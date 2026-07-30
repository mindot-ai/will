// ─────────────────────────────────────────────────────────────
// tests/unit/executive.commands.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for executive command building purity + abort safety (FN11).
 *
 * Regression target: buildStateCommands() used to perform manager writes
 * (summarizer.record, goalManager.addGoal, semanticIntegrator.integrateExecutiveBelief,
 * effectorRegistry.markAsKnown/registerCreatedEffector) *inline during react()* while
 * ALSO returning entity/metric commands describing the same changes. The commands
 * are only applied at commit. If a pre-commit validator aborts the tick
 * (orchestrator.ts:469-484), the commands are discarded but the manager writes have
 * already landed → state and managers drift with no compensation.
 *
 * The fix makes buildStateCommands pure: it returns { commands, effects } and runs
 * NO manager writes itself. The caller runs `effects` only after the tick commits,
 * so an abort drops both the commands and the (never-run) manager writes together.
 */

import { describe, it, expect } from 'vitest'
import { buildStateCommands } from '#faculties/executive.engine/commands'
import type { CommandDependencies } from '#faculties/executive.engine/commands'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import { ExecutiveSummarizer } from '#llm/summarizer'
import { GenerativeModel } from '#cognition/generative.model'
import type { ReadonlySimulationState, ReasoningFootprint } from '#core/types'

function emptyState(): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState
}

function footprintAt( tick: number ): ReasoningFootprint {
  return {
    tickObserved: tick,
    entitiesRead: new Set(),
    metricsRead: new Set(),
    entitiesModified: new Set(),
    intendedCommands: {},
    source: 'executive-engine',
  } as unknown as ReasoningFootprint
}

/** Records every manager call so we can assert *when* side-effects happen. */
interface SpyLog {
  summarizerRecord: string[]
  addGoal: string[]
  abandonGoal: string[]
  reprioritize: string[]
  beliefs: string[]
}

function makeDeps( log: SpyLog, summarizer: ExecutiveSummarizer ): CommandDependencies {
  return {
    summarizer,
    goalManager: {
      addGoal:            ( description: string ) => { log.addGoal.push( description ); return { id: 'g' } },
      abandonGoal:        ( goalId: string )      => { log.abandonGoal.push( goalId ) },
      updateGoalPriority: ( goalId: string )      => { log.reprioritize.push( goalId ) },
    } as unknown as CommandDependencies['goalManager'],
    semanticIntegrator: {
      integrateExecutiveBelief: ( b: { statement: string } ) => { log.beliefs.push( b.statement ) },
    } as unknown as CommandDependencies['semanticIntegrator'],
    bus: null,
    salience: new GenerativeModel(),
  }
}

function freshLog(): SpyLog {
  return { summarizerRecord: [], addGoal: [], abandonGoal: [], reprioritize: [], beliefs: [] }
}

// An output that touches *every* manager: a low-confidence decision (the exact
// shape the inhibition veto aborts on), a new belief, a new goal, an abandon, a
// reprioritize, and a created effector.
function richOutput(): ExecutiveOutputFull {
  return {
    actions: [ { type: 'observe', reasoning: 'r', expectedOutcome: 'o' } ],
    reasoning: 'thinking hard',
    confidence: 0.1, // < 0.2 → inhibition veto would abort this tick
    newBeliefs: [ { statement: 'sky is blue', category: 'world_fact', confidence: 0.8, evidence: 'single_observation', tags: [ 't' ] } ],
    newGoals: [ { description: 'rest', priority: 3, tags: [ 'health' ], completionType: 'open' } ],
    goalsToAbandon: [ { goalId: 'g-old', reason: 'stale' } ],
    goalsToReprioritize: [ { goalId: 'g-keep', newPriority: 5, reason: 'urgent' } ],
  } as ExecutiveOutputFull
}

describe('buildStateCommands — purity (FN11)', () => {
  it('performs NO manager writes during the build, only collects them as effects', () => {
    const log = freshLog()
    const summarizer = new ExecutiveSummarizer()
    const before = summarizer.snapshot()

    const ring: string[] = []
    const { commands, effects } = buildStateCommands( richOutput(), footprintAt( 7 ), emptyState(), makeDeps( log, summarizer ), ring )

    // Nothing landed on any manager yet.
    expect( log.beliefs ).toEqual( [] )
    expect( log.addGoal ).toEqual( [] )
    expect( log.abandonGoal ).toEqual( [] )
    expect( log.reprioritize ).toEqual( [] )
    // Summarizer untouched (callCount unchanged) and ring buffer untouched.
    expect( summarizer.snapshot() ).toEqual( before )
    expect( ring ).toEqual( [] )

    // But the commands were produced, and there are effects queued to mirror them.
    expect( commands.set!.length ).toBeGreaterThan( 0 )
    expect( effects.length ).toBeGreaterThan( 0 )
  })

  it('running the effects applies every manager write exactly once', () => {
    const log = freshLog()
    const summarizer = new ExecutiveSummarizer()
    const ring: string[] = []

    const { effects } = buildStateCommands( richOutput(), footprintAt( 7 ), emptyState(), makeDeps( log, summarizer ), ring )
    for( const fx of effects ) fx()

    expect( log.beliefs ).toEqual( [ 'sky is blue' ] )
    expect( log.addGoal ).toEqual( [ 'rest' ] )
    expect( log.abandonGoal ).toEqual( [ 'g-old' ] )
    expect( log.reprioritize ).toEqual( [ 'g-keep' ] )
    // Ring buffer mutated only after effects ran.
    expect( ring ).toEqual( [ 'observe' ] )
    // Summarizer recorded the reasoning.
    expect( summarizer.snapshot().callCount ).toBe( 1 )
    expect( summarizer.snapshot().buffer ).toContain('thinking hard')
  })
})

describe('buildStateCommands — abort safety + dual-write consistency (FN11)', () => {
  it('an aborted tick (effects never run) leaves managers pristine — no drift', () => {
    const log = freshLog()
    const summarizer = new ExecutiveSummarizer()
    const ring: string[] = []

    // Build commands… then the tick aborts (pre-commit veto on the 0.1-confidence
    // decision), so the caller discards `commands` and NEVER runs `effects`.
    buildStateCommands( richOutput(), footprintAt( 7 ), emptyState(), makeDeps( log, summarizer ), ring )

    // Managers are exactly as they were — the discarded commands have no
    // half-applied manager counterpart.
    expect( log.beliefs ).toEqual( [] )
    expect( log.addGoal ).toEqual( [] )
    expect( summarizer.snapshot().callCount ).toBe( 0 )
    expect( ring ).toEqual( [] )
  })

  it('the persisted summary entity matches the summarizer state the deferred record() produces', () => {
    const log = freshLog()
    const summarizer = new ExecutiveSummarizer()
    const ring: string[] = []

    const { commands, effects } = buildStateCommands( richOutput(), footprintAt( 7 ), emptyState(), makeDeps( log, summarizer ), ring )

    const summaryEntity = commands.set!.find( e => e.id === 'executive-rolling-summary')!
    expect( summaryEntity ).toBeDefined()

    // Commit the tick: run the effects (record() lands).
    for( const fx of effects ) fx()

    // The entity persisted the *projected* post-record snapshot, which now
    // equals the live summarizer's snapshot — no drift between the two writes.
    expect( summaryEntity.metadata ).toEqual( summarizer.snapshot() )
  })
})

describe('buildStateCommands — deterministic belief IDs (FN12)', () => {
  // Two beliefs in one cycle so the per-batch index disambiguator is exercised.
  function twoBeliefOutput(): ExecutiveOutputFull {
    return {
      actions: [ { type: 'reflect', reasoning: 'r', expectedOutcome: 'o' } ],
      reasoning: 'r',
      confidence: 0.6,
      newBeliefs: [
        { statement: 'a', category: 'world_fact', confidence: 0.8, evidence: 'single_observation', tags: [] },
        { statement: 'b', category: 'self_belief', confidence: 0.7, evidence: 'recurring_pattern', tags: [] },
      ],
    } as ExecutiveOutputFull
  }

  function beliefIds( tick: number ): string[] {
    const log = freshLog()
    const { commands } = buildStateCommands( twoBeliefOutput(), footprintAt( tick ), emptyState(), makeDeps( log, new ExecutiveSummarizer() ), [] )
    return commands.set!.filter( e => e.type === 'belief').map( e => e.id )
  }

  it('derives belief ids from the sim tick + batch index (no Date.now/Math.random)', () => {
    expect( beliefIds( 7 ) ).toEqual( [ 'belief-executive-7-0', 'belief-executive-7-1' ] )
  })

  it('is replay-stable: identical inputs at the same tick yield identical ids', () => {
    expect( beliefIds( 7 ) ).toEqual( beliefIds( 7 ) )
  })

  it('distinct ticks yield distinct ids (no cross-cycle collisions)', () => {
    const a = beliefIds( 7 )
    const b = beliefIds( 8 )
    expect( a.some( id => b.includes( id ) ) ).toBe( false )
  })

  it('the deferred integrate() belief id matches the persisted command id', () => {
    const log = freshLog()
    const integrated: string[] = []
    const deps = makeDeps( log, new ExecutiveSummarizer() )
    // Capture the belief object the integrator receives.
    ;( deps.semanticIntegrator as any ).integrateExecutiveBelief = ( b: { id: string } ) => integrated.push( b.id )

    const { commands, effects } = buildStateCommands( twoBeliefOutput(), footprintAt( 9 ), emptyState(), deps, [] )
    for( const fx of effects ) fx()

    const commandIds = commands.set!.filter( e => e.type === 'belief').map( e => e.id )
    expect( integrated ).toEqual( commandIds )
  })
})

describe('buildStateCommands — known-entity updates (Phase 2.2)', () => {
  const keOutput = (): ExecutiveOutputFull => ( {
    actions: [], reasoning: 'r', confidence: 0.6,
    knownEntityUpdates: [ { keid: 'web:42', name: 'Mara', learned: [ 'studies coral reefs' ], feeling: 0.3 } ],
  } as ExecutiveOutputFull )

  it('turns learned facts into keid-tagged social beliefs (pure; effect → integrator)', () => {
    const log = freshLog(); const summarizer = new ExecutiveSummarizer()
    const { commands, effects } = buildStateCommands( keOutput(), footprintAt( 7 ), emptyState(), makeDeps( log, summarizer ), [] )

    const belief = commands.set!.find( e => e.type === 'belief' && ( e.metadata?.tags as string[] | undefined )?.includes('keid:web:42') )
    expect( belief ).toBeDefined()
    expect( belief!.metadata!.category ).toBe('social_belief')
    expect( log.beliefs ).toEqual( [] )            // pure — not applied during the build
    effects.forEach( fn => fn() )
    expect( log.beliefs ).toContain('studies coral reefs')
  })

  it('routes name/feeling to the tracker via a known.entity.learned event', () => {
    const log = freshLog(); const summarizer = new ExecutiveSummarizer()
    const published: any[] = []
    const deps = { ...makeDeps( log, summarizer ), bus: { publish: ( e: any ) => published.push( e ) } as any }
    const { effects } = buildStateCommands( keOutput(), footprintAt( 7 ), emptyState(), deps, [] )
    effects.forEach( fn => fn() )
    const ev = published.find( e => e.type === 'known.entity.learned')
    expect( ev?.payload ).toMatchObject( { keid: 'web:42', name: 'Mara', feeling: 0.3 } )
  })
})

// ── Ideomotor ability leg — executive-supplied args (MCP-effectors groundwork) ──
// An executive action whose type names a CURRENTLY-AFFORDED host ability becomes an
// ideomotor.intent carrying the action's conscious `args` as `parameters` — the
// existing ideomotor pipeline (synthesizer → selector → motor → invocation) then
// delivers them to the host handler. Only what the field affords can be pre-activated.

function stateWithExternalAffordance( schema: string, extra: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> = [] ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  entities.set(`aff-${ schema }`, { id: `aff-${ schema }`, type: 'affordance', createdAt: 0, updatedAt: 0,
    metadata: { schema, source: 'external', available: true } } )
  for( const e of extra )
    entities.set( e.id, { ...e, createdAt: 0, updatedAt: 0 } )
  return { tick: 1, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
}

function outputWithAction( action: Record<string, unknown> ): ExecutiveOutputFull {
  return { actions: [ action ], reasoning: 'r', confidence: 0.8 } as unknown as ExecutiveOutputFull
}

const ideomotorOf = ( commands: { set?: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> }, schema: string ) =>
  ( commands.set ?? [] ).find( e => e.type === 'ideomotor.intent' && e.metadata?.['schema'] === schema )

describe('buildStateCommands — ideomotor ability leg (executive args)', () => {
  const run = ( output: ExecutiveOutputFull, state: ReadonlySimulationState ) => {
    const log = freshLog()
    return buildStateCommands( output, footprintAt( 1 ), state, makeDeps( log, new ExecutiveSummarizer() ), [] ).commands
  }

  it('pre-activates an afforded ability with the executive\'s conscious args', () => {
    const commands = run(
      outputWithAction( { type: 'search_docs', reasoning: 'need the design', expectedOutcome: 'found', args: { query: 'tick loop design' } } ),
      stateWithExternalAffordance('search_docs'),
    )
    const intent = ideomotorOf( commands, 'search_docs')
    expect( intent ).toBeDefined()
    expect( intent?.metadata?.['parameters'] ).toEqual( { query: 'tick loop design' } )
    expect( intent?.metadata?.['origin'] ).toBe('executive')
  } )

  it('ignores an action naming an ability the field does not currently afford', () => {
    const commands = run(
      outputWithAction( { type: 'search_docs', reasoning: 'r', expectedOutcome: 'o', args: { query: 'x' } } ),
      { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState,
    )
    expect( ideomotorOf( commands, 'search_docs') ).toBeUndefined()
  } )

  it('resolves the action target to a known-entity keid for a targeted ability', () => {
    const commands = run(
      outputWithAction( { type: 'give', reasoning: 'r', expectedOutcome: 'o', target: 'Ada' } ),
      stateWithExternalAffordance('give', [
        { id: 'ke-ada', type: 'known-entity', metadata: { keid: 'ada', kind: 'sentient', name: 'Ada' } },
      ] ),
    )
    expect( ideomotorOf( commands, 'give')?.metadata?.['targetEntityId'] ).toBe('ada')
  } )

  it('leaves the communicate leg untouched (reach-out still forms from a communicate action)', () => {
    const commands = run(
      outputWithAction( { type: 'communicate', reasoning: 'r', expectedOutcome: 'o', target: 'Ada' } ),
      stateWithExternalAffordance('unrelated', [
        { id: 'ke-ada', type: 'known-entity', metadata: { keid: 'ada', kind: 'sentient', name: 'Ada' } },
      ] ),
    )
    expect( ideomotorOf( commands, 'reach-out')?.metadata?.['targetEntityId'] ).toBe('ada')
  } )
} )

// ── the communicate leg must accept the addressee the PROMPT asks for ───────
//
// The output guidelines document actions as {type, reasoning, expectedOutcome,
// target?, args?} and tell the mind to put specifics in `args`. So a mind writing
// a message naturally produces `args: { to, content }`. The communicate branch
// used to read `action.target` alone and `continue` on its absence — so real,
// fully-authored sentences never became an intent, never competed, and were never
// enqueued. Reafference then taught the Will that talking to that PERSON fails.
//
// It also dropped `args` entirely, so even a correctly-targeted communicate lost
// its words and hit ProactiveCommunicator's "didn't write anything" arm.
describe('buildStateCommands — a communicate action reaches the outbox', () => {
  const run = ( output: ExecutiveOutputFull, state: ReadonlySimulationState ) => {
    const log = freshLog()
    return buildStateCommands( output, footprintAt( 1 ), state, makeDeps( log, new ExecutiveSummarizer() ), [] ).commands
  }

  const withAda = ( extra: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> = [] ) =>
    stateWithExternalAffordance('unrelated', [
      { id: 'ke-ada', type: 'known-entity', metadata: { keid: 'ada', kind: 'sentient', name: 'Ada' } },
      ...extra,
    ] )

  it('resolves the addressee from args.to when the action carries no target', () => {
    const commands = run(
      outputWithAction( { type: 'message', reasoning: 'r', expectedOutcome: 'o',
        args: { to: 'Ada', content: 'What are you working on?' } } ),
      withAda(),
    )
    const intent = ideomotorOf( commands, 'reach-out')
    expect( intent?.metadata?.['targetEntityId'] ).toBe('ada')
  } )

  it('carries the authored words through as parameters', () => {
    const commands = run(
      outputWithAction( { type: 'message', reasoning: 'r', expectedOutcome: 'o',
        args: { to: 'Ada', content: 'What are you working on?' } } ),
      withAda(),
    )
    const params = ideomotorOf( commands, 'reach-out')?.metadata?.['parameters'] as Record<string, unknown>
    expect( params?.['content'] ).toBe('What are you working on?')
  } )

  it('accepts `recipient` too — the mind does not always pick the same key', () => {
    const commands = run(
      outputWithAction( { type: 'message', reasoning: 'r', expectedOutcome: 'o',
        args: { recipient: 'Ada', content: 'Following up.' } } ),
      withAda(),
    )
    expect( ideomotorOf( commands, 'reach-out')?.metadata?.['targetEntityId'] ).toBe('ada')
  } )

  it('an explicit action.target still wins, and still carries args', () => {
    const commands = run(
      outputWithAction( { type: 'talk', reasoning: 'r', expectedOutcome: 'o', target: 'Ada',
        args: { content: 'Directly addressed.' } } ),
      withAda(),
    )
    const intent = ideomotorOf( commands, 'reach-out')
    expect( intent?.metadata?.['targetEntityId'] ).toBe('ada')
    expect( ( intent?.metadata?.['parameters'] as Record<string, unknown> )?.['content'] ).toBe('Directly addressed.')
  } )

  it('still forms no intent when there is genuinely no one named', () => {
    const commands = run(
      outputWithAction( { type: 'message', reasoning: 'r', expectedOutcome: 'o', args: { content: 'Into the void.' } } ),
      withAda(),
    )
    expect( ideomotorOf( commands, 'reach-out') ).toBeUndefined()
  } )

  it('forms no intent for someone it does not know', () => {
    const commands = run(
      outputWithAction( { type: 'message', reasoning: 'r', expectedOutcome: 'o',
        args: { to: 'Stranger', content: 'Hello?' } } ),
      withAda(),
    )
    expect( ideomotorOf( commands, 'reach-out') ).toBeUndefined()
  } )
} )

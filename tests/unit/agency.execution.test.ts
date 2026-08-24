// ─────────────────────────────────────────────────────────────
// tests/unit/agency.execution.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 2 — enaction. Proves the executor emits an efference copy, resolves
// sync stances into outcomes, holds async (communicate/external) intents open,
// and — the headline — actually RUNS a composite skill across ticks.
//
// A tiny harness applies StateCommands to a mutable state the way the
// orchestrator does, so multi-tick pipelines (select → execute → advance) can
// be driven deterministically in-process.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import type { MotorSchema } from '#agency/types'
import { MotorSchemaExecutor, AWAIT_TIMEOUT } from '#agency/engines/motor.schema.executor'
import { ActionSelector } from '#agency/engines/action.selector'
import { RewardEvaluator } from '#faculties/reward.evaluator'

const CTX = {} as unknown as SimulationContext

/** Capture cognitive-bus publishes from an engine under test. */
function busSpy(): { bus: unknown; events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return {
    bus: {
      publish: ( e: { type: string; payload: Record<string, unknown> } ) => events.push( e ),
      // The bus contract includes subscribe — engines wire their listeners in
      // attachBus(). A publish-only double is an incomplete bus, not a smaller one.
      subscribe: () => () => {},
    },
    events,
  }
}

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }

function freshState( metrics: Record<string, number> = {} ): MutState {
  return { tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) }
}

/** Apply StateCommands the way the orchestrator does (set / delete / metrics). */
function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] )
    s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}

const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function seedIntent( s: MutState, meta: Record<string, unknown> ): void {
  s.entities.set('agency-intent-1', {
    id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
    metadata: { status: 'selected', parameters: {}, expectedReward: 0.5, expectedValence: 0, ...meta },
  } )
}

const entitiesOfType = ( s: MutState, t: string ) =>
  [ ...s.entities.values() ].filter( e => e.type === t )

describe('MotorSchemaExecutor — action.outcome sink (calibrator + reward)', () => {
  it('emits action.outcome for every enaction, carrying the forward-model prior as confidence', async () => {
    const exec = new MotorSchemaExecutor()
    const spy  = busSpy(); exec.attachBus( spy.bus as never )
    const s    = freshState({ 'energy.level': 30 })
    seedIntent( s, { schema: 'rest', expectedReward: 0.4 } )

    await exec.react( 0, 5, frozen( s ), CTX )

    const ao = spy.events.find( e => e.type === 'action.outcome')
    expect( ao ).toBeDefined()
    expect( ao!.payload['actionType'] ).toBe('rest')
    expect( ao!.payload['confidence'] ).toBe( 0.4 )            // the agency's predicted reward
    expect( ao!.payload['success'] ).toBe( true )
    expect( typeof ao!.payload['surprise'] ).toBe('number')  // |predicted − actual|
    expect( ao!.payload ).not.toHaveProperty('planId')       // not a plan step

    // What HAPPENED, in words (SIGNAL_BOUNDARY P2). This payload builds
    // `action.record`, which the prompt renders as `## What Became Of What I Did`
    // — and this method published no description at all, so that section
    // showed the action's NAME and nothing else. Sixty-five lookups rendered
    // as sixty-five identical lines that never said what was found.
    expect( typeof ao!.payload['description'] ).toBe('string')
    expect( ( ao!.payload['description'] as string ).length ).toBeGreaterThan( 0 )
  })

  it('RewardEvaluator + ConfidenceCalibrator consume action.outcome', () => {
    expect( new RewardEvaluator().subscribes() ).toContain('action.outcome')
    // ConfidenceCalibrator already subscribed to action.outcome before the agency cutover.
  })
})

describe('MotorSchemaExecutor — communicate delivery (Phase 5b)', () => {
  function fakeComms( success = true ): { comms: unknown; calls: Array<{ effector: string; parameters: Record<string, unknown> }> } {
    const calls: Array<{ effector: string; parameters: Record<string, unknown> }> = []
    return {
      calls,
      comms: { executeAction: async ( req: { effector: string; parameters: Record<string, unknown> } ) => {
        calls.push( req )
        return { success, description: 'sent', commands: { set: [] },
          feedback: { outcomeQuality: success ? 0.85 : 0, surprise: 0, lessons: [] } }
      } },
    }
  }
  const grant = ( ok: boolean ) => ({ isAllowed: () => ok } as never )

  it('delivers an authored communicate intent through the ProactiveCommunicator (not awaiting)', async () => {
    const exec = new MotorSchemaExecutor()
    const fc = fakeComms( true )
    exec.attachProactiveCommunicator( fc.comms as never ); exec.attachGrants( grant( true ) )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { content: 'hi Alice' } } )

    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )

    expect( fc.calls ).toHaveLength( 1 )
    expect( fc.calls[0]!.effector ).toBe('text')                  // reach-out → text
    expect( fc.calls[0]!.parameters['messages'] ).toEqual( [ 'hi Alice' ] )
    expect( s.entities.has('agency-intent-1') ).toBe( false )    // resolved, not awaiting
    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 1 )
  })

  it('holds an unauthored reach-out awaiting (no words to send yet)', async () => {
    const exec = new MotorSchemaExecutor()
    const fc = fakeComms( true )
    exec.attachProactiveCommunicator( fc.comms as never ); exec.attachGrants( grant( true ) )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice' } )   // no content

    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )

    expect( fc.calls ).toHaveLength( 0 )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')
  })

  it('a denied permission resolves as a failed outcome (not awaiting, no delivery)', async () => {
    const exec = new MotorSchemaExecutor()
    const fc = fakeComms( true )
    exec.attachProactiveCommunicator( fc.comms as never ); exec.attachGrants( grant( false ) )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { content: 'hi' } } )

    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )

    expect( fc.calls ).toHaveLength( 0 )                            // never delivered
    expect( entitiesOfType( s, 'agency.outcome')[0]?.metadata?.['success'] ).toBe( false )
    expect( s.entities.has('agency-intent-1') ).toBe( false )     // resolved, not awaiting
  })
})

describe('MotorSchemaExecutor — two-phase outreach authoring', () => {
  function fakeComms(): { comms: unknown; calls: Array<{ parameters: Record<string, unknown> }> } {
    const calls: Array<{ parameters: Record<string, unknown> }> = []
    return {
      calls,
      comms: { executeAction: async ( req: { parameters: Record<string, unknown> } ) => {
        calls.push( req )
        return { success: true, description: 'sent', commands: { set: [] },
          feedback: { outcomeQuality: 0.85, surprise: 0, lessons: [] } }
      } },
    }
  }
  const grant = ( ok: boolean ) => ({ isAllowed: () => ok } as never )

  /**
   * An author whose promise settles only when the test releases it — standing in for a
   * real facet, whose answer cannot arrive until the tick loop advances and pumps it.
   * Under the previous in-tick `await`, react() would never resolve against this.
   */
  function deferredAuthor(){
    let release: ( bubbles: string[] ) => void = () => {}
    const calls: Array<{ entityId: string; entityName: string; gist?: string }> = []
    return {
      calls,
      release: ( bubbles: string[] ) => release( bubbles ),
      author: {
        authorOutreach: ( entityId: string, entityName: string, gist?: string ) => {
          calls.push({ entityId, entityName, gist })
          return new Promise<string[]>( resolve => { release = resolve } )
        },
      } as never,
    }
  }

  const settle = () => new Promise( r => setImmediate( r ) )

  it('requests the words without awaiting them, then delivers once they land', async () => {
    const exec = new MotorSchemaExecutor()
    const fc   = fakeComms(); const da = deferredAuthor()
    exec.attachProactiveCommunicator( fc.comms as never )
    exec.attachGrants( grant( true ) ); exec.attachOutreachAuthor( da.author )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice',
      parameters: { gist: 'ask how the migration went', targetEntityName: 'Alice' } } )

    // Tick 3 — react RESOLVES while the author is still pending. That is the fix: the
    // old code awaited here and deadlocked against the facet pump.
    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )
    expect( da.calls ).toHaveLength( 1 )
    expect( da.calls[0] ).toMatchObject({ entityId: 'alice', entityName: 'Alice',
      gist: 'ask how the migration went' } )
    expect( fc.calls ).toHaveLength( 0 )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')

    // Still pending across further ticks — exactly ONE call behind the held intent.
    apply( s, ( await exec.react( 0, 4, frozen( s ), CTX ) ).commands )
    expect( da.calls ).toHaveLength( 1 )
    expect( fc.calls ).toHaveLength( 0 )

    // The facet answers off-tick; the NEXT tick speaks it.
    da.release([ 'Hey Alice — how did the migration go?' ])
    await settle()
    apply( s, ( await exec.react( 0, 5, frozen( s ), CTX ) ).commands )

    expect( fc.calls ).toHaveLength( 1 )
    expect( fc.calls[0]!.parameters['messages'] ).toEqual( [ 'Hey Alice — how did the migration go?' ] )
    expect( s.entities.has('agency-intent-1') ).toBe( false )   // resolved, not awaiting
    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 1 )
  })

  it('pauses the await clock while authoring is in flight', async () => {
    const exec = new MotorSchemaExecutor()
    const fc   = fakeComms(); const da = deferredAuthor()
    exec.attachProactiveCommunicator( fc.comms as never )
    exec.attachGrants( grant( true ) ); exec.attachOutreachAuthor( da.author )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { gist: 'check in' } } )

    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )

    // Far past AWAIT_TIMEOUT with the call still in flight: a slow facet is not a dead
    // world, so the intent must NOT be reconciled as a phantom failure.
    apply( s, ( await exec.react( 0, 3 + AWAIT_TIMEOUT + 20, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')
    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 0 )

    // …and words arriving long after the old budget are still spoken, not discarded.
    da.release([ 'still worth saying' ])
    await settle()
    apply( s, ( await exec.react( 0, 3 + AWAIT_TIMEOUT + 21, frozen( s ), CTX ) ).commands )
    expect( fc.calls ).toHaveLength( 1 )
    expect( fc.calls[0]!.parameters['messages'] ).toEqual( [ 'still worth saying' ] )
  })

  it('resumes the clock when authoring comes back empty — a dead author still times out', async () => {
    const exec = new MotorSchemaExecutor()
    const fc   = fakeComms(); const da = deferredAuthor()
    exec.attachProactiveCommunicator( fc.comms as never )
    exec.attachGrants( grant( true ) ); exec.attachOutreachAuthor( da.author )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { gist: 'check in' } } )

    apply( s, ( await exec.react( 0, 3, frozen( s ), CTX ) ).commands )
    da.release( [] )                    // authoring failed / produced nothing
    await settle()

    apply( s, ( await exec.react( 0, 3 + AWAIT_TIMEOUT + 1, frozen( s ), CTX ) ).commands )

    expect( fc.calls ).toHaveLength( 0 )
    expect( s.entities.has('agency-intent-1') ).toBe( false )   // reconciled as failed
    expect( entitiesOfType( s, 'agency.outcome')[0]?.metadata?.['success'] ).toBe( false )
  })
})

describe('MotorSchemaExecutor — primitive enaction', () => {
  it('resolves a sync stance into an outcome with an efference copy, then consumes the intent', async () => {
    const s = freshState({ 'energy.level': 20 })
    seedIntent( s, { schema: 'rest', expectedReward: 0.4 } )

    apply( s, ( await new MotorSchemaExecutor().react( 0, 5, frozen( s ), CTX ) ).commands )

    const outcomes = entitiesOfType( s, 'agency.outcome')
    expect( outcomes ).toHaveLength( 1 )
    const m = outcomes[0]!.metadata!
    expect( m['schema'] ).toBe('rest')
    expect( m['predictedReward'] ).toBe( 0.4 )       // efference copy recorded
    expect( typeof m['outcomeQuality'] ).toBe('number')
    expect( typeof m['surprise'] ).toBe('number')  // |predicted − actual|
    expect( m['mode'] ).toBe('sync')
    // intent consumed
    expect( s.entities.has('agency-intent-1') ).toBe( false )
  })

  it('rest is more restorative (higher quality) when more depleted', async () => {
    const tired  = freshState({ 'energy.level': 10 }); seedIntent( tired,  { schema: 'rest' } )
    const rested = freshState({ 'energy.level': 90 }); seedIntent( rested, { schema: 'rest' } )

    apply( tired,  ( await new MotorSchemaExecutor().react( 0, 1, frozen( tired ),  CTX ) ).commands )
    apply( rested, ( await new MotorSchemaExecutor().react( 0, 1, frozen( rested ), CTX ) ).commands )

    const q = ( s: MutState ) => entitiesOfType( s, 'agency.outcome')[0]!.metadata!['outcomeQuality'] as number
    expect( q( tired ) ).toBeGreaterThan( q( rested ) )
  })
})

describe('MotorSchemaExecutor — async dispatch holds the intent open', () => {
  it('a communicate schema transitions the intent to awaiting (not deleted)', async () => {
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { targetEntityName: 'Alice' } } )

    apply( s, ( await new MotorSchemaExecutor().react( 0, 3, frozen( s ), CTX ) ).commands )

    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 0 )   // not resolved yet
    const intent = s.entities.get('agency-intent-1')
    expect( intent?.metadata?.['status'] ).toBe('awaiting')
    expect( intent?.metadata?.['predictedReward'] ).toBeDefined()        // efference persisted for reconciliation
  })

  it('an unknown schema routes to the host as external (awaiting)', async () => {
    const s = freshState()
    seedIntent( s, { schema: 'open_airlock', targetEntityId: 'door-7' } )

    apply( s, ( await new MotorSchemaExecutor().react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')
  })

  it('abandons an awaiting intent that the world never answers (timeout → failed outcome)', async () => {
    const exec = new MotorSchemaExecutor()
    const s = freshState()
    s.entities.set('agency-intent-1', {
      id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'open_airlock', status: 'awaiting', dispatchedAt: 1, predictedReward: 0.5 },
    } )

    // Well past the 15-tick await window.
    apply( s, ( await exec.react( 0, 20, frozen( s ), CTX ) ).commands )

    expect( s.entities.has('agency-intent-1') ).toBe( false )                 // freed
    const outcome = entitiesOfType( s, 'agency.outcome')[0]
    expect( outcome?.metadata?.['success'] ).toBe( false )                      // taught as a failure
  })
})

describe('MotorSchemaExecutor — a composite skill actually runs', () => {
  const SETTLE: MotorSchema = {
    id: 'settle-self', kind: 'composite', source: 'repertoire', binds: 'none', cost: 0.1,
    composedOf: [ 'withdraw', 'rest', 'reflect' ], tags: [ 'self-care' ],
  }

  it('expands into ordered sub-intents, runs one per tick, and finalizes one composite outcome', async () => {
    const exec = new MotorSchemaExecutor()
    exec.registerSchema( SETTLE )

    const s = freshState({ 'energy.level': 30 })
    seedIntent( s, { schema: 'settle-self', expectedReward: 0.6 } )

    // Tick A: expand — parent → expanding, first sub committed, no outcome yet.
    apply( s, ( await exec.react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('expanding')
    expect( s.entities.get('agency-intent-1-sub-0')?.metadata?.['schema'] ).toBe('withdraw')
    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 0 )

    // Drive the macro to completion — one sub-step per tick.
    const seen: string[] = []
    for( let tick = 2; tick < 8; tick++ ){
      const subIntent = [ ...s.entities.values() ].find(
        e => e.type === 'agency.intent' && e.metadata?.['parentIntentId'] && e.metadata?.['status'] === 'selected')
      if( subIntent ) seen.push( subIntent.metadata!['schema'] as string )
      apply( s, ( await exec.react( 0, tick, frozen( s ), CTX ) ).commands )
      if( !s.entities.has('agency-intent-1') ) break
    }

    // Ran the steps in order…
    expect( seen ).toEqual( [ 'withdraw', 'rest', 'reflect' ] )
    // …left no dangling intents…
    expect( entitiesOfType( s, 'agency.intent') ).toHaveLength( 0 )
    // …and produced exactly one composite outcome on top of the three sub-outcomes.
    const composite = entitiesOfType( s, 'agency.outcome').find( e => e.metadata?.['schema'] === 'settle-self')
    expect( composite ).toBeDefined()
    expect( composite?.metadata?.['predictedReward'] ).toBe( 0.6 )
    expect( composite?.metadata?.['outcomeQuality'] ).toBeGreaterThan( 0 )
  })
})

describe('selector → executor — serial handoff', () => {
  it('selects, executes next tick, and only then is free to select again', async () => {
    const sel  = new ActionSelector()
    const exec = new MotorSchemaExecutor()
    const s    = freshState({ 'energy.level': 40 })

    // A field with a single clear winner.
    s.entities.set('aff-rest', {
      id: 'aff-rest', type: 'affordance', createdAt: 0, updatedAt: 0,
      metadata: {
        schema: 'rest', source: 'innate', parameters: {}, expectedReward: 0.9, expectedValence: 0.2,
        cost: 0.0, habitStrength: 0, available: true, tags: [ 'regulatory' ], tick: 0,
      },
    } )

    // Tick 1: selector commits an intent.
    apply( s, ( await sel.react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('selected')

    // Tick 2: selector is busy (intent in flight) → no second intent; executor enacts it.
    const selBusy = await sel.react( 0, 2, frozen( s ), CTX )
    expect( ( selBusy.commands?.metrics ?? [] ).find( m => m[0] === 'agency.selection.busy')?.[1] ).toBe( 1 )
    apply( s, ( await exec.react( 0, 2, frozen( s ), CTX ) ).commands )
    expect( s.entities.has('agency-intent-1') ).toBe( false )                 // consumed
    expect( entitiesOfType( s, 'agency.outcome') ).toHaveLength( 1 )

    // Tick 3: free again — selector commits the next action.
    apply( s, ( await sel.react( 0, 3, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-3')?.metadata?.['status'] ).toBe('selected')
  })
})

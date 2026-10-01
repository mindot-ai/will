// ─────────────────────────────────────────────────────────────
// tests/unit/self.reflection.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * `## Recent Self-Reflection` shows the mind what it concluded about itself, and
 * what it noticed about itself since.
 *
 * Two things kept that from being true. Self-observations were asked for every
 * cycle and stored, and nothing read them — the section came from introspection
 * alone. And the introspection it did show was the introspection engine's copy,
 * re-taken on every tick of the executive's fresh window under its own field
 * names: fourteen copies of one reflection, the last of which carried `lessons`
 * where the section read `lessonsLearned`, and no recommendations at all. The
 * mind was shown its biases and never what it had decided to do about them.
 *
 * Every test writes through the real writer (the executive's commands, the
 * introspection engine), commits into a real state manager, and reads the prompt
 * the mind is actually given.
 */

import { describe, it, expect } from 'vitest'
import { buildStateCommands, type CommandDependencies } from '#faculties/executive.engine/commands'
import type { ExecutiveContext, ExecutiveOutputFull } from '#faculties/executive.engine/types'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { IntrospectionEngine } from '#faculties/introspection.engine'
import { DefaultStateManager } from '#core/state.manager'
import { GenerativeModel } from '#cognition/generative.model'
import type { ReasoningFootprint, StateCommands } from '#core/types'

// Long enough that any text cut would show.
const AVOIDANCE = 'I have now correctly identified rest as the right action across at least three deliberation cycles '
  + 'and failed to execute it each time. The deliberation process itself has become the avoidance mechanism.'

const INTROSPECTION = {
  explanation:      'I keep diagnosing instead of acting.',
  identifiedBiases: [ 'analysis paralysis' ],
  lessonsLearned:   [ 'Act on a correct diagnosis in the same cycle.' ],
  recommendations:  [ 'Rest now, before the next deliberation.' ],
}

const context = {
  identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
  worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
  affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
  goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
  beliefs: [], beliefsOmitted: 0, recentActions: [],
} as unknown as ExecutiveContext

function mind(){
  const sm = new DefaultStateManager()
  const at = ( tick: number ) => sm.updateClock( tick as never, tick * 1000 as never )
  const commit = ( c: StateCommands | undefined ) => { if( c ) sm.applyCommands( c ) }

  // The executive's own write path, as engine.ts drives it.
  const decide = ( tick: number, output: Partial<ExecutiveOutputFull> ) => {
    at( tick )
    const deps: CommandDependencies = { summarizer: null, goalManager: null, semanticIntegrator: null,
      bus: { publish(){} } as never, salience: new GenerativeModel() } as unknown as CommandDependencies
    const full = { actions: [], reasoning: 'r', confidence: 0.8, ...output } as unknown as ExecutiveOutputFull
    const footprint = { tickObserved: tick, entitiesRead: new Set(), metricsRead: new Set(), entitiesModified: new Set(),
      intendedCommands: {}, source: 'executive-engine' } as unknown as ReasoningFootprint
    commit( buildStateCommands( full, footprint, sm.snapshot(), deps, [] ).commands )
  }

  const prompt = ( tick: number, mode: 'master' | 'facet' = 'master' ) => {
    at( tick )
    return buildUserMessage( { context, state: sm.snapshot(), qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null }, focus: { title: 'T', content: 'focus' }, mode } as never )
  }

  return { sm, at, commit, decide, prompt }
}

const section = ( prompt: string ) => prompt.split('## Recent Self-Reflection\n')[1]?.split('\n## ')[0] ?? ''

describe('she sees what she noticed about herself', () => {
  it('renders her self-observations whole, even before she has ever introspected', () => {
    const m = mind()
    m.decide( 10, { selfObservations: [ AVOIDANCE, 'I answered a simple question simply.' ] } )
    const s = section( m.prompt( 14 ) )
    expect( s ).toContain(`- 4 ticks ago — "${ AVOIDANCE }"`)
    // Within a cycle, in the order she wrote them.
    expect( s.indexOf( AVOIDANCE ) ).toBeLessThan( s.indexOf('I answered a simple question simply.') )
  } )

  it('shows the newest first, and says exactly how many are not in view', () => {
    const m = mind()
    for( const tick of [ 10, 20, 30 ] )
      m.decide( tick, { selfObservations: [ 'a', 'b', 'c' ].map( x => `at ${ tick } I noticed ${ x }` ) } )
    const s = section( m.prompt( 31 ) )
    expect( s ).toContain('at 30 I noticed a')
    expect( s ).toContain('at 20 I noticed c')
    expect( s ).not.toContain('at 10 I noticed')
    expect( s.indexOf('at 30 I noticed c') ).toBeLessThan( s.indexOf('at 20 I noticed a') )
    expect( s ).toContain('3 more earlier observations are not in view — {"recall": [{"section": "self-observations", "page": 2}]}')
  } )

  it('reads a woken mind\'s observations, written into the old ring', () => {
    const m = mind()
    m.at( 5 )
    m.commit( { set: [ { id: 'self-obs-slot-3', type: 'self_observation', metadata: { observation: 'I was quieter today.', tick: 5 } } ] } )
    expect( section( m.prompt( 6 ) ) ).toContain('"I was quieter today."')
  } )

  it('is shown to a facet as well as to the master', () => {
    const m = mind()
    m.decide( 10, { selfObservations: [ AVOIDANCE ] } )
    expect( section( m.prompt( 11, 'facet') ) ).toContain( AVOIDANCE )
  } )
} )

// ── the introspection it is shown is the whole one, taken once ──

function withIntrospectionEngine( m: ReturnType<typeof mind>, executiveTick: number ){
  const published: string[] = []
  const engine = new IntrospectionEngine( { bus: { publish: ( e: { type: string } ) => { published.push( e.type ) } } as never } )
  const output = { actions: [], reasoning: 'r', confidence: 0.8, introspection: INTROSPECTION }
  // The executive's accessor, as it reads: fresh for `executiveInterval` (15) ticks.
  engine.attachExecutiveEngine( { latestOutput: output, isFresh: ( t: number ) => t - executiveTick < 15 } as never )
  const step = async ( tick: number ) => {
    m.at( tick )
    m.commit( ( await engine.react( 1000 as never, tick as never, m.sm.snapshot(), {} as never ) ).commands as StateCommands )
  }
  return { published, step }
}

describe('her reflection reaches her whole', () => {
  it('takes one introspection once, not once per tick it stays fresh', async () => {
    const m = mind()
    m.decide( 10, { introspection: INTROSPECTION } )
    const { published, step } = withIntrospectionEngine( m, 10 )
    for( let t = 11; t < 25; t++ ) await step( t )
    const copies = [ ...m.sm.snapshot().entities.values() ].filter( e => e.id.startsWith('introspection-executive-') )
    // The executive's own record, and the engine's: two. Re-taken on every tick,
    // the engine wrote fourteen (and pruned all but ten of them).
    expect( copies ).toHaveLength( 2 )
    expect( published.filter( t => t === 'introspection.insight') ).toHaveLength( 1 )
  } )

  it('shows her lessons and recommendations, not only her biases', async () => {
    const m = mind()
    m.decide( 10, { introspection: INTROSPECTION } )
    const { step } = withIntrospectionEngine( m, 10 )
    for( let t = 11; t < 25; t++ ) await step( t )
    const s = section( m.prompt( 25 ) )
    expect( s ).toContain('Patterns noticed: analysis paralysis')
    expect( s ).toContain('Lessons learned: Act on a correct diagnosis in the same cycle.')
    expect( s ).toContain('Recommendations: Rest now, before the next deliberation.')
  } )

  it('still lets a fresh executive introspection pre-empt the heuristic one', async () => {
    const m = mind()
    m.decide( 10, { introspection: INTROSPECTION } )
    m.commit( { metrics: [ [ 'outcome.significance', 0.9 ] ] } )
    const { step } = withIntrospectionEngine( m, 10 )
    for( let t = 11; t < 25; t++ ) await step( t )
    const heuristic = [ ...m.sm.snapshot().entities.values() ].filter( e => e.id.startsWith('introspection-heuristic-') )
    expect( heuristic ).toHaveLength( 0 )
    // Once it is stale, the heuristic may reflect again.
    await step( 25 )
    expect( [ ...m.sm.snapshot().entities.keys() ].some( id => id.startsWith('introspection-heuristic-') ) ).toBe( true )
  } )

  it('sits with her observations in the one section', async () => {
    const m = mind()
    m.decide( 10, { introspection: INTROSPECTION, selfObservations: [ AVOIDANCE ] } )
    const s = section( m.prompt( 12 ) )
    expect( s.indexOf('I keep diagnosing instead of acting.') ).toBeLessThan( s.indexOf( AVOIDANCE ) )
  } )
} )

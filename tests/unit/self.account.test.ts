// ─────────────────────────────────────────────────────────────
// tests/unit/self.account.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the mind concludes about itself reaches it — from a facet as from the
 * master — and what it concludes about who it is is applied, once.
 *
 *   - A facet is asked (its system prompt is the master's) for introspection, a
 *     narrative, self-observations, identity, skills and reprioritised goals,
 *     and carried none of them on: only the master's output became state. On
 *     Lora's archived runs 18 of 364 facet decisions held an introspection and
 *     27 a narrative, all dropped. Plan supervision's extractor also dropped what
 *     a facet learned about people.
 *   - `identityUpdates.values` was parsed and never applied; the identity nudge
 *     asked for an `[IDENTITY_UPDATE]` block the parser never reads and a
 *     `style` the output had no field for. Traits were applied by the narrator
 *     only when its 50-tick pass found the master's output fresh — missed, or
 *     applied twice.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createTestBus, type CognitiveEvent } from '#cognition/bus'
import { ExecutiveEngine } from '#faculties/executive.engine'
import { ExecutiveFacet } from '#faculties/executive.engine/facet'
import { AutobiographicalNarrator } from '#faculties/autobiographical.narrator'
import { GoalManager } from '#faculties/goal.manager'
import { LLMDirector } from '#llm/index'
import { parseResponse } from '#faculties/executive.engine/parser'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { identityUpdateCommand } from '#cognition/identity.entity'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import { setLogger, resetLogger } from '#core/logger'
import type { ExecutiveContext } from '#faculties/executive.engine/types'
import type { ReadonlySimulationState } from '#core/types'

const ctx = createContext('sim', 'run', 42 )
const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch; resetLogger() } )
const quiet = () => setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never )

const INTROSPECTION = { explanation: 'I keep re-reading the same board.', identifiedBiases: [ 'anchoring' ],
  lessonsLearned: [ 'Read once, then act.' ], recommendations: [ 'Ask FKEM directly.' ] }

const block = ( tag: string, body: unknown ) => `\n[${ tag }]\n${ JSON.stringify( body ) }\n[/${ tag }]`

// ── a facet's account of itself reaches the master ───────────

const sse = ( text: string ) => ( { ok: true, status: 200, statusText: 'OK',
  body: new ReadableStream<Uint8Array>( { start( c ){ c.enqueue( new TextEncoder().encode(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( text ) }}}\n` +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":400}}\n' +
    'data: [DONE]\n' ) ); c.close() } } ) } as unknown as Response )

/** A bare facet answers once; returns what it published. `extract` stands in for a creator's extractor. */
async function facetSays( reasoning: string, extract?: ( o: unknown ) => unknown ){
  const response = JSON.stringify( { actions: [ { type: 'reflect', reasoning: 'r', expectedOutcome: '' } ], reasoning, confidence: 0.7 } )
  globalThis.fetch = ( async () => sse( response ) ) as unknown as typeof fetch
  quiet()
  const bus = createTestBus()
  const seen: CognitiveEvent[] = []
  bus.subscribe('probe', [ 'executive.facet.sync', 'executive.facet.progress', 'known.entity.learned' ], e => { seen.push( e ) } )
  const facet = new ExecutiveFacet('facet-3', bus,
    new LLMDirector( { willId: 'w', model: 'm', maxOutputTokens: 4096, apiKey: 'k', provider: 'glm', sessionLogger: null } as never ),
    { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null } as never,
    { summarizer: null } as never, 'w')
  facet.setStateRef( { tick: 40, time: 40000, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )
  await facet.report( { type: 'step', payload: {}, focus: { title: 'T', content: 'c', ...( extract ? { extractDecision: extract } : {} ) } } as never )
  for( let i = 0; i < 200 && !seen.some( e => e.type === 'executive.facet.sync'); i++ ){
    bus.flush(); await new Promise( r => setTimeout( r, 5 ) )
  }
  facet.destroy?.()
  return { seen, of: ( type: string ) => seen.find( e => e.type === type )?.payload as Record<string, unknown> }
}

describe('a facet\'s account of itself reaches the mind', () => {
  it('carries its reflection, story, self-observations, identity and skills to the master', async () => {
    const { of } = await facetSays( 'I worked through the step report.'
      + block('INTROSPECTION', { introspection: INTROSPECTION })
      + block('NARRATIVE', { narrative: 'I took the release review over from the master.', narrativeThemes: [ 'ownership' ] })
      + block('SELF_OBS', { selfObservations: [ 'I hesitate when FKEM is silent.' ] })
      + block('IDENTITY', { identityUpdates: { values: [ 'candour' ] } })
      + block('SKILLS', { newSkills: [ { id: 'brief-then-confirm', composedOf: [ 'reach-out', 'wait' ] } ] }) )
    const self = of('executive.facet.sync')['self'] as Record<string, unknown>
    expect( self['introspection'] ).toEqual( INTROSPECTION )
    expect( self['narrative'] ).toBe('I took the release review over from the master.')
    expect( self['narrativeThemes'] ).toEqual( [ 'ownership' ] )
    expect( self['selfObservations'] ).toEqual( [ 'I hesitate when FKEM is silent.' ] )
    expect( self['identityUpdates'] ).toEqual( { values: [ 'candour' ] } )
    expect( ( self['newSkills'] as Array<{ id: string }> )[0]!.id ).toBe('brief-then-confirm')
  } )

  it('says nothing of itself when it concluded nothing about itself', async () => {
    const { of } = await facetSays('I worked through the step report.')
    expect( of('executive.facet.sync') ).not.toHaveProperty('self')
  } )

  it('carries goal re-weighting and what it learned about people, whatever its creator kept', async () => {
    const { of, seen } = await facetSays( 'Plan supervision.'
      + block('GOALS_REPRIORITIZE', { goalsToReprioritize: [ { goalId: 'goal-2', newPriority: 0.9, reason: 'blocking' } ] })
      + block('KNOWN_ENTITIES', { knownEntityUpdates: [ { keid: 'ke:fkem', name: 'FKEM' } ] }),
      () => ( { directive: 'continue' } ) )                       // keeps none of it, as plan supervision's did
    expect( of('executive.facet.progress')['goalsToReprioritize'] ).toEqual( [ { goalId: 'goal-2', newPriority: 0.9, reason: 'blocking' } ] )
    expect( of('executive.facet.progress')['knownEntityUpdates'] ).toEqual( [ { keid: 'ke:fkem', name: 'FKEM' } ] )
    expect( seen.some( e => e.type === 'known.entity.learned' && ( e.payload as { name?: string } ).name === 'FKEM') ).toBe( true )
  } )

  it('the goal manager re-weighs a goal a facet re-weighed', () => {
    const gm = new GoalManager()
    const id = gm.addGoal('ship the review', 0.4 )
    gm.onCognitiveEvent( { type: 'executive.facet.progress', payload: { goalsToReprioritize: [ { goalId: id, newPriority: 0.9, reason: 'blocking' } ] } } as never )
    expect( gm.getGoal( id )!.priority ).toBe( 0.9 )
  } )
} )

// ── the master writes it ─────────────────────────────────────

function master(){
  const bus = createTestBus()
  const engine = new ExecutiveEngine()
  engine.attachBus( bus )
  bus.subscribe( engine.name, engine.subscribes(), ev => { engine.onCognitiveEvent( ev ) } )
  const published: CognitiveEvent[] = []
  bus.subscribe('probe', [ 'executive.self.reflection', 'agency.composite.proposed' ], e => { published.push( e ) } )
  const sm = new DefaultStateManager()
  sm.setEntity( { id: 'identity-self', type: 'will.identity', metadata: { name: 'Lora', values: [ 'clarity' ],
    traits: { openness: 0.5 }, style: 'natural', version: 3 } } )
  const tick = async ( t: number ) => {
    sm.updateClock( t as never, t * 1000 as never )
    const r = await engine.react( 1000 as never, t as never, sm.snapshot(), ctx )
    if( r.commands ) sm.applyCommands( r.commands )
    bus.flush()
    return r
  }
  const sync = ( self: unknown, facetId = 'facet-3', t = 40 ) => {
    bus.publish( { type: 'executive.facet.sync', version: 1, sourceEngine: `executive-facet-${ facetId }`, salience: 0.9,
      payload: { facetId, reasoning: 'r', confidence: 0.7, tick: t, self } } as never )
    bus.flush()
  }
  const identity = () => sm.getEntity('identity-self')!.metadata as Record<string, unknown>
  return { engine, bus, sm, tick, sync, published, identity }
}

describe('the master writes what a facet concluded about the mind', () => {
  it('as its records, under the facet\'s name, with the reflection and skill published', async () => {
    quiet()
    const m = master()
    m.sync( { introspection: INTROSPECTION, narrative: 'I took the review over.', selfObservations: [ 'a', 'b' ],
      newSkills: [ { id: 'brief-then-confirm', composedOf: [ 'reach-out', 'wait' ] } ] } )
    await m.tick( 41 )
    expect( m.sm.getEntity('introspection-facet-3-40')!.metadata ).toEqual( INTROSPECTION )
    expect( m.sm.getEntity('narrative-facet-3-40')!.metadata!['narrative'] ).toBe('I took the review over.')
    expect( [ 'self-obs-facet-3-40-0', 'self-obs-facet-3-40-1' ].map( id => m.sm.getEntity( id )?.metadata?.['observation'] ) )
      .toEqual( [ 'a', 'b' ] )
    expect( m.published.find( e => e.type === 'executive.self.reflection')!.payload )
      .toMatchObject( { lessonsLearned: INTROSPECTION.lessonsLearned, recommendations: INTROSPECTION.recommendations, tick: 40 } )
    expect( m.published.find( e => e.type === 'agency.composite.proposed')!.payload ).toMatchObject( { id: 'brief-then-confirm' } )
  } )

  it('and her self-reflection shows it', async () => {
    quiet()
    const m = master()
    m.sync( { selfObservations: [ 'I hesitate when FKEM is silent.' ] } )
    await m.tick( 41 )
    const context = { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
      worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
      affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
      goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
      beliefs: [], beliefsOmitted: 0, recentActions: [] } as unknown as ExecutiveContext
    const prompt = buildUserMessage( { context, state: m.sm.snapshot(), qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null }, focus: { title: 'T', content: 'focus' }, mode: 'master' } as never )
    expect( prompt ).toContain('I hesitate when FKEM is silent.')
  } )

  it('applies a facet\'s identity update on the next tick, once', async () => {
    quiet()
    const m = master()
    m.sync( { identityUpdates: { traits: [ { key: 'openness', value: 0.1 } ], values: [ 'candour' ] } } )
    await m.tick( 41 )
    await m.tick( 42 )
    expect( m.identity()['values'] ).toEqual( [ 'clarity', 'candour' ] )
    expect( m.identity()['traits'] ).toEqual( { openness: 0.6 } )
    expect( m.identity()['name'] ).toBe('Lora')
  } )

  it('applies the master\'s own identity update, once', async () => {
    quiet()
    const m = master()
    await m.tick( 40 )
    const footprint = { tickObserved: 40, entitiesRead: new Set(), metricsRead: new Set(), entitiesModified: new Set(),
      intendedCommands: {}, source: 'executive-engine' }
    ;( m.engine as unknown as { onReasoningComplete( o: unknown, f: unknown, c: unknown ): unknown } )
      .onReasoningComplete( { actions: [], reasoning: 'r', confidence: 0.8,
        identityUpdates: { traits: [ { key: 'openness', value: 0.1 } ], style: 'dry, exact, unhurried' } }, footprint, ctx )
    await m.tick( 41 )
    await m.tick( 42 )
    expect( m.identity()['traits'] ).toEqual( { openness: 0.6 } )
    expect( m.identity()['style'] ).toBe('dry, exact, unhurried')
  } )
} )

// ── the identity rules ───────────────────────────────────────

describe('what the mind concludes about who it is', () => {
  const stateWith = ( metadata: Record<string, unknown> ) =>
    ( { tick: 1, entities: new Map( [ [ 'identity-self', { id: 'identity-self', type: 'will.identity', metadata } ] ] ) } ) as never

  it('adds values, and removes none an operator gave it', () => {
    const c = identityUpdateCommand( stateWith( { values: [ 'clarity', 'care' ], version: 1 } ),
      [ { values: [ 'Candour', 'clarity ' ] } ] )!
    expect( c.metadata!['values'] ).toEqual( [ 'clarity', 'care', 'Candour' ] )
    expect( c.metadata!['version'] ).toBe( 2 )
  } )

  it('takes a style only while the style is still generic', () => {
    expect( identityUpdateCommand( stateWith( { style: 'natural and authentic' } ), [ { style: 'dry and exact' } ] )!
      .metadata!['style'] ).toBe('dry and exact')
    expect( identityUpdateCommand( stateWith( { style: 'warm, Socratic' } ), [ { style: 'dry and exact' } ] ) ).toBeNull()
    expect( identityUpdateCommand( stateWith( { style: '' } ), [ { style: 'helpful' } ] ) ).toBeNull()
  } )

  it('moves a trait by its delta, within 0..1, and writes nothing when nothing changes', () => {
    expect( identityUpdateCommand( stateWith( { traits: { openness: 0.95 } } ), [ { traits: [ { key: 'openness', value: 0.2 } ] } ] )!
      .metadata!['traits'] ).toEqual( { openness: 1 } )
    expect( identityUpdateCommand( stateWith( { values: [ 'care' ] } ), [ { values: [ 'care' ] } ] ) ).toBeNull()
  } )

  it('the nudge asks for a block the parser reads, and the parser reads its style', () => {
    const context = { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'helpful' },
      worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
      affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
      goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
      beliefs: [], beliefsOmitted: 0, recentActions: [] } as unknown as ExecutiveContext
    const sm = new DefaultStateManager(); sm.updateClock( 30 as never, 30000 as never )
    const prompt = buildUserMessage( { context, state: sm.snapshot(), qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null }, focus: { title: 'T', content: 'focus' }, mode: 'master' } as never )
    expect( prompt ).toContain('`identityUpdates.values`')
    expect( prompt ).toContain('`identityUpdates.style`')
    expect( prompt ).not.toContain('IDENTITY_UPDATE')

    const out = parseResponse( JSON.stringify( { actions: [], confidence: 0.8,
      reasoning: 'r' + block('IDENTITY', { identityUpdates: { style: 'dry and exact', values: [ 'candour' ] } }) } ), sm.snapshot(), [] )
    expect( out.identityUpdates ).toEqual( { style: 'dry and exact', values: [ 'candour' ] } )
  } )
} )

// ── the narrator tells a story, and leaves identity alone ────

describe('the narrator takes each executive output into the story once', () => {
  it('appends a narrative still fresh at its next pass once, and writes no identity', async () => {
    const output = { narrative: 'I took the release review over.', narrativeThemes: [ 'ownership' ],
      identityUpdates: { traits: [ { key: 'openness', value: 0.1 } ] } }
    const narrator = new AutobiographicalNarrator()
    narrator.attachExecutiveEngine( { latestOutput: output, isFresh: () => true } as never )
    // Something to make a heuristic chapter of, were one written in its place.
    narrator.attachEpisodicConsolidator( { query: () => [ { activationStrength: 0.9, affectiveContext: { valence: 0.6 } } ] } as never )
    const sm = new DefaultStateManager()
    sm.setEntity( { id: 'identity-self', type: 'will.identity', metadata: { traits: { openness: 0.5 } } } )
    const writes: string[] = []
    for( const t of [ 50, 100 ] ){
      sm.updateClock( t as never, t * 1000 as never )
      const r = await narrator.react( 1000 as never, t as never, sm.snapshot(), ctx )
      writes.push( ...( r.commands?.set ?? [] ).map( e => e.id ) )
      if( r.commands ) sm.applyCommands( r.commands )
    }
    const story = ( narrator as unknown as { _narrative: { story: string } } )._narrative.story
    expect( story.split('I took the release review over.').length - 1 ).toBe( 1 )
    expect( story ).not.toMatch( /\[Chapter \d+\]/ )
    expect( writes ).not.toContain('identity-self')
  } )
} )

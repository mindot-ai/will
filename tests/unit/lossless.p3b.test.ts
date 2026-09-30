// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p3b.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P3b — the artifact is whole, and waking does not overwrite the mind.
 *
 * The PMA carried the top 50 beliefs, 10 goals (and only `active` ones — the
 * filter also accepted `in_progress`, a status that does not exist), 20
 * relationships and 50 skills. And it was loaded ON TOP of every snapshot:
 * `Will.wake` restores the latest snapshot inside createWill and then loads the
 * artifact, which the loader's own doc said must never happen. So every wake
 * reset goal progress to 0, re-dated every belief to tick 0, and replaced the
 * dossiers of the people the mind knew best with stubs that had no handles — it
 * knew who they were and could not reach them.
 */

import { describe, it, expect } from 'vitest'
import { PMADistiller, PMALoader, PMA_SCHEMA_VERSION, type PMASnapshot } from '#pma/index'
import { assembleMind, type WillConfig } from '#stem/mind'
import { GoalManager } from '#faculties/goal.manager'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { distillCompetence } from '#agency/competence.codec'
import { validateWillIdentity } from '#stem/guards/identity.guard'
import { UtteranceTap } from '#surface/host/utterances'
import { createContext } from '#core/utils'
import type { SimulationEntity, SimulationState } from '#core/types'
import type { MotorSchema } from '#agency/types'
import type { Handle } from '#cognition/social.identity'

const ctx = createContext('sim', 'run', 42 )
const ent = ( id: string, type: string, metadata: Record<string, unknown> ): SimulationEntity =>
  ( { id, type, createdAt: 0, updatedAt: 0, metadata } as SimulationEntity )
const stateOf = ( entities: SimulationEntity[], tick = 900 ): SimulationState =>
  ( { tick, time: tick * 1000, metrics: new Map(), entities: new Map( entities.map( e => [ e.id, e ] ) ) } )

const CONFIG: Omit<WillConfig, 'id'> = {
  name: 'TestWill', anatomy: 'reflex', persistentMemory: false, snapshotInterval: 999_999,
  tickIntervalMs: 0, maxTicks: 0, identity: { prompt: 'Test.', values: [ 'x' ], style: 'concise', traits: {} },
}

const handle: Handle = { keid: 'discord:1531', kind: 'dm', lastAnsweredTick: 870 }

function artifact( over: Partial<PMASnapshot> = {} ): PMASnapshot {
  return {
    schemaVersion: PMA_SCHEMA_VERSION, willId: 'w', willName: 'W', distilledAt: 0, sourceSessionId: 's',
    identity: { prompt: 'I am.', values: [ 'x' ], traits: {}, style: 'concise', version: 1 },
    beliefs: [], goals: [], relationships: [], episodicCount: 0,
    emotionalBaseline: { dominantMood: 'neutral', avgValence: 0, arousalProfile: 'moderate', avgSpikeFrequency: 0, temperamentValence: 0, reactivity: 0.5 },
    behavioral: { topActions: [], avgConfidence: 0.5, completionRate: null },
    meta: { beliefCount: 0, goalCount: 0, relationshipCount: 0, sessionSummaryCount: 0 },
    ...over,
  } as PMASnapshot
}

/** A mind as `Will.wake` makes it: the snapshot restored inside createWill, then the artifact. */
function wake( snapshot: SimulationEntity[], pma: PMASnapshot ){
  const { simulation, cognition } = assembleMind('p3b', { id: 'p3b', ...CONFIG } )
  simulation.stateManager.restore( stateOf( snapshot ), { entities: true, metrics: false } )
  new PMALoader().load( pma, simulation, cognition )
  return { sm: simulation.stateManager, cognition }
}

// ── the artifact is whole ────────────────────────────────────

describe('the artifact carries everything the mind holds', () => {
  const pma = new PMADistiller().distill('w', 'W', stateOf( [
    ...Array.from( { length: 60 }, ( _, i ) => ent( `b-${ i }`, 'belief', { statement: `fact ${ i }`, confidence: 0.5, supportingEpisodes: 1, tags: [] } ) ),
    ...Array.from( { length: 12 }, ( _, i ) => ent( `goal-${ i }`, 'goal',
      { description: `goal ${ i }`, priority: 0.5, progress: 0.3, status: [ 'active', 'pending', 'blocked' ][ i % 3 ] } ) ),
    ent('goal-done', 'goal', { description: 'shipped', priority: 0.9, status: 'completed' } ),
    ...Array.from( { length: 25 }, ( _, i ) => ent( `ke-p${ i }`, 'known-entity',
      { keid: `p${ i }`, kind: 'sentient', name: `Person ${ i }`, familiarity: 0.5, handles: [ handle ] } ) ),
  ] ), 's')

  it('every belief, not the top fifty', () => { expect( pma.beliefs ).toHaveLength( 60 ) } )

  it('every goal still held — pending and blocked too — and not a finished one', () => {
    expect( pma.goals ).toHaveLength( 12 )
    expect( new Set( pma.goals.map( g => g.status ) ) ).toEqual( new Set( [ 'active', 'pending', 'blocked' ] ) )
  } )

  it('everyone it knows, with where to reach them', () => {
    expect( pma.relationships ).toHaveLength( 25 )
    expect( pma.relationships[0]!.dossier!.handles ).toEqual( [ handle ] )
  } )

  it('every skill above the habit floor, not the fifty strongest', () => {
    const rep = new SchemaRepertoire()
    for( let i = 0; i < 60; i++ ){
      const id = `routine-${ i }`
      rep.registerComposite( { id, kind: 'composite', source: 'repertoire', binds: 'none', cost: 0.1,
        composedOf: [ 'rest', 'reflect' ], tags: [] } as MotorSchema )
      for( let n = 0; n < 12; n++ ) rep.recordOutcome( { schema: id, success: true, outcomeQuality: 0.9, predictedReward: 0.9, tick: n } )
    }
    expect( distillCompetence( rep ).skills.filter( s => s.schema.startsWith('routine-') ) ).toHaveLength( 60 )
  } )
} )

// ── waking does not overwrite the mind ───────────────────────

describe('waking onto a snapshot keeps the snapshot', () => {
  it('a goal keeps its progress', async () => {
    // Status is the capacity rule's to move once the mind ticks (a pending goal
    // with a free slot is promoted); progress is the snapshot's, not the artifact's.

    const { sm, cognition } = wake(
      [ ent('goal-3', 'goal', { description: 'unblock payments', priority: 0.7, progress: 0.6, status: 'pending' } ) ],
      artifact( { goals: [ { id: 'goal-3', description: 'unblock payments', priority: 0.7, progress: 0.1, status: 'active',
        tags: [], completionType: 'epistemic', completionCondition: undefined } ] } ) )
    await cognition.goalManager.react( 1000 as never, 901 as never, sm.snapshot(), ctx )
    expect( cognition.goalManager.getGoal('goal-3')!.progress ).toBe( 0.6 )
  } )

  it('a belief keeps when it was last confirmed', async () => {
    const { sm, cognition } = wake(
      [ ent('b-1', 'belief', { statement: 'the demo is Thursday', category: 'world_fact', confidence: 0.8, supportingEpisodes: 4, lastUpdatedAt: 880, tags: [] } ) ],
      artifact( { beliefs: [ { id: 'b-1', statement: 'the demo is Thursday', category: 'world_fact', confidence: 0.8, supportingEpisodes: 4, tags: [], history: [] } ] } ) )
    await cognition.semanticIntegrator.react( 1000 as never, 901 as never, sm.snapshot(), ctx )
    expect( cognition.semanticIntegrator.getBeliefs().find( b => b.id === 'b-1')!.lastUpdatedAt ).toBe( 880 )
  } )

  it('a person keeps the handles they are reached at, and the fuller model of their mind', () => {
    const { sm } = wake(
      [ ent('ke-alice', 'known-entity', { keid: 'alice', kind: 'sentient', name: 'Alice', familiarity: 0.8, handles: [ handle ] } ),
        ent('tom-alice', 'theory_of_mind', { keid: 'alice', modelConfidence: 0.7, beliefCount: 5 } ) ],
      artifact( { relationships: [ { keid: 'alice', agentName: 'Alice',
        dossier: { kind: 'sentient', name: 'Alice', familiarity: 0.8, valence: 0, reliability: 0.5, encounterCount: 9, resolutionConfidence: 0.9 },
        mentalModel: { modelConfidence: 0.7, dominantIntention: null, estimatedEmotion: 'neutral' } } ] } ) )
    expect( sm.getEntity('ke-alice')!.metadata!['handles'] ).toEqual( [ handle ] )
    expect( sm.getEntity('tom-alice')!.metadata!['beliefCount'] ).toBe( 5 )
  } )

  it('does not remember the last conversation twice', () => {
    const { sm } = wake(
      [ ent('episodic-40-0', 'episodic_memory', { sourceType: 'conversation.exchange',
          content: { entityId: 'alice', summary: 'Alice: "Thursday?" → "Thursday."' } } ) ],
      artifact( { relationships: [ { keid: 'alice', agentName: 'Alice', lastConversationDigest: 'Alice: "Thursday?" → "Thursday."' } ] } ) )
    expect( sm.getEntity('wm-exchange-restored-alice') ).toBeUndefined()
  } )
} )

describe('waking from the artifact alone restores it as it was', () => {
  it('a pending goal comes back pending, with its progress', () => {
    const { cognition } = wake( [], artifact( { goals: [ { id: 'goal-9', description: 'hire a designer', priority: 0.4, progress: 0.25,
      status: 'pending', tags: [], completionType: 'epistemic', completionCondition: undefined } ] } ) )
    expect( cognition.goalManager.getGoal('goal-9') ).toMatchObject( { progress: 0.25, status: 'pending' } )
  } )

  it('a person comes back with the handles they are reached at', () => {
    const { sm } = wake( [], artifact( { relationships: [ { keid: 'alice', agentName: 'Alice',
      dossier: { kind: 'sentient', name: 'Alice', familiarity: 0.8, valence: 0, reliability: 0.5, encounterCount: 9, resolutionConfidence: 0.9, handles: [ handle ] } } ] } ) )
    expect( sm.getEntity('ke-alice')!.metadata!['handles'] ).toEqual( [ handle ] )
  } )
} )

// ── the rest of what she keeps ───────────────────────────────

describe('what else is kept whole', () => {
  it('a new goal never takes the name of one already held', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as never, 900 as never, stateOf( [ ent('goal-1', 'goal', { description: 'ship the review', priority: 0.8, status: 'active' } ) ] ), ctx )
    const id = gm.addGoal('brief FKEM', 0.5 )
    expect( id ).not.toBe('goal-1')
    expect( gm.getGoal('goal-1')!.description ).toBe('ship the review')
  } )

  it('an operator\'s thirteenth value is refused, not cut; the mind\'s own is kept', () => {
    const values = Array.from( { length: 14 }, ( _, i ) => `value ${ i }` )
    const identity = { prompt: 'I keep the company running and say so plainly.', values, traits: {}, style: 'x'.repeat( 250 ) }
    const operator = validateWillIdentity( { identity } )
    expect( operator.ok ).toBe( false )
    expect( operator.errors.join(' ') ).toMatch( /values has 14 entries/ )
    expect( operator.errors.join(' ') ).toMatch( /style is 250 chars/ )

    const own = validateWillIdentity( { identity, source: 'artifact' } )
    expect( own.ok ).toBe( true )
    expect( own.sanitized.identity.values ).toHaveLength( 14 )
    expect( own.sanitized.identity.style ).toHaveLength( 250 )
  } )

  it('holds every word she said until a host takes it, not the last fifty', () => {
    const handlers: Array<( m: unknown ) => void> = []
    const will = { on: ( _e: string, h: ( m: unknown ) => void ) => { handlers.push( h ) } }
    const tap = new UtteranceTap( will as never )
    for( let i = 0; i < 60; i++ ) for( const h of handlers ) h( { id: `m${ i }`, content: `line ${ i }`, to: 'alice' } )
    expect( tap.takeBuffered()!.content ).toBe('line 0')
  } )
} )

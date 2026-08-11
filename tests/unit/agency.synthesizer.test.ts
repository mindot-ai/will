// ─────────────────────────────────────────────────────────────
// tests/unit/agency.synthesizer.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 0 — proves the head of the agency pipeline behaves like a mind, not a
// catalog: the field is never empty (innate floor), preconditions gate
// availability against body state, attention caps the field width, perception
// evokes bound affordances, ids are deterministic, and the field is transient.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'

const CTX = {} as unknown as SimulationContext

function makeState( opts: {
  tick?:     number
  metrics?:  Record<string, number>
  entities?: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>
} ): ReadonlySimulationState {
  const metrics  = new Map<string, number>( Object.entries( opts.metrics ?? {} ) )
  const entities = new Map<string, unknown>()
  for( const e of opts.entities ?? [] )
    entities.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick: opts.tick ?? 1, time: 0, entities, metrics } as unknown as ReadonlySimulationState
}

const affordances = ( set: EntityInput[] | undefined ) =>
  ( set ?? [] ).filter( e => e.type === 'affordance')

const bySchema = ( set: EntityInput[] | undefined, schema: string ) =>
  affordances( set ).find( e => e.metadata?.['schema'] === schema )

describe('AffordanceSynthesizer — the field is never empty', () => {
  it('emits the innate floor every tick with no perception present', async () => {
    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({ metrics: { 'energy.level': 50 } }), CTX )

    const field = affordances( res.commands?.set )
    // floor: orient, attend, rest, withdraw, reflect, wait, express
    expect( field.length ).toBeGreaterThanOrEqual( 7 )
    expect( bySchema( res.commands?.set, 'orient') ).toBeDefined()
    expect( bySchema( res.commands?.set, 'rest') ).toBeDefined()
    expect( res.commands?.metrics ).toContainEqual( [ 'affordance.field_size', field.length ] )
  })
})

describe('AffordanceSynthesizer — body state gates availability', () => {
  it('marks energy-hungry stances unavailable when depleted, rest still available', async () => {
    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({ metrics: { 'energy.level': 5 } }), CTX )

    expect( bySchema( res.commands?.set, 'attend')?.metadata?.['available'] ).toBe( false )  // needs energy > 10
    expect( bySchema( res.commands?.set, 'rest')?.metadata?.['available'] ).toBe( true )      // needs energy < 95
  })
})

describe('AffordanceSynthesizer — attention gates the width of the field', () => {
  it('caps non-innate affordances at attention.capacity, keeping the most salient', async () => {
    const percepts = Array.from( { length: 8 }, ( _, i ) => ({
      id:       `percept-${ i }`,
      type:     'percept',
      metadata: { salience: i / 10, summary: `signal ${ i }` },
    }) )

    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80, 'attention.capacity': 3 },
      entities: percepts,
    }), CTX )

    const perceptual = affordances( res.commands?.set ).filter( e => e.metadata?.['source'] === 'perceptual')
    expect( perceptual ).toHaveLength( 3 )
    // innate floor is never capped — still fully present alongside the 3
    expect( bySchema( res.commands?.set, 'orient') ).toBeDefined()
  })
})

describe('AffordanceSynthesizer — perception evokes bound affordances', () => {
  it('a known sentient entity affords reach-out, bound to its id', async () => {
    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 60 },
      entities: [ {
        id:       'ke-alice',
        type:     'known-entity',
        metadata: { keid: 'alice', kind: 'sentient', name: 'Alice', familiarity: 0.8, valence: 0.4 },
      } ],
    }), CTX )

    const reach = bySchema( res.commands?.set, 'reach-out')
    expect( reach ).toBeDefined()
    expect( reach?.metadata?.['targetEntityId'] ).toBe('alice')
    expect( reach?.metadata?.['source'] ).toBe('social')
  })
})

describe('AffordanceSynthesizer — a goal lifts outreach above the attention cap (B1)', () => {
  // Regression for the proactive-outreach gap: a freshly-met (low-familiarity)
  // interlocutor's reach-out has low intrinsic salience and is normally capped out
  // by a flood of higher-salience percepts (rumination). An ACTIVE GOAL targeting
  // that entity must lift its reach-out into the field so the competition can pick it
  // — goal-relevance has to count at the synthesis cap, not only at selection.
  it('surfaces reach-out for a goal-targeted low-familiarity entity despite a capping flood', async () => {
    const flood = Array.from( { length: 6 }, ( _, i ) => ({
      id:       `percept-${ i }`,
      type:     'percept',
      metadata: { salience: 0.6 + i / 50, summary: `rumination ${ i }` },
    }) )

    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80, 'attention.capacity': 3 },
      entities: [
        { id: 'ke-dr-chen', type: 'known-entity',
          metadata: { keid: 'dr-chen', kind: 'sentient', name: 'Dr. Chen', familiarity: 0.1, valence: 0.05 } },
        { id: 'goal-reach', type: 'goal',
          metadata: { status: 'active', priority: 0.95, targetEntityId: 'dr-chen',
                      description: 'Reach out to Dr. Chen' } },
        ...flood,
      ],
    }), CTX )

    const reach = bySchema( res.commands?.set, 'reach-out')
    expect( reach ).toBeDefined()                                  // must survive the cap…
    expect( reach?.metadata?.['targetEntityId'] ).toBe('dr-chen')
  })

  it('does NOT lift outreach for an entity no active goal targets (stays capped)', async () => {
    const flood = Array.from( { length: 6 }, ( _, i ) => ({
      id:       `percept-${ i }`,
      type:     'percept',
      metadata: { salience: 0.6 + i / 50, summary: `rumination ${ i }` },
    }) )

    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80, 'attention.capacity': 3 },
      entities: [
        { id: 'ke-stranger', type: 'known-entity',
          metadata: { keid: 'stranger', kind: 'sentient', name: 'Stranger', familiarity: 0.1, valence: 0.05 } },
        ...flood,
      ],
    }), CTX )

    // No goal → the low-familiarity reach-out is correctly out-competed by the flood.
    expect( bySchema( res.commands?.set, 'reach-out') ).toBeUndefined()
  })

  it('recognizes the keid: tag link (KnownEntityTracker curiosity goals), not just targetEntityId', async () => {
    const flood = Array.from( { length: 6 }, ( _, i ) => ({
      id:       `percept-${ i }`,
      type:     'percept',
      metadata: { salience: 0.6 + i / 50, summary: `rumination ${ i }` },
    }) )

    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80, 'attention.capacity': 3 },
      entities: [
        { id: 'ke-dr-chen', type: 'known-entity',
          metadata: { keid: 'dr-chen', kind: 'sentient', name: 'Dr. Chen', familiarity: 0.1, valence: 0.05 } },
        // Entity-linked via a `keid:` tag (no targetEntityId metadata) — the convention
        // KnownEntityTracker uses for the curiosity goals it auto-forms about a new mind.
        { id: 'goal-curiosity', type: 'goal',
          metadata: { status: 'active', priority: 0.8, description: 'Get to know Dr. Chen',
                      tags: [ 'curiosity', 'known-entity', 'keid:dr-chen' ] } },
        ...flood,
      ],
    }), CTX )

    expect( bySchema( res.commands?.set, 'reach-out') ).toBeDefined()
  })
})

describe('AffordanceSynthesizer — ideomotor leg (executive-imagined actions) (Route A)', () => {
  // The executive writes `ideomotor.intent` entities for actions it imagines. They
  // enter the field pre-activated (it willed them) but still compete — and carry
  // source:'ideomotor' so the selector/telemetry can tell them apart.
  it('surfaces an ideomotor affordance from an ideomotor.intent (source=ideomotor) above a capping flood', async () => {
    const flood = Array.from( { length: 6 }, ( _, i ) => ({
      id:       `percept-${ i }`,
      type:     'percept',
      metadata: { salience: 0.6 + i / 50, summary: `rumination ${ i }` },
    }) )

    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80, 'attention.capacity': 3 },
      entities: [
        // No goal, no high familiarity — the executive simply imagined reaching out.
        { id: 'ideo-1', type: 'ideomotor.intent',
          metadata: { schema: 'reach-out', targetEntityId: 'dr-chen', priority: 0.8 } },
        ...flood,
      ],
    }), CTX )

    const reach = bySchema( res.commands?.set, 'reach-out')
    expect( reach ).toBeDefined()
    expect( reach?.metadata?.['source'] ).toBe('ideomotor')
    expect( reach?.metadata?.['targetEntityId'] ).toBe('dr-chen')
  })

  it('ignores an ideomotor.intent whose schema is unknown (no crash, no affordance)', async () => {
    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80 },
      entities: [ { id: 'ideo-x', type: 'ideomotor.intent', metadata: { schema: 'no-such-schema', priority: 0.9 } } ],
    }), CTX )
    expect( bySchema( res.commands?.set, 'no-such-schema') ).toBeUndefined()
  })
})

describe('AffordanceSynthesizer — deterministic & transient', () => {
  it('produces identical ids for identical (tick, state) — replay-safe', async () => {
    const synth = new AffordanceSynthesizer()
    const state = makeState({ metrics: { 'energy.level': 50 } })

    const a = affordances( ( await synth.react( 0, 7, state, CTX ) ).commands?.set ).map( e => e.id ).sort()
    const b = affordances( ( await synth.react( 0, 7, state, CTX ) ).commands?.set ).map( e => e.id ).sort()
    expect( a ).toEqual( b )
    expect( a.every( id => id.startsWith('affordance-7-') ) ).toBe( true )
  })

  it('clears the previous tick\'s field (affordances are transient)', async () => {
    const synth = new AffordanceSynthesizer()
    const res   = await synth.react( 0, 2, makeState({
      metrics:  { 'energy.level': 50 },
      entities: [ { id: 'affordance-1-orient-orient', type: 'affordance' } ],
    }), CTX )

    expect( res.commands?.delete ).toContain('affordance-1-orient-orient')
  })
})

describe('AffordanceSynthesizer — ideomotor parameters passthrough (executive args)', () => {
  it('carries an ideomotor.intent\'s parameters onto the surfaced affordance', async () => {
    const { externalSchemas } = await import('#agency/schemas/external')
    const { INNATE_SCHEMAS }  = await import('#agency/schemas/innate')
    const synth = new AffordanceSynthesizer( [ ...INNATE_SCHEMAS, ...externalSchemas( [ 'search_docs' ] ) ] )
    const res   = await synth.react( 0, 1, makeState({
      metrics:  { 'energy.level': 80 },
      entities: [
        { id: 'ideo-search', type: 'ideomotor.intent',
          metadata: { schema: 'search_docs', priority: 0.9, parameters: { query: 'tick loop design' } } },
      ],
    }), CTX )

    const aff = ( res.commands?.set ?? [] ).find( ( e: EntityInput ) =>
      e.type === 'affordance' && e.metadata?.['schema'] === 'search_docs' && e.metadata?.['source'] === 'ideomotor')
    expect( aff ).toBeDefined()
    expect( aff?.metadata?.['parameters'] ).toEqual( { query: 'tick loop design' } )
  })
})

// ── looking at what I cannot place ───────────────────────────────────────────

/**
 * The wanting and the doing referenced different things.
 *
 * `drive.curiosity_resolve` is per-REFERENT — it rises with
 * `familiarity × (1 − resolutionConfidence)` and GoalManager turns it into a real
 * goal that completes when that referent resolves. But the only `inspect` on
 * offer bound to PERCEPTS, so a mind could want to know what a room was, hold a
 * goal about it, and have no act that addressed it. The pull existed with nowhere
 * to go.
 */
describe('AffordanceSynthesizer — inspect reaches what curiosity is about', () => {
  const room = ( over: Record<string, unknown> = {} ) => ({
    id: 'ke-room', type: 'known-entity',
    metadata: { keid: 'ke:room9', kind: 'thing', familiarity: 0.8, resolutionConfidence: 0.1, ...over },
  })

  const inspectsOf = ( set: EntityInput[] | undefined ) =>
    affordances( set ).filter( e => e.metadata?.['schema'] === 'inspect')

  it('offers a look at a familiar referent it cannot place', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 1, makeState({
      metrics: { 'energy.level': 70 }, entities: [ room() ],
    }), CTX )

    const look = inspectsOf( res.commands?.set ).find( e => e.metadata?.['targetEntityId'] === 'ke:room9')
    expect( look, 'a familiar-yet-unresolved referent must be inspectable').toBeDefined()
  } )

  it('offers none once the referent is resolved — there is nothing to find out', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 1, makeState({
      metrics: { 'energy.level': 70 },
      // Above CURIOUS_RESOLVED, the same threshold the curiosity GOAL completes at.
      entities: [ room( { resolutionConfidence: 0.9 } ) ],
    }), CTX )

    expect( inspectsOf( res.commands?.set ).some( e => e.metadata?.['targetEntityId'] === 'ke:room9') ).toBe( false )
  } )

  it('offers none for something never encountered — unfamiliarity is not curiosity', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 1, makeState({
      metrics: { 'energy.level': 70 }, entities: [ room( { familiarity: 0 } ) ],
    }), CTX )

    expect( inspectsOf( res.commands?.set ).some( e => e.metadata?.['targetEntityId'] === 'ke:room9') ).toBe( false )
  } )

  it('under a narrow attention it looks at what it knows least', async () => {
    // The pull is expressed as evoke-salience, which budgets ATTENTION — it decides
    // which candidates survive the cap, not what the affordance is worth once it is
    // in the field (that is `expectedReward`, and it comes from the schema). So the
    // honest test is what a narrow mind still finds room for.
    const synth = new AffordanceSynthesizer( undefined, 1 )
    const res = await synth.react( 0, 1, makeState({
      metrics: { 'energy.level': 70 },
      entities: [
        { id: 'ke-clearer', type: 'known-entity',
          metadata: { keid: 'ke:clearer', kind: 'thing', familiarity: 0.8, resolutionConfidence: 0.5 } },
        room(),   // same familiarity, far less resolved
      ],
    }), CTX )

    const targets = inspectsOf( res.commands?.set ).map( e => e.metadata?.['targetEntityId'] )
    expect( targets, 'the thing it can place least is what it makes room to look at')
      .toContain('ke:room9')
    expect( targets ).not.toContain('ke:clearer')
  } )

  it('still offers a look at a salient percept — both kinds of looking are real', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 1, makeState({
      metrics: { 'energy.level': 70 },
      entities: [ { id: 'p1', type: 'percept', metadata: { salience: 0.8, summary: 'a sound outside' } } ],
    }), CTX )

    expect( inspectsOf( res.commands?.set ).length ).toBeGreaterThan( 0 )
  } )
} )

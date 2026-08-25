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

// ── one person, one id ────────────────────────────────────────

/**
 * The mind meets one person under more than one id, and only half of it knew.
 *
 * A REPLY is addressed to the transport id the percept arrived with
 * (`discord:1019…`); a SELF-INITIATED message is addressed to the anchor the
 * executive resolved (`ke:…`). `readSpokenTurns` — the half that builds the
 * prompt — has always resolved that through the alias table, and says so. The
 * half that builds the WEIGHTS never did.
 *
 * So: a conversation facet answers someone, and its sync spikes the master's
 * salience buffer unconditionally — that is the design, a facet reporting back is
 * the master's own attention returning. The master wakes, sees what the facet
 * worked out, and forms a `reach-out` toward the same person. The reply that just
 * went out should damp it. It did not, because the reply was filed under
 * `discord:1019…` and the reach-out asked about `ke:1sqlkux`.
 *
 * Both ids for both people are in the live logs. The prompt read them as one
 * person; satiation read them as two.
 *
 * These run through the synthesizer rather than the readers on purpose. A
 * canonical map read with a raw lookup passes every unit test of either half and
 * damps nothing in the world — which is the shape this codebase keeps shipping.
 */

const ANCHOR    = 'ke:1sqlkux'
const TRANSPORT = 'discord:1019376031150379101'

const fabrice = () => ({
  id: 'ke-fabrice', type: 'known-entity',
  metadata: { keid: ANCHOR, kind: 'sentient', name: 'Fabrice', familiarity: 0.8, valence: 0.4 },
})
const alias = () => ({
  id: 'alias-fabrice-discord', type: 'known-entity-alias',
  metadata: { aliasKeid: TRANSPORT, canonicalKeid: ANCHOR },
})
/** The record a conversation facet writes when it answers someone. */
const repliedTo = ( target: string, atTick: number ) => ({
  id: `conv-sent-reply-${ target }-${ atTick }`, type: 'conversation.sent',
  metadata: { targetEntityId: target, targetEntityName: 'Fabrice', messageCount: 1,
    preview: 'Sure — go ahead. What is on your mind?', effectorName: 'text',
    source: 'audition-facet', tick: atTick, delivered: false },
})
/** The master's willed outreach, aimed at whichever id it resolved. */
const willedOutreachTo = ( target: string ) => ({
  id: `ideomotor-reach-out-${ target }`, type: 'ideomotor.intent',
  metadata: { schema: 'reach-out', targetEntityId: target, priority: 0.85, origin: 'executive' },
})
const willedOutreach = () => willedOutreachTo( ANCHOR )

/** The descriptor the executor writes at dispatch, against the id it dispatched on. */
const spokeVia = ( target: string, atTick: number ) => ({
  id: `agency-consequence-${ target }-${ atTick }`, type: 'agency.consequence',
  metadata: { intentId: `intent-${ atTick }`, schema: 'reach-out', mode: 'communicate',
    effector: 'text', targetEntityId: target, tick: atTick, expiresAt: atTick + 30 },
})

/** A verdict already reached about this person, under one of their ids. */
const settledOn = ( target: string, atTick: number ) => ({
  id: `agency-settlement-reach-out-${ target }`, type: 'agency.settlement',
  metadata: { schema: 'reach-out', targetEntityId: target, tick: atTick, expiresAt: atTick + 60 },
})

/**
 * A satiation window longer than the echo window, which is what separates the two
 * speech arms. `spokeAnywhereAt` — "I have just spoken AT ALL" — is pinned to
 * CONSEQUENCE_TTL_TICKS (30) on purpose, deliberately weaker than the per-person
 * arm. Left at the default both windows are 30, `spokeAnywhereAt` damps 0.9 at a
 * gap of 3 whoever was spoken to, and it masks the arm under test completely.
 * Measured past 30 the general arm is spent and only the per-person one is left.
 */
const window = ( ticks: number ) => ({
  id: 'engine-config-action-selector', type: 'engine.config',
  metadata: { params: { repeatWindowTicks: ticks } },
})

const reachOutAt = async ( entities: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>, tick: number ) => {
  const res = await new AffordanceSynthesizer().react( 0, tick, makeState({
    tick, metrics: { 'energy.level': 60 }, entities: [ window( 120 ), ...entities ],
  }), CTX )
  return bySchema( res.commands?.set, 'reach-out')
}

describe('AffordanceSynthesizer — one person, one id', () => {
  it('damps reaching out to someone the facet just replied to', async () => {
    const reach = await reachOutAt(
      [ fabrice(), alias(), repliedTo( TRANSPORT, 100 ), willedOutreach() ], 160 )

    expect( reach, 'the willed outreach never reached the field').toBeDefined()
    expect( reach?.metadata?.['justEnacted'],
      'answering them under one id did not damp reaching them under the other' )
      .toBeCloseTo( 0.5, 2 )
  })

  it('does not damp when the two ids really are two people', async () => {
    // No alias entity: `discord:1019…` is simply someone else, and having spoken
    // to them must leave Fabrice alone. This is what stops the fix being a
    // wildcard that satiates everyone at once.
    const reach = await reachOutAt(
      [ fabrice(), repliedTo( TRANSPORT, 100 ), willedOutreach() ], 160 )

    expect( reach ).toBeDefined()
    expect( reach?.metadata?.['justEnacted'] ).toBeUndefined()
  })

  it('damps on the anchor too — the ordinary case still works', async () => {
    const reach = await reachOutAt(
      [ fabrice(), alias(), repliedTo( ANCHOR, 100 ), willedOutreach() ], 160 )

    expect( reach?.metadata?.['justEnacted'] ).toBeCloseTo( 0.5, 2 )
  })

  it('fades, so the outreach becomes possible again', async () => {
    // A refractory period, never a veto — she may genuinely have something to add.
    const near = await reachOutAt( [ fabrice(), alias(), repliedTo( TRANSPORT, 100 ), willedOutreach() ], 160 )
    const far  = await reachOutAt( [ fabrice(), alias(), repliedTo( TRANSPORT, 100 ), willedOutreach() ], 210 )

    expect( Number( far?.metadata?.['justEnacted'] ?? 0 ) )
      .toBeLessThan( Number( near?.metadata?.['justEnacted'] ) )
  })

  it('damps the mirror case too — aimed at the alias, recorded on the anchor', async () => {
    // The half the first four tests cannot reach. An ideomotor outreach carries
    // the anchor, so canonicalising the LOOKUP is a no-op for it and the map half
    // alone appears to be the whole fix. A candidate evoked from a percept carries
    // the transport id instead, and then it is the lookup that has to resolve.
    const reach = await reachOutAt(
      [ fabrice(), alias(), repliedTo( ANCHOR, 100 ), willedOutreachTo( TRANSPORT ) ], 160 )

    expect( reach?.metadata?.['justEnacted'] ).toBeCloseTo( 0.5, 2 )
  })

  it('damps from a consequence descriptor across the two ids', async () => {
    // The descriptor arm, which is a different reader from `conversation.sent` and
    // carries whatever id the intent was dispatched against.
    const reach = await reachOutAt(
      [ fabrice(), alias(), spokeVia( TRANSPORT, 100 ), willedOutreach() ], 120 )

    expect( reach?.metadata?.['justEnacted'],
      'a descriptor under one id did not damp a candidate under the other')
      .toBeGreaterThan( 0 )
  })

  it('holds a settlement across the two ids', async () => {
    // Settlement is keyed exactly as satiation is — its own comment says so — so
    // it has to share the same id space, or a verdict reached about a person under
    // one id would not hold about them under the other.
    const reach = await reachOutAt(
      [ fabrice(), alias(), settledOn( TRANSPORT, 140 ), willedOutreach() ], 160 )

    expect( reach?.metadata?.['settled'],
      'the verdict did not follow the person across their ids').toBeGreaterThan( 0 )
  })

  it('leaves the affordance aimed where it was aimed', async () => {
    // Only the QUESTION is asked in canonical form. Rewriting the affordance's own
    // target would change who the act is delivered against, which is not what
    // canonicalising a lookup is for.
    const reach = await reachOutAt(
      [ fabrice(), alias(), repliedTo( TRANSPORT, 100 ), willedOutreach() ], 160 )

    expect( reach?.metadata?.['targetEntityId'] ).toBe( ANCHOR )
  })
})

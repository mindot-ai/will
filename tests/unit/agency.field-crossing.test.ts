// ─────────────────────────────────────────────────────────────
// tests/unit/agency.field-crossing.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The hop between synthesis and selection.
 *
 * Engines cannot hand each other objects — they write state and read it back a
 * step later. So every field of an Affordance crosses one encode/decode boundary
 * (`AffordanceSynthesizer._toEntity` → `readAffordance`), and a field missing
 * from either side is silently `undefined` in the competition. No type error, no
 * failing test, no log: the mechanism that field carries simply never runs.
 *
 * Three had been lost there, each the payload of a shipped mechanism:
 *
 *   • `justEnacted` — `scoreAffordance` subtracts `w.repeat × justEnacted`, the
 *     LARGEST damping weight at 0.30. Never written, so ×0 always: no act has
 *     ever been damped for having just been done. EXAFFERENCE P5 and the
 *     `spokenAt` durability fix both landed on a field nothing read.
 *   • `availability` — POLICY_REAFFERENCE P2's refusal damping. Written but
 *     never read, so `a.availability ?? 1` took the fallback forever.
 *   • `description` — the schema's MEANING, snapshotted by the selector onto
 *     `metadata.candidates` and rendered by the DeliberationEngine as `— <what>`.
 *     The candidate list the mind reasons over listed acts with no meanings.
 *
 * `settled` is the fourth, and the first to arrive with its decoder already
 * written rather than months after the mechanism shipped dark.
 *
 * They survived because the units were tested and the SEAM was not:
 * `agency.repetition.test.ts` builds Affordance literals in memory and calls
 * `scoreAffordance` directly, which is a true statement about the scorer and
 * says nothing about whether anything reaches it. This file tests the crossing.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import type { LearnedSkill } from '#agency/types'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { readAffordance } from '#agency/engines/action.selector'
import { scoreAffordance, DEFAULT_WEIGHTS } from '#agency/selection.scoring'
import type { BiasContext } from '#agency/selection.scoring'
import { settlementId, SETTLEMENT_TYPE, SETTLEMENT_TTL_TICKS } from '#agency/settlement'

const CTX = {} as unknown as SimulationContext

function makeState( opts: {
  tick?: number
  metrics?: Record<string, number>
  entities?: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>
} ): ReadonlySimulationState {
  const metrics  = new Map<string, number>( Object.entries( opts.metrics ?? {} ) )
  const entities = new Map<string, unknown>()
  for( const e of opts.entities ?? [] )
    entities.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick: opts.tick ?? 1, time: 0, entities, metrics } as unknown as ReadonlySimulationState
}

const bySchema = ( set: EntityInput[] | undefined, schema: string ) =>
  ( set ?? [] ).find( e => e.type === 'affordance' && e.metadata?.['schema'] === schema )

/** A skill record as the repertoire keeps one, enacted at `lastEnactedTick`. */
function skill( schema: string, lastEnactedTick: number ): LearnedSkill {
  return {
    schema, valueEstimate: 0.6, habitStrength: 0.9,
    enactments: 10, successes: 9, lastEnactedTick,
    paramPriors: {},
  } as unknown as LearnedSkill
}

const bias = (): BiasContext => ({
  valence: 0, threat: 0, inhibition: 0,
  drives: { energy: 0, sleep: 0, social: 0, stress: 0 },
  goalTargets: new Map(),
} as unknown as BiasContext )

// ─────────────────────────────────────────────────────────────

describe('the hop between synthesis and selection', () => {
  it('carries an act\'s own footprint across, so satiation reaches the competition', async () => {
    const synth = new AffordanceSynthesizer()
    // `express` binds no object, so its footprint IS the act: it was enacted on
    // this very tick, and the mind should feel that when offered it again.
    synth.attachSkills( () => new Map([ [ 'express', skill('express', 20 ) ] ]) )

    const res = await synth.react( 0, 20, makeState({ tick: 20, metrics: { 'energy.level': 60 } }), CTX )
    const entity = bySchema( res.commands?.set, 'express')

    expect( entity?.metadata?.['justEnacted'],
      'the footprint must be WRITTEN — this is the hop it did not cross')
      .toBeGreaterThan( 0 )

    const decoded = readAffordance( entity!.id, entity!.metadata )
    expect( decoded.justEnacted,
      'and READ — a field only one side knows about is undefined in the scorer')
      .toBeGreaterThan( 0 )
  })

  it('and that footprint actually damps the score', async () => {
    const synth = new AffordanceSynthesizer()
    synth.attachSkills( () => new Map([ [ 'express', skill('express', 20 ) ] ]) )

    const fresh = await new AffordanceSynthesizer().react(
      0, 20, makeState({ tick: 20, metrics: { 'energy.level': 60 } }), CTX )
    const sated = await synth.react(
      0, 20, makeState({ tick: 20, metrics: { 'energy.level': 60 } }), CTX )

    const a = bySchema( fresh.commands?.set, 'express')!
    const b = bySchema( sated.commands?.set, 'express')!

    const scoreOf = ( e: EntityInput ) =>
      scoreAffordance( readAffordance( e.id, e.metadata ), bias(), DEFAULT_WEIGHTS )

    // Sated scores lower despite the habit bonus a practised act carries.
    expect( scoreOf( b ) ).toBeLessThan( scoreOf( a ) )
  })

  it('the footprint decays — satiation is a refractory period, not a lock', async () => {
    const at = async ( tick: number ) => {
      const synth = new AffordanceSynthesizer()
      synth.attachSkills( () => new Map([ [ 'express', skill('express', 20 ) ] ]) )
      const res = await synth.react( 0, tick, makeState({ tick, metrics: { 'energy.level': 60 } }), CTX )
      return Number( bySchema( res.commands?.set, 'express')?.metadata?.['justEnacted'] ?? 0 )
    }

    const justNow = await at( 20 )
    const later   = await at( 35 )
    const longAfter = await at( 60 )   // past the 30-tick window

    expect( justNow ).toBeGreaterThan( later )
    expect( later ).toBeGreaterThan( 0 )
    expect( longAfter ).toBe( 0 )      // the appetite comes back on its own
  })

  it('an act never enacted carries no footprint (a mind that has done nothing is undamped)', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 20, makeState({ tick: 20, metrics: { 'energy.level': 60 } }), CTX )
    const entity = bySchema( res.commands?.set, 'express')!

    expect( entity.metadata?.['justEnacted'] ).toBeUndefined()
    expect( readAffordance( entity.id, entity.metadata ).justEnacted ).toBeUndefined()
  })

  it('carries the schema\'s meaning across, so the candidate list is not a list of bare verbs', async () => {
    const synth = new AffordanceSynthesizer( [ {
      id: 'water-the-plants', kind: 'primitive', source: 'learned', binds: 'none',
      cost: 0.1, baseValence: 0.2, tags: [],
      description: 'give the plants water',
    } ] as never )

    const res = await synth.react( 0, 1, makeState({ metrics: { 'energy.level': 60 } }), CTX )
    const entity = bySchema( res.commands?.set, 'water-the-plants')!

    expect( readAffordance( entity.id, entity.metadata ).description )
      .toBe('give the plants water')
  })

  it('carries a settled verdict across, so System 2 is not re-recruited for an answered question', async () => {
    // The fourth field to make this crossing, added WITH its decoder rather than
    // after someone notices the mechanism has been dark for months. A live COO
    // deliberated 149 times in 7 hours, median 17s apart, because a verdict left
    // no trace in the field it was called in to resolve.
    const synth = new AffordanceSynthesizer()
    const state = makeState({
      tick: 110,
      metrics: { 'energy.level': 60 },
      entities: [ {
        id: settlementId('express'), type: SETTLEMENT_TYPE,
        metadata: { schema: 'express', tick: 100, expiresAt: 100 + SETTLEMENT_TTL_TICKS },
      } ],
    })

    const entity = bySchema( ( await synth.react( 0, 110, state, CTX ) ).commands?.set, 'express')!

    expect( entity.metadata?.['settled'], 'the verdict must be WRITTEN onto the affordance')
      .toBeGreaterThan( 0 )
    expect( readAffordance( entity.id, entity.metadata ).settled, 'and READ back')
      .toBeGreaterThan( 0 )

    // And it must actually move the score, or the margin never widens and the
    // selector recruits System 2 again on the next identical tick.
    const undecided = bySchema(
      ( await new AffordanceSynthesizer().react(
        0, 110, makeState({ tick: 110, metrics: { 'energy.level': 60 } }), CTX ) ).commands?.set,
      'express')!

    const scoreOf = ( e: EntityInput ) =>
      scoreAffordance( readAffordance( e.id, e.metadata ), bias(), DEFAULT_WEIGHTS )

    expect( scoreOf( entity ) - scoreOf( undecided ) ).toBeGreaterThan( 0.06 )
  })

  it('a verdict that has aged out leaves no trace — the question is open again', async () => {
    const synth = new AffordanceSynthesizer()
    const res = await synth.react( 0, 200, makeState({
      tick: 200,
      metrics: { 'energy.level': 60 },
      entities: [ {
        id: settlementId('express'), type: SETTLEMENT_TYPE,
        metadata: { schema: 'express', tick: 100, expiresAt: 100 + SETTLEMENT_TTL_TICKS },
      } ],
    }), CTX )

    expect( bySchema( res.commands?.set, 'express')?.metadata?.['settled'] ).toBeUndefined()
  })

  it('carries policy availability across, so a refused ability competes weakly', () => {
    // The synthesizer omits `availability` when 1 (a never-refused mind writes a
    // byte-identical field), so the crossing is what matters: present ⇒ read.
    const dented = readAffordance('a-1', {
      schema: 'post', source: 'learned', available: true, tags: [],
      expectedReward: 0.8, expectedValence: 0.2, cost: 0.1, habitStrength: 0,
      availability: 0.25, tick: 1,
    })
    expect( dented.availability ).toBe( 0.25 )
    expect( scoreAffordance( dented, bias(), DEFAULT_WEIGHTS ) )
      .toBeLessThan( scoreAffordance( { ...dented, availability: 1 }, bias(), DEFAULT_WEIGHTS ) )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/agency.repetition.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * An act carries its own consequence (EXAFFERENCE P5) — the missing consumer.
 *
 * Observed live: Lora delivered the SAME two messages to the same person three
 * times, at 532s / 554s / 575s — roughly 21 ticks apart, each time as though it
 * were the first.
 *
 * The mechanism was a standing want outliving the act that satisfied it. The
 * master writes `ideomotor-reach-out-<keid>`, which persists in state until its
 * next cycle rewrites the field. The selector turns that into an `agency.intent`,
 * MotorSchemaExecutor delivers and deletes the intent — but the *ideomotor* entity
 * is untouched, so the next tick synthesizes the same candidate again. The pushes
 * even land DURING the master's LLM call, which is what proves it is not the
 * master re-deciding: the field was re-enacting a want nothing had discharged.
 *
 * The descriptor recording the act already existed and was already correct —
 * `_deliver` writes one on success with schema, target, text and a 30-tick TTL.
 * Nothing read it back. `enactionFootprint` is that reader, and `justEnacted` is
 * how it reaches the competition: as satiation that decays, not as a lock.
 */

import { describe, it, expect } from 'vitest'
import {
  enactionFootprint, consequenceEntity, readConsequence, liveConsequences,
  CONSEQUENCE_TTL_TICKS,
} from '#agency/consequence'
import { scoreAffordance, DEFAULT_WEIGHTS, type BiasContext } from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'
import type { Tick } from '#core/types'

// ── harness ───────────────────────────────────────────────────

const FABRICE = 'discord:1019376031150379101'
const FKEM    = 'discord:1525573163482742907'

/** A descriptor exactly as MotorSchemaExecutor._deliver writes one on success. */
const delivered = ( target: string, atTick: number, text = 'What are you working on?' ) =>
  readConsequence( consequenceEntity({
    intentId: `intent-${ target }-${ atTick }`,
    schema: 'reach-out', mode: 'communicate', effector: 'text',
    targetEntityId: target, text, textHash: 0,
    expiresAt: atTick + CONSEQUENCE_TTL_TICKS, tick: atTick,
  }).metadata as Record<string, unknown> )!

const bias = (): BiasContext => ({
  goalTargets: new Set<string>(), maxGoalPriority: 0,
  drives: { energy: 0, sleep: 0, social: 0, stress: 0 },
  threat: 0, inhibition: 0,
} as unknown as BiasContext )

/** The willed reach-out the executive produces, as the synthesizer builds it. */
const reachOut = ( target: string, justEnacted?: number ): Affordance => ({
  id: `affordance-1-reach-out-${ target }`,
  schema: 'reach-out', source: 'ideomotor',
  parameters: {}, targetEntityId: target,
  expectedValence: 0.2, expectedReward: 0.5, cost: 0.1, habitStrength: 0.2,
  available: true, tags: [ 'social' ], willBias: 0.75,
  ...( justEnacted !== undefined ? { justEnacted } : {} ),
  tick: 1,
} as unknown as Affordance )

// ── the footprint reader ──────────────────────────────────────

describe('enactionFootprint — how much of my own act is still in flight', () => {
  it('is ~full immediately after the act and decays to nothing by expiry', () => {
    const d = [ delivered( FABRICE, 100 ) ]

    expect( enactionFootprint( d, 'reach-out', FABRICE, 100 ) ).toBeCloseTo( 1, 5 )
    expect( enactionFootprint( d, 'reach-out', FABRICE, 115 ) ).toBeCloseTo( 0.5, 5 )
    expect( enactionFootprint( d, 'reach-out', FABRICE, 130 ) ).toBe( 0 )
    // Past expiry the appetite is fully back — a refractory period, not a ban.
    expect( enactionFootprint( d, 'reach-out', FABRICE, 200 ) ).toBe( 0 )
  } )

  it('is still substantial at the 21-tick interval the repeats actually landed on', () => {
    // The measured gap between duplicate deliveries. If the footprint had run out
    // by here the damping would not have touched the bug it exists to fix.
    const f = enactionFootprint( [ delivered( FABRICE, 100 ) ], 'reach-out', FABRICE, 121 )
    expect( f ).toBeGreaterThan( 0.25 )
  } )

  it('is per-person — saying something to one person frees nothing toward another', () => {
    const d = [ delivered( FABRICE, 100 ) ]
    expect( enactionFootprint( d, 'reach-out', FKEM, 101 ) ).toBe( 0 )
  } )

  it('is per-schema — having spoken does not damp doing something else to them', () => {
    const d = [ delivered( FABRICE, 100 ) ]
    expect( enactionFootprint( d, 'inspect', FABRICE, 101 ) ).toBe( 0 )
  } )

  it('is 0 for an act aimed at nobody', () => {
    expect( enactionFootprint( [ delivered( FABRICE, 100 ) ], 'reach-out', undefined, 101 ) ).toBe( 0 )
  } )

  it('takes the freshest footprint when several are live for the same person', () => {
    const d = [ delivered( FABRICE, 100 ), delivered( FABRICE, 120 ) ]
    expect( enactionFootprint( d, 'reach-out', FABRICE, 121 ) )
      .toBeCloseTo( ( 150 - 121 ) / CONSEQUENCE_TTL_TICKS, 5 )
  } )

  it('reads the descriptors the executor actually writes into state', () => {
    // End-to-end through the real entity shape, not a hand-built descriptor.
    const entities = new Map( [ [ 'c1', consequenceEntity({
      intentId: 'i1', schema: 'reach-out', mode: 'communicate',
      targetEntityId: FABRICE, expiresAt: 130, tick: 100,
    }) ] ].map( ( [ k, e ] ) => [ k, { type: e.type, metadata: e.metadata } ] ) )

    const live = liveConsequences( entities as never, 110 as Tick )
    expect( enactionFootprint( live, 'reach-out', FABRICE, 110 ) ).toBeCloseTo( 0.666, 2 )
  } )
} )

// ── what it does to the competition ───────────────────────────

describe('justEnacted in the competition — satiation, not a lock', () => {
  it('a freshly-delivered reach-out loses to the same one un-enacted', () => {
    const fresh = scoreAffordance( reachOut( FABRICE, 1 ), bias(), DEFAULT_WEIGHTS )
    const quiet = scoreAffordance( reachOut( FABRICE ),    bias(), DEFAULT_WEIGHTS )
    expect( fresh ).toBeLessThan( quiet )
  } )

  it('roughly cancels the volitional prior that produced it, and no more', () => {
    // The calibration claim: repeat ≈ will, so a just-delivered willed act drops
    // back to about where an unwilled one sits — suppressed, not buried. Buried
    // would mean a Will could never follow up on a silence that starts to matter.
    const justSaid = scoreAffordance( reachOut( FABRICE, 1 ), bias(), DEFAULT_WEIGHTS )
    const unwilled = scoreAffordance(
      { ...reachOut( FABRICE ), willBias: 0 } as Affordance, bias(), DEFAULT_WEIGHTS )

    expect( Math.abs( justSaid - unwilled ) ).toBeLessThan( 0.1 )
  } )

  it('recovers as the footprint decays — the pull comes back on its own', () => {
    const at = ( f: number ) => scoreAffordance( reachOut( FABRICE, f ), bias(), DEFAULT_WEIGHTS )
    expect( at( 1 ) ).toBeLessThan( at( 0.5 ) )
    expect( at( 0.5 ) ).toBeLessThan( at( 0 ) )
  } )

  it('leaves the untouched person winnable — silence toward one does not mute the other', () => {
    // The shape that matters operationally: having just messaged Fabrice should
    // make reaching FKEM the better move, not suppress reaching out altogether.
    const toFabrice = scoreAffordance( reachOut( FABRICE, 1 ), bias(), DEFAULT_WEIGHTS )
    const toFkem    = scoreAffordance( reachOut( FKEM ),       bias(), DEFAULT_WEIGHTS )
    expect( toFkem ).toBeGreaterThan( toFabrice )
  } )

  it('changes nothing when no act is in flight (quiet path is byte-identical)', () => {
    const a = reachOut( FABRICE )
    expect( a.justEnacted ).toBeUndefined()
    expect( scoreAffordance( a, bias(), DEFAULT_WEIGHTS ) )
      .toBe( scoreAffordance( { ...a, justEnacted: 0 } as Affordance, bias(), DEFAULT_WEIGHTS ) )
  } )

  it('a strong enough reason still gets through — damping is not a veto', () => {
    // Satiated, but the mind now has a high-priority goal pointed at this person.
    const urgent: BiasContext = {
      ...bias(), goalTargets: new Set( [ FABRICE ] ), maxGoalPriority: 1,
    } as BiasContext

    expect( scoreAffordance( reachOut( FABRICE, 1 ), urgent, DEFAULT_WEIGHTS ) )
      .toBeGreaterThan( 0 )
  } )
} )

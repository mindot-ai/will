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
  spokenAtByEntity, CONSEQUENCE_TTL_TICKS,
  enactedAtBySchemaTarget, enactedId, ENACTED_TYPE,
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
    const written = consequenceEntity({
      intentId: 'i1', schema: 'reach-out', mode: 'communicate',
      targetEntityId: FABRICE, expiresAt: 130, tick: 100,
    })
    const entities = new Map( [ [ written.id, { type: written.type, metadata: written.metadata } ] ] )

    const live = liveConsequences( entities as never, 110 as Tick )
    expect( enactionFootprint( live, 'reach-out', FABRICE, 110 ) ).toBeCloseTo( 0.666, 2 )
  } )
} )

// ── the satiation window belongs to the tenant ────────────────

describe("enactionFootprint — the window is the persona's, not the echo TTL's", () => {
  it('still damps at the cadence that defeated the borrowed 30-tick window', () => {
    // Re-deliveries were landing ~25 ticks apart against a 30-tick echo TTL, so the
    // damping had decayed to ~0.17 exactly when the next impulse arrived. A window
    // that reflects "how long before saying it again feels right" — the seeded
    // default is 60 — still has real weight there.
    const d = [ delivered( FABRICE, 100 ) ]
    expect( enactionFootprint( d, 'reach-out', FABRICE, 125 ) ).toBeCloseTo( 5 / 30, 2 )
    expect( enactionFootprint( d, 'reach-out', FABRICE, 125, 60 ) ).toBeCloseTo( 35 / 60, 2 )
  } )

  it("measures from when the act happened, not from the descriptor's expiry", () => {
    // Different questions: expiry is when the world's echo stops being plausible,
    // this is how long the mind stays satisfied.
    const d = [ delivered( FABRICE, 100 ) ]
    expect( enactionFootprint( d, 'reach-out', FABRICE, 100, 60 ) ).toBeCloseTo( 1, 5 )
    expect( enactionFootprint( d, 'reach-out', FABRICE, 160, 60 ) ).toBe( 0 )
  } )

  it('a tenant that repeats itself freely can flatten the window to nothing', () => {
    expect( enactionFootprint( [ delivered( FABRICE, 100 ) ], 'reach-out', FABRICE, 101, 0 ) ).toBe( 0 )
  } )

  it('defaults to the echo TTL when a harness seeds no window', () => {
    const d = [ delivered( FABRICE, 100 ) ]
    expect( enactionFootprint( d, 'reach-out', FABRICE, 115 ) )
      .toBeCloseTo( enactionFootprint( d, 'reach-out', FABRICE, 115, CONSEQUENCE_TTL_TICKS ), 5 )
  } )
} )

// ── satiation has to outlive the descriptor sweep ─────────────

/**
 * The window param alone was a NO-OP and shipped believing it worked.
 *
 * MotorSchemaExecutor deletes every descriptor at `tick >= expiresAt` (its TTL
 * sweep), so nothing survives past the echo window and a 60-tick satiation window
 * had nothing left to read. Measured live: the same relay delivered twice with
 * `justEnacted` never once appearing in the competition.
 *
 * The earlier tests missed it by building descriptors by hand and never driving
 * them through the sweep. `conversation.sent` is the durable record — written at
 * push time, snapshotted, and already what discharges an undertaking.
 */
describe('satiation reads the durable record, not just the descriptor', () => {
  const sentEntities = ( ...sends: { target: string; at: number }[] ) => new Map(
    sends.map( ( s, i ) => [ `conv-sent-${ s.target }-${ i }`, {
      type: 'conversation.sent',
      metadata: { targetEntityId: s.target, tick: s.at },
    } ] ),
  )

  it('still damps after the descriptor would have been swept away', () => {
    // 40 ticks on: the descriptor is long deleted (TTL 30), but the mind spoke
    // recently enough that saying it again should still feel wrong.
    const spoken = spokenAtByEntity( sentEntities({ target: FABRICE, at: 100 }) as never )
    expect( enactionFootprint( [], 'reach-out', FABRICE, 140, 60, spoken ) ).toBeCloseTo( 20 / 60, 5 )
  } )

  it('decays to nothing at the end of the persona window', () => {
    const spoken = spokenAtByEntity( sentEntities({ target: FABRICE, at: 100 }) as never )
    expect( enactionFootprint( [], 'reach-out', FABRICE, 160, 60, spoken ) ).toBe( 0 )
    expect( enactionFootprint( [], 'reach-out', FABRICE, 100, 60, spoken ) ).toBeCloseTo( 1, 5 )
  } )

  it("falls back to the entity's own sim tick when metadata carries none", () => {
    // Not every writer fills metadata.tick — StateManager stamps `tick` on every
    // entity, and reading metadata alone defaulted every record to 0. That made
    // satiation compare against zero and the undertaking discharge test
    // `contacted >= madeAt` false for any promise made after tick 0: both silently
    // dead against live state where every conversation.sent was stamped 0.
    const noMetaTick = new Map( [ [ 'cs1', {
      type: 'conversation.sent', tick: 120,
      metadata: { targetEntityId: FABRICE },
    } ] ] )
    expect( spokenAtByEntity( noMetaTick as never ).get( FABRICE ) ).toBe( 120 )
  } )

  it('prefers metadata.tick when the writer did set one', () => {
    const both = new Map( [ [ 'cs1', {
      type: 'conversation.sent', tick: 999,
      metadata: { targetEntityId: FABRICE, tick: 120 },
    } ] ] )
    expect( spokenAtByEntity( both as never ).get( FABRICE ) ).toBe( 120 )
  } )

  it('takes the most recent send when there are several', () => {
    const spoken = spokenAtByEntity( sentEntities(
      { target: FABRICE, at: 100 }, { target: FABRICE, at: 130 },
    ) as never )
    expect( spoken.get( FABRICE ) ).toBe( 130 )
  } )

  it('stays per-person', () => {
    const spoken = spokenAtByEntity( sentEntities({ target: FABRICE, at: 100 }) as never )
    expect( enactionFootprint( [], 'reach-out', FKEM, 110, 60, spoken ) ).toBe( 0 )
  } )

  it('is not consulted for acts that are not speaking', () => {
    // The durable half is keyed by PERSON, so it must not damp inspecting them.
    // The synthesizer gates on the schema's `communication` tag; absent the map,
    // behaviour is descriptor-only.
    const spoken = spokenAtByEntity( sentEntities({ target: FABRICE, at: 100 }) as never )
    expect( enactionFootprint( [], 'inspect', FABRICE, 110, 60 ) ).toBe( 0 )
    expect( enactionFootprint( [], 'inspect', FABRICE, 110, 60, spoken ) ).toBeGreaterThan( 0 )
  } )
} )

// ── the restore boundary ──────────────────────────────────────

describe('liveConsequences — descriptors do not survive into the next session', () => {
  /** Entities as they come back from a snapshot, keyed by the real entity id. */
  const restored = ( ...ds: { tick: number; expiresAt: number }[] ) => new Map(
    ds.map( ( d, i ) => {
      const e = consequenceEntity({
        intentId: `i${ i }`, schema: 'reach-out', mode: 'communicate',
        targetEntityId: FABRICE, expiresAt: d.expiresAt, tick: d.tick,
      })
      return [ e.id, { type: e.type, metadata: e.metadata } ]
    } ),
  )

  it('ignores a descriptor stamped later than now — it is from before the restore', () => {
    // The measured shape: a Will hibernated at tick 598 holding three reach-out
    // descriptors (tick 575–596, expiry 605–626), then woke at tick 1. The expiry
    // test alone reads all three as freshly live, so for the WHOLE session it
    // believed it had just messaged that person moments ago.
    const live = liveConsequences( restored(
      { tick: 575, expiresAt: 605 },
      { tick: 594, expiresAt: 624 },
      { tick: 596, expiresAt: 626 },
    ) as never, 1 as Tick )

    expect( live ).toEqual( [] )
  } )

  it('so a restored Will is not damped out of ever contacting that person again', () => {
    // What the bug actually cost: reach-out fully damped for the entire run. The
    // session it was introduced in delivered ZERO messages where the prior one
    // delivered twelve.
    const live = liveConsequences( restored( { tick: 596, expiresAt: 626 } ) as never, 1 as Tick )
    expect( enactionFootprint( live, 'reach-out', FABRICE, 1 ) ).toBe( 0 )
  } )

  it('still honours a descriptor written earlier in THIS session', () => {
    const live = liveConsequences( restored( { tick: 100, expiresAt: 130 } ) as never, 110 as Tick )
    expect( live ).toHaveLength( 1 )
    expect( enactionFootprint( live, 'reach-out', FABRICE, 110 ) ).toBeCloseTo( 0.666, 2 )
  } )

  it('and one written on this very tick', () => {
    const live = liveConsequences( restored( { tick: 100, expiresAt: 130 } ) as never, 100 as Tick )
    expect( live ).toHaveLength( 1 )
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

// ── the durable per-(schema, target) enaction record ──────────
/**
 * The gap the two earlier fixes left behind.
 *
 * Satiation had three carriers and only two of them were durable: speech got
 * `conversation.sent` and objectless acts got `LearnedSkill.lastEnactedTick`,
 * while an act WITH an object that is NOT speech — `inspect`, and every
 * entity-bound host effector — had nothing but the consequence descriptor. That
 * is swept at the ECHO window (30) while satiation runs on `repeatWindowTicks`
 * (60), so the back half of the window damped nothing at all.
 *
 * Measured on a live COO: entity-bound acts carried satiation in 40–46% of
 * competitions against 100% for objectless ones, and she re-enacted
 * `discord_lookup_member` toward the same person 33 times in seven minutes.
 */
describe('enactedAt — satiation for an act with an object that is not speech', () => {
  const LOOKUP = 'discord_lookup_member'
  const WINDOW = 60

  it('damps past the echo window, where the descriptor alone went silent', () => {
    // 45 ticks on: the descriptor is long swept (TTL 30) and there is no
    // `spokenAt` because looking someone up is not speaking to them.
    const enactedAt = enactedAtBySchemaTarget( new Map( [ [
      enactedId( LOOKUP, FABRICE ),
      { type: ENACTED_TYPE, metadata: { schema: LOOKUP, targetEntityId: FABRICE, tick: 100 } },
    ] ] ) )

    const withRecord = enactionFootprint( [], LOOKUP, FABRICE, 145, WINDOW, undefined, undefined, undefined, enactedAt )
    const without    = enactionFootprint( [], LOOKUP, FABRICE, 145, WINDOW )

    expect( without ).toBe( 0 )              // the bug
    expect( withRecord ).toBeCloseTo( 0.25 ) // (60 − 45) / 60
  } )

  it('is keyed by PAIR — damping one person leaves the same act toward another untouched', () => {
    const enactedAt = enactedAtBySchemaTarget( new Map( [ [
      enactedId( LOOKUP, FABRICE ),
      { type: ENACTED_TYPE, metadata: { schema: LOOKUP, targetEntityId: FABRICE, tick: 100 } },
    ] ] ) )

    expect( enactionFootprint( [], LOOKUP, FABRICE, 101, WINDOW, undefined, undefined, undefined, enactedAt ) ).toBeGreaterThan( 0.9 )
    // This is why `lastEnactedTick` (per-schema) cannot serve the entity-bound
    // branch: it would damp looking up someone the mind has never looked up.
    expect( enactionFootprint( [], LOOKUP, FKEM, 101, WINDOW, undefined, undefined, undefined, enactedAt ) ).toBe( 0 )
  } )

  it('decays to nothing, so a genuinely repeatable act comes back on its own', () => {
    const enactedAt = enactedAtBySchemaTarget( new Map( [ [
      enactedId( LOOKUP, FABRICE ),
      { type: ENACTED_TYPE, metadata: { schema: LOOKUP, targetEntityId: FABRICE, tick: 100 } },
    ] ] ) )
    expect( enactionFootprint( [], LOOKUP, FABRICE, 160, WINDOW, undefined, undefined, undefined, enactedAt ) ).toBe( 0 )
  } )

  /**
   * THE INVARIANT THAT MATTERS: this is a refractory period, not a lock.
   *
   * Satiation is one weighted term (`repeat`, 0.30) in a competition, so an act
   * the mind genuinely needs to repeat still wins — it just has to actually be
   * pressing rather than merely available. A mind may always repeat itself; it
   * should not do so because nothing in it could represent having just acted.
   */
  it('never blocks a repeat — a pressing act out-competes maximum damping', () => {
    const idle    = { ...reachOut( FABRICE, 1 ) }                       // damped, nothing pressing
    const pressing = { ...reachOut( FABRICE, 1 ), expectedReward: 1, willBias: 1 } as Affordance

    const urgent: BiasContext = { ...bias(), goalTargets: new Set( [ FABRICE ] ), maxGoalPriority: 1 } as BiasContext

    const idleScore    = scoreAffordance( idle as Affordance, bias(),  DEFAULT_WEIGHTS )
    const pressingScore = scoreAffordance( pressing,          urgent,  DEFAULT_WEIGHTS )

    // Same maximum damping applied to both; the pressing one still comes out on top.
    expect( pressingScore ).toBeGreaterThan( idleScore )
    expect( pressingScore ).toBeGreaterThan( 0 )
  } )
} )

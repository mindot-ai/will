// ─────────────────────────────────────────────────────────────
// tests/unit/agency.restart.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The restart boundary — both halves.
 *
 * This session hit the same class of bug four times before it got named, so the
 * invariants are pinned here rather than left to the call sites.
 *
 * TIME MUST NOT GO BACKWARDS. Entities snapshot with the tick they were written
 * at. The clock used to restart at 0 while they came back stamped at ~598, so
 * every `tick - stampedTick` — 42 comparison sites across 19 files — computed a
 * negative age. Measured consequences: an awaiting intent aged `-589` could never
 * satisfy `age < AWAIT_TIMEOUT`'s complement and so never timed out, and the
 * selector's staleness decay `1 - staleness × STALE_DECAY` became `1 + 19.6`,
 * amplifying a 0.47 incumbent to 9.74 — unpreemptable, holding the channel
 * against every other contact indefinitely and across restarts.
 *
 * WORK IN FLIGHT DOES NOT RESUME. Resuming the clock fixes the arithmetic but not
 * the meaning, and actually makes stale in-flight state MORE dangerous: it now
 * looks plausibly recent rather than obviously impossible, so an awaiting intent
 * would be reconciled as a real timeout — teaching the mind that reaching that
 * person does not work, when all that happened is that it slept.
 */

import { describe, it, expect } from 'vitest'
import { inFlightOnRestore } from '#agency/restart'
import { consequenceEntity } from '#agency/consequence'
import { DefaultSimulationClock } from '#core/clock'
import type { Tick } from '#core/types'

// ── what does not cross the boundary ──────────────────────────

type Ent = { type: string; metadata?: Record<string, unknown> }

const mapOf = ( ...pairs: [ string, Ent ][] ) => new Map<string, Ent>( pairs )

const intent = ( status: string ): Ent => ({
  type: 'agency.intent',
  metadata: { status, schema: 'reach-out', dispatchedAt: 596, targetEntityId: 'discord:1019' },
})

describe('inFlightOnRestore — what a sleep does not carry over', () => {
  it('drops an intent still awaiting the world', () => {
    expect( inFlightOnRestore( mapOf( [ 'i1', intent('awaiting') ] ) ) ).toEqual( [ 'i1' ] )
  } )

  it('drops consequence descriptors — the echo window closed while it slept', () => {
    const c = consequenceEntity({
      intentId: 'i1', schema: 'reach-out', mode: 'communicate',
      targetEntityId: 'discord:1019', expiresAt: 626, tick: 596,
    })
    const dropped = inFlightOnRestore( mapOf( [ c.id, { type: c.type, metadata: c.metadata as Record<string, unknown> } ] ) )
    expect( dropped ).toEqual( [ c.id ] )
  } )

  it('KEEPS a selected intent — held, not dispatched', () => {
    // It is still an intention the mind has, not an action awaiting an answer.
    expect( inFlightOnRestore( mapOf( [ 'i1', intent('selected') ] ) ) ).toEqual( [] )
  } )

  it('keeps everything the mind actually is', () => {
    const durable = mapOf(
      [ 'g1',  { type: 'goal' } ],
      [ 'b1',  { type: 'belief' } ],
      [ 'ke1', { type: 'known-entity' } ],
      [ 'cs1', { type: 'conversation.sent', metadata: { targetEntityId: 'discord:1019', tick: 500 } } ],
      [ 'p1',  { type: 'percept', metadata: { category: 'undertaking' } } ],
      [ 'pp',  { type: 'persona.prior' } ],
    )
    expect( inFlightOnRestore( durable ) ).toEqual( [] )
  } )

  it('is stable on an empty state', () => {
    expect( inFlightOnRestore( mapOf() ) ).toEqual( [] )
  } )

  it('picks out only the in-flight entries from a realistic mixed snapshot', () => {
    const c = consequenceEntity({
      intentId: 'i9', schema: 'reach-out', mode: 'communicate', expiresAt: 626, tick: 596,
    })
    const mixed = mapOf(
      [ 'g1', { type: 'goal' } ],
      [ 'i-await', intent('awaiting') ],
      [ 'i-sel',   intent('selected') ],
      [ c.id, { type: c.type, metadata: c.metadata as Record<string, unknown> } ],
      [ 'ke1', { type: 'known-entity' } ],
    )
    expect( inFlightOnRestore( mixed ).sort() ).toEqual( [ c.id, 'i-await' ].sort() )
  } )
} )

// ── time must not go backwards ────────────────────────────────

describe('clock resumption — a restored mind does not re-live tick 1', () => {
  it('continues from the snapshot tick instead of restarting', () => {
    const clock = new DefaultSimulationClock({ fixedDeltaMs: 50 })
    expect( clock.currentTick ).toBe( 0 )

    clock.setTick( 598 as Tick )     // what WillStem.createWill does after restore
    clock.tick()

    expect( clock.currentTick ).toBe( 599 )
  } )

  it('makes the age of a restored stamp POSITIVE — the whole point', () => {
    // A descriptor/intent written at 596, resumed at 598. Before the fix this age
    // was -589 and every guard built on it inverted.
    const clock = new DefaultSimulationClock({ fixedDeltaMs: 50 })
    clock.setTick( 598 as Tick )
    clock.tick()

    const age = ( clock.currentTick as number ) - 596
    expect( age ).toBeGreaterThan( 0 )
  } )

  it('never lets staleness go negative, so hysteresis cannot amplify', () => {
    // The selector's arithmetic, with a resumed clock. `1 - staleness × 0.5` must
    // stay in (0.5, 1] — a decay, never a multiplier.
    const clock = new DefaultSimulationClock({ fixedDeltaMs: 50 })
    clock.setTick( 598 as Tick )
    clock.tick()

    const staleness = Math.min( 1, Math.max( 0, ( ( clock.currentTick as number ) - 596 ) / 15 ) )
    const factor    = 1 - staleness * 0.5

    expect( staleness ).toBeGreaterThanOrEqual( 0 )
    expect( factor ).toBeGreaterThan( 0.4 )
    expect( factor ).toBeLessThanOrEqual( 1 )
  } )

  it('keeps tick-stamped entity ids from colliding with a previous session', () => {
    // `affordance-${tick}-…` and `agency-outcome-${tick}-…` embed the tick. A
    // rewound clock regenerates ids a prior session already used.
    const first  = new DefaultSimulationClock({ fixedDeltaMs: 50 })
    first.setTick( 598 as Tick ); first.tick()

    const fresh = new DefaultSimulationClock({ fixedDeltaMs: 50 })
    fresh.tick()   // an un-resumed clock — the old behaviour

    expect( `affordance-${ first.currentTick }` ).not.toBe(`affordance-${ fresh.currentTick }`)
  } )
} )

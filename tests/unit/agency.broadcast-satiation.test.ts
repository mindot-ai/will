// ─────────────────────────────────────────────────────────────
// tests/unit/agency.broadcast-satiation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Having just spoken satiates — even to someone else.
 *
 * Satiation was keyed entirely by LISTENER: `spokenAt` damps speaking to a
 * person you have just spoken to, and says nothing once the listener changes.
 * Live, a COO drafted one scoping outline and put substantially the same thing
 * into three destinations inside three minutes — the general channel, a DM, and
 * a second channel — with nothing opposing it, because each destination was a
 * different key.
 *
 * It was not a missing representation. `## What I've Said Lately` listed her own
 * turns ACROSS targets, with previews, and the prompt thirty ticks after the
 * first post showed it back to her flagged "no answer yet". She read it and
 * posted again thirty-one seconds later. The record was there; the pull simply
 * had no opposing force in the competition.
 *
 * So the fix is a second arm, not a rule: an act's footprint now includes
 * "I have just spoken at all", over the SHORTER echo window. Telling a second
 * person something stays cheap; a third destination in ninety seconds does not.
 * Nothing is forbidden — a decaying damp is still out-competed by a real need.
 *
 * Replies are structurally unaffected: an answer to an inbound message is
 * delivered by the audition facet through the outbox and never enters this
 * competition. This damps self-initiated outreach only, which is what
 * broadcasting is.
 */

import { describe, it, expect } from 'vitest'
import { enactionFootprint, CONSEQUENCE_TTL_TICKS } from '#agency/consequence'

const NONE: never[] = []
const WINDOW = 60          // repeatWindowTicks, the per-person window

describe('having just spoken satiates — even to someone else', () => {
  it('damps reaching a NEW person right after speaking to another', () => {
    // Spoke to Ada at tick 100. At 105, reaching FKEM — a different key, so the
    // per-person arm is silent and only the new arm can speak.
    const f = enactionFootprint(
      NONE, 'reach-out', 'fkem', 105, WINDOW,
      new Map([ [ 'ada', 100 ] ]), undefined, 100 )
    expect( f ).toBeGreaterThan( 0 )
  })

  it('but less than repeating to the SAME person, because telling someone new is legitimate', () => {
    const toSomeoneNew  = enactionFootprint(
      NONE, 'reach-out', 'fkem', 105, WINDOW,
      new Map([ [ 'ada', 100 ] ]), undefined, 100 )
    const toSamePerson = enactionFootprint(
      NONE, 'reach-out', 'ada', 105, WINDOW,
      new Map([ [ 'ada', 100 ] ]), undefined, 100 )

    expect( toSamePerson ).toBeGreaterThan( toSomeoneNew )
  })

  it('decays to nothing over the echo window — a refractory period, not a gag', () => {
    const at = ( tick: number ) => enactionFootprint(
      NONE, 'reach-out', 'fkem', tick, WINDOW,
      new Map([ [ 'ada', 100 ] ]), undefined, 100 )

    expect( at( 101 ) ).toBeGreaterThan( at( 115 ) )
    expect( at( 115 ) ).toBeGreaterThan( 0 )
    expect( at( 100 + CONSEQUENCE_TTL_TICKS ) ).toBe( 0 )
  })

  it('the per-person arm still wins when both apply — the stronger claim governs', () => {
    // Spoke to Ada 5 ticks ago; reaching Ada again. Per-person over the 60-tick
    // window is 55/60; the anywhere-arm over 30 is 25/30. The larger stands.
    const f = enactionFootprint(
      NONE, 'reach-out', 'ada', 105, WINDOW,
      new Map([ [ 'ada', 100 ] ]), undefined, 100 )
    expect( f ).toBeCloseTo( 55 / 60, 5 )
  })

  it('is silent for an act that does not speak — the caller withholds it', () => {
    // The synthesizer passes both speaking arms only when the schema is tagged
    // `communication`. Looking something up is not talking.
    const f = enactionFootprint( NONE, 'inspect', 'ke:room', 105, WINDOW,
      undefined, undefined, undefined )
    expect( f ).toBe( 0 )
  })

  it('a mind that has never spoken is undamped', () => {
    const f = enactionFootprint( NONE, 'reach-out', 'ada', 105, WINDOW,
      new Map(), undefined, undefined )
    expect( f ).toBe( 0 )
  })
})

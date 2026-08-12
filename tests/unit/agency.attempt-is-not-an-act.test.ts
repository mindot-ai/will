// ─────────────────────────────────────────────────────────────
// tests/unit/agency.attempt-is-not-an-act.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Attempting to speak is not speaking.
 *
 * A consequence descriptor is written when an intent goes to the async hold. For
 * an EXTERNAL effector that is the act itself — the host is doing it now, and not
 * asking twice while waiting is exactly what satiation is for. For a COMMUNICATE
 * it is not: the facet has not authored anything and the mind has said nothing.
 *
 * Both wrote an identical footprint, so a queued outreach damped the next one as
 * hard as a delivered one would. Dormant while `justEnacted` never reached the
 * competition; live the moment it did. Measured on a booted COO: `reach-out`
 * willed 63 times in four minutes, NOTHING delivered, and 18 of those lost to
 * `justEnacted` readings of 0.93–0.98 — against a mind that had not spoken once
 * that run. Every attempt wrote a fresh footprint, so the damping never decayed
 * and she talked herself into permanent silence.
 *
 * The words landing is what makes it an act. Until then the descriptor is
 * `pending`: still written (P1/P2 want it the moment words exist), never counted
 * as something done.
 */

import { describe, it, expect } from 'vitest'
import {
  enactionFootprint, readConsequence, consequenceEntity,
  CONSEQUENCE_TTL_TICKS, type ConsequenceDescriptor,
} from '#agency/consequence'

const descriptor = ( over: Partial<ConsequenceDescriptor> = {} ): ConsequenceDescriptor => ({
  intentId: 'i-1', schema: 'reach-out', mode: 'communicate',
  targetEntityId: 'ke:ada', tick: 100, expiresAt: 100 + CONSEQUENCE_TTL_TICKS,
  ...over,
})

describe('a queued outreach', () => {
  it('does not satiate — nothing was said', () => {
    const f = enactionFootprint(
      [ descriptor({ pending: true }) ], 'reach-out', 'ke:ada', 101, 60 )
    expect( f, 'attempting to speak silenced the mind as hard as speaking').toBe( 0 )
  })

  it('while a DELIVERED one does — those words are out in the world', () => {
    const f = enactionFootprint(
      [ descriptor({ text: 'Ada — any movement on the RFC?' }) ], 'reach-out', 'ke:ada', 101, 60 )
    expect( f ).toBeGreaterThan( 0 )
  })

  it('and an external dispatch does — the host is acting on it right now', () => {
    // `inspect` held awaiting a host ack IS in flight. Asking again while the
    // answer is coming is the repetition satiation exists to prevent.
    const f = enactionFootprint(
      [ descriptor({ schema: 'inspect', mode: 'external', targetEntityId: 'ke:room' }) ],
      'inspect', 'ke:room', 101, 60 )
    expect( f ).toBeGreaterThan( 0 )
  })

  it('survives the entity round-trip — written AND read back', () => {
    // The failure mode this codebase keeps hitting: a field one side knows about.
    const entity = consequenceEntity( descriptor({ pending: true }) )
    expect( entity.metadata?.['pending'] ).toBe( true )
    expect( readConsequence( entity.metadata )?.pending ).toBe( true )
  })

  it('an ordinary descriptor stays unflagged, so nothing else changes', () => {
    const entity = consequenceEntity( descriptor({ text: 'hello' }) )
    expect( readConsequence( entity.metadata )?.pending ).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/precision.perception.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Precision → perception (Phase 1d audit, made into a regression test).
 *
 * Top-down attention works like this: when the executive predicts a domain
 * matters it raises that engine's GenerativeModel precision; the engine's
 * published cognitive events then carry a higher salience; the executive's
 * Global-Workspace gate buffers any event with `salience >= WORKSPACE_THRESHOLD`
 * and wakes early when the buffer's total salience charges up. So precision is a
 * live lever on what enters the workspace — provided the boosted stream is the
 * one the engine actually publishes on (the per-engine wiring bug class fixed in
 * 1a/1d).
 *
 * These tests pin the lever itself (precision is a clean salience multiplier) and
 * its relationship to the consumed WORKSPACE_THRESHOLD constant.
 */

import { describe, it, expect } from 'vitest'
import { GenerativeModel } from '#cognition/generative.model'
import { WORKSPACE_THRESHOLD } from '#faculties/executive.engine/config'

/** Two identically-primed computers — deterministic, so their base salience matches. */
function prime(): GenerativeModel {
  const s = new GenerativeModel()
  for( let i = 0; i < 30; i++ ) s.observe( 'sig', 100 + ( i % 2 === 0 ? 1 : -1 ) )
  return s
}

describe( 'precision → perception (the workspace-entry lever)', () => {
  it( 'precision scales an event\'s salience by exactly the precision factor (pre-saturation)', () => {
    const plain = prime()
    const amp   = prime(); amp.setPrecision( 'sig', 3.0 )

    const plainSal = plain.observe( 'sig', 100.3 ).salience
    const ampSal   = amp.observe( 'sig', 100.3 ).salience

    expect( plainSal ).toBeGreaterThan( 0 )
    expect( ampSal ).toBeGreaterThan( plainSal )
    // observe() returns min(1, baseSalience × precision); identical priming ⇒ same base.
    expect( ampSal ).toBeCloseTo( Math.min( 1, plainSal * 3.0 ), 6 )
  })

  it( 'a raised precision can lift a sub-threshold event into the executive workspace', () => {
    const plain = prime()
    const amp   = prime(); amp.setPrecision( 'sig', 3.0 )

    const plainSal = plain.observe( 'sig', 100.3 ).salience
    const ampSal   = amp.observe( 'sig', 100.3 ).salience

    // Un-boosted it would NOT enter the Global Workspace …
    expect( plainSal ).toBeLessThan( WORKSPACE_THRESHOLD )
    // … but with the executive's precision it crosses the gate.
    expect( ampSal ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )
  })

  it( 'precision defaults to 1.0 — no boost, no effect on the gate', () => {
    const a = prime(); const b = prime()
    expect( b.observe( 'sig', 100.3 ).salience ).toBeCloseTo( a.observe( 'sig', 100.3 ).salience, 6 )
  })
})

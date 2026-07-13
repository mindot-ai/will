// ─────────────────────────────────────────────────────────────
// tests/unit/config.resolution.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Budgets, not tiers: the engine takes host-supplied parameters — a concrete
 * model id and an executive cadence — and resolves them with two invariants:
 *   - cadence defaults to balanced (60) and is floored by minExecutiveInterval
 *   - WILL_LLM_MODEL env pins the model over config (operator / self-hosting)
 * (Model threading through assembly is covered in assembly.order.test.ts.)
 */

import { describe, it, expect } from 'vitest'
import { resolveExecutiveInterval, EXECUTIVE_CADENCE } from '#stem/mind'
import type { WillConfig } from '#stem/mind'

const cfg = ( over: Partial<WillConfig> = {} ): WillConfig => ( {
  id: 'w', name: 'w', profile: null,
  identity: { prompt: '', values: [], traits: {}, style: '' },
  persistentMemory: false, snapshotInterval: 999, randomSeed: 1,
  ...over,
} as WillConfig )

describe( 'resolveExecutiveInterval — the cadence budget', () => {
  it( 'defaults to balanced (60); the named cadences stay pinned', () => {
    expect( resolveExecutiveInterval( cfg() ) ).toBe( EXECUTIVE_CADENCE.balanced )
    expect( EXECUTIVE_CADENCE ).toMatchObject({ responsive: 30, balanced: 60, economy: 90 })
  } )

  it( 'honours an explicit executiveInterval (host budget knob)', () => {
    expect( resolveExecutiveInterval( cfg({ executiveInterval: 30 }) ) ).toBe( 30 )
    expect( resolveExecutiveInterval( cfg({ executiveInterval: 90 }) ) ).toBe( 90 )
  } )

  it( 'clamps up to minExecutiveInterval (plan floor — cannot go faster)', () => {
    expect( resolveExecutiveInterval( cfg({ executiveInterval: 20, minExecutiveInterval: 60 }) ) ).toBe( 60 )
  } )
} )

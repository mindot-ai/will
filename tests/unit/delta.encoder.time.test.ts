// ─────────────────────────────────────────────────────────────
// tests/unit/delta.encoder.time.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for DeltaEncoder timestamp fidelity (FN14).
 *
 * Regression target: decode() reconstructed `time` as
 * `base.time + (currentTick - baseTick) * 16`, hardcoding 16 ms/tick. The
 * clock's per-tick duration is configurable (`fixedDeltaMs`) and scaled
 * (`timeScale`), so a fixed 16 ms invents a timestamp that need not match the
 * one actually recorded. The fix captures `current.time` at encode time and
 * replays it verbatim on decode.
 */

import { describe, it, expect } from 'vitest'
import { DeltaEncoder, type DeltaSnapshot } from '#core/serialization'
import type { SimulationState } from '#core/types'

function state( tick: number, time: number, entities: SimulationState['entities'] = new Map(), metrics = new Map<string, number>() ): SimulationState {
  return { tick, time, entities, metrics } as unknown as SimulationState
}

describe( 'DeltaEncoder — records real time instead of fabricating it (FN14)', () => {
  const enc = new DeltaEncoder()

  it( 'decode reproduces the exact recorded time, not base + Δtick*16', () => {
    // 10 ticks apart, but only 50 ms of (scaled) sim time elapsed — far from
    // the 160 ms the old `* 16` formula would have invented.
    const prev = state( 100, 1_000 )
    const curr = state( 110, 1_050 )

    const delta = enc.encode( prev, curr )
    expect( delta.time ).toBe( 1_050 )

    const decoded = enc.decode( prev, delta )
    expect( decoded.tick ).toBe( 110 )
    expect( decoded.time ).toBe( 1_050 )
    // Guard against the old fabricated value sneaking back in.
    expect( decoded.time ).not.toBe( prev.time + ( 110 - 100 ) * 16 )
  })

  it( 'preserves a sub-tick / fractional timestamp untouched', () => {
    const prev = state( 0, 0 )
    const curr = state( 1, 7.5 )  // not a multiple of 16

    const decoded = enc.decode( prev, enc.encode( prev, curr ) )
    expect( decoded.time ).toBe( 7.5 )
  })

  it( 'round-trips entity/metric changes alongside the recorded time', () => {
    const prev = state( 5, 500, new Map( [ [ 'a', { id: 'a', type: 't', createdAt: 0, updatedAt: 5 } ] ] as any ), new Map( [ [ 'm', 1 ] ] ) )
    const curr = state( 6, 512, new Map( [ [ 'b', { id: 'b', type: 't', createdAt: 6, updatedAt: 6 } ] ] as any ), new Map( [ [ 'm', 4 ] ] ) )

    const decoded = enc.decode( prev, enc.encode( prev, curr ) )
    expect( decoded.time ).toBe( 512 )
    expect( decoded.entities.has( 'a' ) ).toBe( false )   // removed
    expect( decoded.entities.has( 'b' ) ).toBe( true )    // added
    expect( decoded.metrics.get( 'm' ) ).toBe( 4 )        // updated
  })

  it( 'legacy deltas without a `time` field fall back to base.time, never the fabricated value', () => {
    const base = state( 100, 1_000 )
    // A delta produced before the `time` field existed.
    const legacy = {
      baseTick: 100, currentTick: 110,
      addedEntities: [], removedEntityIds: [], updatedEntities: [], metricsDelta: [],
    } as unknown as DeltaSnapshot

    const decoded = enc.decode( base, legacy )
    expect( decoded.time ).toBe( 1_000 )                              // base.time fallback
    expect( decoded.time ).not.toBe( base.time + ( 110 - 100 ) * 16 ) // not fabricated
  })
})

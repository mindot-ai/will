// ─────────────────────────────────────────────────────────────
// tests/unit/attention.arousal.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Arousal-raised ceiling (Option A — involuntary upward lever).
 *
 * Threat/reward arousal (`affect.arousal`) mobilizes the attention ceiling above
 * baseline (fight-or-flight), following a Yerkes–Dodson inverted-U:
 *   - calm (≤ 0.3)        → factor 1.0 (no boost)
 *   - optimal (~0.65)     → factor 1.3 (maximum mobilization → larger budget)
 *   - extreme (→ 1.0)     → factor < 1.0 (fragmentation → smaller budget)
 *
 * This is the involuntary counterpart to voluntary focus: it raises the ceiling
 * that effort utilizes.
 */

import { describe, it, expect } from 'vitest'
import { AttentionAllocator } from '#faculties/attention.allocator'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

const CTX = {} as SimulationContext

const stateArousal = ( a?: number ): ReadonlySimulationState =>
  ( {
    tick: 1, time: 1000, entities: new Map(),
    metrics: new Map<string, number>( a === undefined ? [] : [ [ 'affect.arousal', a ] ] ),
  } as unknown as ReadonlySimulationState )

const mv = ( r: any, k: string ): number =>
  ( r.commands?.metrics ?? [] ).find( ( e: [string, number] ) => e[0] === k )?.[1]

async function sample( arousal?: number ){
  const a = new AttentionAllocator()
  const r = await a.react( 50, 1 as any, stateArousal( arousal ), CTX )
  return { factor: mv( r, 'attention.arousal_factor' ), capacity: mv( r, 'attention.capacity' ), free: mv( r, 'attention.free_fraction' ) }
}

describe( 'AttentionAllocator — arousal-raised ceiling (Option A)', () => {
  it( 'calm arousal applies no boost (factor 1.0)', async () => {
    expect( ( await sample( 0.2 ) ).factor ).toBeCloseTo( 1.0, 5 )
  } )

  it( 'a missing arousal metric defaults to calm (factor 1.0)', async () => {
    expect( ( await sample( undefined ) ).factor ).toBeCloseTo( 1.0, 5 )
  } )

  it( 'optimal arousal mobilizes the ceiling above baseline (factor 1.3)', async () => {
    expect( ( await sample( 0.65 ) ).factor ).toBeCloseTo( 1.3, 5 )
  } )

  it( 'extreme arousal collapses the ceiling — fragmentation (factor < 1.0)', async () => {
    const f = ( await sample( 1.0 ) ).factor
    expect( f ).toBeLessThan( 1.0 )
    expect( f ).toBeCloseTo( 0.6, 5 )
  } )

  it( 'follows the inverted-U: optimal > calm > panic (capacity)', async () => {
    const calm    = await sample( 0.2 )
    const optimal = await sample( 0.65 )
    const panic   = await sample( 1.0 )
    expect( optimal.capacity ).toBeGreaterThan( calm.capacity )
    expect( calm.capacity ).toBeGreaterThan( panic.capacity )
  } )

  it( 'mobilization widens the facet budget; fragmentation narrows it (free fraction)', async () => {
    const calm    = await sample( 0.2 )
    const optimal = await sample( 0.65 )
    const panic   = await sample( 1.0 )
    // free fraction drives FacetSupervisor.maxFacets = floor(free / 0.3):
    //   calm ~0.70 → 2, optimal ~0.91 → 3, panic ~0.42 → 1
    expect( Math.floor( optimal.free / 0.3 ) ).toBeGreaterThan( Math.floor( calm.free / 0.3 ) )
    expect( Math.floor( calm.free / 0.3 ) ).toBeGreaterThan( Math.floor( panic.free / 0.3 ) )
  } )
} )

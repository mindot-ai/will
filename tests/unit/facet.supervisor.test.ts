// ─────────────────────────────────────────────────────────────
// tests/unit/facet.supervisor.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * FacetSupervisor — idle reaper + LRU eviction (Senses hardening §1).
 *
 * Facets used to be reclaimed ONLY on explicit destroy() (endSession). A quiet
 * conversation leaked its facet forever, eventually exhausting the attention
 * budget and silently dropping new conversations. The reaper reclaims idle
 * facets (by sim tick), LRU eviction preempts a stale facet under budget
 * pressure, and `onReaped` notifies the owner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FacetSupervisor } from '#faculties/executive.engine/facet.supervisor'
import { createTestBus } from '#cognition/bus'
import type { ReadonlySimulationState } from '#core/types'

vi.spyOn( console, 'info' ).mockImplementation( () => {} )

const stateAt = ( tick: number ) => ({ tick } as unknown as ReadonlySimulationState )

function spawnDeps( tick: number ){
  return {
    bus:         createTestBus(),
    llmDirector: {} as any,         // never invoked — no report() in these tests
    stateRef:    stateAt( tick ),
    contextDeps: {} as any,
    promptDeps:  {} as any,
    willId:      'w',
  }
}

describe( 'FacetSupervisor — idle reaper', () => {
  let sup: FacetSupervisor
  beforeEach( () => { sup = new FacetSupervisor({ idleTtlTicks: 50 }) } )

  it( 'reaps a facet idle past the TTL', () => {
    sup.spawn( spawnDeps( 0 ) )         // lastActive = 0
    expect( sup.size ).toBe( 1 )

    sup.broadcastStateRef( stateAt( 40 ) )   // 40 - 0 = 40 ≤ 50 — kept
    expect( sup.size ).toBe( 1 )

    sup.broadcastStateRef( stateAt( 60 ) )   // 60 - 0 = 60 > 50 — reaped
    expect( sup.size ).toBe( 0 )
  } )

  it( 'keeps a more-recently-active facet while reaping an older one in the same sweep', () => {
    sup.spawn( spawnDeps( 0 ) )         // A: lastActive 0
    sup.spawn( spawnDeps( 40 ) )        // B: lastActive 40
    expect( sup.size ).toBe( 2 )

    sup.broadcastStateRef( stateAt( 60 ) )   // A: 60 > 50 reaped; B: 20 ≤ 50 kept
    expect( sup.size ).toBe( 1 )
  } )

  it( 'fires onReaped for the owner when reaped (not for the survivor)', () => {
    const reapedA = vi.fn()
    const reapedB = vi.fn()
    sup.spawn( spawnDeps( 0 ) ).handle!.onReaped( reapedA )
    sup.spawn( spawnDeps( 40 ) ).handle!.onReaped( reapedB )

    sup.broadcastStateRef( stateAt( 60 ) )

    expect( reapedA ).toHaveBeenCalledTimes( 1 )
    expect( reapedB ).not.toHaveBeenCalled()
  } )

  it( 'does NOT fire onReaped on an explicit destroy()', () => {
    const reaped = vi.fn()
    const res = sup.spawn( spawnDeps( 0 ) )
    res.handle!.onReaped( reaped )

    res.handle!.destroy()
    expect( sup.size ).toBe( 0 )
    expect( reaped ).not.toHaveBeenCalled()   // explicit close — owner already knows
  } )
} )

describe( 'FacetSupervisor — LRU eviction under budget pressure', () => {
  it( 'evicts the least-recently-active facet to admit a new one (no silent drop)', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000, evictLruOnPressure: true })
    sup.setAttentionState( 0.3 )        // free fraction 0.3 → maxFacets = 1

    const reapedA = vi.fn()
    const a = sup.spawn( spawnDeps( 0 ) )
    a.handle!.onReaped( reapedA )
    expect( a.attention ).toBe( 'available' )
    expect( sup.size ).toBe( 1 )

    const b = sup.spawn( spawnDeps( 5 ) )   // budget full → evict LRU (A) → admit B
    expect( b.attention ).toBe( 'available' )
    expect( b.handle ).toBeDefined()
    expect( sup.size ).toBe( 1 )
    expect( reapedA ).toHaveBeenCalledTimes( 1 )   // A was evicted
  } )

  it( 'refuses the spawn (attention: full) when LRU eviction is disabled', () => {
    const sup = new FacetSupervisor({ evictLruOnPressure: false })
    sup.setAttentionState( 0.3 )        // free fraction 0.3 → maxFacets = 1

    expect( sup.spawn( spawnDeps( 0 ) ).attention ).toBe( 'available' )
    const b = sup.spawn( spawnDeps( 5 ) )
    expect( b.attention ).toBe( 'full' )
    expect( b.handle ).toBeUndefined()
    expect( sup.size ).toBe( 1 )
  } )
} )

describe( 'FacetSupervisor — attention budget calibration (normalized 0–1, §ATTN fix #2)', () => {
  const deps = ( t: number ) => spawnDeps( t )

  it( 'admits floor(freeFraction / 0.3) facets and then binds (no ~100× inflation)', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000, evictLruOnPressure: false })
    sup.setAttentionState( 1 )                       // floor(1 / 0.3) = 3

    expect( sup.spawn( deps( 0 ) ).attention ).toBe( 'available' )   // 1
    expect( sup.spawn( deps( 1 ) ).attention ).toBe( 'available' )   // 2
    expect( sup.spawn( deps( 2 ) ).attention ).toBe( 'available' )   // 3
    expect( sup.spawn( deps( 3 ) ).attention ).toBe( 'full' )        // 4th refused — budget BINDS
    expect( sup.size ).toBe( 3 )
  } )

  it( 'a low free fraction collapses the budget to a single facet', () => {
    const sup = new FacetSupervisor({ evictLruOnPressure: false })
    sup.setAttentionState( 0.25 )                    // floor(0.25 / 0.3) = 0 → max(1, …) = 1

    expect( sup.spawn( deps( 0 ) ).attention ).toBe( 'available' )
    expect( sup.spawn( deps( 1 ) ).attention ).toBe( 'full' )
    expect( sup.size ).toBe( 1 )
  } )
} )

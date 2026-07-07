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
 *
 * Busy guard: a facet with queued reports or an in-flight _reason() is never
 * idle-reaped, and pressure eviction prefers a quiet victim. A real LLM call
 * spans many ticks (10–30s); reaping mid-flight cleared the listeners the
 * pending decision lands on, silently dropping conversation replies (the
 * with-anthropic no-reply bug).
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

describe( 'FacetSupervisor — busy guard (in-flight work is never reaped)', () => {
  // An inbox stub flips the facet into tick-discipline mode: report() queues
  // (→ busy) and reasoning launches from pump(), like production.
  const busyDeps = ( tick: number ) => ({ ...spawnDeps( tick ), inbox: { enqueue: vi.fn() } as any })

  it( 'does NOT idle-reap a facet with queued reports, even far past the TTL', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 50 })
    const reaped = vi.fn()
    const res = sup.spawn( busyDeps( 0 ) )
    res.handle!.onReaped( reaped )

    await res.handle!.report( { type: 'language_percept' } as any )   // queued → busy

    sup.broadcastStateRef( stateAt( 100 ) )    // 100 - 0 = 100 > 50, but busy — kept
    expect( sup.size ).toBe( 1 )
    expect( reaped ).not.toHaveBeenCalled()
  } )

  it( 'resumes reaping once the queued work drains (no permanent-busy leak)', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 50 })
    const reaped = vi.fn()
    const res = sup.spawn( busyDeps( 0 ) )
    res.handle!.onReaped( reaped )
    await res.handle!.report( { type: 'language_percept' } as any )

    // pump() launches _reason(), which rejects here (no focus set) — the
    // in-flight guard must still decrement on the error path.
    sup.pump( stateAt( 101 ) )
    expect( sup.size ).toBe( 1 )               // in-flight during the same sweep — kept

    await new Promise( r => setTimeout( r, 0 ) )   // let the rejection settle

    sup.broadcastStateRef( stateAt( 200 ) )    // 200 - 101 = 99 > 50, quiet again — reaped
    expect( sup.size ).toBe( 0 )
    expect( reaped ).toHaveBeenCalledTimes( 1 )
  } )

  it( 'LRU eviction under pressure prefers a quiet victim over a busy one', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000, evictLruOnPressure: true })
    sup.setAttentionState( 0.6 )               // floor(0.6 / 0.3) = 2 facets max

    const reapedBusy  = vi.fn()
    const reapedQuiet = vi.fn()

    const busy = sup.spawn( busyDeps( 0 ) )    // absolute LRU, but busy
    busy.handle!.onReaped( reapedBusy )
    await busy.handle!.report( { type: 'language_percept' } as any )

    const quiet = sup.spawn( spawnDeps( 5 ) )  // more recent, but quiet
    quiet.handle!.onReaped( reapedQuiet )

    const third = sup.spawn( spawnDeps( 10 ) ) // budget full → evict the QUIET one
    expect( third.attention ).toBe( 'available' )
    expect( reapedQuiet ).toHaveBeenCalledTimes( 1 )
    expect( reapedBusy ).not.toHaveBeenCalled()
    expect( sup.size ).toBe( 2 )
  } )

  it( 'falls back to the absolute LRU when every facet is busy', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000, evictLruOnPressure: true })
    sup.setAttentionState( 0.6 )               // 2 facets max

    const reapedA = vi.fn()
    const a = sup.spawn( busyDeps( 0 ) )
    a.handle!.onReaped( reapedA )
    await a.handle!.report( { type: 'language_percept' } as any )

    const b = sup.spawn( busyDeps( 5 ) )
    await b.handle!.report( { type: 'language_percept' } as any )

    const c = sup.spawn( spawnDeps( 10 ) )     // all busy → still admit; evict LRU (A)
    expect( c.attention ).toBe( 'available' )
    expect( reapedA ).toHaveBeenCalledTimes( 1 )
    expect( sup.size ).toBe( 2 )
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

// ─────────────────────────────────────────────────────────────
// tests/unit/attention.effort.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Dynamic attention budget — voluntary effort (Option C).
 *
 *   - A `focus` request (effortTarget 1.0) snaps effort up → higher capacity →
 *     larger free fraction → more facets.
 *   - A `rest` request (effortTarget 0.4) stands effort down → smaller budget.
 *   - With no request, effort decays back toward the homeostatic baseline (0.7).
 *   - Requests are clamped to [0.4, 1.0].
 *   - Vitals form the ceiling: effort scales it, so low energy still shrinks the
 *     result (you cannot focus past exhaustion).
 */

import { describe, it, expect } from 'vitest'
import { AttentionAllocator } from '#faculties/attention.allocator'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

const freshState = (): ReadonlySimulationState =>
  ( { tick: 1, time: 1000, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )

const CTX = {} as SimulationContext

function metricVal( res: any, key: string ): number {
  const m = ( res.commands?.metrics ?? [] ).find( ( e: [string, number] ) => e[0] === key )
  return m?.[1]
}

function regulate( a: AttentionAllocator, effortTarget: number ): void {
  a.onCognitiveEvent( {
    type: 'attention.regulate', version: 1, sourceEngine: 'executive-engine',
    salience: 0.6, payload: { effortTarget },
  } as any )
}

const tickReact = ( a: AttentionAllocator, tick: number ) => a.react( 1000, tick as any, freshState(), CTX )

describe( 'AttentionAllocator — voluntary effort (Option C)', () => {
  it( 'starts at the homeostatic baseline (0.7)', async () => {
    const a = new AttentionAllocator()
    const r = await tickReact( a, 1 )
    expect( metricVal( r, 'attention.effort' ) ).toBeCloseTo( 0.7, 5 )
  } )

  it( 'a focus request snaps effort to 1.0 and raises capacity + free fraction', async () => {
    const a = new AttentionAllocator()
    const base = await tickReact( a, 1 )

    regulate( a, 1.0 )                  // "focus"
    const focused = await tickReact( a, 2 )

    expect( metricVal( focused, 'attention.effort' ) ).toBe( 1.0 )
    expect( metricVal( focused, 'attention.capacity' ) ).toBeGreaterThan( metricVal( base, 'attention.capacity' ) )
    // free fraction = effort under full vitals → drives the facet budget up.
    expect( metricVal( focused, 'attention.free_fraction' ) ).toBeGreaterThan( metricVal( base, 'attention.free_fraction' ) )
    expect( metricVal( focused, 'attention.free_fraction' ) ).toBeCloseTo( 1.0, 5 )
  } )

  it( 'a rest request stands effort down to 0.4 (smaller budget)', async () => {
    const a = new AttentionAllocator()
    regulate( a, 0.4 )                  // "rest"
    const rested = await tickReact( a, 1 )

    expect( metricVal( rested, 'attention.effort' ) ).toBe( 0.4 )
    expect( metricVal( rested, 'attention.free_fraction' ) ).toBeCloseTo( 0.4, 5 )
  } )

  it( 'decays back toward baseline when no request is renewed', async () => {
    const a = new AttentionAllocator()
    regulate( a, 1.0 )
    await tickReact( a, 1 )             // effort = 1.0
    const next = await tickReact( a, 2 )   // no request → relaxes toward 0.7

    const e = metricVal( next, 'attention.effort' )
    expect( e ).toBeLessThan( 1.0 )
    expect( e ).toBeGreaterThan( 0.7 )
  } )

  it( 'clamps an out-of-range request into [0.4, 1.0]', async () => {
    const a = new AttentionAllocator()
    regulate( a, 5 )                    // absurd over-focus
    expect( metricVal( await tickReact( a, 1 ), 'attention.effort' ) ).toBe( 1.0 )

    regulate( a, -3 )                   // absurd under-rest
    expect( metricVal( await tickReact( a, 2 ), 'attention.effort' ) ).toBe( 0.4 )
  } )

  it( 'vitals cap the result: low energy shrinks capacity even at full focus', async () => {
    const a = new AttentionAllocator()
    // Drive energy critically low via the regulatory event the allocator consumes.
    a.onCognitiveEvent( { type: 'energy.state.changed', version: 1, sourceEngine: 'energy', salience: 0.5, payload: { level: 5 } } as any )
    regulate( a, 1.0 )                  // will to focus…
    const r = await tickReact( a, 1 )

    expect( metricVal( r, 'attention.effort' ) ).toBe( 1.0 )       // chose full focus
    // …but the ceiling collapsed: even full focus yields less than the normal
    // resting capacity (baseline 0.7 effort at full vitals = 70). You cannot
    // focus past exhaustion.
    expect( metricVal( r, 'attention.capacity' ) ).toBeLessThan( 70 )
  } )
} )

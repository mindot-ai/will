// ─────────────────────────────────────────────────────────────
// tests/integration/attention.budget.loop.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * End-to-end: a focus / rest DECISION actually moves maxFacets in a running mind.
 *
 * The real control loop, over a real CognitiveBus:
 *   executive action choice
 *     → effortTargetForActions()                  (the engine's real mapping)
 *     → attention.regulate event
 *     → AttentionAllocator.onCognitiveEvent + react()  (effort → capacity → freeFraction)
 *     → attention.state.changed event
 *     → FacetSupervisor.setAttentionState()       (the executive's real bridge one-liner)
 *     → maxFacets
 *
 * Asserts: choosing `focus` admits MORE concurrent facets than choosing `rest`.
 */

import { describe, it, expect, vi } from 'vitest'
import { createTestBus } from '#cognition/bus'
import { AttentionAllocator } from '#faculties/attention.allocator'
import { FacetSupervisor } from '#faculties/executive.engine/facet.supervisor'
import { effortTargetForActions } from '#faculties/executive.engine'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

vi.spyOn( console, 'info' ).mockImplementation( () => {} )

const freshState = (): ReadonlySimulationState =>
  ( { tick: 1, time: 1000, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )
const CTX = {} as SimulationContext

function spawnDeps( tick: number ){
  return { bus: createTestBus(), llmDirector: {} as any, stateRef: { tick } as any,
           contextDeps: {} as any, promptDeps: {} as any, willId: 'w' }
}

describe( 'Attention budget control loop (focus/rest → maxFacets)', () => {
  it( 'a focus decision admits more facets than a rest decision — over the real bus', async () => {
    const bus       = createTestBus()
    const allocator = new AttentionAllocator()
    const supervisor = new FacetSupervisor({ idleTtlTicks: 1e9, evictLruOnPressure: false })

    allocator.attachBus( bus )
    // Allocator hears voluntary focus/rest (and anything else it subscribes to).
    bus.subscribe( 'attention-allocator', allocator.subscribes(), e => { allocator.onCognitiveEvent( e ) } )
    // The executive's REAL bridge: attention.state.changed → supervisor budget.
    bus.subscribe( 'executive-engine', [ 'attention.state.changed' ],
      e => supervisor.setAttentionState( ( e.payload as { freeFraction: number } ).freeFraction ) )

    // The executive "decides" by choosing actions; the real mapping derives the
    // effort target and we publish exactly the event the engine would.
    const decide = ( actionTypes: string[] ) => {
      const effortTarget = effortTargetForActions( actionTypes )
      if( effortTarget != null )
        bus.publish( { type: 'attention.regulate', version: 1, sourceEngine: 'executive-engine',
                       salience: 0.6, payload: { effortTarget } } )
    }

    // Count how many facets the supervisor admits from empty under the current budget.
    const admissible = (): number => {
      const handles: any[] = []
      for( let i = 0; i < 12; i++ ){
        const r = supervisor.spawn( spawnDeps( i ) )
        if( r.attention === 'available' && r.handle ){ handles.push( r.handle ) }
        else break
      }
      const n = handles.length
      handles.forEach( h => h.destroy() )   // reset to empty for the next phase
      return n
    }

    // Capture the freeFraction the supervisor actually receives over the bus.
    const delivered: number[] = []
    bus.subscribe( 'probe', [ 'attention.state.changed' ], e => { delivered.push( ( e.payload as { freeFraction: number } ).freeFraction ) } )

    // Warm-up so the GenerativeModel's cold-start (its first observe is always
    // gated) is consumed at baseline — focus/rest then register as real,
    // publishable changes (a quiet running mind already has attention history).
    await allocator.react( 50, 0 as any, freshState(), CTX )

    // ── FOCUS ────────────────────────────────────────────────
    decide( [ 'focus' ] )            // → attention.regulate { effortTarget: 1.0 }
    await allocator.react( 50, 1 as any, freshState(), CTX )   // → attention.state.changed → supervisor
    const facetsWhenFocused = admissible()

    // ── REST ─────────────────────────────────────────────────
    decide( [ 'rest' ] )             // → attention.regulate { effortTarget: 0.4 }
    await allocator.react( 50, 2 as any, freshState(), CTX )
    const facetsWhenResting = admissible()

    // The effort change reached the supervisor over the bus: a high free fraction
    // (focus) followed by a low one (rest).
    expect( Math.max( ...delivered ) ).toBeGreaterThan( Math.min( ...delivered ) )
    expect( delivered.some( f => f >= 0.9 ) ).toBe( true )   // focus
    expect( delivered.some( f => f <= 0.5 ) ).toBe( true )   // rest

    // The decision moved the budget, end-to-end.
    expect( facetsWhenFocused ).toBeGreaterThan( facetsWhenResting )
    expect( facetsWhenFocused ).toBe( 3 )    // freeFraction ~1.0 → floor(1.0/0.3) = 3
    expect( facetsWhenResting ).toBe( 1 )    // freeFraction 0.4  → floor(0.4/0.3) = 1
  } )
} )

describe( 'effortTargetForActions — executive action → effort mapping', () => {
  it( 'focus → 1.0', () => expect( effortTargetForActions( [ 'focus' ] ) ).toBe( 1.0 ) )
  it( 'rest/sleep/wait/meditate → 0.4', () => {
    for( const a of [ 'rest', 'sleep', 'wait', 'meditate' ] )
      expect( effortTargetForActions( [ a ] ) ).toBe( 0.4 )
  } )
  it( 'focus wins if both are present', () =>
    expect( effortTargetForActions( [ 'rest', 'focus' ] ) ).toBe( 1.0 ) )
  it( 'no attention preference → null', () =>
    expect( effortTargetForActions( [ 'observe', 'reflect' ] ) ).toBeNull() )
} )

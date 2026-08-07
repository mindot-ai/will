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

vi.spyOn( console, 'info').mockImplementation( () => {} )

const freshState = (): ReadonlySimulationState =>
  ( { tick: 1, time: 1000, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )
const CTX = {} as SimulationContext

// The supervisor resolves its facet ceiling from the engine-config mirror through
// the persona-prior, so the state it spawns against must carry one — the same
// `engine-config-executive` entity buildEngineConfigEntities seeds at boot. What
// this test measures is the ATTENTION half of the budget: the ceiling is held
// fixed at its default of 10 so any difference between phases is the free
// fraction moving, not the persona.
function spawnDeps( tick: number ){
  return {
    bus: createTestBus(), llmDirector: {} as any,
    stateRef: {
      tick,
      entities: new Map( [ [ 'engine-config-executive', {
        id: 'engine-config-executive', type: 'engine.config',
        metadata: { engine: 'executive', params: { maxFacets: 10 } },
      } ] ] ),
    } as any,
    contextDeps: {} as any, promptDeps: {} as any, willId: 'w',
  }
}

describe('Attention budget control loop (focus/rest → maxFacets)', () => {
  it('a focus decision admits more facets than a rest decision — over the real bus', async () => {
    const bus       = createTestBus()
    const allocator = new AttentionAllocator()
    const supervisor = new FacetSupervisor({ idleTtlTicks: 1e9, evictLruOnPressure: false })

    allocator.attachBus( bus )
    // Allocator hears voluntary focus/rest (and anything else it subscribes to).
    bus.subscribe('attention-allocator', allocator.subscribes(), e => { allocator.onCognitiveEvent( e ) } )
    // The executive's REAL bridge: attention.state.changed → supervisor budget.
    bus.subscribe('executive-engine', [ 'attention.state.changed' ],
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
    bus.subscribe('probe', [ 'attention.state.changed' ], e => { delivered.push( ( e.payload as { freeFraction: number } ).freeFraction ) } )

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
    // Attention scales the persona's ceiling (10 here) rather than replacing it:
    // choosing to focus opens the whole of it, choosing to rest narrows it to
    // roughly the free fraction of it — and resting still leaves room for more
    // than one thread, which the old floor(free/0.3) arithmetic did not.
    expect( facetsWhenFocused ).toBe( 10 )   // freeFraction ~1.0 → round(10 × 1.0)
    expect( facetsWhenResting ).toBe( 4 )    // freeFraction  0.4 → round(10 × 0.4)
  } )
} )

/**
 * The return leg: attending to a conversation COSTS attention.
 *
 * The loop used to run one way only. `freeFraction` scaled the facet budget, but a
 * facet never appeared in the allocator's `_activeFocus` — it is built purely from
 * `_extractSalienceSignals`, a salience map over percepts and `attention.demand`
 * entities — so holding three live conversations reported exactly as much spare
 * attention as holding none. The budget was scaled by a signal blind to the thing
 * it was bounding.
 *
 * ExecutiveEngine now publishes one `attention.demand` per REASONING facet, so a
 * facet competes for `maxFoci` slots against every percept and pays `costPerFocus`
 * out of the same 100-unit capacity. Being in a thread is free; attending to it is
 * not.
 */
describe('Attention economy — a reasoning facet consumes real capacity', () => {
  /** State carrying `n` facet attention-demands, exactly as the engine writes them. */
  const stateAttending = ( n: number ): ReadonlySimulationState => {
    const entities = new Map<string, unknown>()
    for( let i = 0; i < n; i++ )
      entities.set( `facet-attending-facet-${i}`, {
        id: `facet-attending-facet-${i}`, type: 'attention.demand',
        metadata: { urgency: 0.7, source: 'executive-facet', facetId: `facet-${i}` },
      } )
    return { tick: 1, time: 1000, entities, metrics: new Map() } as unknown as ReadonlySimulationState
  }

  const freeFractionAfter = async ( n: number ): Promise<number> => {
    const allocator = new AttentionAllocator()
    let free = 1
    // Two ticks: the first captures the foci (paying the shift cost), the second
    // reinforces them — a conversation is a sustained focus, not a one-tick blip.
    for( const tick of [ 1, 2 ] ){
      const { commands } = await allocator.react( 50, tick as any, stateAttending( n ), CTX )
      const m = commands?.metrics?.find( ( [ k ] ) => k === 'attention.free_fraction')
      if( m ) free = m[1] as number
    }
    return free
  }

  it('spends attention on facets that are reasoning — free fraction falls as threads engage', async () => {
    const idle  = await freeFractionAfter( 0 )
    const one   = await freeFractionAfter( 1 )
    const three = await freeFractionAfter( 3 )

    expect( idle ).toBeGreaterThan( one )
    expect( one ).toBeGreaterThan( three )
  } )

  it('feeds that cost back into the facet budget — attending narrows what it will take on', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000, evictLruOnPressure: false })

    const admissible = ( free: number ): number => {
      sup.setAttentionState( free )
      const handles: any[] = []
      for( let i = 0; i < 12; i++ ){
        const r = sup.spawn( spawnDeps( i ) )
        if( r.attention === 'available' && r.handle ) handles.push( r.handle )
        else break
      }
      const n = handles.length
      handles.forEach( h => h.destroy() )
      return n
    }

    // The whole point of closing the loop: the mind's own engagement, not just its
    // vitals, is what narrows the room it has for more.
    expect( admissible( await freeFractionAfter( 0 ) ) )
      .toBeGreaterThan( admissible( await freeFractionAfter( 3 ) ) )
  } )

  it('stops charging past maxFoci — in six threads, attending to four', async () => {
    // The two-level model's load-bearing property. `maxFoci` (4) caps how many
    // things get attended to at once, so the cost of engagement saturates: measured
    // free fraction runs 0.70 idle → 0.55 at three → 0.50 at four, and stays 0.50
    // at six. A mind cannot talk itself into paralysis by opening more threads, and
    // the ones past the cap are open-but-unattended rather than free.
    const four = await freeFractionAfter( 4 )
    const six  = await freeFractionAfter( 6 )

    expect( six ).toBeCloseTo( four, 5 )
    expect( four ).toBeLessThan( await freeFractionAfter( 3 ) )
  } )

  it('charges nothing for a thread that is merely open', async () => {
    // busyFacetIds() reports only facets with queued reports or an in-flight
    // _reason(); an idle-but-open facet writes no demand, so it costs nothing.
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000 })
    sup.spawn( spawnDeps( 0 ) )
    sup.spawn( spawnDeps( 1 ) )

    expect( sup.size ).toBe( 2 )
    expect( sup.busyFacetIds() ).toEqual( [] )
  } )

  it('reports a facet as attending once it has work queued', async () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10_000 })
    const res = sup.spawn( { ...spawnDeps( 0 ), inbox: { enqueue: vi.fn() } as any } )
    await res.handle!.report( { type: 'language_percept' } as any )   // queued → busy

    expect( sup.busyFacetIds() ).toEqual( [ res.handle!.facetId ] )
  } )
} )

describe('effortTargetForActions — executive action → effort mapping', () => {
  it('focus → 1.0', () => expect( effortTargetForActions( [ 'focus' ] ) ).toBe( 1.0 ) )
  it('rest/sleep/wait/meditate → 0.4', () => {
    for( const a of [ 'rest', 'sleep', 'wait', 'meditate' ] )
      expect( effortTargetForActions( [ a ] ) ).toBe( 0.4 )
  } )
  it('focus wins if both are present', () =>
    expect( effortTargetForActions( [ 'rest', 'focus' ] ) ).toBe( 1.0 ) )
  it('no attention preference → null', () =>
    expect( effortTargetForActions( [ 'observe', 'reflect' ] ) ).toBeNull() )
} )

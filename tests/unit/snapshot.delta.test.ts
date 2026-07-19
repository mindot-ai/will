// ─────────────────────────────────────────────────────────────
// tests/unit/snapshot.delta.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for SnapshotManager delta baseline advancement (FN13).
 *
 * Regression target: `_lastFullState` was only assigned when `delta` was falsy
 * (`if( !delta )`). After the first snapshot every later delta was therefore
 * computed against that one tick-0 baseline forever — never advancing. The
 * deltas grew without bound and, once the tick-0 entry was evicted by the
 * `maxInMemorySnapshots` ring buffer, the surviving delta-only entries
 * referenced a base that no longer existed.
 *
 * The fix advances the baseline (`_prevState`) on every snapshot, so each
 * delta describes a single interval of change against its immediate
 * predecessor. Each entry still stores the full serialized state, so it
 * remains a self-contained keyframe for restore() even after its predecessor
 * is evicted.
 */

import { describe, it, expect } from 'vitest'
import { SnapshotManager } from '#core/snapshot.manager'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState, SimulationContext, Tick } from '#core/types'

const ctx = createContext('sim', 'run', 1 ) as unknown as SimulationContext

/**
 * A state whose single counter metric grows by `tick` each call and which
 * gains one fresh entity per tick. Both let us see whether a delta is
 * incremental (one interval) or cumulative-since-tick-0.
 */
function stateAt( tick: number ): ReadonlySimulationState {
  const entities = new Map()
  // One entity that is rewritten every tick (updatedAt advances) …
  entities.set('counter', {
    id: 'counter', type: 'counter',
    createdAt: 0, updatedAt: tick,
    metadata: { value: tick, components: {} },
  })
  // … plus a brand-new entity each tick, so the *cumulative* entity set grows
  // monotonically while the *per-interval* delta stays a single addition.
  entities.set(`e-${tick}`, {
    id: `e-${tick}`, type: 'ephemeral',
    createdAt: tick, updatedAt: tick,
    metadata: { components: {} },
  })

  return {
    tick: tick as Tick,
    time: tick * 16,
    entities,
    metrics: new Map<string, number>([ [ 'count', tick * 10 ] ]),
  } as unknown as ReadonlySimulationState
}

/** Drive the manager tick-by-tick up to `lastTick` at snapshotInterval 1. */
function run( mgr: SnapshotManager, lastTick: number ): void {
  for( let t = 1; t <= lastTick; t++ )
    mgr.onTick( t as Tick, stateAt( t ), ctx )
}

describe('SnapshotManager — delta baseline advances every snapshot (FN13)', () => {
  it('each delta references its immediate predecessor, not the frozen tick-0 base', () => {
    const mgr = new SnapshotManager({ snapshotInterval: 1, persistInterval: 0 })
    run( mgr, 5 )

    const snaps = mgr.getAllSnapshots()
    expect( snaps.length ).toBe( 5 )

    // First snapshot is a pure keyframe (no predecessor → no delta).
    expect( snaps[0]!.delta ).toBeUndefined()

    // Every subsequent delta's baseTick is the *previous* snapshot's tick.
    for( let i = 1; i < snaps.length; i++ ){
      const delta = snaps[i]!.delta
      expect( delta ).toBeDefined()
      expect( delta!.baseTick ).toBe( snaps[i - 1]!.tick )
      expect( delta!.currentTick ).toBe( snaps[i]!.tick )
    }
  })

  it('deltas stay bounded — one interval of change, not cumulative-since-tick-0', () => {
    const mgr = new SnapshotManager({ snapshotInterval: 1, persistInterval: 0 })
    run( mgr, 6 )

    const snaps = mgr.getAllSnapshots()
    // Each interval adds exactly one new entity (`e-<tick>`) and rewrites
    // `counter`. A frozen tick-0 baseline would make addedEntities grow every
    // tick (tick N would show N freshly-added entities); an advancing baseline
    // keeps it at exactly one per interval.
    for( let i = 1; i < snaps.length; i++ ){
      const delta = snaps[i]!.delta!
      expect( delta.addedEntities.length ).toBe( 1 )
      expect( delta.addedEntities[0]!.id ).toBe(`e-${snaps[i]!.tick}`)
      // The single shared metric changes by a constant +10 each interval —
      // never an accumulating sum.
      expect( delta.metricsDelta ).toEqual( [ [ 'count', 10 ] ] )
    }
  })

  it('surviving entries restore correctly after the baseline entry is evicted', () => {
    // Ring holds only 3 snapshots; we take 6, so ticks 1–3 are evicted and the
    // original delta baseline is long gone.
    const mgr = new SnapshotManager({ snapshotInterval: 1, persistInterval: 0, maxInMemorySnapshots: 3 })
    run( mgr, 6 )

    const snaps = mgr.getAllSnapshots()
    expect( snaps.length ).toBe( 3 )
    expect( snaps.map( s => s.tick ) ).toEqual( [ 4, 5, 6 ] )

    // The evicted-base ticks can no longer be restored …
    expect( mgr.restoreState( 1 as Tick ) ).toBeUndefined()

    // … but every surviving entry is a self-contained keyframe: restore works
    // off the full `state`, independent of any (now-evicted) delta base.
    const restored = mgr.restoreState( 5 as Tick )
    expect( restored ).toBeDefined()
    expect( restored!.tick ).toBe( 5 )
    expect( restored!.metrics.get('count') ).toBe( 50 )
    expect( restored!.entities.has('e-5') ).toBe( true )
    expect( restored!.entities.get('counter')!.updatedAt ).toBe( 5 )
  })

  it('computeDeltas:false produces keyframe-only entries and never advances a baseline', () => {
    const mgr = new SnapshotManager({ snapshotInterval: 1, persistInterval: 0, computeDeltas: false })
    run( mgr, 4 )

    for( const s of mgr.getAllSnapshots() )
      expect( s.delta ).toBeUndefined()

    // Restore still works purely from the stored full state.
    const restored = mgr.restoreState( 3 as Tick )
    expect( restored!.metrics.get('count') ).toBe( 30 )
  })
})

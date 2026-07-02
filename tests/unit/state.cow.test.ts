// ─────────────────────────────────────────────────────────────
// tests/unit/state.cow.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Copy-on-write snapshots (REORIENT R3-b / FIX F8).
 *
 * `snapshot()` used to eagerly `new Map(...)` both the entity and metric maps
 * on every call — an O(n) double copy twice per tick (pre- and post-commit).
 * R3-b makes the snapshot share the live maps by reference and marks them
 * shared; the NEXT mutation clones the map once before writing. Entities are
 * deep-frozen on write (R3-a), so sharing a reference can never leak a mutable
 * value.
 *
 * These tests pin the two halves of the contract:
 *   1. Sharing — back-to-back snapshots with no write between return the SAME
 *      map instance (proof the copy is elided), and the first write afterwards
 *      swaps in a fresh instance (proof the clone is deferred, not skipped).
 *   2. Isolation — a snapshot remains a genuine point-in-time view across later
 *      set / delete / metric writes, restore(), and clear(). This is the
 *      rollback/replay-correctness guarantee that must survive the optimization.
 */

import { describe, it, expect } from 'vitest'
import { DefaultStateManager } from '#core/state.manager'

describe( 'StateManager copy-on-write snapshots (R3-b / FIX F8)', () => {
  it( 'shares the live maps between snapshots until the next write', () => {
    const sm = new DefaultStateManager()
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })
    sm.setMetric( 'm', 1 )

    const a = sm.snapshot()
    const b = sm.snapshot()

    // No write between the two snapshots → the copy is elided (same instance).
    expect( b.entities ).toBe( a.entities )
    expect( b.metrics ).toBe( a.metrics )

    // The first write after a snapshot clones the map once: a fresh snapshot
    // now returns a different instance.
    sm.setEntity({ id: 'e2', type: 'belief', metadata: { count: 2 } })
    const c = sm.snapshot()
    expect( c.entities ).not.toBe( a.entities )
  } )

  it( 'keeps a snapshot isolated from a later setEntity (point-in-time)', () => {
    const sm = new DefaultStateManager()
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })

    const snap = sm.snapshot()
    sm.updateClock( 1, 100 )
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 2 } })

    expect( snap.entities.get( 'e1' )!.metadata!.count ).toBe( 1 )
    expect( sm.getEntity( 'e1' )!.metadata!.count ).toBe( 2 )
    expect( snap.entities.has( 'e2' ) ).toBe( false )
  } )

  it( 'keeps a snapshot isolated from a later deleteEntity', () => {
    const sm = new DefaultStateManager()
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })

    const snap = sm.snapshot()
    sm.deleteEntity( 'e1' )

    expect( snap.entities.has( 'e1' ) ).toBe( true )   // snapshot still sees it
    expect( sm.getEntity( 'e1' ) ).toBeUndefined()      // live state dropped it
  } )

  it( 'keeps a snapshot isolated from later metric writes', () => {
    const sm = new DefaultStateManager()
    sm.setMetric( 'energy', 10 )

    const snap = sm.snapshot()
    sm.setMetric( 'energy', 20 )
    sm.incrementMetric( 'energy', 5 )

    expect( snap.metrics.get( 'energy' ) ).toBe( 10 )
    expect( sm.getMetric( 'energy' ) ).toBe( 25 )
  } )

  it( 'does not wipe an outstanding snapshot when clear() runs', () => {
    const sm = new DefaultStateManager()
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })
    sm.setMetric( 'm', 7 )

    const snap = sm.snapshot()
    sm.clear()

    // clear() replaces the maps rather than emptying the shared ones.
    expect( snap.entities.get( 'e1' )!.metadata!.count ).toBe( 1 )
    expect( snap.metrics.get( 'm' ) ).toBe( 7 )
    expect( [ ...sm.getAllEntities() ] ).toHaveLength( 0 )
    expect( sm.getMetric( 'm' ) ).toBeUndefined()
  } )

  it( 'does not corrupt an outstanding snapshot when restore() runs', () => {
    const sm = new DefaultStateManager()
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })

    const snap = sm.snapshot()
    sm.restore({
      tick: 9,
      time: 900,
      entities: new Map([ [ 'e2', { id: 'e2', type: 'goal', createdAt: 0, updatedAt: 0, metadata: { v: 5 } } ] ]),
      metrics: new Map(),
    })

    // Pre-restore snapshot is untouched; live state reflects the restore.
    expect( snap.entities.has( 'e1' ) ).toBe( true )
    expect( snap.entities.has( 'e2' ) ).toBe( false )
    expect( sm.getEntity( 'e1' ) ).toBeUndefined()
    expect( sm.getEntity( 'e2' )!.metadata!.v ).toBe( 5 )

    // A post-restore write must not reach back into the pre-restore snapshot.
    sm.setEntity({ id: 'e2', type: 'goal', metadata: { v: 6 } })
    expect( snap.entities.has( 'e2' ) ).toBe( false )
  } )
} )

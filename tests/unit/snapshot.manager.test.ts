// ─────────────────────────────────────────────────────────────
// tests/unit/snapshot.manager.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SnapshotManager query / restore / persistence contract (REORIENT R7).
 *
 * The delta-baseline logic is already covered by snapshot.delta.test.ts (FN13);
 * this file pins the rest of the public surface the simulation depends on for
 * rollback and restart — none of which had direct coverage:
 *
 *   1. snapshotInterval gates how often onTick takes a snapshot.
 *   2. getSnapshot / getLatestSnapshot / snapshotCount query the in-memory ring.
 *   3. restoreState() round-trips a stored snapshot back to a live
 *      SimulationState (entities + metrics + clock) usable by StateManager.restore.
 *   4. The in-memory ring evicts oldest-first past maxInMemorySnapshots, and
 *      evicted ticks are no longer queryable.
 *   5. The onSnapshot callback (ReplayRecorder feed) fires per snapshot.
 *   6. persistNow() + loadLatestFromStorage() round-trip through a StorageAdapter
 *      (in-memory stub — no filesystem), and persistInterval: 0 disables both.
 */

import { describe, it, expect } from 'vitest'
import { SnapshotManager } from '#core/snapshot.manager'
import { createContext } from '#core/utils'
import type { StorageAdapter } from '#core/abstracts'
import type {
  ReadonlySimulationState,
  SimulationEntity,
  SimulationContext,
} from '#core/types'

const ctx = createContext('sim', 'snap', 1 ) as unknown as SimulationContext

/** In-memory StorageAdapter — keeps persistence deterministic and off-disk. */
class MemoryStorage implements StorageAdapter {
  files = new Map<string, string>()
  async write( path: string, content: string | Uint8Array ): Promise<void> {
    this.files.set( path, typeof content === 'string' ? content : new TextDecoder().decode( content ) )
  }
  async read( path: string ): Promise<string> {
    const v = this.files.get( path )
    if( v === undefined ) throw new Error(`not found: ${path}`)
    return v
  }
  async readBytes( path: string ): Promise<Uint8Array> {
    return new TextEncoder().encode( await this.read( path ) )
  }
  async exists( path: string ): Promise<boolean> { return this.files.has( path ) }
  async delete( path: string ): Promise<void> { this.files.delete( path ) }
  async ensureDir( _path: string ): Promise<void> { /* no-op */ }
}

function entity( id: string, value: number ): SimulationEntity {
  return { id, type: 'thing', createdAt: 0, updatedAt: 0, metadata: { value } }
}

function stateAt(
  tick: number,
  entities: Array<[ string, SimulationEntity ]> = [],
  metrics:  Array<[ string, number ]> = []
): ReadonlySimulationState {
  return {
    tick,
    time:     tick * 100,
    entities: new Map( entities ),
    metrics:  new Map( metrics ),
  } as unknown as ReadonlySimulationState
}

// ── 1. snapshotInterval gating ────────────────────────────────

describe('SnapshotManager — snapshotInterval gating (R7)', () => {
  it('takes a snapshot only once every `snapshotInterval` ticks', () => {
    const mgr = new SnapshotManager({
      snapshotInterval: 2, persistInterval: 0, computeDeltas: false, storage: new MemoryStorage(),
    } )

    mgr.onTick( 1, stateAt( 1 ), ctx ); expect( mgr.snapshotCount ).toBe( 0 )
    mgr.onTick( 2, stateAt( 2 ), ctx ); expect( mgr.snapshotCount ).toBe( 1 )
    mgr.onTick( 3, stateAt( 3 ), ctx ); expect( mgr.snapshotCount ).toBe( 1 )
    mgr.onTick( 4, stateAt( 4 ), ctx ); expect( mgr.snapshotCount ).toBe( 2 )
  } )
} )

// ── 2. Query API ──────────────────────────────────────────────

describe('SnapshotManager — query API (R7)', () => {
  it('exposes snapshots by tick, the latest entry, and a count', () => {
    const mgr = new SnapshotManager({
      snapshotInterval: 1, persistInterval: 0, storage: new MemoryStorage(),
    } )

    mgr.onTick( 1, stateAt( 1, [ [ 'e1', entity('e1', 1 ) ] ] ), ctx )
    mgr.onTick( 2, stateAt( 2, [ [ 'e1', entity('e1', 2 ) ] ] ), ctx )

    expect( mgr.snapshotCount ).toBe( 2 )
    expect( mgr.getSnapshot( 1 ) ).toBeDefined()
    expect( mgr.getSnapshot( 99 ) ).toBeUndefined()
    expect( mgr.getLatestSnapshot()?.tick ).toBe( 2 )
  } )
} )

// ── 3. restoreState round-trip ────────────────────────────────

describe('SnapshotManager — restoreState round-trip (R7)', () => {
  it('rebuilds a live SimulationState (entities + metrics + clock) from a snapshot', () => {
    const mgr = new SnapshotManager({
      snapshotInterval: 1, persistInterval: 0, storage: new MemoryStorage(),
    } )

    mgr.onTick( 5, stateAt( 5, [ [ 'e1', entity('e1', 42 ) ] ], [ [ 'm', 7 ] ] ), ctx )

    const restored = mgr.restoreState( 5 )
    expect( restored ).toBeDefined()
    expect( restored!.tick ).toBe( 5 )
    expect( restored!.time ).toBe( 500 )
    expect( restored!.entities.get('e1')?.metadata?.value ).toBe( 42 )
    expect( restored!.metrics.get('m') ).toBe( 7 )

    expect( mgr.restoreState( 99 ) ).toBeUndefined()
  } )
} )

// ── 4. Ring-buffer eviction ───────────────────────────────────

describe('SnapshotManager — in-memory ring eviction (R7)', () => {
  it('evicts oldest-first past maxInMemorySnapshots', () => {
    const mgr = new SnapshotManager({
      snapshotInterval: 1, maxInMemorySnapshots: 2, persistInterval: 0, storage: new MemoryStorage(),
    } )

    for( const t of [ 1, 2, 3, 4 ] )
      mgr.onTick( t, stateAt( t ), ctx )

    expect( mgr.snapshotCount ).toBe( 2 )
    expect( mgr.getSnapshot( 1 ) ).toBeUndefined()   // evicted
    expect( mgr.getSnapshot( 2 ) ).toBeUndefined()   // evicted
    expect( mgr.getSnapshot( 3 ) ).toBeDefined()
    expect( mgr.getLatestSnapshot()?.tick ).toBe( 4 )
  } )
} )

// ── 5. onSnapshot callback ────────────────────────────────────

describe('SnapshotManager — onSnapshot callback (R7)', () => {
  it('invokes the replay-feed callback for each snapshot taken', () => {
    const mgr = new SnapshotManager({
      snapshotInterval: 1, persistInterval: 0, computeDeltas: false, storage: new MemoryStorage(),
    } )
    const ticks: number[] = []
    mgr.onSnapshot = ( tick ) => { ticks.push( tick ) }

    mgr.onTick( 1, stateAt( 1 ), ctx )
    mgr.onTick( 2, stateAt( 2 ), ctx )

    expect( ticks ).toEqual( [ 1, 2 ] )
  } )
} )

// ── 6. Persistence round-trip ─────────────────────────────────

describe('SnapshotManager — persistence via StorageAdapter (R7)', () => {
  it('persistNow() writes a snapshot + sentinel that loadLatestFromStorage() reads back', async () => {
    const storage = new MemoryStorage()
    const mgr = new SnapshotManager({ persistInterval: 100, persistPath: '/snaps', storage } )

    await mgr.persistNow( stateAt( 7, [ [ 'e1', entity('e1', 99 ) ] ] ) )

    expect( await storage.exists('/snaps/latest.json') ).toBe( true )

    const loaded = await mgr.loadLatestFromStorage()
    expect( loaded ).toBeDefined()
    expect( loaded!.entities.get('e1')?.metadata?.value ).toBe( 99 )
  } )

  it('persistInterval: 0 disables both persistNow and loadLatestFromStorage', async () => {
    const storage = new MemoryStorage()
    const mgr = new SnapshotManager({ persistInterval: 0, persistPath: '/snaps', storage } )

    await mgr.persistNow( stateAt( 1 ) )
    expect( storage.files.size ).toBe( 0 )                       // nothing written
    expect( await mgr.loadLatestFromStorage() ).toBeUndefined()  // nothing to load
  } )
} )

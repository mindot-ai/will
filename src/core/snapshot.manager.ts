// ─────────────────────────────────────────────────────────────
// src/core/snapshot.manager.ts
// ─────────────────────────────────────────────────────────────

/**
 * SnapshotManager — first-class state serialization for the simulation core.
 * 
 * Follows the same pattern as DefaultMetricCollector:
 *   - Implements TickMiddleware via an onTick method
 *   - Wired into DefaultSimulation via orchestratorConfig.onAfterTick
 *   - Always active (configurable interval, not optional existence)
 * 
 * Responsibilities:
 *   1. Serialize simulation state at configurable intervals
 *   2. Compute deltas between snapshots
 *   3. Feed the ReplayRecorder with structured tick data
 *   4. Persist snapshots to disk
 *   5. Provide restore points for StateManager.restore()
 */

import { logger } from '#core/logger'
import type { Tick, ReadonlySimulationState, SimulationContext, SimulationState } from '#core/types'
import type { Serializer, SerializedState, DeltaSnapshot } from '#core/serialization'
import { BunStorageAdapter, type StorageAdapter } from '#core/abstracts'
import { DefaultSerializer, DeltaEncoder } from '#core/serialization'
import { wallClock } from '#core/wall.clock'

export interface SnapshotManagerConfig {
  /** How often to take full snapshots (ticks). 1 = every tick. */
  snapshotInterval?: number
  /** How often to persist to disk (ticks). 0 = never. */
  persistInterval?: number
  /** Base path for persisted snapshots */
  persistPath?: string
  /** Whether to compute deltas between snapshots */
  computeDeltas?: boolean
  /** Maximum in-memory snapshots to retain */
  maxInMemorySnapshots?: number
  /** Storage adapter */
  storage?: StorageAdapter
}

export interface SnapshotEntry {
  tick: Tick
  state: SerializedState
  delta?: DeltaSnapshot
  timestamp: number
}

export class SnapshotManager {
  private _serializer: Serializer
  private _deltaEncoder: DeltaEncoder
  private _config: Required<SnapshotManagerConfig>
  private _storage: StorageAdapter

  private _snapshots: SnapshotEntry[] = []
  /**
   * Deserialized form of the *immediately preceding* snapshot, kept as the
   * baseline for the next delta. Caching the deserialized state (rather than a
   * SerializedState) lets us encode the next delta without re-stringifying and
   * re-deserializing the baseline every snapshot.
   */
  private _prevState?: SimulationState
  private _ticksSinceSnapshot = 0
  private _ticksSincePersist = 0
  private _currentTick: Tick = 0

  /** Callback for feeding replay recorder — set by DefaultSimulation */
  onSnapshot?: ( tick: Tick, state: SerializedState, delta?: DeltaSnapshot ) => void

  constructor( config: SnapshotManagerConfig = {} ){
    this._serializer    = new DefaultSerializer({ includeChecksum: true, prettyPrint: false })
    this._deltaEncoder  = new DeltaEncoder()
    this._storage       = config.storage ?? new BunStorageAdapter()

    this._config = {
      snapshotInterval:     config.snapshotInterval     ?? 10,
      persistInterval:      config.persistInterval      ?? 100,
      persistPath:          config.persistPath          ?? './data/snapshots',
      computeDeltas:        config.computeDeltas        ?? true,
      maxInMemorySnapshots: config.maxInMemorySnapshots ?? 500,
      storage:              this._storage,  // satisfies Required<>
    }

    this._config.persistInterval > 0
    && this._storage.ensureDir?.( this._config.persistPath ).catch(() => {})
  }

  /**
   * Implements the TickMiddleware signature.
   * Wire this as orchestratorConfig.onAfterTick to enable state serialization.
   * Follows the exact same pattern as DefaultMetricCollector.onTick.
   */
  onTick = ( tick: Tick, state: ReadonlySimulationState, _context: SimulationContext ): void => {
    this._currentTick = tick
    this._ticksSinceSnapshot++
    this._ticksSincePersist++

    // Take a snapshot at the configured interval
    if( this._ticksSinceSnapshot < this._config.snapshotInterval ) return

    this._ticksSinceSnapshot = 0

    // Serialize current state
    const serialized = this._serializer.serialize(
      state as unknown as SimulationState,
      'json'
    ) as string

    const parsed = JSON.parse( serialized ) as SerializedState

    // Compute the delta against the *immediately preceding* snapshot (FN13).
    // The previous code only advanced the baseline when `delta` was falsy
    // (`if( !delta )`), which — after the very first snapshot — pinned the
    // baseline to tick 0 forever: every later delta was computed against that
    // one stale state, growing without bound and, once the tick-0 entry was
    // evicted by the ring buffer, referencing a base that no longer existed.
    // Now each delta describes a single interval of change against the prior
    // snapshot, and the baseline advances every time.
    let delta: DeltaSnapshot | undefined
    let currState: SimulationState | undefined
    if( this._config.computeDeltas ){
      currState = this._serializer.deserialize( serialized )
      if( this._prevState )
        delta = this._deltaEncoder.encode( this._prevState, currState )
    }

    const entry: SnapshotEntry = {
      tick,
      state: parsed,
      delta,
      timestamp: wallClock(),
    }

    // Store in memory
    this._snapshots.push( entry )
    if( this._snapshots.length > this._config.maxInMemorySnapshots )
      this._snapshots.shift()

    // Advance the delta baseline on every snapshot so the next delta is
    // computed against this one. Each stored entry also keeps the full
    // serialized `state`, so it remains a self-contained keyframe for
    // restore() even after its predecessor is evicted.
    if( currState ) this._prevState = currState

    // Feed external consumers (e.g., ReplayRecorder)
    this.onSnapshot?.( tick, parsed, delta )

    // Persist to disk
    if( this._config.persistInterval > 0
        && this._ticksSincePersist >= this._config.persistInterval ){
      this._ticksSincePersist = 0
      this._persistSnapshot( entry ).catch( err => {
        logger.error(`[SnapshotManager] Persist failed at tick ${tick}:`, err )
      })
    }
  }

  // ── Query API ────────────────────────────────────────────

  /**
   * Retrieve a snapshot by tick.
   */
  getSnapshot( tick: Tick ): SerializedState | undefined {
    return this._snapshots.find( s => s.tick === tick )?.state
  }

  /**
   * Get all in-memory snapshots.
   */
  getAllSnapshots(): ReadonlyArray<SnapshotEntry> {
    return this._snapshots
  }

  /**
   * Get the most recent snapshot.
   */
  getLatestSnapshot(): SnapshotEntry | undefined {
    return this._snapshots[ this._snapshots.length - 1 ]
  }

  /**
   * Restore simulation state from a snapshot.
   * Returns the deserialized state ready for StateManager.restore().
   */
  restoreState( tick: Tick ): SimulationState | undefined {
    const snapshot = this.getSnapshot( tick )
    if( !snapshot ) return undefined
    return this._serializer.deserialize( JSON.stringify( snapshot ) )
  }

  /**
   * Export all snapshots to a file.
   */
  async exportAll( path: string ): Promise<void> {
    const output = {
      snapshots: this._snapshots.map( s => ({
        tick: s.tick,
        state: s.state,
        delta: s.delta,
        timestamp: s.timestamp,
      })),
      exportedAt: wallClock(),
    }
    await this._storage.write( path, JSON.stringify( output ) )
  }

  /**
   * Get the number of in-memory snapshots.
   */
  get snapshotCount(): number {
    return this._snapshots.length
  }

  // ── Restore from storage ──────────────────────────────────

  /**
   * Load the most recently persisted snapshot from the storage adapter and
   * deserialize it into a live SimulationState, ready for StateManager.restore().
   *
   * Returns undefined when no snapshot has been persisted yet (first boot).
   *
   * Works with any StorageAdapter — BunStorageAdapter (filesystem) or
   * PostgresStorageAdapter (Postgres). The sentinel file `latest.json` is written
   * alongside each snapshot so we can locate the most recent one without scanning.
   */
  async loadLatestFromStorage(): Promise<SimulationState | undefined> {
    if( this._config.persistInterval === 0 ) return undefined

    const sentinelPath = `${this._config.persistPath}/latest.json`
    try {
      const exists = await this._storage.exists( sentinelPath )
      if( !exists ) return undefined

      const raw     = await this._storage.read( sentinelPath )
      const { path } = JSON.parse( raw ) as { path: string; tick: number }

      const snapExists = await this._storage.exists( path )
      if( !snapExists ) return undefined

      const snapRaw = await this._storage.read( path )
      const parsed  = JSON.parse( snapRaw ) as SerializedState
      return this._serializer.deserialize( JSON.stringify( parsed ) )
    }
    catch( err ){
      logger.warn(`[SnapshotManager] Could not load latest snapshot:`, err )
      return undefined
    }
  }

  /**
   * Force an immediate snapshot of `state` and persist it to disk.
   *
   * Called at session end (pauseWill / archiveWill) to guarantee the latest
   * simulation state — including freshly-flushed episodic memories — is
   * written to disk even if the scheduled persist interval has not elapsed.
   *
   * Unlike the normal onTick path, this does NOT push an entry into the
   * in-memory ring buffer (no replay entry needed for a shutdown snapshot)
   * and does NOT advance the delta baseline (`_prevState`; no more ticks will follow).
   *
   * No-op when persistInterval === 0 (disk persistence disabled).
   */
  async persistNow( state: ReadonlySimulationState ): Promise<void> {
    if( this._config.persistInterval === 0 ) return

    const serialized = this._serializer.serialize(
      state as unknown as SimulationState,
      'json'
    ) as string

    const parsed = JSON.parse( serialized ) as SerializedState
    const entry: SnapshotEntry = {
      tick:      this._currentTick,
      state:     parsed,
      delta:     undefined,
      timestamp: wallClock(),
    }

    await this._persistSnapshot( entry )
  }

  // ── Internal ─────────────────────────────────────────────

  private async _persistSnapshot( entry: SnapshotEntry ): Promise<void> {
    const path = `${this._config.persistPath}/snapshot-${String( entry.tick ).padStart( 8, '0')}.json`
    await this._storage.write( path, JSON.stringify( entry.state ) )

    // Write a sentinel so loadLatestFromStorage() can find this snapshot on restart.
    const sentinelPath = `${this._config.persistPath}/latest.json`
    await this._storage.write( sentinelPath, JSON.stringify({ path, tick: entry.tick }) )
  }
}
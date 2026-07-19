// ─────────────────────────────────────────────────────────────
// src/core/state.manager.ts
// ─────────────────────────────────────────────────────────────

import type { SimulationEntity, EntityInput, SimulationState, StateCommands, Tick, Timestamp, RestoreOptions } from '#core/types'
import { deepFreeze } from '#core/utils'

/**
 * Whether entities are deep-frozen on write (R3). Enforcing the read-only
 * contract at runtime costs a recursive freeze per write, so it is on
 * everywhere *except* production — dev, test and CI catch any illegal mutation
 * loudly, and production runs the exact code paths those caught. Override
 * explicitly with `WILL_FREEZE_STATE` (`1`/`true` to force on, `0`/`false` off).
 */
function resolveFreezeState(): boolean {
  const flag = process.env.WILL_FREEZE_STATE
  if( flag !== undefined && flag !== '')
    return flag !== '0' && flag.toLowerCase() !== 'false'
  return process.env.NODE_ENV !== 'production'
}

export interface StateManager {
  readonly currentTick: Tick
  readonly currentTime: Timestamp

  updateClock( tick: Tick, time: Timestamp ): void

  getEntity<T extends SimulationEntity>( id: string ): T | undefined
  setEntity( entity: EntityInput ): void
  deleteEntity( id: string ): boolean
  getAllEntities(): IterableIterator<SimulationEntity>

  /** O(1) — backed by an internal type index */
  getEntitiesByType( type: string ): SimulationEntity[]

  getMetric( key: string ): number | undefined
  setMetric( key: string, value: number ): void
  incrementMetric( key: string, delta?: number ): number

  /**
   * Apply a batch of commands atomically.
   * Called by the Orchestrator after all engines have returned their
   * EngineResult for a tick (double-buffer commit phase).
   */
  applyCommands( commands: StateCommands ): void

  snapshot(): SimulationState
  /**
   * Accepts optional RestoreOptions for partial
   * restore. Use { entities: true, metrics: false } to rewind entity
   * state while preserving metric counters.
   */
  restore( snapshot: SimulationState, options?: RestoreOptions ): void
  clear(): void
}

export class DefaultStateManager implements StateManager {
  private _entities   = new Map<string, SimulationEntity>()
  private _metrics    = new Map<string, number>()
  private _typeIndex  = new Map<string, Set<string>>()  // type → entity ids
  private _tick: Tick = 0
  private _time: Timestamp = 0

  /**
   * Copy-on-write guard (R3-b / FIX F8). A handed-out snapshot shares the live
   * `_entities` / `_metrics` map by reference instead of being eagerly copied;
   * these flags mark a map as still observed by an outstanding snapshot. The
   * NEXT mutation clones that map once (see _ownEntities / _ownMetrics) before
   * writing, so the snapshot keeps its point-in-time values. This turns
   * snapshot() into O(1) and collapses the per-tick double copy (pre- + post-
   * commit) into a single clone on the first write — and zero clones on an
   * idle tick or a read-only snapshot consumer. Entities are deep-frozen on
   * write (R3-a), so sharing a reference can never leak a mutable value.
   */
  private _entitiesShared = false
  private _metricsShared  = false

  /**
   * When true, every entity stored is deep-frozen so the read-only snapshot
   * contract (R3) is enforced at runtime, not just in the type system.
   * Resolved once per manager from the environment — see resolveFreezeState.
   */
  private readonly _freeze = resolveFreezeState()

  get currentTick(): Tick      { return this._tick }
  get currentTime(): Timestamp { return this._time }

  updateClock( tick: Tick, time: Timestamp ): void {
    this._tick = tick
    this._time = time
  }

  // ── Entity CRUD ──────────────────────────────────────────

  getEntity<T extends SimulationEntity>( id: string ): T | undefined {
    return this._entities.get( id ) as T | undefined
  }

  setEntity( entity: EntityInput ): void {
    const
    existing = this._entities.get( entity.id ),
    // Sim clock time (fed each tick by updateClock), NOT wall time — this is the
    // single place every entity's createdAt/updatedAt is stamped, so sourcing it
    // from the sim clock makes all entity timestamps deterministic on replay (R2).
    now      = this._time

    // Maintain type index — handle type changes
    if( existing && existing.type !== entity.type )
      this._typeIndex.get( existing.type )?.delete( entity.id )

    if( !this._typeIndex.has( entity.type ) )
      this._typeIndex.set( entity.type, new Set() )

    this._typeIndex.get( entity.type )!.add( entity.id )

    // A fresh object every write — setEntity never mutates an existing entity
    // in place. Combined with the copy-on-write clone below, the live map only
    // ever changes by slot replacement on a map no snapshot still observes.
    const stored: SimulationEntity = {
      ...entity,
      createdAt:     existing?.createdAt ?? entity.createdAt ?? now,
      updatedAt:     now,
      updatedAtTick: this._tick,
    }

    // CoW: clone the map once if a snapshot still references it, so this write
    // can't reach back and mutate that point-in-time view (R3-b / FIX F8).
    this._ownEntities()

    // Freeze so anything that later reads this entity (engine snapshots, stored
    // rollback snapshots) cannot mutate it and silently corrupt determinism (R3).
    this._entities.set( entity.id, this._freeze ? deepFreeze( stored ) : stored )
  }

  deleteEntity( id: string ): boolean {
    const existing = this._entities.get( id )
    if( !existing ) return false

    this._typeIndex.get( existing.type )?.delete( id )
    // CoW: clone before removing the slot so an outstanding snapshot still
    // sees the entity (R3-b / FIX F8).
    this._ownEntities()
    return this._entities.delete( id )
  }

  getAllEntities(): IterableIterator<SimulationEntity> {
    return this._entities.values()
  }

  getEntitiesByType( type: string ): SimulationEntity[] {
    const ids = this._typeIndex.get( type )
    if( !ids ) return []

    const result: SimulationEntity[] = []
    for( const id of ids ){
      const entity = this._entities.get( id )
      entity && result.push( entity )
    }

    return result
  }

  // ── Metrics ──────────────────────────────────────────────

  getMetric( key: string ): number | undefined {
    return this._metrics.get( key )
  }

  setMetric( key: string, value: number ): void {
    this._ownMetrics()
    this._metrics.set( key, value )
  }

  incrementMetric( key: string, delta: number = 1 ): number {
    const next = ( this._metrics.get( key ) ?? 0 ) + delta
    this._ownMetrics()
    this._metrics.set( key, next )
    return next
  }

  // ── Command application (double-buffer commit) ───────────

  applyCommands( commands: StateCommands ): void {
    if( commands.set )
      for( const entity of commands.set )
        this.setEntity( entity )

    if( commands.delete )
      for( const id of commands.delete )
        this.deleteEntity( id )

    if( commands.metrics )
      for( const [ key, value ] of commands.metrics )
        typeof value === 'number'
          ? this.setMetric( key, value )
          : this.incrementMetric( key, ( value as { delta: number } ).delta )
  }

  // ── Snapshot / restore ───────────────────────────────────

  snapshot(): SimulationState {
    // Copy-on-write (R3-b / FIX F8): hand out the live maps by reference and
    // mark them shared instead of eagerly cloning. The next mutation clones
    // before writing (_ownEntities / _ownMetrics), so this snapshot stays a
    // genuine point-in-time view. Callers must treat it as read-only — the
    // ReadonlySimulationState type enforces that for the per-tick consumers,
    // and no code mutates a snapshot's maps directly.
    this._entitiesShared = true
    this._metricsShared  = true
    return {
      tick:     this._tick,
      time:     this._time,
      entities: this._entities,
      metrics:  this._metrics,
    }
  }

  /** CoW: clone `_entities` once if an outstanding snapshot still shares it. */
  private _ownEntities(): void {
    if( !this._entitiesShared ) return
    this._entities = new Map( this._entities )
    this._entitiesShared = false
  }

  /** CoW: clone `_metrics` once if an outstanding snapshot still shares it. */
  private _ownMetrics(): void {
    if( !this._metricsShared ) return
    this._metrics = new Map( this._metrics )
    this._metricsShared = false
  }

  /**
   * Allows selective rollback of entities, metrics, or clock state.
   * Default behavior (no options) is full restore — backward compatible.
   */
  restore( snapshot: SimulationState, options: RestoreOptions = {} ): void {
    const restoreEntities = options.entities ?? true
    const restoreMetrics  = options.metrics  ?? true
    const restoreClock    = options.clock    ?? true

    if( restoreClock ){
      this._tick = snapshot.tick
      this._time = snapshot.time
    }

    if( restoreEntities ){
      // Fresh map the manager owns outright — clear any CoW share (R3-b).
      this._entities = new Map( snapshot.entities )
      this._entitiesShared = false

      // Rebuild type index from restored entities
      this._typeIndex.clear()
      for( const entity of this._entities.values() ){
        // Restored entities may be fresh (e.g. deserialized from disk) and thus
        // unfrozen — re-establish the R3 immutability guarantee. Idempotent for
        // entities that came from an already-frozen in-process snapshot.
        if( this._freeze ) deepFreeze( entity )

        if( !this._typeIndex.has( entity.type ) )
          this._typeIndex.set( entity.type, new Set() )

        this._typeIndex.get( entity.type )!.add( entity.id )
      }
    }

    if( restoreMetrics ){
      this._metrics = new Map( snapshot.metrics )
      this._metricsShared = false
    }
  }

  clear(): void {
    // Replace (not .clear()) the maps: an outstanding snapshot may still share
    // them under CoW, and emptying them in place would wipe that view (R3-b).
    this._entities = new Map()
    this._metrics  = new Map()
    this._entitiesShared = false
    this._metricsShared  = false
    this._typeIndex.clear()
    this._tick = 0
    this._time = 0
  }
}
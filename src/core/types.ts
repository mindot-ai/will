// ─────────────────────────────────────────────────────────────
// src/core/types.ts
// ─────────────────────────────────────────────────────────────

/**
 * Core simulation framework types — completely generic.
 * No logistics, mobility, or domain concepts here.
 */

export type Timestamp = number  // milliseconds since epoch
export type Duration  = number  // milliseconds
export type Tick      = number  // discrete simulation step

export interface Coordinates {
  x: number
  y: number
  z?: number
}

// ── PRNG ─────────────────────────────────────────────────────

/**
 * Seeded pseudo-random number generator (Mulberry32).
 * Provides deterministic randomness for simulation replay.
 * All engines should draw from SimulationContext.prng rather
 * than Math.random() to guarantee replay fidelity.
 */

export interface SeededPRNG {
  /** Returns a float in [0, 1) */
  next(): number
  /** Returns an integer in [min, max) */
  nextInt( min: number, max: number ): number
  /** Returns true with the given probability (default 0.5) */
  nextBool( probability?: number ): boolean
  /** Current internal seed state — useful for snapshotting */
  readonly state: number
}

// ── Deep readonly utility ────────────────────────────────────

/**
 * Recursively marks every property, Map, Set, and Array as readonly.
 * Used to enforce the double-buffer contract: engines receive a frozen
 * snapshot and may only produce changes via StateCommands.
 */
export type ReadonlyDeep<T> =
  T extends ( infer U )[]
    ? ReadonlyArray<ReadonlyDeep<U>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<K, ReadonlyDeep<V>>
      : T extends Set<infer U>
        ? ReadonlySet<ReadonlyDeep<U>>
        : T extends object
          ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
          : T

// ── Event type system (discriminated union) ──────────────────

/**
 * Base interface that all simulation events extend.
 * The 'type' field acts as a discriminated union key.
 */
export interface SimulationEventBase {
  id: string
  type: string
  timestamp: Timestamp
  tick: Tick
  source: string
}

/**
 * Typed simulation event with payload and metadata.
 * T = payload type, M = metadata type.
 */
export interface SimulationEvent<T = unknown, M = Record<string, unknown>> extends SimulationEventBase {
  payload: T
  metadata?: M
}

/**
 * Helper to extract payload type from a specific event type string.
 * Usage: type MyPayload = EventPayload<'entity.created'>
 */
export type EventPayload<
  T extends string,
  E extends SimulationEvent = SimulationEvent
> = E extends { type: T; payload: infer P } ? P : never

// ── Core domain types ────────────────────────────────────────

export interface SimulationContext {
  simulationId: string
  runId: string
  tags: Record<string, string>
  /**
   * Seeded PRNG for deterministic randomness.
   * Engines must use this instead of Math.random() to guarantee
   * that a run is fully reproducible from the same seed.
   */
  prng: SeededPRNG
}

export interface SimulationEntity {
  id: string
  type: string
  createdAt: Timestamp
  updatedAt: Timestamp
  /**
   * Sim tick of the last write (stamped by StateManager.setEntity).
   * Distinct from `updatedAt` (wall-clock epoch ms). ConflictDetector compares
   * this tick-vs-tick against a footprint's `tickObserved`; comparing `updatedAt`
   * (ms) to a tick would always register a conflict.
   */
  updatedAtTick?: Tick
  metadata?: Record<string, unknown>
}

/**
 * The write-side shape engines produce for an entity (via StateCommands.set or
 * a direct setEntity call). `createdAt`/`updatedAt`/`updatedAtTick` are optional
 * because StateManager.setEntity is the single authority that stamps them from
 * the sim clock — engines must not supply wall-clock timestamps, which would
 * break replay (R2). A full SimulationEntity is assignable to EntityInput, so
 * existing callers that pass complete entities keep working.
 */
export type EntityInput =
  Omit<SimulationEntity, 'createdAt' | 'updatedAt' | 'updatedAtTick'>
  & Partial<Pick<SimulationEntity, 'createdAt' | 'updatedAt' | 'updatedAtTick'>>

export interface SimulationState {
  tick: Tick
  time: Timestamp
  entities: Map<string, SimulationEntity>
  metrics: Map<string, number>
}

/**
 * Configuration for partial state restore operations.
 * Support selective rollback — entities only,
 * metrics only, or clock state independently.
 */
export interface RestoreOptions {
  /** Restore entity state (default: true) */
  entities?: boolean
  /** Restore metric values (default: true) */
  metrics?: boolean
  /** Restore clock tick and time (default: true) */
  clock?: boolean
}

/**
 * The frozen view of SimulationState passed to engines each tick.
 * Engines read from this; writes go through StateCommands only.
 */
export type ReadonlySimulationState = ReadonlyDeep<SimulationState>

/**
 * The write side of the double-buffer contract.
 * Engines return this from react() instead of mutating state directly.
 * All commands from all engines are applied atomically after every engine
 * has finished reading the frozen snapshot.
 *
 * metrics entries are either:
 *   [key, number]           — set the metric to an absolute value
 *   [key, { delta: number }] — increment by delta (positive or negative)
 */
export interface StateCommands {
  set?:     EntityInput[]
  delete?:  string[]
  metrics?: Array<[ string, number]>
}

// Used by orchestrator for step/run methods
export interface MinimalContext {
  simulationId: string
  runId: string
  seed?: number
}

// ── Async Reasoning Types ─────────────────────────────────────

/**
 * Captures what an async engine observed when it began reasoning.
 * Used by ConflictDetector to validate that the world hasn't changed
 * in ways that invalidate the engine's intended commands.
 */
export interface ReasoningFootprint {
  /** The tick when the engine read its snapshot */
  readonly tickObserved: Tick
  /** Entity IDs the engine read during reasoning */
  readonly entitiesRead: ReadonlySet<string>
  /** Metric keys the engine read during reasoning */
  readonly metricsRead: ReadonlySet<string>
  /** Entity IDs the engine intends to modify */
  readonly entitiesModified: ReadonlySet<string>
  /** The commands the engine wants to apply */
  readonly intendedCommands: StateCommands
  /** Optional: engine that produced this footprint (for debugging) */
  readonly source?: string
}

export interface ConflictReport {
  /** Whether any conflicts were detected */
  readonly hasConflicts: boolean
  /** Read conflicts: entities/metrics observed that have since changed */
  readonly readConflicts: string[]
  /** Write conflicts: entities the engine wants to modify that others modified */
  readonly writeConflicts: string[]
  /** The tick when conflict detection ran */
  readonly detectedAtTick: Tick
  /** The footprint that was checked */
  readonly footprint: ReasoningFootprint
}

export type ConflictStrategy = 'REJECT' | 'MERGE' | 'FORCE'

export interface ConflictResolution {
  /** The strategy used to resolve conflicts */
  readonly strategy: ConflictStrategy
  /** If MERGE, the subset of commands that passed validation */
  readonly resolvedCommands: StateCommands | null
  /** If REJECT, whether to re-run the engine with current state */
  readonly shouldRerun: boolean
  /** Human-readable explanation of what happened */
  readonly reason: string
}

/**
 * Configuration for async engine behavior within the orchestrator.
 */
export interface AsyncEngineConfig {
  /** Default conflict strategy for this engine */
  readonly defaultStrategy?: ConflictStrategy
  /** Maximum ticks a reasoning can be pending before being auto-rejected */
  readonly maxPendingTicks?: number
  /** Whether to log conflict details for debugging */
  readonly logConflicts?: boolean
  /** Re-run on rejection (if false, commands are silently dropped) */
  readonly rerunOnRejection?: boolean
}

// ── Homeostatic Types ──────────────────────────────────────────

/**
 * A homeostatic drive signal emitted by regulatory engines.
 * Drives represent survival-relevant needs that demand attention.
 */
export interface DriveSignal {
  /** Drive name (e.g., 'energy', 'sleep', 'safety') */
  readonly name: string
  /** Current intensity 0-1 (0 = satisfied, 1 = critically deprived) */
  readonly intensity: number
  /** How quickly this is escalating 0-1 (0 = stable, 1 = rapidly worsening) */
  readonly urgency: number
  /** The engine that produced this signal */
  readonly source: string
}

/**
 * A modulation signal that adjusts parameters in other engines.
 * Regulatory engines emit these to tune cognitive function based
 * on homeostatic state (e.g., high sleep pressure degrades attention).
 */
export interface ModulationSignal {
  /** Target engine name (or '*' for all engines) */
  readonly target: string
  /** Parameter to modulate */
  readonly parameter: string
  /** Multiplier to apply (1.0 = no change, 0.5 = halved, 2.0 = doubled) */
  readonly factor: number
  /** The engine that produced this signal */
  readonly source: string
}
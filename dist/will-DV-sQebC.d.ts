/**
 * Core simulation framework types — completely generic.
 * No logistics, mobility, or domain concepts here.
 */
type Timestamp = number;
type Duration = number;
type Tick = number;
interface Coordinates {
    x: number;
    y: number;
    z?: number;
}
/**
 * Seeded pseudo-random number generator (Mulberry32).
 * Provides deterministic randomness for simulation replay.
 * All engines should draw from SimulationContext.prng rather
 * than Math.random() to guarantee replay fidelity.
 */
interface SeededPRNG {
    /** Returns a float in [0, 1) */
    next(): number;
    /** Returns an integer in [min, max) */
    nextInt(min: number, max: number): number;
    /** Returns true with the given probability (default 0.5) */
    nextBool(probability?: number): boolean;
    /** Current internal seed state — useful for snapshotting */
    readonly state: number;
}
/**
 * Recursively marks every property, Map, Set, and Array as readonly.
 * Used to enforce the double-buffer contract: engines receive a frozen
 * snapshot and may only produce changes via StateCommands.
 */
type ReadonlyDeep<T> = T extends (infer U)[] ? ReadonlyArray<ReadonlyDeep<U>> : T extends Map<infer K, infer V> ? ReadonlyMap<K, ReadonlyDeep<V>> : T extends Set<infer U> ? ReadonlySet<ReadonlyDeep<U>> : T extends object ? {
    readonly [K in keyof T]: ReadonlyDeep<T[K]>;
} : T;
/**
 * Base interface that all simulation events extend.
 * The 'type' field acts as a discriminated union key.
 */
interface SimulationEventBase {
    id: string;
    type: string;
    timestamp: Timestamp;
    tick: Tick;
    source: string;
}
/**
 * Typed simulation event with payload and metadata.
 * T = payload type, M = metadata type.
 */
interface SimulationEvent<T = unknown, M = Record<string, unknown>> extends SimulationEventBase {
    payload: T;
    metadata?: M;
}
/**
 * Helper to extract payload type from a specific event type string.
 * Usage: type MyPayload = EventPayload<'entity.created'>
 */
type EventPayload<T extends string, E extends SimulationEvent = SimulationEvent> = E extends {
    type: T;
    payload: infer P;
} ? P : never;
interface SimulationContext {
    simulationId: string;
    runId: string;
    tags: Record<string, string>;
    /**
     * Seeded PRNG for deterministic randomness.
     * Engines must use this instead of Math.random() to guarantee
     * that a run is fully reproducible from the same seed.
     */
    prng: SeededPRNG;
}
interface SimulationEntity {
    id: string;
    type: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    /**
     * Sim tick of the last write (stamped by StateManager.setEntity).
     * Distinct from `updatedAt` (wall-clock epoch ms). ConflictDetector compares
     * this tick-vs-tick against a footprint's `tickObserved`; comparing `updatedAt`
     * (ms) to a tick would always register a conflict.
     */
    updatedAtTick?: Tick;
    metadata?: Record<string, unknown>;
}
/**
 * The write-side shape engines produce for an entity (via StateCommands.set or
 * a direct setEntity call). `createdAt`/`updatedAt`/`updatedAtTick` are optional
 * because StateManager.setEntity is the single authority that stamps them from
 * the sim clock — engines must not supply wall-clock timestamps, which would
 * break replay (R2). A full SimulationEntity is assignable to EntityInput, so
 * existing callers that pass complete entities keep working.
 */
type EntityInput = Omit<SimulationEntity, 'createdAt' | 'updatedAt' | 'updatedAtTick'> & Partial<Pick<SimulationEntity, 'createdAt' | 'updatedAt' | 'updatedAtTick'>>;
interface SimulationState {
    tick: Tick;
    time: Timestamp;
    entities: Map<string, SimulationEntity>;
    metrics: Map<string, number>;
}
/**
 * Configuration for partial state restore operations.
 * Support selective rollback — entities only,
 * metrics only, or clock state independently.
 */
interface RestoreOptions {
    /** Restore entity state (default: true) */
    entities?: boolean;
    /** Restore metric values (default: true) */
    metrics?: boolean;
    /** Restore clock tick and time (default: true) */
    clock?: boolean;
}
/**
 * The frozen view of SimulationState passed to engines each tick.
 * Engines read from this; writes go through StateCommands only.
 */
type ReadonlySimulationState = ReadonlyDeep<SimulationState>;
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
interface StateCommands {
    set?: EntityInput[];
    delete?: string[];
    metrics?: Array<[string, number]>;
}
interface MinimalContext {
    simulationId: string;
    runId: string;
    seed?: number;
}
/**
 * Captures what an async engine observed when it began reasoning.
 * Used by ConflictDetector to validate that the world hasn't changed
 * in ways that invalidate the engine's intended commands.
 */
interface ReasoningFootprint {
    /** The tick when the engine read its snapshot */
    readonly tickObserved: Tick;
    /** Entity IDs the engine read during reasoning */
    readonly entitiesRead: ReadonlySet<string>;
    /** Metric keys the engine read during reasoning */
    readonly metricsRead: ReadonlySet<string>;
    /** Entity IDs the engine intends to modify */
    readonly entitiesModified: ReadonlySet<string>;
    /** The commands the engine wants to apply */
    readonly intendedCommands: StateCommands;
    /** Optional: engine that produced this footprint (for debugging) */
    readonly source?: string;
}
interface ConflictReport {
    /** Whether any conflicts were detected */
    readonly hasConflicts: boolean;
    /** Read conflicts: entities/metrics observed that have since changed */
    readonly readConflicts: string[];
    /** Write conflicts: entities the engine wants to modify that others modified */
    readonly writeConflicts: string[];
    /** The tick when conflict detection ran */
    readonly detectedAtTick: Tick;
    /** The footprint that was checked */
    readonly footprint: ReasoningFootprint;
}
type ConflictStrategy = 'REJECT' | 'MERGE' | 'FORCE';
interface ConflictResolution {
    /** The strategy used to resolve conflicts */
    readonly strategy: ConflictStrategy;
    /** If MERGE, the subset of commands that passed validation */
    readonly resolvedCommands: StateCommands | null;
    /** If REJECT, whether to re-run the engine with current state */
    readonly shouldRerun: boolean;
    /** Human-readable explanation of what happened */
    readonly reason: string;
}
/**
 * Configuration for async engine behavior within the orchestrator.
 */
interface AsyncEngineConfig {
    /** Default conflict strategy for this engine */
    readonly defaultStrategy?: ConflictStrategy;
    /** Maximum ticks a reasoning can be pending before being auto-rejected */
    readonly maxPendingTicks?: number;
    /** Whether to log conflict details for debugging */
    readonly logConflicts?: boolean;
    /** Re-run on rejection (if false, commands are silently dropped) */
    readonly rerunOnRejection?: boolean;
}

/**
 * Core simulation clock — completely generic.
 * No time-of-day, calendar, or domain-specific logic.
 * Time is just milliseconds since epoch.
 */

interface SimulationClock {
    readonly now: Timestamp;
    readonly currentTick: Tick;
    readonly delta: Duration;
    readonly isRunning: boolean;
    readonly multiplier: number;
    tick(): void;
    pause(): void;
    resume(): void;
    reset(): void;
    setTime(time: Timestamp): void;
    setTick(tick: Tick): void;
    setMultiplier(newMultiplier: number): void;
    toSimMs(wallMs: number): number;
    toWallMs(simMs: number): number;
    simSleep(simMs: number): Promise<void>;
}
interface ClockConfig {
    startTime?: Timestamp;
    startTick?: Tick;
    timeScale?: number;
    /** When set, tick() uses this fixed duration (ms) instead of wall time. */
    fixedDeltaMs?: number;
}
declare class DefaultSimulationClock implements SimulationClock {
    private _now;
    private _tick;
    private _delta;
    private _lastTick;
    private _isRunning;
    private _timeScale;
    private _pausedAt;
    private _fixedDeltaMs;
    private _startWallMs;
    private _startSimMs;
    constructor(config?: ClockConfig);
    get now(): Timestamp;
    get currentTick(): Tick;
    get delta(): Duration;
    get isRunning(): boolean;
    get multiplier(): number;
    /**
     * The Orchestrator calls this once per tick as the single
     * source of tick advancement.
     */
    tick(): void;
    pause(): void;
    resume(): void;
    reset(): void;
    setTime(time: Timestamp): void;
    setTick(tick: Tick): void;
    setMultiplier(newMultiplier: number): void;
    toSimMs(wallMs: number): number;
    toWallMs(simMs: number): number;
    simSleep(simMs: number): Promise<void>;
}

type EventHandler<T = unknown> = (event: SimulationEvent<T>, context: SimulationContext) => void | Promise<void>;
type EventFilter = (event: SimulationEventBase) => boolean;
interface EventBus {
    /**
     * Enqueue an event for dispatch at end of the current tick.
     * Prevents silent corruption from events stamped with tick 0.
     * Callers must explicitly pass the current tick from the orchestrator.
     */
    publish<T>(event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext, tick: Tick): void;
    /**
     * Enqueue and immediately flush if the queue is below the sync threshold.
     * Useful outside of a managed tick loop.
     */
    publishAsync<T>(event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext, tick: Tick): Promise<void>;
    /**
     * Schedule an event to be injected into the pending queue at a future tick.
     * The Orchestrator calls prepareTick() each tick to drain due events.
     */
    scheduleAt<T>(scheduledTick: Tick, event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext): void;
    /**
     * Move all scheduled events whose tick ≤ currentTick into the pending queue.
     * Called by the Orchestrator at the start of each tick, before engines run.
     */
    prepareTick(currentTick: Tick): void;
    /**
     * Drain and dispatch all pending events synchronously (within the current
     * async frame).  Called by the Orchestrator at end of each tick, after all
     * commands have been applied.
     */
    flush(): Promise<void>;
    subscribe<T>(eventType: string, handler: EventHandler<T>): () => void;
    subscribeFiltered(filter: EventFilter, handler: EventHandler): () => void;
    subscribeAll(handler: EventHandler): () => void;
    clear(): void;
    getPendingCount(): number;
}
interface EventBusConfig {
    maxQueueSize?: number;
    syncThreshold?: number;
    /**
     * Sim-time source for event timestamps. Events land in the event log, so the
     * timestamp must come from the sim clock (not wall time) for replay fidelity
     * (R2). Defaults to `wallClock` for standalone/non-orchestrated use; the
     * Simulation wires this to `clock.now`.
     */
    now?: () => Timestamp;
}
declare class DefaultEventBus implements EventBus {
    private _handlers;
    private _filteredHandlers;
    private _allHandlers;
    private _pendingEvents;
    private _scheduledEvents;
    private _isProcessing;
    private _maxQueueSize;
    private _syncThreshold;
    private _now;
    private _eventSeq;
    constructor(config?: EventBusConfig);
    /**
     * Events are always stamped with the caller-provided tick
     * to prevent default-to-zero bugs.
     */
    publish<T>(event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext, tick: Tick): void;
    publishAsync<T>(event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext, tick: Tick): Promise<void>;
    private _stamp;
    private _enqueue;
    scheduleAt<T>(scheduledTick: Tick, event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>, context: SimulationContext): void;
    prepareTick(currentTick: Tick): void;
    flush(): Promise<void>;
    /**
     * Background processing — triggered via setImmediate for standalone use.
     * Silently swallows errors to avoid unhandled-rejection noise in that path.
     */
    private _processBackground;
    private _process;
    private _dispatch;
    subscribe<T>(eventType: string, handler: EventHandler<T>): () => void;
    subscribeFiltered(filter: EventFilter, handler: EventHandler): () => void;
    subscribeAll(handler: EventHandler): () => void;
    clear(): void;
    getPendingCount(): number;
}

interface StateManager {
    readonly currentTick: Tick;
    readonly currentTime: Timestamp;
    updateClock(tick: Tick, time: Timestamp): void;
    getEntity<T extends SimulationEntity>(id: string): T | undefined;
    setEntity(entity: EntityInput): void;
    deleteEntity(id: string): boolean;
    getAllEntities(): IterableIterator<SimulationEntity>;
    /** O(1) — backed by an internal type index */
    getEntitiesByType(type: string): SimulationEntity[];
    getMetric(key: string): number | undefined;
    setMetric(key: string, value: number): void;
    incrementMetric(key: string, delta?: number): number;
    /**
     * Apply a batch of commands atomically.
     * Called by the Orchestrator after all engines have returned their
     * EngineResult for a tick (double-buffer commit phase).
     */
    applyCommands(commands: StateCommands): void;
    snapshot(): SimulationState;
    /**
     * Accepts optional RestoreOptions for partial
     * restore. Use { entities: true, metrics: false } to rewind entity
     * state while preserving metric counters.
     */
    restore(snapshot: SimulationState, options?: RestoreOptions): void;
    clear(): void;
}
declare class DefaultStateManager implements StateManager {
    private _entities;
    private _metrics;
    private _typeIndex;
    private _tick;
    private _time;
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
    private _entitiesShared;
    private _metricsShared;
    /**
     * When true, every entity stored is deep-frozen so the read-only snapshot
     * contract (R3) is enforced at runtime, not just in the type system.
     * Resolved once per manager from the environment — see resolveFreezeState.
     */
    private readonly _freeze;
    get currentTick(): Tick;
    get currentTime(): Timestamp;
    updateClock(tick: Tick, time: Timestamp): void;
    getEntity<T extends SimulationEntity>(id: string): T | undefined;
    setEntity(entity: EntityInput): void;
    deleteEntity(id: string): boolean;
    getAllEntities(): IterableIterator<SimulationEntity>;
    getEntitiesByType(type: string): SimulationEntity[];
    getMetric(key: string): number | undefined;
    setMetric(key: string, value: number): void;
    incrementMetric(key: string, delta?: number): number;
    applyCommands(commands: StateCommands): void;
    snapshot(): SimulationState;
    /** CoW: clone `_entities` once if an outstanding snapshot still shares it. */
    private _ownEntities;
    /** CoW: clone `_metrics` once if an outstanding snapshot still shares it. */
    private _ownMetrics;
    /**
     * Allows selective rollback of entities, metrics, or clock state.
     * Default behavior (no options) is full restore — backward compatible.
     */
    restore(snapshot: SimulationState, options?: RestoreOptions): void;
    clear(): void;
}

/**
 * What an engine returns from react().
 * Events and commands are collected from all engines, then applied
 * atomically — no engine sees another engine's writes from the same tick.
 */
interface EngineResult {
    /** Events to publish after commands are applied. tick is stamped by Orchestrator. */
    events?: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>>;
    /** State mutations to apply after all engines have finished reading. */
    commands?: StateCommands;
}
interface SimulationEngine {
    readonly name: string;
    /**
     * Called once per tick with a frozen read-only snapshot.
     * Engines must NOT mutate state directly — return commands instead.
     * Omit entirely on purely event-driven engines — the orchestrator skips them.
     */
    react?(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Called when this engine's react() throws. Allows the orchestrator
     * to isolate engine failures without crashing the entire tick.
     *
     * Return EngineResult to provide fallback commands/events,
     * or return null to skip this engine's contribution for this tick.
     * If not provided, the error propagates (old behavior).
     */
    onError?(error: Error, tick: Tick, context: SimulationContext): Promise<EngineResult | null>;
    onAttach?(state: StateManager, context: SimulationContext): Promise<void>;
    onDetach?(state: StateManager, context: SimulationContext): Promise<void>;
}
type TickMiddleware = (tick: Tick, state: ReadonlySimulationState, context: SimulationContext) => void | Promise<void>;
/**
 * Pre-commit validator signature.
 * Receives all pending commands for the current tick.
 * Return string[] of validation errors to abort the commit,
 * or void/true to proceed.
 */
type CommitValidator = (commands: StateCommands[], tick: Tick, context: SimulationContext) => string[] | true | void | Promise<string[] | true | void>;
interface OrchestratorConfig {
    tickIntervalMs?: number;
    maxTicks?: number;
    maxRealTimeMs?: number;
    /**
     * Stop the loop when the event bus is empty AND no engine produced
     * events or state commands in the last tick.
     */
    stopOnEmptyEvents?: boolean;
    idleThresholdMs?: number;
    /** Fired before engines run — receives the frozen pre-tick snapshot. */
    onBeforeTick?: TickMiddleware | TickMiddleware[];
    /** Fired after commands are applied and events are flushed. */
    onAfterTick?: TickMiddleware | TickMiddleware[];
    /**
     * Pre-commit validation hooks. Called after engines run but
     * before commands are applied. Receives all pending commands.
     * All validators must pass — if any returns string[], the commit
     * is aborted and events are not published for this tick.
     */
    onBeforeCommit?: CommitValidator[];
}
interface Orchestrator {
    readonly isRunning: boolean;
    readonly currentTick: Tick;
    /**
     * Register an onAfterTick handler. Multiple handlers can be registered
     * and all will be called in registration order after each tick.
     * Returns an unsubscribe function.
     */
    onAfterTick(handler: TickMiddleware): () => void;
    /** Register an onBeforeTick handler. Returns unsubscribe function. */
    onBeforeTick(handler: TickMiddleware): () => void;
    /** Register a pre-commit validator. All validators must pass. Returns unsubscribe function. */
    onBeforeCommit(validator: CommitValidator): () => void;
    /**
     * Update non-middleware config fields at runtime.
     * Accepts a partial config — only provided fields are changed.
     * undefined values are ignored.
     *
     * NOTE: Does NOT accept onBeforeTick/onAfterTick/onBeforeCommit.
     * Use the dedicated registration methods for middleware.
     */
    updateConfig(config: Partial<Omit<OrchestratorConfig, 'onBeforeTick' | 'onAfterTick' | 'onBeforeCommit'>>): void;
    addEngine(engine: SimulationEngine): void;
    removeEngine(name: string): boolean;
    hasPendingAsyncWork(): boolean;
    /** Engine names in execution order (assembly-order snapshot artifact). */
    readonly engineNames: string[];
    /** Registered engine instances, execution-ordered (assembly wiring audit). */
    readonly engines: readonly SimulationEngine[];
    start(context: SimulationContext): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
    step(count?: number, context?: MinimalContext): Promise<void>;
    runUntilTick(targetTick: Tick, context?: MinimalContext): Promise<void>;
    runUntilTime(targetTime: number, context?: MinimalContext): Promise<void>;
}
declare class DefaultOrchestrator implements Orchestrator {
    protected _engines: SimulationEngine[];
    /** Override in subclasses to control which engines participate in the tick loop. */
    protected _enginesTick(): SimulationEngine[];
    private _isRunning;
    private _isPaused;
    private _shouldStop;
    private _currentTick;
    private _clock;
    private _eventBus;
    protected _stateManager: StateManager;
    private _config;
    private _lastTickHadActivity;
    private _lastEventTimestamp;
    private _idleTimer;
    private _tickTimer;
    private _executing;
    /** Runtime middleware arrays — the single source of truth for tick execution. */
    private _onBeforeTickHandlers;
    private _onAfterTickHandlers;
    private _onBeforeCommitHandlers;
    private _tickLatencies;
    private _maxLatencySamples;
    constructor(clock: SimulationClock, eventBus: EventBus, stateManager: StateManager, config?: OrchestratorConfig);
    /**
     * Normalize constructor config into the runtime middleware arrays.
     * Accepts single handler or array for onBeforeTick/onAfterTick.
     * onBeforeCommit is always an array.
     */
    private _seedMiddleware;
    get isRunning(): boolean;
    get currentTick(): Tick;
    /**
     * Returns recent tick latency measurements for benchmarking.
     * Array of durations in milliseconds, most recent last.
     */
    get tickLatencies(): ReadonlyArray<number>;
    /**
     * Returns average tick latency over the sample window.
     */
    get averageTickLatency(): number;
    /**
     * Register an onBeforeTick handler. Called before engines run each tick.
     * Returns an unsubscribe function to remove this specific handler.
     */
    onBeforeTick(handler: TickMiddleware): () => void;
    /**
     * Register an onAfterTick handler. Called after commands are applied
     * and events are flushed each tick. Multiple handlers are called in
     * registration order.
     * Returns an unsubscribe function.
     */
    onAfterTick(handler: TickMiddleware): () => void;
    /**
     * Register a pre-commit validator. All registered validators must pass
     * (return void/true) for commands to be applied. If any validator returns
     * string[], the commit is aborted for this tick.
     * Returns an unsubscribe function.
     */
    onBeforeCommit(validator: CommitValidator): () => void;
    /**
     * Update non-middleware configuration at runtime.
     * Only numeric/boolean config fields are accepted — middleware hooks
     * must be registered via onBeforeTick() / onAfterTick() / onBeforeCommit().
     * undefined values are ignored (no un-set support).
     */
    updateConfig(config: Partial<Omit<OrchestratorConfig, 'onBeforeTick' | 'onAfterTick' | 'onBeforeCommit'>>): void;
    addEngine(engine: SimulationEngine): void;
    /**
     * Registered engine names IN EXECUTION ORDER. Registration order = serial
     * tick order = replay determinism — this getter makes the order observable
     * so the assembly-order snapshot test can pin it as a reviewed artifact
     * (the true order comes from priority fields scattered across engine files;
     * without this it is visible nowhere).
     */
    get engineNames(): string[];
    /** The registered engine instances, execution-ordered (assembly audit). */
    get engines(): readonly SimulationEngine[];
    removeEngine(name: string): boolean;
    /**
     * Returns true if any registered engine is an AsyncEngine
     * with pending reasoning operations. Useful for stopOnEmptyEvents
     * logic — the orchestrator should not stop while engines are thinking.
     */
    hasPendingAsyncWork(): boolean;
    /**
     * Hook called after Phase 1 commands are applied and the EventBus is flushed,
     * but BEFORE after-tick middleware runs. Override in CognitiveOrchestrator to
     * flush the CognitiveBus and apply Phase 2 (event-handler) commands so that
     * metrics and snapshot after-tick handlers see the fully updated state.
     */
    protected _onAfterPhase1(_tick: Tick, _state: ReadonlySimulationState, _context: SimulationContext): Promise<void>;
    start(context: SimulationContext): Promise<void>;
    /**
     * Tick-loop scheduling. Uses setInterval for consistent pacing;
     * calls _executeTick() which handles pause/stop checks internally.
     * The orchestrator is the sole driver of ticks.
     */
    /**
     * A plain SimulationEngine's `react()` is implicitly "finish inside the tick" —
     * only an AsyncEngine is allowed to span ticks, and it does so by LAUNCHING work
     * and landing it later (see async.engine.ts: "react() never awaits LLM calls").
     * Nothing enforces that on everyone else, and the failure is silent and severe:
     * every agency deadline is denominated in TICKS, so an engine that awaits network
     * I/O does not merely run slowly, it rescales time for the whole mind.
     *
     * Measured: one rate-limited embedding call awaited inside EpisodicConsolidator
     * made two consecutive ticks take 64.9s and 63.5s. `AWAIT_TIMEOUT` — 15 ticks,
     * normally ~15s — silently became 15 minutes, so a communicate intent sat
     * 'awaiting' forever and the serial selector never chose anything again. 45
     * executive decisions produced one intent and zero delivered messages, with no
     * error anywhere. This turns that into a line in the log the first time it happens.
     */
    private _warnIfSlow;
    private _runLoop;
    private _shutdown;
    stop(): void;
    pause(): void;
    resume(): void;
    private _executeTick;
    /**
     * Override in subclasses to enrich the SimulationContext passed to engines.
     * Default: returns context unchanged.
     * CognitiveOrchestrator overrides this to inject cognitiveBus.
     */
    protected _buildEngineContext(context: SimulationContext): SimulationContext;
    private _resetIdleTimer;
    private _wait;
    step(count?: number, { simulationId, runId, seed }?: MinimalContext): Promise<void>;
    runUntilTick(targetTick: Tick, { simulationId, runId, seed }?: MinimalContext): Promise<void>;
    runUntilTime(targetTime: number, { simulationId, runId, seed }?: MinimalContext): Promise<void>;
}

interface Scenario {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly version: string;
    readonly tags: string[];
    /**
     * Populate the live StateManager with initial entities and metrics.
     * Receives the actual StateManager so writes propagate — unlike a
     * snapshot copy which would be silently discarded.
     */
    initialize(state: StateManager, context: SimulationContext): Promise<void>;
    /**
     * Returns a plain SimulationState snapshot for inspection or seeding
     * before a SimulationContext is available.
     */
    getInitialState(): SimulationState;
    validate(): ScenarioValidationResult;
}
interface ScenarioValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
interface ScenarioConfig {
    id: string;
    name: string;
    version?: string;
    tags?: string[];
    initialEntities?: SimulationEntity[];
    initialMetrics?: Record<string, number>;
    parameters?: Record<string, unknown>;
}
declare class DefaultScenario implements Scenario {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly version: string;
    readonly tags: string[];
    readonly parameters: Record<string, unknown>;
    private _initialEntities;
    private _initialMetrics;
    constructor(config: ScenarioConfig);
    initialize(state: StateManager, _context: SimulationContext): Promise<void>;
    getInitialState(): SimulationState;
    validate(): ScenarioValidationResult;
}

interface MetricCollector {
    record(name: string, value: number, tags?: Record<string, string>): void;
    increment(name: string, delta?: number, tags?: Record<string, string>): void;
    gauge(name: string, value: number, tags?: Record<string, string>): void;
    histogram(name: string, value: number, tags?: Record<string, string>): void;
    flush(): Promise<void>;
}
/**
 * MetricCollector directly implements TickMiddleware.
 * The onTick method serves as the orchestrator's onAfterTick hook.
 */
interface MetricPoint {
    name: string;
    value: number;
    tags: Record<string, string>;
    timestamp: Timestamp;
    tick: Tick;
    type: 'counter' | 'gauge' | 'histogram';
}
declare class DefaultMetricCollector implements MetricCollector {
    private _points;
    private _flushInterval;
    private _flushCallback;
    private _currentTick;
    private _currentTime;
    constructor(autoFlushMs?: number, flushCallback?: (points: MetricPoint[]) => Promise<void>);
    /**
     * Implements the TickMiddleware signature.
     * Wire this as orchestratorConfig.onAfterTick to capture metrics.
     */
    onTick: (tick: Tick, _state: ReadonlySimulationState, _context: SimulationContext) => void;
    record(name: string, value: number, tags?: Record<string, string>): void;
    increment(name: string, delta?: number, tags?: Record<string, string>): void;
    gauge(name: string, value: number, tags?: Record<string, string>): void;
    histogram(name: string, value: number, tags?: Record<string, string>): void;
    flush(): Promise<void>;
    destroy(): void;
}

/**
 * Independent abstractions that decouple the framework from
 * runtime-specific implementations.  New cross-cutting abstractions
 * belong here alongside existing ones.
 */
interface StorageAdapter {
    write(path: string, content: string | Uint8Array): Promise<void>;
    read(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    exists(path: string): Promise<boolean>;
    delete?(path: string): Promise<void>;
    ensureDir?(path: string): Promise<void>;
}
/**
 * Bun-native storage adapter, with a node:fs fallback when the Bun global is
 * absent — the engine is Node-compatible (Bun remains the primary target).
 * Default for all framework components that perform file I/O.
 */
declare class BunStorageAdapter implements StorageAdapter {
    private get _isBun();
    write(path: string, content: string | Uint8Array): Promise<void>;
    read(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    exists(path: string): Promise<boolean>;
    delete(path: string): Promise<void>;
    ensureDir(path: string): Promise<void>;
}

/**
 * Serialization/Deserialization for simulation state.
 * Supports JSON and binary (length-prefixed JSON, upgradeable to MessagePack).
 */

type SerializationFormat = 'json' | 'binary';
interface SerializedEntity {
    id: string;
    type: string;
    createdAt: number;
    updatedAt: number;
    /** Sim tick of the last write — needed by ConflictDetector after a restore. */
    updatedAtTick?: number;
    metadata?: Record<string, unknown>;
    components: Record<string, unknown>;
}
interface SerializedState {
    version: string;
    format: SerializationFormat;
    schema: string;
    tick: Tick;
    time: Timestamp;
    entities: SerializedEntity[];
    metrics: Array<[string, number]>;
    createdAt: Timestamp;
    checksum?: string;
}
interface Serializer {
    serialize(state: SimulationState, format?: SerializationFormat): string | Uint8Array;
    deserialize(data: string | Uint8Array, format?: SerializationFormat): SimulationState;
    export(state: SimulationState, path: string): Promise<void>;
    import(path: string): Promise<SimulationState>;
}
interface SerializationConfig {
    format?: SerializationFormat;
    compress?: boolean;
    includeChecksum?: boolean;
    schemaVersion?: string;
    prettyPrint?: boolean;
    storage?: StorageAdapter;
}
declare class DefaultSerializer implements Serializer {
    private _config;
    private _encoder;
    private _decoder;
    private _storage;
    constructor(config?: SerializationConfig);
    serialize(state: SimulationState, format?: SerializationFormat): string | Uint8Array;
    deserialize(data: string | Uint8Array, _format?: SerializationFormat): SimulationState;
    export(state: SimulationState, path: string): Promise<void>;
    import(path: string): Promise<SimulationState>;
    private _toSerialized;
    private _fromSerialized;
    private _encodeSpecial;
    private _decodeSpecial;
    private _toBinary;
    private _fromBinary;
    /**
     * djb2 hash over meaningful content fields.
     *
     * Coverage:
     *   - tick + time       → catches clock corruption
     *   - entity id:type:updatedAt + encoded metadata/components per entity
     *     → catches add/remove/mutate AND (de)serialization round-trip loss
     *   - metric key:value per entry → catches any metric corruption
     *
     * metadata/components are now hashed directly (FN15): excluding them meant a
     * value silently dropped on serialization (a Map flattening to `{}`, a missing
     * `undefined` key) left `updatedAt` unchanged and so passed the integrity check
     * undetected. The values are hashed in their already-encoded form, so the
     * checksum computed at serialize time matches the one verified at deserialize
     * time (the decode happens only after verification).
     */
    private _computeChecksum;
}
interface DeltaSnapshot {
    baseTick: Tick;
    currentTick: Tick;
    /**
     * The simulation `time` recorded at `currentTick`. Captured at encode time so
     * decode reconstructs the real timestamp instead of fabricating one from a
     * hardcoded tick interval (FN14): the clock's per-tick duration is
     * configurable (`fixedDeltaMs`) and scaled (`timeScale`), so `time` is not a
     * fixed multiple of the tick number.
     */
    time: Timestamp;
    addedEntities: SimulationEntity[];
    removedEntityIds: string[];
    updatedEntities: Array<{
        id: string;
        changes: Partial<SimulationEntity>;
    }>;
    metricsDelta: Array<[string, number]>;
}
declare class DeltaEncoder {
    encode(previous: SimulationState, current: SimulationState): DeltaSnapshot;
    decode(base: SimulationState, delta: DeltaSnapshot): SimulationState;
}

interface SnapshotManagerConfig {
    /** How often to take full snapshots (ticks). 1 = every tick. */
    snapshotInterval?: number;
    /** How often to persist to disk (ticks). 0 = never. */
    persistInterval?: number;
    /** Base path for persisted snapshots */
    persistPath?: string;
    /** Whether to compute deltas between snapshots */
    computeDeltas?: boolean;
    /** Maximum in-memory snapshots to retain */
    maxInMemorySnapshots?: number;
    /** Storage adapter */
    storage?: StorageAdapter;
}
interface SnapshotEntry {
    tick: Tick;
    state: SerializedState;
    delta?: DeltaSnapshot;
    timestamp: number;
}
declare class SnapshotManager {
    private _serializer;
    private _deltaEncoder;
    private _config;
    private _storage;
    private _snapshots;
    /**
     * Deserialized form of the *immediately preceding* snapshot, kept as the
     * baseline for the next delta. Caching the deserialized state (rather than a
     * SerializedState) lets us encode the next delta without re-stringifying and
     * re-deserializing the baseline every snapshot.
     */
    private _prevState?;
    private _ticksSinceSnapshot;
    private _ticksSincePersist;
    private _currentTick;
    /** Callback for feeding replay recorder — set by DefaultSimulation */
    onSnapshot?: (tick: Tick, state: SerializedState, delta?: DeltaSnapshot) => void;
    constructor(config?: SnapshotManagerConfig);
    /**
     * Implements the TickMiddleware signature.
     * Wire this as orchestratorConfig.onAfterTick to enable state serialization.
     * Follows the exact same pattern as DefaultMetricCollector.onTick.
     */
    onTick: (tick: Tick, state: ReadonlySimulationState, _context: SimulationContext) => void;
    /**
     * Retrieve a snapshot by tick.
     */
    getSnapshot(tick: Tick): SerializedState | undefined;
    /**
     * Get all in-memory snapshots.
     */
    getAllSnapshots(): ReadonlyArray<SnapshotEntry>;
    /**
     * Get the most recent snapshot.
     */
    getLatestSnapshot(): SnapshotEntry | undefined;
    /**
     * Restore simulation state from a snapshot.
     * Returns the deserialized state ready for StateManager.restore().
     */
    restoreState(tick: Tick): SimulationState | undefined;
    /**
     * Export all snapshots to a file.
     */
    exportAll(path: string): Promise<void>;
    /**
     * Get the number of in-memory snapshots.
     */
    get snapshotCount(): number;
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
    loadLatestFromStorage(): Promise<SimulationState | undefined>;
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
    persistNow(state: ReadonlySimulationState): Promise<void>;
    private _persistSnapshot;
}

interface Simulation {
    readonly clock: SimulationClock;
    readonly eventBus: EventBus;
    readonly stateManager: StateManager;
    readonly orchestrator: Orchestrator;
    readonly metrics: MetricCollector;
    readonly context: SimulationContext;
    readonly randomSeed: number;
    addEngine(engine: SimulationEngine): void;
    loadScenario(scenario: Scenario): Promise<void>;
    run(): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
    step(count?: number): Promise<void>;
    /** Takes a snapshot of current state and returns its unique ID. */
    snapshot(): string;
    /**
     * Use { entities: false, metrics: true } to keep current entities
     * while rolling back only metrics.
     */
    restore(snapshotId: string, options?: RestoreOptions): Promise<boolean>;
}
interface SimulationConfig {
    clock?: ClockConfig;
    eventBus?: EventBusConfig;
    orchestrator?: OrchestratorConfig;
    metricsAutoFlushMs?: number;
    snapshot?: SnapshotManagerConfig;
    context?: Partial<Omit<SimulationContext, 'prng'>>;
    /** Seed for the PRNG. Defaults to wallClock() — record it to replay. */
    randomSeed?: number;
    /**
     * Optional factory that replaces DefaultOrchestrator with a custom implementation.
     *
     * The simulation constructs clock, eventBus, and stateManager first, then
     * passes them — along with the resolved OrchestratorConfig (including the
     * merged onAfterTick handlers) — into this factory.
     *
     * The cognitive layer uses this to inject CognitiveOrchestrator without
     * creating any import dependency from core → cognition.
     *
     * @example
     * ```ts
     * orchestratorFactory: (clock, eventBus, stateManager, cfg) =>
     *   new CognitiveOrchestrator(clock, eventBus, stateManager, cfg)
     * ```
     */
    orchestratorFactory?: (clock: SimulationClock, eventBus: EventBus, stateManager: StateManager, config: OrchestratorConfig) => Orchestrator;
}
declare class DefaultSimulation implements Simulation {
    readonly clock: SimulationClock;
    readonly eventBus: EventBus;
    readonly stateManager: StateManager;
    readonly snapshotManager: SnapshotManager;
    readonly orchestrator: Orchestrator;
    readonly metrics: DefaultMetricCollector;
    readonly context: SimulationContext;
    readonly randomSeed: number;
    private _scenario;
    private _snapshots;
    constructor(config?: SimulationConfig);
    addEngine(engine: SimulationEngine): void;
    loadScenario(scenario: Scenario): Promise<void>;
    run(): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
    step(count?: number): Promise<void>;
    snapshot(): string;
    /**
     * Forwards RestoreOptions to StateManager
     * for partial restore capability.
     */
    restore(snapshotId: string, options?: RestoreOptions): Promise<boolean>;
}

/**
 * LLM completion record/replay seam.
 *
 * The LLM is an external, non-deterministic oracle: to re-run a session
 * deterministically (REORIENT R2) the recorder captures each completion's full
 * input (model, params, prompt) and output, and on replay a *source* re-feeds
 * those recorded completions instead of re-calling the model. This module is
 * both halves of that seam — the capture sink (R2-b) and the re-feed source
 * (R2-c). Both registries are keyed by willId so each Will routes to its own
 * recorder/source (unlike the process-global token tracker — see REORIENT R4).
 */

interface LLMCompletionRecord {
    tick: Tick;
    willId: string;
    provider: string;
    model: string;
    maxOutputTokens: number;
    systemPrompt: string;
    userMessage: string;
    text: string;
    inputTok: number;
    outputTok: number;
    /** True when produced by the deterministic mock path (no API call). */
    mock: boolean;
    latencyMs: number;
    timestamp: Timestamp;
}
interface LLMCompletionSink {
    recordCompletion(record: LLMCompletionRecord): void;
}
declare function setCompletionRecorder(willId: string, sink: LLMCompletionSink): void;
declare function clearCompletionRecorder(willId: string): void;
declare function getCompletionRecorder(willId: string): LLMCompletionSink | undefined;

interface InboundRecord {
    tick: Tick;
    willId: string;
    /** The InboundEnvelope as applied (opaque here to avoid a #stem dependency). */
    envelope: unknown;
    timestamp: Timestamp;
}
interface InboundSink {
    recordInbound(record: InboundRecord): void;
}

/**
 * Deterministic replay system for debugging and analysis.
 * Records all inputs/events and allows frame-accurate replay.
 */

interface ReplayRecord {
    tick: Tick;
    timestamp: Timestamp;
    events: SimulationEvent[];
    delta?: DeltaSnapshot;
}
interface ReplayMetadata {
    simulationId: string;
    runId: string;
    startTime: Timestamp;
    endTime: Timestamp;
    totalTicks: Tick;
    totalEvents: number;
    totalCompletions: number;
    /** Count of recorded external inbound envelopes (messages/percepts/acks). */
    totalInbound?: number;
    randomSeed: number;
    version: string;
    tags: Record<string, string>;
}
interface ReplaySession {
    readonly metadata: ReplayMetadata;
    readonly currentTick: Tick;
    readonly isPlaying: boolean;
    readonly isPaused: boolean;
    readonly speed: number;
    play(): void;
    pause(): void;
    stop(): void;
    seekToTick(tick: Tick): Promise<void>;
    seekToTime(time: Timestamp): Promise<void>;
    stepForward(count?: number): Promise<SimulationEvent[]>;
    stepBackward(count?: number): Promise<SimulationEvent[]>;
    setSpeed(speed: number): void;
    export(): Promise<Uint8Array>;
}
interface ReplayRecorder extends LLMCompletionSink, InboundSink {
    recordEvent(event: SimulationEvent, context: SimulationContext): void;
    recordTick(tick: Tick, events: SimulationEvent[]): void;
    recordCompletion(record: LLMCompletionRecord): void;
    recordInbound(record: InboundRecord): void;
    flush(): Promise<void>;
    save(path: string): Promise<void>;
    getMetadata(): ReplayMetadata;
    close(): void;
}
interface ReplayConfig {
    bufferSize?: number;
    flushIntervalMs?: number;
    compress?: boolean;
    recordDeltas?: boolean;
    maxEventsPerTick?: number;
    /**
     * Base path for incremental flush segments. When set, flush() persists the
     * buffered records to `${flushBasePath}.partN.json` and clears the buffer;
     * save() consolidates the segments back into the final file. When unset,
     * flush() retains records in memory (still no data loss) until save().
     */
    flushBasePath?: string;
}
declare class DefaultReplayRecorder implements ReplayRecorder {
    private _records;
    private _completions;
    private _inbound;
    private _metadata;
    private _config;
    private _bufferSize;
    private _flushInterval;
    private _deltaEncoder;
    private _storage;
    private _flushBasePath;
    private _segments;
    private _segmentCount;
    constructor(simulationId: string, runId: string, randomSeed?: number, config?: ReplayConfig, storage?: StorageAdapter);
    recordEvent(event: SimulationEvent, _context: SimulationContext): void;
    recordTick(tick: Tick, events: SimulationEvent[]): void;
    /**
     * Record an LLM completion (input + output + model/params) into the replay
     * stream. The LLM is the system's non-deterministic oracle; capturing each
     * completion is the prerequisite for deterministic re-execution (REORIENT R2,
     * deferred) and is the gap FN3 calls out. Completions ride along with tick
     * records through the same flush/segment/save pipeline.
     */
    recordCompletion(record: LLMCompletionRecord): void;
    /**
     * Record an external inbound envelope (message/percept/ack) at the tick it was
     * applied. The transport is a non-deterministic input — capturing each envelope
     * is the prerequisite for re-injecting them on a deterministic re-execution
     * replay. Rides the same flush/segment/save pipeline as completions.
     */
    recordInbound(record: InboundRecord): void;
    flush(): Promise<void>;
    save(path: string): Promise<void>;
    getMetadata(): ReplayMetadata;
    close(): void;
}
declare class DefaultReplaySession implements ReplaySession {
    private _records;
    private _metadata;
    private _currentIndex;
    private _isPlaying;
    private _isPaused;
    private _speed;
    private _playInterval;
    private _eventHandlers;
    constructor(records: ReplayRecord[], metadata: ReplayMetadata);
    get metadata(): ReplayMetadata;
    get currentTick(): Tick;
    get isPlaying(): boolean;
    get isPaused(): boolean;
    get speed(): number;
    play(): void;
    pause(): void;
    stop(): void;
    seekToTick(targetTick: Tick): Promise<void>;
    seekToTime(targetTime: Timestamp): Promise<void>;
    stepForward(count?: number): Promise<SimulationEvent[]>;
    stepBackward(count?: number): Promise<SimulationEvent[]>;
    setSpeed(speed: number): void;
    export(): Promise<Uint8Array>;
    onEvent(handler: (event: SimulationEvent) => void): () => void;
    /**
     * Binary search for a record at a specific tick.
     * O(log n) — records are sorted ascending by tick in the constructor.
     * Used by ReplayManager.compare() to avoid seekToTick side effects
     * and (session as any) type escapes.
     */
    getRecordAtTick(tick: Tick): ReplayRecord | undefined;
    private _emitEventsForCurrentTick;
}
declare class ReplayManager {
    private _recorders;
    private _sessions;
    private _storage;
    constructor(storage?: StorageAdapter);
    createRecorder(simulationId: string, runId: string, randomSeed?: number, config?: ReplayConfig): DefaultReplayRecorder;
    getRecorder(simulationId: string, runId: string): DefaultReplayRecorder | undefined;
    loadReplay(path: string): Promise<DefaultReplaySession>;
    getSession(simulationId: string, runId: string): DefaultReplaySession | undefined;
    /**
     * Compare two replay files tick-by-tick.
     * Uses getRecordAtTick() for O(log n) lookup per tick — no seek side
     * effects, no type escapes into private session fields.
     */
    compare(replay1Path: string, replay2Path: string): Promise<ReplayComparison>;
}
interface ReplayComparison {
    areIdentical: boolean;
    differences: ReplayDifference[];
    totalTicksCompared: number;
}
interface ReplayDifference {
    tick: Tick;
    type: 'entity-mismatch' | 'metric-mismatch' | 'event-mismatch';
    expected: unknown;
    actual: unknown;
    path?: string;
}

/**
 * A write-side channel that async reasoning can push intermediate
 * results into. Each push triggers onIntermediateResult() and the
 * returned StateCommands are applied immediately to the current tick
 * (no conflict detection — progressive disclosure only).
 */
interface IntermediateStream {
    /**
     * Report an intermediate step result.
     * Commands returned by onIntermediateResult() are merged into the
     * current tick's command batch immediately.
     */
    report(step: string, result: unknown): void;
    /** The footprint this stream is associated with */
    readonly footprint: ReasoningFootprint;
    /** Number of intermediate results reported so far */
    readonly count: number;
}
declare abstract class AsyncEngine implements SimulationEngine {
    abstract readonly name: string;
    private _pending;
    private _detector;
    private _config;
    private _pendingCounter;
    constructor(config?: AsyncEngineConfig);
    /** True when there is at least one in-flight reasoning promise. */
    get hasPendingWork(): boolean;
    /**
     * Await all in-flight reasoning promises to settle WITHOUT advancing the
     * simulation. A caller can then collect the completed decision on the next
     * single step — instead of stepping repeatedly to poll, which would drain
     * simulation state (energy, circadian) and corrupt a controlled stimulus.
     * Resolves immediately when nothing is pending.
     */
    awaitPending(): Promise<void>;
    /**
     * Non-blocking tick react.
     * 1. Drains intermediate results from in-flight reasoning
     * 2. Checks for completed reasoning from previous ticks
     * 3. Starts new reasoning if the engine is idle (shouldAct() returns true)
     * 4. Returns validated results for this tick
     */
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    onAttach?(): Promise<void>;
    onDetach?(): Promise<void>;
    /**
     * Called when this engine's react() throws.
     * Default behavior: log and return empty result (engine contributes nothing this tick).
     */
    onError(error: Error, _tick: Tick, _context: SimulationContext): Promise<EngineResult | null>;
    /**
     * Whether the engine should initiate reasoning this tick.
     * Override to control when the engine activates.
     * Default: activates when no reasoning is pending.
     */
    protected shouldAct(_state: ReadonlySimulationState, _tick: Tick, _context: SimulationContext): boolean;
    /**
     * Capture a reasoning footprint from the current state snapshot.
     * Override to specify which entities/metrics the engine will observe.
     * Default: captures all entity IDs and metric keys (conservative).
     */
    protected readState(state: ReadonlySimulationState, tick: Tick): ReasoningFootprint;
    /**
     * Perform the actual async reasoning.
     * Receives the footprint captured at reasoning start, the frozen snapshot,
     * and an IntermediateStream for reporting progress.
     *
     * Call stream.report( stepName, stepResult ) at each meaningful boundary
     * to enable progressive state updates during long-running reasoning.
     *
     * Must return the raw reasoning output — onReasoningComplete() converts it.
     */
    protected abstract reasonAsync(footprint: ReasoningFootprint, state: ReadonlySimulationState, context: SimulationContext, stream: IntermediateStream): Promise<unknown>;
    /**
     * Convert reasoning output to StateCommands.
     * Called after conflict validation passes on the final result.
     */
    protected abstract onReasoningComplete(output: unknown, footprint: ReasoningFootprint, context: SimulationContext): StateCommands;
    /**
     * Convert an intermediate step result to StateCommands.
     * Called immediately when stream.report() is invoked during reasoning.
     * These commands bypass conflict detection — use only for:
     *   - Metric updates (progress, confidence, phase indicators)
     *   - Engine-owned entities (draft plans, working notes, partial analyses)
     *   - Signal events (not entity mutations)
     *
     * Return StateCommands to apply now, or null to skip.
     * Default: no intermediate updates.
     */
    protected onIntermediateResult(step: string, result: unknown, footprint: ReasoningFootprint, context: SimulationContext): StateCommands | null;
    /**
     * Choose the conflict strategy for this reasoning.
     * Override to vary strategy based on context (e.g., high-stakes actions use REJECT).
     */
    protected chooseStrategy(_footprint: ReasoningFootprint, _context: SimulationContext): ConflictStrategy;
    /**
     * Called when reasoning is rejected due to conflicts.
     * Override to handle rejection (logging, notification, etc.).
     */
    protected onConflictRejected(footprint: ReasoningFootprint, report: ConflictReport, _context: SimulationContext): void;
    /**
     * Create an IntermediateStream wired to a specific pending entry.
     * The stream pushes directly into the pending intermediates array,
     * which are drained each tick by _drainIntermediates().
     */
    private _createStream;
    /**
     * Drain intermediate results from in-flight reasoning.
     * Called at the start of each tick — applies any intermediates
     * that arrived since the last tick.
     *
     * Note: intermediates are already applied via the stream's report()
     * callback at the moment they're pushed. This method processes any
     * that were buffered in the pending entry (e.g., if report() was
     * called between ticks via a background process).
     */
    private _drainIntermediates;
    /**
     * Collect all completed reasoning, validate against current state,
     * and merge validated commands into the provided collections.
     */
    private _collectCompleted;
    /**
     * Remove pending operations that have exceeded maxPendingTicks.
     */
    private _pruneStale;
    /**
     * Merge validated StateCommands into the collector.
     * Preserves arrays — appends set, delete, and metrics entries.
     */
    private _mergeCommands;
}

interface CognitiveEventSchema {
    readonly type: string;
    readonly version: number;
    validate(payload: unknown): string | null;
}

declare module '#core/types' {
    interface SimulationContext {
        cognitiveBus?: CognitiveBus;
    }
}
interface CognitiveEvent<T = unknown> {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    readonly sourceEngine: string;
    readonly sequenceNumber: number;
    readonly logicalTime: number;
    readonly wallTime: number;
    readonly salience: number;
    readonly payload: T;
}
type CognitiveEventHandler = (event: CognitiveEvent) => StateCommands | void;
type AcceptsVersionsFn = (eventType: string) => number[];
interface CognitiveBus {
    publish(event: Omit<CognitiveEvent, 'id' | 'sequenceNumber' | 'logicalTime' | 'wallTime'>): void;
    /** acceptsVersions — optional per-subscriber version filter (Phase A). */
    subscribe(engineId: string, topics: string[], handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn): void;
    unsubscribe(engineId: string): void;
    flush(): void;
    /** Drain and return all StateCommands returned by onCognitiveEvent() handlers since last drain. */
    drainCommands(): StateCommands[];
    logicalTime: number;
}

/**
 * CognitiveEngine — additive interface for engines that participate in the
 * event-driven cognitive bus architecture.
 *
 * Any SimulationEngine can opt in by implementing these four methods.
 * Engines that don't implement it continue to work normally via react().
 * Migration can happen engine-by-engine with no orchestrator changes.
 */

interface CognitiveEngine extends SimulationEngine {
    /** Event schemas this engine may publish — declared at registration time. */
    publishes(): CognitiveEventSchema[];
    /** Topic patterns this engine subscribes to — used for bus wiring and cycle detection. */
    subscribes(): string[];
    /**
     * Declare which schema versions this engine accepts for a given event type.
     * If not implemented (or returns empty), any version is accepted.
     * The bus will attempt migration before delivery when version is not in the list.
     * Phase A: per-subscriber version filtering.
     */
    acceptsVersions?(eventType: string): number[];
    /** Called by the bus on event delivery — never called concurrently. */
    onCognitiveEvent(event: CognitiveEvent): StateCommands | void;
    /** Full local state snapshot for cold-start bootstrap and debugging. */
    snapshot(): Record<string, unknown>;
    /**
     * Rehydrate engine-internal mutable state from a prior snapshot() payload (FN9).
     *
     * snapshot() captures private accumulating state (activity multipliers, salience
     * baselines, generative-model predictions) that the event-sourced SimulationState
     * never sees; restore() is the matching seam that lets a snapshot/replay reproduce
     * it instead of resuming with freshly-zeroed internals. Optional and additive:
     * engines that don't implement it keep their old behaviour, and a restore caller
     * must treat it as best-effort (feature-detect before calling).
     */
    restore?(snapshot: Record<string, unknown>): void;
}

/** Top-level cost bucket for an LLM call. */
type LLMCallCategory = 'executive' | 'summarizer' | 'embedding' | 'identity-guard';
/** The actor/subsystem doing the work. */
type LLMCallAttribute = 'master' | 'facet' | 'memory' | 'guard';
/** The specific cognitive process being paid for. */
type LLMCallProcess = 'cog' | 'decision' | 'ideation';
/** The specific cognitive function being paid for. */
type LLMCallFunction = '-' | 'deliberation' | 'conversation' | 'outreach' | 'planning' | 'supervision' | 'consolidation' | 'recall' | 'index' | 'identity-coherence';
/** One attributed ledger record (5-axis attribution + tokens + cost). */
type TokenLedgerRecord = Record<string, unknown>;
type TokenRecordListener = (record: TokenLedgerRecord) => void;
/** USD per 1M tokens for one model. */
interface ModelPrice {
    input: number;
    output: number;
}
/**
 * Host-supplied prices, keyed by model id. Matching is exact first, then
 * normalized (provider prefix, date stamp and context qualifier stripped), so
 * `claude-sonnet-5` matches `claude-sonnet-5-20260114`.
 *
 * Prices belong to the host: they change on a vendor's schedule, differ per
 * account, and are ~0 for a self-hosted model. The engine ships none.
 */
type PriceTable = Record<string, ModelPrice>;
/**
 * Resolve the price for a model id from the host's table.
 *
 * The engine ships no prices at all. A table baked into a release is wrong the
 * week a vendor changes a rate, differs per account, and is meaningless for a
 * self-hosted model — and a *partial* table is worse than none, because some
 * models then report plausible-but-stale numbers while others honestly report
 * nothing. Prices live with the host, next to the routing policy they inform.
 *
 * `null` does NOT mean free — it means *unknown*, and the caller reports zero
 * cost with `priced: false` so the gap stays visible rather than confidently
 * wrong. (The removed built-in default priced every unrecognised model at
 * Sonnet's rate, overstating a budget model's output by ~54×.)
 */
declare function resolvePricing(model: string, hostPrices?: PriceTable): ModelPrice | null;
interface TokenUsage {
    /** Model identifier (e.g., 'openai/gpt-4o') */
    model: string;
    /**
     * The provider that actually served this call.
     *
     * Not derivable from `model`: routing is what makes the same model id
     * reachable from several places — `deepseek-v3` direct, through a gateway, or
     * self-hosted — at prices that differ by orders of magnitude. Without this a
     * host billing across a multi-vendor routing table can attribute spend to a
     * model but never to the vendor it actually paid.
     *
     * Optional because a caller recording usage directly (outside the LLM
     * director) may not know it; absent means unattributed, not "the default".
     */
    provider?: string;
    /** Input/prompt tokens consumed */
    promptTokens: number;
    /** Output/completion tokens consumed */
    completionTokens: number;
    /** Total tokens */
    totalTokens: number;
    /** Anthropic prompt-cache read tokens (billed at 0.1× input). Optional. */
    cacheReadTokens?: number;
    /** Anthropic prompt-cache write tokens (billed at 1.25× input). Optional. */
    cacheWriteTokens?: number;
    /** Estimated cost in USD. Zero when `priced` is false — unknown, not free. */
    estimatedCostUsd: number;
    /**
     * Whether a price was found for this model. False ⇒ `estimatedCostUsd` is 0
     * because nothing priced it, NOT because the call was free. A consumer
     * summing costs should surface unpriced calls rather than fold them in as
     * zero.
     */
    priced: boolean;
    /**
     * How much this call demanded, 0..1 — the cognitive measure the router saw.
     *
     * Recorded so routing can be ANSWERED rather than argued. Every call computes
     * this, routes on it, and until now threw it away — which left questions like
     * "is deliberation being rated by the tick's mood rather than the stakes of
     * its own choice?" with no dataset at all.
     *
     * Absent means UNMEASURED, never zero. It must stay nullable all the way to
     * storage: a call that never reported demand and a call that reported 0.0 are
     * different facts, and collapsing them would put a floor of invented
     * confidence under exactly the analysis this exists to enable.
     */
    demand?: number;
    category: LLMCallCategory;
    attribute: LLMCallAttribute;
    process: LLMCallProcess;
    function: LLMCallFunction;
    /** Optional specific id or namespace: facet id, entity id, model name. */
    scope?: string;
    /** Human-readable label — auto-composed from the axes when the caller omits it. */
    label: string;
    /** Optional pre-cache prompt size estimate (chars/4) — for cache-savings analysis. */
    estPromptTokens?: number;
    /** Tick when the call completed */
    tick: Tick;
    /** Latency in milliseconds */
    latencyMs: number;
}
/** What callers pass to {@link TokenTracker.recordUsage} — cost and label are derived. */
type RecordUsageInput = Omit<TokenUsage, 'estimatedCostUsd' | 'label' | 'priced'> & {
    label?: string;
};
interface TokenTrackerConfig {
    /**
     * Host-supplied model prices (USD per 1M tokens), merged from the per-provider
     * `prices` maps in `WillLLMConfig.providers`. These win over the built-in
     * fallback table. Omitted ⇒ fallback only.
     */
    prices?: PriceTable;
    /** Whether to emit cost events */
    emitCostEvents?: boolean;
    /** Cost threshold for warning events */
    costWarningThresholdUsd?: number;
    /**
     * When set together with `writeLedger`, every recorded call is appended (with
     * full 5-axis attribution + cost) to `./data/wills/<willId>/debug/token-report.jsonl`
     * — the complete, billable per-Will usage ledger (master, facets, summarizer,
     * embedding, guard — not just the master path).
     */
    willId?: string;
    /** Append the attributed ledger to disk (dev convenience). Off in prod/tests/replay. */
    writeLedger?: boolean;
}
declare class TokenTracker implements SimulationEngine {
    readonly name = "token-tracker";
    private _emitCostEvents;
    private _costWarningThreshold;
    private _prices;
    private _usageLog;
    private _totalPromptTokens;
    private _totalCompletionTokens;
    private _totalCost;
    private _categoryCosts;
    private _categoryTokens;
    private _functionCosts;
    private _functionTokens;
    private _processCosts;
    private _processTokens;
    private _providerCosts;
    private _providerTokens;
    private _tickCosts;
    private _maxTickCostSamples;
    private _lastCostWarningTick;
    private _lastProcessedIndex;
    private _recordListeners;
    private _ledgerPath;
    private _ledgerDirReady;
    constructor(config?: TokenTrackerConfig);
    /**
     * Record a completed LLM call.
     * Called by LLMDirector.call after each completion (src/llm/index.ts).
     */
    recordUsage(usage: RecordUsageInput): void;
    /**
     * Subscribe to every attributed ledger record (5-axis attribution + tokens +
     * cost). Neutral sink — the stem bridges these onto the ExternalTransport so
     * cognition/ stays free of any transport dependency. Returns an unsubscribe fn.
     */
    onRecord(listener: TokenRecordListener): () => void;
    private _emitLedger;
    /** Fold one call's cost + tokens into a (cost, tokens) breakdown pair under `key`. */
    private _accumulate;
    react(_delta: Duration, tick: Tick, _state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /** Total cost since simulation start */
    get totalCostUsd(): number;
    /** Total tokens consumed */
    get totalTokens(): {
        prompt: number;
        completion: number;
    };
    /** Cost broken down by category ('executive' | 'summarizer' | 'embedding' | …). */
    get categoryBreakdown(): ReadonlyMap<string, number>;
    /** Token counts (prompt + completion) broken down by category. */
    get categoryTokenBreakdown(): ReadonlyMap<string, {
        prompt: number;
        completion: number;
    }>;
    /** Cost broken down by function ('decision' | 'ideation' | 'conversation' | 'planning' | …). */
    get functionBreakdown(): ReadonlyMap<string, number>;
    /** Token counts (prompt + completion) broken down by function. */
    get functionTokenBreakdown(): ReadonlyMap<string, {
        prompt: number;
        completion: number;
    }>;
    /** Cost broken down by process ('decision' | 'ideation' | 'cog'). */
    get processBreakdown(): ReadonlyMap<string, number>;
    /** Token counts (prompt + completion) broken down by process. */
    get processTokenBreakdown(): ReadonlyMap<string, {
        prompt: number;
        completion: number;
    }>;
    /**
     * Cost broken down by provider ('anthropic' | 'glm' | 'moonshot' | …), plus
     * an `unattributed` bucket for usage recorded without one.
     *
     * This is the axis a host reconciles against vendor invoices. Calls whose
     * model went unpriced contribute 0 here, so compare against
     * `getUsageLog()`'s `priced` flag before treating a small number as a small
     * bill.
     */
    get providerBreakdown(): ReadonlyMap<string, number>;
    /** Token counts (prompt + completion) broken down by provider. */
    get providerTokenBreakdown(): ReadonlyMap<string, {
        prompt: number;
        completion: number;
    }>;
    /** Cost per call average */
    get averageCostPerCall(): number;
    /** Cost per tick average */
    get averageCostPerTick(): number;
    /** Estimated cost per hour at current rate */
    estimateHourlyCost(): number;
    /** Full usage log for export/analysis */
    getUsageLog(): ReadonlyArray<TokenUsage>;
    /** Reset all counters (for new simulation run) */
    reset(): void;
    private _computeTickCost;
    private _averageTickCost;
}

/**
 * Embedding provider interface — abstracts different embedding models.
 *
 * Supports:
 *   - Local models (via Transformers.js or Ollama)
 *   - Cloud providers (OpenAI, Anthropic, Cohere)
 *   - Mock embedder for testing/deterministic replay
 */

/** Embedding is only ever a read or a write. */
type EmbedFunction = Extract<LLMCallFunction, 'recall' | 'index'>;
interface EmbeddingProvider {
    readonly modelName: string;
    readonly dimensions: number;
    /** Generate embedding for a single piece of content. `fn` tags the call for
     *  cost attribution: 'recall' (query) vs 'index' (write). */
    embed(content: unknown, fn?: string): Promise<number[]>;
    /** Generate embeddings for multiple items (batched for efficiency). */
    embedBatch(contents: unknown[], fn?: string): Promise<number[][]>;
    /** Check if two embeddings are semantically equivalent (for replay validation) */
    areEquivalent(embedding1: number[], embedding2: number[], tolerance?: number): boolean;
}
/**
 * OpenAI-compatible embedder (works with OpenAI, Azure, LocalAI, Ollama)
 */
declare class OpenAICompatibleEmbedder implements EmbeddingProvider {
    readonly modelName: string;
    readonly dimensions: number;
    private _apiUrl;
    private _apiKey;
    private _maxConcurrency;
    private _timeoutMs;
    private _tokenTracker;
    /**
     * Own gate — the same LLMSemaphore the LLM calls use, on a separate instance so
     * embeddings and reasoning do not compete for one another's slots. It bounds the
     * fan-out that produced the 10.7s tail, and `withGate` additionally retries a 429
     * with backoff, which a bare `embed()` previously surfaced as a hard failure.
     */
    private _gate;
    constructor(config: {
        modelName: string;
        dimensions: number;
        apiUrl: string;
        apiKey?: string | null;
        /**
         * Max embedding requests in flight at once — across ALL callers, not just one
         * embedBatch(). Default 4, chosen from measured provider behaviour rather than
         * taste: gemini-embedding-001 answers a lone request in ~1.1s, but queues hard
         * under fan-out — at 8 in flight the slowest three took 10.7s (all HTTP 200, no
         * 429, simply serialized). That tail is what made recall exceed its 5s budget
         * and return "no recall" while a mind with six live facets was asking.
         */
        maxConcurrency?: number;
        /** @deprecated use maxConcurrency — kept as its fallback for back-compat. */
        batchSize?: number;
        /** Per-request timeout in ms before the connection is aborted. Default 30s. */
        timeoutMs?: number;
        /**
         * Per-Will token tracker. When provided, each embedding call records its
         * input-token usage under the 'embedding' category so memory-vector spend is
         * visible alongside LLM spend instead of being a silent cost leak.
         */
        tokenTracker?: TokenTracker | null;
    });
    /**
     * Embed one item, gated. Every caller funnels through here — a facet building a
     * prompt, the master recalling, the consolidator indexing — so the gate is the
     * only place total in-flight fan-out is bounded. Waiting for a slot is strictly
     * better than the alternative it replaces: an ungated request that returns after
     * the recall budget has already expired is a request whose answer is thrown away.
     */
    embed(content: unknown, fn?: EmbedFunction): Promise<number[]>;
    private _embedOnce;
    embedBatch(contents: unknown[], fn?: EmbedFunction): Promise<number[][]>;
    areEquivalent(embedding1: number[], embedding2: number[], tolerance?: number): boolean;
}
/**
 * Deterministic mock embedder for testing and replay.
 * Uses content hashing to produce stable embeddings.
 */
declare class MockEmbedder implements EmbeddingProvider {
    readonly modelName = "mock";
    readonly dimensions = 128;
    private _seed;
    constructor(seed?: number);
    embed(content: unknown, _fn?: EmbedFunction): Promise<number[]>;
    embedBatch(contents: unknown[], fn?: EmbedFunction): Promise<number[][]>;
    areEquivalent(embedding1: number[], embedding2: number[], tolerance?: number): boolean;
    private _hashString;
    private _next;
}

interface EpisodicConsolidatorConfig {
    /** Threshold above which a WM item is consolidated */
    consolidationThreshold?: number;
    /** How much emotional intensity boosts consolidation (multiplier) */
    emotionBoost?: number;
    /** Maximum episodes to consolidate per tick */
    maxPerTick?: number;
    /** Optional vector memory adapter for semantic search */
    vectorMemory?: VectorMemoryAdapter;
    /** Optional embedding provider (required if vectorMemory provided) */
    embedder?: EmbeddingProvider;
    /** Whether to automatically index episodes (default true) */
    autoIndex?: boolean;
    bus?: CognitiveBus;
}
interface EpisodicMemory {
    id: string;
    timestamp: Tick;
    content: unknown;
    emotionalTags: Record<string, number>;
    affectiveContext: {
        valence: number;
        arousal: number;
        dominance: number;
    };
    activationStrength: number;
    retrievalCount: number;
    lastRetrievedAt: Tick | null;
    tags: string[];
    sourceType: string;
    /** Wall-clock ms at the moment the episode was first consolidated. */
    createdAt: number;
    /**
     * Outcome lifecycle of the originating action/intent:
     *   'intended'  — goal or plan was formed but not yet attempted
     *   'attempted' — action was dispatched; outcome unknown at consolidation time
     *   'confirmed' — action was confirmed successful (e.g. message delivered)
     *   'failed'    — action failed, timed out, or was abandoned
     */
    outcomeStatus?: 'intended' | 'attempted' | 'confirmed' | 'failed';
}
declare class EpisodicConsolidator implements SimulationEngine, CognitiveEngine {
    readonly name = "episodic-consolidator";
    private _consolidationThreshold;
    private _emotionBoost;
    private _maxPerTick;
    private _store;
    private _storeMap;
    private _restored;
    /** Ticks between full-store state syncs (captures decay / dream mutations).
     *  Must be ≤ SnapshotManager.persistInterval (default 15) so every persisted
     *  snapshot contains up-to-date episode values. */
    private readonly _syncInterval;
    private _ticksSinceSync;
    private _affectValence;
    private _affectArousal;
    private _affectDominance;
    private _bus;
    private _vectorMemory;
    /**
     * In-flight background indexing. Indexing is deliberately not awaited inside
     * react() (a rate-limit retry chain would stall the whole tick loop), so this is
     * the handle for the two callers that genuinely must wait for it: shutdown,
     * before persisting the index, and tests asserting on it.
     */
    private _indexing;
    private _embedder;
    private _autoIndex;
    private readonly _model;
    constructor(config?: EpisodicConsolidatorConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Query episodic memory by tags, time range, or emotional context.
     */
    query(filters: {
        tags?: string[];
        fromTick?: Tick;
        toTick?: Tick;
        minEmotion?: string;
        limit?: number;
    }): EpisodicMemory[];
    /**
     * Semantic query via vector memory.
     * Returns episodes with content semantically similar to the query.
     * Requires vectorMemory adapter to be configured.
     *
     * Similarity ranking, with optional mood-congruent re-ranking: when
     * `affectiveBias` is supplied, results are re-scored by blending embedding
     * similarity with affective congruence between the caller's current valence
     * and each episode's encoded valence (`affectiveContext.valence`) — modelling
     * mood-congruent recall (Bower). Similarity still dominates at low weights. To
     * let affect promote a congruent-but-slightly-less-similar memory, we
     * over-fetch candidates and re-rank before truncating to `limit`.
     *
     * Other metadata narrowing (sourceType / tags) remains the caller's job on the
     * returned episodes (which carry all metadata).
     */
    /** Await any background indexing still in flight. Shutdown and tests only. */
    flushIndexing(): Promise<void>;
    semanticQuery(query: unknown, filters?: {
        minSimilarity?: number;
        limit?: number;
        /** Mood-congruent re-ranking: target valence [-1,1] + blend weight [0,1]. */
        affectiveBias?: {
            valence: number;
            weight: number;
        };
    }): Promise<EpisodicMemory[]>;
    /**
     * Mark an episode as retrieved (boosts its strength slightly).
     *
     * Immutable replace (mirrors applyDecay): other engines may already hold a
     * reference to this episode this tick, so we update a copy in both _store and
     * _storeMap rather than mutating the shared object underneath them. The bumped
     * retrievalCount is the load-bearing field — it unlocks the ForgettingCurve's
     * retrievalBoost, so memories that are actively recalled decay slower than
     * ones that are never used.
     */
    markRetrieved(episodeId: string, tick: Tick): void;
    /**
     * Get all episodes (for serialization / replay).
     */
    getAllEpisodes(): ReadonlyArray<EpisodicMemory>;
    /**
     * Permanently remove decayed episodes from the store, the id index, and the
     * vector index. The consolidator owns the store, so the ForgettingCurve asks
     * it to prune rather than mutating the store itself. Returns the ids that
     * were actually present and removed, so the caller can emit matching state
     * deletions. Removal is order-deterministic for replay.
     */
    /**
     * Apply decayed activation strengths computed by the ForgettingCurve.
     *
     * The consolidator owns the episode store, so decay is committed here rather
     * than written onto the live objects the curve borrowed via getAllEpisodes()
     * — those references may already be held by other engines this tick. Each
     * changed episode is replaced with an updated copy (immutable update), so
     * previously handed-out references are not mutated underneath their holders.
     */
    applyDecay(updates: ReadonlyMap<string, number>): void;
    /**
     * Commit dream-state mutations computed by the DreamSimulator — reactivation
     * boosts (activationStrength), REM emotional dampening (emotionalTags), and
     * creative-recombination tag cross-pollination (tags).
     *
     * Like applyDecay, the consolidator owns the store, so the simulator computes
     * the new field values on its own working copies and hands them here for an
     * immutable replace, rather than mutating the shared episode objects it
     * borrowed via getAllEpisodes() — those references may be held by other
     * engines this tick. Only the fields present in each entry are replaced.
     */
    applyDreamUpdates(updates: ReadonlyMap<string, {
        activationStrength?: number;
        emotionalTags?: Record<string, number>;
        tags?: string[];
    }>): void;
    pruneEpisodes(ids: Iterable<string>): Promise<string[]>;
    /**
     * Force an immediate full sync of all in-memory episodes to StateCommands.
     *
     * Called at session end (pauseWill / archiveWill) to guarantee that episode
     * mutations accumulated since the last periodic sync — activationStrength
     * decay, emotionalTag dampening, retrieval counts — are captured in the
     * final persisted snapshot.  Without this, any session that ends between
     * two scheduled sync ticks loses those mutations on the next cold-start.
     */
    flushToState(): StateCommands;
    /**
     * Restore episodes from snapshot (for replay).
     */
    restoreEpisodes(episodes: EpisodicMemory[]): void;
    /**
     * Serialize one episode into a StateCommands entity write.
     * Used both at creation time and during periodic sync.
     */
    private _episodeToEntity;
    /**
     * Rehydrate _store from 'episodic_memory' entities in state.
     * Called once on first tick after snapshot restore.
     * Also rebuilds vector index if configured.
     */
    private _restoreFromState;
    private _findCandidates;
    private _readCurrentEmotions;
    private _computeEmotionalIntensity;
}

/**
 * Vector memory types for semantic episodic retrieval.
 *
 * Provides similarity search over consolidated episodic memories
 * without replacing the existing _store array or StateManager.
 * Acts as a read-optimized secondary index.
 */

interface VectorMemoryConfig {
    /** Dimension of embedding vectors (default 1536 for OpenAI text-embedding-3-small) */
    dimensions?: number;
    /** Similarity metric: 'cosine', 'euclidean', or 'dot' */
    similarityMetric?: 'cosine' | 'euclidean' | 'dot';
    /** Maximum number of episodes to index (older entries evicted) */
    maxIndexedEpisodes?: number;
    /** Minimum similarity threshold for query results (0-1). Default 0.35, tuned
     *  for real sentence embeddings (text-embedding-3-small); raise for higher
     *  precision. */
    minSimilarity?: number;
    /** Seed for the index's level-assignment PRNG — required for deterministic replay */
    seed?: number;
}
interface VectorRecord {
    id: string;
    vector: number[];
    embeddingModel: string;
    createdAt: number;
    metadata: {
        tick: Tick;
        sourceType: string;
        /** Encode-time affective valence (-1..1). Stamped here so index backends that
         *  CAN filter/rank on metadata (pgvector, Qdrant) may do affective filtering
         *  server-side. The HNSW path is similarity-only, so its mood-congruent recall
         *  (EpisodicConsolidator.semanticQuery affectiveBias) re-ranks on the
         *  authoritative resolved-episode valence instead. */
        emotionalValence: number;
        tags: string[];
    };
}
interface VectorQueryResult {
    episodeId: string;
    similarity: number;
}
/**
 * Query knobs for vector search.
 *
 * The HNSW index is **similarity-only**: it ranks by vector distance and
 * applies a `minSimilarity` floor, nothing else. Metadata is stored on
 * VectorRecord but is NOT indexed, so any metadata-based narrowing
 * (sourceType / valence / tags / tick range) must be done by the caller
 * AFTER the search returns. See episodic.consolidator.semanticQuery.
 */
interface VectorQueryFilter {
    minSimilarity?: number;
    maxResults?: number;
}

/**
 * Vector index interface — allows swapping different implementations.
 *
 * Implementations:
 *   - HNSWIndex (in-memory, deterministic)
 *   - QdrantClient (cloud)
 *   - PgVectorClient (Postgres)
 *   - PineconeClient (cloud)
 */

interface VectorIndex {
    /** Insert a vector into the index */
    insert(record: VectorRecord): Promise<void>;
    /** Search for k nearest neighbors. Similarity-only — see VectorQueryFilter. */
    search(vector: number[], k: number, filter?: {
        minSimilarity?: number;
    }): Promise<VectorQueryResult[]>;
    /** Delete a vector from the index */
    delete(id: string): Promise<boolean>;
    /** Get current size of index */
    readonly size: number;
    /** Iterate all indexed ids in insertion order — lets callers rebuild an
     *  external id-set (e.g. the adapter's dedup/eviction set) after a load. */
    keys?(): IterableIterator<string>;
    /** Serialize index to bytes for persistence (optional) */
    serialize?(): Uint8Array;
    /** Deserialize index from bytes (optional) */
    deserialize?(bytes: Uint8Array): Promise<void>;
    /** Clear all entries */
    clear(): Promise<void>;
}

interface VectorMemoryAdapter {
    /** Index an episodic memory (called during consolidation) */
    index(episode: EpisodicMemory, content: unknown): Promise<void>;
    /** Index multiple episodes in batch */
    indexBatch(episodes: Array<{
        episode: EpisodicMemory;
        content: unknown;
    }>): Promise<void>;
    /** Search for semantically similar episodes — returns ID + similarity, caller resolves from store */
    search(query: unknown, filter?: VectorQueryFilter): Promise<VectorQueryResult[]>;
    /** Search with embedding vector directly */
    searchWithVector(embedding: number[], filter?: VectorQueryFilter): Promise<VectorQueryResult[]>;
    /** Delete an episode from the index (when pruned from _store) */
    delete(episodeId: string): Promise<void>;
    /** Rebuild entire index from store (called on snapshot restore when no persisted index exists) */
    rebuildFromStore(store: EpisodicMemory[]): Promise<void>;
    /** Persist index to storage */
    persist(): Promise<void>;
    /** Load index from storage */
    load(): Promise<void>;
    /** Get current index size */
    readonly size: number;
}
declare class DefaultVectorMemoryAdapter implements VectorMemoryAdapter {
    private _index;
    private _embedder;
    private _storage;
    private _persistPath;
    private _metaPath;
    private _maxIndexedEpisodes;
    private _indexedIds;
    private _dirty;
    private _persistDebounceTimer;
    private _minSimilarity;
    /** Per-id access recency (insert + search hit) for LRU-style eviction. A plain
     *  monotonic counter — not persisted; rebuilt from insertion order on load. */
    private _accessTick;
    private _accessClock;
    constructor(embedder: EmbeddingProvider, config?: VectorMemoryConfig & {
        persistPath?: string;
    }, storage?: StorageAdapter, indexImpl?: VectorIndex);
    /** Record that `id` was just inserted or recalled, so eviction keeps the
     *  memories the Will actually uses (LRU) and drops the genuinely cold ones. */
    private _touch;
    get size(): number;
    index(episode: EpisodicMemory, content: unknown): Promise<void>;
    indexBatch(episodes: Array<{
        episode: EpisodicMemory;
        content: unknown;
    }>): Promise<void>;
    search(query: unknown, filter?: VectorQueryFilter): Promise<VectorQueryResult[]>;
    searchWithVector(embedding: number[], filter?: VectorQueryFilter): Promise<VectorQueryResult[]>;
    delete(episodeId: string): Promise<void>;
    rebuildFromStore(store: EpisodicMemory[]): Promise<void>;
    persist(): Promise<void>;
    load(): Promise<void>;
    private _evictColdest;
    /**
     * Throttle, NOT a debounce. The previous version cleared and re-armed the timer on
     * every index(), so it only ever fired after 5s of complete inactivity — and a mind
     * consolidating steadily indexes far more often than that, so the write was pushed
     * back indefinitely and the index never reached disk while it was awake.
     *
     * A pending timer is now left alone: the first write after a quiet period sets the
     * deadline, and everything indexed within the window rides along on it. Persist is
     * bounded at 5s from the FIRST pending change rather than the last.
     */
    private _schedulePersist;
}

interface EnergyRegulatorConfig {
    maxEnergy?: number;
    baseDecayRate?: number;
    restReplenishRate?: number;
    lowEnergyThreshold?: number;
    criticalEnergyThreshold?: number;
    /** Energy level below which the system forces unconscious recovery */
    collapseThreshold?: number;
    /** Energy level at which forced recovery ends and consciousness returns */
    recoveryThreshold?: number;
    bus?: CognitiveBus;
}
declare class EnergyRegulator implements SimulationEngine, CognitiveEngine {
    readonly name = "energy-regulator";
    private _maxEnergy;
    private _baseDecayRate;
    private _restReplenishRate;
    private _lowThreshold;
    private _criticalThreshold;
    private _collapseThreshold;
    private _recoveryThreshold;
    private _bus;
    private readonly _model;
    constructor(config?: EnergyRegulatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _readConfigFromState;
}

/**
 * SleepPressureRegulator — accumulates sleep drive during wakefulness
 * and dissipates it during rest/sleep states.
 *
 * Models the two-process sleep model:
 *   - Process S: homeostatic sleep pressure (accumulates while awake)
 *   - Process C: circadian modulation (handled by CircadianOscillator)
 *
 * High sleep pressure degrades attention, working memory, and
 * decision quality via modulation signals.
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

interface SleepPressureConfig {
    /** Rate at which sleep pressure accumulates while awake (per second of sim time) */
    wakeAccumulationRate?: number;
    /** Rate at which sleep pressure dissipates during rest (per second of sim time) */
    restDissipationRate?: number;
    /** Maximum sleep pressure (saturation point) */
    maxPressure?: number;
    /** Pressure threshold for cognitive degradation onset */
    fatigueThreshold?: number;
    /** Pressure threshold for severe impairment */
    exhaustionThreshold?: number;
    bus?: CognitiveBus;
}
declare class SleepPressureRegulator implements SimulationEngine, CognitiveEngine {
    readonly name = "sleep-pressure-regulator";
    private _wakeAccumulationRate;
    private _restDissipationRate;
    private _maxPressure;
    private _fatigueThreshold;
    private _exhaustionThreshold;
    private _wasSleeping;
    private _bus;
    private readonly _model;
    constructor(config?: SleepPressureConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _readConfigFromState;
}

/**
 * AttentionAllocator — manages a finite attention budget.
 *
 * Attention is a limited resource. Attending to entities consumes
 * budget. Salient stimuli (from Perception) compete for allocation.
 * Multiple simultaneous demands cause fragmentation (reduced depth).
 *
 * Receives modulation from:
 *   - EnergyRegulator (low energy → reduced capacity)
 *   - SleepPressureRegulator (fatigue → reduced capacity)
 *   - CircadianOscillator (time-of-day capacity variation)
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

interface AttentionAllocatorConfig {
    /** Maximum attention capacity (baseline, before modulation) */
    maxCapacity?: number;
    /** Cost per tick to maintain attention on a single focus */
    costPerFocus?: number;
    /** Maximum number of simultaneous attention foci */
    maxFoci?: number;
    /** How quickly attention shifts between foci (lower = more sticky) */
    shiftInertia?: number;
    bus?: CognitiveBus;
}
declare class AttentionAllocator implements SimulationEngine, CognitiveEngine {
    readonly name = "attention-allocator";
    private _maxCapacity;
    private _costPerFocus;
    private _maxFoci;
    private _shiftInertia;
    private _activeFocus;
    private _energyLevel;
    private _sleepPressure;
    /** Voluntary effort set-point (0.4–1.0); see EFFORT_* constants. */
    private _effort;
    /** A one-shot focus/rest request from the executive, applied next react(). */
    private _effortRequest;
    /** ACP-P2: a self-caused precision attenuation is armed; react() restores after one observe. */
    private _acpOneShot;
    private _bus;
    private readonly _model;
    constructor(config?: AttentionAllocatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _readConfigFromState;
    /**
     * Yerkes–Dodson arousal → ceiling factor. Calm (≤ AROUSAL_REST) → 1.0 (no
     * boost); rises linearly to 1 + AROUSAL_GAIN at AROUSAL_PEAK (mobilization);
     * then declines below 1 toward 1 − AROUSAL_OVERLOAD at maximum arousal
     * (fragmentation / tunnel vision — capacity the mind cannot will back).
     */
    private _arousalFactor;
    /**
     * Extract salience signals from perceptual entities.
     * Entities with higher salience demand more attention.
     */
    private _extractSalienceSignals;
    /**
     * Decay existing attention focuses over time.
     * Sustained attention on a single focus resists decay (vigilance effect).
     */
    private _decayFocuses;
    /**
     * Allocate attention budget across competing salience signals.
     * Balances capturing new salient stimuli against maintaining existing focus.
     */
    private _allocate;
}

/**
 * StressRegulator — tracks cumulative allostatic load.
 *
 * Stress accumulates from:
 *   - Unresolved demands (pending goals, unread messages)
 *   - Time pressure (deadlines approaching)
 *   - Resource scarcity (low energy, high sleep pressure)
 *   - Social evaluation (perceived judgment, conflict)
 *   - Novelty/uncertainty (unfamiliar situations)
 *
 * Chronic stress degrades cognitive function and biases toward
 * habitual/defensive responses. Acute stress can enhance performance
 * (Yerkes-Dodson curve) up to an optimal point.
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

interface StressRegulatorConfig {
    /** Maximum allostatic load */
    maxLoad?: number;
    /**
     * Fractional clearance rate (per second): the proportion of the *current*
     * load shed each second. Recovery is first-order (exponential), so this also
     * sets the recovery time-constant τ ≈ 1 / rate. Emotional-stability persona
     * development raises it (sheds stress faster); see persona.consolidator #23.
     */
    baseDecayRate?: number;
    /** Threshold for optimal stress (peak performance) */
    optimalThreshold?: number;
    /** Threshold for distress (cognitive degradation begins) */
    distressThreshold?: number;
    /** Threshold for overload (significant impairment) */
    overloadThreshold?: number;
    bus?: CognitiveBus;
}
declare class StressRegulator implements SimulationEngine, CognitiveEngine {
    readonly name = "stress-regulator";
    private _maxLoad;
    private _baseDecayRate;
    private _optimalThreshold;
    private _distressThreshold;
    private _overloadThreshold;
    private _energyLevel;
    private _sleepPressure;
    private _noveltyScore;
    private _activeGoalCount;
    private _metacogConfidence;
    private _bus;
    private readonly _model;
    constructor(config?: StressRegulatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    /** ACP-P2: self-caused stress attenuation armed; react() restores after one observe. */
    private _acpOneShot;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _readConfigFromState;
    /**
     * Assess active stressors from the current state.
     */
    private _assessStressors;
    private _getZone;
}

/**
 * CircadianOscillator — maintains an internal biological clock.
 *
 * Produces a ~24-hour rhythm that modulates:
 *   - Energy baseline (lower at night)
 *   - Cognitive performance (peaks during day)
 *   - Sleep propensity (highest at night)
 *   - Mood baseline (varies with time of day)
 *
 * The oscillator can be entrained by external light/dark signals
 * and can drift if isolated (free-running period slightly > 24h).
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

type CircadianPhase = 'morning' | 'afternoon' | 'evening' | 'night';
interface CircadianConfig {
    /** Period of the oscillator in hours (default 24.2 — free-running human) */
    periodHours?: number;
    /** Phase offset in hours (shift the peak) */
    phaseOffsetHours?: number;
    /** Whether external light signals entrain the oscillator */
    entrainable?: boolean;
    /** Current simulated time of day in hours (0-24). If not provided, derived from tick. */
    timeOfDayHours?: number;
    bus?: CognitiveBus;
}
declare class CircadianOscillator implements SimulationEngine, CognitiveEngine {
    readonly name = "circadian-oscillator";
    private _periodHours;
    private _phaseOffsetHours;
    private _entrainable;
    private _timeOfDayHours?;
    private _bus;
    private readonly _model;
    constructor(config?: CircadianConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _readConfigFromState;
    /**
     * Set the current time of day explicitly (for scenarios with controlled time).
     */
    setTimeOfDay(hours: number): void;
    /**
     * Get the current circadian phase.
     */
    getPhase(): CircadianPhase;
}

/**
 * Exteroception — processes external world events into structured percepts.
 *
 * Scans the event bus and entity space for:
 *   - New entities entering the world
 *   - Changes to existing entities
 *   - Explicit events (messages, notifications, environmental changes)
 *   - Other agents' observable actions
 *
 * Each percept is an entity with salience tagging, enabling downstream
 * engines (Attention, Affective, Memory) to prioritize processing.
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

interface ExteroceptionConfig {
    /** Maximum percepts to produce per tick */
    maxPerceptsPerTick?: number;
    /** Default salience for unmarked percepts */
    defaultSalience?: number;
    /** Whether to emit percept events */
    emitPerceptEvents?: boolean;
    /** Entity types to always treat as high-salience */
    highPriorityTypes?: string[];
    bus?: CognitiveBus;
}
declare class Exteroception implements SimulationEngine, CognitiveEngine {
    readonly name = "exteroception";
    private _maxPerceptsPerTick;
    private _defaultSalience;
    private _emitPerceptEvents;
    private _highPriorityTypes;
    private _previousEntityVersions;
    private _bus;
    private readonly _model;
    constructor(config?: ExteroceptionConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Scan the world for perceptible changes.
     * Compares current entity state against previous versions.
     */
    private _scanWorld;
    /**
     * Generate a meaningful summary for an entity.
     * Instead of "New percept: percept-54-0", produce something useful.
     */
    /**
     * The text the corollary-discharge matcher inspects for this entity — its
     * content (a message body) over its description over its summary. Where our
     * own delivered words would surface if the world echoes them back.
     */
    /**
     * The affect→percept valence seam (registry #5). A percept carries how the
     * mind *feels* about what it is a percept OF, resolved most-specific-first:
     *
     *   1. the KnownEntityTracker's dossier for this entity (`ke-<id>.valence`) —
     *      a real per-entity felt valence, the honest signal;
     *   2. otherwise the ambient `affect.valence` — the felt tone at perception
     *      time. Weaker evidence, so it is tagged `'ambient'` and consumers
     *      weight it down (mood is context, not appraisal of this thing).
     *
     * Absent both, no valence is stamped and every consumer keeps its
     * pre-seam behaviour.
     */
    /** Spread-friendly form of `_valenceFor` for percept construction. */
    private _valenceOf;
    private _valenceFor;
    private _matchText;
    private _summarizeEntity;
    /**
     * Compute salience of a percept based on entity characteristics.
     */
    private _computeSalience;
    /**
     * Collect IDs of stale percept entities to clean up.
     */
    private _collectStalePerceptIds;
}

/**
 * Interoception — monitors internal bodily and mental state.
 *
 * Produces a unified "how I feel right now" percept by aggregating:
 *   - Energy level
 *   - Sleep pressure
 *   - Stress load
 *   - Circadian phase
 *   - Active emotions (from affective layer, once built)
 *   - Cognitive load
 *
 * This is the mind's sense of its own body — the foundation for
 * subjective feeling states. Without interoception, emotions are
 * just numbers; with it, they become felt experiences.
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

interface InteroceptionConfig {
    /** Metric keys to include in the interoceptive percept */
    monitoredMetrics?: string[];
    /** Whether to emit a detailed interoceptive event each tick */
    emitDetailEvent?: boolean;
    bus?: CognitiveBus;
}
declare class Interoception implements SimulationEngine, CognitiveEngine {
    readonly name = "interoception";
    private _monitoredMetrics;
    private _emitDetailEvent;
    private _previousSignals;
    private _energyLevel;
    private _sleepPressure;
    private _stressLoad;
    private _bus;
    private readonly _model;
    constructor(config?: InteroceptionConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Read all monitored internal metrics and produce interpreted signals.
     */
    private _readInternalState;
    /**
     * Interpret a metric value into a subjective description.
     */
    private _interpret;
    /**
     * Compute how intensely a signal is felt (deviation from comfort zone).
     */
    private _computeIntensity;
    /**
     * Detect significant changes in internal signals since last tick.
     */
    private _detectChanges;
    /**
     * Compute overall comfort from all signals.
     * 1.0 = completely comfortable, 0.0 = deeply uncomfortable.
     */
    private _computeComfort;
    private _metricToComfort;
    private _collectStale;
}

/**
 * SocialPerception — processes social signals from other agents.
 *
 * Detects and interprets:
 *   - Other agents' observable actions
 *   - Communication directed at this agent
 *   - Social status and relationship cues
 *   - Group dynamics and social context
 *
 * Produces social percepts with salience that feed into:
 *   - AttachmentEvaluator (to update relationship models)
 *   - TheoryOfMind (to update mental models of others)
 *   - ThreatEvaluator (social evaluation threat)
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

interface SocialPerceptionConfig {
    /** Entity types that represent other agents */
    agentTypes?: string[];
    /** Entity types that represent social signals */
    signalTypes?: string[];
    /** Maximum social percepts per tick */
    maxPerceptsPerTick?: number;
    bus?: CognitiveBus;
}
declare class SocialPerception implements SimulationEngine, CognitiveEngine {
    readonly name = "social-perception";
    private _agentTypes;
    private _signalTypes;
    private _maxPerceptsPerTick;
    private _previousActions;
    private _bus;
    private readonly _model;
    constructor(config?: SocialPerceptionConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _scanSocialSignals;
    /**
     * Default valence mapping for known action types.
     */
    private _defaultValence;
    /**
     * Update running relationship metrics for a perceived will.
     */
    private _updateRelationshipMetrics;
    private _countActiveAgents;
    /**
     * Compute social evaluation threat — how much social scrutiny is perceived.
     */
    private _computeEvaluationThreat;
    private _collectStale;
}

/**
 * NoveltyDetector — compares current percepts against expectations.
 *
 * Computes prediction error by comparing incoming percept patterns
 * against a running model of expected patterns. High novelty signals:
 *   - Something unexpected happened
 *   - The world has changed in a meaningful way
 *   - The current mental model needs updating
 *
 * Novelty drives:
 *   - Curiosity (positive valence + novelty → exploration)
 *   - Anxiety (negative valence + novelty → caution)
 *   - Learning (high novelty events are consolidated more strongly)
 *
 * Uses a simple exponential moving average of recent percept counts
 * per category as the expectation baseline.
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

interface NoveltyDetectorConfig {
    /** Learning rate for expectation updates (0-1) */
    learningRate?: number;
    /** How many ticks to look back for pattern comparison */
    windowSize?: number;
    /** Threshold above which novelty is considered significant */
    significanceThreshold?: number;
    bus?: CognitiveBus;
}
declare class NoveltyDetector implements SimulationEngine, CognitiveEngine {
    readonly name = "novelty-detector";
    private _learningRate;
    private _windowSize;
    private _significanceThreshold;
    private _expectedCounts;
    private _expectedSalience;
    private _recentHistory;
    private _bus;
    private readonly _model;
    constructor(config?: NoveltyDetectorConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Aggregate current percept entities by category.
     */
    private _aggregatePercepts;
    /**
     * Compute novelty as normalized deviation from expected value.
     */
    private _computeNovelty;
    /**
     * Update exponential moving averages for each category.
     */
    private _updateExpectations;
    private _updateHistory;
}

/**
 * ThreatEvaluator — assesses danger across multiple dimensions.
 *
 * Evaluates:
 *   - Hostile entities (entities marked as threatening)
 *   - Resource scarcity (low energy, time pressure)
 *   - Uncertainty (high novelty, low predictability)
 *   - Social rejection risk (negative social signals directed at self)
 *
 * Produces: fear, anxiety, vigilance
 *
 * Fear = immediate, identifiable threat
 * Anxiety = diffuse, uncertain threat
 * Vigilance = heightened alertness in response to elevated threat level
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface ThreatEvaluatorConfig {
    /** Weight for hostile entity threats */
    hostileWeight?: number;
    /** Weight for resource scarcity threats */
    scarcityWeight?: number;
    /** Weight for uncertainty threats */
    uncertaintyWeight?: number;
    /** Weight for social rejection threats */
    socialWeight?: number;
    /** Threshold above which fear triggers a significant event */
    fearEventThreshold?: number;
    bus?: CognitiveBus;
}
declare class ThreatEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "threat-evaluator";
    private _hostileWeight;
    private _scarcityWeight;
    private _uncertaintyWeight;
    private _socialWeight;
    private _fearEventThreshold;
    private _energyLevel;
    private _sleepPressure;
    private _stressLoad;
    private _deadlineUrgency;
    private _cognitiveLoad;
    private _cachedNovelty;
    private _cachedMetacognitionConfidence;
    private _socialEvaluationThreat;
    private _activeAgents;
    private _threatFromHostile;
    private _threatFromScarcity;
    private _threatFromUncertainty;
    private _threatFromSocial;
    private _bus;
    private readonly _model;
    constructor(config?: ThreatEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    /**
     * Scans state each tick for active hostile entities (type === 'threat',
     * metadata.hostile === true). Updates _threatFromHostile and re-emits
     * the full threat/emotion metrics so that downstream engines always see
     * a current picture even when no bus event arrives.
     *
     * `threat` is a HOST SEAM, not a starved input (#114). No core engine writes
     * one — appraisal runs entirely off this engine's six bus inputs (energy,
     * sleep, stress, novelty, metacognition, prediction), all of which are live.
     * A host embedding a Will in a world with actual hostile agents writes `threat`
     * entities to make them felt. Empty here means nothing is hostile, not that
     * nothing is wired.
     */
    react(_delta: Duration, _tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _computeScarcityThreat;
    private _computeUncertaintyThreat;
    private _computeSocialThreat;
    private _computeAndEmit;
}

/**
 * RewardEvaluator — detects positive outcomes and progress.
 *
 * Evaluates:
 *   - Goal progress and completion
 *   - Positive social feedback
 *   - Resource gains
 *   - Novel discoveries (when safe)
 *
 * Produces: joy, satisfaction, excitement
 *
 * Joy = immediate positive outcome
 * Satisfaction = goal completion / steady progress
 * Excitement = anticipated positive outcome + high arousal
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface RewardEvaluatorConfig {
    /** Weight for goal-related rewards */
    goalWeight?: number;
    /** Weight for social rewards */
    socialWeight?: number;
    /** Weight for resource gains */
    resourceWeight?: number;
    /** Weight for discovery/novelty rewards */
    discoveryWeight?: number;
    /**
     * How fast the social reward signal decays per tick (0-1).
     * Default 0.02 → social warmth fades to zero over ~50 ticks after last interaction.
     */
    socialDecayRate?: number;
    /** How much each positive directed interaction warms the social reward (warmth intensity) */
    socialWarmthBoost?: number;
    bus?: CognitiveBus;
}
declare class RewardEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "reward-evaluator";
    private _goalWeight;
    private _socialWeight;
    private _resourceWeight;
    private _discoveryWeight;
    private _socialDecayRate;
    private _socialWarmthBoost;
    /**
     * How fast goal-reward signal decays per tick (0-1).
     * Default 0.05 → a priority-1.0 goal reward fades to ~0 over ~20 ticks,
     * giving a noticeable joy/satisfaction window after each completion.
     */
    private _goalRewardDecayRate;
    private _cachedEnergyLevel;
    private _cachedNovelty;
    private _cachedFearLevel;
    /** Transient goal-achievement signal — spiked by goal.achieved, decays each tick. */
    private _cachedGoalReward;
    /** Transient social warmth — boosted by interaction.occurred, decays each tick. */
    private _cachedSocialReward;
    /** Count of goals completed recently — decays gradually, feeds satisfaction formula. */
    private _goalsCompletedRecently;
    private _previousGoalProgress;
    private _bus;
    private readonly _model;
    constructor(config?: RewardEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    /**
     * Effective config = base engine-config-reward ⊕ persona-prior (single-source).
     * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
     */
    private _readConfigFromState;
    react(_delta: Duration, _tick: Tick, state: ReadonlySimulationState, _ctx: SimulationContext): Promise<EngineResult>;
    private _computeResourceReward;
    private _computeDiscoveryReward;
    private _computeAndEmit;
}

/**
 * LossEvaluator — detects setbacks, failures, and losses.
 *
 * Evaluates:
 *   - Failed goals
 *   - Lost resources
 *   - Relationship damage
 *   - Missed opportunities
 *   - Degraded state (worsening metrics)
 *
 * Produces: sadness, disappointment, grief
 *
 * Sadness = generalized loss response
 * Disappointment = expected positive outcome that didn't materialize
 * Grief = significant permanent loss (relationship, major goal)
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface LossEvaluatorConfig {
    /** Threshold for significant loss events */
    significantLossThreshold?: number;
    /** How quickly sadness decays without re-triggering */
    decayRate?: number;
    bus?: CognitiveBus;
}
declare class LossEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "loss-evaluator";
    private _significantLossThreshold;
    private _decayRate;
    private _previousGoalProgress;
    private _previousRelationshipValence;
    private _energyLevel;
    private _stressLoad;
    private _interoceptionComfort;
    private _previousComfort;
    private _cachedGoalLoss;
    private _cachedRelationshipLoss;
    private _previousSadness;
    private _previousDisappointment;
    private _previousGrief;
    private _decayDeltaMs;
    private _bus;
    private readonly _model;
    constructor(config?: LossEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    private _computeResourceLoss;
    private _computeStateDegradation;
}

/**
 * FrustrationEvaluator — detects blocked goals and repeated failures.
 *
 * Evaluates:
 *   - Goals stuck without progress  (via goal.blocked events)
 *   - Repeated blocked events on same goal
 *   - Violated expectations (cached confidence × goal-loss signals)
 *   - Perceived unfairness  (via interaction.occurred events)
 *
 * Produces: frustration, anger, irritability
 *
 * Frustration = goal blockage without clear target
 * Anger = goal blockage with identifiable external cause
 * Irritability = accumulated low-grade frustration lowering threshold
 *
 * Part of Shard 1 (Affective Layer) — hybrid: event-driven inputs, temporal react.
 */

interface FrustrationEvaluatorConfig {
    /** Ticks without progress before frustration begins */
    stuckThreshold?: number;
    /** How quickly irritability accumulates */
    irritabilityRate?: number;
    /** Decay rate when frustration resolves */
    decayRate?: number;
    /**
     * Habituation rate — proportional to current irritability level.
     * Prevents the one-way ratchet to 1.0 under chronic goal blockage.
     * Natural ceiling: irritabilityRate / habituationRate (e.g. 0.02/0.03 ≈ 0.67).
     */
    habituationRate?: number;
    bus?: CognitiveBus;
}
declare class FrustrationEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "frustration-evaluator";
    private _stuckThreshold;
    private _irritabilityRate;
    private _decayRate;
    private _habituationRate;
    private _cachedFrustration;
    private _cachedAnger;
    private _cachedIrritability;
    private _blockedGoals;
    private _goalBlockedCounts;
    private _reactCount;
    private _unfairnessSignal;
    private _cachedConfidence;
    private _cachedGoalLoss;
    private _cachedDisappointment;
    private _bus;
    private readonly _model;
    constructor(config?: FrustrationEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _assessGoalBlockage;
    private _assessRepeatedFailures;
    private _assessViolatedExpectations;
}

/**
 * AttachmentEvaluator — models relationship bonds with other agents.
 *
 * Evaluates:
 *   - Interaction frequency and recency
 *   - Positive vs. negative interaction ratio
 *   - Dependency (how much the agent relies on this other)
 *   - Trust history (reliability over time)
 *   - Shared experience depth
 *
 * Produces: love, trust, belonging, loneliness
 *
 * Love = strong positive bond with specific other
 * Trust = confidence in another's reliability and benevolence
 * Belonging = sense of connection to a social group
 * Loneliness = absence of meaningful attachment
 *
 * Attachment builds gradually (repeated positive interactions) and
 * decays slowly (bonds persist through absence, but fade over time).
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface AttachmentEvaluatorConfig {
    /** How quickly attachment builds from positive interactions */
    attachmentGrowthRate?: number;
    /** How slowly attachment decays during absence */
    attachmentDecayRate?: number;
    /** Threshold for loneliness to become significant */
    lonelinessThreshold?: number;
    /** Minimum interactions to consider a bond meaningful */
    minInteractionsForBond?: number;
    /**
     * Baseline belonging from self-awareness (0–1).
     * Prevents loneliness from maxing out at boot with no social context.
     * 0.35 ≈ "I know who I am" — connected to self but still meaningfully alone.
     */
    selfBelonging?: number;
    bus?: CognitiveBus;
}
declare class AttachmentEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "attachment-evaluator";
    private _growthRate;
    private _decayRate;
    private _lonelinessThreshold;
    private _minInteractionsForBond;
    private _selfBelonging;
    private _bonds;
    private _restored;
    private _pendingInteractions;
    private _cachedActiveAgents;
    private _cachedBelonging;
    private _bus;
    private readonly _model;
    constructor(config?: AttachmentEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    /**
     * Attachment strength (0–1) toward a specific agent, or 0 if no bond exists.
     * Read-only accessor used by the AuditionEngine to weight conversational
     * salience by relationship closeness.
     */
    getAttachmentScore(keid: string): number;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _processSocialSignals;
    private _decayBonds;
    private _computeLove;
    private _computeTrust;
    private _computeBelonging;
    private _computeLoneliness;
    private _strongestBond;
    private _strongestBondStrength;
    private _restoreFromState;
    private _persistBonds;
}

/**
 * AestheticEvaluator — responds to novelty, complexity, pattern, and beauty.
 *
 * Evaluates:
 *   - Perceptual novelty (new patterns, unexpected combinations)
 *   - Complexity (information richness)
 *   - Pattern coherence (elegance, symmetry, resolution)
 *   - Cognitive challenge (optimal difficulty for engagement)
 *
 * Produces: awe, curiosity, interest, boredom
 *
 * Awe = overwhelming positive novelty + pattern (transcendent experience)
 * Curiosity = moderate novelty + safety (desire to explore)
 * Interest = sustainable engagement with moderately complex stimuli
 * Boredom = absence of novelty or excessive predictability
 *
 * The aesthetic drive fuels exploration, learning, and creative behavior.
 * It's modulated by safety (curiosity shuts down under high threat).
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface AestheticEvaluatorConfig {
    /** Threshold for awe (extreme novelty + coherence) */
    aweThreshold?: number;
    /** Optimal novelty range for curiosity [min, max] */
    curiosityRange?: [number, number];
    /** How quickly boredom escalates without stimulation */
    boredomRate?: number;
    /**
     * Minimum curiosity even with zero novelty (0–1).
     * Prevents full curiosity collapse — the Will retains baseline intellectual drive.
     */
    curiosityFloor?: number;
    bus?: CognitiveBus;
}
declare class AestheticEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "aesthetic-evaluator";
    private _aweThreshold;
    private _curiosityMin;
    private _curiosityMax;
    private _boredomRate;
    private _curiosityFloor;
    private _boredomExecutiveScale;
    private _recentStimulusCount;
    private _windowSize;
    private _categoryBuffer;
    private _cachedNovelty;
    private _cachedFear;
    private _cachedBoredom;
    private _bus;
    private _consecutiveBoredomTicks;
    private readonly _boredomEscalationThreshold;
    private readonly _boredomSignificantCutoff;
    private readonly _model;
    constructor(config?: AestheticEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _assessComplexity;
    private _assessCoherence;
    /**
     * Map novelty to a curiosity curve.
     * Peak curiosity at moderate novelty (not too boring, not too threatening).
     */
    private _curiosityCurve;
    /**
     * Compute variability in recent stimulus levels.
     * Low variability = predictable = boring.
     */
    private _computeStimulusVariability;
}

/**
 * MoralEvaluator — compares actions against internalized values and norms.
 *
 * Evaluates:
 *   - Own actions against personal standards
 *   - Others' actions against social norms
 *   - Value alignment and violation
 *   - Social comparison (am I better/worse than my standards?)
 *
 * Produces: guilt, shame, pride, indignation, disgust
 *
 * Guilt = "I did something bad" (action-focused, private)
 * Shame = "I am bad" (self-focused, social exposure)
 * Pride = "I did something good" (achievement against standards)
 * Indignation = "They did something wrong" (moral anger at others)
 * Disgust = "That violates a sacred value" (visceral moral rejection)
 *
 * Requires a value system — initialized with basic moral foundations
 * and extensible through learning.
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

interface MoralEvaluatorConfig {
    /** Moral foundations and their weights */
    foundations?: Record<string, number>;
    /** Threshold for moral emotions to trigger events */
    eventThreshold?: number;
    /** Rate at which moral emotions decay without re-trigger */
    decayRate?: number;
    bus?: CognitiveBus;
}
declare class MoralEvaluator implements SimulationEngine, CognitiveEngine {
    readonly name = "moral-evaluator";
    private _foundations;
    private _eventThreshold;
    private _decayRate;
    private _recentOwnActions;
    private _bus;
    private readonly _model;
    constructor(config?: MoralEvaluatorConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(delta: Duration, _tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _detectViolations;
    private _computeGuilt;
    private _computeShame;
    private _computePride;
    private _computeIndignation;
    private _computeDisgust;
}

/**
 * AffectiveBlender — integrates all discrete emotions into a unified
 * affective state.
 *
 * Reads the output of all other affective evaluators and produces:
 *   - Valence (-1 to +1): overall pleasantness/unpleasantness
 *   - Arousal (0-1): activation/intensity level
 *   - Dominance (0-1): sense of control/agency
 *
 * Handles:
 *   - Emotion blending (bittersweet = joy + sadness coexist)
 *   - Emotional inertia (emotions carry over between ticks)
 *   - Affective amplification (some emotions amplify others)
 *   - Somatic integration (interoceptive signals modulate emotions)
 *
 * This is the final output of the affective layer — the unified
 * "how I feel" that feeds into decision-making and conscious experience.
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 * Must run LAST among affective engines (priority 17).
 */

interface AffectiveBlenderConfig {
    /** Inertia factor — how much previous affect carries over (0-1) */
    inertia?: number;
    /** Whether to emit detailed blend events */
    emitBlendEvents?: boolean;
    bus?: CognitiveBus;
}
declare class AffectiveBlender implements SimulationEngine, CognitiveEngine {
    readonly name = "affective-blender";
    private _inertia;
    private _temperamentValence;
    private _emitBlendEvents;
    private _previousPAD;
    private _emotionHistory;
    private _moodBaseline;
    /** ACP-P2: self-caused arousal attenuation armed; react() restores after one observe. */
    private _acpOneShot;
    private _energyLevel;
    private _comfort;
    private _sleepPressure;
    private _stressLoad;
    private _socialArousalSurge;
    private _socialValenceBump;
    private _bus;
    private readonly _model;
    constructor(config?: AffectiveBlenderConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Compute raw PAD state from discrete emotion intensities.
     * Each emotion contributes to PAD proportional to its intensity
     * and its established PAD coordinates.
     */
    private _computeRawPAD;
    /**
     * Apply emotional inertia — emotions don't flip instantly.
     * The higher the inertia, the more the previous state carries over.
     */
    private _applyInertia;
    /**
     * Modulate PAD by interoceptive state.
     * The body state colors emotional experience:
     * - High sleep pressure dampens positive valence
     * - Low energy reduces arousal capacity
     * - High stress amplifies negative valence
     */
    private _applyInteroceptiveModulation;
    /**
     * Detect co-occurring emotions that produce blend phenomena.
     */
    private _detectBlends;
    /**
     * Find the most intense emotion.
     */
    private _dominantEmotion;
    private _updateHistory;
}

/**
 * WorkingMemory — limited-capacity active buffer for current cognition.
 *
 * Holds:
 *   - Current percepts (from perceptual engines)
 *   - Active goals (from executive layer)
 *   - Retrieved episodic memories (from long-term store)
 *   - Current affective state
 *
 * Properties:
 *   - Capacity-limited (7 ± 2 chunks by default)
 *   - Rapid decay without rehearsal (items fade in ~2-10 seconds)
 *   - Attentional boost (attended items resist decay)
 *   - Chunking (related items can be grouped into single slots)
 *   - Recency effect (newest items displace oldest when at capacity)
 *
 * Receives modulation from:
 *   - SleepPressureRegulator (fatigue reduces capacity)
 *   - StressRegulator (overload reduces effective capacity)
 *   - CircadianOscillator (alertness modulates rehearsal strength)
 *
 * Part of Shard 0 — runs every tick, synchronous.
 */

interface WorkingMemoryConfig {
    /** Maximum chunks in working memory (default 7, Miller's Law) */
    maxChunks?: number;
    /** Base decay rate per second (0-1, fraction of activation lost) */
    baseDecayRate?: number;
    /** How much attention focus slows decay (0-1, 0 = no protection) */
    attentionProtection?: number;
    /** Threshold below which an item is dropped */
    retrievalThreshold?: number;
    /** Whether to emit detailed WM events */
    emitEvents?: boolean;
    bus?: CognitiveBus;
}
interface WMItem {
    id: string;
    type: string;
    content: unknown;
    activation: number;
    attendedAt: Tick[];
    createdAt: Tick;
    sourceEntityId?: string;
    tags: string[];
}
declare class WorkingMemory implements SimulationEngine, CognitiveEngine {
    readonly name = "working-memory";
    private _maxChunks;
    private _baseDecayRate;
    private _attentionProtection;
    private _retrievalThreshold;
    private _emitEvents;
    private _items;
    private _modulatedCapacity;
    private _activeGoalCount;
    /**
     * Monotonic suffix counter for injected WM item ids. Replaces Math.random()
     * AND the former `Date.now()` component so a run replays identically (R2).
     * Unique per engine instance, which is sufficient for WM item ids.
     */
    private _idSeq;
    private _bus;
    private readonly _model;
    constructor(config?: WorkingMemoryConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    /** Returns all active WM items sorted by activation descending. */
    getItems(): WMItem[];
    /** Returns all active WM items of a given type, sorted by activation descending. */
    getItemsByType(type: string): WMItem[];
    /** Inject an item directly (used by integration tests and episodic retrieval). */
    load(item: Omit<WMItem, 'id' | 'createdAt'> & {
        createdAt?: Tick;
    }): void;
    /**
     * Effective config = base engine-config-working-memory ⊕ persona-prior (single-source).
     * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
     */
    private _readConfigFromState;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    /**
     * Read the latest percept entities from state and inject them as WM items.
     * Skips generic placeholder summaries to avoid noise.
     */
    private _ingestPercepts;
    /**
     * Read active goal entities from state and ensure each has a WM slot.
     * Goal items start at 0.65 activation — lower than percepts, higher than background.
     */
    private _ingestGoals;
    /**
     * Mark the currently focused entity's WM item as attended this tick, from the
     * `attention.focus` entities AttentionAllocator writes. (A second, bus-driven
     * branch used to sit above this one, labelled "preferred"; the event behind it was
     * never published, so this loop has always been the only path — see #114.)
     */
    private _applyAttention;
    /**
     * Items that have been attended 3+ times receive a small activation boost
     * — simulating active rehearsal keeping them in working memory.
     */
    private _rehearseItems;
    /**
     * Write each live WM item as a state entity so downstream engines can read them,
     * and delete any stale WM entities that no longer correspond to live items.
     */
    private _persistItems;
    private _evictIfNeeded;
}

/** Forwards each entry to the consumer (the stem bridges it onto the transport). */
type SessionLogEmit = (record: Record<string, unknown>) => void;
type LogEntryType = 'session.start' | 'session.end' | 'tick' | 'event' | 'executive.call' | 'executive.response' | 'executive.output' | 'executive.facet.spawn' | 'executive.facet.call' | 'executive.facet.response' | 'executive.facet.output' | 'executive.facet.destroy' | 'action.execute' | 'action.error' | 'action.outcome' | 'belief.integrate' | 'conversation.in' | 'conversation.out' | 'plan.step.activated' | 'plan.step.outcome' | 'goal.progress' | 'goal.achieved' | 'goal.blocked' | 'goal.abandoned' | 'outbox.push' | 'outbox.expire';
interface BaseEntry {
    type: LogEntryType;
    wallTime: number;
    tick?: number;
}
type LogEntry = BaseEntry & Record<string, unknown>;
interface SessionLoggerOptions {
    /**
     * Forward every entry to the consumer (typically the stem, which emits it as a
     * `session_log` envelope on the transport). May also be set later via
     * {@link SessionLogger.attachEmit} once the Will instance exists.
     */
    emit?: SessionLogEmit | null;
    /** Also write a local NDJSON file. Dev convenience only; off in production. */
    fileLogging?: boolean;
    /** Override the data directory for the dev file (default `./data`). */
    dataDir?: string;
}
declare class SessionLogger {
    readonly sessionId: string;
    /** Local file path — empty string when file logging is disabled. */
    readonly filePath: string;
    private readonly _stream;
    private _emit;
    private _closed;
    private _count;
    constructor(willId: string, dataDir?: string, opts?: SessionLoggerOptions);
    /**
     * Late-bind the consumer forwarder (the stem sets this once the Will instance
     * exists, so it can emit a `session_log` envelope on the instance's transport).
     */
    attachEmit(emit: SessionLogEmit): void;
    write(entry: Omit<LogEntry, 'wallTime'>): void;
    /**
     * Emits `session.end` and closes the local file stream (if any). Persistence
     * of the streamed entries is the consumer's responsibility — the Will no longer
     * uploads anywhere itself.
     */
    close(): void;
    get entryCount(): number;
    get isClosed(): boolean;
}

interface SemanticIntegratorConfig {
    minIntervalTicks?: number;
    minNewEpisodes?: number;
    maxBeliefs?: number;
    /** Ticks without reinforcement before a belief starts losing confidence */
    beliefStalenessThreshold?: number;
    /** Confidence lost per tick once a belief goes stale */
    beliefDecayRate?: number;
    /** Minimum similarity threshold for semantic pattern detection (0-1) */
    semanticSimilarityThreshold?: number;
    /** Maximum episodes to query for semantic pattern detection */
    semanticQueryLimit?: number;
    bus?: CognitiveBus;
}
interface BeliefHistoryEntry {
    tick: Tick;
    confidence: number;
    delta: number;
    cause: string;
}
interface Belief {
    id: string;
    statement: string;
    category: 'world_fact' | 'self_belief' | 'social_belief' | 'causal_rule' | 'pattern';
    confidence: number;
    supportingEpisodes: number;
    lastUpdatedAt: Tick;
    tags: string[];
    /** Bounded trajectory of confidence changes. Max 20 entries; oldest dropped when full.
     *  Becomes a first-class PMM input — the causal story of how a belief formed. */
    history?: BeliefHistoryEntry[];
}

interface Cluster {
    id: string;
    episodes: EpisodicMemory[];
    centroid: number[];
    prototypeStatement: string;
    valenceMean: number;
    valenceStd: number;
    dominantEmotions: Array<[string, number]>;
    dominantTags: Array<[string, number]>;
    sourceTypes: Array<[string, number]>;
    firstSeen: Tick;
    lastSeen: Tick;
    episodeCount: number;
    stabilityScore: number;
}
interface SemanticClusteringConfig {
    /** Minimum episodes to form a cluster */
    minClusterSize?: number;
    /** Minimum similarity threshold for cluster membership (0-1) */
    clusterSimilarityThreshold?: number;
    /** Maximum distance from centroid to be considered in cluster (0-1) */
    maxCentroidDistance?: number;
    /** Minimum number of temporal windows for trend detection */
    minTrendWindows?: number;
    /** Ticks per temporal window for trend analysis */
    trendWindowTicks?: number;
    bus?: CognitiveBus;
}
declare class SemanticClustering {
    readonly name = "semantic-clustering";
    private _minClusterSize;
    private _clusterSimilarityThreshold;
    private _maxCentroidDistance;
    private _minTrendWindows;
    private _trendWindowTicks;
    private _episodicConsolidator;
    private _bus;
    private _clusters;
    private _idSeq;
    private readonly _model;
    constructor(config?: SemanticClusteringConfig);
    attachBus(bus: CognitiveBus): void;
    attachConsolidator(consolidator: EpisodicConsolidator): void;
    /**
     * Main entry point: discover clusters from recent episodes.
     * Called by SemanticIntegrator during heuristic pattern detection.
     */
    discoverClusters(tick: Tick, recentEpisodes: EpisodicMemory[]): Promise<Belief[]>;
    private _findClusters;
    private _fallbackClustering;
    private _buildCluster;
    private _buildClusterFromContent;
    private _clusterToBelief;
    private _generatePrototypeStatement;
    private _detectTemporalTrends;
    private _computeLinearTrend;
    private _trendToBelief;
    private _detectAnomalies;
    private _anomalyToBelief;
    private _episodeToText;
    private _episodeToQuery;
    private _contentSimilarity;
    getClusters(): ReadonlyArray<Cluster>;
    clearClusters(): void;
}

declare class SemanticIntegrator implements SimulationEngine, CognitiveEngine {
    readonly name = "semantic-integrator";
    private _minIntervalTicks;
    private _minNewEpisodes;
    private _maxBeliefs;
    private _beliefStalenessThreshold;
    private _beliefDecayRate;
    private _semanticSimilarityThreshold;
    private _semanticQueryLimit;
    private _beliefs;
    private _lastIntegrationTick;
    private _episodeCountAtLastIntegration;
    private _semanticClustering;
    private _episodicConsolidator;
    private _sessionLogger;
    private _restored;
    /**
     * Monotonic suffix counter for belief ids. Replaces Math.random() AND the
     * former `Date.now()` component so the same seed+inputs reproduce the same
     * belief ids on replay (R2). Combined with the id prefix it is unique per
     * engine instance, which is sufficient for belief ids.
     */
    private _idSeq;
    private _bus;
    private readonly _model;
    constructor(config?: SemanticIntegratorConfig);
    attachBus(bus: CognitiveBus): void;
    attachConsolidator(consolidator: EpisodicConsolidator): void;
    attachSemanticClustering(ct: SemanticClustering): void;
    attachSessionLogger(logger: SessionLogger | null): void;
    /**
     * Called by ExecutiveEngine when it produces new beliefs.
     * Confidence is capped by evidence count before integration — prevents the
     * executive from asserting high-certainty beliefs from thin episodic support.
     */
    integrateExecutiveBelief(belief: Belief, tick?: number, cause?: string): void;
    /**
     * Evidence-based confidence ceiling.
     * Thin evidence cannot support high confidence regardless of how the executive reasons.
     * Mirrors how scientific confidence scales with replications, not just reasoning quality.
     */
    /**
     * Rehydrate _beliefs from 'belief' entities in state.
     * Called once on the first tick after a snapshot restore so that beliefs
     * formed in previous sessions survive a server restart.
     */
    private _restoreFromState;
    private _capConfidenceByEvidence;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    /**
     * Effective config = base engine-config-semantic ⊕ persona-prior (single-source).
     * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
     */
    private _readConfigFromState;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _shouldRunHeuristic;
    private _heuristicPatternDetection;
    /**
     * UPGRADE: Semantic pattern detection using vector memory.
     *
     * Identifies clusters of semantically similar episodes that share
     * emotional or thematic patterns not captured by simple tag/type matching.
     *
     * Falls back to traditional heuristics if vector memory not available
     * or if no meaningful clusters are found.
     */
    private _semanticPatternDetection;
    /**
     * Build a semantic query string from recent episodes for pattern detection.
     * Combines content snippets and tags to create a representative query.
     */
    private _buildSemanticQueryForPatterns;
    private static readonly _MAX_HISTORY;
    /** Append a history entry to a belief, dropping the oldest if the buffer is full. */
    private static _recordHistory;
    private _integrateBelief;
    /**
     * Determines whether two beliefs are similar enough to merge.
     *
     * Primary gate: same category + at least one shared substantive tag.
     * If tags overlap by ≥ 50%, we trust the category+tag match and skip
     * text comparison — this prevents Jaccard word-overlap from merging
     * semantically unrelated beliefs that share filler words.
     * Weak tag overlap falls back to stop-word-filtered content similarity.
     */
    private _shouldMerge;
    /**
     * Jaccard similarity on content words — stop words stripped before comparison
     * so common filler ("I", "my", "the", "have") can't drive false merges.
     */
    private _contentSimilarity;
    /**
     * Restore beliefs verbatim from a PMA / snapshot — NOT through the live
     * executive-integration path. A stored belief is a known prior state: its id
     * and final confidence must be preserved exactly. integrateExecutiveBelief()
     * would corrupt a faithful reconstruction two ways: (a) _shouldMerge absorbs
     * semantically-similar stored beliefs into one another, dropping ids and
     * averaging confidence, and (b) it re-caps confidence by evidence count. The
     * live merge/decay dynamics resume once the Will ticks.
     */
    restoreBeliefs(beliefs: Belief[]): void;
    getBeliefs(): ReadonlyArray<Belief>;
    queryBeliefs(filters: {
        category?: string;
        tags?: string[];
        minConfidence?: number;
    }): Belief[];
}

/**
 * GoalManager — maintains the active goal hierarchy.
 *
 * Manages:
 *   - Goal activation and deactivation based on drives and context
 *   - Goal priority ordering (conflict resolution)
 *   - Progress tracking
 *   - Goal completion and abandonment
 *   - Sub-goal decomposition
 *
 * Goals are entities in the state manager. The GoalManager reads
 * drive signals from regulatory engines and perceptual context to
 * determine which goals should be active, then updates their
 * priorities and tracks progress.
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
 */

interface GoalManagerConfig {
    /** Maximum active goals at once */
    maxActiveGoals?: number;
    /** How quickly goal priority decays without reinforcement */
    priorityDecayRate?: number;
    /** Minimum priority before a goal is deactivated */
    deactivationThreshold?: number;
    /**
     * Resilience / grit. A goal whose priority ≥ gritPriority is NEVER auto-abandoned
     * by staleness — the mind only lets it go by a deliberate executive decision.
     * Below that, the staleness patience window scales with priority by
     * gritPatienceScale (important stuck goals are pursued much longer).
     */
    gritPriority?: number;
    gritPatienceScale?: number;
    /** Frustration tolerance [0–1]: how much the frustration emotion is allowed to
     *  compress the patience window. High tolerance → setbacks don't make the mind
     *  give up faster. A personality dimension (seeded by PMA, developed by metacog). */
    frustrationTolerance?: number;
    /**
     * How many new beliefs must form after a goal activates for it to be
     * considered complete. Applies only to epistemic (non-drive) goals.
     */
    epistemicBeliefThreshold?: number;
    bus?: CognitiveBus;
}
interface GoalState {
    id: string;
    description: string;
    priority: number;
    basePriority: number;
    progress: number;
    status: 'active' | 'blocked' | 'completed' | 'abandoned' | 'pending' | 'pending_verification';
    parentGoalId?: string;
    subGoals: string[];
    activatedAt: Tick;
    deadline?: Tick;
    tags: string[];
    /** Why this goal was abandoned, when it was. Set only on status 'abandoned'.
     *  The reason used to be pushed onto `tags`, which threw once the goal had
     *  been rehydrated from a deep-frozen state entity. */
    abandonedReason?: string;
    /** Snapshot of memory.beliefs_total when this goal was activated.
     *  Used to compute epistemic progress: (currentBeliefs - baseline) / threshold. */
    beliefsAtActivation: number;
    /**
     * How this goal knows it is done — set at creation time, not inferred from tags.
     *
     * 'metric'    — a measurable state crosses a threshold (completionCondition).
     * 'action'    — a real-world outcome must occur; stays 0% if impossible and
     *               is abandoned through frustration rather than belief formation.
     * 'epistemic' — resolved through understanding: belief formation about the
     *               situation, the self, or the world.
     */
    completionType: 'metric' | 'action' | 'epistemic' | 'pending_verification';
    /** For 'metric' goals: e.g. "stress.load < 40" or "energy.level > 80".
     *  Parsed and evaluated each tick to compute smooth progress. */
    completionCondition?: string;
    /** Tick of the most recent action.outcome that matched this goal's tags.
     *  Lets the executive see "I tried this N ticks ago" without scanning decision.records. */
    lastActionAttemptTick?: number;
    /** ActionType of the most recent attempt (e.g. 'text', 'talk', 'observe'). */
    lastActionType?: string;
    /**
     * Causal link back to the entity whose message triggered this goal.
     * Populated when a conversation escalation creates the goal (AuditionEngine → executive).
     * Used by PlanningEngine to tag plan bus events so the activity SSE stream can
     * filter and forward them to the correct requesting entity.
     */
    requestingEntityId?: string;
    /** Thread ID of the conversation turn that triggered this goal (for reply correlation). */
    requestingThreadId?: string;
}
declare class GoalManager implements SimulationEngine, CognitiveEngine {
    readonly name = "goal-manager";
    private _maxActiveGoals;
    private _priorityDecayRate;
    private _basePriorityDecayRate;
    private _deactivationThreshold;
    private _gritPriority;
    private _gritPatienceScale;
    private _frustrationTolerance;
    private _epistemicBeliefThreshold;
    private _goals;
    private _goalCounter;
    /** Updated every tick — used as the baseline for newly created goals. */
    private _currentBeliefCount;
    /** IDs of goals for which goal.achieved has already been published, so we
     *  don't re-fire the event on every subsequent tick. */
    private _achievedGoalIds;
    /** IDs of goals for which goal.completed has already been emitted. Same
     *  once-per-goal guard as _achievedGoalIds — completedGoals accumulates across
     *  ticks, so without this the event re-fires every tick for every completed
     *  goal (the goal-completion churn). */
    private _completedEmittedIds;
    private _goalLastProgress;
    private _goalStuckSince;
    private _energyLevel;
    private _sleepPressure;
    private _stressLoad;
    private _executiveGoalConfidence;
    /** Tracks current simulation tick so addGoal() can stamp activatedAt correctly. */
    private _currentTick;
    private _bus;
    private _sessionLogger;
    private readonly _model;
    attachSessionLogger(logger: SessionLogger | null): void;
    constructor(config?: GoalManagerConfig);
    attachBus(bus: CognitiveBus): void;
    private readonly _STUCK_THRESHOLD;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _detectBlockedGoals;
    /**
     * Add a goal to the manager.
     */
    addGoal(description: string, basePriority: number, tags?: string[], parentGoalId?: string, deadline?: Tick, completionType?: GoalState['completionType'], completionCondition?: string, id?: string, requestingEntityId?: string, requestingThreadId?: string): string;
    /**
     * Get all active goals sorted by priority.
     */
    getActiveGoals(): GoalState[];
    getGoal(id: string): GoalState | undefined;
    /**
     * Mark a goal as completed.
     */
    completeGoal(goalId: string): void;
    /**
     * Abandon a goal with an optional reason.
     */
    abandonGoal(goalId: string, reason?: string): void;
    /**
     * Update a goal's priority.
     */
    updateGoalPriority(goalId: string, newPriority: number): void;
    private _syncFromStateGoals;
    private _activateFromDrives;
    private _activateFromPercepts;
    private _updatePriorities;
    /**
     * Plan completion (0..1) for a goal, read from the live `plan` entity (planning.engine).
     * Sunk cost: a goal with a half-finished plan is costlier to abandon, so it amplifies the
     * task-persistence commitment boost. 0 when the goal has no plan or an empty one.
     */
    private _focusedPlanProgress;
    private _resolveConflicts;
    private _updateProgress;
    /**
     * Evaluate progress for a metric goal.
     *
     * If the goal has a completionCondition (e.g. "stress.load < 40"), parse and
     * compute smooth 0-1 progress toward it. Falls back to tag-based heuristics
     * for the three built-in drive metrics when no condition is specified.
     */
    /**
     * 4.1: Nudge progress on `action`-type goals when an action.outcome event fires
     * whose domain or actionType overlaps with the goal's tags.
     *
     * Progress is incremented by `outcomeQuality × 0.12` per matched action, so
     * a goal with a single matching tag needs ~9 successful actions (at full quality)
     * to complete — a realistic bar for discrete, real-world tasks.
     *
     * Substring matching (both directions) handles common mismatches between
     * effector names and goal tags (e.g. "communicate" ↔ "communication",
     * "learn" ↔ "learning").
     */
    private _nudgeActionGoals;
    /** True when a metric completionCondition (e.g. "emotion.boredom < 40") is already met. */
    private _isConditionMet;
    private _evaluateMetricProgress;
    /**
     * Refresh personality-derived dispositions from `engine-config-goal-manager`
     * (base params ⊕ persona-prior deltas). Grit/persistence is a per-Will trait
     * seeded by the PMA and developed by the metacognition cycle — not a constant.
     */
    private _readConfigFromState;
    private _deactivateStale;
    private _persistGoals;
}

interface Plan {
    id: string;
    goalId: string;
    steps: PlanStep[];
    estimatedCost: number;
    confidence: number;
    /** Full lifecycle: draft → validated → approved → ready → executing → completed/failed/rejected */
    status: 'draft' | 'validated' | 'approved' | 'ready' | 'executing' | 'paused' | 'completed' | 'failed' | 'rejected' | 'revised';
    executionTier: 'deliberate' | 'automatic';
    /** Concrete description of what successful completion looks like — set by executive */
    expectedOutcome: string;
    createdAt: Tick;
    /**
     * Causal link — the entity whose message triggered the goal that spawned this plan.
     * Copied from GoalState.requestingEntityId at plan-creation time.
     * Stamped on all bus events so the activity SSE stream can filter by entity.
     */
    requestingEntityId?: string;
    /** Matching thread ID for reply correlation. */
    requestingThreadId?: string;
}
interface PlanStep {
    id: string;
    order: number;
    /**
     * Advisory suggested schema — the action this step would LIKE to recruit. It is
     * projected as a `plan.prior` that biases the competition toward this schema; it
     * is NOT dispatched. If the schema does not resolve in the repertoire the prior
     * cannot surface and the plan waits / replans (no forced execution of a string).
     */
    action: string;
    description: string;
    expectedOutcome: string;
    prerequisites: string[];
    estimatedDuration: number;
    /** `active` = on the frontier, biasing the competition this tick (was `dispatched`). */
    status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
    /** Optional entity the step's action is directed at — biases goal-relevance + binds the affordance. */
    targetEntityId?: string;
    /** Optional schema tags to route the prior (currently unused by projection; reserved). */
    tags?: string[];
    /** Re-attempt count (the `retry` directive); capped by maxStepRetries. */
    retries?: number;
    /** The outcome from ActionExecutor when the step completes */
    outcome?: {
        success: boolean;
        description: string;
        outcomeQuality: number;
    };
}
/**
 * A normalised activity event forwarded to activity-stream listeners.
 * Maps 1-to-1 onto the SSE event types emitted by GET /wills/:id/activity.
 */
interface ActivityEvent {
    /** SSE event type name. */
    type: 'plan_started' | 'step_activated' | 'step_outcome' | 'plan_complete' | 'plan_failed' | 'plan_cancelled';
    planId: string;
    goalId?: string;
    requestingEntityId?: string;
    requestingThreadId?: string;
    /** Additional per-event fields (steps, outcomes, etc.). */
    [key: string]: unknown;
}
type ActivityEventHandler = (event: ActivityEvent) => void;
interface PlanningEngineConfig {
    bus?: CognitiveBus;
    /**
     * Ticks a terminal (completed/failed/rejected) plan is retained before it and
     * its state entity are GC'd. Bounds unbounded plan accretion on long-lived
     * minds. Default 300.
     */
    planRetentionTicks?: number;
    /**
     * Emergent-supervision thresholds. The executive no longer sets the tier; the
     * engine starts a plan `deliberate` when its goal is important (top-down) or the
     * plan is uncertain, and escalates an `automatic` plan to `deliberate` on a
     * surprising step outcome (bottom-up). All extensible in _inferInitialTier /
     * _shouldEscalate.
     */
    deliberateGoalPriority?: number;
    lowPlanConfidence?: number;
    surpriseOutcomeQuality?: number;
    maxStepRetries?: number;
}

declare class PlanningEngine implements SimulationEngine, CognitiveEngine {
    readonly name = "planning-engine";
    private _planRetentionTicks;
    /**
     * Trait-driven dispositions (Channel A) — ONE mutable object, refreshed from
     * the persona-prior mirror each tick (_readConfigFromState) and read live by
     * the supervisor + frontier projection. See PlanningDispositions.
     */
    private readonly _dispositions;
    private _goalManager;
    private _executiveEngine;
    /** Canonical plan state — store, goal index, terminal bookkeeping, GC, persistence. */
    private readonly _store;
    /** Deliberate-tier judgment — facet lifecycle, reports, directive dispatch. */
    private readonly _supervisor;
    /** Plan ids needing a recall descriptor emitted (created/revised this cycle). */
    private _newPlanDescriptors;
    /**
     * Last tick react() ran — used only to stamp session-log telemetry (never
     * replay state) from off-tick callbacks like _activateStep / _onStepOutcome.
     */
    private _lastTick;
    /** One-time deletion of legacy `plan-executive-*` entities (see react step 0a). */
    private _legacyPlanSweepDone;
    /**
     * Monotonic suffix counter for activity-listener subscription ids. These ids
     * are transient bus-subscription keys (HTTP/SSE-driven, never entering the
     * event log or snapshot), so they must NOT draw from the seeded PRNG — that
     * would consume sim-random draws and perturb determinism. A plain counter
     * replaces Math.random() here (R2).
     */
    private _subCounter;
    private _energyLevel;
    private _bus;
    private _sessionLogger;
    private readonly _model;
    private _lastIngestedOutput;
    constructor(config?: PlanningEngineConfig);
    attachGoalManager(gm: GoalManager): void;
    attachExecutiveEngine(oe: ExecutiveEngine): void;
    attachSessionLogger(logger: SessionLogger | null): void;
    /**
     * Give the engine its CognitiveBus. Called by the orchestrator's addEngine()
     * during assembly (every other faculty already exposes this). Without it the
     * bus stayed null, so plan-lifecycle events (plan.started / plan.step.* /
     * plan.completed) never published and addActivityListener no-op'd.
     */
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    /**
     * Cancel every still-active plan for a goal that has reached a terminal state
     * (achieved/abandoned). Marks them rejected (→ retention GC cleans the entity)
     * and tears down any step-aware facet. A plan whose own completion triggered the
     * goal is already terminal and is skipped, so this only reaps siblings still
     * pursuing a goal that's now done/dropped. (planning↔goal sync)
     */
    private _cancelPlansForGoal;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Channel A (subconscious disposition): refresh trait-driven supervision params
     * from the persona-prior mirror (base `engine-config-planning` ⊕ metacog deltas).
     * Demonstrated conscientiousness develops planning follow-through — it raises
     * `maxStepRetries` (re-attempt a stuck step more before giving up) and
     * `surpriseOutcomeQuality` (vigilance: escalate to deliberate supervision on
     * smaller quality dips). Only present params override; absent config/prior leaves
     * the constructor defaults standing. Pure + deterministic (R2): same state ⇒ same
     * dispositions, no wall-clock, no RNG.
     */
    private _readConfigFromState;
    private _ingestExecutivePlans;
    private _createPlan;
    private _executePlans;
    /**
     * Move a ready step onto the frontier: it starts biasing the competition (via
     * `projectFrontier`) instead of being dispatched. Emits `plan.step.activated`
     * for the activity stream — the awareness analog of the old `plan.step.dispatched`.
     */
    private _activateStep;
    private _onStepOutcome;
    private _onPlanCompleted;
    private _onPlanFailed;
    /**
     * Emit a stable, embeddable descriptor for newly created/revised plans as a
     * `working_memory.item`, so the EpisodicConsolidator indexes it into vector
     * memory and a later message can RECALL the plan (→ `context.relevantPlanIds` →
     * the Active Plans awareness filter). Only the stable descriptor (goal +
     * expectedOutcome) is embedded — never the live step state (which changes every
     * tick) — so recall stays match-stable while the projector renders live state.
     * The WorkingMemory faculty GCs the item after consolidation, so it doesn't
     * accrete. Follows the established external-injection pattern (AuditionEngine).
     */
    private _flushPlanDescriptors;
    /** The goal's active plan, or its most-recent plan if all are terminal. */
    getPlan(goalId: string): Plan | undefined;
    /** All plans for a goal (any status), in creation order. (P4) */
    getPlansForGoal(goalId: string): Plan[];
    /**
     * Subscribe to plan activity events for a specific requesting entity.
     *
     * Subscribes to the internal CognitiveBus and forwards all plan-lifecycle
     * events (`plan.started`, `plan.step.activated`, `plan.step.outcome`,
     * `plan.completed`, `plan.failed`) that were triggered by `entityId` to
     * the provided `handler`.
     *
     * Used by WillManager to back the `GET /wills/:id/activity` SSE stream.
     *
     * @returns Unsubscribe function — call it to remove the subscription.
     */
    addActivityListener(entityId: string, handler: ActivityEventHandler): () => void;
}

declare class CompletionInbox {
    private _queue;
    /** Number of completions waiting to land. */
    get size(): number;
    /**
     * Stage a completion effect for the next tick boundary. Called from async
     * resolution contexts (facet decision emission); never applies inline.
     */
    enqueue(label: string, apply: () => void): void;
    /**
     * Apply every staged completion in FIFO order. Called by the
     * CognitiveOrchestrator at the top of Phase 2, before the bus flush — so any
     * bus events a thunk publishes deliver in the same phase. A throwing thunk is
     * isolated: it never blocks the rest of the queue or the tick.
     *
     * Thunks enqueued DURING the drain (e.g. a listener triggering another facet
     * whose mock resolves synchronously) land next tick — the snapshot taken this
     * drain cycle stays coherent.
     */
    drain(tick: number): number;
    /** Drop staged completions (mind teardown). Returns how many were discarded. */
    clear(): number;
}

/**
 * Where a single call should go. Every field except `model` falls back to the
 * Will's default when omitted.
 */
interface ModelRoute {
    /**
     * Omit to keep the Will's default provider and change only the model — the
     * common "same vendor, different model for this kind of work" route, and what
     * the per-role model map compiles to (a role has never had a provider of its
     * own). Name a provider to cross vendors; it must appear in `llm.providers`
     * or the route falls back to the default.
     */
    provider?: LLMProvider;
    model: string;
    /** Override the provider's API base (self-hosted / OpenAI-compatible servers). */
    baseUrl?: string;
    /** Override the output-token ceiling for this call. */
    maxOutputTokens?: number;
}
/**
 * Chooses a model for a call.
 *
 * Returning `null` means "no opinion" — the Will's default model is used. A
 * router should return `null` rather than guess when it does not recognise a
 * call: falling back is always safe, and a wrong route is not.
 */
interface ModelRouter {
    /** Stable identifier, recorded alongside routing telemetry. */
    readonly name: string;
    route(meta: LLMCallMeta): ModelRoute | null;
}
/**
 * The default. Has no opinion about anything, allocates nothing.
 *
 * A Will running this must be byte-identical to one built before the routing
 * seam existed — that property is asserted by test, and it is what lets this
 * ship dark.
 */
declare const NULL_ROUTER: ModelRouter;
/** True when the router is the no-op default (used to skip the seam entirely). */
declare function isNullRouter(router: ModelRouter | null | undefined): boolean;
/**
 * One entry in a {@link TableRouter}'s table. All present conditions must match
 * (logical AND); an absent condition matches anything.
 */
interface RoutingRule {
    /**
     * Match `LLMCallMeta.category` exactly (e.g. 'executive', 'summarizer').
     *
     * The axes are typed rather than free strings so a rule that names a bucket
     * the engine never emits fails to compile instead of silently never matching
     * — a routing table's worst failure is the rule that looks right and is dead.
     */
    category?: LLMCallMeta['category'];
    /** Match `LLMCallMeta.attribute` exactly (e.g. 'master', 'facet', 'guard'). */
    attribute?: LLMCallMeta['attribute'];
    /** Match `LLMCallMeta.process` exactly (e.g. 'decision', 'ideation'). */
    process?: LLMCallMeta['process'];
    /** Match `LLMCallMeta.function` exactly (e.g. 'decision', 'consolidation'). */
    function?: LLMCallMeta['function'];
    /**
     * Inclusive lower bound on `LLMCallMeta.demand`. A call with no demand
     * reported never matches a rule that sets this — absent means unknown, and
     * unknown must not be treated as zero.
     */
    minDemand?: number;
    /** Exclusive upper bound on `LLMCallMeta.demand`. Same absence rule. */
    maxDemand?: number;
    /** Where a matching call goes. */
    route: ModelRoute;
}
/**
 * A worked example of the seam: first matching rule wins, otherwise no opinion.
 *
 * This ships so that the interface has a reference implementation and so that
 * hosts have something to copy — it is deliberately dumb. It is not a routing
 * strategy, and the engine ships no table of its own: what belongs where is the
 * host's decision, expressed as configuration.
 *
 * Rules are evaluated in order, so put specific rules before general ones.
 */
declare class TableRouter implements ModelRouter {
    readonly name: string;
    private readonly _rules;
    constructor(rules: readonly RoutingRule[], name?: string);
    route(meta: LLMCallMeta): ModelRoute | null;
}
/**
 * Ask each router in turn; the first with an opinion wins.
 *
 * This exists because a Will can have two sources of routing at once: the
 * host's own router, and the one compiled from its per-role model map. Order
 * expresses precedence — an explicit router is consulted before the role map,
 * which is the precedence those two mechanisms already had when roles were
 * served by separate directors.
 *
 * A throwing link is skipped, not propagated. The links are independent
 * decisions, and one broken router must not take a working one down with it —
 * that would silently demote every role-mapped call to the default model.
 */
declare function chainRouters(...routers: (ModelRouter | null | undefined)[]): ModelRouter;

/**
 * The request/response dialect an endpoint speaks. This — not the provider's
 * name — is what the transport actually branches on.
 */
type LLMWire = 'anthropic' | 'openai' | 'google';
/** Providers with built-in defaults. Any other string is equally valid. */
type KnownProvider = 'anthropic' | 'glm' | 'openai' | 'google' | 'deepseek' | 'moonshot' | 'qwen' | 'xai' | 'minimax' | 'mistral' | 'ollama' | 'vllm';
/**
 * A provider name. Deliberately open: the field of providers changes monthly,
 * and a closed union meant a host reaching Kimi or Qwen had to masquerade as
 * `openai`, which then lied on the completion tape and in cost attribution.
 *
 * `(string & {})` keeps editor autocomplete for the known names while accepting
 * anything. A provider outside {@link KNOWN_PROVIDERS} simply has to declare its
 * `wire` and `baseUrl` — see `WillLLMConfig.providers`.
 */
type LLMProvider = KnownProvider | (string & {});
/**
 * Built-in wire + base URL per provider. This is *data*, not support: it saves
 * a host from looking up an endpoint, and nothing more. Any provider absent
 * from this table works identically once the host declares `wire` + `baseUrl`
 * on its `llm.providers` entry.
 *
 * WHY THIS TABLE SURVIVES WHEN THE PRICE TABLE DID NOT. A stale price is
 * invisible: it produces a confident wrong number nobody doubts. A stale base
 * URL fails on the first call, loudly, with the endpoint in the message. They
 * also move on completely different clocks — vendors reprice quarterly, and
 * change an API host about once a decade. Convenience is worth it when being
 * wrong is self-announcing.
 *
 * REGIONAL ENDPOINTS. `moonshot`, `qwen` and `minimax` all run separate
 * mainland-China hosts (`api.moonshot.cn`, `dashscope.aliyuncs.com`,
 * `api.minimaxi.com`). The international host is the default here; a key issued
 * on the other one authenticates nowhere, so a host on a China account must set
 * `baseUrl` explicitly.
 */
declare const KNOWN_PROVIDERS: Record<string, {
    wire: LLMWire;
    baseUrl: string;
}>;
/** Built-in wire for a known provider, or undefined — the host must declare it. */
declare function knownWireFor(provider: LLMProvider): LLMWire | undefined;
/** Built-in base URL for a known provider, or undefined — the host must declare it. */
declare function defaultBaseFor(provider: LLMProvider): string | undefined;
interface LLMDirectorConfig {
    willId: string;
    model: string;
    maxOutputTokens: number;
    apiKey: string;
    provider: LLMProvider;
    sessionLogger: SessionLogger | null;
    /** When true, all LLM calls return canned deterministic responses — no API cost. */
    mock?: boolean;
    /**
     * Override the provider's API base URL (including the version segment, e.g.
     * `http://localhost:11434/v1` for Ollama). Defaults to the provider's
     * official endpoint. This is what lets `deepseek` actually reach DeepSeek
     * and lets `openai` point at any OpenAI-compatible server.
     */
    baseUrl?: string;
    /**
     * Timeout in ms. On the Anthropic streaming path this is a *first-byte*
     * (time-to-first-token) deadline — a long-but-healthy completion is never
     * aborted mid-generation. Other providers treat it as a whole-request
     * deadline. Default 90s.
     */
    timeoutMs?: number;
    /**
     * Per-Will token tracker (R4). When provided, completed live calls record
     * their usage/cost here. Omitted/null → recording is skipped (e.g. mock or
     * replay runs). This replaces the former process-global getTokenTracker().
     */
    tokenTracker?: TokenTracker | null;
    /**
     * MODEL_ROUTING W3 — per-call model selection. Absent (or NULL_ROUTER) means
     * every call uses the default model below, exactly as before the seam existed.
     * A router that throws, or names a provider with no usable credential, falls
     * back to the default: a routing problem must never kill a running mind.
     */
    router?: ModelRouter | null;
    /**
     * Per-provider credentials for routed calls. The top-level `apiKey`/`baseUrl`
     * remain the default entry; a route to a provider absent from this map falls
     * back to the default endpoint.
     */
    credentials?: Partial<Record<string, ProviderCredential>>;
    /**
     * Dialect for the default provider. Required when the provider is not one of
     * {@link KNOWN_PROVIDERS} — the engine will not guess how to talk to an
     * endpoint it has never heard of.
     */
    wire?: LLMWire;
}
/**
 * Everything a single call needs to reach a model. Resolved once per call and
 * threaded through the provider methods — never stored on the instance, because
 * the concurrency gate lets several calls be in flight on one director at once
 * and per-call state on `this` would race between them.
 */
/** What a host supplies so a routed provider can be reached. */
interface ProviderCredential {
    apiKey: string;
    baseUrl?: string;
    /** Required for providers outside {@link KNOWN_PROVIDERS}. */
    wire?: LLMWire;
}
interface LLMCallResult {
    text: string;
    inputTok: number;
    outputTok: number;
    /** Anthropic prompt-cache: tokens served from cache (~0.1× cost). Telemetry. */
    cacheReadTok?: number;
    /** Anthropic prompt-cache: tokens written to cache this call (~1.25× cost). Telemetry. */
    cacheWriteTok?: number;
}
/**
 * Cost-attribution metadata for a single LLM call. The same director instance is
 * shared by the master executive, every facet (conversation/planning/outreach),
 * the summarizer, and the ideation/propose pass — so the *call site* tags itself
 * here, letting the TokenTracker break spend down per category for transparency.
 */
interface LLMCallMeta {
    /** Top-level cost bucket. */
    category: LLMCallCategory;
    /** The actor/subsystem doing the work. */
    attribute: LLMCallAttribute;
    /** The specific cognitive function. */
    process: LLMCallProcess;
    /** The specific cognitive function. */
    function: LLMCallFunction;
    /** Optional specific id or namespace: facet id, entity id, model name. */
    scope?: string;
    /** Free-form human-readable label. Auto-composed from the axes when omitted. */
    label?: string;
    /**
     * How much this call demands, 0..1 — MODEL_ROUTING W0.
     *
     * A *cognitive* measure, never a commercial one: it says how consequential or
     * uncertain this moment is, never who is paying for it.
     *
     * What actually reports it today:
     *   · the master and every facet — including the deliberation facet — forward
     *     `effortScore`, the a-priori effort gate (uncertainty, prior confidence,
     *     novelty, a pending reply, stress load);
     *   · structurally background work (summarising, the identity guard) reports a
     *     low constant, because it is background whether the mind is calm or in
     *     crisis.
     *
     * Note what is NOT here: agency's `stakes( winner, bias )` — the consequence
     * of the specific choice under contest — is computed in
     * `agency/selection.scoring.ts` and never reaches a call. So a deliberation
     * facet currently reports the tick's general effort, not the stakes of the
     * choice it is deliberating. Carrying it is MODEL_ROUTING W1, still open.
     * This comment previously claimed deliberation passed those stakes; it does
     * not, and a doc comment that ships to npm is a bad place to be aspirational.
     *
     * Absent means UNKNOWN, not zero: a consumer must fall back to its default
     * rather than treat a missing value as "cheapest possible".
     *
     * This field is inert with respect to cognition. It rides along to whoever
     * resolves the model for a call; no engine may read it back and behave
     * differently, or the routing layer becomes a hidden input to the mind.
     */
    demand?: number;
}
/** Structurally background work — see `LLMCallMeta.demand`. */
declare const BACKGROUND_DEMAND = 0.1;
/**
 * Escalation is elevated by construction: the buffer only fires once something
 * has already failed to resolve on its own.
 */
declare const ESCALATION_DEMAND = 0.7;
declare class LLMDirector {
    private _willId;
    private _model;
    private _maxOutputTokens;
    private _apiKey;
    private _provider;
    private _sessionLogger;
    private _mock;
    private _baseUrl;
    private _timeoutMs;
    private _tokenTracker;
    private _router;
    private _credentials;
    /** Default endpoint — what every call used before the routing seam existed. */
    private _defaultEndpoint;
    /** Routes already warned about (missing credential / bad provider) — log once. */
    private _routeWarned;
    constructor(config: LLMDirectorConfig);
    /**
     * Resolve which model serves this call. Falls back to the default endpoint
     * whenever the router has no opinion, throws, or names a provider we hold no
     * credential for — degrade, never crash.
     */
    private _resolveEndpoint;
    private _warnRouteOnce;
    /**
     * Returns a structurally valid executive output with zero API cost.
     * Used when `mock: true` — e.g. for `bw_test_` key holders and the Playground.
     *
     * The response rotates through a small set of cognitively distinct actions so
     * the Will's state panel shows believable variety across ticks.
     */
    /**
     * Returns a deterministic mock LLM response parseable by the executive engine.
     *
     * Format for a conversation-facet turn (AuditionEngine): the facet focus renders
     *   Speaker: <name> (id: <entityId>)
     *   Current message: "<content>"
     * and CONVERSATION_OUTPUT_FORMAT expects a JSON reasoning object followed by a
     * [REPLY_TEXT] block — the block is the only part that reaches the speaker
     * (streamed live, then landed in the outbox by the facet decision).
     *
     * Format for background ticks (no conversation focus):
     *   {"actions":[{"type":"...","reasoning":"...","expectedOutcome":"..."}],...}
     *   Strategy 1 (JSON.parse) handles this directly.
     */
    private _mockResponse;
    /**
     * Stream tokens from the LLM. Calls `onChunk` for each text delta as it
     * arrives, then returns the full result once the stream is done.
     * Currently Anthropic only — other providers fall back to a single-chunk call.
     */
    callStream(systemPrompt: string, userMessage: string, tick: number, onChunk: (chunk: string) => void, 
    /** Optional sampling temperature. Omitted ⇒ the provider's default. */
    temperature?: number, 
    /** Cost-attribution tag for this call. Defaults to the master executive. */
    meta?: LLMCallMeta): Promise<LLMCallResult>;
    /**
     * Record a completed live call's token usage + cost into this Will's tracker,
     * tagged with the caller's attribution (category/label). Optional — absent on
     * mock/replay directors, so the call is simply skipped. Cache read/write tokens
     * are forwarded so the tracker prices them at 0.1× / 1.25× input.
     */
    private _track;
    /** Pre-cache prompt size estimate (chars/4) — mirrors the old token-report `ourEstTok`. */
    private _estPromptTokens;
    /**
     * Capture an LLM completion into the active replay recorder for this Will,
     * when one is registered (see core/completion.recorder). No-op otherwise.
     * The LLM is the non-deterministic oracle; recording its input+output is the
     * prerequisite for deterministic re-execution (REORIENT R2, deferred).
     */
    private _recordCompletion;
    /**
     * Replay re-feed (REORIENT R2-c). When a completion source is registered for
     * this Will, return the recorded completion for `tick` instead of calling the
     * non-deterministic model. The source verifies the prompt and throws on a miss
     * or divergence, so a replay can never silently re-call the LLM. Returns
     * `undefined` when no source is registered (the normal live path).
     */
    private _replayCompletion;
    private _callAnthropicStream;
    /**
     * Call the LLM directly via fetch — no SDK, no middleware.
     * Routes through withGate for concurrency limiting and 429 retry.
     */
    call(systemPrompt: string, userMessage: string, tick: Tick, 
    /** Optional sampling temperature. Omitted ⇒ the provider's default (behaviour
     *  unchanged). Used by the deliberate path's ideation (propose) pass to diverge. */
    temperature?: number, 
    /** Cost-attribution tag for this call. Defaults to the master executive. */
    meta?: LLMCallMeta): Promise<LLMCallResult>;
    private _callProvider;
    /** Resolved API base: explicit override wins, else the provider default. */
    private _resolvedBase;
    /**
     * fetch() with a hard per-request deadline. A hung connection is aborted
     * after _timeoutMs and surfaced as a clear error instead of hanging forever.
     * Mirrors the embedder hardening in vector.embedder.ts.
     */
    private _fetchWithTimeout;
    /**
     * Anthropic `system` field with a single prompt-cache breakpoint. The system
     * prompt is fully stable per context (PromptFactory keeps every volatile section
     * — including `## Current Focus` — in the user message), so one ephemeral
     * breakpoint caches the whole thing: reused across master ticks and shared
     * across a Will's conversation facets. GA — no beta header required.
     */
    private _systemField;
    private _callAnthropic;
    private _callOpenAI;
    private _callGoogle;
    /**
     * Write the full prompt to a debug file for inspection.
     * Mirrors the original _writeDebugPrompt behavior.
     */
    writeDebugPrompt(tick: Tick, systemPrompt: string, userMessage: string): string;
    /**
     * Write the full LLM response text to `response-tick-N.txt` alongside the
     * corresponding `prompt-tick-N.txt`. This gives developers the complete
     * reasoning trace without truncation — useful for debugging planning failures.
     */
    writeDebugResponse(tick: Tick, responseText: string, inputTok: number, outputTok: number, latencyMs: number): void;
}

interface SummarizerConfig {
    /** How many executive calls between summarization runs. Default: 10 */
    summaryInterval?: number;
    /** How many reasoning excerpts to keep in the rolling buffer. Default: 12 */
    bufferSize?: number;
    /** Max chars to keep per reasoning entry before truncating. Default: 600 */
    maxCharsPerEntry?: number;
}
declare class ExecutiveSummarizer {
    private _buffer;
    private _summary;
    private _callCount;
    private _summarizing;
    private _llmDirector;
    private readonly _interval;
    private readonly _bufferSize;
    private readonly _maxCharsPerEntry;
    constructor(config?: SummarizerConfig);
    /**
     * Inject the LLMDirector. Called by ExecutiveEngine once its director is ready.
     * The summarizer silently skips runs until this is set.
     */
    attachLLMDirector(director: LLMDirector): void;
    /**
     * Record one executive reasoning pass.
     * Triggers background summarization when the interval is hit.
     */
    record(reasoning: string): void;
    /**
     * The current rolling summary, ready to embed in a system prompt.
     * Empty string until the first summarization has completed.
     */
    get current(): string;
    /** Total number of executive calls recorded so far. */
    get callCount(): number;
    /** Whether a summarization is currently running. */
    get isBusy(): boolean;
    /**
     * Restore state from a persisted snapshot (called by ExecutiveEngine on first tick
     * after a restart). Picks up the summary and buffer without triggering a new LLM call.
     */
    restore(summary: string, buffer: string[], callCount: number): void;
    /**
     * Return a plain object suitable for persisting to a state entity.
     * ExecutiveEngine writes this to 'executive-rolling-summary' each cycle.
     */
    snapshot(): {
        summary: string;
        buffer: string[];
        callCount: number;
    };
    /**
     * Pure preview of what snapshot() *would* return after record( reasoning ),
     * without mutating internal state or triggering a background summarization.
     *
     * Used by the executive command builder so the persisted
     * 'executive-rolling-summary' entity can describe the post-record state while
     * the actual record() is deferred until the tick is known to commit (FN11).
     * The async summary refresh in record() does not change `summary`
     * synchronously, so a verbatim snapshot()-after-record() is reproduced here.
     */
    projectedSnapshot(reasoning: string): {
        summary: string;
        buffer: string[];
        callCount: number;
    };
    private _run;
}

interface ExecutiveOutputFull {
    actions: Array<{
        type: string;
        reasoning: string;
        expectedOutcome: string;
        target?: string;
        /**
         * Arguments the executive consciously supplies when enacting an ability
         * that needs them (e.g. a search ability's query). Ride the ideomotor
         * intent into the affordance competition and, if the action wins, reach
         * the host handler as the invocation's parameters.
         */
        args?: Record<string, unknown>;
    }>;
    reasoning: string;
    confidence: number;
    /** Plans — the executive controls lifecycle via status + action fields */
    plans?: ExecutivePlanOutput[];
    newBeliefs?: Array<{
        statement: string;
        category: string;
        confidence: number;
        /**
         * Evidence strength — replaces the hallucination-prone numeric count.
         * The LLM picks a categorical label it can honestly assign; the runtime
         * maps it to a numeric `supportingEpisodes` value for the belief store.
         */
        evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern';
        tags: string[];
    }>;
    introspection?: {
        explanation: string;
        identifiedBiases: string[];
        lessonsLearned: string[];
        recommendations: string[];
    };
    narrative?: string;
    narrativeThemes?: string[];
    currentSelfView?: string;
    identityUpdates?: {
        traits: Array<{
            key: string;
            value: number;
        }>;
        values: string[];
    };
    /**
     * What the Will consciously learned about the *others* it is dealing with (the analogue
     * of identityUpdates, but about someone/something else). `keid` is the referent from the
     * known-entity dossier / "## People I Know" context. `name` is a learned identifying
     * name; `learned` are facts (→ keid-tagged social beliefs, so they ride the memory
     * pipeline); `feeling` is a felt valence toward them (a bounded nudge).
     */
    knownEntityUpdates?: Array<{
        keid: string;
        name?: string;
        learned?: string[];
        feeling?: number;
    }>;
    newGoals?: Array<{
        description: string;
        priority: number;
        tags: string[];
        completionType: string;
        completionCondition?: string;
    }>;
    goalsToAbandon?: Array<{
        goalId: string;
        reason: string;
    }>;
    goalsToReprioritize?: Array<{
        goalId: string;
        newPriority: number;
        reason: string;
    }>;
    selfObservations?: string[];
    /** Compound actions the mind is naming as single skills (see ProposedSkill). */
    newSkills?: ProposedSkill[];
    /**
     * Plain-text reply from a conversation facet — populated by parseResponse()
     * from the [REPLY_TEXT]...[/REPLY_TEXT] block.
     * Only present in facet mode (AuditionEngine). Undefined for master cycles.
     * Paragraphs (double-newline separated) map to separate reply bubbles.
     */
    replyText?: string;
    /**
     * @deprecated Legacy JSON reply format — no longer emitted by conversation facets.
     * Kept for backward compatibility with any tests/tooling that inspect parsed output.
     */
    conversationReplies?: Array<{
        targetEntityId: string;
        targetEntityName: string;
        messages: string[];
    }>;
    /**
     * System 2 only — the distinct approaches the master generated and weighed before
     * committing, retained for explainability/auditability (and a future regret /
     * counterfactual substrate). Populated on the deliberate (propose→evaluate) path;
     * undefined for System 1 (the fast single-shot).
     */
    consideredAlternatives?: string[];
}
/**
 * Plan output from the executive LLM.
 *
 * This is what the LLM produces in the [PLANS] tagged block.
 * It includes lifecycle control fields (status, action, executionTier,
 * expectedOutcome) that only the executive sets, plus the step structure
 * that feeds into PlanningEngine's Plan type.
 */
interface ExecutivePlanOutput {
    /**
     * Target an EXISTING plan for validate/execute/revise/cancel. Omit on a fresh
     * `draft` to create a new plan. Enables managing multiple plans per goal (P4);
     * when omitted, the op falls back to the goal's active plan.
     */
    planId?: string;
    goalId: string;
    /** Lifecycle stage the executive is setting */
    status: 'draft' | 'validated' | 'approved' | 'revised' | 'rejected';
    /** What PlanningEngine should do with this plan */
    action: 'draft' | 'validate' | 'execute' | 'revise' | 'cancel';
    /** Concrete description of what successful completion looks like */
    expectedOutcome?: string;
    /** The steps — mirrors PlanStep structure from PlanningEngine */
    steps: Array<Pick<PlanStep, 'action' | 'description' | 'expectedOutcome' | 'estimatedDuration' | 'prerequisites'>>;
    estimatedCost: number;
    feasibility: number;
}
interface ExecutiveEngineConfig$1 {
    executiveInterval?: number;
    cooldownTicks?: number;
    bus?: CognitiveBus;
}
/**
 * A compound action the mind names as one thing it does — "when I do A then B,
 * that is <name>". Registered into the SchemaRepertoire as a composite, after
 * which it competes as a single affordance and can proceduralize into a habit.
 *
 * This is the creation seam for the instrumental→habitual gradient. Before it,
 * `agency.composite.proposed` was subscribed by ReafferenceEngine — whose handler
 * is the only caller of `registerComposite()` anywhere — and published by nothing,
 * so no Will could ever hold a skill beyond the innate floor (#114).
 */
interface ProposedSkill {
    /** What the mind calls it. Becomes the schema id. */
    id: string;
    /** The sub-schemas it is made of, in order. Two or more, or it is not compound. */
    composedOf: string[];
    tags?: string[];
    cost?: number;
}

/**
 * PromptFactory — single source of truth for all executive prompts
 * (master and facets).
 *
 * Any cognitive entity that reasons (master executive, facets, future
 * satellite reasoning engines) uses this factory to ensure:
 *   - Same identity grounding
 *   - Same memory continuity
 *   - Same value system
 *   - Same cognitive capacity awareness
 *   - Same output schema and guidelines
 *
 * Only the FOCUS section and injected report context differ between
 * reasoning instances — this preserves the unified inference and
 * singularity between master and facet.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  System prompt  — static identity + role + output schema │
 * │  User message   — live state + dynamic guidance + focus  │
 * └─────────────────────────────────────────────────────────┘
 *
 * Mode:
 *   'master' — full cognitive prompt; goals, percepts, memories, escalations.
 *              No [REPLY] block — master responds via plans/goals/actions only.
 *   'facet'  — same awareness baseline; creator engine injects domain context
 *              via reportContent and optionally overrides outputFormat.
 *              Conversation facets (AuditionEngine) handle all [REPLY] output.
 *
 * Voice convention (person follows ownership):
 *   The executive loop has no second party — the "user" message is the mind's
 *   own state feed, not an interlocutor. So:
 *   - Self-model content (identity, role, affect/beliefs/percepts headers,
 *     action outcomes, felt state) is FIRST PERSON — it is the mind's own text.
 *   - Protocol content (JSON format, tag lists, lifecycle mechanics) is
 *     IMPERATIVE and person-free — rules of the body, not thoughts of the self.
 *   - SECOND PERSON is reserved for real addressees only (a user speaking,
 *     developer-facing docs) and never appears in the cognitive prompts.
 *   Guards that inspect persona text (identity.guard, identity.coherence)
 *   must keep matching BOTH persons — legacy personas and adversarial inputs
 *   choose their own grammar.
 */

type AwarenessScope = 'goals' | 'plans' | 'beliefs' | 'percepts' | 'ruminations' | 'memories' | 'recentActions';
interface FocusSection {
    /** Title of the focus section (e.g., "Active Plan", "Bias Analysis") */
    title: string;
    /** Content of the focus section (what this reasoning instance is concentrating on) */
    content: string;
    /**
     * Optional: cost-attribution *function* for this facet, set by the creating
     * engine (e.g. 'conversation' for AuditionEngine, 'planning' for PlanningEngine,
     * 'outreach' for proactive outreach, 'deliberation' for the substrate). Threaded
     * into the facet's LLM calls as `LLMCallMeta.function` so the TokenTracker can
     * break spend down per facet type. Defaults to 'facet' when unset.
     */
    function?: LLMCallFunction;
    /**
     * Optional: Custom output format to append instead of the standard executive format.
     * Pass via PromptBuildOptions.outputFormat when building the user message.
     */
    outputFormat?: string;
    /**
     * Optional: Additional instructions specific to this focus.
     * Injected into the USER MESSAGE as "## Focus Instructions" — not the system prompt.
     * These are per-focus recurring instructions (e.g. "Evaluate whether the plan step succeeded").
     */
    instructions?: string;
    /**
     * Optional: episodic-recall query for this focus. When set (e.g. a conversation
     * facet passes the current message), it drives the single "## Relevant Memories"
     * section so recall is focus-relevant — replacing any separate per-focus recall
     * block. Threaded into buildFreshContext → buildExecutiveContext.
     */
    recallQuery?: string;
    /**
     * Optional: which cognitive-context sections this facet should see in its user
     * message (e.g. `['plans']`). Defaults to DEFAULT_FACET_AWARENESS when unset;
     * ignored in master mode (master always gets FULL_AWARENESS). See AwarenessScope.
     */
    awareness?: AwarenessScope[];
    /**
     * Optional: scope entity-filtered awareness sections (currently `plans`) to a
     * single requester — e.g. a conversation facet passes the speaker's id so it
     * only sees that person's plans. When unset, those sections show all.
     */
    awarenessEntityId?: string;
    /**
     * Optional: WHO this facet is engaged with — the keid and the name the mind has
     * learned for them. Reported back to the master on every `executive.facet.sync`.
     *
     * Without it the master was told, in its own system prompt, that "focused facets
     * may run simultaneously… their reasoning syncs back to me" while the sync payload
     * carried only a facetId and a confidence number — so a mind holding two live
     * conversations could not tell you whose they were. The master is the singular
     * seat: it has to know who is at the table to reason about them together.
     */
    subjectEntityId?: string;
    subjectName?: string;
    /**
     * Optional: Provided by the creating engine to convert the LLM's parsed output
     * into a domain-specific decision payload.
     *
     * The `output` parameter is `ExecutiveOutputFull` typed as `unknown` to keep
     * FocusSection free of circular imports. Cast it in your implementation.
     *
     * If omitted, the facet falls back to a generic passthrough of
     * { actions, newGoals, goalsToAbandon, newBeliefs }.
     */
    extractDecision?: (output: unknown) => unknown;
}

/**
 * Generic report interface — the facet doesn't interpret this.
 * The creator engine defines the structure and interprets responses.
 */
interface FacetReport {
    /** The reason for this report (creator-defined) */
    type: string;
    /** The payload content (creator-defined structure) */
    payload: unknown;
    /** Optional context identifier for routing */
    contextId?: string;
    /** Optional dynamic instructions to append to the user message */
    instructions?: string;
}
interface FacetDecision {
    facetId: string;
    /** The reason/report type this decision responds to */
    respondingToType: string;
    /** The decision payload (creator-defined structure) */
    decision: unknown;
    reasoning: string;
    confidence: number;
}
type FacetEventListener = (decision: FacetDecision) => void;
interface ExecutiveFacetHandle {
    /** Push a report into the facet — triggers a reasoning cycle */
    report: (report: FacetReport) => void;
    /** Subscribe to facet decisions — returns unsubscribe function */
    subscribe: (listener: FacetEventListener) => () => void;
    /** The facet's unique identifier */
    facetId: string;
    /** Destroy the facet — unsubscribes from bus, cleans up */
    destroy: () => void;
    /** Set the focus for this facet (called by creator before first report) */
    setFocus: (focus: FocusSection) => void;
    /** Set the current state reference (called by orchestrator) */
    setStateRef: (state: ReadonlySimulationState) => void;
    /**
     * Register a per-facet chunk handler.
     * Called when the creating engine wants per-entity token streaming
     * (e.g. AuditionEngine, one handler per conversation session).
     * Fires for every LLM token during `_reason()` — in addition to any
     * global `_chunkBroadcaster` wired via `setChunkBroadcaster()` on the
     * master ExecutiveEngine.
     */
    onChunk: (handler: (chunk: string) => void) => void;
    /**
     * Register a callback fired when the supervisor REAPS this facet (idle TTL or
     * LRU eviction), as opposed to an explicit `destroy()`. Lets the owner (e.g.
     * AuditionEngine) drop its handle reference + session state when the facet is
     * reclaimed out from under it. Not fired by `destroy()`.
     */
    onReaped: (handler: () => void) => void;
}

/**
 * DeliberationCache — types and contracts.
 *
 * The cache stores past executive outputs keyed by a deterministic
 * cognitive fingerprint. It is pure, deterministic, and R2-safe:
 * the same state + same history ⇒ same retrieval + same composition.
 *
 * Scope note: Phase 1 caches the ACTIONS block only. The composed output
 * is a valid `ExecutiveOutputFull` carrying the three required fields
 * (actions, reasoning, confidence) plus whatever optional blocks the
 * enabled scopes cover. Everything else stays undefined and the existing
 * downstream (`buildStateCommands`) treats it as "nothing to do", which is
 * exactly the intended Phase-1 behaviour.
 */

/** Which blocks of the executive output the cache may synthesise. */
type CacheScope = 'actions' | 'goals' | 'beliefs';
interface DeliberationCacheConfig {
    /** Maximum patterns to retain. Lowest (competence × recency) evicted when full. */
    maxPatterns?: number;
    /** Neighbors retrieved for composition. */
    k?: number;
    /** Minimum similarity for a stored pattern to count as a neighbor. */
    minSimilarity?: number;
    /** Confidence threshold θ — cache hit requires ρ ≥ θ. Start conservative. */
    theta?: number;
    /** Temperature for softmax weights over neighbors. */
    tau?: number;
    /** Learning rate (EMA) for competence updates. */
    eta?: number;
    /** Competence decay per executive cycle (applied via decay()). */
    decayPerCycle?: number;
    /** Verify 1-in-N cache hits against the LLM (0 = never). */
    verifyEveryNHits?: number;
    /** Which output blocks to synthesise. Phase 1 default: ['actions']. */
    scopes?: CacheScope[];
}

interface ExecutiveEngineConfig {
    executiveInterval?: number;
    cooldownTicks?: number;
    bus?: CognitiveBus;
}
declare class ExecutiveEngine extends AsyncEngine implements CognitiveEngine {
    readonly name = "executive-engine";
    private _executiveInterval;
    private _cooldownTicks;
    private _gatingState;
    private _consumedBufferEntries;
    private _llmDirector;
    private _testMode;
    private _recentActionTypes;
    private _coherenceVersion;
    private _lastEpistemicUncertainty;
    private _lastExecutiveOutput;
    private _lastExecutiveTick;
    private _cache;
    private _cacheRestored;
    private _pendingVerify;
    private _lastCacheHit;
    private _lastCacheConfidence;
    private _lastCacheNeighborCount;
    private _willId;
    /**
     * The Will's default model (config.model's `executive` role, resolved in
     * mind.ts). Every other role reaches its model through the router — see
     * `compileRoleRouter`.
     */
    private _modelId;
    /** Per-Will LLM transport overrides (config.llm) — env fallbacks apply per field. */
    private _llm;
    private _workingMemory;
    private _goalManager;
    private _episodicConsolidator;
    private _semanticIntegrator;
    private _planningEngine;
    private _summarizer;
    private _sessionLogger;
    private _bus;
    /** Tick-boundary landing for facet decisions — injected by the orchestrator. */
    private _inbox;
    private _tokenTracker;
    private readonly _facetSupervisor;
    /**
     * Who each live facet is engaged with, learned from `executive.facet.sync`.
     * Keyed by facetId; the last sync wins. Rendered into the master's own prompt so
     * the singular seat can reason across its conversations "as if they were sitting
     * at the same table" — which it cannot do while it only knows facet numbers.
     * Stale entries age out on read (see _activeConversations).
     */
    private _facetSubjects;
    private readonly _model;
    private readonly _generativeModel;
    private _summarizerRestored;
    private _lastStateRef;
    /**
     * The tick currently being processed, refreshed every react() — distinct from
     * `_lastStateRef` (which tracks the REASONING tick and must not move under
     * onReasoningComplete) and from `_lastExecutiveTick` (the last cycle that ran).
     *
     * Off-tick arrivals — a facet handoff, in particular — need to be stamped with
     * when they actually happened. Using `_lastExecutiveTick` for that dated them to
     * the last master cycle, which can be hundreds of ticks behind.
     */
    private _currentTick;
    private readonly _deferred;
    private _chunkBroadcaster;
    private readonly _escalations;
    /** Set/clear the chunk broadcaster (called by WillManager when SSE clients connect). */
    setChunkBroadcaster(fn: ((chunk: string) => void) | null): void;
    constructor(config?: ExecutiveEngineConfig);
    attachWorkingMemory(wm: WorkingMemory): void;
    attachGoalManager(gm: GoalManager): void;
    attachEpisodicConsolidator(ec: EpisodicConsolidator): void;
    attachSemanticIntegrator(si: SemanticIntegrator): void;
    attachPlanningEngine(pe: PlanningEngine): void;
    attachSummarizer(s: ExecutiveSummarizer): void;
    attachSessionLogger(logger: SessionLogger | null): void;
    attachTokenTracker(t: TokenTracker): void;
    /** Enable test mode — all LLM calls return canned mock responses at zero cost. */
    setTestMode(enabled: boolean): void;
    /** Called by CognitiveOrchestrator.addEngine() — injects the shared bus. */
    attachBus(bus: CognitiveBus): void;
    /**
     * Called by CognitiveOrchestrator.addEngine() — injects the completion inbox
     * so facet decision effects land at tick boundaries (Phase 2) instead of at
     * raw LLM-promise resolution. See cognition/completion.inbox.ts.
     */
    attachCompletionInbox(inbox: CompletionInbox): void;
    set willId(willId: string);
    /**
     * The Will's default model. Set before the first tick.
     *
     * This replaced a four-role map (W7): the other roles are routing rules now,
     * compiled in mind.ts, so the engine holds one model and one router rather
     * than a model per role plus a router.
     */
    set modelId(id: string | null);
    get modelId(): string | null;
    /** Per-Will LLM transport overrides (config.llm). Set before the first tick. */
    set llm(c: {
        provider?: string;
        apiKey?: string;
        baseUrl?: string;
        maxOutputTokens?: number;
        timeoutMs?: number;
        credentials?: Partial<Record<string, ProviderCredential>>;
        router?: ModelRouter | null;
        wire?: LLMWire;
    } | null);
    get latestOutput(): ExecutiveOutputFull | null;
    isFresh(currentTick: Tick): boolean;
    /**
     * Spawn a focused facet of the executive consciousness.
     *
     * Creates an independent reasoning instance that shares the master's
     * cognitive state (identity, values, beliefs, memories) but operates
     * outside the tick cycle. The facet syncs bidirectionally with the
     * master via cognitive bus events.
     *
     * Returns a handle with report() and subscribe() methods.
     * The caller (PlanningEngine) uses report() to push step outcomes
     * and subscribe() to receive facet decisions.
     */
    /** Get-or-create the director for a model id (shared config, per-Will). */
    /**
     * The provider, from config or environment — never guessed.
     *
     * This used to default to 'anthropic', which is how a Will configured for one
     * vendor could quietly talk to another. An unset provider is a configuration
     * error, and saying so at construction is far cheaper than a 401 mid-tick.
     */
    private _requireProvider;
    /**
     * True when this Will cannot make a live call, so provider/model are not
     * required: mock mode, or a replay re-feeding recorded completions.
     */
    private _noLiveCalls;
    /**
     * Build this Will's one and only director.
     *
     * There used to be a cache of them, keyed by model, because the per-role
     * model map had no other way to make a role use a different model. Routing
     * gave it one — the role map now compiles to rules (see `compileRoleRouter`)
     * and a single director resolves every call's endpoint per call. That is also
     * strictly more faithful: a facet follows the work it is doing rather than
     * whatever role it happened to be spawned under.
     */
    private _buildDirector;
    /**
     * Spawn a facet.
     *
     * `role` declares the facet's intent at the call site. It no longer selects a
     * model: that used to happen here, pinning a facet for life to whatever role
     * it was spawned under, and it now happens per call from the focus function
     * the caller sets immediately afterwards (W7). The two always agreed — every
     * spawn site sets a focus whose `function` matches its role — so the routed
     * answer is the same one, decided later and from the work itself.
     */
    spawnFacet(role?: 'deliberation' | 'conversation' | 'outreach' | 'supervision', 
    /**
     * What this facet is FOR — see `FacetSpawnDeps.key`. Two spawns with the same
     * key get the same facet, so callers no longer each invent their own dedup
     * (and `authorOutreach`, which had none, no longer opens a rival facet on a
     * person the mind is already talking to).
     */
    key?: string): {
        attention: 'available' | 'full';
        handle?: ExecutiveFacetHandle;
    };
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    snapshot(): Record<string, unknown>;
    onCognitiveEvent(event: CognitiveEvent): StateCommands | void;
    /**
     * Tick entry point (FN11). Before delegating to AsyncEngine.react(), flush any
     * deferred manager side-effects whose tick is now confirmed committed (and drop
     * any whose tick aborted). `state` is the start-of-tick committed snapshot, so
     * its `executive.last_tick` metric reflects whether our prior commands landed.
     */
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * What the mind is attending to because a facet is reasoning about it, as
     * `attention.demand` entities the AttentionAllocator allocates real capacity
     * against (`_extractSalienceSignals` reads this type; `costPerFocus` is then
     * charged against the same 100-unit budget as perceptual foci).
     *
     * This closes a loop that was open in one direction only: the allocator's
     * `freeFraction` scaled the facet budget, but facets never appeared in
     * `_activeFocus`, so holding three conversations reported exactly as much spare
     * attention as holding none. The budget was being scaled by a signal blind to the
     * thing it was bounding.
     *
     * `urgency` sits below 1 on purpose: a live conversation is a genuine claim on
     * attention but must not automatically outrank every percept — the allocator sorts
     * candidates by salience into `maxFoci` slots, and a facet that always won would
     * starve perception. Only BUSY facets are charged; an open-but-quiet thread is one
     * the mind is in, not one it is attending to.
     */
    private _facetAttentionDemands;
    protected shouldAct(state: ReadonlySimulationState, tick: Tick, _context: SimulationContext): boolean;
    protected readState(state: ReadonlySimulationState, tick: Tick): ReasoningFootprint;
    protected reasonAsync(footprint: ReasoningFootprint, state: ReadonlySimulationState, context: SimulationContext, stream: IntermediateStream): Promise<unknown>;
    protected onIntermediateResult(step: string, result: unknown, _footprint: ReasoningFootprint, _context: SimulationContext): StateCommands | null;
    protected onReasoningComplete(output: unknown, footprint: ReasoningFootprint, _context: SimulationContext): StateCommands;
    /**
     * The people the mind is in conversation with right now, newest first.
     *
     * Pruned against the supervisor's live facets on every read: a reaped facet is a
     * conversation that has ended, and a master that still believes it is mid-thread
     * with someone reasons about a table that is no longer there.
     */
    private _activeConversations;
    /**
     * Facet sync — remember WHO each facet is with, and wake the master.
     *
     * Reached from `onCognitiveEvent`, NOT from its own `bus.subscribe`. The bus
     * stores one subscription per engineId (`_subscriptions.set( engineId, … )`),
     * so a second `subscribe(this.name, …)` silently REPLACES the first — and the
     * orchestrator registers `subscribe( engine.name, engine.subscribes(), … )`
     * after `attachBus`, which replaced everything registered here. Two dedicated
     * handlers used to be installed at this point; the second overwrote the first
     * and the orchestrator then overwrote that, so neither ever ran. The escalation
     * leg had been dead in production for its whole life: a facet could escalate,
     * the audition engine published, and nothing was listening.
     */
    /**
     * Retire undertakings the mind has already honoured, and refuse to restate one
     * it is already carrying.
     *
     * An undertaking percept says, in the first person, "I said I would reach X and
     * nothing has gone to them yet". That sentence has to stop being true at some
     * point, and nothing made it stop. Measured on a live Will: SEVEN of them
     * accumulated in state, every one still asserting nothing had been sent, while
     * a `conversation.sent` to that person sat right beside them. She read seven
     * standing unfulfilled promises every cycle and dutifully sent the same message
     * again, five times in five minutes and once more in the next session — the
     * percept meant to stop her forgetting a promise was making her unable to
     * believe she had kept it.
     *
     * Discharged by EVIDENCE, not by a timer: a `conversation.sent` to that target,
     * written no earlier than the undertaking, means the contact happened. That
     * record is durable and snapshots with the state, so the discharge survives a
     * restart exactly as the promise does — which the tick-scoped satiation in
     * `enactionFootprint` deliberately cannot.
     *
     * It stays a decision, not an erasure. Retiring the percept removes the standing
     * claim that the words are unsent; whether to say more to that person is then an
     * ordinary competition like any other.
     */
    private _reconcileUndertakings;
    private _onFacetSync;
    /**
     * A focused part of me surfaced something the singular seat owns — work to plan
     * (`escalation`) or an intention toward a third party (`undertaking`).
     *
     * ONE handler for every facet type. This was `_onAuditionTaskSignal`, listening
     * on a topic named for one sense engine and typed with one sense engine's nouns
     * (`entityId`, `threadId`), which meant a planning, supervision or deliberation
     * facet had no way to hand anything up at all. See EscalationBuffer for the full
     * rationale; new kinds go in `HandoffBody`, not in a new topic and a new handler
     * beside this one.
     *
     * Master stays out of the reply path entirely:
     *   • The facet has already said (or will say) whatever the person in front of
     *     it needed to hear.
     *   • The master's job is purely cognitive: create a [PLANS] block, update
     *     goals, reflect, or decide whether it still means to make that contact.
     *     Any follow-up communication flows through the agency competition —
     *     NEVER via [REPLY].
     *
     * Buffered rather than written directly: state is read-only here, so
     * `EscalationBuffer.drainToPercepts()` emits it as a StateCommand on the next
     * master cycle, where Exteroception surfaces it under "## Percepts (What I Notice)".
     */
    private _onFacetHandoff;
    /** Enable the deliberation cache (off by default). Call during mind assembly. */
    enableCache(config?: DeliberationCacheConfig): void;
    /** True when the cache is active. */
    get cacheEnabled(): boolean;
    /** Telemetry snapshot for harnesses / eval. Null when disabled. */
    cacheStats(): {
        size: number;
        hits: number;
        misses: number;
    } | null;
    /**
     * Reafference hook — update cache competence from a confirmed action outcome.
     * Optional, layered on top of the inline verify loop. Reward follows the
     * research sketch: mean of (action succeeded, stress relief, goal progress).
     */
    onActionOutcome(state: ReadonlySimulationState, tick: Tick, success: boolean, stressDelta: number, goalProgressDelta: number): void;
    private _actionTypesMatch;
    private _restoreDeliberationCache;
    private _restoreSummarizer;
}

interface SpacedRepetitionConfig {
    /** Minimum ticks between review cycles */
    reviewIntervalTicks?: number;
    /** Maximum beliefs to review per cycle */
    maxReviewsPerCycle?: number;
    /** Minimum confidence before a belief qualifies for review */
    minConfidenceForReview?: number;
    /** How much successful review increases confidence (0-1) */
    successBoost?: number;
    /** How much failed review decreases confidence (0-1) */
    failurePenalty?: number;
    /** Base interval for new beliefs (ticks) */
    baseIntervalTicks?: number;
    /** Maximum interval cap (ticks) */
    maxIntervalTicks?: number;
    /** Whether to surface beliefs to executive for re-evaluation */
    executiveReviewEnabled?: boolean;
    /** Whether to actively rehearse salient episodic memories each review cycle
     *  (waking episodic spaced repetition). Default true. */
    episodicRehearsalEnabled?: boolean;
    bus?: CognitiveBus;
}
interface ReviewRecord {
    beliefId: string;
    /** Current interval length in ticks */
    interval: number;
    /** Tick of the last review */
    lastReviewedAt: Tick;
    /** Number of successful reviews in a row */
    consecutiveSuccesses: number;
    /** Easiness factor (SM-2: 1.3 to 2.5, default 2.5) */
    easinessFactor: number;
}
declare class SpacedRepetition implements SimulationEngine, CognitiveEngine {
    readonly name = "spaced-repetition";
    private _reviewIntervalTicks;
    private _maxReviewsPerCycle;
    private _minConfidenceForReview;
    private _successBoost;
    private _failurePenalty;
    private _baseIntervalTicks;
    private _maxIntervalTicks;
    private _executiveReviewEnabled;
    private _episodicRehearsalEnabled;
    private _semanticIntegrator;
    private _episodicConsolidator;
    private _executiveEngine;
    private _sessionLogger;
    /** Review records keyed by beliefId */
    private _reviewRecords;
    /** Last tick when a review cycle ran */
    private _lastReviewCycleTick;
    private _bus;
    private _restored;
    private readonly _model;
    constructor(config?: SpacedRepetitionConfig);
    attachBus(bus: CognitiveBus): void;
    attachSemanticIntegrator(integrator: SemanticIntegrator): void;
    attachEpisodicConsolidator(consolidator: EpisodicConsolidator): void;
    attachExecutiveEngine(executive: ExecutiveEngine): void;
    attachSessionLogger(logger: SessionLogger): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    /**
     * Rehydrate review records from persisted 'spaced_repetition_record' entities.
     * Called once on the first tick after snapshot restore.
     */
    private _restoreFromState;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _runReviewCycle;
    /**
     * Active waking rehearsal of salient episodic memories.
     *
     * Beliefs get scheduled SM-2 review above; episodes previously had only
     * passive decay (ForgettingCurve) plus opportunistic sleep reactivation
     * (DreamSimulator), so an emotionally significant memory the Will happened not
     * to recall would simply fade. This selects the most worth-keeping episodes
     * that are *due* — salient, not retrieved within a review interval, still
     * above the pruning floor — and marks them retrieved. markRetrieved both nudges
     * activation and (via retrievalCount) unlocks the ForgettingCurve's
     * retrievalBoost, so rehearsed memories decay slower and persist.
     */
    private _rehearseEpisodes;
    private _episodeEmotionalIntensity;
    private _initializeRecord;
    private _processReviewOutcome;
    /**
     * Record belief history entry (mirrors SemanticIntegrator._recordHistory).
     * This requires SemanticIntegrator to expose a public method for external updates.
     */
    private _recordBeliefHistory;
    private _surfaceToExecutive;
    /**
     * Manually trigger a review for a specific belief.
     * Used when the executive decides to re-evaluate a belief.
     */
    requestReview(beliefId: string, tick: Tick): void;
    /**
     * Get the current review status for a belief.
     */
    getReviewStatus(beliefId: string): ReviewRecord | undefined;
    /**
     * Get all beliefs currently due for review (without triggering cycle).
     */
    getDueForReview(tick: Tick): Array<{
        belief: Belief;
        record: ReviewRecord;
    }>;
}

/**
 * ForgettingCurve — applies spaced repetition dynamics to episodic memories.
 *
 * Models the Ebbinghaus forgetting curve:
 *   - Memories decay exponentially without reactivation
 *   - Each retrieval resets and strengthens the memory
 *   - Emotionally intense memories decay slower
 *   - Sleep consolidates and protects memories
 *
 * Operates on the episodic memory store, decaying activation
 * strength over time and removing memories that fall below
 * the retrieval threshold.
 *
 * Part of Shard 2 (Memory Layer) — runs every tick, synchronous.
 */

interface ForgettingCurveConfig {
    /** Base forgetting rate (Ebbinghaus: ~0.3 per log-time unit) */
    baseForgettingRate?: number;
    /** How much emotional intensity slows forgetting (0-1, 1 = no forgetting) */
    emotionProtection?: number;
    /** Minimum activation before a memory is pruned */
    pruningThreshold?: number;
    /** Maximum memories to prune per tick (avoids stalls) */
    maxPrunePerTick?: number;
    bus?: CognitiveBus;
}
declare class ForgettingCurve implements SimulationEngine, CognitiveEngine {
    readonly name = "forgetting-curve";
    private _baseForgettingRate;
    private _emotionProtection;
    private _pruningThreshold;
    private _maxPrunePerTick;
    private _episodicConsolidator;
    private _bus;
    private readonly _model;
    constructor(config?: ForgettingCurveConfig);
    attachBus(bus: CognitiveBus): void;
    attachConsolidator(consolidator: EpisodicConsolidator): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    react(delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _computeEmotionalIntensity;
}

/**
 * DreamSimulator — reactivates and recombines memory traces during rest.
 *
 * Functions:
 *   - Memory reactivation: replays recent episodic memories
 *   - Emotional processing: dampens emotional charge of memories
 *   - Creative recombination: randomly associates related memories
 *   - Consolidation boost: strengthens reactivated memories
 *
 * Only active during sleep/rest states.
 * Models the hippocampal-neocortical dialogue during slow-wave sleep
 * and the emotional processing of REM sleep.
 *
 * Part of Shard 2 (Memory Layer) — runs every tick when sleeping.
 */

interface DreamSimulatorConfig {
    /** Maximum memories to reactivate per tick */
    maxReactivationsPerTick?: number;
    /** How much emotional dampening per reactivation */
    emotionalDampeningRate?: number;
    /** Probability of creative recombination between two memories */
    recombinationProbability?: number;
    bus?: CognitiveBus;
}
declare class DreamSimulator implements SimulationEngine, CognitiveEngine {
    readonly name = "dream-simulator";
    private _maxReactivationsPerTick;
    private _emotionalDampeningRate;
    private _recombinationProbability;
    private _episodicConsolidator;
    private _lastReactivationIndex;
    private _isSleeping;
    private _bus;
    private readonly _model;
    constructor(config?: DreamSimulatorConfig);
    attachBus(bus: CognitiveBus): void;
    attachConsolidator(consolidator: EpisodicConsolidator): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, _state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _selectForReactivation;
    private _reactivationScore;
    private _pickRandomMemory;
}

/**
 * InhibitionController — suppresses prepotent responses and delays
 * gratification.
 *
 * Functions as a somatic veto:
 *   - Monitors pending decision.record entities queued for execution
 *   - Evaluates them against affective state and long-term goals
 *   - Vetoes actions that are impulsive, risky, or misaligned
 *   - Implements gratification delay (can defer actions to future ticks)
 *
 * This engine is the "pause between impulse and action."
 * It integrates with the Orchestrator's CommitValidator system
 * to block commands before they're applied.
 *
 * Modulated by:
 *   - Stress (overload disinhibits — impulsive actions get through)
 *   - Sleep pressure (fatigue reduces inhibition)
 *   - Energy (low energy reduces inhibition capacity)
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
 */

interface InhibitionControllerConfig {
    /** Base inhibition strength (0-1, higher = more veto power) */
    baseInhibitionStrength?: number;
    /** Threshold above which affective arousal triggers inhibition check */
    arousalThreshold?: number;
    /** Maximum actions that can be deferred per tick */
    maxDeferralsPerTick?: number;
    bus?: CognitiveBus;
}
declare class InhibitionController implements SimulationEngine, CognitiveEngine {
    readonly name = "inhibition-controller";
    private _baseInhibitionStrength;
    private _inhibitionStrength;
    private _arousalThreshold;
    private _maxDeferralsPerTick;
    private _deferredActions;
    private _energyLevel;
    private _sleepPressure;
    private _stressLoad;
    private _executiveConfidence;
    private _bus;
    private readonly _model;
    constructor(config?: InhibitionControllerConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Explicitly veto a specific action type for a duration.
     */
    vetoAction(actionType: string, durationTicks: number): void;
    private _computeEffectiveInhibition;
    private _contradictsActiveGoals;
    /**
     * Register this engine as a CommitValidator in the Orchestrator.
     * Call during setup to wire the veto into the commit pipeline.
     */
    asCommitValidator(): (cmds: StateCommands[], tick: Tick, ctx: SimulationContext) => string[] | true;
}

/**
 * TaskSwitcher — manages attention shifts between competing goals.
 *
 * When multiple goals compete for attention, the TaskSwitcher:
 *   1. Compares active goal priorities
 *   2. Applies switching costs (attention residue from previous focus)
 *   3. Decides whether to maintain current focus or switch
 *   4. Signals the AttentionAllocator to reallocate
 *
 * Switching is costly — frequent switching degrades performance.
 * The TaskSwitcher balances exploitation (stay on current goal) vs.
 * exploration (switch to potentially higher-value goal).
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
 */

interface TaskSwitcherConfig {
    /** Base switching cost (0-1, fraction of attention lost on switch) */
    baseSwitchCost?: number;
    /** How much priority advantage a new goal needs to justify switching */
    switchThreshold?: number;
    /** Minimum ticks on a goal before switching is considered */
    minFocusTicks?: number;
    bus?: CognitiveBus;
}
declare class TaskSwitcher implements SimulationEngine, CognitiveEngine {
    readonly name = "task-switcher";
    private _baseSwitchCost;
    private _switchThreshold;
    private _minFocusTicks;
    private _currentFocus;
    private _totalSwitches;
    private _bus;
    private readonly _model;
    constructor(config?: TaskSwitcherConfig);
    attachBus(bus: CognitiveBus): void;
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _getActiveGoals;
    /**
     * Get the current focus goal ID.
     */
    getCurrentFocus(): string | null;
}

/**
 * SelfModelUpdater — maintains beliefs about own capabilities, traits,
 * and patterns.
 *
 * Periodically evaluates recent performance across domains and updates
 * the will.identity entity with refined self-knowledge. This is how
 * the mind learns "I am good at X, bad at Y" through experience.
 *
 * Uses AsyncEngine — deep self-evaluation may involve LLM introspection.
 *
 * Part of Shard 4 (Meta-Cognitive Layer).
 */

interface SelfModelUpdaterConfig {
    /** Minimum ticks between self-model evaluations */
    minIntervalTicks?: number;
    /** Minimum new experiences before re-evaluating */
    minNewExperiences?: number;
    bus?: CognitiveBus;
}
declare class SelfModelUpdater extends AsyncEngine implements CognitiveEngine {
    readonly name = "self-model-updater";
    private _executiveReflectionBiases;
    private _executiveReflectionTick;
    private _minIntervalTicks;
    private _minNewExperiences;
    private _lastEvaluationTick;
    private _experienceCountAtLastEval;
    private _cachedEpisodicTotal;
    private _domainPerformance;
    private _affectStabilityEma;
    private _affectObservations;
    private _bus;
    private _semanticIntegrator;
    /** The reasoning tick's state — onReasoningComplete needs it to merge identity. */
    private _lastStateRef;
    private readonly _model;
    constructor(config?: SelfModelUpdaterConfig);
    attachBus(bus: CognitiveBus): void;
    attachSemanticIntegrator(si: SemanticIntegrator): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    /**
     * Record an action outcome for domain-specific self-assessment.
     */
    recordOutcome(domain: string, success: boolean, tick: Tick): void;
    private _readConfigFromState;
    /**
     * Sample current negative affect into a slow EMA — the running self-observation the
     * self-model turns into an 'emotional-stability' trait. Called every tick (in
     * shouldAct), so it tracks affect continuously even between the gated evaluations.
     * Pure/deterministic: the same emotion-metric stream reproduces the same EMA on
     * replay (no wall-clock, no RNG). Stability is read as low sustained negative affect;
     * volatility (variance) would be a finer refinement but a level EMA is enough to drive
     * the self-regulation loop (steadier ⇒ slower frustration build ⇒ steadier).
     */
    private _sampleAffectStability;
    protected shouldAct(state: ReadonlySimulationState, tick: Tick, _context: SimulationContext): boolean;
    protected readState(state: ReadonlySimulationState, tick: Tick): ReasoningFootprint;
    /**
     * Recompute per-trait self-knowledge at an evaluation (Options B/C substrate). Pure +
     * deterministic — sim-tick only. The EMA tracks the personal baseline; a significant Δ
     * this evaluation stamps a recency direction that ages out after TRAIT_RECENCY_WINDOW.
     * The window is checked ONLY here (at evals), so the recency stamp never churns the
     * prompt between evaluations.
     */
    private _computeTraitStats;
    protected reasonAsync(footprint: ReasoningFootprint, state: ReadonlySimulationState, context: SimulationContext, stream: IntermediateStream): Promise<unknown>;
    protected onIntermediateResult(step: string, result: unknown, _footprint: ReasoningFootprint, _context: SimulationContext): StateCommands | null;
    protected onReasoningComplete(output: unknown, footprint: ReasoningFootprint, context: SimulationContext): StateCommands;
    private _computeDomainAssessments;
    private _extractIdentity;
    /**
     * Evaluate self based on performance data and existing beliefs.
     * Adjusts trait estimates and updates values.
     */
    private _evaluateSelf;
    private _domainToTrait;
    private _diffTraits;
    /**
     * Scalar magnitude of how much the identity actually moved this evaluation —
     * summed absolute trait deltas plus a per-new-value increment. This is the
     * surprise signal the generative model gates on (a real self-revision is a
     * large change), replacing the monotonically-incrementing version counter
     * which always looked like the same "+1" of error.
     */
    private _identityChangeMagnitude;
}

/**
 * ConfidenceCalibrator — compares decision confidence against actual
 * outcomes to calibrate future confidence estimates.
 *
 * Maintains a calibration curve per action domain. If the agent
 * consistently overestimates confidence in "planning" decisions,
 * future planning confidence is adjusted downward.
 *
 * This is the mechanism behind "knowing what you don't know."
 *
 * Part of Shard 4 (Meta-Cognitive Layer) — runs every tick, synchronous.
 */

interface ConfidenceCalibratorConfig {
    /** Minimum outcome samples before calibration activates */
    minSamplesPerDomain?: number;
    /** How aggressively to adjust calibration (learning rate) */
    calibrationRate?: number;
    /** Maximum calibration adjustment per evaluation */
    maxAdjustment?: number;
    bus?: CognitiveBus;
}
declare class ConfidenceCalibrator implements SimulationEngine, CognitiveEngine {
    readonly name = "confidence-calibrator";
    private _executiveFlaggedBiasCount;
    private _minSamplesPerDomain;
    private _calibrationRate;
    private _maxAdjustment;
    private _records;
    private _domainBias;
    private _bus;
    private _restored;
    private readonly _model;
    constructor(config?: ConfidenceCalibratorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    /**
     * Rehydrate the learned calibration curve from the persisted `calibration-state`
     * entity (Phase 2, Option B — the entity-restore path that's actually wired at
     * boot). Called once on the first react after a restore. Bias is restored
     * directly so calibration is continuous immediately, rather than waiting to
     * re-accumulate minSamplesPerDomain fresh outcomes.
     */
    private _restoreFromState;
    /**
     * Record a decision and its eventual outcome.
     * Called when an action's outcome is known.
     */
    recordOutcome(domain: string, confidence: number, outcomeQuality: number, tick: Tick): void;
    /**
     * Get the calibrated confidence for a given raw confidence in a domain.
     * Adjusts based on historical over/under-confidence patterns.
     */
    getCalibratedConfidence(domain: string, rawConfidence: number): number;
    /**
     * Effective config = base engine-config-confidence ⊕ persona-prior. Seeded base
     * matches the constructor defaults (no drift), so this just single-sources the
     * tunables and lets a future persona-prior modulate calibration aggressiveness.
     */
    private _readConfigFromState;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Compute calibration bias from records.
     * Positive bias = overconfident (confidence > outcome).
     * Negative bias = underconfident (confidence < outcome).
     */
    private _computeBias;
}

/**
 * BiasDetector — identifies recurring patterns of error in the agent's
 * own reasoning.
 *
 * Scans decision history for:
 *   - Anchoring (over-reliance on first piece of information)
 *   - Confirmation bias (seeking evidence that confirms existing beliefs)
 *   - Recency bias (overweighting recent events)
 *   - Availability bias (overweighting vivid/salient memories)
 *   - Overgeneralization (forming broad beliefs from few samples)
 *
 * Part of Shard 4 (Meta-Cognitive Layer) — runs periodically, synchronous.
 */

interface BiasDetectorConfig {
    /** Minimum decisions before bias detection activates */
    minDecisions?: number;
    /** Ticks between bias scans */
    scanIntervalTicks?: number;
    /** Whether to flag biases as events */
    emitBiasEvents?: boolean;
    bus?: CognitiveBus;
}
interface DetectedBias {
    type: string;
    description: string;
    confidence: number;
    supportingEvidence: string[];
    detectedAt: Tick;
}
declare class BiasDetector implements SimulationEngine, CognitiveEngine {
    readonly name = "bias-detector";
    private _executiveNamedBiases;
    private _minDecisions;
    private _scanIntervalTicks;
    private _emitBiasEvents;
    private _lastScanTick;
    private _detectedBiases;
    private _bus;
    private readonly _model;
    constructor(config?: BiasDetectorConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    /**
     * Effective config = base engine-config-bias-detector ⊕ persona-prior. Seeded
     * base matches the constructor defaults (no drift). Only the numeric tunables
     * are single-sourced here; `emitBiasEvents` is a boolean (stored 1/0 in the
     * mirror) and stays constructor-only to avoid a lossy numeric coercion.
     */
    private _readConfigFromState;
    private _scanForBiases;
    /**
     * True if the executive (via executive.self.reflection) independently named a
     * bias matching `type`. Normalised, fuzzy match — the executive names biases in
     * free text ("recency bias") while the detector uses codes ("recency_bias").
     */
    private _executiveCorroborates;
    private _integrateBias;
    /**
     * Get currently detected biases.
     */
    getDetectedBiases(): ReadonlyArray<DetectedBias>;
}

/**
 * AutobiographicalNarrator — satellite mode.
 *
 * Reads the most recent ExecutiveEngine output for narrative updates.
 * Performs heuristic narrative extension between executive runs.
 * No longer makes its own LLM calls.
 */

interface AutobiographicalNarratorConfig {
    minIntervalTicks?: number;
    maxNarrativeLength?: number;
    bus?: CognitiveBus;
}
interface SelfNarrative {
    story: string;
    themes: string[];
    pivotalEvents: string[];
    currentSelfView: string;
    version: number;
    lastUpdatedAt: Tick;
}
declare class AutobiographicalNarrator implements SimulationEngine, CognitiveEngine {
    readonly name = "autobiographical-narrator";
    private _minIntervalTicks;
    private _maxNarrativeLength;
    private _narrative;
    private _lastUpdateTick;
    private _restored;
    private _episodicConsolidator;
    private _semanticIntegrator;
    private _executiveEngine;
    private _affectValence;
    private _bus;
    private readonly _model;
    constructor(config?: AutobiographicalNarratorConfig);
    attachBus(bus: CognitiveBus): void;
    attachEpisodicConsolidator(ec: EpisodicConsolidator): void;
    attachSemanticIntegrator(si: SemanticIntegrator): void;
    attachExecutiveEngine(oe: ExecutiveEngine): void;
    getNarrative(): SelfNarrative;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _heuristicSelfView;
    /**
     * Effective config = base engine-config-narrator ⊕ persona-prior. Single-sourced
     * now that the seeded base (minIntervalTicks 50) and the constructor default
     * agree, so the consolidator's self_model.updated → narrative edge applies
     * cleanly: a significant identity change lowers this interval and the Will
     * re-narrates its life story sooner.
     */
    private _readConfigFromState;
    /**
     * Rehydrate _narrative from the persisted 'self-narrative' entity.
     * Called once on the first tick after a snapshot restore so the
     * narrator continues from the saved story rather than the fresh-boot default.
     */
    private _restoreFromState;
}

/**
 * IntrospectionEngine — satellite mode.
 *
 * Reads the most recent ExecutiveEngine output for introspections.
 * Performs heuristic self-analysis between executive runs for minor events.
 * No longer makes its own LLM calls.
 */

interface IntrospectionEngineConfig {
    cooldownTicks?: number;
    significanceThreshold?: number;
    bus?: CognitiveBus;
}
interface IntrospectionResult {
    question: string;
    explanation: string;
    identifiedBiases: string[];
    lessons: string[];
    introspectedAt: Tick;
    analyzedTicks: Tick[];
}
declare class IntrospectionEngine implements SimulationEngine, CognitiveEngine {
    readonly name = "introspection-engine";
    private _cooldownTicks;
    private _significanceThreshold;
    private _lastIntrospectionTick;
    private _introspectionHistory;
    private _emittedEntityIds;
    private _executiveEngine;
    private _affectArousal;
    private _bus;
    private readonly _model;
    constructor(config?: IntrospectionEngineConfig);
    attachBus(bus: CognitiveBus): void;
    attachExecutiveEngine(oe: ExecutiveEngine): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, context: SimulationContext): Promise<EngineResult>;
    private _shouldHeuristicIntrospect;
    private _heuristicIntrospection;
    /**
     * Effective config = base engine-config ⊕ persona-prior. The consolidator
     * lowers `cooldownTicks` when bias is recurring, so introspection runs more
     * often. (The seeded base matches this engine's defaults — no single-source
     * drift — so reading base⊕prior is safe here.)
     */
    private _readConfigFromState;
    getHistory(): ReadonlyArray<IntrospectionResult>;
}

/**
 * PersonaConsolidator — the write-back edge of the metacognition cycle.
 *
 * This is the faculty that performs *accommodation*: it reads the Will's own
 * introspection and writes bounded, durable adjustments back into the apparatus
 * that perceives and reasons — without ever mutating the seeded base config.
 *
 * Closed loops (each: a meta signal → an apparatus param; see
 * METACOGNITION_CYCLE_TODO.md Phase 3):
 *   1. confidence.calibrated  →  self-model re-evaluation cadence (minIntervalTicks)
 *        "I keep mis-judging my confidence → re-examine who I am more often."
 *   2. bias.detected          →  introspection cadence (cooldownTicks)
 *        "I keep reasoning with bias → introspect more often."
 *   3. self_model.updated     →  narrative cadence (minIntervalTicks)
 *        "My identity shifted significantly → re-narrate my life story sooner."
 *   4. bias.detected (belief)  →  semantic belief-staleness (beliefStalenessThreshold)
 *        "I overgeneralise / confirm → let my beliefs go stale sooner for review."
 *   5. bias.detected (memory)  →  working-memory protection (attentionProtection)
 *        "I over-weight recent/vivid items → cling to them less tightly."
 *   6. bias.detected          →  inhibitory control (inhibition.baseInhibitionStrength, ↑)
 *        "My reasoning keeps mis-firing → exert more self-restraint before acting."
 *   7. introspection.insight   →  self-model evidence gate (minNewExperiences, ↓)
 *        "My introspection is productive → re-evaluate who I am on less new evidence."
 *   8. bias.detected (belief)  →  attentional fixation (attention.shiftInertia, ↓)
 *        "I keep confirming/overgeneralising → shift attention more readily to break the fixation."
 *
 * Edges 1–5 push a *faster cadence* (a negative delta on an interval/cooldown);
 * 6 *raises* a control gain, 7–8 *lower* a gate/inertia — each proportional to the
 * significance of the signal, bounded + decayed by
 * `consolidatePrior`. The equilibrium between a magnitude-proportional push and
 * the per-pass decay yields a cadence elevation proportional to how significant
 * the introspection actually is; when the signal subsides, the prior decays back
 * to the seeded baseline.
 *
 * Properties:
 *   - **Significance-gated**, not surprise-gated: these are persistent control
 *     signals, so a magnitude threshold (not a prediction-error gate) is the
 *     right notion of "significant introspection". Routine ticks only decay.
 *   - **Bounded** (stability–plasticity): all limits live in `consolidatePrior`,
 *     relative to each param's base scale.
 *   - **Deterministic (R2)**: magnitudes come from replayed bus events; the write
 *     is a pure function of (prior entity, bases, magnitudes, tick).
 *   - **Durable via entity (Option B)**: the prior is a `persona-prior` entity,
 *     so it survives restart on the wired entity-restore path. No bus / salience /
 *     generative sub-state — nothing it doesn't actually use.
 */

interface PersonaConsolidatorConfig {
    /** Ticks between consolidation passes. Default 100. */
    intervalTicks?: number;
    /** |calibrationBias| at/below this counts as well-calibrated → no push. Default 0.05. */
    significanceThreshold?: number;
    /** Self-model cadence delta per unit |bias| (clamped by consolidatePrior). Default 400. */
    cadenceGain?: number;
}
declare class PersonaConsolidator implements SimulationEngine, CognitiveEngine {
    readonly name = "persona-consolidator";
    private _intervalTicks;
    private _significanceThreshold;
    private _cadenceGain;
    private _lastConsolidationTick;
    private _latestCalibrationBias;
    private _latestBiasNovelty;
    private _latestBeliefBiasNovelty;
    private _latestMemoryBiasNovelty;
    private _latestSelfModelChange;
    private _latestInsightSignificance;
    constructor(config?: PersonaConsolidatorConfig);
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    restore(snap: Record<string, unknown>): void;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    /**
     * Build one bounded adjustment per consolidation rule. A rule contributes a
     * push only when its signal is significant; otherwise its proposedDelta is 0
     * and consolidatePrior just lets that param's existing prior decay.
     */
    private _proposedAdjustments;
}

/**
 * TheoryOfMind — models what other agents know, believe, and intend.
 *
 * Maintains a mental model for each observed agent:
 *   - Knowledge state (what they've observed)
 *   - Belief state (what they think is true, may differ from reality)
 *   - Intention state (what they're trying to achieve)
 *   - Emotional state (what they're likely feeling)
 *
 * Updates models based on:
 *   - Observed actions (what the other agent did)
 *   - Shared observations (what the other agent could have seen)
 *   - Communication (what the other agent explicitly shared)
 *
 * Part of Shard 1 (Social Layer) — runs every tick, synchronous.
 */

interface TheoryOfMindConfig {
    /** Maximum agents to model simultaneously */
    maxModeledAgents?: number;
    /** How quickly belief confidence decays without observation */
    beliefDecayRate?: number;
    /** Minimum confidence to consider a belief reliable */
    confidenceThreshold?: number;
    bus?: CognitiveBus;
}
interface AgentMentalModel {
    keid: string;
    /** What this agent is known to have observed */
    knownObservations: Array<{
        entityId: string;
        tick: Tick;
        confidence: number;
    }>;
    /** What this agent is believed to believe */
    beliefs: Array<{
        statement: string;
        confidence: number;
        lastUpdated: Tick;
    }>;
    /** What this agent is believed to intend */
    intentions: Array<{
        goal: string;
        confidence: number;
        lastUpdated: Tick;
    }>;
    /** What this agent is likely feeling */
    emotionalState: {
        valence: number;
        arousal: number;
        dominantEmotion: string;
    };
    /** Last tick this model was updated */
    lastUpdated: Tick;
    /** Overall model confidence */
    modelConfidence: number;
}
declare class TheoryOfMind implements SimulationEngine, CognitiveEngine {
    readonly name = "theory-of-mind";
    private _maxModeledAgents;
    private _beliefDecayRate;
    private _confidenceThreshold;
    private _models;
    private _restored;
    private _pendingInteractions;
    private _bus;
    private readonly _model;
    constructor(config?: TheoryOfMindConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    /**
     * Query what another agent is likely to know/believe/intend.
     */
    getModel(keid: string): AgentMentalModel | undefined;
    /**
     * Check if another agent is likely aware of something.
     */
    isLikelyAwareOf(keid: string, entityId: string): boolean;
    /**
     * Rehydrate _models from persisted tom-<id> entities on the first tick after a
     * snapshot/PMA restore — mirrors AttachmentEvaluator/ReputationTracker._restoreFromState.
     * The entity stores a gist (modelConfidence + the dominant intention + estimated emotion),
     * not the full belief/observation arrays, so the restored model is a coherent gist that
     * subsequent interactions grow from — the soul-true level: the Will recovers its
     * *sense* of a mind, not every belief it once inferred about it.
     */
    private _restoreFromState;
    private _getOrCreateModel;
    private _inferIntention;
    private _decayBeliefs;
    private _pruneModels;
}

/**
 * EmpathySimulator — simulates what another agent is feeling.
 *
 * Uses TheoryOfMind models plus observed social signals to estimate
 * another agent's emotional state. Produces empathic responses:
 *   - Emotional resonance (feeling what they feel)
 *   - Compassionate concern (wanting to help if they're distressed)
 *   - Empathic accuracy (how well the simulation matches reality)
 *
 * Part of Shard 1 (Social Layer) — runs every tick, synchronous.
 */

interface EmpathySimulatorConfig {
    /** How strongly another's emotion resonates (0-1) */
    resonanceStrength?: number;
    /** Threshold for triggering compassionate response */
    compassionThreshold?: number;
    bus?: CognitiveBus;
}
interface EmpathicState {
    targetKeid: string;
    estimatedEmotion: {
        valence: number;
        arousal: number;
        dominantEmotion: string;
    };
    resonanceStrength: number;
    compassionateConcern: number;
    confidence: number;
}
declare class EmpathySimulator implements SimulationEngine, CognitiveEngine {
    readonly name = "empathy-simulator";
    private _resonanceStrength;
    private _compassionThreshold;
    private _theoryOfMind;
    private _currentEmpathicStates;
    private _pendingInteractions;
    private _bus;
    private readonly _model;
    constructor(config?: EmpathySimulatorConfig);
    attachBus(bus: CognitiveBus): void;
    attachTheoryOfMind(tom: TheoryOfMind): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _estimateEmotion;
    /**
     * Get current empathic states.
     */
    getEmpathicStates(): ReadonlyArray<EmpathicState>;
}

/**
 * ReputationTracker — maintains models of others' reliability,
 * cooperativeness, and social standing.
 *
 * Tracks per-agent:
 *   - Reliability (did they do what they said they would?)
 *   - Cooperativeness (did they help or hinder?)
 *   - Social standing (how do others seem to regard them?)
 *   - Trustworthiness (composite of reliability + cooperativeness)
 *
 * Part of Shard 1 (Social Layer) — runs every tick, synchronous.
 */

interface ReputationTrackerConfig {
    /** Maximum agents to track */
    maxTrackedAgents?: number;
    /** How quickly reputation decays without new observations */
    decayRate?: number;
    /** Minimum interactions before reputation is considered reliable */
    minInteractions?: number;
    /** How much a cooperative interaction raises a tracked agent's cooperativeness (trust step) */
    trustGrowthStep?: number;
    bus?: CognitiveBus;
}
interface Reputation {
    keid: string;
    reliability: number;
    cooperativeness: number;
    socialStanding: number;
    trustworthiness: number;
    interactionCount: number;
    positiveInteractions: number;
    negativeInteractions: number;
    lastInteractionTick: Tick;
    confidence: number;
}
declare class ReputationTracker implements SimulationEngine, CognitiveEngine {
    readonly name = "reputation-tracker";
    private _maxTrackedAgents;
    private _decayRate;
    private _minInteractions;
    private _trustGrowthStep;
    private _reputations;
    /** True after reputations have been rehydrated from persisted state on first tick. */
    private _restored;
    private _pendingInteractions;
    private _bus;
    private readonly _model;
    constructor(config?: ReputationTrackerConfig);
    attachBus(bus: CognitiveBus): void;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    getReputation(keid: string): Reputation | undefined;
    isTrusted(keid: string, threshold?: number): boolean;
    /**
     * Rehydrate _reputations from 'reputation' entities in state.
     * Called once on the first tick after snapshot restore so that relationship
     * models formed in previous sessions survive a server restart.
     */
    private _restoreFromState;
    private _getOrCreate;
    private _prune;
}

/**
 * KnownEntityTracker — the cross-modal binder, and owner of the known-entity dossier.
 *
 * This is the faculty `base.sense.engine.ts` anticipates: it subscribes to every
 * `senses.*.percept` and, per `sourceEntityId`, accretes a dossier — the node for anything
 * the Will has come to know (someone or something). It maintains the *perceptual /
 * subconscious* layer of that knowledge:
 *
 *   - familiarity   — mere-exposure: rises with each encounter, decays in absence
 *   - encounterCount, lastSeen
 *   - name          — when the channel supplies one (e.g. TextMessage.speakerName)
 *   - kind          — sentient | thing
 *   - resolutionConfidence — how identified this referent is (drives curiosity, Phase 3)
 *
 * The *conscious* layer (facts learned in reasoning, a felt valence) is written separately
 * via `knownEntityUpdates` (Phase 2.2). The executive joins both, plus the social triple,
 * in `extractKnownEntities`. Identity is provisional: the `keid` is the referent the
 * senses supply — a dossier can exist long before the Will knows the entity's name.
 *
 * Part of the Social/Perceptual layer — runs every tick, synchronous, deterministic (R2):
 * all accretion/decay is a pure function of percepts + sim-tick.
 */

interface KnownEntityTrackerConfig {
    /** How fast familiarity rises per encounter (saturating toward 1). Channel A: openness. */
    familiarityGrowthRate?: number;
    /** How fast familiarity fades per tick without an encounter. */
    familiarityDecayRate?: number;
    /** Gain on the curiosity-to-resolve drive — how readily the pull-to-know fires. Channel A: openness. */
    curiosityGain?: number;
    /** EMA weight per action outcome — how fast a reliability judgment is revised. Channel A: analytical. */
    reliabilityRate?: number;
    /** Maximum dossiers retained (lowest familiarity pruned). */
    maxTracked?: number;
    bus?: CognitiveBus;
}
interface KnownEntity {
    keid: string;
    kind: 'sentient' | 'thing';
    name?: string;
    /** Mere-exposure familiarity 0–1 — rises per encounter, decays in absence. */
    familiarity: number;
    /** Felt affective tone toward the entity (−1..1). Set by the conscious layer (2.2). */
    valence: number;
    /**
     * Track-record reliability 0–1 — does it perform/behave as expected? An EMA of action
     * outcomes targeting this entity. General (a car/tool/place/person can have one), distinct
     * from a sentient's *social* reputation. 0.5 = unknown.
     */
    reliability: number;
    encounterCount: number;
    lastSeenTick: Tick;
    /** 0–1: how identified/coherent this referent is (a name + repeated encounters raise it). */
    resolutionConfidence: number;
}
declare class KnownEntityTracker implements SimulationEngine, CognitiveEngine {
    readonly name = "known-entity-tracker";
    private _growthRate;
    private _decayRate;
    private _curiosityGain;
    private _reliabilityRate;
    private _maxTracked;
    private _dossiers;
    private _aliases;
    /** True after dossiers have been rehydrated from persisted state on first tick. */
    private _restored;
    private _pendingEncounters;
    private _pendingConscious;
    private _pendingOutcomes;
    private _bus;
    private readonly _model;
    constructor(config?: KnownEntityTrackerConfig);
    attachBus(bus: CognitiveBus): void;
    /**
     * Effective config = base engine-config-known-entity ⊕ persona-prior (Channel A). Read
     * each tick so the tracker's dispositions *develop*: openness raises familiarity growth +
     * the curiosity pull; analytical sharpens how fast reliability judgments are revised.
     */
    private _readConfigFromState;
    subscribes(): string[];
    publishes(): CognitiveEventSchema[];
    onCognitiveEvent(e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _ctx: SimulationContext): Promise<EngineResult>;
    /** The dossier for a referent, if the Will has one. */
    getDossier(keid: string): KnownEntity | undefined;
    /** Resolution confidence: a learned name plus repeated encounters identify a referent. */
    private _resolution;
    /**
     * Fuse dossiers that have resolved to the same name into one canonical referent. Returns
     * true if any merge happened. Pure + deterministic.
     */
    private _recognise;
    private _getOrCreate;
    /** Keep the most-familiar dossiers; absence-faded acquaintances fall away (forgetting). */
    private _prune;
    private _restoreFromState;
}

/** Where an affordance came from — its evoking origin in the perception field. */
type AffordanceSource = 'innate' | 'perceptual' | 'social' | 'repertoire' | 'ideomotor' | 'plan' | 'external';
/** A body-state gate. If any precondition fails, the affordance is unavailable. */
interface SchemaPrecondition {
    metric: string;
    op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
    value: number;
}
/**
 * What kind of target a schema binds when it becomes an affordance.
 * 'entity' = a sentient known-entity (a person); 'object' = a non-sentient
 * known-entity (a thing); 'percept' = a salient percept; 'none' = objectless.
 */
type SchemaBinding = 'none' | 'entity' | 'object' | 'percept';
/**
 * A MotorSchema — a parameterized control program, not a flat effector row.
 * `kind: 'primitive'` runs a body directly (an internal stance, a communication,
 * or an external host invocation). `kind: 'composite'` expands into an ordered
 * policy over sub-schemas (this is where a *created* skill actually executes).
 */
interface MotorSchema {
    id: string;
    kind: 'primitive' | 'composite';
    source: AffordanceSource;
    /** Normalized intrinsic cost 0..1 (effort / energy demand). */
    cost: number;
    /** What this schema binds to when afforded. */
    binds: SchemaBinding;
    /** Body-state gates evaluated against live metrics. */
    preconditions?: SchemaPrecondition[];
    /** Sub-schema ids, in policy order — composite schemas only. */
    composedOf?: string[];
    /** Intrinsic affective prior (−1..1) before any learning has occurred. */
    baseValence?: number;
    /** What the schema is *for* — its meaning, carried to the host on enaction. */
    description?: string;
    tags?: string[];
}
/**
 * How a host declares a domain effector to a Will. A bare string is the
 * name-only form (`CUSTOM_ABILITY_WIRING.md` Phase 1). The object form seeds the
 * ability as a *learnable affordance*: `description` is its meaning; `cost`,
 * `valence`, and `preconditions` are the intrinsic priors the mind starts from
 * before reafference refines them through use. Args still bind from the
 * situation — this is not a tool-call parameter form.
 */
type EffectorDeclaration = string | {
    name: string;
    /** What the ability is for — its meaning, carried to perception + the host. */
    description?: string;
    /** Intrinsic effort/energy demand 0..1 (default 0.15). */
    cost?: number;
    /** Intrinsic affective prior −1..1 the mind expects before learning (default 0). */
    valence?: number;
    /** Body-state gates; the affordance is unavailable unless all pass. */
    preconditions?: SchemaPrecondition[];
    /**
     * Whether the ability targets a specific *perceived* target (default
     * 'none'). 'entity' binds it to each sentient known-entity (a person),
     * 'object' to each non-sentient one (a thing) — so the Will can
     * `give`/`greet` someone or `use`/`pick-up` something in particular; the
     * bound target reaches the host as `ctx.targetEntityId`.
     */
    binds?: 'none' | 'entity' | 'object';
    /**
     * Routing tags folded into the schema (merged with 'external'/'host').
     * A tag the drive system recognises (e.g. 'social', 'nourishment') lets a
     * homeostatic drive lift this ability in the competition when pressing.
     */
    tags?: string[];
};
/**
 * LearnedSkill — the persisted competence unit. This, not the transient
 * affordance field, is what travels in the PMA and makes a grown Will *act like
 * itself* after re-embodiment.
 */
interface LearnedSkill {
    schema: string;
    /** Proceduralization 0..1 — rises with low-error success, decays with disuse. */
    habitStrength: number;
    /** Expected reward 0..1 (EMA over outcomes). */
    valueEstimate: number;
    /** Learned default parameters for this schema. */
    paramPriors: Record<string, unknown>;
    enactments: number;
    successes: number;
    /** Rolling mean |prediction error|. */
    avgPredictionError: number;
    lastEnactedTick: number;
}

/**
 * WHY this denial is final — the distinction that makes a refusal learnable
 * rather than a wall to re-probe forever. Each value selects a different
 * cognitive fate; they are not degrees of one severity.
 *
 *   • 'class'     — the ACTION ITSELF is never permitted. Suppress the
 *                   affordance hard, erase any learned envelope, and let go of
 *                   a commitment currently deliberating toward it.
 *   • 'parameter' — the action is fine; THESE ARGUMENTS were not (bound
 *                   exceeded, wrong target). Narrow the envelope the Will
 *                   reaches for; the ability stays.
 *   • 'context'   — the refusal was NOT ABOUT THE ACTION at all (tainted
 *                   context, unavailable dependency). Touch nothing: no
 *                   availability delta, no envelope, no competence.
 *
 * POLICY_REAFFERENCE P5 widened this from 'class' | 'instance' after the HELM
 * joint RFC ("Denials That Teach") identified that an instance-scoped refusal
 * splits in two, and that the two halves demand opposite responses. These are
 * OUR names for the distinctions, deliberately not HELM's wire spellings — see
 * the naming-boundary note in .TODO/POLICY_REAFFERENCE.md. A provider adapter
 * translates; this interface stays vendor-neutral.
 */
type DenialFinality = 'class' | 'parameter' | 'context';

interface OutcomeObservation {
    schema: string;
    success: boolean;
    outcomeQuality: number;
    predictedReward: number;
    /** Last-known-good parameters to fold into priors (only kept on success). */
    params?: Record<string, unknown>;
    tick: number;
}
declare class SchemaRepertoire {
    private _templates;
    private _skills;
    /** Tracks which templates were learned at runtime (vs innate) so decay can forget them. */
    private _learned;
    /** Availability layer (P2): schema → { value 0..1, lastRefusedTick }. Empty until
     *  a refusal lands — a never-refused Will writes nothing here (byte-identical). */
    private _availability;
    constructor(seed?: MotorSchema[]);
    schemas(): MotorSchema[];
    getSchema(id: string): MotorSchema | undefined;
    /** Register a learned composite skill template (starts with no habit). */
    registerComposite(schema: MotorSchema): void;
    /**
     * Register a host effector's primitive schema at runtime (post-create
     * `.effector()`). Unlike a composite it is NOT marked learned — it is a
     * capacity the host granted, which the synthesizer surfaces immediately and
     * reafference then builds skill on. Idempotent; re-registering updates it.
     */
    registerExternal(schema: MotorSchema): void;
    skills(): ReadonlyMap<string, LearnedSkill>;
    getSkill(id: string): LearnedSkill | undefined;
    availability(): ReadonlyMap<string, {
        value: number;
        lastRefusedTick: number;
    }>;
    /**
     * How available a schema is right now, 0..1. Absent from the ledger ⇒ 1
     * (fully available — the common case). This is the ONLY value the
     * AffordanceSynthesizer reads; it never touches competence.
     */
    availabilityOf(schema: string): number;
    /**
     * Fold a policy refusal into the availability layer (NOT competence). A
     * `class` refusal cuts availability hard; a `parameter` refusal dents it
     * lightly. Multiplicative so repeated refusals compound toward — but never
     * reach — zero, keeping re-probe alive.
     *
     * `context` is EXCLUDED FROM THE SIGNATURE, not handled inside: a refusal
     * that was not about the action must never reach the availability layer at
     * all, and making that a type error rather than a convention means a future
     * caller cannot quietly re-introduce the dent. The routing decision lives in
     * the ReafferenceEngine's refused branch (P5).
     */
    recordRefusal(schema: string, finality: Exclude<DenialFinality, 'context'>, tick: number): number;
    /**
     * Fold one outcome into the schema's learned skill. Returns the updated skill
     * and whether it just crossed the proceduralization threshold this update.
     */
    recordOutcome(o: OutcomeObservation): {
        skill: LearnedSkill;
        proceduralized: boolean;
    };
    /**
     * Forgetting curve over the competence layer, plus availability recovery.
     * Skills unused for IDLE_TICKS lose habit; learned composites below DROP_HABIT
     * are dropped entirely (template + skill). Availability entries climb back
     * toward 1 and are dropped once fully recovered. Returns the ids that were
     * removed from each layer so their mirrored state entities can be deleted.
     */
    decay(tick: number): {
        skills: string[];
        availability: string[];
    };
    /** Learned composite templates + all skills above a confidence floor. */
    export(minHabit?: number): {
        composites: MotorSchema[];
        skills: LearnedSkill[];
    };
    import(data: {
        composites?: MotorSchema[];
        skills?: LearnedSkill[];
    }): void;
    /** Learned composite templates encoded as `agency.schema` state entities. */
    compositeEntities(): EntityInput[];
    /**
     * Re-register learned composites from `agency.schema` state entities after a
     * restore rebuilt the repertoire innate-only. Idempotent — skips composites
     * already present and never seeds a fresh skill (the restored `agency.skill`
     * entity and future outcomes own the habit; seeding here would reset it).
     * Mirrors GoalManager._syncFromStateGoals.
     */
    restoreComposites(entities: ReadonlySimulationState['entities']): void;
    /** Availability ledger encoded as `agency.availability` state entities (P2).
     *  Empty until a refusal lands, so the quiet path writes nothing. */
    availabilityEntities(): EntityInput[];
    /** Rehydrate the availability ledger from state after a restore. Idempotent;
     *  keeps whichever value is more restrictive so a concurrent refusal isn't lost. */
    restoreAvailability(entities: ReadonlySimulationState['entities']): void;
}

declare class AccessGrants {
    private _granted;
    /** Seed from the resolved allow-list (e.g. profile effectors). null/[] ⇒ none granted. */
    constructor(initial?: string[] | null);
    /** Is the Will permitted to use this effector/schema right now? */
    isAllowed(name: string): boolean;
    /** Grant one explicit effector (no-op for non-explicit names). */
    allow(name: string): void;
    /** Revoke one effector. */
    revoke(name: string): void;
    /** Replace the entire grant set (runtime reconfiguration). */
    setAllowed(names: string[] | null): void;
    /** The currently granted explicit effectors. */
    granted(): string[];
}

interface Cognition extends EngineRegistry {
    /** Shared outbox producer (row shape + reply audit); see #stem/tracts/outbox.writer. */
    outboxWriter: OutboxWriter;
    /** Agency pipeline competence layer (learned schemas + skills) — see #agency. */
    schemaRepertoire: SchemaRepertoire;
    /** Permission / sense-gate authority (replaces effectorRegistry's grant role). */
    accessGrants: AccessGrants;
}
/**
 * Emitted when Will decides to use an effector that has no internal handler.
 * The host system receives this via SSE and is responsible for execution.
 * When done, the host calls injectEvent() with the result.
 */
interface effectorInvocation {
    id: string;
    /** Correlation handle — the awaiting `agency.intent` id. Echo it when POSTing to
     *  `POST /v1/wills/:id/effectors/invoked/ack`; the Will reconciles the result onto
     *  that intent. (Field name kept for wire-contract stability; no longer a
     *  `decision.record` id since the agency cutover.) */
    decisionRecordId: string;
    effectorName: string;
    parameters: Record<string, unknown>;
    targetEntityId: string | undefined;
    reasoning: string;
    /** The ability's declared meaning (from its EffectorDeclaration), when present. */
    description?: string;
    tick: number;
    timestamp: number;
}
interface WorldEntity {
    id: string;
    type: string;
    name: string;
    description: string;
    /** What effectors can be used on this entity */
    affordances: string[];
    /** Current state */
    state: Record<string, unknown>;
    /** Is this entity currently reachable/interactable */
    reachable: boolean;
}
interface ActionRequest {
    /** The effector being invoked */
    effector: string;
    /** Parameters for the effector */
    parameters: Record<string, unknown>;
    /** Target entity (if any) */
    targetEntityId?: string;
    /** The Will's reasoning for this action */
    reasoning: string;
    /** Expected outcome description */
    expectedOutcome: string;
    /** The tick when this was decided */
    decidedAt: number;
}
interface ActionResult {
    /** Whether the action succeeded */
    success: boolean;
    /** Human-readable description of what happened */
    description: string;
    /** State changes that occurred as a result */
    commands: StateCommands;
    /** New entities created by this action */
    createdEntities?: WorldEntity[];
    /** Feedback for the Will to learn from */
    feedback: {
        outcomeQuality: number;
        surprise: number;
        lessons: string[];
    };
}
interface WorldInterface {
    /** Get all entities the Will can perceive right now */
    getPerceptibleEntities(state: ReadonlySimulationState): WorldEntity[];
    /** Get entities the Will can interact with */
    getInteractableEntities(state: ReadonlySimulationState): WorldEntity[];
    /** Returns true if this world can handle the given effector name. */
    canHandle(effectorName: string): boolean;
    /** Execute a Will's action in the world */
    executeAction(request: ActionRequest, state: ReadonlySimulationState): Promise<ActionResult>;
}
interface OutboxMessage {
    id: string;
    targetEntityId: string;
    targetEntityName?: string;
    content: string;
    effectorName: 'talk' | 'text' | 'gesture' | 'broadcast';
    gestureType?: string;
    createdAtTick: number;
    createdAt: number;
    /** If this message is a reply, the incoming message ID it is replying to. */
    replyToMessageId?: string;
    /**
     * Conversation thread this message belongs to.
     * Set by AuditionEngine/OutboxWriter.enqueueReply() — ties all bubbles from one exchange
     * to the same thread so the SSE consumer can group them into a single reply_complete.
     */
    threadId?: string;
    /** Delivery lifecycle: 'pending' until the SSE consumer confirms receipt. */
    deliveryStatus: 'pending' | 'delivered' | 'failed';
    /** Token usage from the outbound() composition call — used for exchange billing. */
    usage?: {
        promptTokens: number;
        completionTokens: number;
    };
}

/** The caller-supplied fields of an outbox row; the writer stamps id + defaults. */
interface OutboxRow {
    targetEntityId: string;
    content: string;
    effectorName: OutboxMessage['effectorName'];
    targetEntityName?: string;
    gestureType?: string;
    replyToMessageId?: string;
    threadId?: string;
}
declare class OutboxWriter {
    private _outbox;
    private _willId;
    private _sessionLogger;
    /**
     * Per-Will monotonic id counter. Deterministic for replay: the writer is
     * created once per Will and `enqueue` is called in the same order on a
     * re-execution, so the ids reproduce exactly (vs the old Date.now()+random,
     * which made the embedded ids in `conversation.sent` diverge every run).
     */
    private _seq;
    constructor(opts?: {
        outbox?: OutboxMessage[];
        willId?: string;
    });
    attachSessionLogger(logger: SessionLogger | null): void;
    private _genId;
    /**
     * Push one canonical outbox row and return its generated id. The single point
     * where the row shape is materialized — all producers funnel through here.
     */
    enqueue(row: OutboxRow, idSuffix?: string): string;
    /**
     * Reply convenience for AuditionEngine (formerly ProactiveCommunicator.deliverReply).
     *
     * Pushes the facet's reply bubbles as `text` outbox rows and writes the
     * `conversation.out` audit entry. Returns the generated message ids (always
     * generated, for delivery correlation), or an empty array when there are no
     * bubbles.
     *
     * `pushToOutbox` (default true) controls only whether a copy is queued: set
     * false when an ExternalTransport already delivered the reply via the fast-path
     * (avoids double delivery) — the ids are still generated and returned.
     */
    enqueueReply(opts: {
        entityId: string;
        entityName: string;
        bubbles: string[];
        threadId?: string;
        tick?: number;
        pushToOutbox?: boolean;
    }): string[];
}

declare class VisionEngine extends ShellSenseEngine {
    readonly name = "vision-engine";
    readonly domain: "vision";
    protected readonly acceptedKinds: Set<"text" | "system" | "ambient" | "voice" | "image" | "video" | "webhook" | "background" | "self-eval" | "assessment">;
}

declare class SomatosensationEngine extends ShellSenseEngine {
    readonly name = "somatosensation-engine";
    readonly domain: "somatosensation";
    protected readonly acceptedKinds: Set<"text" | "system" | "ambient" | "voice" | "image" | "video" | "webhook" | "background" | "self-eval" | "assessment">;
}

declare class OlfactionEngine extends ShellSenseEngine {
    readonly name = "olfaction-engine";
    readonly domain: "olfaction";
    protected readonly acceptedKinds: Set<"text" | "system" | "ambient" | "voice" | "image" | "video" | "webhook" | "background" | "self-eval" | "assessment">;
}

declare class GustationEngine extends ShellSenseEngine {
    readonly name = "gustation-engine";
    readonly domain: "gustation";
    protected readonly acceptedKinds: Set<"text" | "system" | "ambient" | "voice" | "image" | "video" | "webhook" | "background" | "self-eval" | "assessment">;
}

/**
 * Perceptual Tier — 5 Senses Architecture
 *
 * Shared types and the SenseEngine interface for all sense engines.
 * Sense engines are CognitiveEngines that also expose an `ingest()` method
 * for external stimuli to enter Will's cognitive pipeline.
 *
 * Events flow on the existing CognitiveBus under the `senses.*` topic prefix:
 *   senses.audition.percept   — LanguagePercept from AuditionEngine
 *   senses.vision.percept     — (shell, future)
 *   senses.somatosensation.percept — (shell, future)
 *   senses.olfaction.percept  — (shell, future)
 *   senses.gustation.percept  — (shell, future)
 *
 * AttentionAllocator subscribes to 'senses.*' to receive all percepts.
 */

type SenseDomain = 'audition' | 'vision' | 'somatosensation' | 'olfaction' | 'gustation';
/** Base percept published on the CognitiveBus. */
interface Percept {
    domain: SenseDomain;
    sourceEntityId: string;
    timestamp: number;
    salience: number;
    raw: unknown;
}
interface TextMessage {
    kind: 'text';
    entityId: string;
    threadId: string;
    content: string;
    /** Display name — used in the facet focus content. */
    speakerName?: string;
}
interface VoiceChunk {
    kind: 'voice';
    entityId: string;
    threadId: string;
    audioBuffer?: Buffer;
    transcription?: string;
}
interface ImageFrame {
    kind: 'image';
    entityId: string;
    data: Buffer;
    mimeType: string;
}
interface VideoSegment {
    kind: 'video';
    entityId: string;
    frames: ImageFrame[];
    durationMs: number;
}
interface WebhookEvent {
    kind: 'webhook';
    source: string;
    payload: unknown;
    headers: Record<string, string>;
}
interface SystemSignal {
    kind: 'system';
    signal: string;
    data: unknown;
}
interface AmbientMetric {
    kind: 'ambient';
    metricKey: string;
    value: number;
    trend: 'rising' | 'falling' | 'stable';
}
interface BackgroundSignal {
    kind: 'background';
    category: string;
    data: unknown;
}
interface InternalEvaluation {
    kind: 'self-eval';
    context: string;
    trigger: string;
}
interface SelfAssessmentTrigger {
    kind: 'assessment';
    goalId?: string;
    checkType: string;
}
/** Discriminated union of all sensory input kinds. */
type SensoryInput = TextMessage | VoiceChunk | ImageFrame | VideoSegment | WebhookEvent | SystemSignal | AmbientMetric | BackgroundSignal | InternalEvaluation | SelfAssessmentTrigger;
/**
 * SenseEngine — a CognitiveEngine that also accepts external stimuli.
 *
 * Sense engines implement the full CognitiveEngine contract
 * (publishes, subscribes, onCognitiveEvent, snapshot) plus:
 *   - `domain`: declares which sensory domain this engine handles
 *   - `ingest()`: entry point for external stimuli (called by WillManager)
 *   - `attachBus()`: called automatically by CognitiveOrchestrator.addEngine()
 *
 * Shell engines have no-op `ingest()` bodies — they log a warning and return.
 * Full engines (AuditionEngine) process percepts and publish to the bus.
 */
interface SenseEngine extends CognitiveEngine {
    readonly domain: SenseDomain;
    attachBus(bus: CognitiveBus): void;
    ingest(input: SensoryInput): Promise<void>;
}

declare abstract class BaseSenseEngine implements SenseEngine {
    abstract readonly name: string;
    abstract readonly domain: SenseDomain;
    /**
     * The `SensoryInput.kind` values this engine consumes. Inputs of any other
     * kind are ignored silently by `ingest()` (no warning, no work) — this is how
     * a single `ingestSensory(domain, input)` call can be routed leniently.
     */
    protected abstract readonly acceptedKinds: ReadonlySet<SensoryInput['kind']>;
    /**
     * Effector that gates ingestion (e.g. audition → 'listen'). When set and
     * AccessGrants denies it, `ingest()` is a silent no-op — the engine stays
     * wired but functionally inactive. `null` = always active.
     */
    protected readonly gateEffector: string | null;
    protected _bus: CognitiveBus | null;
    protected _grants: AccessGrants | null;
    attachBus(bus: CognitiveBus): void;
    /** Inject the AccessGrants so `ingest()` honours `gateEffector` (the permission gate). */
    attachGrants(g: AccessGrants): void;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    onCognitiveEvent(_e: CognitiveEvent): StateCommands | void;
    snapshot(): Record<string, unknown>;
    /**
     * Apply the effector gate + kind filter common to every sense, then delegate
     * the domain-specific work to `_perceive()`. Subclasses never re-handle gating
     * or filtering — they only implement `_perceive()`.
     */
    ingest(input: SensoryInput): Promise<void>;
    /** Domain-specific perception. Invoked only for accepted kinds, past the gate. */
    protected abstract _perceive(input: SensoryInput): Promise<void>;
    /**
     * Publish a percept on this engine's `senses.<domain>.percept` topic. The
     * single emit chokepoint — the AttentionAllocator (and, in future, a
     * cross-modal binder) observes percepts here.
     */
    protected publishPercept(percept: Percept): void;
}
/**
 * ShellSenseEngine — base for the not-yet-implemented senses
 * (vision, somatosensation, olfaction, gustation).
 *
 * `_perceive()` logs a warning (only ever reached for an accepted kind, since the
 * base filters first) and `snapshot()` advertises shell status. A concrete shell
 * is just: `name`, `domain`, and `acceptedKinds`.
 */
declare abstract class ShellSenseEngine extends BaseSenseEngine {
    snapshot(): Record<string, unknown>;
    protected _perceive(_input: SensoryInput): Promise<void>;
}

/** Minimal write-side entity shape accepted by `stateManager.setEntity`. */
interface MemoryEntity {
    id: string;
    type: string;
    metadata: Record<string, unknown>;
}
declare class AuditionEngine extends BaseSenseEngine {
    readonly name = "audition-engine";
    readonly domain: "audition";
    /** Audition consumes language input; the base filters every other kind out. */
    protected readonly acceptedKinds: Set<"text" | "system" | "ambient" | "voice" | "image" | "video" | "webhook" | "background" | "self-eval" | "assessment">;
    /** Inbound is gated on the 'listen' effector — the base enforces it before _perceive(). */
    protected readonly gateEffector = "listen";
    private _executiveEngine;
    private _episodicConsolidator;
    private _outboxWriter;
    /**
     * Chunk subscribers — multi-subscriber so several consumers (transport emit,
     * SSE fan-out) receive the filtered [REPLY_TEXT] stream simultaneously.
     * Handlers get (entityId, threadId, chunk).
     */
    private _chunkCallbacks;
    private _replyCallback;
    /** One facet per active conversation (keyed by entityId). */
    private _facets;
    /** Rolling thread digests keyed by threadId. */
    private _digests;
    /** Salience computer — tracks baseline message energy per entity. */
    private _model;
    /**
     * Per-entity chunk stream state.
     * Tracks position in the raw LLM token stream so only [REPLY_TEXT] content
     * is forwarded to chunk subscribers — internal reasoning and JSON never leak.
     */
    private _streamState;
    /**
     * Per-entity promise chain. Each entity processes its messages strictly one
     * turn at a time so two rapid messages never interleave the shared per-entity
     * stream state, the facet's reasoning history, or the chunk stream.
     */
    private _entityTail;
    /** Resolver for the in-flight turn per entity — fired by _onFacetDecision. */
    private _turnDone;
    /** Safety valve: release the entity queue if a reasoning cycle emits no decision. */
    private _turnTimeoutMs;
    /**
     * Open coalescing window per entity (§6). Rapid-fire messages that arrive while a
     * turn is queued-but-not-yet-started fold into the same window, so a burst becomes
     * one turn instead of N. The window closes the instant its turn starts (parts are
     * snapshotted), and the next message opens a fresh window behind it on the chain.
     */
    private _coalesce;
    /**
     * Persists conversation turns as `working_memory.item` state entities
     * (wmType: 'conversation.exchange'), so they flow through the canonical
     * WorkingMemory → EpisodicConsolidator → vector pipeline — the same path every
     * other percept uses. Wired to `stateManager.setEntity` in assembleMind().
     */
    private _memorySink;
    /** Deterministic id source for `conversation.received` — see _writeReceived. */
    private _receivedSeq;
    /** Deterministic id source for `conversation.sent` — see _writeSent. */
    private _sentSeq;
    /** Speaker attachment strength accessor (0–1) — weights salience by relationship. */
    private _getAttachmentScore;
    /** Active-goal topic text accessor — for salience topic-overlap. */
    private _getActiveGoalText;
    /** In-flight inbound text per entity — paired with the reply into an exchange memory. */
    private _inflightInbound;
    /** In-flight thread per entity — stamps chunk envelopes with the current threadId. */
    private _inflightThread;
    /** Targets with an outreach being composed right now — see authorOutreach. */
    private _outreachInFlight;
    attachExecutiveEngine(exec: ExecutiveEngine): void;
    /**
     * Inject the OutboxWriter so reply bubbles are delivered through the canonical
     * outbox path (or the transport fast-path when one is attached). A sense engine
     * needs only to write to the outbox — not the effector executor.
     * Called by `assembleMind()` after the engines are constructed.
     */
    attachOutboxWriter(writer: OutboxWriter): void;
    /**
     * Inject a chunk delivery callback — called per token chunk as the
     * conversation facet streams its response.
     * In production: WillManager provides this to push chunks into the SSE outbox.
     * Full wiring deferred to Section 5.4 (requires onChunk() on ExecutiveFacetHandle).
     */
    /**
     * Inject an episodic recall accessor (`semanticQuery` → exchange summaries) used
     * to seed an empty thread digest on cold facet spawn (§5.4). Wired only when a
     * vector adapter is present; absent → digests simply start empty on cold spawn.
     */
    attachEpisodicConsolidator(consolidator: EpisodicConsolidator): void;
    /**
     * Subscribe to the filtered reply-token stream (content between [REPLY_TEXT]
     * and [/REPLY_TEXT] only). Multi-subscriber — the transport emit and the SSE
     * fan-out can both listen. Returns an unsubscribe.
     */
    addChunkCallback(cb: (entityId: string, threadId: string, chunk: string) => void): () => void;
    /**
     * Inject a reply callback fired the instant a facet decision is ready, with the
     * assembled bubbles. The stem bridges this to `transport.emit({channel:'reply'})`
     * for off-tick delivery — decoupled from the outbox tick-drain. The outbox copy
     * (via OutboxWriter.enqueueReply) remains as the disconnect buffer / legacy SSE path.
     */
    attachReplyCallback(cb: (entityId: string, threadId: string, bubbles: string[]) => void): void;
    /**
     * Inject a sink that persists conversation turns as `working_memory.item`
     * state entities. Wired to `simulation.stateManager.setEntity` in assembleMind()
     * so the EpisodicConsolidator consolidates exchanges on its next tick.
     */
    attachMemorySink(sink: (entity: MemoryEntity) => void): void;
    /** Inject a per-entity attachment-strength accessor (reads AttachmentEvaluator). */
    attachAttachmentScore(fn: (entityId: string) => number): void;
    /** Inject an active-goal topic-text accessor (reads GoalManager) for salience overlap. */
    attachActiveGoalText(fn: () => string[]): void;
    /** Override: audition adds the facet→master handoff to the base percept schema. */
    publishes(): CognitiveEventSchema[];
    snapshot(): Record<string, unknown>;
    /**
     * Domain perception. The base `ingest()` calls this for accepted kinds
     * (text/voice) only once the 'listen' gate passes — so the gate + kind filter
     * are no longer repeated here.
     *
     * Two layers of per-entity ordering:
     *   - Serialization (Tier 2): an entity processes one turn at a time so rapid
     *     messages never interleave stream state, reasoning history, or the chunk
     *     stream.
     *   - Coalescing (§6): messages that pile up before a turn STARTS fold into that
     *     turn, so a burst becomes one reply instead of N. Once the turn starts, the
     *     next message opens a fresh window behind it on the chain.
     *
     * The returned promise resolves when the turn this message folded into completes,
     * so callers awaiting ingest() still see their turn through.
     */
    protected _perceive(input: SensoryInput): Promise<void>;
    /** Extract the textual content of a message (voice → transcription). */
    private _contentOf;
    /**
     * Run one coalescing window as a single turn. Closing the window (started=true +
     * delete) BEFORE processing snapshots its parts: any message arriving from here on
     * opens a fresh window that the chain runs after this turn. `done` resolves for
     * every folded `ingest()` on every exit path.
     */
    private _runCoalesced;
    private _getEpisodicRecall;
    /**
     * Append a unit of work to an entity's serial turn chain. A rejected unit is
     * isolated so it never breaks the chain for subsequent messages.
     */
    private _enqueue;
    /** Process one conversational turn end-to-end (runs serialized per entity). */
    private _processMessage;
    /**
     * Arm the in-flight turn deferred for an entity. Returns a promise that
     * resolves when the turn's decision arrives (_endTurn) or the safety timeout
     * fires — guaranteeing the per-entity queue can never deadlock.
     */
    private _beginTurn;
    /** Release the in-flight turn for an entity (idempotent). */
    private _endTurn;
    private _routeToFacet;
    private _pipeChunk;
    /** Fan a filtered reply-token out to all chunk subscribers, stamping the current thread. */
    private _emitChunk;
    private _buildFocus;
    /**
     * Author the words for a PROACTIVE outreach the agency selected — a self-initiated
     * contact with no inbound to trigger a reply. Reuses the unified conversation voice
     * ([REPLY_TEXT] → bubbles, same persona/identity/memory grounding) via a TRANSIENT
     * facet with its OWN subscription, so it never collides with the entity's live
     * reactive facet or double-delivers. Returns the bubbles for the caller
     * (MotorSchemaExecutor) to deliver through the proactive communicate path; empty
     * when no executive is attached or the facet budget is full (caller then awaits).
     */
    authorOutreach(entityId: string, entityName: string, gist?: string): Promise<string[]>;
    /**
     * Persist one completed exchange (inbound + reply) as a `working_memory.item`
     * state entity so the EpisodicConsolidator consolidates it on its next tick.
     *
     * Off-tick `setEntity` matches the established external-injection pattern
     * (`injectEvent`); it becomes on-tick automatically once inbound marshaling
     * (Section 1.2) routes ingest through the tick loop. The entity carries no
     * wall-clock timestamp — `setEntity` stamps createdAt/tick from the sim clock.
     */
    /**
     * The inbound as a social signal in state — mirror of `conversation.sent`.
     *
     * Shaped for `SocialPerception._scanSocialSignals`, which reads `sourceKeid` for
     * who acted and `directedAtSelf` for whether it was aimed at us. Valence is left
     * UNSET on purpose: the words have not been appraised yet, and guessing a number
     * here would feed reputation and affect a sentiment nobody measured. Absent, the
     * scanner falls back to its neutral default, so the Will learns *that* someone
     * engaged (familiarity, recency, reliability) without inventing how it felt.
     */
    private _writeReceived;
    /**
     * Record that the mind SPOKE to someone, mirroring `_writeReceived`.
     *
     * Only ProactiveCommunicator wrote `conversation.sent`, so a reply — which is
     * most of what a Will says — left no durable trace of having spoken. Everything
     * that asks "have I already said something to them?" was therefore blind to
     * conversation: satiation could not damp repeating a relay delivered as a reply,
     * and an undertaking discharged inside a conversation stayed forever unkept,
     * which is exactly how the same message went out again and again.
     *
     * Speaking is speaking, whichever path carried it.
     */
    private _writeSent;
    private _persistExchangeMemory;
    private _onFacetDecision;
    /**
     * Terminate the conversation session for an entity.
     * Called when the SSE/WS client disconnects or the session expires.
     */
    endSession(entityId: string): void;
    /**
     * Drop all per-entity session state. Does NOT destroy the facet handle — used
     * both after an explicit `endSession()` (handle already destroyed) and from the
     * `onReaped` callback when the supervisor reclaims the facet (already destroyed).
     * Idempotent: deleting absent keys is safe.
     */
    private _teardownEntity;
    /** Active entityId sessions. */
    activeSessions(): string[];
    destroy(): void;
}

interface Instruction {
    /** Unique ID */
    id: string;
    /** Who gave the instruction */
    source: string;
    /** What to do */
    directive: string;
    /** Priority override (0-1, higher = more important) */
    priority: number;
    /** Deadline in ticks (if any) */
    deadline?: number;
    /** Constraints on how to execute */
    constraints?: string[];
    /** Context/provenance — why this instruction was given */
    context: string;
    /** Whether the Will can refuse */
    isOverridable: boolean;
    /** Status */
    status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'refused' | 'failed';
    /** When it was received */
    receivedAt: number;
}
declare class InstructionHandler {
    private _pending;
    private _history;
    /**
     * Receive an instruction from an external source.
     * Converts it to a goal in the GoalManager if accepted.
     */
    receive(instruction: Omit<Instruction, 'status' | 'receivedAt'>): Instruction;
    /**
     * Evaluate pending instructions against current state.
     * Called each tick before decision-making.
     * Returns instructions that should be converted to goals.
     */
    evaluatePending(state: ReadonlySimulationState, currentValues: string[]): Instruction[];
    /**
     * Convert accepted instructions into goals.
     */
    convertToGoal(instruction: Instruction): {
        description: string;
        priority: number;
        tags: string[];
        completionType: 'action';
        completionCondition?: string;
    };
    markCompleted(instructionId: string): void;
    markFailed(instructionId: string, reason: string): void;
    getPending(): ReadonlyArray<Instruction>;
    getHistory(): ReadonlyArray<Instruction>;
    private _shouldRefuse;
}

declare class InstructionIntake implements CognitiveEngine {
    readonly name = "instruction-intake";
    private _instructionHandler;
    private _goalManager;
    attachInstructionHandler(h: InstructionHandler): void;
    attachGoalManager(gm: GoalManager): void;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    onCognitiveEvent(): void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, _tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
}

type SkillAccessor = () => ReadonlyMap<string, LearnedSkill>;
declare class AffordanceSynthesizer implements CognitiveEngine {
    readonly name = "affordance-synthesizer";
    private _schemas;
    private _skills;
    private _repertoire;
    /**
     * This tick's live consequence descriptors — the acts the mind has performed
     * whose outcome has not yet come back. Refreshed once at the top of react()
     * because `_build` runs per candidate and reading them is a full-entity scan.
     */
    private _inFlight;
    /** Ticks an act stays satiating (engine-config-action-selector.repeatWindowTicks). */
    private _satiationWindow;
    /** Tick of the last thing said to each entity — outlives the descriptor sweep. */
    private _spokenAt;
    private _bus;
    private _defaultCap;
    private _lastFieldSize;
    constructor(schemas?: MotorSchema[], defaultCap?: number);
    attachBus(bus: CognitiveBus): void;
    /** Inject the repertoire's learned-skill accessor (Phase 3). */
    attachSkills(accessor: SkillAccessor): void;
    /**
     * Attach the live repertoire — its templates (innate floor + learned composites)
     * become the schema set, and its skills feed the affordance priors. This is how
     * a newly-learned composite shows up in the field without a restart.
     */
    attachRepertoire(repertoire: SchemaRepertoire): void;
    /** Register an additional schema template (e.g. a learned composite). */
    registerSchema(schema: MotorSchema): void;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    onCognitiveEvent(): void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    /** Compose an Affordance from a schema + the evoking context, folding in learned priors. */
    private _build;
    private _toEntity;
    private _available;
    private _attentionCap;
}

declare class ActionSelector implements CognitiveEngine {
    readonly name = "action-selector";
    private _bus;
    private _lastEntropy;
    private _lastDeliberate;
    private _lastRevoked;
    private _senseBuffer;
    attachBus(bus: CognitiveBus): void;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    /**
     * Mostly pull-model — but two afferent classes never become entities and
     * would leave rupture blind: sense-channel percepts
     * (ACTION_CONDITIONED_PREDICTION §2b) and the model-error state-change
     * events (registry #6). Buffer both (cross-tick: bus flush at T, consumed
     * by react at T+1 — FN9-snapshotted); the echo guard is applied at read
     * time for texts, and at the SOURCE for model errors (ACP-P2 precision).
     */
    onCognitiveEvent(e: CognitiveEvent): void;
    snapshot(): Record<string, unknown>;
    /** FN9: `_lastRevoked` has behavioral effect (the Channel-B `revokedBy` stamp),
     *  so a restored mind must carry it — a rupture-driven letting-go survives a
     *  snapshot boundary instead of silently losing its narrative thread. */
    restore(s: Record<string, unknown>): void;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
}

interface DeliberationFacetHandle {
    setFocus(focus: {
        title: string;
        content: string;
        instructions?: string;
        function?: string;
    }): void;
    report(report: {
        type: string;
        payload: unknown;
    }): Promise<void> | void;
    subscribe(listener: (decision: {
        decision: unknown;
    }) => void): () => void;
    destroy(): void;
}
interface DeliberationFacetProvider {
    spawnFacet(role?: 'deliberation'): {
        attention: 'available' | 'full';
        handle?: DeliberationFacetHandle;
    };
}
declare class DeliberationEngine implements CognitiveEngine {
    readonly name = "deliberation";
    private _provider;
    private _handle;
    private _bus;
    private _willName;
    private _deliberations;
    attachBus(bus: CognitiveBus): void;
    /**
     * Attach the executive (facet provider). Absent ⇒ the engine confirms the
     * substrate's winner (System 1) — used at basic tier where no LLM runs.
     */
    attachExecutive(provider: DeliberationFacetProvider): void;
    setWillName(name: string): void;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    onCognitiveEvent(): void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    /** Run one unified-inference deliberation. Returns the chosen schema (or the provisional winner on any failure). */
    private _deliberate;
    /** Write the deliberating intent back as 'selected' with the chosen action. */
    private _commit;
    /** The deliberation focus body — the candidate actions the substrate surfaced. */
    private _buildFocusContent;
}

interface ProactiveCommunicatorOptions {
    /** Shared outbox producer — owns the row shape; the executor delegates pushes. */
    writer: OutboxWriter;
    willId?: string;
}
declare class ProactiveCommunicator {
    private _writer;
    private _willId;
    private _sessionLogger;
    constructor(options: ProactiveCommunicatorOptions);
    attachSessionLogger(logger: SessionLogger | null): void;
    executeAction(request: ActionRequest, _state: ReadonlySimulationState): Promise<ActionResult>;
    private _handleListen;
    private _handleGesture;
    private _handleBroadcast;
    private _handleOutboundMessage;
}

/** Authors the words for a self-initiated communicate the agency selected (no inbound triggered it). */
interface OutreachAuthor {
    authorOutreach(entityId: string, entityName: string, gist?: string): Promise<string[]>;
}
declare class MotorSchemaExecutor implements CognitiveEngine {
    readonly name = "motor-schema-executor";
    private _schemas;
    private _repertoire;
    private _comms;
    private _author;
    private _grants;
    private _bus;
    /**
     * Two-phase outreach authoring. A facet cannot be awaited from inside a tick:
     * `ExecutiveFacet.report()` only QUEUES in tick-discipline mode and the reasoning
     * launches from `pump()`, which the ExecutiveEngine calls once per tick — so an
     * in-tick `await` blocks the very loop that would produce the answer. Observed
     * live: a 61s freeze of the whole mind inside one tick, then an empty result.
     * (It passes unit tests because bare facets have no inbox and author inline.)
     *
     * So `_deliver` REQUESTS words and returns false (the intent holds 'awaiting'),
     * the facet answers off-tick, and a later tick delivers. Process-local by design:
     * an authoring call in flight cannot survive a restart, and the intent would
     * simply re-request.
     */
    private _authoring;
    private _authored;
    constructor(schemas?: MotorSchema[]);
    attachBus(bus: CognitiveBus): void;
    /** Resolve schemas (incl. learned composites) from the live repertoire first. */
    attachRepertoire(repertoire: SchemaRepertoire): void;
    /** Inject the communicate-enaction handler (owned here; the only caller). */
    attachProactiveCommunicator(c: ProactiveCommunicator): void;
    /** Inject the outreach author — words for a self-initiated communicate are authored on selection. */
    attachOutreachAuthor(a: OutreachAuthor): void;
    /** Forward the session logger to the owned ProactiveCommunicator (it audits outbound). */
    attachSessionLogger(logger: SessionLogger | null): void;
    /** Inject the permission gate so outbound communication is grant-checked. */
    attachGrants(g: AccessGrants): void;
    registerSchema(schema: MotorSchema): void;
    /** Repertoire-first schema resolution, falling back to the local seed set. */
    private _resolve;
    publishes(): CognitiveEventSchema[];
    subscribes(): string[];
    /**
     * The executor is plan-agnostic. A plan does NOT dispatch steps here — it biases
     * the affordance competition (see PLANNING_AS_PRIOR_TODO.md), so a plan-driven
     * action reaches the executor as an ordinary committed `agency.intent` the
     * selector won. That intent already carries planId/stepId provenance (stamped by
     * the selector from the winning affordance); `_emitActionOutcome` threads it back
     * out, which is how the PlanningEngine advances. Nothing plan-specific here.
     */
    onCognitiveEvent(): void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _expand;
    private _advance;
    private _subIntent;
    /**
     * Deliver a communicate intent through the shared ProactiveCommunicator, gated by
     * AccessGrants. Returns true when it handled the intent (delivered + outcome written),
     * false when it cannot (no delivery layer / no authored content) so the caller holds
     * the intent 'awaiting'. Message *content* is authored upstream (the deliberation /
     * conversation facet); this is the single enaction → delivery path.
     */
    private _deliver;
    /**
     * Ask a facet for the words, off-tick. Fire-and-forget on purpose: awaiting this
     * from inside `react()` deadlocks the tick loop against the facet pump. Idempotent
     * per intent — a request already in flight is not duplicated, so the intent may sit
     * 'awaiting' across many ticks with exactly one LLM call behind it.
     */
    private _requestAuthoring;
    private _emitEnacted;
    /**
     * Publish `action.outcome` for EVERY enaction — the shared metacognitive/affective
     * sink. The PlanningEngine consumes it (when planId/stepId are present) to advance
     * a plan; the ConfidenceCalibrator calibrates predicted-vs-actual from it; the
     * RewardEvaluator reads it as a reward signal. `confidence` carries the agency's
     * own forward-model prior so calibration has a real prediction to score.
     */
    private _emitActionOutcome;
    private _emitDispatch;
}

declare class ReafferenceEngine implements CognitiveEngine {
    readonly name = "reafference";
    private _repertoire;
    private _bus;
    constructor(repertoire: SchemaRepertoire);
    attachBus(bus: CognitiveBus): void;
    publishes(): CognitiveEventSchema[];
    /** Creation seam: register a composite proposed by the executive/deliberation facet. */
    subscribes(): string[];
    onCognitiveEvent(e: CognitiveEvent): void;
    snapshot(): Record<string, unknown>;
    react(_delta: Duration, tick: Tick, state: ReadonlySimulationState, _context: SimulationContext): Promise<EngineResult>;
    private _emitProceduralized;
    /**
     * Emit the `action.outcome{planId,stepId}` for an async (host-acked) plan-step
     * enaction. Mirrors the executor's `_emitActionOutcome` payload so the
     * PlanningEngine's consumer can't tell which path produced it.
     */
    private _emitPlanOutcome;
    private _emitDiscovered;
}

type EngineRegistry = {
    instructionIntake: InstructionIntake;
    energyRegulator: EnergyRegulator;
    sleepPressureRegulator: SleepPressureRegulator;
    circadianOscillator: CircadianOscillator;
    attentionAllocator: AttentionAllocator;
    stressRegulator: StressRegulator;
    exteroception: Exteroception;
    interoception: Interoception;
    socialPerception: SocialPerception;
    noveltyDetector: NoveltyDetector;
    threatEvaluator: ThreatEvaluator;
    rewardEvaluator: RewardEvaluator;
    lossEvaluator: LossEvaluator;
    frustrationEvaluator: FrustrationEvaluator;
    attachmentEvaluator: AttachmentEvaluator;
    aestheticEvaluator: AestheticEvaluator;
    moralEvaluator: MoralEvaluator;
    affectiveBlender: AffectiveBlender;
    workingMemory: WorkingMemory;
    episodicConsolidator: EpisodicConsolidator;
    /**
     * The vector index, when semantic recall is configured. Exposed so shutdown can
     * FLUSH it: it lives outside the state snapshot and previously persisted only from
     * a debounce timer no shutdown path awaited, so it died with the process.
     */
    vectorMemory: VectorMemoryAdapter | null;
    semanticIntegrator: SemanticIntegrator;
    spacedRepetition: SpacedRepetition;
    forgettingCurve: ForgettingCurve;
    dreamSimulator: DreamSimulator;
    executiveEngine: ExecutiveEngine;
    goalManager: GoalManager;
    planningEngine: PlanningEngine;
    inhibitionCtrl: InhibitionController;
    taskSwitcher: TaskSwitcher;
    selfModelUpdater: SelfModelUpdater;
    confidenceCalibrator: ConfidenceCalibrator;
    biasDetector: BiasDetector;
    autobiographicalNarrator: AutobiographicalNarrator;
    introspectionEngine: IntrospectionEngine;
    personaConsolidator: PersonaConsolidator;
    theoryOfMind: TheoryOfMind;
    empathySimulator: EmpathySimulator;
    reputationTracker: ReputationTracker;
    knownEntityTracker: KnownEntityTracker;
    auditionEngine: AuditionEngine;
    visionEngine: VisionEngine;
    somatosensationEngine: SomatosensationEngine;
    olfactionEngine: OlfactionEngine;
    gustationEngine: GustationEngine;
    affordanceSynthesizer: AffordanceSynthesizer;
    actionSelector: ActionSelector;
    deliberationEngine: DeliberationEngine;
    motorSchemaExecutor: MotorSchemaExecutor;
    reafferenceEngine: ReafferenceEngine;
    tokenTracker: TokenTracker;
};

interface BaseEnvelope {
    /** Will instance this envelope belongs to (routing key for the peer). */
    willId: string;
    /**
     * Stable id used to match an outbound envelope to its ack(s).
     * For messages this is the OutboxMessage id; for effector invocations the
     * decisionRecordId; for replies/chunks a generated id.
     */
    correlationId: string;
    /** Monotonic per-Will sequence number — ordering + dedup at the peer. */
    seq: number;
    /** Wall-clock emit/arrival time. Telemetry only (R2) — never replay state. */
    wallTime: number;
}
/** Facet reply, assembled. Fast path — emitted the instant the facet decides. */
interface ReplyEnvelope extends BaseEnvelope {
    channel: 'reply';
    entityId: string;
    threadId: string;
    bubbles: string[];
    replyToMessageId?: string;
}
/** One streamed LLM token for a live conversation. Fast path, best-effort. */
interface ChunkEnvelope extends BaseEnvelope {
    channel: 'chunk';
    entityId: string;
    threadId: string;
    content: string;
}
/** Generic outbox message (talk/text/gesture/broadcast). Bridged on tick drain. */
interface MessageEnvelope extends BaseEnvelope {
    channel: 'message';
    message: OutboxMessage;
}
/** External effector call for the peer/host to execute. Result returns via ack. */
interface effectorInvocationEnvelope extends BaseEnvelope {
    channel: 'effector_invocation';
    invocation: effectorInvocation;
}
/** Projection of a cognitive percept — observability only. */
interface PerceptEnvelope extends BaseEnvelope {
    channel: 'percept';
    domain: string;
    payload: Record<string, unknown>;
}
/** Plan/activity event for the peer's activity stream. */
interface ActivityEnvelope extends BaseEnvelope {
    channel: 'activity';
    entityId: string;
    eventType: string;
    payload: Record<string, unknown>;
}
/**
 * A SessionLogger NDJSON entry — observability. Emitted so the consumer owns log
 * persistence (Postgres, S3, Kafka, …) instead of the Will writing files/S3.
 */
interface SessionLogEnvelope extends BaseEnvelope {
    channel: 'session_log';
    entry: Record<string, unknown>;
}
/**
 * One attributed token/cost ledger record — observability + billing. Carries the
 * 5-axis attribution (category/attribute/function/scope/label) + tokens + costUsd
 * so the consumer can meter and re-bill end-users straight off the stream.
 */
interface TokenReportEnvelope extends BaseEnvelope {
    channel: 'token_report';
    report: Record<string, unknown>;
}
type OutboundEnvelope = ReplyEnvelope | ChunkEnvelope | MessageEnvelope | effectorInvocationEnvelope | PerceptEnvelope | ActivityEnvelope | SessionLogEnvelope | TokenReportEnvelope;
/** Conversational text/voice from an external entity. */
interface InboundMessageEnvelope extends BaseEnvelope {
    channel: 'inbound_message';
    kind: 'text' | 'voice';
    entityId: string;
    threadId: string;
    content: string;
    speakerName?: string;
}
/** A non-conversational external percept (webhook, system signal, etc.). */
interface InboundPerceptEnvelope extends BaseEnvelope {
    channel: 'inbound_percept';
    domain: string;
    payload: Record<string, unknown>;
}
/**
 * Acknowledgement for a prior outbound envelope.
 *   - 'delivery' → receipt confirmation (edge-level; updates outbox status)
 *   - 'result'   → effector execution result (crosses determinism boundary →
 *                  applied on tick via confirmExecution)
 * `correlationId` points back to the acked outbound envelope.
 */
interface AckEnvelope extends BaseEnvelope {
    channel: 'ack';
    ackKind: 'delivery' | 'result';
    delivered?: boolean;
    result?: {
        success: boolean;
        description: string;
        metrics?: Record<string, number>;
    };
}
type InboundEnvelope = InboundMessageEnvelope | InboundPerceptEnvelope | AckEnvelope;
type Envelope = OutboundEnvelope | InboundEnvelope;
type TransportStatus = 'connected' | 'disconnected' | 'reconnecting';
interface AckResult {
    acked: boolean;
    via: 'callback' | 'event' | 'timeout';
    payload?: unknown;
}
interface ExternalTransport {
    /** True when a live connection to the peer exists. */
    readonly connected: boolean;
    /**
     * Emit an outbound envelope. Resolves when the peer acks (via socket.io ack
     * callback) or the ack times out. Resolution NEVER mutates simulation state —
     * the caller decides what to do with the AckResult (e.g. requeue the outbox).
     */
    emit(env: OutboundEnvelope, opts?: {
        ackTimeoutMs?: number;
    }): Promise<AckResult>;
    /**
     * Register a handler for inbound envelopes. The stem's handler MUST do nothing
     * but enqueue onto the InboundQueue — application happens on tick.
     * Returns an unsubscribe function.
     */
    onInbound(handler: (env: InboundEnvelope) => void): () => void;
    /** Connection lifecycle notifications (for buffer flush on reconnect). */
    onStatus(handler: (status: TransportStatus) => void): () => void;
    /** Tear down the connection and all handlers. */
    close(): void;
}

/**
 * Anatomy — the only structural variant a Will has.
 *   mind   — the whole cognitive architecture (default). Faculties are not a
 *            pricing axis; hosts differentiate on model + budgets (cadence,
 *            ceilings), never by amputating engines.
 *   reflex — a no-LLM shell: regulatory + senses + agency heuristics only,
 *            for embedded / offline deployments (no System 2 at all).
 */
type Anatomy = 'mind' | 'reflex';
/**
 * Per-role model map — different cognitive work can run on different models.
 * Unset thinking roles fall back to `executive`; `embedding` belongs to the
 * embedding stack (its own provider/key resolution) and never falls back to a
 * chat model.
 */
interface WillModelConfig {
    /** The master consciousness + any facet without a more specific role. */
    executive?: string;
    /** Memory-consolidation summaries — classic cheap-model work. */
    summarizer?: string;
    /** The deliberation facet — action choice under contest. */
    deliberation?: string;
    /** Conversation + outreach facets — the user-facing voice (latency/tone lever). */
    conversation?: string;
    /** Semantic-memory embedder ('provider/model' form supported). */
    embedding?: string;
}
/**
 * Per-Will LLM transport overrides — provider, credentials, limits. Every
 * field falls back to the corresponding env (WILL_LLM_*); the primary use is
 * BYO keys: a host billing LLM spend to the customer's own provider account.
 * `apiKey` is held in memory only — it is never mirrored into state entities,
 * session logs, or the PMA.
 */
interface WillProviderConfig {
    /** Credential for this provider. Held in memory only — never state/logs/PMA. */
    apiKey?: string;
    /** Base URL override — self-hosted or OpenAI-compatible endpoints. */
    baseUrl?: string;
    /**
     * USD per 1M tokens, keyed by model id. Host-owned on purpose: prices change
     * on a vendor's schedule, differ per account, and are ~0 self-hosted, so they
     * cannot be tracked from inside an npm release. These win over the engine's
     * built-in fallback table.
     *
     * Cost is telemetry only — it never enters simulation state — so changing a
     * price can never change what a mind does or break a replay.
     */
    prices?: PriceTable;
}
interface WillLLMConfig {
    provider?: LLMProvider;
    apiKey?: string;
    baseUrl?: string;
    maxOutputTokens?: number;
    timeoutMs?: number;
    /**
     * Everything the host knows about each provider — credential, endpoint, and
     * prices — declared once per provider. The single-provider fields above stay
     * the simple path; this map is for hosts reaching more than one.
     */
    providers?: Partial<Record<LLMProvider, WillProviderConfig>>;
    /**
     * Per-call model selection. Omitted (or NULL_ROUTER) means every call uses
     * `model` above, exactly as before the seam existed.
     *
     * The router sees only the call's attribution — what kind of work it is and
     * how much the moment demands — never who is paying or what anything costs.
     * Routes name providers from the `providers` map above; a route to a provider
     * with no credential falls back to the default rather than failing the call.
     */
    router?: ModelRouter | null;
    /**
     * Concrete LLM model id(s) for this Will — a single id for every role, or a
     * per-role map. An explicit WILL_LLM_MODEL env pins the thinking roles
     * (operator single-model deployments); unset roles fall back to `executive`,
     * then the LLMDirector's built-in default. Product-level labels (pricing
     * tiers, model families) live host-side and resolve to concrete ids BEFORE
     * reaching the engine.
     */
    model?: string | WillModelConfig;
}
interface WillIdentity {
    /**
     * Persona overlay — who this Will is: backstory, personality, world context.
     *
     * This is appended after the immutable Will-core preamble, which grounds the LLM
     * in the cognitive architecture and how to interpret its state data. You do NOT
     * need to describe energy, memory, executive reasoning, or any engine — the platform
     * handles that automatically and always.
     *
     * Focus on: character, history, relationships, domain context.
     * Example: "I was created to oversee the Nexus research station..."
     *
     * Leaving this empty is valid — the Will-core preamble alone produces a functioning mind.
     */
    prompt: string;
    values: string[];
    traits: Record<string, number>;
    style: string;
}
interface InitialGoal {
    id?: string;
    description: string;
    priority: number;
    tags?: string[];
}
interface WillConfig {
    /** Unique identifier — used as thread key and filesystem path segment. */
    id: string;
    /** Human-readable name for display purposes. */
    name: string;
    /**
     * World profile — a named configuration preset for common use cases.
     * Sets default effectors and injects environment context into the executive prompt.
     * Profile effectors are merged with allowedGenericEffectors (explicit takes precedence).
     * null or omitted = no profile (Will has no environmental context by default).
     */
    profile?: string | null;
    /** Persona definition seeded into the will.identity entity. */
    identity: WillIdentity;
    /** Anatomy — 'mind' (default) or the no-LLM 'reflex' shell. */
    anatomy?: Anatomy;
    /**
     * Per-Will LLM transport overrides (provider, BYO apiKey, baseUrl, output
     * cap, timeout). Unset fields fall back to WILL_LLM_* envs. The apiKey never
     * touches state, logs, or the PMA.
     */
    llm?: WillLLMConfig;
    /** Whether to persist snapshots between restarts. */
    persistentMemory: boolean;
    /** How many ticks between in-memory snapshots. */
    snapshotInterval: number;
    /** Milliseconds to wait between ticks. Default: 1000 */
    tickIntervalMs?: number;
    /** Stop automatically after this many ticks. 0 = run forever. Default: 0 */
    maxTicks?: number;
    /** Seed for the PRNG inside the simulation. Default: Date.now() */
    randomSeed?: number;
    /**
     * Optional simulation-clock configuration. Omitted (the default) leaves the
     * clock in wall-time mode — sim-time tracks real elapsed time. Pass
     * `{ fixedDeltaMs, startTime }` to put the clock in deterministic mode, where
     * sim-time advances purely from ticks. This is what makes a run reproducible
     * for record-and-replay (R2); production runs normally leave it unset.
     */
    clock?: ClockConfig;
    /**
     * How many ticks between executive (LLM) calls — the cadence budget.
     * Clamped to minExecutiveInterval if set. Default: balanced (60).
     */
    executiveInterval?: number;
    /**
     * Plan-enforced floor for executiveInterval — the customer cannot go faster.
     */
    minExecutiveInterval?: number;
    /**
     * Goals seeded before the first tick. If omitted or empty, the Will starts
     * goalless — the executive engine will generate context-appropriate goals on its
     * first cycle (triggered automatically after ~20 goalless ticks).
     *
     * Prefer leaving this empty for domain-specific Wills and letting the LLM derive
     * goals from the identity/persona. Only pre-seed when a concrete starting mission
     * is known at construction time (e.g. "guard the northern gate").
     */
    initialGoals?: InitialGoal[];
    /**
     * Optional custom StorageAdapter for the SnapshotManager.
     *
     * When provided, simulation snapshots are stored via this adapter instead
     * of the default BunStorageAdapter (filesystem). The backend passes a
     * PostgresStorageAdapter here so snapshots land in the `will_snapshots`
     * table rather than on disk — enabling stateless/serverless deployments.
     *
     * Omit to keep the default file-based snapshot persistence.
     */
    snapshotStorage?: StorageAdapter;
    /**
     * Optional pre-built VectorMemoryAdapter for semantic episode search.
     *
     * When provided, this adapter is used directly and env-var HNSW wiring
     * is skipped entirely. The backend injects a pgvector-backed adapter here
     * so vector storage lives in the database rather than on local disk —
     * required for stateless deployments where HNSW on the filesystem would
     * be rebuilt from scratch on every process restart.
     *
     * The adapter is responsible for its own embedding provider internally.
     * Omit to fall back to env-var-based HNSW (WILL_EMBEDDING_API_KEY) or
     * no vector memory if neither is configured.
     */
    vectorMemoryAdapter?: VectorMemoryAdapter;
    /** Disable semantic vector memory for this Will — e.g. ephemeral eval/probe
     *  instances that don't need recall and shouldn't hit the embedding API. */
    disableVectorMemory?: boolean;
    /**
     * Optional pre-built ExternalTransport — Will's bidirectional channel to its
     * host peer (e.g. a socket.io server owned by the backend). The CALLER
     * constructs it (e.g. `new SocketIoTransport({ url, token })`) so the `will`
     * package never hard-depends on `socket.io-client`. When present, the stem
     * wires its inbound stream onto the tick-stamped InboundQueue and exposes it
     * for outbound emission. Omit for the legacy outbox/SSE delivery path.
     */
    transport?: ExternalTransport;
    /**
     * Communication effectors explicitly granted to this Will.
     *
     * Communication effectors (listen, talk, text, gesture, broadcast) are NOT
     * available by default — they require an explicit opt-in here. This keeps
     * developers aware of the communication surface they are opening.
     *
     * null or omitted = no communication effectors (minimal default).
     * Example: ['listen', 'talk', 'text'] enables inbound + text outbound.
     *
     * A domain effector may be a bare name or an object carrying its meaning +
     * intrinsic priors: `{ name, description?, cost?, valence?, preconditions? }`
     * (see EffectorDeclaration). Comms names are always bare.
     */
    allowedGenericEffectors?: EffectorDeclaration[] | null;
    /**
     * When true the executive engine uses a canned mock LLM response instead of
     * calling the real API. Zero cost, deterministic output. Used for:
     *   • `bw_test_` API keys (test mode)
     *   • The Playground (ephemeral Wills, no account required)
     */
    testMode?: boolean;
}
interface MindAssembly {
    simulation: DefaultSimulation;
    cognition: Cognition;
    /** Shared outbox array — written by OutboxWriter, drained by WillManager/SSE. */
    outbox: OutboxMessage[];
}
declare function assembleMind(willId: string, config: WillConfig): MindAssembly;

interface CoherenceIssue {
    severity: 'error' | 'warning';
    kind: 'contradiction' | 'false-capability' | 'injection' | 'incoherence' | 'other';
    detail: string;
}
interface CoherenceResult {
    /** False when any error-severity issue is present (caller may block on this). */
    ok: boolean;
    /** False when the review did not run (no key / LLM error) — advisory, fail-open. */
    ran: boolean;
    issues: CoherenceIssue[];
    /** Raw model text, for debugging. */
    raw?: string;
}
interface CoherenceInput {
    identity: WillIdentity;
    profileContext?: string;
}

interface CompetenceSnapshot {
    schemaVersion: number;
    /** Learned composite schema DEFINITIONS (the innate floor is intrinsic — not carried). */
    composites: MotorSchema[];
    /** Per-schema learned skills above the carry floor, ranked by consolidation. */
    skills: LearnedSkill[];
}

interface PMAIdentity {
    /** Core identity prompt */
    prompt: string;
    values: string[];
    traits: Record<string, number>;
    /**
     * Per-trait self-knowledge — personal baseline EMA + recent-shift direction. Persisted
     * so the Will's sense of its OWN norm (graded salience B/C) carries across sessions
     * instead of rebuilding from the population prior on every cold load. Optional: absent
     * in older PMAs (and the self-model rebuilds it either way).
     */
    traitStats?: Record<string, {
        mean: number;
        shiftDir: number;
        shiftTick: number;
    }>;
    style: string;
    version: number;
    /** Social orientation: 'gregarious', 'ambivert', 'reserved' */
    socialOrientation?: string;
    /** Trust propensity (0-1) — how quickly the Will trusts new agents */
    trustPropensity?: number;
    /** Memory persistence (0-1) — influences forgetting curve rate */
    memoryPersistence?: number;
}
interface PMABelief {
    id: string;
    statement: string;
    category: string;
    confidence: number;
    supportingEpisodes: number;
    tags: string[];
    /** Up to 20 history entries — see BeliefHistoryEntry in semantic.integrator.ts */
    history: BeliefHistoryEntry[];
}
interface PMAGoal {
    id: string;
    description: string;
    priority: number;
    progress: number;
    status: string;
    tags: string[];
    /** 'metric' | 'action' | 'epistemic' — preserved so the restored goal completes via its original mechanism */
    completionType: 'metric' | 'action' | 'epistemic';
    /** Condition expression for 'metric' goals, e.g. "stress.load < 0.3" */
    completionCondition: string | undefined;
}
interface PMAEmotionalBaseline {
    /** Dominant mood label averaged over last sessions: 'positive' | 'neutral' | 'negative' */
    dominantMood: string;
    /** Mean valence across last N sessions (-1 to +1) */
    avgValence: number;
    /** Arousal activation profile: 'high-energy' | 'moderate' | 'calm' */
    arousalProfile: string;
    /** Mean spike events per session */
    avgSpikeFrequency: number;
    /** Inherited temperament from identity (0-1, unaffected by recent sessions) */
    temperamentValence: number;
    /** Emotional reactivity (0-1) — how strongly the Will responds to events */
    reactivity: number;
}
interface PMABehavioral {
    /** Top 3 action effector names by frequency across recent sessions */
    topActions: string[];
    /** Mean executive.confidence across recent sessions */
    avgConfidence: number;
    /** Goal completion rate — null if no goals observed */
    completionRate: number | null;
    /** Risk tolerance inferred from action outcomes (0=cautious, 1=risk-seeking) */
    riskTolerance?: number;
    /** Exploration rate (0-1) — how often the Will tries novel actions */
    explorationRate?: number;
    /** Impulsivity (0-1) — tendency to act without deliberation */
    impulsivity?: number;
}
/**
 * A relationship stub — enough data to re-seed the Will's model of another
 * agent on first session start, preventing a cold-social-reset.
 *
 * Combines `attachment.bond` (emotional closeness) and `reputation` (social trust)
 * into a single record per will. Both can be present, or just one.
 *
 * At load time, `PMALoader` writes these as state entities in the formats that
 * `AttachmentEvaluator._restoreFromState()` and `ReputationTracker._restoreFromState()`
 * already read on the first tick — no new engine APIs required.
 */
interface PMARelationshipStub {
    /** The other agent's ID */
    keid: string;
    /** Optional display name for readability */
    agentName?: string;
    /**
     * Compact digest of the last conversation, derived from the most recent
     * consolidated conversation.exchange episode. On load it is re-seeded as a
     * conversation.exchange working-memory item so the Will recalls it through the
     * normal memory pipeline (consolidator → vector → unified recall).
     */
    lastConversationDigest?: string;
    attachment?: {
        attachmentStrength: number;
        trustLevel: number;
        positiveRatio: number;
        interactionCount: number;
        sharedExperiences: number;
        dependency: number;
    };
    reputation?: {
        reliability: number;
        cooperativeness: number;
        socialStanding: number;
        trustworthiness: number;
        interactionCount: number;
        positiveInteractions: number;
        negativeInteractions: number;
        confidence: number;
    };
    mentalModel?: {
        modelConfidence: number;
        dominantIntention: string | null;
        estimatedEmotion: string;
    };
    dossier?: {
        kind: 'sentient' | 'thing';
        name?: string;
        familiarity: number;
        valence: number;
        reliability: number;
        encounterCount: number;
        resolutionConfidence: number;
    };
}
/**
 * PMASnapshot — the portable identity artifact.
 *
 * Top-level contract:
 *   - ~10–50 KB for a typical Will (50 beliefs × history)
 *   - Self-contained: can bootstrap a Will with no other files
 *   - Versioned: schemaVersion guards against stale artifacts
 */
interface PMASnapshot {
    /** Schema version — see PMA_SCHEMA_VERSION */
    schemaVersion: number;
    willId: string;
    willName: string;
    /** Unix ms when this snapshot was produced */
    distilledAt: number;
    /** Session ID that triggered distillation */
    sourceSessionId: string;
    identity: PMAIdentity;
    /** Top 50 beliefs ranked by confidence × log(1 + supportingEpisodes) */
    beliefs: PMABelief[];
    /** Top 10 active/in_progress goals by priority */
    goals: PMAGoal[];
    emotionalBaseline: PMAEmotionalBaseline;
    behavioral: PMABehavioral;
    /** Top 20 relationship stubs (bonds + reputation) by interaction count */
    relationships: PMARelationshipStub[];
    /** Total episodic memory count at snapshot time (metadata only — episodes not stored) */
    episodicCount: number;
    /**
     * Learned self-tuning from the metacognition closing cycle — the accommodation
     * the Will has made to itself. `configPriors` are the bounded persona-prior
     * deltas over engine config (engineConfigId → param → delta); `calibrationBias`
     * is the per-domain confidence calibration. Omitted when nothing has been
     * learned yet. Carrying these makes the *accreted* persona portable, not just
     * the seeded identity.
     */
    persona?: {
        configPriors: Record<string, Record<string, number>>;
        calibrationBias: Record<string, number>;
    };
    /**
     * The competence layer — the Will's learned skills (habit strength, value,
     * param priors) and the composite schemas it invented. This is what makes a
     * re-embodied Will *act like itself* (its habits, its proceduralized skills),
     * not just believe/feel like itself. Omitted when nothing has been learned.
     * See #agency/pma/competence.codec.
     */
    competence?: CompetenceSnapshot;
    meta: {
        beliefCount: number;
        goalCount: number;
        relationshipCount: number;
        /** How many sessions contributed to emotional / behavioral baselines */
        sessionSummaryCount: number;
    };
}

interface BeliefFidelityDetail {
    /** Total beliefs in the PMA source */
    total: number;
    /** Beliefs successfully loaded into the fresh simulation */
    recovered: number;
    /** Fraction recovered with confidence within ±10% of original */
    fidelityScore: number;
    /** Beliefs that are missing (ID not found in loaded state) */
    missing: string[];
    /** Beliefs whose confidence drifted by > 10% */
    drifted: Array<{
        id: string;
        expected: number;
        got: number;
    }>;
}
interface GoalFidelityDetail {
    total: number;
    recovered: number;
    fidelityScore: number;
    missing: string[];
}
interface IdentityFidelityDetail {
    original: Record<string, number>;
    loaded: Record<string, number>;
    cosineSimilarity: number;
    fidelityScore: number;
}
interface EmotionalBaselineFidelityDetail {
    expectedValence: number;
    loadedValence: number;
    expectedArousal: number;
    loadedArousal: number;
    valenceDelta: number;
    arousalDelta: number;
    fidelityScore: number;
}
interface ReconstructionFidelityScores {
    /** 0-1: fraction of beliefs recovered within confidence tolerance */
    beliefs: number;
    /** 0-1: fraction of active goals present after load */
    goals: number;
    /** 0-1: cosine similarity of trait vectors */
    identity: number;
    /** 0-1: proximity of initial valence + arousal to PMA baseline */
    emotionalBaseline: number;
    /** Weighted composite: beliefs(35%) + goals(20%) + identity(25%) + emotional(20%) */
    overall: number;
}
interface ReconstructionFidelityReport {
    willId: string;
    pmaVersion: number;
    evaluatedAt: number;
    scores: ReconstructionFidelityScores;
    details: {
        beliefs: BeliefFidelityDetail;
        goals: GoalFidelityDetail;
        identity: IdentityFidelityDetail;
        emotionalBaseline: EmotionalBaselineFidelityDetail;
    };
    /** True if Phase 2 (behavioral probes) was executed */
    behavioralProbesRan: boolean;
    /** Action-type distribution comparison from Phase 2 (null if not run) */
    behavioralProbeResult: BehavioralProbeResult | null;
}
interface BehavioralProbeResult {
    /** What the similarity is measured against. */
    mode: 'vs-original' | 'load-consistency';
    /** Number of standardized probes evaluated */
    probeCount: number;
    /**
     * Jaccard similarity of action-type distributions (0-1).
     * 'vs-original': reconstruction vs the original's pre-distillation baseline.
     * 'load-consistency': two independent reloads of the same PMA.
     */
    distributionSimilarity: number;
    /** Per-probe comparison (originalTopAction = the reference: baseline or reload-A) */
    probes: Array<{
        probeId: string;
        originalTopAction: string;
        loadedTopAction: string;
        match: boolean;
    }>;
}
/**
 * A standardized probe: a named initial state configuration that should
 * elicit a predictable behavioral response. Used in Phase 2 evaluation.
 */
interface PMAProbe {
    /** Unique probe identifier */
    id: string;
    /** Human-readable description */
    description: string;
    /** Metrics to set before running the probe */
    metrics: Record<string, number>;
    /** Entity types/metadata to inject */
    entities?: Array<{
        type: string;
        metadata: Record<string, unknown>;
    }>;
    /** Ticks to run before collecting responses */
    ticks: number;
}
declare class PMAEvalHarness {
    /**
     * Evaluate PMA reconstruction fidelity.
     *
     * Always runs Phase 1 (structural). Runs Phase 2 only if
     * `runBehavioralProbes: true` is passed in options — Phase 2 requires
     * LLM API access (ANTHROPIC_API_KEY or equivalent must be set).
     *
     * @param pma       The PMASnapshot to evaluate
     * @param config    WillConfig used to assemble the loaded simulation
     * @param options   Optional: probe suite and flags
     */
    evaluate(pma: PMASnapshot, config: Omit<WillConfig, 'id'>, options?: {
        runBehavioralProbes?: boolean;
        probes?: PMAProbe[];
        /**
         * The original Will's per-probe action distribution, captured (via
         * captureProbeBaseline) BEFORE distillation. When present, Phase 2
         * measures reconstruction-vs-original fidelity; otherwise it falls back
         * to a two-reload load-consistency check.
         */
        baselineDist?: Record<string, Record<string, number>>;
    }): Promise<ReconstructionFidelityReport>;
    private _evalBeliefs;
    private _evalGoals;
    private _evalIdentity;
    private _evalEmotionalBaseline;
    /**
     * Phase 2 behavioral fidelity.
     *
     * When `baselineDist` (the original Will's per-probe action distribution,
     * captured before distillation via captureProbeBaseline) is provided, this
     * measures **reconstruction-vs-original** fidelity: does a fresh PMA load act
     * like the source Will under standardized stimuli? Without a baseline it falls
     * back to **load consistency** (two independent reloads behave the same).
     *
     * NOTE: triggers executive engine cycles (LLM calls) — requires an API key.
     */
    private _runBehavioralProbes;
    /** Load the reconstruction once, then probe it (restoring to the loaded state
     *  between probes so they don't contaminate one another). */
    private _collectProbeDistribution;
    /**
     * Run the probe suite on a LIVE Will instance to capture its action-distribution
     * baseline (for vs-original behavioral fidelity). Mutates the instance — call
     * after distillation, before archiving.
     */
    captureProbeBaseline(simulation: ReturnType<typeof assembleMind>['simulation'], cognition: Cognition, probes?: PMAProbe[]): Promise<Record<string, Record<string, number>>>;
    /**
     * Probe a (simulation, cognition) pair. For each probe: reset to the pre-suite
     * state, apply the stimulus, drive the executive to a *completed* decision (so
     * the captured action is deliberate, not just the default System-1 habit), and
     * record which skills were enacted *during* the probe (delta — the loaded
     * competence already carries enactment counts that would otherwise dominate).
     */
    private _probeOnInstance;
    /**
     * Dispatch the executive and wait (real time) until its in-flight LLM call
     * settles — stepping so _collectCompleted() applies the result — then let the
     * chosen action enact through the agency pipeline. Bounded by a wall-clock cap.
     */
    private _driveExecutive;
}

/** An inbound envelope paired with the tick it was applied on (set at drain). */
interface StampedInbound {
    envelope: InboundEnvelope;
    /** Tick at which this was drained + applied. Assigned by drain(tick). */
    appliedTick: number;
}
declare class InboundQueue {
    private _pending;
    /** Buffer an inbound envelope. Called from the transport handler — never applies. */
    enqueue(env: InboundEnvelope): void;
    /** Number of envelopes waiting to be applied. */
    get size(): number;
    /**
     * Remove and return all pending envelopes, stamped with the given tick.
     * Called once per tick by the stem before simulation.step(). FIFO order is
     * preserved so application is deterministic given the recorded batch.
     */
    drain(tick: number): StampedInbound[];
    /** Discard everything without applying (teardown). */
    clear(): void;
}

type WillStatus = 'initializing' | 'active' | 'paused' | 'archived';
type StateSnapshot = ReturnType<DefaultSimulation['stateManager']['snapshot']>;
type TickListener = (snapshot: SimulationState, tick: number, outboxMessages: OutboxMessage[], effectorInvocations: effectorInvocation[]) => void;
/**
 * Callback fired for every event published on the simulation's internal
 * DefaultEventBus (via subscribeAll). This gives the API layer access
 * to fine-grained semantic events: goal.formed, belief.updated,
 * emotion.spike, etc. — as published by individual engines.
 */
type SimulationEventListener = (event: SimulationEvent, context: SimulationContext) => void | Promise<void>;
interface CognitiveHealth {
    tick: number;
    status: 'healthy' | 'drifting' | 'degraded';
    overallScore: number;
    beliefs: {
        total: number;
        avgConfidence: number;
        highRisk: number;
    };
    affect: {
        valence: number;
        frustration: number;
        irritability: number;
        stress: number;
        isElevated: boolean;
    };
    goals: {
        total: number;
        active: number;
    };
}
interface WillSummary {
    id: string;
    status: WillStatus;
    tickCount: number;
    createdAt: Date;
    lastTickAt: Date | null;
    anatomy: WillConfig['anatomy'];
    model: NonNullable<WillConfig['llm']>['model'];
}

interface WillInstance {
    simulation: DefaultSimulation;
    cognition: Cognition;
    config: WillConfig;
    status: WillStatus;
    tickCount: number;
    createdAt: Date;
    lastTickAt: Date | null;
    tickListeners: Set<TickListener>;
    simulationEventListeners: Set<SimulationEventListener>;
    /** Unsubscribe function for the DefaultEventBus subscribeAll hook. */
    _eventBusUnsub: (() => void) | null;
    /** Queued outbound messages waiting to be drained by the delivery layer (SSE/webhook). */
    outbox: OutboxMessage[];
    /** External effector invocations pending host-system execution. Drained per tick by SSE. */
    pendingEffectorInvocations: effectorInvocation[];
    /** Bidirectional channel to the host peer (socket.io etc.). null = legacy outbox/SSE path. */
    transport: ExternalTransport | null;
    /** Tick-stamped buffer for inbound envelopes; drained + applied at tick start. */
    inbound: InboundQueue;
    /** Unsubscribe for the transport's onInbound hook. */
    _transportUnsub: (() => void) | null;
    /** NDJSON session log — one file per continuous run (start/resume → pause/archive). */
    sessionLogger: SessionLogger | null;
    /** Resolver that interrupts the tick-sleep when a high-priority event (e.g. incoming message) arrives. */
    _tickWakeFn: (() => void) | null;
    /** Timestamp when the Will was last paused — used to compute offline duration for the wake percept on resume. */
    pausedAt: Date | null;
    /** Set of active LLM-chunk listeners (one per SSE connection). F3 word-level streaming. */
    chunkListeners: Set<(chunk: string) => void>;
    /**
     * Per-entity chunk listeners registered by the SSE/WS layer.
     * Keyed by entityId — only the listener(s) for the active conversation receive chunks.
     * Populated by `addSensoryChunkListener()`.
     */
    sensoryChunkListeners: Map<string, Set<(chunk: string) => void>>;
    /** Running accumulator for the behavioral fingerprint written at session end. */
    _sessionBehavior: {
        startTick: number;
        valenceMin: number;
        valenceMax: number;
        arousalMin: number;
        arousalMax: number;
        confidenceSum: number;
        confidenceCount: number;
        goalsTotal: number;
        goalsCompleted: number;
        /** Previous tick's valence — used for spike delta calculation. */
        prevValence: number;
        /** Previous tick's arousal — used for spike delta calculation. */
        prevArousal: number;
        /** Valence at session open — for arc reporting. */
        valenceStart: number;
        /** Arousal at session open — for arc reporting. */
        arousalStart: number;
        /** Valence at last tick — for arc reporting. */
        valenceEnd: number;
        /** Arousal at last tick — for arc reporting. */
        arousalEnd: number;
        /** Consecutive ticks with arousal > 0.70 (high activation). */
        highArousalStreak: number;
        /** Completed sustained high-arousal episodes this session. */
        sustainedEpisodes: number;
        /** Total spike events (valence + arousal) this session. */
        spikeCount: number;
        /** Sum of all tick valences — for dominant mood computation. */
        avgValenceSum: number;
        /** Number of valence samples. */
        avgValenceCount: number;
        /** Actions taken in ticks where executive confidence < 0.35. */
        impulsiveActionCount: number;
    } | null;
}
declare class WillStem {
    private readonly _wills;
    private readonly _replay;
    private readonly _pma;
    private readonly _outbox;
    private readonly _effector;
    private readonly _sensory;
    private readonly _transport;
    private readonly _biography;
    private readonly _health;
    /**
     * Assemble a new Will and start its autonomous tick loop.
     * Returns the Will ID (same as config.id) once the loop is running.
     */
    createWill(config: WillConfig, startPaused?: boolean): Promise<string>;
    /**
     * Register a callback fired after every tick.
     * Use this to attach logging, metrics, or API push in the caller.
     * Returns an unsubscribe function.
     */
    addTickListener(id: string, fn: TickListener): () => void;
    /**
     * Subscribe to semantic events emitted by the simulation's internal
     * DefaultEventBus (via subscribeAll). These are fine-grained events
     * published by individual engines during tick execution:
     *
     *   goal.formed         — GoalManager created a new goal
     *   goal.completed      — GoalManager marked a goal completed
     *   goal.abandoned      — GoalManager abandoned a goal
     *   belief.updated      — SemanticIntegrator integrated a new belief
     *   emotion.spike       — AffectiveBlender detected an affect spike
     *   executive.complete    — ExecutiveEngine finished a reasoning cycle
     *   percept.received    — Exteroception picked up a new external event
     *   dream.consolidated  — DreamSimulator ran consolidation
     *
     * Note: engines must explicitly call `simulation.eventBus.publish()`
     * for their events to appear here. Core lifecycle events (tick,
     * flush) always flow through.
     *
     * Returns an unsubscribe function.
     */
    addSimulationEventListener(id: string, fn: SimulationEventListener): () => void;
    /**
     * Subscribe to real-time LLM token chunks for this Will.
     * The callback fires for each text token during executive LLM generation.
     * Returns an unsubscribe function — call it when the SSE connection closes.
     */
    addChunkListener(id: string, fn: (chunk: string) => void): () => void;
    /**
     * Subscribe to real-time LLM token chunks for a specific conversation entity.
     *
     * Unlike `addChunkListener()` (Will-wide), this fires only when the AuditionEngine
     * conversation facet for `entityId` is actively streaming — isolating chunks to the
     * relevant SSE/WS client connection.
     *
     * Implementation: on first listener for any entity, wires `addChunkCallback()` on
     * `AuditionEngine` to fan out chunks by entityId. Subsequent listeners reuse the same
     * callback — no duplicate registration occurs.
     *
     * Returns an unsubscribe function — call it when the SSE/WS connection closes.
     */
    addSensoryChunkListener(id: string, entityId: string, fn: (chunk: string) => void): () => void;
    /**
     * Subscribe to plan-activity events for a specific requesting entity.
     *
     * Delegates to `PlanningEngine.addActivityListener()`.  Events are emitted
     * for plan lifecycle transitions that were triggered by a message or request
     * from `entityId` (i.e. `requestingEntityId === entityId`).
     *
     * @returns Unsubscribe function.
     */
    addActivityListener(id: string, entityId: string, fn: ActivityEventHandler): () => void;
    pauseWill(id: string): void;
    resumeWill(id: string): void;
    /**
     * Stop a Will permanently. The tick loop exits after the current tick.
     * The instance remains in the map for state inspection.
     */
    archiveWill(id: string): Promise<void>;
    /**
     * Inject a percept or external event into the Will's world.
     * The event is picked up by perceptual engines on the next tick.
     */
    injectEvent(id: string, event: {
        type: string;
        payload: Record<string, unknown>;
    }): void;
    getWillState(id: string): SimulationState;
    getWillCognition(id: string): Cognition;
    /**
     * Returns the active session log file path for this Will, or null if
     * the Will is paused/archived (no active session).
     */
    getSessionLogPath(id: string): string | null;
    /**
     * Attach a world interface to a running Will's action executor.
     * Intended for dev use only — call from runner.ts after createWill().
     * In production the Will operates without a server-side world;
     * host-owned effectors are delivered via `agency.invocation` events.
     */
    attachWorld(_id: string, _world: WorldInterface): void;
    /**
     * Returns the most recent executive reasoning output for a Will.
     * Null if the Will hasn't completed its first executive cycle yet.
     */
    getLatestExecutiveOutput(id: string): ExecutiveOutputFull | null;
    /**
     * Returns a composite health summary for a running Will.
     * Intended for developer dashboards and platform monitoring.
     *
     * Status bands:
     *   healthy  — normal operating range
     *   drifting — one or more indicators approaching problematic thresholds
     *   degraded — one or more indicators clearly outside healthy range
     */
    getCognitiveHealth(id: string): CognitiveHealth;
    /**
     * Load a PMASnapshot into a paused or freshly-created Will.
     *
     * Seeds beliefs, goals, identity, and emotional baseline from the PMA.
     * Should only be called when no prior snapshot has been restored —
     * calling on an active Will with existing beliefs may cause unintended merges.
     *
     * The Will must be paused (status: 'paused' or 'initializing') before calling.
     * Resume the Will after loading to start ticking with the seeded state.
     */
    loadPMA(id: string, pma: PMASnapshot): void;
    startReplay(id: string): string;
    stopReplay(id: string): Promise<ReplayMetadata>;
    getReplayMeta(id: string, runId: string): ReplayMetadata | null;
    listReplays(id: string): ReplayMetadata[];
    compareReplays(id: string, runId1: string, runId2: string): Promise<ReplayComparison>;
    loadScenario(id: string, cfg: ScenarioConfig): Promise<ScenarioValidationResult>;
    runPMAEval(id: string, opts?: {
        behavioral?: boolean;
        vsOriginal?: boolean;
    }): Promise<ReconstructionFidelityReport>;
    distillPMA(id: string): PMASnapshot;
    /**
     * Optional semantic coherence check for an operator-supplied persona (identity
     * guardrail Phase 2). One LLM review flagging contradictions with the
     * architecture grounding, false-capability claims, and semantic injection the
     * deterministic guard can't catch. Advisory + fail-open (an LLM error returns
     * `ran: false`, never blocks). Intended for the API to call pre-creation.
     */
    reviewIdentityCoherence(input: CoherenceInput, opts?: {
        willId?: string;
    }): Promise<CoherenceResult>;
    /**
     * Reset affect metrics to a neutral baseline without touching memory.
     * Intended as a recovery path when a Will is clearly drifting or degraded.
     * Does NOT wipe beliefs, goals, episodes, or the executive's reasoning context.
     */
    recalibrateWill(id: string): void;
    /**
     * Returns true if the Will is in the registry (regardless of status).
     */
    isRunning(id: string): boolean;
    /**
     * Update the set of allowed communication effectors at runtime.
     * Routes to `AccessGrants.setAllowed()` (the permission / sense gate).
     */
    /** Update the set of allowed communication effectors at runtime. */
    setAllowedEffectors(id: string, effectors: string[] | null): void;
    /**
     * Register a host effector on a *running* Will (post-create `.effector()`).
     * Builds its external schema and adds it to the live repertoire so the Will
     * can actually perceive + enact it — a grant alone only gates; without the
     * schema the ability could never be afforded. Comms names are no-ops here
     * (governed by AccessGrants). This is a runtime mutation, like a grant change;
     * the deterministic/replayable path is declaring effectors at create time.
     */
    registerEffector(id: string, declaration: EffectorDeclaration): void;
    /**
     * Called by the host/WorldInterface after executing a host-owned effector.
     * `invocationId` is the correlation handle the host echoed (the awaiting
     * `agency.intent` id). Reconciles it into an `agency.outcome` the ReafferenceEngine
     * consumes — learning the result, freeing the intent, and advancing the plan it
     * served (if any). See effectorController.confirmExecution.
     */
    confirmEffectorExecution(id: string, invocationId: string, result: {
        success: boolean;
        description: string;
        metrics?: Record<string, number>;
    }): void;
    /**
     * Resolve a policy escalation the Will raised (POLICY_REAFFERENCE P4).
     * `approved` dispatches the held invocation to the world; otherwise it is
     * refused. Applied at the next tick boundary. `invocationId` is the awaiting
     * `agency.intent` id the escalation ask referenced.
     */
    resolveEscalation(id: string, invocationId: string, approved: boolean): void;
    /**
     * Confirm a message was received by the target entity. Writes a
     * message.delivery percept ("ear hears the word you spoke") and updates the
     * conversation.sent entity that tracks the outbox message.
     */
    confirmMessageDelivery(id: string, messageId: string, delivered: boolean): void;
    /**
     * Drain all queued outbound messages from the Will's outbox.
     * Called by the SSE/webhook delivery layer to retrieve messages.
     */
    drainOutbox(id: string): OutboxMessage[];
    /** Peek at outbox without draining it. */
    peekOutbox(id: string): readonly OutboxMessage[];
    /** Re-queue messages that were drained but not successfully delivered. */
    requeueToOutbox(id: string, messages: OutboxMessage[]): void;
    /**
     * Drain all pending external effector invocations.
     * Called by the SSE delivery layer each tick after drainOutbox.
     */
    drainEffectorInvocations(id: string): effectorInvocation[];
    /**
     * Route an external text message through Will's AuditionEngine.
     *
     * Senses-aware AuditionEngine handles:
     *   - Salience computation (urgency keywords + message length)
     *   - Thread digest accumulation (rolling last-5-turn context)
     *   - LanguagePercept publication on the CognitiveBus (`senses.audition.percept`)
     *   - AttentionAllocator entity salience tracking
     *   - Conversation facet spawn / reuse per entityId
     *   - LLM reply generation via the conversation facet
     *
     * Reply delivery is handled asynchronously via the outbox / SSE channel.
     * And real-time chunk streaming wiring.
     *
     * @param id     Will ID
     * @param input  TextMessage — `{ kind: 'text', entityId, threadId, content, speakerName? }`
     */
    ingestText(id: string, input: TextMessage): Promise<void>;
    /**
     * Terminate the conversation session for an entity.
     *
     * Destroys the AuditionEngine conversation facet for `entityId`, freeing
     * its slot in the executive facet pool. The thread digest is intentionally
     * preserved — it remains available for history retrieval after session end.
     *
     * Call this when the SSE/WS client disconnects or the session expires.
     *
     * @param id       Will ID
     * @param entityId The entity whose conversation session to close
     */
    endConversation(id: string, entityId: string): void;
    /**
     * Return the list of active conversation entityIds for a Will.
     * Each entry is an entityId that currently has a live AuditionEngine facet.
     */
    activeConversationSessions(id: string): string[];
    /**
     * Return registration status for all five sense engines.
     * Shell engines report status: 'shell'; active engines report 'active'.
     */
    getSenseEngineStatus(id: string): Array<{
        domain: string;
        status: string;
    }>;
    /**
     * Route a raw SensoryInput to the appropriate sense engine by domain.
     * Used by the debug `POST /senses/:domain/ingest` route.
     * Audition inputs are gated by the 'listen' effector like ingestText().
     */
    ingestSensory(id: string, domain: string, input: SensoryInput): Promise<void>;
    listWills(): WillSummary[];
    private _runTickLoop;
    private _get;
}

/**
 * A stimulus entering the Will's sensory field. A Will is a subject, not a
 * function: you don't *call* it with input and await a return — you `perceive`
 * something to it, and it *may* project a response later (see `nextUtterance`),
 * coloured by its current state. Silence is a valid, meaningful outcome.
 */
interface Stimulus {
    /** What was said / observed. */
    text: string;
    /** Who it's from (entity id). Default 'user'. */
    from?: string;
    /**
     * The speaker's real name, when known. A name here is *learned* by the Will as
     * this entity's name (see known.entity.tracker) — so it is left unset by
     * default rather than filled with a chat-frame placeholder: absent a real
     * name, the Will knows the person as "someone" until it learns one.
     */
    speaker?: string;
    /** Conversation/thread id (default = `from`). */
    thread?: string;
}
/** A message the Will emitted to someone. */
interface WillMessage {
    /** Message id (stable — dedupe on it). */
    id: string;
    /** The text the Will said. */
    content: string;
    /** Entity id the Will addressed (the speaker you used in say()/tell(), or a bond). */
    to: string;
}
/**
 * A motor act the Will *chose* to enact — a projection of its agency, surfaced
 * whether or not you registered a handler for it. (When you did, the handler
 * still runs and its outcome feeds reafference.)
 */
interface WillEffectorAct {
    /** The effector the Will selected. */
    name: string;
    /** The arguments it bound. */
    args: Record<string, unknown>;
    /** Its stated reason for the act. */
    reasoning: string;
    /** Bound target entity, when the act binds one. */
    to?: string;
}
/** The Will's affect, projected when it shifts. Valence/arousal ∈ −1..1. */
interface WillAffect {
    valence: number;
    arousal: number;
}
/**
 * The result of an effector your handler ran. Return a bare string as shorthand
 * for `{ success: true, description }`. `metrics` optionally writes world state
 * back into the Will's body (e.g. `{ 'energy.level': 80 }`) — validated finite.
 */
type EffectorResult = string | {
    success: boolean;
    description: string;
    metrics?: Record<string, number>;
};
/** Your implementation of an ability the Will can choose to use. */
type EffectorHandler = (args: Record<string, unknown>, ctx: {
    reasoning: string;
    targetEntityId?: string;
    description?: string;
}) => EffectorResult | Promise<EffectorResult>;
/**
 * A richer effector declaration — the ability seeded as a *learnable affordance*.
 * `description` is its meaning (carried to perception + your handler); `cost`,
 * `valence`, and `preconditions` are the intrinsic priors the mind starts from,
 * refined by reafference through use. Args still bind from the situation — this
 * is not a tool-call parameter form. Declare rich effectors in `create()`'s
 * `effectors` map (that is where they enter the affordance repertoire).
 */
interface EffectorSpec {
    /** What the ability is for. */
    description?: string;
    /** Intrinsic effort / energy demand 0..1 (default 0.15). */
    cost?: number;
    /** Intrinsic reward prior −1..1 the mind expects before learning (default 0). */
    valence?: number;
    /** Body-state gates; the ability is unavailable unless all pass. */
    preconditions?: SchemaPrecondition[];
    /**
     * Whether the ability targets a specific perceived target (default 'none').
     * 'entity' directs it at a known person, 'object' at a known thing; the bound
     * target arrives as `ctx.targetEntityId`.
     */
    binds?: 'none' | 'entity' | 'object';
    /**
     * Routing tags (merged with 'external'/'host'). A drive-recognised tag (e.g.
     * 'social', 'nourishment') lets a homeostatic drive lift this ability when it
     * presses.
     */
    tags?: string[];
    /** Your implementation. */
    handler: EffectorHandler;
}
/** An effectors-map value: a bare handler, or a spec carrying meaning + priors. */
type EffectorEntry = EffectorHandler | EffectorSpec;
/** A compact read of the mind's current inner state. */
interface WillStateSummary {
    tick: number;
    /** Physiology + affect, 0..1 unless noted. */
    metrics: {
        energy: number;
        stress: number;
        sleep: number;
        valence: number;
        arousal: number;
    };
    goals: Array<{
        description: string;
        priority: number;
    }>;
    beliefs: Array<{
        statement: string;
        confidence: number;
    }>;
    /** The Will's current self-narrative (may be empty early in a life). */
    narrative: string;
}
interface CreateWillOptions {
    /** Display name. */
    name: string;
    /** Persona: who this Will is. All fields optional except by your intent. */
    identity: Partial<WillIdentity> & {
        prompt: string;
    };
    /** 'mind' (default: the whole architecture) | 'reflex' (no-LLM shell). */
    anatomy?: Anatomy;
    /** Concrete LLM model id, or a per-role map ({ executive, summarizer?,
     *  deliberation?, embedding? } — unset thinking roles fall back to executive).
     *  Unset → env / provider default.
     *  @deprecated Pass `llmConfig: { model }` instead — model and transport are
     *  one concern. Still honoured; an explicit `llmConfig.model` wins. */
    model?: string | WillModelConfig;
    /** Per-Will LLM config: provider, model(s), BYO apiKey, baseUrl, caps.
     *  Unset fields fall back to WILL_LLM_* envs. apiKey stays in memory only.
     *  (Named llmConfig because `llm` is the provider MODE switch.) */
    llmConfig?: WillLLMConfig;
    /**
    * LLM mode — which provider the executive speaks to.
    *
    * 'mock' (the default when no key is present) runs a deterministic canned
    * executive: zero keys, zero cost. Every other value names a provider and
    * needs its key, either the provider's own env below or the
    * provider-agnostic WILL_LLM_API_KEY:
    *
    *   anthropic  ANTHROPIC_API_KEY   Claude, native Messages wire
    *   glm        ZAI_API_KEY         Z.ai GLM, Anthropic-compatible wire
    *   openai     OPENAI_API_KEY      OpenAI wire
    *   google     GOOGLE_API_KEY | GEMINI_API_KEY   native Gemini wire
    *   deepseek   DEEPSEEK_API_KEY    OpenAI wire
    *   moonshot   MOONSHOT_API_KEY    Kimi — OpenAI wire
    *   qwen       DASHSCOPE_API_KEY   Alibaba Model Studio — OpenAI wire
    *   xai        XAI_API_KEY         Grok — OpenAI wire
    *   minimax    MINIMAX_API_KEY     OpenAI wire
    *   mistral    MISTRAL_API_KEY     OpenAI wire
    *   ollama · vllm                  local; no key, set `llm` explicitly
    *
    * Any other string works too — it just has to declare its `wire` and
    * `baseUrl` on `llmConfig.providers`. Naming the vendor rather than
    * borrowing `openai` because it speaks that wire is what keeps the
    * completion tape and the cost breakdown honest.
    *
    * Omit to auto-detect from whichever key is set.
    */
    llm?: 'mock' | LLMProvider;
    /**
     * Abilities the Will can choose to enact. `name → handler`, or
     * `name → { handler, description?, cost?, valence?, preconditions? }` to seed
     * the ability with meaning + intrinsic priors (see EffectorSpec). Declared
     * here (create time) so they enter the affordance repertoire.
     */
    effectors?: Record<string, EffectorEntry>;
    /** Goals seeded before the first tick. Usually leave empty — the Will forms its own. */
    initialGoals?: InitialGoal[];
    /** Persist snapshots to disk across restarts (default false). */
    persist?: boolean;
    /** Deterministic clock + seed (for replay/testing). Omit for wall-time. */
    seed?: number;
    /** Milliseconds between ticks (default 1000; lower = faster demo). */
    tickMs?: number;
    /** Stable id (default: derived from name + a random suffix). */
    id?: string;
}
declare class Will {
    /** The underlying WillStem — drop here for the full contract. */
    readonly stem: WillStem;
    /** This Will's id. */
    readonly id: string;
    readonly name: string;
    private readonly _effectors;
    /** Rich declarations for create-time effectors → seed the affordance repertoire. */
    private readonly _effectorDecls;
    private readonly _messageHandlers;
    private readonly _stateHandlers;
    private readonly _effectorHandlers;
    private readonly _emotionHandlers;
    private readonly _errorHandlers;
    private readonly _utteranceWaiters;
    private _lastAffect;
    private _unsub;
    private constructor();
    /** Boot a new mind. Resolves once it is ticking. */
    static create(opts: CreateWillOptions): Promise<Will>;
    /**
     * Restore a mind from a PMA artifact — identity, beliefs, relationships, and
     * learned competence carry across the process boundary. Same options as
     * create() (minus identity, which the artifact supplies).
     */
    static wake(pma: PMASnapshot, opts: Omit<CreateWillOptions, 'identity'> & {
        identity?: Partial<WillIdentity>;
    }): Promise<Will>;
    /**
     * Deliver a stimulus into the Will's sensory field. This is the one true
     * intake — `say`/`tell` are sugar over it. It returns once the stimulus is
     * *delivered*, NOT once the Will has responded: a response (if any) is a
     * projection that arrives later on the `message` event, or via
     * `nextUtterance()`. The Will may also stay silent — that is not an error.
     */
    perceive(stimulus: Stimulus): Promise<void>;
    /** Perceive from the default user. Sugar over `perceive`. */
    say(text: string): Promise<void>;
    /** Perceive from a specific interlocutor (multi-party). Sugar over `perceive`. */
    tell(entityId: string, speakerName: string, text: string): Promise<void>;
    /**
     * Await the Will's *next spontaneous utterance* — a thin, honest adapter over
     * the `message` projection stream for request/response callers. Resolves with
     * the message, or `null` if the Will stays silent within `within` ms (default
     * 5000). `null` is a real outcome — the Will chose not to speak — not a
     * failure. Pass `to` to only accept an utterance addressed to that entity.
     *
     *   await will.perceive( { from: 'ada', text: 'Hi!' } )
     *   const reply = await will.nextUtterance( { to: 'ada', within: 3000 } )
     *   // reply is a WillMessage, or null if Ada got the silent treatment.
     */
    nextUtterance(opts?: {
        within?: number;
        to?: string;
    }): Promise<WillMessage | null>;
    /**
     * Register an ability the Will can choose to enact, at runtime. `entry` is a
     * bare handler or a full spec (`{ handler, description?, cost?, valence?,
     * preconditions?, binds?, tags? }`). When the Will decides to use `name`, your
     * handler runs with the arguments it chose; the return value feeds back as the
     * outcome (the reafference loop that lets the Will learn the ability).
     *
     * The ability's schema is added to the live repertoire so it can actually be
     * *afforded* immediately (a grant alone only gates), then granted. Note: this
     * is a runtime mutation — the deterministic/replayable path is declaring
     * effectors in `create()`'s `effectors` map.
     */
    effector(name: string, entry: EffectorEntry): this;
    /** Split an effectors-map entry into a handler + an EffectorDeclaration. */
    private _register;
    /** A compact snapshot of the mind's current inner state. */
    state(): WillStateSummary;
    on(event: 'message', handler: (m: WillMessage) => void): this;
    on(event: 'state', handler: (s: WillStateSummary) => void): this;
    on(event: 'effector', handler: (a: WillEffectorAct) => void): this;
    on(event: 'emotion', handler: (a: WillAffect) => void): this;
    on(event: 'error', handler: (e: Error) => void): this;
    pause(): void;
    resume(): void;
    /**
     * Checkpoint the living mind into a portable PMA artifact — NON-destructive.
     * The Will keeps ticking; the snapshot is a point-in-time copy you can archive
     * or wake elsewhere. Use this for periodic saves; use `hibernate()` to sleep.
     */
    save(): Promise<PMASnapshot>;
    /**
     * Distil the mind into a portable PMA artifact and archive it — DESTRUCTIVE:
     * the tick loop stops (the Will sleeps). The returned snapshot restores the
     * same self via `Will.wake()` — across a restart, a fork, or a machine
     * boundary. For a copy that leaves the Will running, use `save()`.
     */
    hibernate(): Promise<PMASnapshot>;
    /** Tear the Will down (its tick loop stops; state is discarded unless persisted). */
    stop(): Promise<void>;
    private _buildConfig;
    /** Wire the single tick listener that drives messages + the effector ack loop. */
    private _attach;
    private _runEffector;
    private _emitMessage;
    private _emitEffectorAct;
    private _maybeEmitAffect;
    private _emitError;
}

export { type DeltaSnapshot as $, type AckEnvelope as A, BACKGROUND_DEMAND as B, type ChunkEnvelope as C, CircadianOscillator as D, type ClockConfig as E, type Cognition as F, type CognitiveHealth as G, ConfidenceCalibrator as H, type ConfidenceCalibratorConfig as I, type ConflictReport as J, type ConflictResolution as K, type ConflictStrategy as L, type Coordinates as M, type CreateWillOptions as N, DefaultEventBus as O, DefaultMetricCollector as P, DefaultOrchestrator as Q, DefaultReplayRecorder as R, DefaultReplaySession as S, DefaultScenario as T, DefaultSerializer as U, DefaultSimulation as V, DefaultSimulationClock as W, DefaultStateManager as X, DefaultVectorMemoryAdapter as Y, DeliberationEngine as Z, DeltaEncoder as _, type AckResult as a, type ModelRouter as a$, DreamSimulator as a0, type DreamSimulatorConfig as a1, type Duration as a2, ESCALATION_DEMAND as a3, type EffectorDeclaration as a4, type EffectorEntry as a5, type EffectorHandler as a6, type EffectorResult as a7, type EffectorSpec as a8, type EmbeddingProvider as a9, type InboundEnvelope as aA, type InboundMessageEnvelope as aB, type InboundPerceptEnvelope as aC, InhibitionController as aD, type InhibitionControllerConfig as aE, Interoception as aF, type InteroceptionConfig as aG, IntrospectionEngine as aH, type IntrospectionEngineConfig as aI, KNOWN_PROVIDERS as aJ, KnownEntityTracker as aK, type KnownEntityTrackerConfig as aL, type KnownProvider as aM, type LLMCallMeta as aN, type LLMCompletionRecord as aO, type LLMCompletionSink as aP, type LLMProvider as aQ, type LLMWire as aR, LossEvaluator as aS, type LossEvaluatorConfig as aT, type MessageEnvelope as aU, type MetricCollector as aV, type MetricPoint as aW, type MinimalContext as aX, MockEmbedder as aY, type ModelPrice as aZ, type ModelRoute as a_, EmpathySimulator as aa, type EmpathySimulatorConfig as ab, EnergyRegulator as ac, type EnergyRegulatorConfig as ad, type EngineRegistry as ae, type EngineResult as af, type Envelope as ag, EpisodicConsolidator as ah, type EpisodicConsolidatorConfig as ai, type EventBus as aj, type EventBusConfig as ak, type EventFilter as al, type EventHandler as am, type EventPayload as an, ExecutiveEngine as ao, type ExecutiveEngineConfig$1 as ap, type ExternalTransport as aq, Exteroception as ar, type ExteroceptionConfig as as, ForgettingCurve as at, type ForgettingCurveConfig as au, FrustrationEvaluator as av, type FrustrationEvaluatorConfig as aw, GoalManager as ax, type GoalManagerConfig as ay, GustationEngine as az, type ActionRequest as b, type SessionLogEnvelope as b$, MoralEvaluator as b0, type MoralEvaluatorConfig as b1, MotorSchemaExecutor as b2, NULL_ROUTER as b3, NoveltyDetector as b4, type NoveltyDetectorConfig as b5, OlfactionEngine as b6, OpenAICompatibleEmbedder as b7, type Orchestrator as b8, type OrchestratorConfig as b9, ReplayManager as bA, type ReplayMetadata as bB, type ReplayRecord as bC, type ReplayRecorder as bD, type ReplaySession as bE, type ReplyEnvelope as bF, ReputationTracker as bG, type ReputationTrackerConfig as bH, type RestoreOptions as bI, RewardEvaluator as bJ, type RewardEvaluatorConfig as bK, type RoutingRule as bL, type Scenario as bM, type ScenarioConfig as bN, type ScenarioValidationResult as bO, type SchemaPrecondition as bP, type SeededPRNG as bQ, SelfModelUpdater as bR, type SelfModelUpdaterConfig as bS, SemanticIntegrator as bT, type SemanticIntegratorConfig as bU, type SensoryInput as bV, type SerializationConfig as bW, type SerializationFormat as bX, type SerializedEntity as bY, type SerializedState as bZ, type Serializer as b_, type OutboundEnvelope as ba, type OutboxMessage as bb, type PMABehavioral as bc, type PMABelief as bd, type PMAEmotionalBaseline as be, PMAEvalHarness as bf, type PMAGoal as bg, type PMAIdentity as bh, type PMAProbe as bi, type PMASnapshot as bj, type PerceptEnvelope as bk, PersonaConsolidator as bl, type PersonaConsolidatorConfig as bm, PlanningEngine as bn, type PlanningEngineConfig as bo, type PriceTable as bp, type ProviderCredential as bq, type ReadonlySimulationState as br, ReafferenceEngine as bs, type ReasoningFootprint as bt, type ReconstructionFidelityReport as bu, type ReconstructionFidelityScores as bv, type RecordUsageInput as bw, type ReplayComparison as bx, type ReplayConfig as by, type ReplayDifference as bz, type ActionResult as c, assembleMind as c$, type Simulation as c0, type SimulationClock as c1, type SimulationConfig as c2, type SimulationContext as c3, type SimulationEngine as c4, type SimulationEntity as c5, type SimulationEvent as c6, type SimulationEventBase as c7, type SimulationEventListener as c8, type SimulationState as c9, type TokenReportEnvelope as cA, TokenTracker as cB, type TokenTrackerConfig as cC, type TokenUsage as cD, type TransportStatus as cE, type VectorIndex as cF, type VectorMemoryAdapter as cG, type VectorMemoryConfig as cH, type VectorQueryFilter as cI, type VectorQueryResult as cJ, type VectorRecord as cK, VisionEngine as cL, type VoiceChunk as cM, Will as cN, type WillAffect as cO, type WillConfig as cP, type WillEffectorAct as cQ, type WillInstance as cR, type WillMessage as cS, type WillStateSummary as cT, type WillStatus as cU, WillStem as cV, type WillSummary as cW, WorkingMemory as cX, type WorkingMemoryConfig as cY, type WorldEntity as cZ, type WorldInterface as c_, type SleepPressureConfig as ca, SleepPressureRegulator as cb, SocialPerception as cc, type SocialPerceptionConfig as cd, SomatosensationEngine as ce, SpacedRepetition as cf, type SpacedRepetitionConfig as cg, type StateCommands as ch, type StateManager as ci, type StateSnapshot as cj, type Stimulus as ck, type StorageAdapter as cl, StressRegulator as cm, type StressRegulatorConfig as cn, TableRouter as co, TaskSwitcher as cp, type TaskSwitcherConfig as cq, type TextMessage as cr, TheoryOfMind as cs, type TheoryOfMindConfig as ct, ThreatEvaluator as cu, type ThreatEvaluatorConfig as cv, type Tick as cw, type TickListener as cx, type Timestamp as cy, type TokenLedgerRecord as cz, ActionSelector as d, chainRouters as d0, clearCompletionRecorder as d1, defaultBaseFor as d2, type effectorInvocation as d3, type effectorInvocationEnvelope as d4, getCompletionRecorder as d5, isNullRouter as d6, knownWireFor as d7, resolvePricing as d8, setCompletionRecorder as d9, type ActivityEnvelope as e, type ActivityEvent as f, type ActivityEventHandler as g, AestheticEvaluator as h, type AestheticEvaluatorConfig as i, AffectiveBlender as j, type AffectiveBlenderConfig as k, AffordanceSynthesizer as l, AsyncEngine as m, type AsyncEngineConfig as n, AttachmentEvaluator as o, type AttachmentEvaluatorConfig as p, AttentionAllocator as q, type AttentionAllocatorConfig as r, AuditionEngine as s, AutobiographicalNarrator as t, type AutobiographicalNarratorConfig as u, type BehavioralProbeResult as v, BiasDetector as w, type BiasDetectorConfig as x, BunStorageAdapter as y, type CircadianConfig as z };

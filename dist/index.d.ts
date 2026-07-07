import { bR as SimulationContext, bC as SeededPRNG, bT as SimulationEntity, cj as Timestamp, bU as SimulationEvent, c4 as StateManager, ch as Tick, bX as SimulationState, bv as RestoreOptions, c3 as StateCommands, bg as ReasoningFootprint, be as ReadonlySimulationState, I as ConflictReport, K as ConflictStrategy, J as ConflictResolution, a$ as OutboundEnvelope, a as AckResult, ao as ExternalTransport, ay as InboundEnvelope, cp as TransportStatus } from './will-HlaDxbqL.js';
export { A as AckEnvelope, b as ActionRequest, c as ActionResult, d as ActionSelector, e as ActivityEnvelope, f as ActivityEvent, g as ActivityEventHandler, h as AestheticEvaluator, i as AestheticEvaluatorConfig, j as AffectiveBlender, k as AffectiveBlenderConfig, l as AffordanceSynthesizer, m as AsyncEngine, n as AsyncEngineConfig, o as AttachmentEvaluator, p as AttachmentEvaluatorConfig, q as AttentionAllocator, r as AttentionAllocatorConfig, s as AuditionEngine, t as AutobiographicalNarrator, u as AutobiographicalNarratorConfig, B as BehavioralProbeResult, v as BiasDetector, w as BiasDetectorConfig, x as BunStorageAdapter, C as ChunkEnvelope, y as CircadianConfig, z as CircadianOscillator, D as ClockConfig, E as Cognition, F as CognitiveHealth, G as ConfidenceCalibrator, H as ConfidenceCalibratorConfig, L as Coordinates, M as CreateWillOptions, N as DefaultEventBus, O as DefaultMetricCollector, P as DefaultOrchestrator, Q as DefaultReplayRecorder, R as DefaultReplaySession, S as DefaultScenario, T as DefaultSerializer, U as DefaultSimulation, V as DefaultSimulationClock, W as DefaultStateManager, X as DefaultVectorMemoryAdapter, Y as DeliberationEngine, Z as DeltaEncoder, _ as DeltaSnapshot, $ as DreamSimulator, a0 as DreamSimulatorConfig, a1 as Duration, a2 as EffectorDeclaration, a3 as EffectorEntry, a4 as EffectorHandler, a5 as EffectorResult, a6 as EffectorSpec, a7 as EmbeddingProvider, a8 as EmpathySimulator, a9 as EmpathySimulatorConfig, aa as EnergyRegulator, ab as EnergyRegulatorConfig, ac as EngineRegistry, ad as EngineResult, ae as Envelope, af as EpisodicConsolidator, ag as EpisodicConsolidatorConfig, ah as EventBus, ai as EventBusConfig, aj as EventFilter, ak as EventHandler, al as EventPayload, am as ExecutiveEngine, an as ExecutiveEngineConfig, ap as Exteroception, aq as ExteroceptionConfig, ar as ForgettingCurve, as as ForgettingCurveConfig, at as FrustrationEvaluator, au as FrustrationEvaluatorConfig, av as GoalManager, aw as GoalManagerConfig, ax as GustationEngine, az as InboundMessageEnvelope, aA as InboundPerceptEnvelope, aB as InhibitionController, aC as InhibitionControllerConfig, aD as Interoception, aE as InteroceptionConfig, aF as IntrospectionEngine, aG as IntrospectionEngineConfig, aH as KnownEntityTracker, aI as KnownEntityTrackerConfig, aJ as LLMCompletionRecord, aK as LLMCompletionSink, aL as LossEvaluator, aM as LossEvaluatorConfig, aN as MessageEnvelope, aO as MetricCollector, aP as MetricPoint, aQ as MinimalContext, aR as MockEmbedder, aS as MoralEvaluator, aT as MoralEvaluatorConfig, aU as MotorSchemaExecutor, aV as NoveltyDetector, aW as NoveltyDetectorConfig, aX as OlfactionEngine, aY as OpenAICompatibleEmbedder, aZ as Orchestrator, a_ as OrchestratorConfig, b0 as OutboxMessage, b1 as PMABehavioral, b2 as PMABelief, b3 as PMAEmotionalBaseline, b4 as PMAEvalHarness, b5 as PMAGoal, b6 as PMAIdentity, b7 as PMAProbe, b8 as PMASnapshot, b9 as PerceptEnvelope, ba as PersonaConsolidator, bb as PersonaConsolidatorConfig, bc as PlanningEngine, bd as PlanningEngineConfig, bf as ReafferenceEngine, bh as ReconstructionFidelityReport, bi as ReconstructionFidelityScores, bj as RecordUsageInput, bk as ReplayComparison, bl as ReplayConfig, bm as ReplayDifference, bn as ReplayManager, bo as ReplayMetadata, bp as ReplayRecord, bq as ReplayRecorder, br as ReplaySession, bs as ReplyEnvelope, bt as ReputationTracker, bu as ReputationTrackerConfig, bw as RewardEvaluator, bx as RewardEvaluatorConfig, by as Scenario, bz as ScenarioConfig, bA as ScenarioValidationResult, bB as SchemaPrecondition, bD as SelfModelUpdater, bE as SelfModelUpdaterConfig, bF as SemanticIntegrator, bG as SemanticIntegratorConfig, bH as SensoryInput, bI as SerializationConfig, bJ as SerializationFormat, bK as SerializedEntity, bL as SerializedState, bM as Serializer, bN as SessionLogEnvelope, bO as Simulation, bP as SimulationClock, bQ as SimulationConfig, bS as SimulationEngine, bV as SimulationEventBase, bW as SimulationEventListener, bY as SleepPressureConfig, bZ as SleepPressureRegulator, b_ as SocialPerception, b$ as SocialPerceptionConfig, c0 as SomatosensationEngine, c1 as SpacedRepetition, c2 as SpacedRepetitionConfig, c5 as StateSnapshot, c6 as Stimulus, c7 as StorageAdapter, c8 as StressRegulator, c9 as StressRegulatorConfig, ca as TaskSwitcher, cb as TaskSwitcherConfig, cc as TextMessage, cd as TheoryOfMind, ce as TheoryOfMindConfig, cf as ThreatEvaluator, cg as ThreatEvaluatorConfig, ci as TickListener, ck as TokenLedgerRecord, cl as TokenReportEnvelope, cm as TokenTracker, cn as TokenTrackerConfig, co as TokenUsage, cq as VectorIndex, cr as VectorMemoryAdapter, cs as VectorMemoryConfig, ct as VectorQueryFilter, cu as VectorQueryResult, cv as VectorRecord, cw as VisionEngine, cx as VoiceChunk, cy as Will, cz as WillAffect, cA as WillConfig, cB as WillEffectorAct, cC as WillInstance, cD as WillMessage, cE as WillStateSummary, cF as WillStatus, cG as WillStem, cH as WillSummary, cI as WorkingMemory, cJ as WorkingMemoryConfig, cK as WorldEntity, cL as WorldInterface, cM as assembleMind, cN as clearCompletionRecorder, cO as effectorInvocation, cP as effectorInvocationEnvelope, cQ as getCompletionRecorder, cR as resolvePricing, cS as setCompletionRecorder } from './will-HlaDxbqL.js';

/**
 * Creates a Mulberry32 PRNG from the given seed.
 * Mulberry32 is a fast, high-quality 32-bit generator
 * with a full 2^32 period.
 */
declare function createPRNG(seed: number): SeededPRNG;
/**
 * Creates a minimal SimulationContext with required prng.
 * Use for standalone operations (tests, step calls) where a full
 * simulation is not running.
 */
declare function createContext(simulationId: string, runId: string, seed?: number): SimulationContext;

/**
 * Distributed simulation support for multi-node execution.
 * Supports partitioning by entity type, geographic region, or custom sharding.
 */

type ShardStrategy = 'by-entity-type' | 'by-entity-id-hash' | 'by-region' | 'custom';
type ConsistencyLevel = 'strong' | 'eventual' | 'causal';
type DeliveryGuarantee = 'at-most-once' | 'at-least-once' | 'exactly-once';
interface ShardConfig {
    index: number;
    total: number;
    strategy: ShardStrategy;
    entityTypes?: string[];
    regionBounds?: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    };
}
interface DistributedNodeConfig {
    nodeId: string;
    shard: ShardConfig;
    coordinatorUrl?: string;
    heartbeatIntervalMs?: number;
    syncIntervalMs?: number;
    consistencyLevel?: ConsistencyLevel;
}
interface DistributedEvent<T = unknown> extends SimulationEvent<T, {
    originatingNode: string;
    shardIndex: number;
    isCrossShard: boolean;
    targetShard?: number;
}> {
}
interface CrossShardQuery {
    type: 'get-entity' | 'get-entities-by-type' | 'get-metric';
    entityId?: string;
    entityType?: string;
    metricKey?: string;
    shardTarget?: number;
}
interface CrossShardResult {
    success: boolean;
    data: unknown;
    fromNode: string;
    timestamp: Timestamp;
}
interface PartitionRouter {
    getShardForEntity(entity: SimulationEntity, totalShards: number): number;
    getShardForMetric(metricKey: string, totalShards: number): number;
    isLocalEntity(entityId: string, shardConfig: ShardConfig): boolean;
}
declare class ConsistentHashRouter implements PartitionRouter {
    private _virtualNodes;
    constructor(virtualNodes?: number);
    getShardForEntity(entity: SimulationEntity, totalShards: number): number;
    getShardForMetric(metricKey: string, totalShards: number): number;
    isLocalEntity(entityId: string, shardConfig: ShardConfig): boolean;
    private _hashToShard;
    /**
     * Use FNV-1a hash for better distribution.
     * Replaces the weak djb2 variant.
     */
    private _hash;
}
declare class DefaultPartitionRouter implements PartitionRouter {
    private _strategy;
    private _regionSize;
    constructor(strategy?: ShardStrategy, regionSize?: number);
    getShardForEntity(entity: SimulationEntity, totalShards: number): number;
    getShardForMetric(metricKey: string, totalShards: number): number;
    isLocalEntity(entityId: string, shardConfig: ShardConfig): boolean;
    private _hash;
}
/**
 * Transport interface with timeout, retry, circuit breaker
 * semantics, and delivery guarantees.
 */
interface CrossShardTransport {
    send(targetNode: string, event: DistributedEvent, context: SimulationContext): Promise<void>;
    broadcast(event: DistributedEvent, context: SimulationContext): Promise<void>;
    query(targetNode: string, query: CrossShardQuery, timeoutMs?: number): Promise<CrossShardResult>;
    registerHandler(handler: CrossShardHandler): void;
    /** Configure delivery guarantee for subsequent sends. */
    setDeliveryGuarantee(guarantee: DeliveryGuarantee): void;
    /** Configure retry policy. */
    setRetryPolicy(maxRetries: number, backoffMs: number): void;
    /** Returns circuit breaker status for a node. */
    isCircuitOpen(nodeId: string): boolean;
    /** Reset circuit breaker for a node. */
    resetCircuit(nodeId: string): void;
}
type CrossShardHandler = (event: DistributedEvent, context: SimulationContext) => Promise<void>;
declare class LocalTransport implements CrossShardTransport {
    private _nodes;
    private _handlers;
    private _deliveryGuarantee;
    private _maxRetries;
    private _backoffMs;
    private _circuitBreakers;
    registerNode(nodeId: string, transport: LocalTransportNode): void;
    send(targetNode: string, event: DistributedEvent, context: SimulationContext): Promise<void>;
    broadcast(event: DistributedEvent, context: SimulationContext): Promise<void>;
    query(targetNode: string, query: CrossShardQuery, timeoutMs?: number): Promise<CrossShardResult>;
    registerHandler(handler: CrossShardHandler): void;
    setDeliveryGuarantee(guarantee: DeliveryGuarantee): void;
    setRetryPolicy(maxRetries: number, backoffMs: number): void;
    isCircuitOpen(nodeId: string): boolean;
    resetCircuit(nodeId: string): void;
    private _recordSuccess;
    private _recordFailure;
    private _delay;
    _dispatch(event: DistributedEvent, context: SimulationContext): Promise<void>;
}
interface LocalTransportNode {
    receive(event: DistributedEvent, context: SimulationContext): Promise<void>;
    handleQuery(query: CrossShardQuery): Promise<CrossShardResult>;
}
declare class DistributedStateManager implements StateManager, LocalTransportNode {
    private _localState;
    private _router;
    private _shardConfig;
    private _transport;
    private _nodeId;
    private _pendingCrossShardEvents;
    private _syncInterval;
    constructor(localState: StateManager, router: PartitionRouter, shardConfig: ShardConfig, transport: LocalTransport, nodeId: string, syncIntervalMs?: number);
    get currentTick(): Tick;
    get currentTime(): Timestamp;
    updateClock(tick: Tick, time: Timestamp): void;
    getEntity<T extends SimulationEntity>(id: string): T | undefined;
    /**
     * Async cross-shard entity access.
     * Returns undefined for entities not found on the target shard.
     */
    getEntityAsync<T extends SimulationEntity>(id: string): Promise<T | undefined>;
    setEntity(entity: SimulationEntity): void;
    deleteEntity(id: string): boolean;
    getAllEntities(): IterableIterator<SimulationEntity>;
    getEntitiesByType(type: string): SimulationEntity[];
    getMetric(key: string): number | undefined;
    setMetric(key: string, value: number): void;
    incrementMetric(key: string, delta?: number): number;
    snapshot(): SimulationState;
    restore(snapshot: SimulationState, options?: RestoreOptions): void;
    applyCommands(commands: StateCommands): void;
    clear(): void;
    receive(event: DistributedEvent, _context: SimulationContext): Promise<void>;
    handleQuery(query: CrossShardQuery): Promise<CrossShardResult>;
    flushPendingEvents(): DistributedEvent[];
    private _sync;
    destroy(): void;
}
declare class DistributedOrchestrator {
    private _nodes;
    private _router;
    private _transport;
    private _coordinatorId;
    constructor(router?: PartitionRouter);
    addNode(config: DistributedNodeConfig, localState: StateManager): DistributedNode;
    getNode(nodeId: string): DistributedNode | undefined;
    getAllNodes(): DistributedNode[];
    broadcast(event: DistributedEvent, context: SimulationContext): Promise<void>;
    sendToShard(shardIndex: number, event: DistributedEvent, context: SimulationContext): Promise<void>;
}
interface DistributedNode {
    nodeId: string;
    shard: ShardConfig;
    stateManager: DistributedStateManager;
    transport: CrossShardTransport;
    status: 'active' | 'standby' | 'failed';
}

/**
 * Injectable diagnostic logger for the Will library.
 *
 * Will is embedded inside a host process (the API server, the dev runner,
 * tests). A library has no business deciding where diagnostic output goes,
 * so every internal `console.*` call routes through this seam instead. The
 * host installs its own sink once at startup via `setLogger()`; everything
 * downstream calls `logger.info()/warn()/error()/debug()` and never touches
 * `console` directly.
 *
 * This is deliberately NOT the same thing as `SessionLogger` (stem/tracts),
 * which writes the structured NDJSON cognitive event stream. This logger is
 * for unstructured operational diagnostics — "rate limited, retrying",
 * "S3 upload failed", "engine X skipped" — the lines that used to be
 * `console.warn`.
 *
 * Default behaviour is identical to the previous direct `console.*` usage:
 * `ConsoleLogger` forwards each level to the matching console method, so
 * installing nothing changes nothing.
 *
 * Usage:
 *   import { logger } from '#core/logger'
 *   logger.warn('[LLMGate] rate limited — retrying')
 *
 *   // host, once at startup:
 *   import { setLogger } from 'will'
 *   setLogger(myStructuredLogger)
 */
interface Logger {
    debug(message?: unknown, ...args: unknown[]): void;
    info(message?: unknown, ...args: unknown[]): void;
    warn(message?: unknown, ...args: unknown[]): void;
    error(message?: unknown, ...args: unknown[]): void;
}
/**
 * Default sink: forwards to the global console. `debug` → console.debug,
 * `info` → console.info (stdout, same channel as the old console.log calls),
 * `warn`/`error` → their console equivalents (stderr). Behaviour matches the
 * pre-refactor direct console usage exactly.
 */
declare class ConsoleLogger implements Logger {
    debug(message?: unknown, ...args: unknown[]): void;
    info(message?: unknown, ...args: unknown[]): void;
    warn(message?: unknown, ...args: unknown[]): void;
    error(message?: unknown, ...args: unknown[]): void;
}
/**
 * No-op sink — useful for tests or hosts that want Will to stay silent.
 */
declare class SilentLogger implements Logger {
    debug(): void;
    info(): void;
    warn(): void;
    error(): void;
}
/**
 * Stable indirection object. Callers import this and call `logger.info(...)`;
 * `setLogger()` re-points the underlying sink without callers re-importing.
 */
declare const logger: Logger;
/** Install a custom sink for all subsequent Will diagnostic logging. */
declare function setLogger(next: Logger): void;
/** Reset to the default console sink. Primarily for tests. */
declare function resetLogger(): void;
/** The currently-installed sink (the real object, not the indirection). */
declare function getLogger(): Logger;

/**
 * Validates async engine reasoning footprints against current state.
 * Detects read-after-write and write-after-write conflicts that occur
 * when an engine reasons on a stale snapshot while the world advances.
 */

declare class ConflictDetector {
    /**
     * Check a reasoning footprint against the current state snapshot.
     * Returns a detailed conflict report.
     */
    detect(footprint: ReasoningFootprint, currentState: ReadonlySimulationState): ConflictReport;
    /**
     * Resolve conflicts using the specified strategy.
     */
    resolve(report: ConflictReport, strategy?: ConflictStrategy): ConflictResolution;
    /**
     * Attempt to apply a non-conflicting subset of commands.
     * Only includes entity sets and metric sets that don't touch conflicted entities.
     */
    private _merge;
}

/** Decides how emit() resolves an ack for a given envelope. Default: acked via callback. */
type AckPolicy = (env: OutboundEnvelope) => AckResult;
declare class LoopbackTransport implements ExternalTransport {
    /** Every envelope passed to emit(), in order — inspect in tests. */
    readonly sent: OutboundEnvelope[];
    private _connected;
    private _ackPolicy;
    private readonly _inboundHandlers;
    private readonly _statusHandlers;
    constructor(ackPolicy?: AckPolicy);
    get connected(): boolean;
    emit(env: OutboundEnvelope): Promise<AckResult>;
    onInbound(handler: (env: InboundEnvelope) => void): () => void;
    onStatus(handler: (s: TransportStatus) => void): () => void;
    close(): void;
    /** Simulate the peer sending an inbound envelope to the Will. */
    injectInbound(env: InboundEnvelope): void;
    /** Flip connection state and notify status handlers. */
    setConnected(connected: boolean): void;
    /** Swap the ack policy mid-test (e.g. to simulate timeouts then recovery). */
    setAckPolicy(policy: AckPolicy): void;
    /** Convenience: only the envelopes on a given channel. */
    sentOn<T extends OutboundEnvelope['channel']>(channel: T): Extract<OutboundEnvelope, {
        channel: T;
    }>[];
}

/** Minimal surface of a socket.io client we depend on — keeps us decoupled from the dep's types. */
interface SocketLike {
    connected: boolean;
    on(event: string, handler: (...args: any[]) => void): void;
    emit(event: string, payload: unknown, ack?: (response: unknown) => void): void;
    disconnect(): void;
}
interface SocketIoTransportOptions {
    /** socket.io server URL (e.g. wss://host or http://host:port). */
    url: string;
    /** This Will's id — sent as auth + routing key. */
    willId: string;
    /** Optional auth token sent in the socket.io handshake. */
    token?: string;
    /** Default ack timeout for emit() in ms. Default 5000. */
    ackTimeoutMs?: number;
    /**
     * Override the socket factory — inject a fake in tests, or customize the
     * socket.io connection. When omitted, `socket.io-client` is dynamically
     * imported and `io(url, { auth })` is called.
     */
    socketFactory?: (url: string, opts: {
        auth: {
            willId: string;
            token?: string;
        };
    }) => SocketLike | Promise<SocketLike>;
}
declare class SocketIoTransport implements ExternalTransport {
    private readonly _opts;
    private _socket;
    private _connecting;
    private _seq;
    private readonly _inboundHandlers;
    private readonly _statusHandlers;
    constructor(_opts: SocketIoTransportOptions);
    get connected(): boolean;
    emit(env: OutboundEnvelope, opts?: {
        ackTimeoutMs?: number;
    }): Promise<AckResult>;
    onInbound(handler: (env: InboundEnvelope) => void): () => void;
    onStatus(handler: (s: TransportStatus) => void): () => void;
    close(): void;
    private _ensureSocket;
    private _connect;
    private _defaultFactory;
    /** Attach socket.io event handlers that feed the inbound + status streams. */
    private _wire;
    private _emitInbound;
    private _notifyStatus;
    private _deliveryAck;
    private _resultAck;
}

/** Channels a consumer can filter on (any OutboundEnvelope channel, or '*'). */
type StreamChannel = OutboundEnvelope['channel'] | '*';
type OutboundListener = (env: OutboundEnvelope) => void;
declare class StreamTransport implements ExternalTransport {
    readonly willId: string;
    private _connected;
    private readonly _outbound;
    private readonly _outboundByCh;
    private readonly _inboundHandlers;
    private readonly _statusHandlers;
    constructor(willId?: string);
    get connected(): boolean;
    /**
     * Deliver an outbound envelope to subscribers. In-process and synchronous, so
     * it resolves immediately (`via: 'event'`) — there is no remote peer to ack.
     * A listener that throws is isolated; it can never break the tick loop.
     */
    emit(env: OutboundEnvelope): Promise<AckResult>;
    /** Subscribe to every outbound envelope. Returns an unsubscribe function. */
    subscribe(listener: OutboundListener): () => void;
    /**
     * Subscribe to a single channel (e.g. `'token_report'`, `'session_log'`,
     * `'reply'`) or `'*'` for all. Returns an unsubscribe function.
     */
    on(channel: StreamChannel, listener: OutboundListener): () => void;
    /**
     * Inject an inbound envelope (message, percept, ack) into the Will. The stem
     * enqueues it onto the tick-stamped InboundQueue and applies it deterministically
     * on tick — this method itself never touches simulation state.
     */
    injectInbound(env: InboundEnvelope): void;
    onInbound(handler: (env: InboundEnvelope) => void): () => void;
    onStatus(handler: (s: TransportStatus) => void): () => void;
    /** Notify status subscribers (e.g. flip to 'disconnected' in a test). */
    setStatus(status: TransportStatus): void;
    close(): void;
    /** Total active outbound listeners (diagnostics/tests). */
    get listenerCount(): number;
    private _dispatch;
}
/**
 * Whether producers should ALSO write their telemetry to local files.
 *
 * Files are a development convenience only. In production the stream/transport is
 * the single source of truth and the consumer owns persistence.
 *
 * - `WILL_FILE_LOGS=true|1|false|0` — explicit override (wins).
 * - otherwise: on when `NODE_ENV` is neither `production` nor `test`.
 */
declare function fileLoggingEnabled(): boolean;

/**
 * Number of ticks an undelivered outbox message survives before it is
 * expired. Override via WILL_OUTBOX_TTL_TICKS. Default: 100 ticks.
 */
declare const OUTBOX_TTL_TICKS: number;

interface WorldProfile {
    id: string;
    name: string;
    description: string;
    /** Effectors pre-granted when this profile is active. */
    effectors: string[];
    /**
     * Appended to the executive prompt under "## Your Environment".
     * Tells the Will what world it inhabits and how to behave in it.
     */
    context: string;
}
/** Resolve a profile by id. Returns undefined if not registered. */
declare function resolveProfile(id: string): WorldProfile | undefined;
/** List all registered profile ids. */
declare function listProfiles(): string[];

export { type AckPolicy, AckResult, ConflictDetector, ConflictReport, ConflictResolution, ConflictStrategy, ConsistentHashRouter, ConsoleLogger, type CrossShardQuery, type CrossShardResult, type CrossShardTransport, DefaultPartitionRouter, type DeliveryGuarantee, type DistributedEvent, type DistributedNode, type DistributedNodeConfig, DistributedOrchestrator, DistributedStateManager, ExternalTransport, InboundEnvelope, LocalTransport, type Logger, LoopbackTransport, OUTBOX_TTL_TICKS, OutboundEnvelope, type OutboundListener, type PartitionRouter, ReasoningFootprint, RestoreOptions, type ShardConfig, type ShardStrategy, SilentLogger, SimulationContext, SimulationEntity, SimulationEvent, SimulationState, SocketIoTransport, type SocketIoTransportOptions, type SocketLike, StateManager, type StreamChannel, StreamTransport, Tick, Timestamp, TransportStatus, type WorldProfile, createContext, createPRNG, fileLoggingEnabled, getLogger, listProfiles, logger, resetLogger, resolveProfile, setLogger };

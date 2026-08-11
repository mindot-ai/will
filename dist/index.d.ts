import { c3 as SimulationContext, bQ as SeededPRNG, c5 as SimulationEntity, cy as Timestamp, c6 as SimulationEvent, ci as StateManager, cw as Tick, c9 as SimulationState, bI as RestoreOptions, ch as StateCommands, bt as ReasoningFootprint, br as ReadonlySimulationState, J as ConflictReport, L as ConflictStrategy, K as ConflictResolution, ba as OutboundEnvelope, a as AckResult, aq as ExternalTransport, aA as InboundEnvelope, cE as TransportStatus } from './will-Dw52h8Ty.js';
export { A as AckEnvelope, b as ActionRequest, c as ActionResult, d as ActionSelector, e as ActivityEnvelope, f as ActivityEvent, g as ActivityEventHandler, h as AestheticEvaluator, i as AestheticEvaluatorConfig, j as AffectiveBlender, k as AffectiveBlenderConfig, l as AffordanceSynthesizer, m as AsyncEngine, n as AsyncEngineConfig, o as AttachmentEvaluator, p as AttachmentEvaluatorConfig, q as AttentionAllocator, r as AttentionAllocatorConfig, s as AuditionEngine, t as AutobiographicalNarrator, u as AutobiographicalNarratorConfig, B as BACKGROUND_DEMAND, v as BehavioralProbeResult, w as BiasDetector, x as BiasDetectorConfig, y as BunStorageAdapter, C as ChunkEnvelope, z as CircadianConfig, D as CircadianOscillator, E as ClockConfig, F as Cognition, G as CognitiveHealth, H as ConfidenceCalibrator, I as ConfidenceCalibratorConfig, M as Coordinates, N as CreateWillOptions, O as DefaultEventBus, P as DefaultMetricCollector, Q as DefaultOrchestrator, R as DefaultReplayRecorder, S as DefaultReplaySession, T as DefaultScenario, U as DefaultSerializer, V as DefaultSimulation, W as DefaultSimulationClock, X as DefaultStateManager, Y as DefaultVectorMemoryAdapter, Z as DeliberationEngine, _ as DeltaEncoder, $ as DeltaSnapshot, a0 as DreamSimulator, a1 as DreamSimulatorConfig, a2 as Duration, a3 as ESCALATION_DEMAND, a4 as EffectorDeclaration, a5 as EffectorEntry, a6 as EffectorHandler, a7 as EffectorResult, a8 as EffectorSpec, a9 as EmbeddingProvider, aa as EmpathySimulator, ab as EmpathySimulatorConfig, ac as EnergyRegulator, ad as EnergyRegulatorConfig, ae as EngineRegistry, af as EngineResult, ag as Envelope, ah as EpisodicConsolidator, ai as EpisodicConsolidatorConfig, aj as EventBus, ak as EventBusConfig, al as EventFilter, am as EventHandler, an as EventPayload, ao as ExecutiveEngine, ap as ExecutiveEngineConfig, ar as Exteroception, as as ExteroceptionConfig, at as ForgettingCurve, au as ForgettingCurveConfig, av as FrustrationEvaluator, aw as FrustrationEvaluatorConfig, ax as GoalManager, ay as GoalManagerConfig, az as GustationEngine, aB as InboundMessageEnvelope, aC as InboundPerceptEnvelope, aD as InhibitionController, aE as InhibitionControllerConfig, aF as Interoception, aG as InteroceptionConfig, aH as IntrospectionEngine, aI as IntrospectionEngineConfig, aJ as KNOWN_PROVIDERS, aK as KnownEntityTracker, aL as KnownEntityTrackerConfig, aM as KnownProvider, aN as LLMCallMeta, aO as LLMCompletionRecord, aP as LLMCompletionSink, aQ as LLMProvider, aR as LLMWire, aS as LossEvaluator, aT as LossEvaluatorConfig, aU as MessageEnvelope, aV as MetricCollector, aW as MetricPoint, aX as MinimalContext, aY as MockEmbedder, aZ as ModelPrice, a_ as ModelRoute, a$ as ModelRouter, b0 as MoralEvaluator, b1 as MoralEvaluatorConfig, b2 as MotorSchemaExecutor, b3 as NULL_ROUTER, b4 as NoveltyDetector, b5 as NoveltyDetectorConfig, b6 as OlfactionEngine, b7 as OpenAICompatibleEmbedder, b8 as Orchestrator, b9 as OrchestratorConfig, bb as OutboxMessage, bc as PMABehavioral, bd as PMABelief, be as PMAEmotionalBaseline, bf as PMAEvalHarness, bg as PMAGoal, bh as PMAIdentity, bi as PMAProbe, bj as PMASnapshot, bk as PerceptEnvelope, bl as PersonaConsolidator, bm as PersonaConsolidatorConfig, bn as PlanningEngine, bo as PlanningEngineConfig, bp as PriceTable, bq as ProviderCredential, bs as ReafferenceEngine, bu as ReconstructionFidelityReport, bv as ReconstructionFidelityScores, bw as RecordUsageInput, bx as ReplayComparison, by as ReplayConfig, bz as ReplayDifference, bA as ReplayManager, bB as ReplayMetadata, bC as ReplayRecord, bD as ReplayRecorder, bE as ReplaySession, bF as ReplyEnvelope, bG as ReputationTracker, bH as ReputationTrackerConfig, bJ as RewardEvaluator, bK as RewardEvaluatorConfig, bL as RoutingRule, bM as Scenario, bN as ScenarioConfig, bO as ScenarioValidationResult, bP as SchemaPrecondition, bR as SelfModelUpdater, bS as SelfModelUpdaterConfig, bT as SemanticIntegrator, bU as SemanticIntegratorConfig, bV as SensoryInput, bW as SerializationConfig, bX as SerializationFormat, bY as SerializedEntity, bZ as SerializedState, b_ as Serializer, b$ as SessionLogEnvelope, c0 as Simulation, c1 as SimulationClock, c2 as SimulationConfig, c4 as SimulationEngine, c7 as SimulationEventBase, c8 as SimulationEventListener, ca as SleepPressureConfig, cb as SleepPressureRegulator, cc as SocialPerception, cd as SocialPerceptionConfig, ce as SomatosensationEngine, cf as SpacedRepetition, cg as SpacedRepetitionConfig, cj as StateSnapshot, ck as Stimulus, cl as StorageAdapter, cm as StressRegulator, cn as StressRegulatorConfig, co as TableRouter, cp as TaskSwitcher, cq as TaskSwitcherConfig, cr as TextMessage, cs as TheoryOfMind, ct as TheoryOfMindConfig, cu as ThreatEvaluator, cv as ThreatEvaluatorConfig, cx as TickListener, cz as TokenLedgerRecord, cA as TokenReportEnvelope, cB as TokenTracker, cC as TokenTrackerConfig, cD as TokenUsage, cF as VectorIndex, cG as VectorMemoryAdapter, cH as VectorMemoryConfig, cI as VectorQueryFilter, cJ as VectorQueryResult, cK as VectorRecord, cL as VisionEngine, cM as VoiceChunk, cN as Will, cO as WillAffect, cP as WillConfig, cQ as WillEffectorAct, cR as WillInstance, cS as WillMessage, cT as WillStateSummary, cU as WillStatus, cV as WillStem, cW as WillSummary, cX as WorkingMemory, cY as WorkingMemoryConfig, cZ as WorldEntity, c_ as WorldInterface, c$ as assembleMind, d0 as chainRouters, d1 as clearCompletionRecorder, d2 as defaultBaseFor, d3 as effectorInvocation, d4 as effectorInvocationEnvelope, d5 as getCompletionRecorder, d6 as isNullRouter, d7 as knownWireFor, d8 as resolvePricing, d9 as setCompletionRecorder } from './will-Dw52h8Ty.js';

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
     * Appended to the executive prompt under "## My Environment".
     * Tells the Will what world it inhabits and how to behave in it.
     */
    context: string;
}
/** Resolve a profile by id. Returns undefined if not registered. */
declare function resolveProfile(id: string): WorldProfile | undefined;
/** List all registered profile ids. */
declare function listProfiles(): string[];

export { type AckPolicy, AckResult, ConflictDetector, ConflictReport, ConflictResolution, ConflictStrategy, ConsistentHashRouter, ConsoleLogger, type CrossShardQuery, type CrossShardResult, type CrossShardTransport, DefaultPartitionRouter, type DeliveryGuarantee, type DistributedEvent, type DistributedNode, type DistributedNodeConfig, DistributedOrchestrator, DistributedStateManager, ExternalTransport, InboundEnvelope, LocalTransport, type Logger, LoopbackTransport, OUTBOX_TTL_TICKS, OutboundEnvelope, type OutboundListener, type PartitionRouter, ReasoningFootprint, RestoreOptions, type ShardConfig, type ShardStrategy, SilentLogger, SimulationContext, SimulationEntity, SimulationEvent, SimulationState, SocketIoTransport, type SocketIoTransportOptions, type SocketLike, StateManager, type StreamChannel, StreamTransport, Tick, Timestamp, TransportStatus, type WorldProfile, createContext, createPRNG, fileLoggingEnabled, getLogger, listProfiles, logger, resetLogger, resolveProfile, setLogger };

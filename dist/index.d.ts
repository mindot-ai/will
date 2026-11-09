import { cl as SimulationContext, c3 as SeededPRNG, cn as SimulationEntity, cQ as Timestamp, co as SimulationEvent, cA as StateManager, cO as Tick, cr as SimulationState, bX as RestoreOptions, cz as StateCommands, bF as ReasoningFootprint, bD as ReadonlySimulationState, N as ConflictReport, P as ConflictStrategy, O as ConflictResolution, bh as OutboundEnvelope, a as AckResult, av as ExternalTransport, aG as InboundEnvelope, cX as TransportStatus, E as ChainVerification, D as ChainHead, C as ChainEntry, bJ as RecordDigest, m as AnchoringOptions, by as PolicyDecision, a4 as DenialFinality, bw as PolicyArbiter, bz as PolicyInvocation, d2 as Verdict } from './will-C9Ege0jp.js';
export { A as AckEnvelope, b as ActionRequest, c as ActionResult, d as ActionSelector, e as ActivityEnvelope, f as ActivityEvent, g as ActivityEventHandler, h as AestheticEvaluator, i as AestheticEvaluatorConfig, j as AffectiveBlender, k as AffectiveBlenderConfig, l as AffordanceSynthesizer, n as AsyncEngine, o as AsyncEngineConfig, p as AttachmentEvaluator, q as AttachmentEvaluatorConfig, r as AttentionAllocator, s as AttentionAllocatorConfig, t as AuditionEngine, u as AutobiographicalNarrator, v as AutobiographicalNarratorConfig, B as BACKGROUND_DEMAND, w as BehavioralProbeResult, x as BiasDetector, y as BiasDetectorConfig, z as BunStorageAdapter, F as ChunkEnvelope, G as CircadianConfig, H as CircadianOscillator, I as ClockConfig, J as Cognition, K as CognitiveHealth, L as ConfidenceCalibrator, M as ConfidenceCalibratorConfig, Q as Coordinates, R as CreateWillOptions, S as DefaultEventBus, T as DefaultMetricCollector, U as DefaultOrchestrator, V as DefaultReplayRecorder, W as DefaultReplaySession, X as DefaultScenario, Y as DefaultSerializer, Z as DefaultSimulation, _ as DefaultSimulationClock, $ as DefaultStateManager, a0 as DefaultVectorMemoryAdapter, a1 as DeliberationEngine, a2 as DeltaEncoder, a3 as DeltaSnapshot, a5 as DreamSimulator, a6 as DreamSimulatorConfig, a7 as Duration, a8 as ESCALATION_DEMAND, a9 as EffectorDeclaration, aa as EffectorEntry, ab as EffectorHandler, ac as EffectorResult, ad as EffectorSpec, ae as EmbeddingProvider, af as EmpathySimulator, ag as EmpathySimulatorConfig, ah as EnergyRegulator, ai as EnergyRegulatorConfig, aj as EngineRegistry, ak as EngineResult, al as Envelope, am as EpisodicConsolidator, an as EpisodicConsolidatorConfig, ao as EventBus, ap as EventBusConfig, aq as EventFilter, ar as EventHandler, as as EventPayload, at as ExecutiveEngine, au as ExecutiveEngineConfig, aw as Exteroception, ax as ExteroceptionConfig, ay as ForgettingCurve, az as ForgettingCurveConfig, aA as FrustrationEvaluator, aB as FrustrationEvaluatorConfig, aC as GENESIS_HASH, aD as GoalManager, aE as GoalManagerConfig, aF as GustationEngine, aH as InboundMessageEnvelope, aI as InboundPerceptEnvelope, aJ as InhibitionController, aK as InhibitionControllerConfig, aL as Interoception, aM as InteroceptionConfig, aN as IntrospectionEngine, aO as IntrospectionEngineConfig, aP as KNOWN_PROVIDERS, aQ as KnownEntityTracker, aR as KnownEntityTrackerConfig, aS as KnownProvider, aT as LLMCallMeta, aU as LLMCompletionRecord, aV as LLMCompletionSink, aW as LLMProvider, aX as LLMWire, aY as LossEvaluator, aZ as LossEvaluatorConfig, a_ as MessageEnvelope, a$ as MetricCollector, b0 as MetricPoint, b1 as MinimalContext, b2 as MockEmbedder, b3 as ModelPrice, b4 as ModelRoute, b5 as ModelRouter, b6 as MoralEvaluator, b7 as MoralEvaluatorConfig, b8 as MotorSchemaExecutor, b9 as NULL_ARBITER, ba as NULL_ROUTER, bb as NoveltyDetector, bc as NoveltyDetectorConfig, bd as OlfactionEngine, be as OpenAICompatibleEmbedder, bf as Orchestrator, bg as OrchestratorConfig, bi as OutboxMessage, bj as PMABehavioral, bk as PMABelief, bl as PMAEmotionalBaseline, bm as PMAEvalHarness, bn as PMAGoal, bo as PMAIdentity, bp as PMAProbe, bq as PMASnapshot, br as PerceptEnvelope, bs as PersonaConsolidator, bt as PersonaConsolidatorConfig, bu as PlanningEngine, bv as PlanningEngineConfig, bx as PolicyCounterfactual, bA as PriceTable, bB as ProviderCredential, bC as RECORD_CHAIN, bE as ReafferenceEngine, bG as ReconstructionFidelityReport, bH as ReconstructionFidelityScores, bI as RecordChain, bK as RecordStream, bL as RecordUsageInput, bM as ReplayComparison, bN as ReplayConfig, bO as ReplayDifference, bP as ReplayManager, bQ as ReplayMetadata, bR as ReplayRecord, bS as ReplayRecorder, bT as ReplaySession, bU as ReplyEnvelope, bV as ReputationTracker, bW as ReputationTrackerConfig, bY as RewardEvaluator, bZ as RewardEvaluatorConfig, b_ as RoutingRule, b$ as Scenario, c0 as ScenarioConfig, c1 as ScenarioValidationResult, c2 as SchemaPrecondition, c4 as SelfModelUpdater, c5 as SelfModelUpdaterConfig, c6 as SemanticIntegrator, c7 as SemanticIntegratorConfig, c8 as SensoryInput, c9 as SensorySignal, ca as SerializationConfig, cb as SerializationFormat, cc as SerializedEntity, cd as SerializedState, ce as Serializer, cf as SessionLogEnvelope, cg as SharedFile, ch as SignalProvenance, ci as Simulation, cj as SimulationClock, ck as SimulationConfig, cm as SimulationEngine, cp as SimulationEventBase, cq as SimulationEventListener, cs as SleepPressureConfig, ct as SleepPressureRegulator, cu as SocialPerception, cv as SocialPerceptionConfig, cw as SomatosensationEngine, cx as SpacedRepetition, cy as SpacedRepetitionConfig, cB as StateSnapshot, cC as Stimulus, cD as StorageAdapter, cE as StressRegulator, cF as StressRegulatorConfig, cG as TableRouter, cH as TaskSwitcher, cI as TaskSwitcherConfig, cJ as TextMessage, cK as TheoryOfMind, cL as TheoryOfMindConfig, cM as ThreatEvaluator, cN as ThreatEvaluatorConfig, cP as TickListener, cR as TokenLedgerRecord, cS as TokenReportEnvelope, cT as TokenTracker, cU as TokenTrackerConfig, cV as TokenUsage, cW as Transduced, cY as VectorIndex, cZ as VectorMemoryAdapter, c_ as VectorMemoryConfig, c$ as VectorQueryFilter, d0 as VectorQueryResult, d1 as VectorRecord, d3 as VisionEngine, d4 as VoiceChunk, d5 as Will, d6 as WillAffect, d7 as WillConfig, d8 as WillEffectorAct, d9 as WillInstance, da as WillMessage, db as WillStateSummary, dc as WillStatus, dd as WillStem, de as WillSummary, df as WorkingMemory, dg as WorkingMemoryConfig, dh as WorldEntity, di as WorldInterface, dj as asFinality, dk as asProvenance, dl as assembleMind, dm as canonical, dn as chainRouters, dp as clearCompletionRecorder, dq as defaultBaseFor, dr as effectorInvocation, ds as effectorInvocationEnvelope, dt as finalityOf, du as getCompletionRecorder, dv as isNullArbiter, dw as isNullRouter, dx as knownWireFor, dy as recordHash, dz as resolvePricing, dA as setCompletionRecorder, dB as verifyChain } from './will-C9Ege0jp.js';

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

/** A digest as `anchor()` was handed it, with the signature if one was made. */
interface AnchoredDigest {
    readonly digest: {
        readonly willId: string;
        readonly tick: number;
        readonly streamHeads: {
            readonly records: string;
        };
        readonly meta: {
            readonly chain: string;
            readonly seq: number;
        };
    };
    readonly signature?: string;
}
interface DigestCheck {
    readonly tick: number;
    readonly seq: number;
    readonly ok: boolean;
    readonly reason?: string;
}
interface RecordsReport {
    /** The chain verified and every digest checked. */
    readonly ok: boolean;
    readonly entries: number;
    readonly chain: ChainVerification;
    readonly digests: readonly DigestCheck[];
    /** The last entry a good digest covers; `null` when none does. */
    readonly anchoredThrough: number | null;
    /** Entries after it: what could still be rewritten without detection. */
    readonly unanchored: number;
}
interface VerifyOptions {
    /** Where a continued chain's records begin: the head before the first one kept. */
    readonly from?: ChainHead;
    readonly digests?: readonly AnchoredDigest[];
    /**
     * Checks a signature over `canonical(digest)`. When given, every digest must
     * carry one that it accepts.
     */
    readonly verify?: (material: string, signature: string) => boolean;
}
declare function verifyRecords(entries: readonly ChainEntry[], opts?: VerifyOptions): RecordsReport;

/** One JSON value per non-empty line. */
declare function readJsonLines<T>(path: string): T[];
interface FileAnchoringOptions {
    readonly every: number;
    readonly sign?: (material: string) => string;
    /** Also publish each digest somewhere the operator cannot rewrite. Not awaited. */
    readonly publish?: (digest: RecordDigest, signature?: string) => void | Promise<void>;
}
declare function fileAnchoring(dir: string, opts: FileAnchoringOptions): AnchoringOptions;
/** Sign `canonical(digest)` with an Ed25519 private key (PEM). Base64 out. */
declare function ed25519Signer(privateKeyPem: string): (material: string) => string;
/** Check a base64 signature with an Ed25519 public key (PEM). */
declare function ed25519Verifier(publicKeyPem: string): (material: string, signature: string) => boolean;

interface ReplayDivergence {
    readonly seq: number;
    readonly reason: string;
    readonly expected?: unknown;
    readonly produced?: unknown;
}
interface ReplayReport {
    /** Every entry of the original was reproduced. */
    readonly reproduced: boolean;
    /** The last entry reproduced. */
    readonly through: number;
    /** The original's last entry. */
    readonly last: number;
    readonly divergence?: ReplayDivergence;
    /** Outputs whose record was shredded: compared by stream and tick only. */
    readonly shredded: number;
    /** Why the chain could not be replayed at all. */
    readonly refused?: string;
}
interface ReplayOptions {
    /** Longest a tick may run before the replay is called stalled. Default 30 s. */
    readonly stallMs?: number;
    /** Keep the engine's own logging. Off by default: a replay is a check, not a run. */
    readonly verbose?: boolean;
}
/**
 * Re-execute the mind whose chain `entries` is, and report the first place it
 * does not reproduce. `entries` begins at a genesis: a chain's first entry, or
 * the entry a woken Will continued it with. A chain a mind continued across
 * processes holds one genesis per process; each is replayed from its own, in
 * order, since each was a mind raised afresh from its starting state.
 */
declare function replayChain(entries: readonly ChainEntry[], opts?: ReplayOptions): Promise<ReplayReport>;

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

/** A bound on one parameter. Checked in declaration order: max, min, equals, oneOf. */
interface ParamConstraint {
    max?: number;
    min?: number;
    equals?: unknown;
    oneOf?: readonly unknown[];
}
/**
 * One rule. `schema`/`target` scope it (omitted ⇒ matches any); the FIRST rule
 * whose scope matches decides, so order is policy.
 *
 * `require` is meaningful with `decision: 'allow'` only: the scope matched, and
 * these constraints must hold for the allow to stand. A violation flips the
 * verdict to deny — carrying the counterfactual — with finality 'parameter',
 * because the ability itself was permitted and only these arguments were not.
 *
 * A rule with `decision: 'deny'` and no `require` is a flat class-level ban;
 * it reports finality 'class' unless told otherwise.
 */
interface PolicyRule {
    schema?: string;
    target?: string;
    decision: PolicyDecision;
    require?: Record<string, ParamConstraint>;
    reasonCode?: string;
    finality?: DenialFinality;
}
interface RuleTableOptions {
    rules: readonly PolicyRule[];
    /**
     * The verdict when NO rule matches. Required — deliberately not defaulted.
     * A policy component that silently defaults open is a trap; make the posture
     * an explicit decision at the call site. 'deny' is fail-closed and is the
     * right choice once a rule set is complete.
     */
    fallthrough: PolicyDecision;
    /** Recorded with every verdict for audit. Defaults to 'rule-table'. */
    name?: string;
}
declare class RuleTableArbiter implements PolicyArbiter {
    readonly name: string;
    private readonly _rules;
    private readonly _fallthrough;
    constructor(opts: RuleTableOptions);
    evaluate(invocation: PolicyInvocation): Verdict;
}

export { type AckPolicy, AckResult, type AnchoredDigest, AnchoringOptions, ChainEntry, ChainHead, ChainVerification, ConflictDetector, ConflictReport, ConflictResolution, ConflictStrategy, ConsistentHashRouter, ConsoleLogger, type CrossShardQuery, type CrossShardResult, type CrossShardTransport, DefaultPartitionRouter, type DeliveryGuarantee, DenialFinality, type DigestCheck, type DistributedEvent, type DistributedNode, type DistributedNodeConfig, DistributedOrchestrator, DistributedStateManager, ExternalTransport, type FileAnchoringOptions, InboundEnvelope, LocalTransport, type Logger, LoopbackTransport, OUTBOX_TTL_TICKS, OutboundEnvelope, type OutboundListener, type ParamConstraint, type PartitionRouter, PolicyArbiter, PolicyDecision, PolicyInvocation, type PolicyRule, ReasoningFootprint, RecordDigest, type RecordsReport, type ReplayDivergence, type ReplayOptions, type ReplayReport, RestoreOptions, RuleTableArbiter, type RuleTableOptions, type ShardConfig, type ShardStrategy, SilentLogger, SimulationContext, SimulationEntity, SimulationEvent, SimulationState, SocketIoTransport, type SocketIoTransportOptions, type SocketLike, StateManager, type StreamChannel, StreamTransport, Tick, Timestamp, TransportStatus, Verdict, type VerifyOptions, type WorldProfile, createContext, createPRNG, ed25519Signer, ed25519Verifier, fileAnchoring, fileLoggingEnabled, getLogger, listProfiles, logger, readJsonLines, replayChain, resetLogger, resolveProfile, setLogger, verifyRecords };

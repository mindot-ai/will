import { cb as SimulationContext, bW as SeededPRNG, cd as SimulationEntity, cG as Timestamp, ce as SimulationEvent, cq as StateManager, cE as Tick, ch as SimulationState, bO as RestoreOptions, cp as StateCommands, bz as ReasoningFootprint, bx as ReadonlySimulationState, J as ConflictReport, L as ConflictStrategy, K as ConflictResolution, bc as OutboundEnvelope, a as AckResult, ar as ExternalTransport, aB as InboundEnvelope, cN as TransportStatus, bt as PolicyDecision, a0 as DenialFinality, br as PolicyArbiter, bu as PolicyInvocation, cU as Verdict } from './will-CaOGxpwp.js';
export { A as AckEnvelope, b as ActionRequest, c as ActionResult, d as ActionSelector, e as ActivityEnvelope, f as ActivityEvent, g as ActivityEventHandler, h as AestheticEvaluator, i as AestheticEvaluatorConfig, j as AffectiveBlender, k as AffectiveBlenderConfig, l as AffordanceSynthesizer, m as AsyncEngine, n as AsyncEngineConfig, o as AttachmentEvaluator, p as AttachmentEvaluatorConfig, q as AttentionAllocator, r as AttentionAllocatorConfig, s as AuditionEngine, t as AutobiographicalNarrator, u as AutobiographicalNarratorConfig, B as BACKGROUND_DEMAND, v as BehavioralProbeResult, w as BiasDetector, x as BiasDetectorConfig, y as BunStorageAdapter, C as ChunkEnvelope, z as CircadianConfig, D as CircadianOscillator, E as ClockConfig, F as Cognition, G as CognitiveHealth, H as ConfidenceCalibrator, I as ConfidenceCalibratorConfig, M as Coordinates, N as CreateWillOptions, O as DefaultEventBus, P as DefaultMetricCollector, Q as DefaultOrchestrator, R as DefaultReplayRecorder, S as DefaultReplaySession, T as DefaultScenario, U as DefaultSerializer, V as DefaultSimulation, W as DefaultSimulationClock, X as DefaultStateManager, Y as DefaultVectorMemoryAdapter, Z as DeliberationEngine, _ as DeltaEncoder, $ as DeltaSnapshot, a1 as DreamSimulator, a2 as DreamSimulatorConfig, a3 as Duration, a4 as ESCALATION_DEMAND, a5 as EffectorDeclaration, a6 as EffectorEntry, a7 as EffectorHandler, a8 as EffectorResult, a9 as EffectorSpec, aa as EmbeddingProvider, ab as EmpathySimulator, ac as EmpathySimulatorConfig, ad as EnergyRegulator, ae as EnergyRegulatorConfig, af as EngineRegistry, ag as EngineResult, ah as Envelope, ai as EpisodicConsolidator, aj as EpisodicConsolidatorConfig, ak as EventBus, al as EventBusConfig, am as EventFilter, an as EventHandler, ao as EventPayload, ap as ExecutiveEngine, aq as ExecutiveEngineConfig, as as Exteroception, at as ExteroceptionConfig, au as ForgettingCurve, av as ForgettingCurveConfig, aw as FrustrationEvaluator, ax as FrustrationEvaluatorConfig, ay as GoalManager, az as GoalManagerConfig, aA as GustationEngine, aC as InboundMessageEnvelope, aD as InboundPerceptEnvelope, aE as InhibitionController, aF as InhibitionControllerConfig, aG as Interoception, aH as InteroceptionConfig, aI as IntrospectionEngine, aJ as IntrospectionEngineConfig, aK as KNOWN_PROVIDERS, aL as KnownEntityTracker, aM as KnownEntityTrackerConfig, aN as KnownProvider, aO as LLMCallMeta, aP as LLMCompletionRecord, aQ as LLMCompletionSink, aR as LLMProvider, aS as LLMWire, aT as LossEvaluator, aU as LossEvaluatorConfig, aV as MessageEnvelope, aW as MetricCollector, aX as MetricPoint, aY as MinimalContext, aZ as MockEmbedder, a_ as ModelPrice, a$ as ModelRoute, b0 as ModelRouter, b1 as MoralEvaluator, b2 as MoralEvaluatorConfig, b3 as MotorSchemaExecutor, b4 as NULL_ARBITER, b5 as NULL_ROUTER, b6 as NoveltyDetector, b7 as NoveltyDetectorConfig, b8 as OlfactionEngine, b9 as OpenAICompatibleEmbedder, ba as Orchestrator, bb as OrchestratorConfig, bd as OutboxMessage, be as PMABehavioral, bf as PMABelief, bg as PMAEmotionalBaseline, bh as PMAEvalHarness, bi as PMAGoal, bj as PMAIdentity, bk as PMAProbe, bl as PMASnapshot, bm as PerceptEnvelope, bn as PersonaConsolidator, bo as PersonaConsolidatorConfig, bp as PlanningEngine, bq as PlanningEngineConfig, bs as PolicyCounterfactual, bv as PriceTable, bw as ProviderCredential, by as ReafferenceEngine, bA as ReconstructionFidelityReport, bB as ReconstructionFidelityScores, bC as RecordUsageInput, bD as ReplayComparison, bE as ReplayConfig, bF as ReplayDifference, bG as ReplayManager, bH as ReplayMetadata, bI as ReplayRecord, bJ as ReplayRecorder, bK as ReplaySession, bL as ReplyEnvelope, bM as ReputationTracker, bN as ReputationTrackerConfig, bP as RewardEvaluator, bQ as RewardEvaluatorConfig, bR as RoutingRule, bS as Scenario, bT as ScenarioConfig, bU as ScenarioValidationResult, bV as SchemaPrecondition, bX as SelfModelUpdater, bY as SelfModelUpdaterConfig, bZ as SemanticIntegrator, b_ as SemanticIntegratorConfig, b$ as SensoryInput, c0 as SensorySignal, c1 as SerializationConfig, c2 as SerializationFormat, c3 as SerializedEntity, c4 as SerializedState, c5 as Serializer, c6 as SessionLogEnvelope, c7 as SignalProvenance, c8 as Simulation, c9 as SimulationClock, ca as SimulationConfig, cc as SimulationEngine, cf as SimulationEventBase, cg as SimulationEventListener, ci as SleepPressureConfig, cj as SleepPressureRegulator, ck as SocialPerception, cl as SocialPerceptionConfig, cm as SomatosensationEngine, cn as SpacedRepetition, co as SpacedRepetitionConfig, cr as StateSnapshot, cs as Stimulus, ct as StorageAdapter, cu as StressRegulator, cv as StressRegulatorConfig, cw as TableRouter, cx as TaskSwitcher, cy as TaskSwitcherConfig, cz as TextMessage, cA as TheoryOfMind, cB as TheoryOfMindConfig, cC as ThreatEvaluator, cD as ThreatEvaluatorConfig, cF as TickListener, cH as TokenLedgerRecord, cI as TokenReportEnvelope, cJ as TokenTracker, cK as TokenTrackerConfig, cL as TokenUsage, cM as Transduced, cO as VectorIndex, cP as VectorMemoryAdapter, cQ as VectorMemoryConfig, cR as VectorQueryFilter, cS as VectorQueryResult, cT as VectorRecord, cV as VisionEngine, cW as VoiceChunk, cX as Will, cY as WillAffect, cZ as WillConfig, c_ as WillEffectorAct, c$ as WillInstance, d0 as WillMessage, d1 as WillStateSummary, d2 as WillStatus, d3 as WillStem, d4 as WillSummary, d5 as WorkingMemory, d6 as WorkingMemoryConfig, d7 as WorldEntity, d8 as WorldInterface, d9 as asFinality, da as asProvenance, db as assembleMind, dc as chainRouters, dd as clearCompletionRecorder, de as defaultBaseFor, df as effectorInvocation, dg as effectorInvocationEnvelope, dh as finalityOf, di as getCompletionRecorder, dj as isNullArbiter, dk as isNullRouter, dl as knownWireFor, dm as resolvePricing, dn as setCompletionRecorder } from './will-CaOGxpwp.js';

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

export { type AckPolicy, AckResult, ConflictDetector, ConflictReport, ConflictResolution, ConflictStrategy, ConsistentHashRouter, ConsoleLogger, type CrossShardQuery, type CrossShardResult, type CrossShardTransport, DefaultPartitionRouter, type DeliveryGuarantee, DenialFinality, type DistributedEvent, type DistributedNode, type DistributedNodeConfig, DistributedOrchestrator, DistributedStateManager, ExternalTransport, InboundEnvelope, LocalTransport, type Logger, LoopbackTransport, OUTBOX_TTL_TICKS, OutboundEnvelope, type OutboundListener, type ParamConstraint, type PartitionRouter, PolicyArbiter, PolicyDecision, PolicyInvocation, type PolicyRule, ReasoningFootprint, RestoreOptions, RuleTableArbiter, type RuleTableOptions, type ShardConfig, type ShardStrategy, SilentLogger, SimulationContext, SimulationEntity, SimulationEvent, SimulationState, SocketIoTransport, type SocketIoTransportOptions, type SocketLike, StateManager, type StreamChannel, StreamTransport, Tick, Timestamp, TransportStatus, Verdict, type WorldProfile, createContext, createPRNG, fileLoggingEnabled, getLogger, listProfiles, logger, resetLogger, resolveProfile, setLogger };

// ─────────────────────────────────────────────────────────────
// src/stem/index.ts  —  Will lifecycle manager
// ─────────────────────────────────────────────────────────────
//
// WillStem owns the lifecycle of one or more Will instances:
//   create → tick (autonomous loop) → pause / resume → archive
//
// Each Will runs its own async tick loop concurrently.
// The LLM gate (src/llm/gate.ts) handles concurrency across Wills.
//
// Usage (production / API layer):
//   const manager = new WillStem()
//   const id = await manager.createWill(config)
//   manager.addTickListener(id, (snapshot, tick) => { ... })
//   await manager.pauseWill(id)
//   await manager.archiveWill(id)
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { DefaultSimulation } from '#core/simulation'
import type { SimulationEvent, SimulationContext, SimulationState } from '#core/types'
import type { ExecutiveOutputFull } from '#faculties/executive.engine'
import type { Cognition, OutboxMessage, effectorInvocation, WorldInterface } from '#types'
import type { TextMessage, SensoryInput } from '#senses/index'
import type { ActivityEvent, ActivityEventHandler } from '#cognition/faculties/planning.engine/engine'
import { assembleMind, backfillEngineConfigs, resolveExecutiveInterval, type WillConfig } from '#stem/mind'
import { reviewIdentityCoherence as runCoherenceReview, type CoherenceInput, type CoherenceResult } from '#stem/guards/identity.coherence'
import { SessionLogger } from '#stem/tracts/session.logger'
import { fileLoggingEnabled } from '#stem/tracts/transport/stream.transport'
import type { PMASnapshot } from '#pma/index'
import type { ReconstructionFidelityReport } from '#pma/eval'
import type { ReplayMetadata, ReplayComparison } from '#core/replay'
import { DefaultScenario, type ScenarioConfig, type ScenarioValidationResult } from '#core/scenario'
import { ReplayController } from '#stem/tracts/replay.controller'
import { PMAController } from '#stem/tracts/pma.controller'
import { OutboxController } from '#stem/tracts/outbox.controller'
import { TransportController } from '#stem/tracts/transport.controller'
import { InboundQueue } from '#stem/tracts/inbound.queue'
import type { ExternalTransport } from '#stem/tracts/transport'
import { effectorController } from '#stem/tracts/effector.controller'
import type { PolicyArbiter } from '#stem/policy/arbiter'
import { externalSchemas } from '#agency/schemas/external'
import { inFlightOnRestore } from '#agency/restart'
import { buildEngineConfigEntities } from '#cognition/config.mirror.entities'
import type { EffectorDeclaration } from '#agency/types'
import { SensoryController } from '#stem/tracts/sensory.controller'
import { BiographyWriter } from '#stem/tracts/biography.writer'
import { HealthReporter } from '#stem/tracts/health.reporter'
import { mergeIdentity } from '#cognition/identity.entity'

// ── Types ─────────────────────────────────────────────────────

export type WillStatus = 'initializing' | 'active' | 'paused' | 'archived'

export type StateSnapshot = ReturnType<DefaultSimulation['stateManager']['snapshot']>

// outboxMessages + effectorInvocations: snapshots taken before any listener fires.
// All listeners receive the SAME snapshots so multiple SSE connections each
// get a complete copy rather than racing on the destructive drain methods.
export type TickListener = ( snapshot: SimulationState, tick: number, outboxMessages: OutboxMessage[], effectorInvocations: effectorInvocation[] ) => void

/**
 * Callback fired for every event published on the simulation's internal
 * DefaultEventBus (via subscribeAll). This gives the API layer access
 * to fine-grained semantic events: goal.formed, belief.updated,
 * emotion.spike, etc. — as published by individual engines.
 */
export type SimulationEventListener = (
  event:   SimulationEvent,
  context: SimulationContext,
) => void | Promise<void>

export interface CognitiveHealth {
  tick:         number
  status:       'healthy' | 'drifting' | 'degraded'
  overallScore: number
  beliefs: {
    total:         number
    avgConfidence: number
    highRisk:      number
  }
  affect: {
    valence:       number
    frustration:   number
    irritability:  number
    stress:        number
    isElevated:    boolean
  }
  goals: {
    total:  number
    active: number
  }
}

export interface WillSummary {
  id:         string
  status:     WillStatus
  tickCount:  number
  createdAt:  Date
  lastTickAt: Date | null
  anatomy:    WillConfig['anatomy']
  model:      NonNullable<WillConfig['llm']>['model']
}

// Re-export WillConfig so the API layer only imports from manager
export type { WillConfig, Anatomy, InitialGoal, WillIdentity } from './mind'
export type { ExecutiveOutputFull } from '#faculties/executive.engine'
export type { StorageAdapter } from '#core/abstracts'
export type { PMASnapshot, PMAIdentity, PMABelief, PMAGoal, PMAEmotionalBaseline, PMABehavioral } from '../pma'
export { PMADistiller, PMALoader, PMA_SCHEMA_VERSION } from '../pma'

// OUTBOX_TTL_TICKS lives in the OutboxController (R5-c); re-exported here so
// the public barrel (src/index.ts) keeps its existing import surface.
export { OUTBOX_TTL_TICKS } from '#stem/tracts/outbox.controller'

// ── Internal instance record ──────────────────────────────────

export interface WillInstance {
  simulation:                DefaultSimulation
  cognition:                 Cognition
  config:                    WillConfig
  status:                    WillStatus
  tickCount:                 number
  createdAt:                 Date
  lastTickAt:                Date | null
  tickListeners:             Set<TickListener>
  simulationEventListeners:  Set<SimulationEventListener>
  /** Unsubscribe function for the DefaultEventBus subscribeAll hook. */
  _eventBusUnsub:            (() => void) | null
  /** Queued outbound messages waiting to be drained by the delivery layer (SSE/webhook). */
  outbox:                    OutboxMessage[]
  /** External effector invocations pending host-system execution. Drained per tick by SSE. */
  pendingEffectorInvocations: effectorInvocation[]
  /** Bidirectional channel to the host peer (socket.io etc.). null = legacy outbox/SSE path. */
  transport:                 ExternalTransport | null
  /** Tick-stamped buffer for inbound envelopes; drained + applied at tick start. */
  inbound:                   InboundQueue
  /** Unsubscribe for the transport's onInbound hook. */
  _transportUnsub:           (() => void) | null
  /** NDJSON session log — one file per continuous run (start/resume → pause/archive). */
  sessionLogger:             SessionLogger | null
  /** Resolver that interrupts the tick-sleep when a high-priority event (e.g. incoming message) arrives. */
  _tickWakeFn:               (() => void) | null
  /** Timestamp when the Will was last paused — used to compute offline duration for the wake percept on resume. */
  pausedAt:                  Date | null
  /** Set of active LLM-chunk listeners (one per SSE connection). F3 word-level streaming. */
  chunkListeners:            Set<( chunk: string ) => void>
  /**
   * Per-entity chunk listeners registered by the SSE/WS layer.
   * Keyed by entityId — only the listener(s) for the active conversation receive chunks.
   * Populated by `addSensoryChunkListener()`.
   */
  sensoryChunkListeners:      Map<string, Set<( chunk: string ) => void>>
  /** Running accumulator for the behavioral fingerprint written at session end. */
  _sessionBehavior: {
    startTick:       number
    valenceMin:      number
    valenceMax:      number
    arousalMin:      number
    arousalMax:      number
    confidenceSum:   number
    confidenceCount: number
    goalsTotal:      number
    goalsCompleted:  number
    // ── Emotional biography tracking ────────────────────────
    /** Previous tick's valence — used for spike delta calculation. */
    prevValence:         number
    /** Previous tick's arousal — used for spike delta calculation. */
    prevArousal:         number
    /** Valence at session open — for arc reporting. */
    valenceStart:        number
    /** Arousal at session open — for arc reporting. */
    arousalStart:        number
    /** Valence at last tick — for arc reporting. */
    valenceEnd:          number
    /** Arousal at last tick — for arc reporting. */
    arousalEnd:          number
    /** Consecutive ticks with arousal > 0.70 (high activation). */
    highArousalStreak:   number
    /** Completed sustained high-arousal episodes this session. */
    sustainedEpisodes:   number
    /** Total spike events (valence + arousal) this session. */
    spikeCount:          number
    /** Sum of all tick valences — for dominant mood computation. */
    avgValenceSum:       number
    /** Number of valence samples. */
    avgValenceCount:     number
    /** Actions taken in ticks where executive confidence < 0.35. */
    impulsiveActionCount: number
  } | null
}

// ── Manager ───────────────────────────────────────────────────

export class WillStem {
  private readonly _wills            = new Map<string, WillInstance>()
  // Subsystems extracted to their own collaborators (R5).
  private readonly _replay           = new ReplayController()   // R5-a: record/replay
  private readonly _pma              = new PMAController()       // R5-b: distill/load/eval
  private readonly _outbox           = new OutboxController()    // R5-c: messaging/outbox
  private readonly _effector          = new effectorController()   // R5-d: external effectors
  private readonly _sensory          = new SensoryController()   // R5-e: senses I/O + chunk streaming
  private readonly _transport        = new TransportController()  // External transport ↔ tick boundary
  private readonly _biography         = new BiographyWriter()     // R5-f: session-biography writers
  private readonly _health            = new HealthReporter()      // R5-f2: cognitive-health view

  // ── Create ─────────────────────────────────────────────────

  /**
   * Assemble a new Will and start its autonomous tick loop.
   * Returns the Will ID (same as config.id) once the loop is running.
   */
  async createWill( config: WillConfig, startPaused = false ): Promise<string> {
    if( this._wills.has( config.id ) )
      throw new Error(`Will already exists: ${config.id}`)

    const
    { simulation, cognition, outbox } = assembleMind( config.id, config )

    // ── Snapshot restore ─────────────────────────────────────
    // If persistentMemory is enabled (snapshotStorage configured), attempt to
    // load the most recent persisted snapshot and restore entity state.
    // This brings beliefs, goals, episodic memories, narrative, and bonds
    // back to life across wills restarts without re-running the simulation.
    //
    // NOTE: Metrics are NOT restored — they rebuild naturally from tick 1.
    if( config.persistentMemory || config.snapshotStorage )
      try {
        const previousState = await simulation.snapshotManager.loadLatestFromStorage()
        if( previousState ){
          // Work that was in flight when the mind slept does not resume — see
          // agency/restart.ts. Dropped BEFORE restore so it never enters live
          // state at all, rather than being swept on some later tick.
          const inFlight = inFlightOnRestore( previousState.entities )
          for( const id of inFlight ) previousState.entities.delete( id )

          simulation.stateManager.restore( previousState, { entities: true, metrics: false } )

          // TIME MUST NOT GO BACKWARDS.
          //
          // Entities come back stamped with the tick they were written at, and
          // the orchestrator overwrites the StateManager's tick from the CLOCK
          // every tick (`_clock.tick()` → `updateClock`) — so restoring the
          // manager's tick alone is undone immediately. The clock is the source
          // of truth and has to resume too.
          //
          // Without this, every `tick - stampedTick` in the codebase computed a
          // negative age. Measured: an awaiting intent read `-589 ticks`, so it
          // could never time out, and the selector's staleness decay inverted
          // into amplification (`1 - (-39 × 0.5)` = 20.6×) — a 0.47 incumbent
          // scoring 9.74, unpreemptable, holding the channel against every other
          // contact indefinitely and across restarts. It also means tick-stamped
          // entity ids (`affordance-${tick}-…`, `agency-outcome-${tick}-…`) stop
          // colliding with a previous session's.
          simulation.clock.setTick( previousState.tick )

          // The restore above replaced the entity map wholesale, including the
          // engine-config mirror `assembleMind` had just seeded — so a Will woke
          // with whatever config it FIRST hibernated under, and every tunable
          // added since was unreachable to it. Restored values win; only params it
          // has never seen are added.
          backfillEngineConfigs( simulation, buildEngineConfigEntities( config, resolveExecutiveInterval( config ) ) )

          // The same wholesale replacement takes `identity-self` — so the name
          // `_seedIdentity` wrote moments ago is replaced by whatever the snapshot
          // carries, which for any mind hibernated before the merging writer
          // existed is NO NAME AT ALL.
          //
          // Caught only by booting: making every writer merge is necessary and was
          // not sufficient, because restore is not a writer — it is the whole map
          // arriving at once, and it lands between `_seedIdentity` and `loadPMA`.
          // A live Will woke from a repaired build and still told her operator "my
          // self-model says I'm Will".
          //
          // ONLY the name is re-asserted. Everything else on this entity — prompt,
          // values, traits, traitStats, style — is the mind's own accumulated
          // self-knowledge and must come from the snapshot, not from boot config.
          // The name is the one field the container supplies and the tenant never
          // learns, which is exactly why it is the one field a restore may not eat.
          if( config.name ){
            const restored = mergeIdentity( simulation.stateManager, { name: config.name } )
            if( restored.length )
              logger.info(`[WillStem] identity-self: re-asserted name '${config.name}' after restore`)
          }

          logger.info(
            `[WillStem] Restored snapshot for ${config.id} — ${previousState.entities.size} entities loaded, ` +
            `resuming at tick ${previousState.tick}` +
            ( inFlight.length ? ` (dropped ${inFlight.length} in-flight)` : '')
          )
        }
      }
      catch( err ){ logger.warn(`[WillStem] Snapshot restore failed for ${config.id} — starting fresh:`, err ) }

    const
    dataDir       = process.env.WILL_DATA_DIR ?? './data',
    sessionLogger = new SessionLogger( config.id, dataDir, {
      fileLogging: fileLoggingEnabled() && !config.testMode,
    } ),
    instance: WillInstance = {
      simulation,
      cognition,
      config,
      status:                   'initializing',
      tickCount:                0,
      createdAt:                new Date(),
      lastTickAt:               null,
      tickListeners:            new Set(),
      simulationEventListeners: new Set(),
      _eventBusUnsub:              null,
      outbox,
      pendingEffectorInvocations: [],
      transport:                 config.transport ?? null,
      inbound:                   new InboundQueue(),
      _transportUnsub:           null,
      sessionLogger,
      _tickWakeFn:               null,
      pausedAt:                  null,
      chunkListeners:            new Set(),
      sensoryChunkListeners:      new Map(),
      _sessionBehavior: {
        startTick: 0, valenceMin: 1, valenceMax: -1,
        arousalMin: 1, arousalMax: 0,
        confidenceSum: 0, confidenceCount: 0,
        goalsTotal: 0, goalsCompleted: 0,
        prevValence: 0, prevArousal: 0,
        valenceStart: 0, arousalStart: 0,
        valenceEnd: 0, arousalEnd: 0,
        highArousalStreak: 0, sustainedEpisodes: 0,
        spikeCount: 0, avgValenceSum: 0, avgValenceCount: 0,
        impulsiveActionCount: 0
      },
    }

    // Attach session logger to all cognitive components that produce loggable data
    cognition.executiveEngine.attachSessionLogger( sessionLogger )
    cognition.semanticIntegrator.attachSessionLogger( sessionLogger )
    cognition.motorSchemaExecutor.attachSessionLogger( sessionLogger )
    cognition.outboxWriter.attachSessionLogger( sessionLogger )
    cognition.planningEngine.attachSessionLogger( sessionLogger )
    cognition.goalManager.attachSessionLogger( sessionLogger )

    // Bridge telemetry onto the configured transport (StreamTransport / SocketIo /
    // Loopback) as 'session_log' / 'token_report' envelopes. No-op when no
    // transport is set; the dev file mirrors still happen inside the producers.
    sessionLogger.attachEmit( record => this._transport.emitSessionLog( instance, record ) )
    cognition.tokenTracker.onRecord( record => this._transport.emitTokenReport( instance, record ) )

    sessionLogger.write({
      type:       'session.start',
      willId:     config.id,
      willName:   config.name,
      anatomy:    config.anatomy ?? 'mind',
      model:      config.llm?.model ?? null,
      startedAt:  new Date().toISOString(),
    })

    // Subscribe to ALL simulation events via DefaultEventBus.subscribeAll().
    // This lets callers (backend SSE, webhook delivery) observe fine-grained
    // semantic events (goal.formed, belief.updated, emotion.spike, etc.)
    // that engines publish during their tick execution.
    instance._eventBusUnsub = simulation.eventBus.subscribeAll( ( event, context ) => {
      // Log every semantic event to the session file
      instance.sessionLogger?.write({
        type:    'event',
        tick:    ( event as any ).tick,
        evtType: event.type,
        source:  event.source,
        payload: event.payload,
      })

      // Buffer host-owned effector invocations for delivery. The MotorSchemaExecutor
      // emits `agency.invocation` (intentId = correlation handle) when it holds an
      // external action 'awaiting'; the host executes it and acks → confirmExecution.
      if( event.type === 'agency.invocation')
        this._effector.bufferInvocation( instance, event.payload as Record<string, unknown> )

      if( instance.simulationEventListeners.size === 0 ) return

      for( const fn of instance.simulationEventListeners ){
        try { void fn( event, context ) }
        catch( err ){ logger.error(`[WillStem] sim-event listener error (${config.id}):`, err ) }
      }
    })

    this._wills.set( config.id, instance )

    // Wire the external transport's inbound stream onto the tick-stamped queue.
    // No-op when no transport is configured (legacy outbox/SSE path).
    this._transport.attach( instance )

    // Set initial status before the tick loop starts so the loop's first
    // iteration sees the correct state and skips ticking if paused.
    instance.status = startPaused ? 'paused' : 'active'
    
    this._runTickLoop( config.id ).catch( err => {
      logger.error(`[WillStem] tick loop crashed (${config.id}):`, err )

      const inst = this._wills.get( config.id )
      if( inst ) inst.status = 'archived'
    })

    return config.id
  }

  // ── Tick listener ──────────────────────────────────────────

  /**
   * Register a callback fired after every tick.
   * Use this to attach logging, metrics, or API push in the caller.
   * Returns an unsubscribe function.
   */
  addTickListener( id: string, fn: TickListener ): () => void {
    const instance = this._get( id )

    instance.tickListeners.add( fn )
    return () => instance.tickListeners.delete( fn )
  }

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
  addSimulationEventListener( id: string, fn: SimulationEventListener ): () => void {
    const instance = this._get( id )
    instance.simulationEventListeners.add( fn )

    return () => instance.simulationEventListeners.delete( fn )
  }

  // ── Telemetry ────────────────────────────────────────────────
  //
  // Session logs + the token/cost ledger flow out as `session_log` / `token_report`
  // envelopes on the Will's transport. To consume them, pass a StreamTransport as
  // `config.transport` and subscribe on it directly:
  //
  //   const transport = new StreamTransport(willId)
  //   transport.on('token_report', ({ report }) => meter.charge(report.costUsd))
  //   await stem.createWill({ ...config, transport })

  // ── F3: LLM streaming chunk listeners ────────────────────────

  /**
   * Subscribe to real-time LLM token chunks for this Will.
   * The callback fires for each text token during executive LLM generation.
   * Returns an unsubscribe function — call it when the SSE connection closes.
   */
  addChunkListener( id: string, fn: ( chunk: string ) => void ): () => void {
    return this._sensory.addChunkListener( this._get( id ), fn )
  }

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
  addSensoryChunkListener(
    id: string,
    entityId: string,
    fn: ( chunk: string ) => void,
  ): () => void {
    return this._sensory.addSensoryChunkListener( this._get( id ), entityId, fn )
  }

  /**
   * Subscribe to plan-activity events for a specific requesting entity.
   *
   * Delegates to `PlanningEngine.addActivityListener()`.  Events are emitted
   * for plan lifecycle transitions that were triggered by a message or request
   * from `entityId` (i.e. `requestingEntityId === entityId`).
   *
   * @returns Unsubscribe function.
   */
  addActivityListener(
    id:       string,
    entityId: string,
    fn:       ActivityEventHandler,
  ): () => void {
    const instance = this._get( id )
    return instance.cognition.planningEngine.addActivityListener( entityId, fn )
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pauseWill( id: string ): void {
    const instance = this._get( id )
    if( instance.status !== 'active')
      throw new Error(`Cannot pause Will with status '${instance.status}': ${id}`)

    // Flush all in-memory episode mutations to state entities, then force a
    // disk persist so the next session cold-starts with every episode intact.
    // Fire-and-forget: pauseWill is sync; the persist completes asynchronously.
    const flushCmds = instance.cognition.episodicConsolidator.flushToState()
    if( flushCmds.set?.length )
      instance.simulation.stateManager.applyCommands( flushCmds )
    const pauseState = instance.simulation.stateManager.snapshot()
    instance.simulation.snapshotManager.persistNow( pauseState )
      .catch( err => logger.error(`[WillStem] snapshot persist failed on pause (${id}):`, err ))

    // The vector index lives outside the snapshot and only ever persisted itself from
    // a debounce timer nothing awaited — so it died with the process, and every
    // restart cold-started with an EMPTY index no matter how much was consolidated.
    instance.cognition.vectorMemory?.persist()
      .catch( ( err: unknown ) => logger.error(`[WillStem] vector index persist failed on pause (${id}):`, err ))

    this._biography.writeSessionSummary( instance )
    this._biography.writeEmotionalBiographySummary( instance )
    instance.sessionLogger?.close()
    instance.sessionLogger = null
    instance.pausedAt      = new Date()
    instance.status        = 'paused'
  }

  resumeWill( id: string ): void {
    const instance = this._get( id )
    if( instance.status !== 'paused')
      throw new Error(`Cannot resume Will with status '${instance.status}': ${id}`)

    const dataDir     = process.env.WILL_DATA_DIR ?? './data'
    const newLogger   = new SessionLogger( id, dataDir, {
      fileLogging: fileLoggingEnabled() && !instance.config.testMode,
    } )
    newLogger.attachEmit( record => this._transport.emitSessionLog( instance, record ) )

    instance.sessionLogger = newLogger

    instance.cognition.executiveEngine.attachSessionLogger( newLogger )
    instance.cognition.semanticIntegrator.attachSessionLogger( newLogger )
    instance.cognition.motorSchemaExecutor.attachSessionLogger( newLogger )
    instance.cognition.outboxWriter.attachSessionLogger( newLogger )
    instance.cognition.planningEngine.attachSessionLogger( newLogger )
    instance.cognition.goalManager.attachSessionLogger( newLogger )

    newLogger.write({
      type:      'session.start',
      willId:    id,
      willName:  instance.config.name,
      resumedAt: new Date().toISOString(),
      tick:      instance.tickCount,
    })

    // ── F2: Wake percept ──────────────────────────────────────
    // Inject a percept so the Will knows it was offline and for how long.
    // This surfaces in the Exteroception → executive context pipeline within
    // the first few ticks after resume, giving the Will situational awareness.
    if( instance.pausedAt ){
      const offlineMs   = Date.now() - instance.pausedAt.getTime()
      const offlineMins = Math.round( offlineMs / 60_000 )
      const duration    = offlineMins < 2
        ? 'a moment'
        : offlineMins < 60
          ? `${offlineMins} minutes`
          : `${Math.round( offlineMins / 60 )} hours`

      instance.simulation.stateManager.setEntity({
        id:        'percept-wake-event',
        type:      'percept',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          category:  'system',
          summary:   `I was offline for ${duration}. I am now online again.`,
          salience:  0.75,
          source:    'system',
          offlineMs,
        },
      })

      instance.pausedAt = null
    }

    // Reset behavioral accumulator for the new session segment
    instance._sessionBehavior = {
      startTick: instance.tickCount, valenceMin: 1, valenceMax: -1,
      arousalMin: 1, arousalMax: 0,
      confidenceSum: 0, confidenceCount: 0,
      goalsTotal: 0, goalsCompleted: 0,
      prevValence: 0, prevArousal: 0,
      valenceStart: 0, arousalStart: 0,
      valenceEnd: 0, arousalEnd: 0,
      highArousalStreak: 0, sustainedEpisodes: 0,
      spikeCount: 0, avgValenceSum: 0, avgValenceCount: 0,
      impulsiveActionCount: 0,
    }

    instance.status = 'active'
  }

  /**
   * Stop a Will permanently. The tick loop exits after the current tick.
   * The instance remains in the map for state inspection.
   */
  async archiveWill( id: string ): Promise<void> {
    const instance = this._get( id )

    this._biography.writeSessionSummary( instance )
    this._biography.writeEmotionalBiographySummary( instance )
    instance.sessionLogger?.close()
    instance.sessionLogger = null
    instance.status = 'archived'

    // Clean up the eventBus subscription
    instance._eventBusUnsub?.()
    instance._eventBusUnsub = null

    // Tear down the external transport + discard un-applied inbound.
    this._transport.detach( instance )

    // Give the tick loop one tick length to exit cleanly
    const wait = instance.config.tickIntervalMs ?? 1000
    await _sleep( wait + 200 )

    // Flush all in-memory episode mutations to state entities, then await a
    // final disk persist.  The tick loop has exited by now so no concurrent
    // state mutations can race with the flush.
    const flushCmds = instance.cognition.episodicConsolidator.flushToState()
    if( flushCmds.set?.length )
      instance.simulation.stateManager.applyCommands( flushCmds )
    const archiveState = instance.simulation.stateManager.snapshot()
    await instance.simulation.snapshotManager.persistNow( archiveState )

    // …and the vector index, which is NOT part of that snapshot. Awaited here (unlike
    // the pause path) because the process usually exits straight after this: a
    // fire-and-forget write would simply be lost, which is exactly how a mind ended a
    // session having consolidated episodes and left a 198-byte index on disk.
    // Indexing runs in the background (it must not stall the tick loop), so drain it
    // first — otherwise the last episodes consolidated are still mid-embed when the
    // index is written and are absent from the file this session leaves behind.
    await instance.cognition.episodicConsolidator.flushIndexing()
    await instance.cognition.vectorMemory?.persist()
  }

  // Session-biography writers (behavioral + emotional) extracted to
  // BiographyWriter (R5-f); WillStem calls them from pause/archive and the
  // tick loop's emotion-spike detection.

  // ── Event injection ────────────────────────────────────────

  /**
   * Inject a percept or external event into the Will's world.
   * The event is picked up by perceptual engines on the next tick.
   */
  injectEvent( id: string, event: { type: string; payload: Record<string, unknown> } ): void {
    this._sensory.injectEvent( this._get( id ), event )
  }

  // ── State inspection ───────────────────────────────────────

  getWillState( id: string ): SimulationState {
    return this._get( id ).simulation.stateManager.snapshot()
  }

  getWillCognition( id: string ): Cognition {
    return this._get( id ).cognition
  }

  /**
   * Returns the active session log file path for this Will, or null if
   * the Will is paused/archived (no active session).
   */
  getSessionLogPath( id: string ): string | null {
    const instance = this._wills.get( id )
    return instance?.sessionLogger?.filePath ?? null
  }

  /**
   * Attach a world interface to a running Will's action executor.
   * Intended for dev use only — call from runner.ts after createWill().
   * In production the Will operates without a server-side world;
   * host-owned effectors are delivered via `agency.invocation` events.
   */
  attachWorld( _id: string, _world: WorldInterface ): void {
    // No-op since the agency cutover: the MotorSchemaExecutor owns enaction. Internal
    // stances run as agency primitives; world/host-owned schemas route out via the
    // `agency.invocation` event (reconciled by reconcileInvocation). Kept for the dev
    // runner's call-site compatibility.
  }

  /**
   * Returns the most recent executive reasoning output for a Will.
   * Null if the Will hasn't completed its first executive cycle yet.
   */
  getLatestExecutiveOutput( id: string ): ExecutiveOutputFull | null {
    return this._get( id ).cognition.executiveEngine.latestOutput
  }

  /**
   * Returns a composite health summary for a running Will.
   * Intended for developer dashboards and platform monitoring.
   *
   * Status bands:
   *   healthy  — normal operating range
   *   drifting — one or more indicators approaching problematic thresholds
   *   degraded — one or more indicators clearly outside healthy range
   */
  getCognitiveHealth( id: string ): CognitiveHealth {
    return this._health.report( this._get( id ) )
  }

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
  loadPMA( id: string, pma: PMASnapshot ): void {
    this._pma.load( id, this._get( id ), pma )
  }

  // ── Replay ─────────────────────────────────────────────────

  // Record/replay delegates to ReplayController (R5-a). `_get(id)` here both
  // validates the Will exists and supplies the instance the recorder hooks into.
  startReplay( id: string ): string {
    return this._replay.start( id, this._get( id ) )
  }

  stopReplay( id: string ): Promise<ReplayMetadata> {
    return this._replay.stop( id )
  }

  getReplayMeta( id: string, runId: string ): ReplayMetadata | null {
    return this._replay.getMeta( id, runId )
  }

  listReplays( id: string ): ReplayMetadata[] {
    return this._replay.list( id )
  }

  compareReplays( id: string, runId1: string, runId2: string ): Promise<ReplayComparison> {
    return this._replay.compare( id, runId1, runId2 )
  }

  // ── Scenario ────────────────────────────────────────────────

  async loadScenario( id: string, cfg: ScenarioConfig ): Promise<ScenarioValidationResult> {
    const instance = this._get( id )
    const scenario = new DefaultScenario( cfg )
    const result   = scenario.validate()
    if( result.isValid )
      await instance.simulation.loadScenario( scenario )
    return result
  }

  // ── PMA Eval ────────────────────────────────────────────────

  runPMAEval(
    id:   string,
    opts: { behavioral?: boolean; vsOriginal?: boolean } = {}
  ): Promise<ReconstructionFidelityReport> {
    return this._pma.runEval( id, this._get( id ), opts )
  }

  distillPMA( id: string ): PMASnapshot {
    return this._pma.distill( id, this._get( id ) )
  }

  /**
   * Optional semantic coherence check for an operator-supplied persona (identity
   * guardrail Phase 2). One LLM review flagging contradictions with the
   * architecture grounding, false-capability claims, and semantic injection the
   * deterministic guard can't catch. Advisory + fail-open (an LLM error returns
   * `ran: false`, never blocks). Intended for the API to call pre-creation.
   */
  reviewIdentityCoherence(
    input: CoherenceInput,
    opts?: { willId?: string },
  ): Promise<CoherenceResult> {
    return runCoherenceReview( input, opts )
  }

  /**
   * Reset affect metrics to a neutral baseline without touching memory.
   * Intended as a recovery path when a Will is clearly drifting or degraded.
   * Does NOT wipe beliefs, goals, episodes, or the executive's reasoning context.
   */
  recalibrateWill( id: string ): void {
    const
    instance = this._get( id ),
    sm       = instance.simulation.stateManager,

    resetMetrics: Array<[ string, number ]> = [
      [ 'emotion.frustration',  0.0 ],
      [ 'emotion.irritability', 0.0 ],
      [ 'stress.load',          0.0 ],
      [ 'affect.arousal',       0.35 ],
      [ 'affect.valence',       0.10 ],
      [ 'affect.dominant',      0.50 ],
    ]

    for( const [ key, val ] of resetMetrics )
      sm.setMetric( key, val )

    instance.sessionLogger?.write({
      type:         'recalibrate',
      tick:         instance.tickCount,
      resetMetrics: Object.fromEntries( resetMetrics ),
    })

    logger.info(`[WillStem] recalibrated affect for Will ${id} at tick ${instance.tickCount}`)
  }

  /**
   * Returns true if the Will is in the registry (regardless of status).
   */
  isRunning( id: string ): boolean {
    try {
      this._get( id )
      return true
    }
    catch { return false }
  }

  /**
   * Update the set of allowed communication effectors at runtime.
   * Routes to `AccessGrants.setAllowed()` (the permission / sense gate).
   */
  // ── External effectors (10.1 / 10.3) ─────────────────────────────────────
  // Delegates to effectorController (R5-d). `_get(id)` validates the Will exists
  // and supplies the WillInstance; the effector ops touch only instance fields.

  /** Update the set of allowed communication effectors at runtime. */
  setAllowedEffectors( id: string, effectors: string[] | null ): void {
    this._effector.setAllowed( this._get( id ), effectors )
  }

  /**
   * Register a host effector on a *running* Will (post-create `.effector()`).
   * Builds its external schema and adds it to the live repertoire so the Will
   * can actually perceive + enact it — a grant alone only gates; without the
   * schema the ability could never be afforded. Comms names are no-ops here
   * (governed by AccessGrants). This is a runtime mutation, like a grant change;
   * the deterministic/replayable path is declaring effectors at create time.
   */
  registerEffector( id: string, declaration: EffectorDeclaration ): void {
    const repertoire = this._get( id ).cognition.schemaRepertoire
    for( const schema of externalSchemas( [ declaration ] ) )
      repertoire.registerExternal( schema )
  }

  /**
   * Called by the host/WorldInterface after executing a host-owned effector.
   * `invocationId` is the correlation handle the host echoed (the awaiting
   * `agency.intent` id). Reconciles it into an `agency.outcome` the ReafferenceEngine
   * consumes — learning the result, freeing the intent, and advancing the plan it
   * served (if any). See effectorController.confirmExecution.
   */
  confirmEffectorExecution(
    id:           string,
    invocationId: string,
    result: {
      success:     boolean
      description: string
      metrics?:    Record<string, number>
    },
  ): void {
    this._effector.confirmExecution( this._get( id ), invocationId, result )
  }

  /**
   * Resolve a policy escalation the Will raised (POLICY_REAFFERENCE P4).
   * `approved` dispatches the held invocation to the world; otherwise it is
   * refused. Applied at the next tick boundary. `invocationId` is the awaiting
   * `agency.intent` id the escalation ask referenced.
   */
  resolveEscalation( id: string, invocationId: string, approved: boolean ): void {
    this._effector.resolveEscalation( this._get( id ), invocationId, approved )
  }


  /**
   * Install the Policy Decision Point consulted before every host-owned
   * effector invocation is handed to the world (POLICY_REAFFERENCE P0).
   * Passing `null` restores the no-op default — a stem with no arbiter
   * installed runs byte-identical to one built before the policy seam existed.
   *
   * SCOPE: one arbiter per `WillStem`, not per Will — `effectorController` is a
   * single instance shared by every Will this stem hosts (`setAllowed`,
   * `resolveEscalation` etc. take a resolved instance; this does not, because
   * there is only one). `Will.create()` / `Will.wake()` each allocate a fresh
   * `WillStem`, so on that (recommended) path this is per-Will in practice. A
   * host running several Wills on ONE shared `WillStem` — e.g. a multi-tenant
   * service holding many users' Wills in one process — installs ONE arbiter
   * for all of them; branch on `invocation.willId` inside `evaluate()` if
   * that's your host, the same way `PolicyVerdictRecord`/`PolicyVerdictSource`
   * are already keyed per-Will for recording and replay.
   */
  setArbiter( arbiter: PolicyArbiter | null ): void {
    this._effector.setArbiter( arbiter )
  }

  // ── Messaging / outbox (11.1) ────────────────────────────────────────────
  // Delegates to OutboxController (R5-c). `_get(id)` validates the Will exists
  // and supplies the WillInstance; the outbox ops touch only instance fields.

  /**
   * Confirm a message was received by the target entity. Writes a
   * message.delivery percept ("ear hears the word you spoke") and updates the
   * conversation.sent entity that tracks the outbox message.
   */
  confirmMessageDelivery( id: string, messageId: string, delivered: boolean ): void {
    this._outbox.confirmDelivery( this._get( id ), messageId, delivered )
  }

  /**
   * Drain all queued outbound messages from the Will's outbox.
   * Called by the SSE/webhook delivery layer to retrieve messages.
   */
  drainOutbox( id: string ): OutboxMessage[] {
    return this._outbox.drain( this._get( id ) )
  }

  /** Peek at outbox without draining it. */
  peekOutbox( id: string ): readonly OutboxMessage[] {
    return this._outbox.peek( this._get( id ) )
  }

  /** Re-queue messages that were drained but not successfully delivered. */
  requeueToOutbox( id: string, messages: OutboxMessage[] ): void {
    this._outbox.requeue( this._get( id ), messages )
  }

  /**
   * Drain all pending external effector invocations.
   * Called by the SSE delivery layer each tick after drainOutbox.
   */
  drainEffectorInvocations( id: string ): effectorInvocation[] {
    return this._effector.drain( this._get( id ) )
  }

  // ── Senses API ─────────────────────────────────────────────────

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
  async ingestText( id: string, input: TextMessage ): Promise<void> {
    await this._sensory.ingestText( this._get( id ), input )
  }

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
  endConversation( id: string, entityId: string ): void {
    this._get( id ).cognition.auditionEngine.endSession( entityId )
  }

  /**
   * Return the list of active conversation entityIds for a Will.
   * Each entry is an entityId that currently has a live AuditionEngine facet.
   */
  activeConversationSessions( id: string ): string[] {
    return this._get( id ).cognition.auditionEngine.activeSessions()
  }

  /**
   * Return registration status for all five sense engines.
   * Shell engines report status: 'shell'; active engines report 'active'.
   */
  getSenseEngineStatus( id: string ): Array<{ domain: string; status: string }> {
    const cog = this._get( id ).cognition
    return [
      cog.auditionEngine,
      cog.visionEngine,
      cog.somatosensationEngine,
      cog.olfactionEngine,
      cog.gustationEngine,
    ].map( engine => {
      const snap = engine.snapshot()
      return {
        domain: ( snap.domain as string ) ?? 'unknown',
        status: ( snap.status as string ) ?? 'active',
        ...(( snap.activeSessions !== undefined ) ? { activeSessions: snap.activeSessions, sessions: snap.sessions } : {}),
      }
    })
  }

  /**
   * Route a raw SensoryInput to the appropriate sense engine by domain.
   * Used by the debug `POST /senses/:domain/ingest` route.
   * Audition inputs are gated by the 'listen' effector like ingestText().
   */
  async ingestSensory( id: string, domain: string, input: SensoryInput ): Promise<void> {
    await this._sensory.ingestSensory( this._get( id ), domain, input )
  }

  listWills(): WillSummary[] {
    return Array.from( this._wills.entries() ).map( ([ id, inst ]) => ({
      id,
      status:     inst.status,
      tickCount:  inst.tickCount,
      createdAt:  inst.createdAt,
      lastTickAt: inst.lastTickAt,
      anatomy:    inst.config.anatomy ?? 'mind',
      model:      inst.config.llm?.model,
    }))
  }

  // ── Tick loop (internal) ───────────────────────────────────

  private async _runTickLoop( id: string ): Promise<void> {
    const
    instance    = this._wills.get( id )!,
    tickMs      = instance.config.tickIntervalMs ?? 1000,
    maxTicks    = instance.config.maxTicks ?? 0

    while( instance.status !== 'archived'){
      // Pause: spin-wait at low cost until resumed or archived
      if( instance.status === 'paused'){
        await _sleep( 100 )
        continue
      }

      const start = Date.now()

      // Apply all inbound external I/O at a fixed point BEFORE the step, stamped
      // to this tick. Result-acks mutate state synchronously here so the step
      // sees them; messages/percepts are fire-and-forget (async reasoning is
      // recorded/replayed by the LLM layer, not the deterministic core).
      this._transport.applyInbound( instance, instance.tickCount, {
        effector: this._effector,
        outbox:  this._outbox,
        sensory: this._sensory,
      } )

      // Apply policy refusals queued during the previous step's flush, at the
      // same boundary and for the same reason (POLICY_REAFFERENCE P1): a denial
      // reconciles as a host-rejection-shaped failure ack the step then sees.
      this._effector.applyPolicyOutcomes( instance )

      await instance.simulation.step( 1 )

      instance.tickCount++
      instance.lastTickAt = new Date()

      // Fire tick listeners with a fresh snapshot.
      // Outbox is snapshotted BEFORE notifying any listener so all active SSE
      // connections receive the same set of outbound messages.  The outbox is
      // cleared here; each listener that fails to write may call requeueToOutbox()
      // to preserve messages for the next tick.
      const
      snapshot               = instance.simulation.stateManager.snapshot(),
      outboxSnapshot         = instance.outbox.splice( 0 ),
      invocationsSnapshot    = instance.pendingEffectorInvocations.splice( 0 )

      for( const msg of outboxSnapshot )
        if( msg.createdAtTick === 0 ) msg.createdAtTick = instance.tickCount

      // Bridge drained outbox messages + effector invocations onto the transport
      // (2.3 / 2.4). No-op when no transport (legacy SSE tick-listener path).
      // Facet replies are NOT in the outbox when a transport is present — they go
      // via the 2.1 reply fast-path — so emitOutbox carries only master/action messages.
      this._transport.emitOutbox( instance, outboxSnapshot )
      this._transport.emitInvocations( instance, invocationsSnapshot )

      if( instance.tickListeners.size > 0 )
        for( const fn of instance.tickListeners ){
          try { fn( snapshot, instance.tickCount, outboxSnapshot, invocationsSnapshot ) }
          catch( err ){ logger.error(`[WillStem] tick listener error (${id}):`, err ) }
        }

      // Session log — per-tick metrics snapshot.
      // MUST_LOG_METRICS: canonical list of signals required for PMA + behavioral analysis.
      // If any of these are absent from the tick log, the engine responsible is not pushing
      // the metric or is using a different key — investigate the engine's metrics push block.
      //
      // Affective:       affect.valence, affect.arousal, affect.dominance, intero.mood
      // Homeostasis:     energy.level, sleep.pressure, stress.load
      // Memory:          memory.episodic_total, memory.beliefs_total
      // Goals:           goals.active, goals.avg_progress, goals.top_priority
      // Executive:       executive.confidence, executive.epistemic_uncertainty, executive.action_count, executive.action_diversity
      // Self-model:      self_model.version
      // Executor:        executor.success_rate, executor.actions_this_tick
      if( instance.sessionLogger ){
        const metrics: Record<string, number> = {}
        for( const [ k, v ] of snapshot.metrics ) metrics[ k ] = v

        const entityCounts: Record<string, number> = {}
        for( const e of snapshot.entities.values() )
          entityCounts[ e.type ] = ( entityCounts[ e.type ] ?? 0 ) + 1

        instance.sessionLogger.write({
          type:        'tick',
          tick:        instance.tickCount,
          durationMs:  instance.lastTickAt ? Date.now() - instance.lastTickAt.getTime() : 0,
          outboxSize:  instance.outbox.length,
          entityCounts,
          metrics
        })
      }

      // Behavioral fingerprint + emotional biography accumulator.
      // Updated every tick so session.end has a complete picture of emotional range,
      // executive confidence, goal outcomes, and significant emotional events.
      if( instance._sessionBehavior ){
        const sb = instance._sessionBehavior
        const v = snapshot.metrics.get('affect.valence') ?? 0
        const a = snapshot.metrics.get('affect.arousal') ?? 0
        const c = snapshot.metrics.get('executive.confidence')

        // ── Range tracking ──────────────────────────────────────
        if( v < sb.valenceMin ) sb.valenceMin = v
        if( v > sb.valenceMax ) sb.valenceMax = v
        if( a < sb.arousalMin ) sb.arousalMin = a
        if( a > sb.arousalMax ) sb.arousalMax = a
        if( c !== undefined ){ sb.confidenceSum += c; sb.confidenceCount++ }
        const gt = snapshot.metrics.get('goals.total')
        const gc = snapshot.metrics.get('goals.completed_total')
        if( gt !== undefined ) sb.goalsTotal     = gt
        if( gc !== undefined ) sb.goalsCompleted = gc

        // ── Emotional biography: seed arc start on first sample ─
        if( sb.avgValenceCount === 0 ){
          sb.valenceStart = v
          sb.arousalStart = a
          sb.prevValence  = v
          sb.prevArousal  = a
        }

        sb.avgValenceSum   += v
        sb.avgValenceCount ++
        sb.valenceEnd = v
        sb.arousalEnd = a

        // ── Spike detection ─────────────────────────────────────
        // Write a real-time entry to emotional_biography.jsonl for each spike
        // so PMA can pin emotional events to specific ticks without scanning
        // the full session log.  Thresholds: |Δv| ≥ 0.12, |Δa| ≥ 0.18.
        const dv = v - sb.prevValence
        const da = a - sb.prevArousal

        if( Math.abs( dv ) >= 0.12 ){
          sb.spikeCount++
          this._biography.writeEmotionalEvent( instance, 'spike', {
            dimension: 'valence', from: sb.prevValence, to: v, delta: dv,
            tick: instance.tickCount,
          })
        }

        if( Math.abs( da ) >= 0.18 ){
          sb.spikeCount++
          this._biography.writeEmotionalEvent( instance, 'spike', {
            dimension: 'arousal', from: sb.prevArousal, to: a, delta: da,
            tick: instance.tickCount,
          })
        }

        // ── Sustained high-arousal episodes ─────────────────────
        // An episode completes when the streak exits (arousal drops back below 0.7)
        // after ≥ 10 consecutive ticks.  Session-end flush handles open streaks.
        if( a > 0.70 ){
          sb.highArousalStreak++
        } else {
          if( sb.highArousalStreak >= 10 ){
            sb.sustainedEpisodes++
            this._biography.writeEmotionalEvent( instance, 'sustained_high_arousal', {
              startTick:     instance.tickCount - sb.highArousalStreak,
              durationTicks: sb.highArousalStreak,
              tick:          instance.tickCount,
            })
          }
          sb.highArousalStreak = 0
        }

        sb.prevValence = v
        sb.prevArousal = a

        // Track impulsive actions: ticks where executive fired with low confidence
        const conf      = snapshot.metrics.get('executive.confidence')
        const actCount  = Math.round( snapshot.metrics.get('executive.action_count') ?? 0 )
        if( conf !== undefined && conf < 0.35 && actCount > 0 )
          sb.impulsiveActionCount += actCount
      }

      // Expire stale outbox messages (TTL cleanup; OutboxController owns the policy).
      this._outbox.expireStale( instance )

      // Pause when the per-session tick budget is exhausted.
      // maxTicks is a run-length limit, not a TTL — the Will stays alive
      // and can be resumed on the next session for a fresh budget.
      if( maxTicks > 0 && instance.tickCount >= maxTicks ){
        instance.status = 'paused'
        // loop continues spin-waiting in the paused branch above
      }

      // Maintain target tick rate, but allow early wake when a message arrives.
      // _tickWakeFn is set by injectIncomingMessage; calling it interrupts the sleep.
      const
      elapsed = Date.now() - start,
      delay   = tickMs - elapsed

      if( delay > 0 ){
        await Promise.race([
          _sleep( delay ),
          new Promise<void>( resolve => { instance._tickWakeFn = resolve }),
        ])

        instance._tickWakeFn = null
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private _get( id: string ): WillInstance {
    const instance = this._wills.get( id )
    if( !instance ) throw new Error(`Will not found: ${id}`)

    return instance
  }
}

// NOTE (R4-b): the former process-global `_globalManager` + `getWillStem()`
// lazy singleton was removed. `WillStem` is instantiated directly — the dev
// runner makes its own (`new WillStem()`), and API servers that manage multiple
// Wills already do the same. Removing the ambient singleton keeps per-process
// state from leaking across Wills/tenants and across test files.

// ── Utils ─────────────────────────────────────────────────────

function _sleep( ms: number ): Promise<void> {
  return new Promise( r => setTimeout( r, ms ) )
}

/** Build a terse emotional state string from a snapshot for conversation context. */


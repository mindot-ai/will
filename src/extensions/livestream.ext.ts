// ─────────────────────────────────────────────────────────────
// src/extensions/live.ext.ts
// ─────────────────────────────────────────────────────────────

/**
 * Live streaming extension for dashboards, monitoring, and observability.
 * Layers on top of core — not part of the framework itself.
 * 
 * Provides WebSocket (full-duplex) and Server-Sent Events (unidirectional)
 * transports for real-time simulation state, metrics, and event streaming.
 */

import { logger } from '#core/logger'
import type { SimulationClock } from '#core/clock'
import type { EventBus } from '#core/event.bus'
import type { MetricCollector } from '#core/metrics'
import type { Orchestrator } from '#core/orchestrator'
import type { StateManager } from '#core/state.manager'
import type {
  SimulationContext,
  SimulationEvent,
  ReadonlySimulationState,
  Tick,
  Timestamp,
} from '../core/types'

// ── Transport-agnostic stream message ──────────────────────

export interface StreamMessage {
  type: 'snapshot' | 'tick-summary' | 'event' | 'metric-point' | 'log'
  timestamp: Timestamp
  tick: Tick
  payload: unknown
}

export interface TickSummary {
  tick: Tick
  simTime: Timestamp
  wallDuration: number       // ms this tick took
  entityCount: number
  metricCount: number
  pendingEvents: number
}

// ── Stream transports ─────────────────────────────────────

/**
 * Pluggable transport for live data.
 * Implementations: WebSocketStream, SSEStream, ConsoleStream, NoopStream
 */
export interface LiveStreamTransport {
  /** Push a single message to connected clients. */
  send( message: StreamMessage ): void

  /** Close all connections gracefully. */
  close(): void

  /** Called when the transport is registered with the extension. */
  onRegister?(): void
}

// ── Configuration ─────────────────────────────────────────

export interface LiveStreamConfig {
  /** Emit full state snapshot every N ticks (0 = never) */
  snapshotIntervalTicks?: number
  /** Emit tick summary (entity count, latency) every N ticks (1 = every tick) */
  tickSummaryIntervalTicks?: number
  /** Forward all events from EventBus */
  streamEvents?: boolean
  /** Forward metric points */
  streamMetrics?: boolean
  /** Event types to exclude from streaming (e.g., verbose debug events) */
  excludeEventTypes?: string[]
  /** Maximum message queue depth before dropping (backpressure) */
  maxQueueDepth?: number
}

// ── Extension implementation ──────────────────────────────

/**
 * FIX 1: Instead of implementing TickMiddleware (which has a call-signature
 * constraint), we expose the handler as a property that matches the signature.
 * The class no longer `implements TickMiddleware` — it provides an `onTick`
 * arrow function that is structurally compatible and can be assigned to
 * orchestratorConfig.onAfterTick.
 */
export class LiveStreamExtension {
  private _transport: LiveStreamTransport
  private _config: LiveStreamConfig
  private _eventBus: EventBus
  private _stateManager: StateManager
  private _metricCollector?: MetricCollector
  private _clock: SimulationClock
  /** FIX 2: Use the concrete DefaultOrchestrator type which has tickLatencies. */
  private _orchestrator: Orchestrator
  private _getTickLatency: () => number

  private _unsubscribeEventBus?: () => void
  private _messageQueue: StreamMessage[] = []
  private _maxQueueDepth: number
  private _flushInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    transport: LiveStreamTransport,
    eventBus: EventBus,
    stateManager: StateManager,
    orchestrator: Orchestrator,
    clock: SimulationClock,
    config: LiveStreamConfig = {},
    metricCollector?: MetricCollector
  ){
    this._transport = transport
    this._eventBus = eventBus
    this._stateManager = stateManager
    this._orchestrator = orchestrator
    this._clock = clock
    this._metricCollector = metricCollector
    this._config = {
      snapshotIntervalTicks: config.snapshotIntervalTicks ?? 0,
      tickSummaryIntervalTicks: config.tickSummaryIntervalTicks ?? 1,
      streamEvents: config.streamEvents ?? true,
      streamMetrics: config.streamMetrics ?? false,
      excludeEventTypes: config.excludeEventTypes ?? [],
      maxQueueDepth: config.maxQueueDepth ?? 1000,
    }
    this._maxQueueDepth = this._config.maxQueueDepth!

    /**
     * FIX 2: tickLatencies is only available on DefaultOrchestrator, not the
     * Orchestrator interface. We probe for it and provide a fallback so the
     * extension works with any orchestrator implementation.
     */
    const orchestratorAny = orchestrator as any
    if( Array.isArray( orchestratorAny.tickLatencies ) ){
      this._getTickLatency = () => {
        const latencies = orchestratorAny.tickLatencies as number[]
        return latencies.length > 0 ? ( latencies.at( -1 ) ?? 0 ) : 0
      }
    }
    else {
      this._getTickLatency = () => 0
    }

    // Wire transport lifecycle
    transport.onRegister?.()
  }

  // ── Tick handler (assignable to OrchestratorConfig.onAfterTick) ──

  /**
   * Arrow function property — structurally matches the TickMiddleware
   * call signature `(tick, time, state, context) => void | Promise<void>`.
   * Assign this to orchestratorConfig.onAfterTick.
   */
  readonly onTick = (
    tick: Tick,
    _time: Timestamp,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): void => {
    // Tick summary
    if(
      this._config.tickSummaryIntervalTicks! > 0
      && tick % this._config.tickSummaryIntervalTicks! === 0
    ){
      this._enqueue({
        type: 'tick-summary',
        timestamp: Date.now(),
        tick,
        payload: {
          tick,
          simTime: this._clock.now,
          wallDuration: this._getTickLatency(),
          entityCount: state.entities.size,
          metricCount: state.metrics.size,
          pendingEvents: this._eventBus.getPendingCount(),
        } satisfies TickSummary,
      })
    }

    // Full snapshot
    if(
      this._config.snapshotIntervalTicks! > 0
      && tick % this._config.snapshotIntervalTicks! === 0
    ){
      this._enqueue({
        type: 'snapshot',
        timestamp: Date.now(),
        tick,
        payload: this._stateManager.snapshot(),
      })
    }
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** Start streaming. Must be called after construction. */
  start(): void {
    // Subscribe to event bus
    if( this._config.streamEvents ){
      this._unsubscribeEventBus = this._eventBus.subscribeAll( ( event, _ctx ) => {
        if( this._config.excludeEventTypes?.includes( event.type ) ) return
        this._enqueue({
          type: 'event',
          timestamp: Date.now(),
          tick: event.tick,
          payload: event,
        })
      })
    }

    // Periodic flush (handles metric streaming + drain)
    this._flushInterval = setInterval( () => {
      // Metric streaming can be wired here if MetricCollector exposes a
      // per-point callback. Currently metrics flow through tick summaries.
      this._drainQueue()
    }, 50 ) // 20 fps flush rate
  }

  /** Stop streaming and close transport. */
  stop(): void {
    this._unsubscribeEventBus?.()
    if( this._flushInterval ) clearInterval( this._flushInterval )
    this._drainQueue()
    this._transport.close()
  }

  // ── Backpressure handling ───────────────────────────────

  private _enqueue( message: StreamMessage ): void {
    if( this._messageQueue.length >= this._maxQueueDepth ){
      // Drop oldest message (circular buffer semantics)
      this._messageQueue.shift()
      logger.warn(`[LiveStream] Queue full (${this._maxQueueDepth}), dropping oldest message`)
    }

    this._messageQueue.push( message )
  }

  private _drainQueue(): void {
    while( this._messageQueue.length > 0 ){
      const message = this._messageQueue.shift()!
      try {
        this._transport.send( message )
      }
      catch( error ){
        logger.error('[LiveStream] Failed to send message, transport may be closed:', error )
        // Stop trying — transport is dead
        this._messageQueue.length = 0
        break
      }
    }
  }
}

// ── WebSocket transport (Bun-native) ──────────────────────

export interface WebSocketConfig {
  port: number
  path?: string  // e.g., '/live'
  maxConnections?: number
}

/**
 * FIX 3: Bun.serve().upgrade() requires an options object with `data`.
 * The third argument is not rest parameters — it's a single options bag.
 */
export class WebSocketTransport implements LiveStreamTransport {
  private _server: ReturnType<typeof Bun.serve> | null = null
  private _clients: Set<{ send: ( data: string ) => void }> = new Set()
  private _config: WebSocketConfig
  private _maxConnections: number

  constructor( config: WebSocketConfig ){
    this._config = config
    this._maxConnections = config.maxConnections ?? 100
  }

  send( message: StreamMessage ): void {
    const data = JSON.stringify( message )

    for( const client of this._clients )
      client.send( data )
  }

  close(): void {
    this._server?.stop()
    this._clients.clear()
  }

  onRegister(): void {
    this._server = Bun.serve({
      port: this._config.port,
      fetch: ( req, server ) => {
        // Only upgrade on the configured path
        const url = new URL( req.url )
        if( this._config.path && url.pathname !== this._config.path )
          return new Response('Not found', { status: 404 } )

        // Connection limit
        if( this._clients.size >= this._maxConnections )
          return new Response('Too many connections', { status: 503 } )

        // FIX 3: upgrade() requires { data } as second argument per Bun types
        const upgraded = server.upgrade( req, { data: {} } )
        if( !upgraded )
          return new Response('WebSocket upgrade failed', { status: 400 } )

        return undefined  // Bun handles the upgrade response
      },
      websocket: {
        open: ( ws ) => {
          this._clients.add( ws )
          logger.info(`[WebSocket] Client connected (${this._clients.size} total)`)
        },
        close: ( ws ) => {
          this._clients.delete( ws )
          logger.info(`[WebSocket] Client disconnected (${this._clients.size} total)`)
        },
        message: ( _ws, _message ) => {
          // Clients can send commands here (pause, resume, set speed, etc.)
          // For now, read-only streaming
        },
      },
    })

    logger.info(`[WebSocket] Server listening on ws://localhost:${this._config.port}${this._config.path ?? '/'}`)
  }
}

// ── Server-Sent Events transport ──────────────────────────

export interface SSEConfig {
  port: number
  path?: string
}

/**
 * FIX 4 & 5: ReadableStreamDefaultController (from Bun.serve fetch) is not
 * a WritableStreamDefaultWriter. SSE uses a ReadableStream to push events
 * to the client. We need to store the controller and use controller.enqueue()
 * instead of writer.write().
 */
export class SSETransport implements LiveStreamTransport {
  private _server: ReturnType<typeof Bun.serve> | null = null
  private _clients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set()
  private _config: SSEConfig
  private _encoder = new TextEncoder()

  constructor( config: SSEConfig ){
    this._config = config
  }

  send( message: StreamMessage ): void {
    const
    eventLine = `event: ${message.type}\n`,
    dataLine = `data: ${JSON.stringify( message )}\n\n`,
    encoded = this._encoder.encode( eventLine + dataLine )

    for( const controller of this._clients )
      controller.enqueue( encoded )
  }

  close(): void {
    this._server?.stop()
    for( const controller of this._clients ){
      try { controller.close() } catch {}
    }
    this._clients.clear()
  }

  onRegister(): void {
    this._server = Bun.serve({
      port: this._config.port,
      fetch: async ( req ) => {
        const url = new URL( req.url )
        if( this._config.path && url.pathname !== this._config.path )
          return new Response('Not found', { status: 404 } )

        /**
         * FIX 4 & 5: ReadableStream with start(controller) gives us a
         * ReadableStreamDefaultController. We store the controller directly
         * and use controller.enqueue() to push SSE data. The client's
         * abort signal handles disconnection cleanup.
         */
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null

        const stream = new ReadableStream<Uint8Array>({
          start: ( controller ) => {
            streamController = controller
            this._clients.add( controller )

            // Send initial comment to establish connection
            controller.enqueue( this._encoder.encode(': connected\n\n') )

            req.signal.addEventListener('abort', () => {
              if( streamController ){
                this._clients.delete( streamController )
                logger.info(`[SSE] Client disconnected (${this._clients.size} total)`)
                streamController = null
              }
            })
          },
          cancel: () => {
            if( streamController ){
              this._clients.delete( streamController )
              streamController = null
            }
          },
        })

        return new Response( stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
      },
    })

    logger.info(`[SSE] Server listening on http://localhost:${this._config.port}${this._config.path ?? '/'}`)
  }
}

// ── Console transport (for development) ───────────────────

export class ConsoleTransport implements LiveStreamTransport {
  private _verbose: boolean

  constructor( verbose: boolean = false ){
    this._verbose = verbose
  }

  send( message: StreamMessage ): void {
    if( !this._verbose && message.type === 'tick-summary'){
      // Only log every 100 ticks for summary
      const summary = message.payload as TickSummary
      if( summary.tick % 100 === 0 ){
        logger.info(
          `[Live] Tick ${summary.tick}: ${summary.entityCount} entities, ${summary.wallDuration}ms`
        )
      }
      return
    }

    logger.info(`[Live] ${message.type}:`, message.payload )
  }

  close(): void {
    // No-op for console
  }
}

// ── Factory helpers ───────────────────────────────────────

export class LiveStreamFactory {
  /**
   * Create a WebSocket-backed live stream wired into a running simulation.
   * Wire `stream.onTick` as `orchestratorConfig.onAfterTick`.
   */
  static createWebSocket(
    sim: {
      eventBus: EventBus
      stateManager: StateManager
      orchestrator: Orchestrator
      clock: SimulationClock
      metrics: MetricCollector
    },
    config: LiveStreamConfig & WebSocketConfig
  ): LiveStreamExtension {
    const transport = new WebSocketTransport({
      port: config.port,
      path: config.path,
      maxConnections: config.maxConnections,
    })

    return new LiveStreamExtension(
      transport,
      sim.eventBus,
      sim.stateManager,
      sim.orchestrator,
      sim.clock,
      config,
      sim.metrics
    )
  }

  /**
   * Create an SSE-backed live stream.
   */
  static createSSE(
    sim: {
      eventBus: EventBus
      stateManager: StateManager
      orchestrator: Orchestrator
      clock: SimulationClock
      metrics: MetricCollector
    },
    config: LiveStreamConfig & SSEConfig
  ): LiveStreamExtension {
    const transport = new SSETransport({
      port: config.port,
      path: config.path,
    })

    return new LiveStreamExtension(
      transport,
      sim.eventBus,
      sim.stateManager,
      sim.orchestrator,
      sim.clock,
      config,
      sim.metrics
    )
  }

  /**
   * Quick console logger for development.
   */
  static createConsole(
    sim: {
      eventBus: EventBus
      stateManager: StateManager
      orchestrator: Orchestrator
      clock: SimulationClock
      metrics: MetricCollector
    },
    config: LiveStreamConfig = {}
  ): LiveStreamExtension {
    const transport = new ConsoleTransport()

    return new LiveStreamExtension(
      transport,
      sim.eventBus,
      sim.stateManager,
      sim.orchestrator,
      sim.clock,
      config,
      sim.metrics
    )
  }
}

// ── Usage example ─────────────────────────────────────────

// import { DefaultSimulation } from '../core/simulation'
// import { LiveStreamFactory } from './live.ext'
//
// const sim = new DefaultSimulation()
// // ... load scenario, add engines ...
//
// const liveStream = LiveStreamFactory.createWebSocket( sim, {
//   port: 8080,
//   path: '/simulation-live',
//   tickSummaryIntervalTicks: 1,
//   streamEvents: true,
//   snapshotIntervalTicks: 100,
// })
//
// // Wire into orchestrator using updateConfig — works post-construction
// const unsubLive = sim.orchestrator.onAfterTick( liveStream.onTick )
//
// // Later, remove one without affecting the other
// unsubLive()
//
// liveStream.start()
// await sim.run()
// liveStream.stop()
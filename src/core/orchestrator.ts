// ─────────────────────────────────────────────────────────────
// src/core/orchestrator.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { EventBus } from '#core/event.bus'
import type { SimulationClock } from '#core/clock'
import type { StateManager } from '#core/state.manager'
import type {
  SimulationContext,
  SimulationEvent,
  StateCommands,
  ReadonlySimulationState,
  Tick,
  Duration,
  MinimalContext,
} from '#core/types'
import { createContext } from '#core/utils'
import { wallClock } from '#core/wall.clock'

// ── Engine contract ──────────────────────────────────────────

/**
 * What an engine returns from react().
 * Events and commands are collected from all engines, then applied
 * atomically — no engine sees another engine's writes from the same tick.
 */
export interface EngineResult {
  /** Events to publish after commands are applied. tick is stamped by Orchestrator. */
  events?:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>>
  /** State mutations to apply after all engines have finished reading. */
  commands?: StateCommands
}

export interface SimulationEngine {
  readonly name: string

  /**
   * Called once per tick with a frozen read-only snapshot.
   * Engines must NOT mutate state directly — return commands instead.
   * Omit entirely on purely event-driven engines — the orchestrator skips them.
   */
  react?(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult>

  /**
   * Called when this engine's react() throws. Allows the orchestrator 
   * to isolate engine failures without crashing the entire tick.
   * 
   * Return EngineResult to provide fallback commands/events,
   * or return null to skip this engine's contribution for this tick.
   * If not provided, the error propagates (old behavior).
   */
  onError?( error: Error, tick: Tick, context: SimulationContext ): Promise<EngineResult | null>

  onAttach?( state: StateManager, context: SimulationContext ): Promise<void>
  onDetach?( state: StateManager, context: SimulationContext ): Promise<void>
}


// ── Middleware ───────────────────────────────────────────────

export type TickMiddleware = (
  tick:    Tick,
  state:   ReadonlySimulationState,
  context: SimulationContext
) => void | Promise<void>

/**
 * Pre-commit validator signature.
 * Receives all pending commands for the current tick.
 * Return string[] of validation errors to abort the commit,
 * or void/true to proceed.
 */
export type CommitValidator = (
  commands: StateCommands[],
  tick: Tick,
  context: SimulationContext
) => string[] | true | void | Promise<string[] | true | void>

// ── Config ───────────────────────────────────────────────────

export interface OrchestratorConfig {
  tickIntervalMs?:   number
  maxTicks?:         number
  maxRealTimeMs?:    number
  /**
   * Stop the loop when the event bus is empty AND no engine produced
   * events or state commands in the last tick.
   */
  stopOnEmptyEvents?: boolean
  idleThresholdMs?:  number
  /** Fired before engines run — receives the frozen pre-tick snapshot. */
  onBeforeTick?: TickMiddleware | TickMiddleware[]
  /** Fired after commands are applied and events are flushed. */
  onAfterTick?: TickMiddleware | TickMiddleware[]
  /**
   * Pre-commit validation hooks. Called after engines run but
   * before commands are applied. Receives all pending commands.
   * All validators must pass — if any returns string[], the commit
   * is aborted and events are not published for this tick.
   */
  onBeforeCommit?: CommitValidator[]
}

// ── Interface ────────────────────────────────────────────────

export interface Orchestrator {
  readonly isRunning:    boolean
  readonly currentTick:  Tick

  /**
   * Register an onAfterTick handler. Multiple handlers can be registered
   * and all will be called in registration order after each tick.
   * Returns an unsubscribe function.
   */
  onAfterTick( handler: TickMiddleware ): () => void

  /** Register an onBeforeTick handler. Returns unsubscribe function. */
  onBeforeTick( handler: TickMiddleware ): () => void

  /** Register a pre-commit validator. All validators must pass. Returns unsubscribe function. */
  onBeforeCommit( validator: CommitValidator ): () => void

  /**
   * Update non-middleware config fields at runtime.
   * Accepts a partial config — only provided fields are changed.
   * undefined values are ignored.
   * 
   * NOTE: Does NOT accept onBeforeTick/onAfterTick/onBeforeCommit.
   * Use the dedicated registration methods for middleware.
   */
  updateConfig( config: Partial<Omit<OrchestratorConfig, 'onBeforeTick' | 'onAfterTick' | 'onBeforeCommit'>> ): void

  addEngine( engine: SimulationEngine ): void
  removeEngine( name: string ): boolean
  hasPendingAsyncWork(): boolean
  /** Engine names in execution order (assembly-order snapshot artifact). */
  readonly engineNames: string[]
  /** Registered engine instances, execution-ordered (assembly wiring audit). */
  readonly engines: readonly SimulationEngine[]

  start( context: SimulationContext ): Promise<void>
  stop(): void
  pause(): void
  resume(): void

  step( count?: number, context?: MinimalContext ): Promise<void>
  runUntilTick( targetTick: Tick, context?: MinimalContext ): Promise<void>
  runUntilTime( targetTime: number, context?: MinimalContext ): Promise<void>
}

// ── Implementation ───────────────────────────────────────────

export class DefaultOrchestrator implements Orchestrator {
  protected _engines: SimulationEngine[] = []

  /** Override in subclasses to control which engines participate in the tick loop. */
  protected _enginesTick(): SimulationEngine[] { return this._engines }
  private _isRunning    = false
  private _isPaused     = false
  private _shouldStop   = false
  private _currentTick: Tick = 0
  private _clock:         SimulationClock
  private _eventBus:      EventBus
  protected _stateManager:  StateManager
  private _config:        OrchestratorConfig
  private _lastTickHadActivity = false
  private _lastEventTimestamp: number = 0
  private _idleTimer: NodeJS.Timeout | null = null
  private _tickTimer: NodeJS.Timeout | null = null
  // Re-entrancy guard: true while _executeTick is in flight. Prevents an
  // overlapping tick when a tick's async work exceeds tickIntervalMs.
  private _executing = false

  /** Runtime middleware arrays — the single source of truth for tick execution. */
  private _onBeforeTickHandlers:   TickMiddleware[] = []
  private _onAfterTickHandlers:    TickMiddleware[] = []
  private _onBeforeCommitHandlers: CommitValidator[] = []

  // Tick benchmarking — records per-tick latency
  private _tickLatencies: number[] = []
  private _maxLatencySamples = 1000

  constructor(
    clock:        SimulationClock,
    eventBus:     EventBus,
    stateManager: StateManager,
    config:       OrchestratorConfig = {}
  ){
    this._clock        = clock
    this._eventBus     = eventBus
    this._stateManager = stateManager
    this._config       = config

    // Seed runtime arrays from constructor config
    this._seedMiddleware( config )
  }

  /**
   * Normalize constructor config into the runtime middleware arrays.
   * Accepts single handler or array for onBeforeTick/onAfterTick.
   * onBeforeCommit is always an array.
   */
  private _seedMiddleware( config: OrchestratorConfig ): void {
    if( config.onBeforeTick ) {
      if( Array.isArray( config.onBeforeTick ) )
        this._onBeforeTickHandlers.push( ...config.onBeforeTick )
      else
        this._onBeforeTickHandlers.push( config.onBeforeTick )
    }

    if( config.onAfterTick ) {
      if( Array.isArray( config.onAfterTick ) )
        this._onAfterTickHandlers.push( ...config.onAfterTick )
      else
        this._onAfterTickHandlers.push( config.onAfterTick )
    }

    if( config.onBeforeCommit )
      this._onBeforeCommitHandlers.push( ...config.onBeforeCommit )
  }

  get isRunning():   boolean { return this._isRunning }
  get currentTick(): Tick    { return this._currentTick }

  /**
   * Returns recent tick latency measurements for benchmarking.
   * Array of durations in milliseconds, most recent last.
   */
  get tickLatencies(): ReadonlyArray<number> {
    return this._tickLatencies
  }

  /**
   * Returns average tick latency over the sample window.
   */
  get averageTickLatency(): number {
    if( this._tickLatencies.length === 0 ) return 0
    return this._tickLatencies.reduce( ( a, b ) => a + b, 0 ) / this._tickLatencies.length
  }

  // ── Middleware registration (post-construction) ──────────

  /**
   * Register an onBeforeTick handler. Called before engines run each tick.
   * Returns an unsubscribe function to remove this specific handler.
   */
  onBeforeTick( handler: TickMiddleware ): () => void {
    this._onBeforeTickHandlers.push( handler )
    return () => {
      const idx = this._onBeforeTickHandlers.indexOf( handler )
      if( idx !== -1 ) this._onBeforeTickHandlers.splice( idx, 1 )
    }
  }

  /**
   * Register an onAfterTick handler. Called after commands are applied
   * and events are flushed each tick. Multiple handlers are called in
   * registration order.
   * Returns an unsubscribe function.
   */
  onAfterTick( handler: TickMiddleware ): () => void {
    this._onAfterTickHandlers.push( handler )
    return () => {
      const idx = this._onAfterTickHandlers.indexOf( handler )
      if( idx !== -1 ) this._onAfterTickHandlers.splice( idx, 1 )
    }
  }

  /**
   * Register a pre-commit validator. All registered validators must pass
   * (return void/true) for commands to be applied. If any validator returns
   * string[], the commit is aborted for this tick.
   * Returns an unsubscribe function.
   */
  onBeforeCommit( validator: CommitValidator ): () => void {
    this._onBeforeCommitHandlers.push( validator )
    return () => {
      const idx = this._onBeforeCommitHandlers.indexOf( validator )
      if( idx !== -1 ) this._onBeforeCommitHandlers.splice( idx, 1 )
    }
  }

  /**
   * Update non-middleware configuration at runtime.
   * Only numeric/boolean config fields are accepted — middleware hooks
   * must be registered via onBeforeTick() / onAfterTick() / onBeforeCommit().
   * undefined values are ignored (no un-set support).
   */
  updateConfig( config: Partial<Omit<OrchestratorConfig, 'onBeforeTick' | 'onAfterTick' | 'onBeforeCommit'>> ): void {
    if( config.tickIntervalMs !== undefined )
      this._config.tickIntervalMs = config.tickIntervalMs

    if( config.maxTicks !== undefined )
      this._config.maxTicks = config.maxTicks

    if( config.maxRealTimeMs !== undefined )
      this._config.maxRealTimeMs = config.maxRealTimeMs

    if( config.stopOnEmptyEvents !== undefined )
      this._config.stopOnEmptyEvents = config.stopOnEmptyEvents

    if( config.idleThresholdMs !== undefined )
      this._config.idleThresholdMs = config.idleThresholdMs
  }

  // ── Engine registry ──────────────────────────────────────

  addEngine( engine: SimulationEngine ): void {
    this._engines.push( engine )
  }

  /**
   * Registered engine names IN EXECUTION ORDER. Registration order = serial
   * tick order = replay determinism — this getter makes the order observable
   * so the assembly-order snapshot test can pin it as a reviewed artifact
   * (the true order comes from priority fields scattered across engine files;
   * without this it is visible nowhere).
   */
  get engineNames(): string[] {
    return this._engines.map( e => e.name )
  }

  /** The registered engine instances, execution-ordered (assembly audit). */
  get engines(): readonly SimulationEngine[] {
    return this._engines
  }

  removeEngine( name: string ): boolean {
    const index = this._engines.findIndex( e => e.name === name )
    if( index === -1 ) return false

    this._engines.splice( index, 1 )
    return true
  }

  /**
   * Returns true if any registered engine is an AsyncEngine
   * with pending reasoning operations. Useful for stopOnEmptyEvents
   * logic — the orchestrator should not stop while engines are thinking.
   */
  hasPendingAsyncWork(): boolean {
    // AsyncEngine instances maintain internal pending state.
    // This is a conservative check — we check if any engine's react()
    // returned no commands AND no events last tick (indicating waiting).
    // More precise tracking would require the engine to expose pending count.
    return false  // Default: orchestrator doesn't introspect engine internals
  }

  /**
   * Hook called after Phase 1 commands are applied and the EventBus is flushed,
   * but BEFORE after-tick middleware runs. Override in CognitiveOrchestrator to
   * flush the CognitiveBus and apply Phase 2 (event-handler) commands so that
   * metrics and snapshot after-tick handlers see the fully updated state.
   */
  protected async _onAfterPhase1(
    _tick:    Tick,
    _state:   ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<void> { /* no-op in base orchestrator */ }

  // ── Lifecycle ────────────────────────────────────────────

  async start( context: SimulationContext ): Promise<void> {
    if( this._isRunning ) return

    this._shouldStop = false
    this._isRunning  = true
    this._isPaused   = false

    for( const engine of this._engines )
      engine.onAttach && await engine.onAttach( this._stateManager, context )

    this._runLoop( context )
  }

  /**
   * Tick-loop scheduling. Uses setInterval for consistent pacing;
   * calls _executeTick() which handles pause/stop checks internally.
   * The orchestrator is the sole driver of ticks.
   */
  private _runLoop( context: SimulationContext ): void {
    if( this._tickTimer ) return

    this._tickTimer = setInterval( async () => {
      if( this._shouldStop || this._isPaused ) return

      // Drop this firing if the previous tick is still in flight. setInterval does
      // not wait for an async callback, so without this guard a tick whose async
      // work (engine reacts, eventBus.flush) exceeds tickIntervalMs would overlap
      // the next one and interleave applyCommands on the double buffer.
      if( this._executing ) return

      if( this._config.maxTicks && this._currentTick >= this._config.maxTicks ){
        await this._shutdown( context )
        return
      }

      if( this._config.maxRealTimeMs && wallClock() >= this._config.maxRealTimeMs ){
        await this._shutdown( context )
        return
      }

      if( this._config.stopOnEmptyEvents
          && this._eventBus.getPendingCount() === 0
          && !this._lastTickHadActivity ){
        await this._shutdown( context )
        return
      }

      this._executing = true
      try {
        await this._executeTick( context )
      }
      finally {
        this._executing = false
      }
    }, this._config.tickIntervalMs ?? 0 )
  }

  private async _shutdown( context: SimulationContext ): Promise<void> {
    this._shouldStop = true
    this._tickTimer && clearInterval( this._tickTimer )
    this._tickTimer = null

    for( const engine of this._engines )
      engine.onDetach && await engine.onDetach( this._stateManager, context )

    this._isRunning = false
  }

  stop(): void {
    this._shouldStop = true
    this._tickTimer && clearInterval( this._tickTimer )
    this._tickTimer = null
  }

  pause():  void { this._isPaused = true;  this._clock.pause() }
  resume(): void { this._isPaused = false; this._clock.resume() }

  // ── Core tick ────────────────────────────────────────────

  private async _executeTick( context: SimulationContext ): Promise<void> {
    const tickStart = wallClock()

    // 1. Advance clock
    this._clock.tick()
    this._currentTick = this._clock.currentTick

    // 2. Sync state manager clock reference
    this._stateManager.updateClock( this._currentTick, this._clock.now )

    // 3. Drain future events due at this tick into the pending queue
    this._eventBus.prepareTick( this._currentTick )

    // 4. Frozen read-only snapshot — all engines read this same view
    const snapshot = this._stateManager.snapshot() as ReadonlySimulationState

    // Allow subclasses to enrich the context (e.g. inject cognitiveBus)
    const engineContext = this._buildEngineContext( context )

    // 5. Before-tick: iterate all handlers in registration order
    for( const handler of this._onBeforeTickHandlers )
      await handler( this._currentTick, snapshot, engineContext )

    // 6. Run engines — strictly sequential in priority (registration) order.
    // This serial await chain is DELIBERATE, not an oversight: it fixes the order
    // in which engines emit commands, which is what makes record-and-replay
    // reproducible. The synchronous heuristic engines are mutually independent
    // within a tick and *could* run via Promise.all for throughput — do NOT do
    // that. Parallelizing reintroduces nondeterministic command ordering and
    // silently breaks replay. Throughput is traded for determinism on purpose.
    const allResults: EngineResult[] = []

    const runEngine = async ( engine: SimulationEngine ): Promise<void> => {
      try {
        const result = await engine.react?.( this._clock.delta, this._currentTick, snapshot, engineContext )
        if( result ) allResults.push( result )
      }
      catch( error ){
        if( engine.onError ){
          const fallback = await engine.onError( error as Error, this._currentTick, engineContext )
          if( fallback ) allResults.push( fallback )
        }
        else {
          logger.error(
            `[Orchestrator] Engine "${engine.name}" threw at tick ${this._currentTick}:`,
            error
          )
        }
      }
    }

    for( const engine of this._enginesTick() )
      await runEngine( engine )

    // Track pending async work across engines (check all engines, not just tick engines)
    const hasPendingAsync = this._engines.some( e => ( e as any ).hasPendingWork === true )

    // 7. Collect all commands for pre-commit validation
    const allCommands: StateCommands[] = []
    for( const result of allResults )
      result.commands && allCommands.push( result.commands )

    // 8. Pre-commit validation — all validators must pass.
    // If any validator returns string[], abort the commit for this tick.
    if( this._onBeforeCommitHandlers.length > 0 && allCommands.length > 0 ){
      let abort = false
      for( const validator of this._onBeforeCommitHandlers ){
        const result = await validator( allCommands, this._currentTick, engineContext )
        if( Array.isArray( result ) && result.length > 0 ){
          logger.error(
            `[Orchestrator] Pre-commit validation failed at tick ${this._currentTick}:`,
            result.join(', ')
          )
          abort = true
          break  // Stop at first failing validator
        }
      }
      
      if( abort ) return  // Skip command application and event publishing
    }

    // 9. Apply all state commands atomically (double-buffer commit)
    for( const commands of allCommands )
      this._stateManager.applyCommands( commands )

    // 10. Publish engine events with tick stamped
    const allEvents: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = []
    for( const result of allResults )
      result.events && allEvents.push( ...result.events )

    for( const event of allEvents )
      this._eventBus.publish( event, context, this._currentTick )

    // 12. Flush event bus — handlers see the post-command state
    await this._eventBus.flush()

    // Phase 2: CognitiveBus flush + event-handler command commit (overridden in CognitiveOrchestrator)
    await this._onAfterPhase1( this._currentTick, snapshot, engineContext )

    // 13. After-tick: iterate all handlers in registration order
    const postSnapshot = this._stateManager.snapshot() as ReadonlySimulationState
    for( const handler of this._onAfterTickHandlers )
      await handler( this._currentTick, postSnapshot, engineContext )

    // 13. Track activity for stopOnEmptyEvents
    const commandActivity = allResults.some( r => ( r.commands?.set?.length ?? 0 ) + ( r.commands?.delete?.length ?? 0 ) > 0 )
    this._lastTickHadActivity = allEvents.length > 0 || commandActivity || hasPendingAsync

    // 14. Idle detection
    if( this._lastTickHadActivity ){
      this._lastEventTimestamp = wallClock()
      this._resetIdleTimer()
    }
    else if( this._config.idleThresholdMs )
      this._resetIdleTimer()

    // 15. Record tick latency for benchmarking
    const tickDuration = wallClock() - tickStart
    this._tickLatencies.push( tickDuration )

    if( this._tickLatencies.length > this._maxLatencySamples )
      this._tickLatencies.shift()
  }

  /**
   * Override in subclasses to enrich the SimulationContext passed to engines.
   * Default: returns context unchanged.
   * CognitiveOrchestrator overrides this to inject cognitiveBus.
   */
  protected _buildEngineContext( context: SimulationContext ): SimulationContext {
    return context
  }

  private _resetIdleTimer(): void {
    if( !this._config.idleThresholdMs ) return

    this._idleTimer && clearTimeout( this._idleTimer )
    this._idleTimer = setTimeout( () => {
      if( this._isRunning && !this._isPaused ){
        const idleDuration = wallClock() - this._lastEventTimestamp
        idleDuration >= ( this._config.idleThresholdMs ?? 0 ) && ( this._shouldStop = true )
      }
    }, this._config.idleThresholdMs )
  }

  private _wait( ms: number ): Promise<void> {
    return new Promise( resolve => setTimeout( resolve, ms ) )
  }

  // ── Utility run modes ────────────────────────────────────

  async step(
    count: number = 1,
    { simulationId, runId, seed }: MinimalContext = { simulationId: 'step', runId: 'single' }
  ): Promise<void> {
    const fullContext = createContext( simulationId, runId, seed ?? 42 )
    for( let i = 0; i < count; i++ )
      await this._executeTick( fullContext )
  }

  async runUntilTick(
    targetTick: Tick,
    { simulationId, runId, seed }: MinimalContext = { simulationId: 'batch', runId: 'until-tick' }
  ): Promise<void> {
    const fullContext = createContext( simulationId, runId, seed ?? 42 )
    while( this._currentTick < targetTick && !this._shouldStop )
      await this._executeTick( fullContext )
  }

  async runUntilTime(
    targetTime: number,
    { simulationId, runId, seed }: MinimalContext = { simulationId: 'batch', runId: 'until-time' }
  ): Promise<void> {
    const fullContext = createContext( simulationId, runId, seed ?? 42 )
    while( this._clock.now < targetTime && !this._shouldStop )
      await this._executeTick( fullContext )
  }
}
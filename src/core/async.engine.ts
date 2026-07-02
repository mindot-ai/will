// ─────────────────────────────────────────────────────────────
// src/core/async.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * Base class for simulation engines that perform asynchronous reasoning
 * (e.g., LLM calls). Extends SimulationEngine with
 * non-blocking execution, state re-validation, and progressive streaming
 * of intermediate results.
 *
 * Engines that extend this class:
 *   - readState() captures a ReasoningFootprint at reasoning start
 *   - reasonAsync() performs the actual async work (LLM call, etc.)
 *     and receives an IntermediateStream to report progress
 *   - onReasoningComplete() converts the reasoning result to StateCommands
 *   - onIntermediateResult() converts streaming steps to StateCommands
 *
 * The base class handles:
 *   - Non-blocking tick execution (react() never awaits LLM calls)
 *   - Footprint capture
 *   - Progressive intermediate result application (bypasses conflict detection)
 *   - Conflict detection and resolution on final results
 *   - Re-evaluation triggering
 */

import { logger } from '#core/logger'
import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  ReasoningFootprint,
  StateCommands,
  ConflictStrategy,
  AsyncEngineConfig,
  SimulationEvent,
  ConflictReport,
} from '#core/types'
import type { SimulationEngine, EngineResult } from '#core/orchestrator'
import { ConflictDetector } from '#core/conflict.detector'
import { wallClock } from '#core/wall.clock'

// ── Streaming ─────────────────────────────────────────────────

/**
 * A write-side channel that async reasoning can push intermediate
 * results into. Each push triggers onIntermediateResult() and the
 * returned StateCommands are applied immediately to the current tick
 * (no conflict detection — progressive disclosure only).
 */
export interface IntermediateStream {
  /**
   * Report an intermediate step result.
   * Commands returned by onIntermediateResult() are merged into the
   * current tick's command batch immediately.
   */
  report( step: string, result: unknown ): void

  /** The footprint this stream is associated with */
  readonly footprint: ReasoningFootprint

  /** Number of intermediate results reported so far */
  readonly count: number
}

// ── Internal state ────────────────────────────────────────────

interface IntermediateEntry {
  step: string
  result: unknown
  timestamp: number
}

/**
 * Internal state for a pending reasoning operation.
 */
interface PendingReasoning {
  /** Unique key for this pending operation */
  key: string
  /** The footprint captured when reasoning began */
  footprint: ReasoningFootprint
  /** The promise that resolves with reasoning output */
  promise: Promise<unknown>
  /** Tick when reasoning was initiated */
  startedAtTick: Tick
  /** Intermediate results that arrived while reasoning was in-flight */
  intermediates: IntermediateEntry[]
  /** Set to true via .then()/.catch() when the promise settles */
  settled: boolean
  /** Set to true by _collectCompleted() after result is processed (prevents double-processing) */
  resolved: boolean
}

export abstract class AsyncEngine implements SimulationEngine {
  abstract readonly name: string

  private _pending: Map<string, PendingReasoning> = new Map()
  private _detector: ConflictDetector
  private _config: AsyncEngineConfig
  private _pendingCounter = 0

  constructor( config: AsyncEngineConfig = {} ){
    this._detector = new ConflictDetector()
    this._config = {
      defaultStrategy:  config.defaultStrategy  ?? 'REJECT',
      maxPendingTicks:  config.maxPendingTicks  ?? 50,
      logConflicts:     config.logConflicts     ?? true,
      rerunOnRejection: config.rerunOnRejection ?? true,
    }
  }

  /** True when there is at least one in-flight reasoning promise. */
  get hasPendingWork(): boolean {
    return this._pending.size > 0
  }

  /**
   * Await all in-flight reasoning promises to settle WITHOUT advancing the
   * simulation. A caller can then collect the completed decision on the next
   * single step — instead of stepping repeatedly to poll, which would drain
   * simulation state (energy, circadian) and corrupt a controlled stimulus.
   * Resolves immediately when nothing is pending.
   */
  async awaitPending(): Promise<void> {
    await Promise.allSettled( [ ...this._pending.values() ].map( p => p.promise ) )
  }

  // ── SimulationEngine implementation ──────────────────────

  /**
   * Non-blocking tick react.
   * 1. Drains intermediate results from in-flight reasoning
   * 2. Checks for completed reasoning from previous ticks
   * 3. Starts new reasoning if the engine is idle (shouldAct() returns true)
   * 4. Returns validated results for this tick
   */
  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = {}

    // 1. Drain intermediate results from in-flight reasoning
    this._drainIntermediates( tick, context, events, commands )

    // 2. Collect completed reasoning, re-validated against current state
    await this._collectCompleted( tick, state, context, events, commands )

    // 3. Prune stale pending operations
    this._pruneStale( tick )

    // 4. Start new reasoning if conditions are met
    if( this.shouldAct( state, tick, context ) ){
      const footprint = this.readState( state, tick )

      // Build the intermediate stream that reasoning can push into
      const stream = this._createStream( footprint, context, events, commands )
      const reasoningPromise = this.reasonAsync( footprint, state, context, stream )

      this._pendingCounter++
      const key = `${this.name}-${this._pendingCounter}-tick${tick}`

      const pendingEntry: PendingReasoning = {
        key,
        footprint,
        promise: reasoningPromise,
        startedAtTick: tick,
        intermediates: [],
        settled: false,
        resolved: false,
      }

      // Mark settled when the promise completes (micro-task safe flag)
      reasoningPromise.then(
        () => { pendingEntry.settled = true },
        () => { pendingEntry.settled = true }
      )

      this._pending.set( key, pendingEntry )
    }

    // Emit queue depth metric so orchestrator/runner can detect overloaded engines
    const metricKey = `engine.${this.name}.pending_depth`
    commands.metrics ??= []
    commands.metrics.push([ metricKey, this._pending.size ])

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Optional lifecycle hooks ─────────────────────────────

  onAttach?(): Promise<void>
  onDetach?(): Promise<void>

  /**
   * Called when this engine's react() throws.
   * Default behavior: log and return empty result (engine contributes nothing this tick).
   */
  async onError( error: Error, _tick: Tick, _context: SimulationContext ): Promise<EngineResult | null> {
    logger.error(`[AsyncEngine] ${this.name} error:`, error )
    return null
  }

  // ── Subclass contract ────────────────────────────────────

  /**
   * Whether the engine should initiate reasoning this tick.
   * Override to control when the engine activates.
   * Default: activates when no reasoning is pending.
   */
  protected shouldAct(
    _state: ReadonlySimulationState,
    _tick: Tick,
    _context: SimulationContext
  ): boolean {
    return this._pending.size === 0
  }

  /**
   * Capture a reasoning footprint from the current state snapshot.
   * Override to specify which entities/metrics the engine will observe.
   * Default: captures all entity IDs and metric keys (conservative).
   */
  protected readState(
    state: ReadonlySimulationState,
    tick: Tick
  ): ReasoningFootprint {
    return {
      tickObserved: tick,
      entitiesRead: new Set( state.entities.keys() ),
      metricsRead: new Set( state.metrics.keys() ),
      entitiesModified: new Set(),
      intendedCommands: {},
      source: this.name,
    }
  }

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
  protected abstract reasonAsync(
    footprint: ReasoningFootprint,
    state: ReadonlySimulationState,
    context: SimulationContext,
    stream: IntermediateStream
  ): Promise<unknown>

  /**
   * Convert reasoning output to StateCommands.
   * Called after conflict validation passes on the final result.
   */
  protected abstract onReasoningComplete(
    output: unknown,
    footprint: ReasoningFootprint,
    context: SimulationContext
  ): StateCommands

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
  protected onIntermediateResult(
    step: string,
    result: unknown,
    footprint: ReasoningFootprint,
    context: SimulationContext
  ): StateCommands | null {
    return null
  }

  /**
   * Choose the conflict strategy for this reasoning.
   * Override to vary strategy based on context (e.g., high-stakes actions use REJECT).
   */
  protected chooseStrategy(
    _footprint: ReasoningFootprint,
    _context: SimulationContext
  ): ConflictStrategy {
    return this._config.defaultStrategy!
  }

  /**
   * Called when reasoning is rejected due to conflicts.
   * Override to handle rejection (logging, notification, etc.).
   */
  protected onConflictRejected(
    footprint: ReasoningFootprint,
    report: ConflictReport,
    _context: SimulationContext
  ): void {
    this._config.logConflicts && logger.warn(
      `[AsyncEngine] ${this.name} reasoning from tick ${footprint.tickObserved} rejected:`,
      `${report.readConflicts.length} read conflicts, ${report.writeConflicts.length} write conflicts`
    )
  }

  // ── Stream creation ──────────────────────────────────────

  /**
   * Create an IntermediateStream wired to a specific pending entry.
   * The stream pushes directly into the pending intermediates array,
   * which are drained each tick by _drainIntermediates().
   */
  private _createStream(
    footprint: ReasoningFootprint,
    context: SimulationContext,
    events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>>,
    commands: StateCommands
  ): IntermediateStream {
    let count = 0

    return {
      footprint,

      get count(){ return count },

      report: ( step: string, result: unknown ): void => {
        count++

        // Apply the intermediate result immediately through the subclass hook
        const intermediateCommands = this.onIntermediateResult(
          step, result, footprint, context
        )

        if( intermediateCommands ){
          this._mergeCommands( commands, intermediateCommands )
        }

        // Also store in the pending entry for historical record
        // Find our pending entry (the last one added for this footprint's tick)
        for( const pending of this._pending.values() ){
          if( pending.footprint.tickObserved === footprint.tickObserved
              && !pending.resolved ){
            pending.intermediates.push({
              step,
              result,
              timestamp: wallClock(),
            })
            break
          }
        }
      },
    }
  }

  // ── Internal: intermediate draining ──────────────────────

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
  private _drainIntermediates(
    _currentTick: Tick,
    context: SimulationContext,
    _events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>>,
    commands: StateCommands
  ): void {
    for( const pending of this._pending.values() ){
      if( pending.resolved ) continue

      // Apply any intermediates that haven't been applied yet
      // (They were already applied via stream.report() inline,
      // but this catches any edge case where intermediates arrived
      // outside the stream callback path)
      for( const entry of pending.intermediates ){
        const intermediateCommands = this.onIntermediateResult(
          entry.step, entry.result, pending.footprint, context
        )

        if( intermediateCommands ){
          this._mergeCommands( commands, intermediateCommands )
        }
      }
    }
  }

  // ── Internal: completion collection ──────────────────────

  /**
   * Collect all completed reasoning, validate against current state,
   * and merge validated commands into the provided collections.
   */
  private async _collectCompleted(
    currentTick: Tick,
    currentState: ReadonlySimulationState,
    context: SimulationContext,
    events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>>,
    commands: StateCommands
  ): Promise<void> {
    const completed: PendingReasoning[] = []

    for( const pending of this._pending.values() ){
      if( pending.settled && !pending.resolved )
        completed.push( pending )
    }

    for( const pending of completed ){
      pending.resolved = true

      let rawOutput: unknown
      try {
        rawOutput = await pending.promise
      }
      catch( error ){
        logger.error(
          `[AsyncEngine] ${this.name} reasoning at tick ${pending.startedAtTick} failed:`,
          error
        )
        this._pending.delete( pending.key )
        continue
      }

      // Conflict detection on final result
      const report = this._detector.detect( pending.footprint, currentState )

      if( report.hasConflicts ){
        this.onConflictRejected( pending.footprint, report, context )

        const strategy = this.chooseStrategy( pending.footprint, context )

        if( strategy === 'FORCE'){
          // Apply the full reasoning result despite conflicts —
          // intendedCommands is always empty so we must call onReasoningComplete.
          const resultCommands = this.onReasoningComplete( rawOutput, pending.footprint, context )
          this._mergeCommands( commands, resultCommands )
        }
        else {
          const resolution = this._detector.resolve( report, strategy )

          if( resolution.resolvedCommands )
            this._mergeCommands( commands, resolution.resolvedCommands )

          if( resolution.shouldRerun && this._config.rerunOnRejection ){
            // Re-run with current state — new footprint, new stream
            const newFootprint = this.readState( currentState, currentTick )
            const newStream = this._createStream( newFootprint, context, events, commands )
            const newPromise = this.reasonAsync( newFootprint, currentState, context, newStream )

            this._pendingCounter++
            const key = `${this.name}-${this._pendingCounter}-tick${currentTick}-rerun`

            const rerunEntry: PendingReasoning = {
              key,
              footprint: newFootprint,
              promise: newPromise,
              startedAtTick: currentTick,
              intermediates: [],
              settled: false,
              resolved: false,
            }

            newPromise.then(
              () => { rerunEntry.settled = true },
              () => { rerunEntry.settled = true }
            )

            this._pending.set( key, rerunEntry )
          }
        }

        // Clean up the original pending entry
        this._pending.delete( pending.key )
      }
      else {
        // Clean commit — no conflicts
        const resultCommands = this.onReasoningComplete( rawOutput, pending.footprint, context )
        this._mergeCommands( commands, resultCommands )

        // Clean up
        this._pending.delete( pending.key )
      }
    }
  }

  // ── Internal: stale pruning ──────────────────────────────

  /**
   * Remove pending operations that have exceeded maxPendingTicks.
   */
  private _pruneStale( currentTick: Tick ): void {
    const maxAge = this._config.maxPendingTicks!

    for( const [ key, pending ] of this._pending ){
      if( currentTick - pending.startedAtTick > maxAge ){
        this._pending.delete( key )
        logger.warn(
          `[AsyncEngine] ${this.name} pruned stale reasoning from tick ${pending.startedAtTick} (current: ${currentTick})`
        )
      }
    }
  }

  // ── Internal: command merging ────────────────────────────

  /**
   * Merge validated StateCommands into the collector.
   * Preserves arrays — appends set, delete, and metrics entries.
   */
  private _mergeCommands( target: StateCommands, source: StateCommands ): void {
    if( source.set?.length ){
      target.set ??= []
      target.set.push( ...source.set )
    }

    if( source.delete?.length ){
      target.delete ??= []
      target.delete.push( ...source.delete )
    }

    if( source.metrics?.length ){
      target.metrics ??= []
      target.metrics.push( ...source.metrics )
    }
  }
}
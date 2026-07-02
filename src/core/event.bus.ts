// ─────────────────────────────────────────────────────────────
// src/core/event.bus.ts
// ─────────────────────────────────────────────────────────────

import type { SimulationEvent, SimulationEventBase, SimulationContext, Tick, Timestamp } from '#core/types'
import { wallClock } from '#core/wall.clock'

export type EventHandler<T = unknown> = ( event: SimulationEvent<T>, context: SimulationContext ) => void | Promise<void>
export type EventFilter = ( event: SimulationEventBase ) => boolean

export interface EventBus {
  /**
   * Enqueue an event for dispatch at end of the current tick.
   * Prevents silent corruption from events stamped with tick 0. 
   * Callers must explicitly pass the current tick from the orchestrator.
   */
  publish<T>(
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext,
    tick: Tick
  ): void

  /**
   * Enqueue and immediately flush if the queue is below the sync threshold.
   * Useful outside of a managed tick loop.
   */
  publishAsync<T>(
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext,
    tick: Tick
  ): Promise<void>

  /**
   * Schedule an event to be injected into the pending queue at a future tick.
   * The Orchestrator calls prepareTick() each tick to drain due events.
   */
  scheduleAt<T>(
    scheduledTick: Tick,
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext
  ): void

  /**
   * Move all scheduled events whose tick ≤ currentTick into the pending queue.
   * Called by the Orchestrator at the start of each tick, before engines run.
   */
  prepareTick( currentTick: Tick ): void

  /**
   * Drain and dispatch all pending events synchronously (within the current
   * async frame).  Called by the Orchestrator at end of each tick, after all
   * commands have been applied.
   */
  flush(): Promise<void>

  subscribe<T>( eventType: string, handler: EventHandler<T> ): () => void
  subscribeFiltered( filter: EventFilter, handler: EventHandler ): () => void
  subscribeAll( handler: EventHandler ): () => void

  clear(): void
  getPendingCount(): number
}

export interface EventBusConfig {
  maxQueueSize?: number
  syncThreshold?: number
  /**
   * Sim-time source for event timestamps. Events land in the event log, so the
   * timestamp must come from the sim clock (not wall time) for replay fidelity
   * (R2). Defaults to `wallClock` for standalone/non-orchestrated use; the
   * Simulation wires this to `clock.now`.
   */
  now?: () => Timestamp
}

// ── Internal types ───────────────────────────────────────────

interface PendingEntry {
  event: SimulationEvent
  context: SimulationContext
}

interface ScheduledEntry {
  tick: Tick
  event: SimulationEvent
  context: SimulationContext
}

// ── Implementation ───────────────────────────────────────────

export class DefaultEventBus implements EventBus {
  private _handlers         = new Map<string, Set<EventHandler>>()
  private _filteredHandlers = new Map<EventFilter, Set<EventHandler>>()
  private _allHandlers      = new Set<EventHandler>()
  private _pendingEvents:   PendingEntry[] = []
  private _scheduledEvents: ScheduledEntry[] = []  // sorted ascending by tick
  private _isProcessing   = false
  private _maxQueueSize: number
  private _syncThreshold: number
  private _now: () => Timestamp
  // Monotonic event-id counter. Event ids land in the replay stream, so they
  // must be deterministic across identical runs for byte-identical replay (R2);
  // a per-bus counter incremented in publish/schedule order replaces randomUUID().
  private _eventSeq = 0

  constructor( config: EventBusConfig = {} ){
    this._maxQueueSize  = config.maxQueueSize ?? 10000
    this._syncThreshold = config.syncThreshold ?? 100
    this._now           = config.now ?? wallClock
  }

  // ── Publish ─────────────────────────────────────────────

  /**
   * Events are always stamped with the caller-provided tick 
   * to prevent default-to-zero bugs.
   */
  publish<T>(
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext,
    tick: Tick
  ): void {
    const fullEvent = this._stamp<T>( event, tick )
    this._enqueue( fullEvent, context )
  }

  async publishAsync<T>(
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext,
    tick: Tick
  ): Promise<void> {
    const fullEvent = this._stamp<T>( event, tick )
    this._enqueue( fullEvent, context )

    this._pendingEvents.length <= this._syncThreshold && await this.flush()
  }

  private _stamp<T>(
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    tick: Tick
  ): SimulationEvent<T> {
    return {
      ...event,
      id:        `evt-${this._eventSeq++}`,
      timestamp: this._now(),
      tick,
    } as SimulationEvent<T>
  }

  private _enqueue( event: SimulationEvent, context: SimulationContext ): void {
    if( this._pendingEvents.length >= this._maxQueueSize )
      throw new Error(`Event bus queue full (${this._maxQueueSize}). Dropping event: ${event.type}`)

    this._pendingEvents.push({ event, context })

    // Trigger async processing for standalone (non-orchestrated) use.
    // When the Orchestrator is driving ticks it calls flush() explicitly;
    // the setImmediate fires after that and finds an empty queue — no-op.
    !this._isProcessing && setImmediate( () => { this._processBackground() } )
  }

  // ── Future-event priority queue ─────────────────────────

  scheduleAt<T>(
    scheduledTick: Tick,
    event: Omit<SimulationEvent<T>, 'id' | 'timestamp' | 'tick'>,
    context: SimulationContext
  ): void {
    const fullEvent: SimulationEvent<T> = {
      ...event,
      id:        `evt-${this._eventSeq++}`,
      timestamp: this._now(),
      tick:      scheduledTick,
    } as SimulationEvent<T>

    // Binary-search insertion to maintain ascending tick order — O(log n)
    const entry: ScheduledEntry = { tick: scheduledTick, event: fullEvent, context }
    let lo = 0, hi = this._scheduledEvents.length

    while( lo < hi ){
      const mid = ( lo + hi ) >>> 1
      this._scheduledEvents[mid]!.tick <= scheduledTick ? lo = mid + 1 : hi = mid
    }

    this._scheduledEvents.splice( lo, 0, entry )
  }

  prepareTick( currentTick: Tick ): void {
    // Find the first entry beyond the current tick — O(log n) scan
    let i = 0
    while( i < this._scheduledEvents.length && this._scheduledEvents[i]!.tick <= currentTick )
      i++

    if( i === 0 ) return

    // Move due events into the pending queue (preserving scheduled tick)
    const due = this._scheduledEvents.splice( 0, i )
    for( const entry of due )
      this._pendingEvents.push({ event: entry.event, context: entry.context })
  }

  // ── Flush ───────────────────────────────────────────────

  async flush(): Promise<void> {
    await this._process()
  }

  /**
   * Background processing — triggered via setImmediate for standalone use.
   * Silently swallows errors to avoid unhandled-rejection noise in that path.
   */
  private _processBackground(): void {
    this._process().catch( () => {} )
  }

  private async _process(): Promise<void> {
    if( this._isProcessing ) return
    if( this._pendingEvents.length === 0 ) return

    this._isProcessing = true

    try {
      // Loop so that events published by handlers in the same flush are
      // dispatched before we yield back to the caller.
      while( this._pendingEvents.length > 0 ){
        const batch = this._pendingEvents.splice( 0 )
        for( const { event, context } of batch )
          await this._dispatch( event, context )
      }
    }
    finally {
      this._isProcessing = false
    }
  }

  private async _dispatch( event: SimulationEvent, context: SimulationContext ): Promise<void> {
    // Type-specific handlers
    const handlers = this._handlers.get( event.type )
    if( handlers )
      for( const handler of handlers )
        await handler( event, context )

    // Filtered handlers
    for( const [ filter, handlersSet ] of this._filteredHandlers )
      filter( event ) && await Promise.all( [ ...handlersSet ].map( h => h( event, context ) ) )

    // All-catch handlers
    for( const handler of this._allHandlers )
      await handler( event, context )
  }

  // ── Subscriptions ────────────────────────────────────────

  subscribe<T>( eventType: string, handler: EventHandler<T> ): () => void {
    !this._handlers.has( eventType ) && this._handlers.set( eventType, new Set() )
    this._handlers.get( eventType )!.add( handler as EventHandler )

    return () => {
      this._handlers.get( eventType )?.delete( handler as EventHandler )
      this._handlers.get( eventType )?.size === 0 && this._handlers.delete( eventType )
    }
  }

  subscribeFiltered( filter: EventFilter, handler: EventHandler ): () => void {
    !this._filteredHandlers.has( filter ) && this._filteredHandlers.set( filter, new Set() )
    this._filteredHandlers.get( filter )!.add( handler )

    return () => {
      this._filteredHandlers.get( filter )?.delete( handler )
      this._filteredHandlers.get( filter )?.size === 0 && this._filteredHandlers.delete( filter )
    }
  }

  subscribeAll( handler: EventHandler ): () => void {
    this._allHandlers.add( handler )
    return () => { this._allHandlers.delete( handler ) }
  }

  // ── Housekeeping ─────────────────────────────────────────

  clear(): void {
    this._handlers.clear()
    this._filteredHandlers.clear()
    this._allHandlers.clear()
    this._pendingEvents    = []
    this._scheduledEvents  = []
  }

  getPendingCount(): number {
    return this._pendingEvents.length
  }
}
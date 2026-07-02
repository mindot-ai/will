// ─────────────────────────────────────────────────────────────
// src/cognition/bus.ts
// ─────────────────────────────────────────────────────────────

/**
 * CognitiveBus — inter-engine communication layer.
 *
 * Distinct from the existing DefaultEventBus (simulation event notifications,
 * tick-scoped, for SSE/session logging). This bus handles:
 *   - Typed CognitiveEvent delivery between engines
 *   - Per-engine FIFO ordering (KPN-derived guarantee)
 *   - Lamport logical clock for causal ordering
 *   - Schema validation at publish time via SchemaRegistry
 *   - Persistent event log before delivery
 *   - Salience scoring so subscribers can filter by significance
 *
 * Topic scheme: {engine}.{category}.{signal}
 *   e.g. 'stress.zone.critical', 'executive.interpretation.formed', 'clock.tick'
 *
 * Wildcard matching: 'stress.*' matches any topic starting with 'stress.'
 *
 * Two implementations:
 *   - DefaultCognitiveBus  — queued delivery, flushed on demand (production)
 *   - SyncCognitiveBus     — immediate synchronous delivery (test bus)
 */

import { logger } from '#core/logger'
import { globalSchemaRegistry, type SchemaRegistry } from '#cognition/schema.registry'
import type { EventLog } from '#cognition/event.log'
import type { StateCommands } from '#core/types'
import { wallClock } from '#core/wall.clock'

// ── SimulationContext augmentation ───────────────────────────
// Adds cognitiveBus as an optional field on SimulationContext so
// engines can access it via context.cognitiveBus without touching core types.
declare module '#core/types' {
  interface SimulationContext {
    cognitiveBus?: CognitiveBus
  }
}

// ── CognitiveEvent type ──────────────────────────────────────

export interface CognitiveEvent<T = unknown> {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly sourceEngine: string
  readonly sequenceNumber: number
  readonly logicalTime: number
  readonly wallTime: number
  readonly salience: number
  readonly payload: T
}

// ── Transport abstraction ────────────────────────────────────

export type CognitiveEventHandler = ( event: CognitiveEvent ) => StateCommands | void

export interface CognitiveBusTransport {
  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler ): void
  unsubscribe( engineId: string ): void
  deliver( event: CognitiveEvent, matchedEngines: string[] ): void
  flush(): void
}

// ── Subscription store ───────────────────────────────────────

interface Subscription {
  engineId: string
  topics: string[]
  handler: CognitiveEventHandler
}

function topicMatches( pattern: string, topic: string ): boolean {
  if( pattern === '*' ) return true   // global workspace subscription
  if( pattern === topic ) return true
  if( pattern.endsWith('.*') ){
    const prefix = pattern.slice( 0, -2 )
    return topic === prefix || topic.startsWith( prefix + '.' )
  }
  return false
}

// ── Per-category inbox policy (Phase A) ─────────────────────
// critical — goal changes, executive broadcasts, effector events: never dropped
// metric   — *.state.changed, clock.tick, high-frequency signals: drop-oldest on overflow

const METRIC_QUEUE_MAX = 500

function isCriticalEvent( type: string ): boolean {
  return type.startsWith('executive.')
    || type.startsWith('goal.')
    || type.startsWith('effector.')
    || type.startsWith('action.')
    || type === 'engine.snapshot'
}

// ── In-process transport (production) ───────────────────────

export class InProcessCognitiveTransport implements CognitiveBusTransport {
  private _subscriptions = new Map<string, Subscription>()
  // Critical queue — unbounded, never dropped
  private _criticalQueue: Array<{ event: CognitiveEvent; targets: string[] }> = []
  // Metric queue — bounded with drop-oldest on overflow
  private _metricQueue:   Array<{ event: CognitiveEvent; targets: string[] }> = []
  private _droppedCount = 0

  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler ): void {
    this._subscriptions.set( engineId, { engineId, topics, handler })
  }

  unsubscribe( engineId: string ): void {
    this._subscriptions.delete( engineId )
  }

  deliver( event: CognitiveEvent, matchedEngines: string[] ): void {
    if( isCriticalEvent( event.type ) ){
      this._criticalQueue.push({ event, targets: matchedEngines })
    } else {
      if( this._metricQueue.length >= METRIC_QUEUE_MAX ){
        this._metricQueue.shift()   // drop oldest metric event
        this._droppedCount++
        if( this._droppedCount % 100 === 1 )
          logger.warn(`[CognitiveBus] metric queue overflow — dropped ${this._droppedCount} events`)
      }
      this._metricQueue.push({ event, targets: matchedEngines })
    }
  }

  flush(): void {
    // Critical events delivered first, then metrics (preserves priority ordering)
    const batch = [ ...this._criticalQueue.splice(0), ...this._metricQueue.splice(0) ]
    for( const { event, targets } of batch ){
      for( const engineId of targets ){
        const sub = this._subscriptions.get( engineId )
        if( sub ) sub.handler( event )
      }
    }
  }

  get droppedCount(): number { return this._droppedCount }

  matchSubscribers( topic: string ): string[] {
    const matched: string[] = []
    for( const sub of this._subscriptions.values() ){
      if( sub.topics.some( p => topicMatches( p, topic ) ) )
        matched.push( sub.engineId )
    }
    return matched
  }
}

// ── Synchronous transport (test bus) ────────────────────────

/**
 * Delivers events immediately and synchronously in publish order.
 * Required for deterministic unit and integration tests.
 */
export class SyncCognitiveBusTransport implements CognitiveBusTransport {
  private _subscriptions = new Map<string, Subscription>()

  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler ): void {
    this._subscriptions.set( engineId, { engineId, topics, handler })
  }

  unsubscribe( engineId: string ): void {
    this._subscriptions.delete( engineId )
  }

  deliver( event: CognitiveEvent, matchedEngines: string[] ): void {
    for( const engineId of matchedEngines ){
      const sub = this._subscriptions.get( engineId )
      if( sub ) sub.handler( event )
    }
  }

  flush(): void { /* no-op — already delivered synchronously */ }

  matchSubscribers( topic: string ): string[] {
    const matched: string[] = []
    for( const sub of this._subscriptions.values() ){
      if( sub.topics.some( p => topicMatches( p, topic ) ) )
        matched.push( sub.engineId )
    }
    return matched
  }
}

// ── CognitiveBus interface ───────────────────────────────────

export type AcceptsVersionsFn = ( eventType: string ) => number[]

export interface CognitiveBus {
  publish( event: Omit<CognitiveEvent, 'id' | 'sequenceNumber' | 'logicalTime' | 'wallTime'> ): void
  /** acceptsVersions — optional per-subscriber version filter (Phase A). */
  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn ): void
  unsubscribe( engineId: string ): void
  flush(): void
  /** Drain and return all StateCommands returned by onCognitiveEvent() handlers since last drain. */
  drainCommands(): StateCommands[]
  logicalTime: number
}

// ── DefaultCognitiveBus ──────────────────────────────────────

export class DefaultCognitiveBus implements CognitiveBus {
  private _transport: InProcessCognitiveTransport
  private _registry: SchemaRegistry
  private _log: EventLog | null
  private _lamportClock = 0
  private _sequenceNumbers = new Map<string, number>()
  private _counter = 0
  private _pendingCommands: StateCommands[] = []

  constructor(
    transport: InProcessCognitiveTransport,
    registry: SchemaRegistry = globalSchemaRegistry,
    log: EventLog | null = null
  ){
    this._transport = transport
    this._registry  = registry
    this._log       = log
  }

  get logicalTime(): number { return this._lamportClock }

  publish( partial: Omit<CognitiveEvent, 'id' | 'sequenceNumber' | 'logicalTime' | 'wallTime'> ): void {
    if( this._registry.hasType( partial.type ) ){
      const error = this._registry.validate( partial.type, partial.version, partial.payload )
      if( error ) throw new Error(`CognitiveBus schema violation [${partial.type} v${partial.version}]: ${error}`)
    }

    const seq = ( this._sequenceNumbers.get( partial.sourceEngine ) ?? 0 ) + 1
    this._sequenceNumbers.set( partial.sourceEngine, seq )
    this._lamportClock++

    const event: CognitiveEvent = {
      ...partial,
      id: `cog-${this._lamportClock}-${++this._counter}`,
      sequenceNumber: seq,
      logicalTime: this._lamportClock,
      wallTime: wallClock(),  // telemetry only; logicalTime is the deterministic clock
    }

    this._log?.append( event )

    const targets = this._transport.matchSubscribers( event.type )
    if( targets.length > 0 )
      this._transport.deliver( event, targets )
  }

  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn ): void {
    this._transport.subscribe( engineId, topics, this._wrapHandler( handler, acceptsVersions ) )
  }

  unsubscribe( engineId: string ): void {
    this._transport.unsubscribe( engineId )
  }

  flush(): void {
    this._transport.flush()
  }

  drainCommands(): StateCommands[] {
    const cmds = this._pendingCommands
    this._pendingCommands = []
    return cmds
  }

  private _wrapHandler( handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn ): CognitiveEventHandler {
    const registry = this._registry
    return ( event: CognitiveEvent ) => {
      let result: StateCommands | void = undefined
      if( !acceptsVersions ){
        result = handler( event )
      } else {
        const accepted = acceptsVersions( event.type )
        if( accepted.length === 0 || accepted.includes( event.version ) ){
          result = handler( event )
        } else {
          const migrated = registry.tryMigrate( event.type, event.version, event.payload )
          if( migrated.ok && ( accepted.length === 0 || accepted.includes( migrated.targetVersion ) ) )
            result = handler({ ...event, version: migrated.targetVersion, payload: migrated.payload })
        }
      }
      if( result ) this._pendingCommands.push( result )
    }
  }
}

// ── SyncCognitiveBus ─────────────────────────────────────────

export class SyncCognitiveBus implements CognitiveBus {
  private _transport: SyncCognitiveBusTransport
  private _registry: SchemaRegistry
  private _log: EventLog | null
  private _lamportClock = 0
  private _sequenceNumbers = new Map<string, number>()
  private _counter = 0
  private _pendingCommands: StateCommands[] = []

  constructor(
    transport: SyncCognitiveBusTransport,
    registry: SchemaRegistry = globalSchemaRegistry,
    log: EventLog | null = null
  ){
    this._transport = transport
    this._registry  = registry
    this._log       = log
  }

  get logicalTime(): number { return this._lamportClock }

  publish( partial: Omit<CognitiveEvent, 'id' | 'sequenceNumber' | 'logicalTime' | 'wallTime'> ): void {
    if( this._registry.hasType( partial.type ) ){
      const error = this._registry.validate( partial.type, partial.version, partial.payload )
      if( error ) throw new Error(`SyncCognitiveBus schema violation [${partial.type} v${partial.version}]: ${error}`)
    }

    const seq = ( this._sequenceNumbers.get( partial.sourceEngine ) ?? 0 ) + 1
    this._sequenceNumbers.set( partial.sourceEngine, seq )
    this._lamportClock++

    const event: CognitiveEvent = {
      ...partial,
      id: `cog-${this._lamportClock}-${++this._counter}`,
      sequenceNumber: seq,
      logicalTime: this._lamportClock,
      wallTime: wallClock(),  // telemetry only; logicalTime is the deterministic clock
    }

    this._log?.append( event )

    const targets = this._transport.matchSubscribers( event.type )
    if( targets.length > 0 )
      this._transport.deliver( event, targets )
  }

  subscribe( engineId: string, topics: string[], handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn ): void {
    this._transport.subscribe( engineId, topics, this._wrapHandler( handler, acceptsVersions ) )
  }

  unsubscribe( engineId: string ): void {
    this._transport.unsubscribe( engineId )
  }

  flush(): void { /* no-op for sync transport */ }

  drainCommands(): StateCommands[] {
    const cmds = this._pendingCommands
    this._pendingCommands = []
    return cmds
  }

  private _wrapHandler( handler: CognitiveEventHandler, acceptsVersions?: AcceptsVersionsFn ): CognitiveEventHandler {
    const registry = this._registry
    return ( event: CognitiveEvent ) => {
      let result: StateCommands | void = undefined
      if( !acceptsVersions ){
        result = handler( event )
      } else {
        const accepted = acceptsVersions( event.type )
        if( accepted.length === 0 || accepted.includes( event.version ) ){
          result = handler( event )
        } else {
          const migrated = registry.tryMigrate( event.type, event.version, event.payload )
          if( migrated.ok && ( accepted.length === 0 || accepted.includes( migrated.targetVersion ) ) )
            result = handler({ ...event, version: migrated.targetVersion, payload: migrated.payload })
        }
      }
      if( result ) this._pendingCommands.push( result )
    }
  }
}

// ── Factory helpers ──────────────────────────────────────────

export function createProductionBus(
  log: EventLog | null = null,
  registry = globalSchemaRegistry
): DefaultCognitiveBus {
  return new DefaultCognitiveBus( new InProcessCognitiveTransport(), registry, log )
}

export function createTestBus(
  log: EventLog | null = null,
  registry = globalSchemaRegistry
): SyncCognitiveBus {
  return new SyncCognitiveBus( new SyncCognitiveBusTransport(), registry, log )
}

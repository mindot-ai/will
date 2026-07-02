// ─────────────────────────────────────────────────────────────
// src/core/distributed.ts
// ─────────────────────────────────────────────────────────────

/**
 * Distributed simulation support for multi-node execution.
 * Supports partitioning by entity type, geographic region, or custom sharding.
 */

import type { StateManager } from '#core/state.manager'
import type { SimulationState, SimulationContext, SimulationEntity, Tick, Timestamp, SimulationEvent, RestoreOptions, StateCommands } from '#core/types'
import { createContext } from '#core/utils'
import { wallClock } from '#core/wall.clock'

export type ShardStrategy = 'by-entity-type' | 'by-entity-id-hash' | 'by-region' | 'custom'
export type ConsistencyLevel = 'strong' | 'eventual' | 'causal'
export type DeliveryGuarantee = 'at-most-once' | 'at-least-once' | 'exactly-once'

export interface ShardConfig {
  index: number
  total: number
  strategy: ShardStrategy
  entityTypes?: string[]  // for by-entity-type strategy
  regionBounds?: { minX: number; maxX: number; minY: number; maxY: number }  // for by-region
}

export interface DistributedNodeConfig {
  nodeId: string
  shard: ShardConfig
  coordinatorUrl?: string
  heartbeatIntervalMs?: number
  syncIntervalMs?: number
  consistencyLevel?: ConsistencyLevel
}

export interface ShardAssignment {
  nodeId: string
  shard: ShardConfig
  status: 'active' | 'standby' | 'failed'
  lastHeartbeat: Timestamp
}

export interface DistributedEvent<T = unknown> extends SimulationEvent<T, {
  originatingNode: string
  shardIndex: number
  isCrossShard: boolean
  targetShard?: number
}> {}

export interface RemoteNode {
  nodeId: string
  shard: ShardConfig
  send( event: SimulationEvent, context: SimulationContext ): Promise<void>
  query( request: CrossShardQuery ): Promise<CrossShardResult>
}

export interface CrossShardQuery {
  type: 'get-entity' | 'get-entities-by-type' | 'get-metric'
  entityId?: string
  entityType?: string
  metricKey?: string
  shardTarget?: number
}

export interface CrossShardResult {
  success: boolean
  data: unknown
  fromNode: string
  timestamp: Timestamp
}

export interface PartitionRouter {
  getShardForEntity( entity: SimulationEntity, totalShards: number ): number
  getShardForMetric( metricKey: string, totalShards: number ): number
  isLocalEntity( entityId: string, shardConfig: ShardConfig ): boolean
}

export class ConsistentHashRouter implements PartitionRouter {
  private _virtualNodes: number

  constructor( virtualNodes: number = 150 ){
    this._virtualNodes = virtualNodes
  }

  getShardForEntity( entity: SimulationEntity, totalShards: number ): number {
    const key = `${entity.type}:${entity.id}`
    return this._hashToShard( key, totalShards )
  }

  getShardForMetric( metricKey: string, totalShards: number ): number {
    return this._hashToShard(`metric:${metricKey}`, totalShards )
  }

  isLocalEntity( entityId: string, shardConfig: ShardConfig ): boolean {
    const
    hash = this._hash( entityId ),
    shardIndex = hash % shardConfig.total

    return shardIndex === shardConfig.index
  }

  private _hashToShard( key: string, totalShards: number ): number {
    return this._hash( key ) % totalShards
  }

  /**
   * Use FNV-1a hash for better distribution.
   * Replaces the weak djb2 variant.
   */
  private _hash( key: string ): number {
    let hash = 2166136261  // FNV offset basis
    for( let i = 0; i < key.length; i++ ) {
      hash ^= key.charCodeAt( i )
      hash = Math.imul( hash, 16777619 )  // FNV prime
    }
    return hash >>> 0
  }
}

export class DefaultPartitionRouter implements PartitionRouter {
  private _strategy: ShardStrategy
  private _regionSize: number

  constructor( strategy: ShardStrategy = 'by-entity-id-hash', regionSize: number = 100 ){
    this._strategy = strategy
    this._regionSize = regionSize
  }

  getShardForEntity( entity: SimulationEntity, totalShards: number ): number {
    switch( this._strategy ){
      case 'by-entity-type': return this._hash( entity.type ) % totalShards
      case 'by-entity-id-hash': return this._hash( entity.id ) % totalShards
      case 'by-region': {
        const coords = entity.metadata?.position as { x: number; y: number } | undefined
        if( !coords ) return 0

        const
        regionX = Math.floor( coords.x / this._regionSize ),
        regionY = Math.floor( coords.y / this._regionSize )

        return ( regionX * 31 + regionY ) % totalShards
      }
      default: return this._hash( entity.id ) % totalShards
    }
  }

  getShardForMetric( metricKey: string, totalShards: number ): number {
    return this._hash( metricKey ) % totalShards
  }

  isLocalEntity( entityId: string, shardConfig: ShardConfig ): boolean {
    const
    hash = this._hash( entityId ),
    assignedShard = hash % shardConfig.total

    return assignedShard === shardConfig.index
  }

  private _hash( key: string ): number {
    let hash = 5381
    for( let i = 0; i < key.length; i++ )
      hash = ( ( hash << 5 ) + hash ) + key.charCodeAt( i )
    
    return Math.abs( hash )
  }
}

/**
 * Transport interface with timeout, retry, circuit breaker
 * semantics, and delivery guarantees.
 */
export interface CrossShardTransport {
  send( targetNode: string, event: DistributedEvent, context: SimulationContext ): Promise<void>
  broadcast( event: DistributedEvent, context: SimulationContext ): Promise<void>
  query( targetNode: string, query: CrossShardQuery, timeoutMs?: number ): Promise<CrossShardResult>
  registerHandler( handler: CrossShardHandler ): void

  /** Configure delivery guarantee for subsequent sends. */
  setDeliveryGuarantee( guarantee: DeliveryGuarantee ): void
  
  /** Configure retry policy. */
  setRetryPolicy( maxRetries: number, backoffMs: number ): void
  
  /** Returns circuit breaker status for a node. */
  isCircuitOpen( nodeId: string ): boolean
  
  /** Reset circuit breaker for a node. */
  resetCircuit( nodeId: string ): void
}

export type CrossShardHandler = ( event: DistributedEvent, context: SimulationContext ) => Promise<void>

export class LocalTransport implements CrossShardTransport {
  private _nodes: Map<string, LocalTransportNode> = new Map()
  private _handlers: Set<CrossShardHandler> = new Set()
  private _deliveryGuarantee: DeliveryGuarantee = 'at-least-once'
  private _maxRetries = 3
  private _backoffMs = 100
  private _circuitBreakers: Map<string, { failures: number; open: boolean; lastFailure: number }> = new Map()

  registerNode( nodeId: string, transport: LocalTransportNode ): void {
    this._nodes.set( nodeId, transport )
  }

  async send( targetNode: string, event: DistributedEvent, context: SimulationContext ): Promise<void> {
    const node = this._nodes.get( targetNode )
    if( !node )
      throw new Error(`Node not found: ${targetNode}`)

    // Circuit breaker check
    if( this.isCircuitOpen( targetNode ) )
      throw new Error(`Circuit breaker open for node: ${targetNode}`)

    // Retry logic
    let lastError: Error | null = null
    for( let attempt = 0; attempt <= this._maxRetries; attempt++ ){
      try {
        await node.receive( event, context )
        this._recordSuccess( targetNode )
        return
      }
      catch( error ){
        lastError = error as Error
        this._recordFailure( targetNode )
        if( attempt < this._maxRetries )
          await this._delay( this._backoffMs * Math.pow( 2, attempt ) )
      }
    }

    if( this._deliveryGuarantee === 'at-least-once')
      throw lastError ?? new Error(`Failed to send to ${targetNode} after ${this._maxRetries} retries`)
    
    // at-most-once: silently drop after retries exhausted
  }

  async broadcast( event: DistributedEvent, context: SimulationContext ): Promise<void> {
    await Promise.all( Array.from( this._nodes.values() ).map( node => node.receive( event, context ) ) )
  }

  async query( targetNode: string, query: CrossShardQuery, timeoutMs: number = 5000 ): Promise<CrossShardResult> {
    const node = this._nodes.get( targetNode )
    if( !node )
      return { success: false, data: null, fromNode: targetNode, timestamp: wallClock() }

    // Timeout support
    const result = await Promise.race([
      node.handleQuery( query ),
      new Promise<CrossShardResult>( ( _, reject ) =>
        setTimeout( () => reject( new Error(`Query timeout to ${targetNode}`) ), timeoutMs )
      )
    ])

    return result as CrossShardResult
  }

  registerHandler( handler: CrossShardHandler ): void {
    this._handlers.add( handler )
  }

  // ── Configuration setters ──────────────────────────────

  setDeliveryGuarantee( guarantee: DeliveryGuarantee ): void {
    this._deliveryGuarantee = guarantee
  }

  setRetryPolicy( maxRetries: number, backoffMs: number ): void {
    this._maxRetries = maxRetries
    this._backoffMs = backoffMs
  }

  isCircuitOpen( nodeId: string ): boolean {
    return this._circuitBreakers.get( nodeId )?.open ?? false
  }

  resetCircuit( nodeId: string ): void {
    this._circuitBreakers.set( nodeId, { failures: 0, open: false, lastFailure: 0 } )
  }

  private _recordSuccess( nodeId: string ): void {
    this._circuitBreakers.set( nodeId, { failures: 0, open: false, lastFailure: 0 } )
  }

  private _recordFailure( nodeId: string ): void {
    const current = this._circuitBreakers.get( nodeId ) ?? { failures: 0, open: false, lastFailure: 0 }
    current.failures++
    current.lastFailure = wallClock()

    // Open circuit after 5 consecutive failures
    if( current.failures >= 5 )
      current.open = true

    this._circuitBreakers.set( nodeId, current )
  }

  private async _delay( ms: number ): Promise<void> {
    return new Promise( resolve => setTimeout( resolve, ms ) )
  }

  async _dispatch( event: DistributedEvent, context: SimulationContext ): Promise<void> {
    for( const handler of this._handlers )
      await handler( event, context )
  }
}

export interface LocalTransportNode {
  receive( event: DistributedEvent, context: SimulationContext ): Promise<void>
  handleQuery( query: CrossShardQuery ): Promise<CrossShardResult>
}

export class DistributedStateManager implements StateManager, LocalTransportNode {
  private _localState: StateManager
  private _router: PartitionRouter
  private _shardConfig: ShardConfig
  private _transport: LocalTransport
  private _nodeId: string
  private _pendingCrossShardEvents: DistributedEvent[] = []
  private _syncInterval: NodeJS.Timeout | null = null

  constructor(
    localState: StateManager,
    router: PartitionRouter,
    shardConfig: ShardConfig,
    transport: LocalTransport,
    nodeId: string,
    syncIntervalMs: number = 1000
  ){
    this._localState = localState
    this._router = router
    this._shardConfig = shardConfig
    this._transport = transport
    this._nodeId = nodeId

    if( syncIntervalMs > 0 )
      this._syncInterval = setInterval( () => this._sync(), syncIntervalMs )
  }

  get currentTick(): Tick { return this._localState.currentTick }
  get currentTime(): Timestamp { return this._localState.currentTime }

  updateClock( tick: Tick, time: Timestamp ): void {
    this._localState.updateClock( tick, time )
  }

  getEntity<T extends SimulationEntity>( id: string ): T | undefined {
    if( this._router.isLocalEntity( id, this._shardConfig ) )
      return this._localState.getEntity<T>( id )

    return undefined
  }

  /**
   * Async cross-shard entity access.
   * Returns undefined for entities not found on the target shard.
   */
  async getEntityAsync<T extends SimulationEntity>( id: string ): Promise<T | undefined> {
    if( this._router.isLocalEntity( id, this._shardConfig ) )
      return this._localState.getEntity<T>( id )

    // Route to the appropriate shard
    const dummyEntity: SimulationEntity = { id, type: '', createdAt: 0, updatedAt: 0 }
    const targetShard = this._router.getShardForEntity( dummyEntity, this._shardConfig.total )
    const targetNode = `node-${targetShard}`

    try {
      const result = await this._transport.query( targetNode, { type: 'get-entity', entityId: id })
      return result.success ? ( result.data as T ) : undefined
    }
    catch { return undefined }
  }

  setEntity( entity: SimulationEntity ): void {
    const targetShard = this._router.getShardForEntity( entity, this._shardConfig.total )

    if( targetShard === this._shardConfig.index )
      this._localState.setEntity( entity )
    
    else this._pendingCrossShardEvents.push({
          id: crypto.randomUUID(), // determinism-ok: cross-shard coordination id at the cross-node boundary (already wallClock-stamped)
          type: 'shard.entity.set',
          timestamp: wallClock(),
          tick: this.currentTick,
          source: this._nodeId,
          payload: entity,
          metadata: {
            originatingNode: this._nodeId,
            shardIndex: this._shardConfig.index,
            isCrossShard: true,
            targetShard
          }
        })
  }

  deleteEntity( id: string ): boolean {
    if( this._router.isLocalEntity( id, this._shardConfig ) )
      return this._localState.deleteEntity( id )
    
    return false
  }

  getAllEntities(): IterableIterator<SimulationEntity> {
    return this._localState.getAllEntities()
  }

  getEntitiesByType( type: string ): SimulationEntity[] {
    return this._localState.getEntitiesByType( type )
  }

  getMetric( key: string ): number | undefined {
    const targetShard = this._router.getShardForMetric( key, this._shardConfig.total )
    if( targetShard === this._shardConfig.index )
      return this._localState.getMetric( key )

    return undefined
  }

  setMetric( key: string, value: number ): void {
    const targetShard = this._router.getShardForMetric( key, this._shardConfig.total )

    if( targetShard === this._shardConfig.index )
      this._localState.setMetric( key, value )
    
    else this._pendingCrossShardEvents.push({
          id: crypto.randomUUID(), // determinism-ok: cross-shard coordination id at the cross-node boundary (already wallClock-stamped)
          type: 'shard.metric.set',
          timestamp: wallClock(),
          tick: this.currentTick,
          source: this._nodeId,
          payload: { key, value },
          metadata: {
            originatingNode: this._nodeId,
            shardIndex: this._shardConfig.index,
            isCrossShard: true,
            targetShard
          }
        })
  }

  incrementMetric( key: string, delta: number = 1 ): number {
    const targetShard = this._router.getShardForMetric( key, this._shardConfig.total )

    if( targetShard === this._shardConfig.index )
      return this._localState.incrementMetric( key, delta )

    this._pendingCrossShardEvents.push({
      id: crypto.randomUUID(), // determinism-ok: cross-shard coordination id at the cross-node boundary (already wallClock-stamped)
      type: 'shard.metric.increment',
      timestamp: wallClock(),
      tick: this.currentTick,
      source: this._nodeId,
      payload: { key, delta },
      metadata: {
        originatingNode: this._nodeId,
        shardIndex: this._shardConfig.index,
        isCrossShard: true,
        targetShard
      }
    })

    const current = this._localState.getMetric( key ) ?? 0
    return current + delta
  }

  snapshot(): SimulationState {
    return this._localState.snapshot()
  }

  restore( snapshot: SimulationState, options?: RestoreOptions ): void {
    this._localState.restore( snapshot, options )
  }

  applyCommands( commands: StateCommands ): void {
    this._localState.applyCommands( commands )
  }

  clear(): void {
    this._localState.clear()
  }

  async receive( event: DistributedEvent, _context: SimulationContext ): Promise<void> {
    switch( event.type ) {
      case 'shard.entity.set':
        this._localState.setEntity( event.payload as SimulationEntity )
        break

      case 'shard.metric.set':
        const { key, value } = event.payload as { key: string; value: number }
        this._localState.setMetric( key, value )
        break

      case 'shard.metric.increment':
        const { key: incKey, delta } = event.payload as { key: string; delta: number }
        this._localState.incrementMetric( incKey, delta )
        break

      default:
        break
    }
  }

  async handleQuery( query: CrossShardQuery ): Promise<CrossShardResult> {
    switch( query.type ){
      case 'get-entity':
        if( !query.entityId )
          return { success: false, data: null, fromNode: this._nodeId, timestamp: wallClock() }
        
        return {
          success: true,
          data: this._localState.getEntity( query.entityId ),
          fromNode: this._nodeId,
          timestamp: wallClock()
        }

      case 'get-entities-by-type':
        if( !query.entityType )
          return { success: false, data: null, fromNode: this._nodeId, timestamp: wallClock() }
        
        return {
          success: true,
          data: this._localState.getEntitiesByType( query.entityType ),
          fromNode: this._nodeId,
          timestamp: wallClock()
        }

      case 'get-metric':
        if( !query.metricKey )
          return { success: false, data: null, fromNode: this._nodeId, timestamp: wallClock() }
        
        return {
          success: true,
          data: this._localState.getMetric( query.metricKey ),
          fromNode: this._nodeId,
          timestamp: wallClock()
        }

      default:
        return { success: false, data: null, fromNode: this._nodeId, timestamp: wallClock() }
    }
  }

  flushPendingEvents(): DistributedEvent[] {
    return this._pendingCrossShardEvents.splice( 0 )
  }

  private async _sync(): Promise<void> {
    const events = this.flushPendingEvents()
    for( const event of events ) {
      const targetShard = event.metadata?.targetShard

      if( targetShard !== undefined && targetShard !== this._shardConfig.index ){
        const targetNode = `node-${targetShard}`
        await this._transport.send( targetNode, event, createContext('distributed', this._nodeId ) )
      }
    }
  }

  destroy(): void {
    this._syncInterval && clearInterval( this._syncInterval )
  }
}

export class DistributedOrchestrator {
  private _nodes: Map<string, DistributedNode> = new Map()
  private _router: PartitionRouter
  private _transport: LocalTransport
  private _coordinatorId: string | null = null

  constructor( router: PartitionRouter = new DefaultPartitionRouter() ){
    this._router = router
    this._transport = new LocalTransport()
  }

  addNode( config: DistributedNodeConfig, localState: StateManager ): DistributedNode {
    const distributedState = new DistributedStateManager(
      localState,
      this._router,
      config.shard,
      this._transport,
      config.nodeId,
      config.syncIntervalMs
    )

    const node: DistributedNode = {
      nodeId: config.nodeId,
      shard: config.shard,
      stateManager: distributedState,
      transport: this._transport,
      status: 'active',
    }

    this._nodes.set( config.nodeId, node )
    this._transport.registerNode( config.nodeId, distributedState )

    if( config.coordinatorUrl && !this._coordinatorId )
      this._coordinatorId = config.nodeId

    return node
  }

  getNode( nodeId: string ): DistributedNode | undefined {
    return this._nodes.get( nodeId )
  }

  getAllNodes(): DistributedNode[] {
    return Array.from( this._nodes.values() )
  }

  async broadcast( event: DistributedEvent, context: SimulationContext ): Promise<void> {
    await this._transport.broadcast( event, context )
  }

  async sendToShard( shardIndex: number, event: DistributedEvent, context: SimulationContext ): Promise<void> {
    const node = Array.from( this._nodes.values() ).find( n => n.shard.index === shardIndex )
    if( !node )
      throw new Error(`No node found for shard ${shardIndex}`)

    await this._transport.send( node.nodeId, event, context )
  }
}

export interface DistributedNode {
  nodeId: string
  shard: ShardConfig
  stateManager: DistributedStateManager
  transport: CrossShardTransport
  status: 'active' | 'standby' | 'failed'
}
// ─────────────────────────────────────────────────────────────
// src/core/serialization.ts
// ─────────────────────────────────────────────────────────────

/**
 * Serialization/Deserialization for simulation state.
 * Supports JSON and binary (length-prefixed JSON, upgradeable to MessagePack).
 */

import type { SimulationState, SimulationEntity, Tick, Timestamp } from '#core/types'
import { BunStorageAdapter, type StorageAdapter } from '#core/abstracts'
import { wallClock } from '#core/wall.clock'

export type SerializationFormat = 'json' | 'binary'

export interface SerializedEntity {
  id: string
  type: string
  createdAt: number
  updatedAt: number
  /** Sim tick of the last write — needed by ConflictDetector after a restore. */
  updatedAtTick?: number
  metadata?: Record<string, unknown>
  components: Record<string, unknown>
}

export interface SerializedState {
  version: string
  format: SerializationFormat
  schema: string
  tick: Tick
  time: Timestamp
  entities: SerializedEntity[]
  metrics: Array<[string, number]>
  createdAt: Timestamp
  checksum?: string
}

export interface Serializer {
  serialize( state: SimulationState, format?: SerializationFormat ): string | Uint8Array
  deserialize( data: string | Uint8Array, format?: SerializationFormat ): SimulationState
  export( state: SimulationState, path: string ): Promise<void>
  import( path: string ): Promise<SimulationState>
}

export interface SerializationConfig {
  format?: SerializationFormat
  compress?: boolean
  includeChecksum?: boolean
  schemaVersion?: string
  prettyPrint?: boolean
  storage?: StorageAdapter
}

export class DefaultSerializer implements Serializer {
  private _config: SerializationConfig
  private _encoder = new TextEncoder()
  private _decoder = new TextDecoder()
  private _storage: StorageAdapter

  constructor( config: SerializationConfig = {} ){
    this._config = {
      format: config.format ?? 'json',
      compress: config.compress ?? false,
      includeChecksum: config.includeChecksum ?? true,
      schemaVersion: config.schemaVersion ?? '1.0.0',
      prettyPrint: config.prettyPrint ?? false
    }

    this._storage = config.storage ?? new BunStorageAdapter()
  }

  serialize( state: SimulationState, format: SerializationFormat = this._config.format! ): string | Uint8Array {
    const serialized = this._toSerialized( state )

    switch( format ){
      case 'json': return this._config.prettyPrint
                       ? JSON.stringify( serialized, null, 2 )
                       : JSON.stringify( serialized )

      case 'binary': return this._toBinary( serialized )
      default: throw new Error(`Unknown format: ${format}`)
    }
  }

  deserialize( data: string | Uint8Array, _format?: SerializationFormat ): SimulationState {
    let serialized: SerializedState

    if( typeof data === 'string')
      serialized = JSON.parse( data ) as SerializedState

    else {
      const firstByte = data[0]
      serialized = firstByte === 0x7B  // '{' in ASCII — JSON wrapped in bytes
                     ? JSON.parse( this._decoder.decode( data ) )
                     : this._fromBinary( data )
    }

    return this._fromSerialized( serialized )
  }

  async export( state: SimulationState, path: string ): Promise<void> {
    const
    serialized = this.serialize( state ),
    content = typeof serialized === 'string'
                   ? serialized
                   : JSON.stringify( Array.from( serialized ) )

    await this._storage.write( path, content )
  }

  async import( path: string ): Promise<SimulationState> {
    if( !( await this._storage.exists( path ) ) )
      throw new Error(`File not found: ${path}`)

    const content = await this._storage.read( path )
    return this.deserialize( content )
  }

  // ── Serialization ────────────────────────────────────────

  private _toSerialized( state: SimulationState ): SerializedState {
    const entities: SerializedEntity[] = []

    for( const entity of state.entities.values() ){
      const components: Record<string, unknown> = entity.metadata?.components as Record<string, unknown> ?? {}

      entities.push({
        id: entity.id,
        type: entity.type,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        updatedAtTick: entity.updatedAtTick,
        // metadata/components are free-form `Record<string, unknown>`; encode so
        // Map/Set/Date/undefined survive the JSON round-trip instead of being
        // silently flattened or dropped (FN15). Plain JSON values pass through.
        metadata: entity.metadata === undefined
          ? undefined
          : this._encodeSpecial( entity.metadata ) as Record<string, unknown>,
        components: this._encodeSpecial( components ) as Record<string, unknown>,
      })
    }

    // Build base without checksum first — checksum must be computed
    // over a stable object that does not include the checksum field itself.
    const base: Omit<SerializedState, 'checksum'> = {
      version: this._config.schemaVersion!,
      format: this._config.format!,
      schema: 'simulation-state-v1',
      tick: state.tick,
      time: state.time,
      entities,
      metrics: Array.from( state.metrics.entries() ),
      createdAt: wallClock(),
    }

    return this._config.includeChecksum
      ? { ...base, checksum: this._computeChecksum( base ) }
      : base as SerializedState
  }

  private _fromSerialized( serialized: SerializedState ): SimulationState {
    if( this._config.includeChecksum && serialized.checksum ){
      // Destructure checksum out before verifying — the hash must be computed
      // over the same field set used during write (i.e. without the checksum field).
      const
      { checksum, ...rest } = serialized,
      computed = this._computeChecksum( rest )

      if( computed !== checksum )
        throw new Error('Checksum mismatch — data may be corrupted')
    }

    const entities = new Map<string, SimulationEntity>()
    for( const e of serialized.entities ){
      // Reverse the FN15 encoding: revive Map/Set/Date/undefined that were
      // tagged on the way out.
      const metadata = e.metadata === undefined
        ? undefined
        : this._decodeSpecial( e.metadata ) as Record<string, unknown>
      const components = this._decodeSpecial( e.components ) as Record<string, unknown>

      entities.set( e.id, {
        id: e.id,
        type: e.type,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        updatedAtTick: e.updatedAtTick,
        metadata: { ...metadata, components },
      })
    }

    return {
      tick: serialized.tick,
      time: serialized.time,
      entities,
      metrics: new Map( serialized.metrics ),
    }
  }

  // ── Special-value encoding (FN15) ────────────────────────
  //
  // Entity metadata/components are free-form `Record<string, unknown>`. Plain
  // `JSON.stringify` silently loses anything that is not JSON-native: `Map` and
  // `Set` flatten to `{}`, `Date` becomes a string that never revives, and
  // `undefined`-valued keys vanish. We tag those values on the way out and
  // revive them on the way in so the round-trip is lossless.
  //
  // Encoding is a reserved-key scheme: `{ __ser: <kind>, __val: <payload> }`.
  // Objects that already carry a `__ser` string key are a (documented) edge we
  // accept — metadata is engine-internal, not user-controlled.

  private _encodeSpecial( value: unknown ): unknown {
    if( value === undefined )      return { __ser: 'undefined' }
    if( value === null )           return null
    if( value instanceof Date )    return { __ser: 'date', __val: value.toISOString() }
    if( value instanceof Map )
      return { __ser: 'map', __val: Array.from( value.entries() )
        .map( ([ k, v ]) => [ this._encodeSpecial( k ), this._encodeSpecial( v ) ] ) }
    if( value instanceof Set )
      return { __ser: 'set', __val: Array.from( value.values() ).map( v => this._encodeSpecial( v ) ) }
    if( Array.isArray( value ) )
      return value.map( v => this._encodeSpecial( v ) )

    if( typeof value === 'object' ){
      const out: Record<string, unknown> = {}
      for( const [ k, v ] of Object.entries( value as Record<string, unknown> ) )
        out[k] = this._encodeSpecial( v )
      return out
    }

    return value  // string | number | boolean (bigint/symbol/function unchanged from prior behaviour)
  }

  private _decodeSpecial( value: unknown ): unknown {
    if( value === null || typeof value !== 'object' ) return value
    if( Array.isArray( value ) ) return value.map( v => this._decodeSpecial( v ) )

    const tag = ( value as Record<string, unknown> ).__ser
    if( typeof tag === 'string' ){
      const payload = ( value as Record<string, unknown> ).__val
      switch( tag ){
        case 'undefined': return undefined
        case 'date':      return new Date( payload as string ) // determinism-ok: reviving a stored Date, not reading current time
        case 'map':       return new Map(
          ( payload as unknown[] ).map( pair => {
            const [ k, v ] = pair as [ unknown, unknown ]
            return [ this._decodeSpecial( k ), this._decodeSpecial( v ) ] as [ unknown, unknown ]
          })
        )
        case 'set':       return new Set( ( payload as unknown[] ).map( v => this._decodeSpecial( v ) ) )
      }
    }

    const out: Record<string, unknown> = {}
    for( const [ k, v ] of Object.entries( value as Record<string, unknown> ) )
      out[k] = this._decodeSpecial( v )
    return out
  }

  // ── Binary encoding ──────────────────────────────────────

  private _toBinary( state: SerializedState ): Uint8Array {
    // Length-prefixed JSON (uint32 big-endian header).
    // Upgrade path: swap JSON.stringify for MessagePack/CBOR without
    // changing the framing protocol.
    const
    json = JSON.stringify( state ),
    bytes = this._encoder.encode( json ),
    result = new Uint8Array( bytes.length + 4 )

    result[0] = ( bytes.length >> 24 ) & 0xFF
    result[1] = ( bytes.length >> 16 ) & 0xFF
    result[2] = ( bytes.length >>  8 ) & 0xFF
    result[3] = bytes.length & 0xFF

    result.set( bytes, 4 )
    return result
  }

  private _fromBinary( data: Uint8Array ): SerializedState {
    if( data.length < 4 )
      throw new Error('Invalid binary data: too short')

    const length =
      ( ( data[0] ?? 0 ) << 24 ) |
      ( ( data[1] ?? 0 ) << 16 ) |
      ( ( data[2] ?? 0 ) <<  8 ) |
        ( data[3] ?? 0 )

    if( data.length - 4 < length )
      throw new Error('Invalid binary data: length mismatch')

    const json = this._decoder.decode( data.slice( 4, 4 + length ) )
    return JSON.parse( json ) as SerializedState
  }

  // ── Checksum ─────────────────────────────────────────────

  /**
   * djb2 hash over meaningful content fields.
   *
   * Coverage:
   *   - tick + time       → catches clock corruption
   *   - entity id:type:updatedAt + encoded metadata/components per entity
   *     → catches add/remove/mutate AND (de)serialization round-trip loss
   *   - metric key:value per entry → catches any metric corruption
   *
   * metadata/components are now hashed directly (FN15): excluding them meant a
   * value silently dropped on serialization (a Map flattening to `{}`, a missing
   * `undefined` key) left `updatedAt` unchanged and so passed the integrity check
   * undetected. The values are hashed in their already-encoded form, so the
   * checksum computed at serialize time matches the one verified at deserialize
   * time (the decode happens only after verification).
   */
  private _computeChecksum( state: Omit<SerializedState, 'checksum'> ): string {
    let hash = 0

    // Timeline anchor — catches tick/time tampering
    const header = `${state.tick}:${state.time}:${state.entities.length}:${state.metrics.length}`
    for( let i = 0; i < header.length; i++ ){
      hash = ( ( hash << 5 ) - hash ) + header.charCodeAt( i )
      hash |= 0
    }

    // Per-entity identity, mutation timestamp, and (encoded) metadata/components
    for( const e of state.entities ){
      const str = `${e.id}:${e.type}:${e.updatedAt}:${e.updatedAtTick}:${JSON.stringify( e.metadata )}:${JSON.stringify( e.components )}`
      for( let i = 0; i < str.length; i++ ){
        hash = ( ( hash << 5 ) - hash ) + str.charCodeAt( i )
        hash |= 0
      }
    }

    // Full metric key-value coverage
    for( const [ key, value ] of state.metrics ){
      const str = `${key}:${value}`
      for( let i = 0; i < str.length; i++ ){
        hash = ( ( hash << 5 ) - hash ) + str.charCodeAt( i )
        hash |= 0
      }
    }

    return ( hash >>> 0 ).toString( 16 )
  }
}

// ── Delta encoding ───────────────────────────────────────────

export interface DeltaSnapshot {
  baseTick: Tick
  currentTick: Tick
  /**
   * The simulation `time` recorded at `currentTick`. Captured at encode time so
   * decode reconstructs the real timestamp instead of fabricating one from a
   * hardcoded tick interval (FN14): the clock's per-tick duration is
   * configurable (`fixedDeltaMs`) and scaled (`timeScale`), so `time` is not a
   * fixed multiple of the tick number.
   */
  time: Timestamp
  addedEntities: SimulationEntity[]
  removedEntityIds: string[]
  updatedEntities: Array<{ id: string; changes: Partial<SimulationEntity> }>
  metricsDelta: Array<[string, number]>
}

export class DeltaEncoder {
  encode( previous: SimulationState, current: SimulationState ): DeltaSnapshot {
    const
    addedEntities: SimulationEntity[] = [],
    removedEntityIds: string[] = [],
    updatedEntities: Array<{ id: string; changes: Partial<SimulationEntity> }> = []

    for( const id of previous.entities.keys() )
      !current.entities.has( id ) && removedEntityIds.push( id )

    for( const [ id, currentEntity ] of current.entities ){
      const previousEntity = previous.entities.get( id )
      if( !previousEntity ){
        addedEntities.push( currentEntity )
        continue
      }

      if( JSON.stringify( previousEntity ) !== JSON.stringify( currentEntity ) ){
        const changes: Partial<SimulationEntity> = {}

        if( previousEntity.type !== currentEntity.type ) changes.type = currentEntity.type
        if( previousEntity.updatedAt !== currentEntity.updatedAt ) changes.updatedAt = currentEntity.updatedAt
        if( JSON.stringify( previousEntity.metadata ) !== JSON.stringify( currentEntity.metadata ) )
          changes.metadata = currentEntity.metadata

        updatedEntities.push({ id, changes })
      }
    }

    const metricsDelta: Array<[string, number]> = []
    for( const [ key, currentValue ] of current.metrics ){
      const previousValue = previous.metrics.get( key )
      previousValue !== currentValue && metricsDelta.push([ key, currentValue - ( previousValue ?? 0 ) ])
    }

    for( const [ key ] of previous.metrics )
      !current.metrics.has( key ) && metricsDelta.push([ key, -Infinity ])

    return {
      baseTick: previous.tick,
      currentTick: current.tick,
      time: current.time,
      addedEntities,
      removedEntityIds,
      updatedEntities,
      metricsDelta,
    }
  }

  decode( base: SimulationState, delta: DeltaSnapshot ): SimulationState {
    const
    entities = new Map( base.entities ),
    metrics = new Map( base.metrics )

    for( const id of delta.removedEntityIds )
      entities.delete( id )

    for( const entity of delta.addedEntities )
      entities.set( entity.id, entity )

    for( const { id, changes } of delta.updatedEntities ){
      const existing = entities.get( id )
      existing && entities.set( id, { ...existing, ...changes } )
    }

    for( const [ key, deltaValue ] of delta.metricsDelta ){
      deltaValue === -Infinity
            ? metrics.delete( key )
            : metrics.set( key, ( metrics.get( key ) ?? 0 ) + deltaValue )
    }

    return {
      tick: delta.currentTick,
      // Use the timestamp recorded at encode time. Falls back to the base time
      // only for legacy deltas that predate the `time` field — never the old
      // fabricated `+ (Δtick) * 16` value (FN14).
      time: delta.time ?? base.time,
      entities,
      metrics
    }
  }
}
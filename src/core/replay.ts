// ─────────────────────────────────────────────────────────────
// src/core/replay.ts
// ─────────────────────────────────────────────────────────────

/**
 * Deterministic replay system for debugging and analysis.
 * Records all inputs/events and allows frame-accurate replay.
 */

import type { SimulationContext, SimulationEvent, Tick, Timestamp } from '#core/types'
import { BunStorageAdapter, type StorageAdapter } from '#core/abstracts'
import { DeltaEncoder } from '#core/serialization'
import type { DeltaSnapshot } from '#core/serialization'
import type { LLMCompletionRecord, LLMCompletionSink } from '#core/completion.recorder'
import type { InboundRecord, InboundSink } from '#core/inbound.recorder'
import { wallClock } from '#core/wall.clock'

export interface ReplayRecord {
  tick: Tick
  timestamp: Timestamp
  events: SimulationEvent[]
  delta?: DeltaSnapshot
}

export interface ReplayMetadata {
  simulationId: string
  runId: string
  startTime: Timestamp
  endTime: Timestamp
  totalTicks: Tick
  totalEvents: number
  totalCompletions: number
  /** Count of recorded external inbound envelopes (messages/percepts/acks). */
  totalInbound?: number
  randomSeed: number
  version: string
  tags: Record<string, string>
}

export interface ReplaySession {
  readonly metadata: ReplayMetadata
  readonly currentTick: Tick
  readonly isPlaying: boolean
  readonly isPaused: boolean
  readonly speed: number
  play(): void
  pause(): void
  stop(): void
  seekToTick( tick: Tick ): Promise<void>
  seekToTime( time: Timestamp ): Promise<void>
  stepForward( count?: number ): Promise<SimulationEvent[]>
  stepBackward( count?: number ): Promise<SimulationEvent[]>
  setSpeed( speed: number ): void
  export(): Promise<Uint8Array>
}

export interface ReplayRecorder extends LLMCompletionSink, InboundSink {
  recordEvent( event: SimulationEvent, context: SimulationContext ): void
  recordTick( tick: Tick, events: SimulationEvent[] ): void
  recordCompletion( record: LLMCompletionRecord ): void
  recordInbound( record: InboundRecord ): void
  flush(): Promise<void>
  save( path: string ): Promise<void>
  getMetadata(): ReplayMetadata
  close(): void
}

/** On-disk shape of a flush segment: a batch of tick records + completions. */
interface ReplaySegment {
  records: ReplayRecord[]
  completions: LLMCompletionRecord[]
  inbound?: InboundRecord[]
}

export interface ReplayConfig {
  bufferSize?: number
  flushIntervalMs?: number
  compress?: boolean
  recordDeltas?: boolean
  maxEventsPerTick?: number
  /**
   * Base path for incremental flush segments. When set, flush() persists the
   * buffered records to `${flushBasePath}.partN.json` and clears the buffer;
   * save() consolidates the segments back into the final file. When unset,
   * flush() retains records in memory (still no data loss) until save().
   */
  flushBasePath?: string
}

// ── Recorder ─────────────────────────────────────────────────

export class DefaultReplayRecorder implements ReplayRecorder {
  private _records: ReplayRecord[] = []
  private _completions: LLMCompletionRecord[] = []
  private _inbound: InboundRecord[] = []
  private _metadata: ReplayMetadata
  private _config: ReplayConfig
  private _bufferSize: number
  private _flushInterval: NodeJS.Timeout | null = null
  private _deltaEncoder: DeltaEncoder
  private _storage: StorageAdapter
  private _flushBasePath: string | undefined
  private _segments: string[] = []
  private _segmentCount = 0

  constructor(
    simulationId: string,
    runId: string,
    randomSeed: number = wallClock(),
    config: ReplayConfig = {},
    storage: StorageAdapter = new BunStorageAdapter()
  ){
    this._config = config
    this._bufferSize = config.bufferSize ?? 1000
    this._deltaEncoder = new DeltaEncoder()
    this._storage = storage
    this._flushBasePath = config.flushBasePath

    this._metadata = {
      simulationId,
      runId,
      startTime: wallClock(),
      endTime: 0,
      totalTicks: 0,
      totalEvents: 0,
      totalCompletions: 0,
      totalInbound: 0,
      randomSeed,
      version: '1.0.0',
      tags: {}
    }

    if( config.flushIntervalMs && config.flushIntervalMs > 0 )
      this._flushInterval = setInterval( () => this.flush(), config.flushIntervalMs )
  }

  recordEvent( event: SimulationEvent, _context: SimulationContext ): void {
    let record = this._records.find( r => r.tick === event.tick )
    if( !record ){
      record = { tick: event.tick, timestamp: event.timestamp, events: [] }
      this._records.push( record )
    }

    record.events.push( event )
    this._metadata.totalEvents++

    this._records.length >= this._bufferSize && this.flush().catch( () => {} )
  }

  recordTick( tick: Tick, events: SimulationEvent[] ): void {
    this._records.push({ tick, timestamp: wallClock(), events: [ ...events ] })
    this._metadata.totalEvents += events.length
    this._metadata.totalTicks = tick

    this._records.length >= this._bufferSize && this.flush().catch( () => {} )
  }

  /**
   * Record an LLM completion (input + output + model/params) into the replay
   * stream. The LLM is the system's non-deterministic oracle; capturing each
   * completion is the prerequisite for deterministic re-execution (REORIENT R2,
   * deferred) and is the gap FN3 calls out. Completions ride along with tick
   * records through the same flush/segment/save pipeline.
   */
  recordCompletion( record: LLMCompletionRecord ): void {
    this._completions.push( record )
    this._metadata.totalCompletions++

    this._records.length >= this._bufferSize && this.flush().catch( () => {} )
  }

  /**
   * Record an external inbound envelope (message/percept/ack) at the tick it was
   * applied. The transport is a non-deterministic input — capturing each envelope
   * is the prerequisite for re-injecting them on a deterministic re-execution
   * replay. Rides the same flush/segment/save pipeline as completions.
   */
  recordInbound( record: InboundRecord ): void {
    this._inbound.push( record )
    this._metadata.totalInbound = ( this._metadata.totalInbound ?? 0 ) + 1

    this._records.length >= this._bufferSize && this.flush().catch( () => {} )
  }

  async flush(): Promise<void> {
    if( this._records.length === 0 && this._completions.length === 0 ) return

    // Without a persistence target, retain records in memory so they survive
    // until save() — never discard (the previous behaviour silently lost all
    // history once the buffer rolled over at bufferSize).
    if( !this._flushBasePath ) return

    // Swap the buffers out and reserve the segment name synchronously before
    // any await: recordTick fires flush() without awaiting and keeps pushing,
    // so concurrent flushes must each get a fresh array and a unique segment
    // name (reading _segmentCount after the await would collide and overwrite).
    const batch: ReplaySegment = { records: this._records, completions: this._completions, inbound: this._inbound }
    this._records     = []
    this._completions = []
    this._inbound     = []
    const segPath   = `${this._flushBasePath}.part${this._segmentCount}.json`
    this._segmentCount++
    this._segments.push( segPath )

    try {
      await this._storage.write( segPath, JSON.stringify( batch ) )
    }
    catch( err ){
      // Persisting failed — drop the reservation and fold the batch back in
      // (ahead of newer records) so save() still captures it from memory.
      this._segments    = this._segments.filter( s => s !== segPath )
      this._records     = batch.records.concat( this._records )
      this._completions = batch.completions.concat( this._completions )
      this._inbound     = ( batch.inbound ?? [] ).concat( this._inbound )
      throw err
    }
  }

  async save( path: string ): Promise<void> {
    // Consolidate any flushed segments with the live buffers so nothing is lost
    // across buffer rollovers.
    const records: ReplayRecord[] = []
    const completions: LLMCompletionRecord[] = []
    const inbound: InboundRecord[] = []
    for( const seg of this._segments ){
      try {
        const parsed = JSON.parse( await this._storage.read( seg ) ) as ReplaySegment
        records.push( ...( parsed.records ?? [] ) )
        completions.push( ...( parsed.completions ?? [] ) )
        inbound.push( ...( parsed.inbound ?? [] ) )
      } catch { /* segment unreadable — skip rather than abort the save */ }
    }
    records.push( ...this._records )
    completions.push( ...this._completions )
    inbound.push( ...this._inbound )

    const output = {
      metadata: { ...this._metadata, endTime: wallClock() },
      config:   this._config,
      records,
      completions,
      inbound,
    }
    await this._storage.write( path, JSON.stringify( output, null, 2 ) )

    // Clean up consolidated segment files.
    const del = this._storage.delete
    if( del )
      for( const seg of this._segments )
        await del.call( this._storage, seg ).catch( () => {} )

    this._segments = []
    this._segmentCount = 0
    this._records = []
    this._completions = []
    this._inbound = []
  }

  getMetadata(): ReplayMetadata {
    return { ...this._metadata }
  }

  close(): void {
    this._flushInterval && clearInterval( this._flushInterval )
    this._metadata.endTime = wallClock()
    this.flush().catch( () => {} )
  }
}

// ── Session ──────────────────────────────────────────────────

export class DefaultReplaySession implements ReplaySession {
  private _records: ReplayRecord[]
  private _metadata: ReplayMetadata
  private _currentIndex = 0
  private _isPlaying = false
  private _isPaused = false
  private _speed = 1.0
  private _playInterval: NodeJS.Timeout | null = null
  private _eventHandlers: Array<( event: SimulationEvent ) => void> = []

  constructor( records: ReplayRecord[], metadata: ReplayMetadata ){
    this._records = records.sort( ( a, b ) => a.tick - b.tick )
    this._metadata = metadata
  }

  get metadata(): ReplayMetadata { return { ...this._metadata } }
  get currentTick(): Tick           { return this._records[this._currentIndex]?.tick ?? 0 }
  get isPlaying(): boolean        { return this._isPlaying }
  get isPaused(): boolean        { return this._isPaused }
  get speed(): number         { return this._speed }

  // ── Playback ─────────────────────────────────────────────

  play(): void {
    if( this._isPlaying ) return

    this._isPlaying = true
    this._isPaused = false

    this._playInterval = setInterval( () => {
      if( !this._isPlaying || this._isPaused ) return
      if( this._currentIndex >= this._records.length - 1 ){
        this.stop()
        return
      }

      this._currentIndex++
      this._emitEventsForCurrentTick()
    }, 16 / this._speed )  // ~60fps base
  }

  pause(): void {
    this._isPaused = true
  }

  stop(): void {
    this._isPlaying = false
    this._isPaused = false
    this._playInterval && clearInterval( this._playInterval )
    this._playInterval = null
  }

  async seekToTick( targetTick: Tick ): Promise<void> {
    const wasPlaying = this._isPlaying
    if( wasPlaying ) this.pause()

    let index = this._records.findIndex( r => r.tick >= targetTick )
    if( index === -1 ) index = this._records.length - 1
    if( index <   0  ) index = 0

    this._currentIndex = index
    await this._emitEventsForCurrentTick()

    wasPlaying && this.play()
  }

  async seekToTime( targetTime: Timestamp ): Promise<void> {
    const wasPlaying = this._isPlaying
    wasPlaying && this.pause()

    let index = this._records.findIndex( r => r.timestamp >= targetTime )
    if( index === -1 ) index = this._records.length - 1
    if( index <   0  ) index = 0

    this._currentIndex = index
    await this._emitEventsForCurrentTick()

    wasPlaying && this.play()
  }

  async stepForward( count: number = 1 ): Promise<SimulationEvent[]> {
    const events: SimulationEvent[] = []

    for( let i = 0; i < count; i++ ){
      if( this._currentIndex >= this._records.length - 1 ) break

      this._currentIndex++
      const tickEvents = await this._emitEventsForCurrentTick()
      events.push( ...tickEvents )
    }

    return events
  }

  async stepBackward( count: number = 1 ): Promise<SimulationEvent[]> {
    const events: SimulationEvent[] = []

    for( let i = 0; i < count; i++ ){
      if( this._currentIndex <= 0 ) break

      this._currentIndex--
      const tickEvents = await this._emitEventsForCurrentTick()
      events.push( ...tickEvents )
    }

    return events
  }

  setSpeed( speed: number ): void {
    this._speed = Math.max( 0.1, Math.min( 10, speed ) )

    if( this._isPlaying && !this._isPaused ){
      this.stop()
      this.play()
    }
  }

  async export(): Promise<Uint8Array> {
    const encoder = new TextEncoder()
    return encoder.encode( JSON.stringify({ metadata: this._metadata, records: this._records }) )
  }

  onEvent( handler: ( event: SimulationEvent ) => void ): () => void {
    this._eventHandlers.push( handler )
    return () => {
      const index = this._eventHandlers.indexOf( handler )
      index !== -1 && this._eventHandlers.splice( index, 1 )
    }
  }

  /**
   * Binary search for a record at a specific tick.
   * O(log n) — records are sorted ascending by tick in the constructor.
   * Used by ReplayManager.compare() to avoid seekToTick side effects
   * and (session as any) type escapes.
   */
  getRecordAtTick( tick: Tick ): ReplayRecord | undefined {
    let lo = 0, hi = this._records.length - 1

    while( lo <= hi ){
      const mid = ( lo + hi ) >>> 1
      const t = this._records[mid]!.tick

      if( t === tick ) return this._records[mid]
      t < tick ? lo = mid + 1 : hi = mid - 1
    }

    return undefined
  }

  private async _emitEventsForCurrentTick(): Promise<SimulationEvent[]> {
    const record = this._records[this._currentIndex]
    if( !record ) return []

    for( const handler of this._eventHandlers )
      for( const event of record.events )
        handler( event )

    return record.events
  }
}

// ── Manager ──────────────────────────────────────────────────

export class ReplayManager {
  private _recorders: Map<string, DefaultReplayRecorder> = new Map()
  private _sessions: Map<string, DefaultReplaySession> = new Map()
  private _storage: StorageAdapter

  constructor( storage: StorageAdapter = new BunStorageAdapter() ){
    this._storage = storage
  }

  createRecorder(
    simulationId: string,
    runId: string,
    randomSeed?: number,
    config: ReplayConfig = {}
  ): DefaultReplayRecorder {
    const
    key = `${simulationId}:${runId}`,
    recorder = new DefaultReplayRecorder( simulationId, runId, randomSeed, config, this._storage )

    this._recorders.set( key, recorder )
    return recorder
  }

  getRecorder( simulationId: string, runId: string ): DefaultReplayRecorder | undefined {
    return this._recorders.get(`${simulationId}:${runId}`)
  }

  async loadReplay( path: string ): Promise<DefaultReplaySession> {
    if( !( await this._storage.exists( path ) ) )
      throw new Error(`Replay file not found: ${path}`)

    const content = await this._storage.read( path )
    const parsed = JSON.parse( content )

    if( !parsed.records || !parsed.metadata )
      throw new Error('Invalid replay file format')

    const
    session = new DefaultReplaySession( parsed.records, parsed.metadata ),
    key = `${parsed.metadata.simulationId}:${parsed.metadata.runId}`

    this._sessions.set( key, session )
    return session
  }

  getSession( simulationId: string, runId: string ): DefaultReplaySession | undefined {
    return this._sessions.get(`${simulationId}:${runId}`)
  }

  /**
   * Compare two replay files tick-by-tick.
   * Uses getRecordAtTick() for O(log n) lookup per tick — no seek side
   * effects, no type escapes into private session fields.
   */
  async compare( replay1Path: string, replay2Path: string ): Promise<ReplayComparison> {
    const
    session1 = await this.loadReplay( replay1Path ),
    session2 = await this.loadReplay( replay2Path ),
    differences: ReplayDifference[] = [],
    maxTicks = Math.max( session1.metadata.totalTicks, session2.metadata.totalTicks )

    for( let tick = 0; tick <= maxTicks; tick++ ){
      const
      events1 = session1.getRecordAtTick( tick )?.events ?? [],
      events2 = session2.getRecordAtTick( tick )?.events ?? []

      // Compare event counts
      if( events1.length !== events2.length )
        differences.push({
          tick,
          type: 'event-mismatch',
          expected: events1.length,
          actual: events2.length,
          path: `tick-${tick}.events.length`,
        })

      // Compare event types present at this tick
      const
      types1 = new Set( events1.map( e => e.type ) ),
      types2 = new Set( events2.map( e => e.type ) )

      for( const type of types1 )
        !types2.has( type ) && differences.push({
          tick,
          type: 'event-mismatch',
          expected: type,
          actual: '(missing)',
          path: `tick-${tick}.events.type.${type}`,
        })

      for( const type of types2 )
        !types1.has( type ) && differences.push({
          tick,
          type: 'event-mismatch',
          expected: '(missing)',
          actual: type,
          path: `tick-${tick}.events.type.${type}`,
        })

      // Compare individual event payloads in order
      const maxEvents = Math.max( events1.length, events2.length )
      for( let i = 0; i < maxEvents; i++ ){
        const
        e1 = events1[i],
        e2 = events2[i]

        if( !e1 || !e2 ){
          differences.push({
            tick,
            type: 'event-mismatch',
            expected: e1 ? `event[${i}]: ${e1.type}` : '(missing)',
            actual: e2 ? `event[${i}]: ${e2.type}` : '(missing)',
            path: `tick-${tick}.events[${i}]`,
          })
          continue
        }

        const
        payload1 = JSON.stringify( e1.payload ),
        payload2 = JSON.stringify( e2.payload )

        payload1 !== payload2 && differences.push({
          tick,
          type: 'event-mismatch',
          expected: e1.payload,
          actual: e2.payload,
          path: `tick-${tick}.events[${i}].payload`,
        })
      }
    }

    return {
      areIdentical: differences.length === 0,
      differences,
      totalTicksCompared: maxTicks,
    }
  }
}

// ── Supporting types ─────────────────────────────────────────

export interface ReplayComparison {
  areIdentical: boolean
  differences: ReplayDifference[]
  totalTicksCompared: number
}

export interface ReplayDifference {
  tick: Tick
  type: 'entity-mismatch' | 'metric-mismatch' | 'event-mismatch'
  expected: unknown
  actual: unknown
  path?: string
}
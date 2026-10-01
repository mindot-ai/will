// ─────────────────────────────────────────────────────────────
// src/cognition/event.log.ts
// ─────────────────────────────────────────────────────────────

/**
 * Append-only persistent event log.
 *
 * Every CognitiveEvent is written here before delivery so the full
 * causal history of the system is reconstructible at any logical time.
 * The log is the authoritative record; engine state is a derived projection.
 *
 * Storage: JSONL (one JSON object per line), pluggable backend via StorageAdapter.
 * Auto-flushes at AUTO_FLUSH_SIZE entries or when flush() is called explicitly.
 *
 * In-memory ring buffer is capped at MAX_IN_MEMORY entries to prevent OOM.
 */

import type { StorageAdapter } from '#core/abstracts'
import type { CognitiveEvent } from '#cognition/bus'

const AUTO_FLUSH_SIZE = 100
const MAX_IN_MEMORY   = 10_000

export interface EventLog {
  append( event: CognitiveEvent ): void
  flush(): Promise<void>
  recent( n?: number ): CognitiveEvent[]
  since( logicalTime: number ): CognitiveEvent[]
}

export class DefaultEventLog implements EventLog {
  private _path: string
  private _storage: StorageAdapter
  private _buffer: CognitiveEvent[] = []      // pending writes, not yet flushed
  private _memory:  CognitiveEvent[] = []      // in-memory ring (capped)
  private _flushing = false
  private _pendingFlush: Promise<void> | null = null

  constructor( path: string, storage: StorageAdapter ){
    this._path    = path
    this._storage = storage
  }

  append( event: CognitiveEvent ): void {
    this._buffer.push( event )

    // Ring buffer — drop oldest when full
    if( this._memory.length >= MAX_IN_MEMORY )
      this._memory.shift()
    this._memory.push( event )

    if( this._buffer.length >= AUTO_FLUSH_SIZE )
      this._triggerFlush().catch( () => {} )   // kept in the buffer; flush() reports it
  }

  /**
   * Write everything appended so far. It returned the flush already in flight,
   * so what arrived during that write was left in the buffer — at shutdown, the
   * last events of a run.
   */
  async flush(): Promise<void> {
    while( this._pendingFlush || this._buffer.length > 0 )
      await ( this._pendingFlush ?? this._triggerFlush() )
  }

  recent( n = 100 ): CognitiveEvent[] {
    return this._memory.slice( -n )
  }

  since( logicalTime: number ): CognitiveEvent[] {
    return this._memory.filter( e => e.logicalTime >= logicalTime )
  }

  // ── Internal ─────────────────────────────────────────────

  private async _triggerFlush(): Promise<void> {
    if( this._flushing || this._buffer.length === 0 ) return

    this._flushing = true
    const batch = this._buffer.splice( 0 )

    this._pendingFlush = this._writeBatch( batch ).catch( err => {
      this._buffer.unshift( ...batch )   // a failed write loses nothing; the next one retries
      throw err
    } ).finally( () => {
      this._flushing    = false
      this._pendingFlush = null
    })

    return this._pendingFlush
  }

  /**
   * Appended where the store can. It read the whole log and wrote it back with
   * a hundred more lines each time — a cost that grows with everything the mind
   * has ever done, paid every hundred events.
   */
  private async _writeBatch( batch: CognitiveEvent[] ): Promise<void> {
    const lines  = batch.map( e => JSON.stringify( e ) ).join('\n') + '\n'
    if( this._storage.append ) return this._storage.append( this._path, lines )

    let existing = ''

    try {
      if( await this._storage.exists( this._path ) )
        existing = await this._storage.read( this._path )
    } catch { /* file may not exist yet */ }

    await this._storage.ensureDir?.( this._path.replace( /\/[^/]+$/, '') )
    await this._storage.write( this._path, existing + lines )
  }
}

/** No-op log for testing or when persistence is not needed. */
export class NullEventLog implements EventLog {
  private _memory: CognitiveEvent[] = []

  append( event: CognitiveEvent ): void {
    if( this._memory.length >= MAX_IN_MEMORY ) this._memory.shift()
    this._memory.push( event )
  }

  flush(): Promise<void> { return Promise.resolve() }

  recent( n = 100 ): CognitiveEvent[] { return this._memory.slice( -n ) }

  since( logicalTime: number ): CognitiveEvent[] {
    return this._memory.filter( e => e.logicalTime >= logicalTime )
  }
}

// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport/stream.ts
// ─────────────────────────────────────────────────────────────
//
// StreamTransport — an in-process ExternalTransport.
//
// Selected the same way as LoopbackTransport / SocketIoTransport: pass an
// instance as `config.transport`. Everything the Will emits — replies, chunks,
// messages, and the observability channels (`session_log`, `token_report`) —
// is delivered to the consumer's subscribed listeners instead of being written
// to files or S3 inside the Will. The consumer owns persistence/forwarding
// (Postgres, S3, Kafka, a billing meter, an SSE feed).
//
// `injectInbound()` lets the consumer drive inbound envelopes (messages,
// percepts, acks) into the Will, mirroring LoopbackTransport.
//
// Files remain available in DEVELOPMENT only: the producers (SessionLogger,
// TokenTracker) keep a local file mirror behind `fileLoggingEnabled()`.
// ─────────────────────────────────────────────────────────────

import type {
  ExternalTransport,
  OutboundEnvelope,
  InboundEnvelope,
  AckResult,
  TransportStatus,
} from './types'

/** Channels a consumer can filter on (any OutboundEnvelope channel, or '*'). */
export type StreamChannel = OutboundEnvelope['channel'] | '*'
export type OutboundListener = ( env: OutboundEnvelope ) => void

export class StreamTransport implements ExternalTransport {
  readonly willId: string

  private _connected = true
  private readonly _outbound       = new Set<OutboundListener>()
  private readonly _outboundByCh   = new Map<string, Set<OutboundListener>>()
  private readonly _inboundHandlers = new Set<( env: InboundEnvelope ) => void>()
  private readonly _statusHandlers  = new Set<( s: TransportStatus ) => void>()

  constructor( willId: string = 'stream'){
    this.willId = willId
  }

  get connected(): boolean { return this._connected }

  // ── ExternalTransport: Will → consumer ──────────────────────

  /**
   * Deliver an outbound envelope to subscribers. In-process and synchronous, so
   * it resolves immediately (`via: 'event'`) — there is no remote peer to ack.
   * A listener that throws is isolated; it can never break the tick loop.
   */
  async emit( env: OutboundEnvelope ): Promise<AckResult> {
    this._dispatch( this._outbound, env )
    this._dispatch( this._outboundByCh.get( env.channel ), env )
    return { acked: true, via: 'event' }
  }

  // ── Consumer subscription (Will → consumer) ─────────────────

  /** Subscribe to every outbound envelope. Returns an unsubscribe function. */
  subscribe( listener: OutboundListener ): () => void {
    this._outbound.add( listener )
    return () => { this._outbound.delete( listener ) }
  }

  /**
   * Subscribe to a single channel (e.g. `'token_report'`, `'session_log'`,
   * `'reply'`) or `'*'` for all. Returns an unsubscribe function.
   */
  on( channel: StreamChannel, listener: OutboundListener ): () => void {
    if( channel === '*') return this.subscribe( listener )
    let set = this._outboundByCh.get( channel )
    if( !set ){ set = new Set(); this._outboundByCh.set( channel, set ) }
    set.add( listener )
    return () => { set!.delete( listener ) }
  }

  // ── Consumer → Will (inbound) ───────────────────────────────

  /**
   * Inject an inbound envelope (message, percept, ack) into the Will. The stem
   * enqueues it onto the tick-stamped InboundQueue and applies it deterministically
   * on tick — this method itself never touches simulation state.
   */
  injectInbound( env: InboundEnvelope ): void {
    for( const fn of this._inboundHandlers ){
      try { fn( env ) }
      catch { /* handler fault isolated */ }
    }
  }

  onInbound( handler: ( env: InboundEnvelope ) => void ): () => void {
    this._inboundHandlers.add( handler )
    return () => { this._inboundHandlers.delete( handler ) }
  }

  onStatus( handler: ( s: TransportStatus ) => void ): () => void {
    this._statusHandlers.add( handler )
    return () => { this._statusHandlers.delete( handler ) }
  }

  /** Notify status subscribers (e.g. flip to 'disconnected' in a test). */
  setStatus( status: TransportStatus ): void {
    this._connected = status === 'connected'
    for( const fn of this._statusHandlers ){
      try { fn( status ) }
      catch { /* isolated */ }
    }
  }

  close(): void {
    this._connected = false
    this._outbound.clear()
    this._outboundByCh.clear()
    this._inboundHandlers.clear()
    this._statusHandlers.clear()
  }

  /** Total active outbound listeners (diagnostics/tests). */
  get listenerCount(): number {
    let n = this._outbound.size
    for( const set of this._outboundByCh.values() ) n += set.size
    return n
  }

  private _dispatch( set: Set<OutboundListener> | undefined, env: OutboundEnvelope ): void {
    if( !set ) return
    for( const fn of set ){
      try { fn( env ) }
      catch { /* consumer listener must never break the Will */ }
    }
  }
}

/**
 * Whether producers should ALSO write their telemetry to local files.
 *
 * Files are a development convenience only. In production the stream/transport is
 * the single source of truth and the consumer owns persistence.
 *
 * - `WILL_FILE_LOGS=true|1|false|0` — explicit override (wins).
 * - otherwise: on when `NODE_ENV` is neither `production` nor `test`.
 */
export function fileLoggingEnabled(): boolean {
  const override = process.env['WILL_FILE_LOGS']
  if( override !== undefined ) return override === 'true' || override === '1'
  const env = process.env['NODE_ENV']
  return env !== 'production' && env !== 'test'
}

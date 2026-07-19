// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport/socketio.transport.ts
// ─────────────────────────────────────────────────────────────
//
// SocketIoTransport — production ExternalTransport over socket.io-client.
//
// The peer (backend) hosts the socket.io server; this is Will's client side.
// It is constructed by the CALLER and injected via WillConfig.transport, so the
// `will` package never imports socket.io-client at module load — the dependency
// is OPTIONAL and loaded lazily via a dynamic import only when a transport is
// actually instantiated. The import specifier is indirected through a variable
// so the type checker does not require the module to be installed.
//
// Outbound:  emit('envelope', env, ack)  — socket.io ack callback gives the fast
//            best-effort delivery/result ack (Section 3 reconciles with the
//            durable discrete-event path).
// Inbound:   'envelope' events plus discrete 'message.delivered' /
//            'effector.invoked.ack' events (synthesized into ack envelopes), in
//            case the peer emits them independently. All inbound is handed to
//            onInbound() handlers — the stem enqueues them onto the tick queue.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { wallClock } from '#core/wall.clock'
import type {
  ExternalTransport,
  OutboundEnvelope,
  InboundEnvelope,
  AckEnvelope,
  AckResult,
  TransportStatus,
} from './types'

/** Minimal surface of a socket.io client we depend on — keeps us decoupled from the dep's types. */
export interface SocketLike {
  connected: boolean
  on( event: string, handler: ( ...args: any[] ) => void ): void
  emit( event: string, payload: unknown, ack?: ( response: unknown ) => void ): void
  disconnect(): void
}

export interface SocketIoTransportOptions {
  /** socket.io server URL (e.g. wss://host or http://host:port). */
  url:           string
  /** This Will's id — sent as auth + routing key. */
  willId:        string
  /** Optional auth token sent in the socket.io handshake. */
  token?:        string
  /** Default ack timeout for emit() in ms. Default 5000. */
  ackTimeoutMs?: number
  /**
   * Override the socket factory — inject a fake in tests, or customize the
   * socket.io connection. When omitted, `socket.io-client` is dynamically
   * imported and `io(url, { auth })` is called.
   */
  socketFactory?: ( url: string, opts: { auth: { willId: string; token?: string } } ) => SocketLike | Promise<SocketLike>
}

const DEFAULT_ACK_TIMEOUT_MS = 5_000

export class SocketIoTransport implements ExternalTransport {
  private _socket:     SocketLike | null = null
  private _connecting: Promise<SocketLike | null> | null = null
  private _seq        = 0

  private readonly _inboundHandlers = new Set<( env: InboundEnvelope ) => void>()
  private readonly _statusHandlers  = new Set<( s: TransportStatus ) => void>()

  constructor( private readonly _opts: SocketIoTransportOptions ){
    // Begin connecting eagerly; emit()/inbound wiring await the same promise.
    void this._ensureSocket()
  }

  get connected(): boolean { return this._socket?.connected ?? false }

  // ── Outbound ─────────────────────────────────────────────────

  async emit( env: OutboundEnvelope, opts?: { ackTimeoutMs?: number } ): Promise<AckResult> {
    const socket = await this._ensureSocket()
    if( !socket || !socket.connected )
      // No connection — caller keeps the message buffered (outbox) and retries.
      return { acked: false, via: 'timeout' }

    const timeoutMs = opts?.ackTimeoutMs ?? this._opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    const stamped: OutboundEnvelope = { ...env, seq: env.seq || ++this._seq }

    return new Promise<AckResult>( resolve => {
      let settled = false
      const done = ( r: AckResult ) => { if( !settled ){ settled = true; clearTimeout( timer ); resolve( r ) } }

      const timer = setTimeout( () => done({ acked: false, via: 'timeout' }), timeoutMs )

      try {
        socket.emit('envelope', stamped, ( response: unknown ) => done({ acked: true, via: 'callback', payload: response }) )
      }
      catch( err ){
        logger.warn(`[socketio-transport] emit failed: ${( err as Error ).message}`)
        done({ acked: false, via: 'timeout' })
      }
    } )
  }

  // ── Inbound + status subscriptions ───────────────────────────

  onInbound( handler: ( env: InboundEnvelope ) => void ): () => void {
    this._inboundHandlers.add( handler )
    return () => { this._inboundHandlers.delete( handler ) }
  }

  onStatus( handler: ( s: TransportStatus ) => void ): () => void {
    this._statusHandlers.add( handler )
    return () => { this._statusHandlers.delete( handler ) }
  }

  close(): void {
    try { this._socket?.disconnect() } catch { /* ignore */ }
    this._socket = null
    this._connecting = null
    this._inboundHandlers.clear()
    this._statusHandlers.clear()
  }

  // ── Internal ─────────────────────────────────────────────────

  private async _ensureSocket(): Promise<SocketLike | null> {
    if( this._socket ) return this._socket
    if( !this._connecting ) this._connecting = this._connect()
    return this._connecting
  }

  private async _connect(): Promise<SocketLike | null> {
    try {
      const socket = this._opts.socketFactory
        ? await this._opts.socketFactory( this._opts.url, { auth: { willId: this._opts.willId, token: this._opts.token } } )
        : await this._defaultFactory()

      this._wire( socket )
      this._socket = socket
      return socket
    }
    catch( err ){
      logger.error(`[socketio-transport] connect failed: ${( err as Error ).message}`)
      this._connecting = null   // allow a later retry
      return null
    }
  }

  private async _defaultFactory(): Promise<SocketLike> {
    // Indirect the specifier so the type checker does not require the optional
    // dependency to be installed for the core package to build.
    const spec = 'socket.io-client'
    const mod  = await import( /* @vite-ignore */ spec ) as any
    const io   = mod.io ?? mod.default ?? mod
    return io( this._opts.url, {
      auth:       { willId: this._opts.willId, token: this._opts.token },
      transports: ['websocket'],
    } ) as SocketLike
  }

  /** Attach socket.io event handlers that feed the inbound + status streams. */
  private _wire( socket: SocketLike ): void {
    socket.on('connect',    () => this._notifyStatus('connected') )
    socket.on('disconnect', () => this._notifyStatus('disconnected') )
    socket.on('reconnect_attempt', () => this._notifyStatus('reconnecting') )

    // Primary inbound channel — already-typed envelopes from the peer.
    socket.on('envelope', ( env: InboundEnvelope ) => this._emitInbound( env ) )

    // Discrete ack events (Section 2): in case the peer emits acks independently
    // rather than via the emit() callback. Synthesized into ack envelopes; the
    // AckReconciler (Section 3) dedups against the callback path by correlationId.
    socket.on('message.delivered', ( m: { correlationId: string; delivered?: boolean } ) =>
      this._emitInbound( this._deliveryAck( m.correlationId, m.delivered ?? true ) ) )

    socket.on('effector.invoked.ack', ( m: { correlationId: string; result: AckEnvelope['result'] } ) =>
      this._emitInbound( this._resultAck( m.correlationId, m.result ) ) )
  }

  private _emitInbound( env: InboundEnvelope ): void {
    for( const h of this._inboundHandlers ){
      try { h( env ) }
      catch( err ){ logger.error(`[socketio-transport] inbound handler error: ${( err as Error ).message}`) }
    }
  }

  private _notifyStatus( status: TransportStatus ): void {
    for( const h of this._statusHandlers ){
      try { h( status ) }
      catch { /* ignore */ }
    }
  }

  private _deliveryAck( correlationId: string, delivered: boolean ): AckEnvelope {
    return { channel: 'ack', ackKind: 'delivery', delivered, willId: this._opts.willId, correlationId, seq: 0, wallTime: wallClock() }
  }

  private _resultAck( correlationId: string, result: AckEnvelope['result'] ): AckEnvelope {
    return { channel: 'ack', ackKind: 'result', result, willId: this._opts.willId, correlationId, seq: 0, wallTime: wallClock() }
  }
}

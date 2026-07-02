// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport/loopback.transport.ts
// ─────────────────────────────────────────────────────────────
//
// LoopbackTransport — in-memory, deterministic ExternalTransport for tests,
// replay, and any configuration without a real peer.
//
// No sockets, no timers: emit() resolves its ack synchronously per a scripted
// policy, and inbound is driven by injectInbound(). Mirrors the role of
// InProcessCognitiveTransport for the cognitive bus.
// ─────────────────────────────────────────────────────────────

import type {
  ExternalTransport,
  OutboundEnvelope,
  InboundEnvelope,
  AckResult,
  TransportStatus,
} from './types'

/** Decides how emit() resolves an ack for a given envelope. Default: acked via callback. */
export type AckPolicy = ( env: OutboundEnvelope ) => AckResult

const DEFAULT_ACK: AckPolicy = () => ({ acked: true, via: 'callback' })

export class LoopbackTransport implements ExternalTransport {
  /** Every envelope passed to emit(), in order — inspect in tests. */
  readonly sent: OutboundEnvelope[] = []

  private _connected = true
  private _ackPolicy: AckPolicy
  private readonly _inboundHandlers = new Set<( env: InboundEnvelope ) => void>()
  private readonly _statusHandlers  = new Set<( s: TransportStatus ) => void>()

  constructor( ackPolicy: AckPolicy = DEFAULT_ACK ){
    this._ackPolicy = ackPolicy
  }

  get connected(): boolean { return this._connected }

  async emit( env: OutboundEnvelope ): Promise<AckResult> {
    this.sent.push( env )
    return this._ackPolicy( env )
  }

  onInbound( handler: ( env: InboundEnvelope ) => void ): () => void {
    this._inboundHandlers.add( handler )
    return () => { this._inboundHandlers.delete( handler ) }
  }

  onStatus( handler: ( s: TransportStatus ) => void ): () => void {
    this._statusHandlers.add( handler )
    return () => { this._statusHandlers.delete( handler ) }
  }

  close(): void {
    this._connected = false
    this._inboundHandlers.clear()
    this._statusHandlers.clear()
    this.sent.length = 0
  }

  // ── Test / harness controls ──────────────────────────────────

  /** Simulate the peer sending an inbound envelope to the Will. */
  injectInbound( env: InboundEnvelope ): void {
    for( const h of this._inboundHandlers ) h( env )
  }

  /** Flip connection state and notify status handlers. */
  setConnected( connected: boolean ): void {
    this._connected = connected
    const status: TransportStatus = connected ? 'connected' : 'disconnected'
    for( const h of this._statusHandlers ) h( status )
  }

  /** Swap the ack policy mid-test (e.g. to simulate timeouts then recovery). */
  setAckPolicy( policy: AckPolicy ): void {
    this._ackPolicy = policy
  }

  /** Convenience: only the envelopes on a given channel. */
  sentOn<T extends OutboundEnvelope['channel']>( channel: T ): Extract<OutboundEnvelope, { channel: T }>[] {
    return this.sent.filter( e => e.channel === channel ) as Extract<OutboundEnvelope, { channel: T }>[]
  }
}

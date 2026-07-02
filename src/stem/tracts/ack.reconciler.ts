// ─────────────────────────────────────────────────────────────
// src/stem/tracts/ack.reconciler.ts
// ─────────────────────────────────────────────────────────────
//
// AckReconciler — idempotent dedup for the dual ack paths (Section 3).
//
// An outbound envelope can be acked twice: once via the socket.io emit callback
// (fast, best-effort) and once via a discrete inbound event (durable across
// reconnects — see SocketIoTransport). Both carry the same correlationId. This
// keyed deduper guarantees the ack is applied exactly once: the FIRST ack for a
// correlationId wins, every later one is a no-op.
//
// It is a pure deduper — classification (delivery vs result) and application
// (confirmDelivery / confirmExecution) stay in TransportController, which holds
// the collaborators. Bounded by a FIFO eviction window so it never grows without
// limit on a long-lived Will.
// ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_TRACKED = 10_000

export class AckReconciler {
  private readonly _seen  = new Set<string>()
  private readonly _order: string[] = []
  private readonly _max:   number

  constructor( maxTracked: number = DEFAULT_MAX_TRACKED ){
    this._max = maxTracked
  }

  /**
   * Record an ack for `correlationId`. Returns true the FIRST time (caller should
   * apply the ack), false on every subsequent call (caller drops it).
   */
  shouldApply( correlationId: string ): boolean {
    if( this._seen.has( correlationId ) ) return false

    this._seen.add( correlationId )
    this._order.push( correlationId )
    if( this._order.length > this._max ){
      const evicted = this._order.shift()
      if( evicted !== undefined ) this._seen.delete( evicted )
    }
    return true
  }

  /** Whether a correlationId has already been applied (without recording it). */
  has( correlationId: string ): boolean { return this._seen.has( correlationId ) }

  get size(): number { return this._seen.size }

  clear(): void {
    this._seen.clear()
    this._order.length = 0
  }
}

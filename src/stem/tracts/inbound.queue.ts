// ─────────────────────────────────────────────────────────────
// src/stem/tracts/inbound.queue.ts
// ─────────────────────────────────────────────────────────────
//
// InboundQueue — the determinism linchpin for external I/O.
//
// Every InboundEnvelope from the ExternalTransport (messages, percepts, acks)
// is enqueued here on arrival and applied LATER, at a fixed point in the tick
// loop, with a logicalTime (tick) stamp. This is what keeps a live, async,
// non-deterministic socket compatible with the replay-deterministic core:
//   - arrival is decoupled from application
//   - application happens on-tick, in FIFO order, stamped to that tick
//   - the replay recorder logs each tick's drained batch; replay re-injects it
//
// The queue holds NO sockets and applies NOTHING itself — it is a buffer.
// ─────────────────────────────────────────────────────────────

import type { InboundEnvelope } from './transport/types'

/** An inbound envelope paired with the tick it was applied on (set at drain). */
export interface StampedInbound {
  envelope:    InboundEnvelope
  /** Tick at which this was drained + applied. Assigned by drain(tick). */
  appliedTick: number
}

export class InboundQueue {
  private _pending: InboundEnvelope[] = []

  /** Buffer an inbound envelope. Called from the transport handler — never applies. */
  enqueue( env: InboundEnvelope ): void {
    this._pending.push( env )
  }

  /** Number of envelopes waiting to be applied. */
  get size(): number { return this._pending.length }

  /**
   * Remove and return all pending envelopes, stamped with the given tick.
   * Called once per tick by the stem before simulation.step(). FIFO order is
   * preserved so application is deterministic given the recorded batch.
   */
  drain( tick: number ): StampedInbound[] {
    if( this._pending.length === 0 ) return []
    const batch = this._pending
    this._pending = []
    return batch.map( envelope => ({ envelope, appliedTick: tick }) )
  }

  /** Discard everything without applying (teardown). */
  clear(): void {
    this._pending = []
  }
}

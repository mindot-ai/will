// ─────────────────────────────────────────────────────────────
// src/core/inbound.recorder.ts
// ─────────────────────────────────────────────────────────────
//
// External-inbound record/replay seam (REORIENT R2, transport edition).
//
// The ExternalTransport is a non-deterministic input, exactly like the LLM:
// to re-run a session deterministically the recorder must capture every inbound
// envelope (messages, percepts, acks) at the tick it was applied. On replay a
// *source* re-feeds those recorded envelopes instead of waiting on a live socket.
//
// This mirrors completion.recorder.ts: a capture sink (recordInbound) and a
// re-feed source, both keyed by willId. Deterministic re-execution itself is
// still deferred — this completes the capture half so it lands ready.
//
// `envelope` is `unknown` on purpose: this is `#core` and must not depend on the
// `#stem` transport types. It round-trips as JSON.
// ─────────────────────────────────────────────────────────────

import type { Tick, Timestamp } from '#core/types'

export interface InboundRecord {
  tick:      Tick
  willId:    string
  /** The InboundEnvelope as applied (opaque here to avoid a #stem dependency). */
  envelope:  unknown
  timestamp: Timestamp
}

export interface InboundSink {
  recordInbound( record: InboundRecord ): void
}

// ── Capture sink ─────────────────────────────────────────────

const _sinks = new Map<string, InboundSink>()

export function setInboundRecorder( willId: string, sink: InboundSink ): void {
  _sinks.set( willId, sink )
}

export function clearInboundRecorder( willId: string ): void {
  _sinks.delete( willId )
}

export function getInboundRecorder( willId: string ): InboundSink | undefined {
  return _sinks.get( willId )
}

// ── Replay re-feed source (deferred re-execution) ────────────

/**
 * Supplies recorded inbound envelopes back during a deterministic re-execution
 * replay, keyed by willId. Returns the envelopes recorded at `tick` (empty if
 * none). Registered only while replaying; absent during live runs.
 */
export interface InboundSource {
  envelopesAt( tick: Tick ): unknown[]
}

/**
 * Re-feed source backed by recorded inbound. Groups envelopes by their applied
 * tick (FIFO within a tick, preserving record order) and hands them back once.
 * Unlike the LLM source, a tick with no recorded inbound is normal (most ticks),
 * so a miss returns `[]` rather than throwing — only an upstream LLM/clock/PRNG
 * divergence (caught by their own sources) can invalidate the replay.
 */
export class RecordedInboundSource implements InboundSource {
  private readonly _byTick = new Map<Tick, unknown[]>()

  constructor( records: readonly InboundRecord[] ){
    for( const r of records ){
      const queue = this._byTick.get( r.tick )
      if( queue ) queue.push( r.envelope )
      else this._byTick.set( r.tick, [ r.envelope ] )
    }
  }

  envelopesAt( tick: Tick ): unknown[] {
    const queue = this._byTick.get( tick )
    if( !queue || queue.length === 0 ) return []
    // Consume so a tick is never re-fed twice within one replay.
    this._byTick.set( tick, [] )
    return queue
  }
}

const _sources = new Map<string, InboundSource>()

export function setInboundSource( willId: string, source: InboundSource ): void {
  _sources.set( willId, source )
}

export function clearInboundSource( willId: string ): void {
  _sources.delete( willId )
}

export function getInboundSource( willId: string ): InboundSource | undefined {
  return _sources.get( willId )
}

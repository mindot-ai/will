// ─────────────────────────────────────────────────────────────
// src/cognition/completion.inbox.ts — tick-boundary landing for async results
// ─────────────────────────────────────────────────────────────
//
// The architecture's rule is that state changes land at tick boundaries: engine
// commands go through the collect→commit pipeline, bus events queue and flush in
// Phase 2, and AsyncEngine results settle off-tick but convert to commands inside
// the next react(). Facet decisions were the one path that broke the rule — the
// direct subscriber callbacks (PlanningEngine plan mutations, AuditionEngine
// outbox writes) fired at raw LLM-promise resolution, i.e. at an arbitrary
// wall-clock moment that could interleave with a tick in flight.
//
// The CompletionInbox closes that seam. Async completion effects are enqueued
// as thunks at resolution time and applied by the CognitiveOrchestrator at the
// top of Phase 2 — the same tick-aligned point where the bus flushes. Result:
//
//   • the frozen-snapshot premise holds — nothing mutates shared state while a
//     tick's engines are reading;
//   • a completion's landing tick is quantized: effects from work that resolved
//     during tick N are visible to every engine at tick N+1, in FIFO order;
//   • under replay, re-fed completions resolve deterministically, so enqueue
//     order — and therefore landing order — reproduces exactly.
//
// This does NOT constrain facet spawning or reasoning: facets stay dynamically
// spawned, entity-scoped, and fully async. Only the *return path* is disciplined
// — the same contract every synchronous engine already obeys. Reply chunk
// streaming intentionally bypasses the inbox: chunks are client-facing flow,
// not simulation state, and stay real-time.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'

interface PendingCompletion {
  /** Provenance label for diagnostics — e.g. `facet-3:decision`. */
  label: string
  /** The deferred effect — runs at the next Phase-2 drain. */
  apply: () => void
}

export class CompletionInbox {
  private _queue: PendingCompletion[] = []

  /** Number of completions waiting to land. */
  get size(): number { return this._queue.length }

  /**
   * Stage a completion effect for the next tick boundary. Called from async
   * resolution contexts (facet decision emission); never applies inline.
   */
  enqueue( label: string, apply: () => void ): void {
    this._queue.push( { label, apply } )
  }

  /**
   * Apply every staged completion in FIFO order. Called by the
   * CognitiveOrchestrator at the top of Phase 2, before the bus flush — so any
   * bus events a thunk publishes deliver in the same phase. A throwing thunk is
   * isolated: it never blocks the rest of the queue or the tick.
   *
   * Thunks enqueued DURING the drain (e.g. a listener triggering another facet
   * whose mock resolves synchronously) land next tick — the snapshot taken this
   * drain cycle stays coherent.
   */
  drain( tick: number ): number {
    if( this._queue.length === 0 ) return 0

    const batch = this._queue
    this._queue = []

    for( const { label, apply } of batch ){
      try { apply() }
      catch( err ){
        logger.error( `[completion-inbox] "${label}" failed while landing at tick ${tick}:`, err )
      }
    }

    return batch.length
  }

  /** Drop staged completions (mind teardown). Returns how many were discarded. */
  clear(): number {
    const n = this._queue.length
    this._queue = []
    return n
  }
}

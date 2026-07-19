// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/deferred.effects.ts
// ─────────────────────────────────────────────────────────────
//
// DeferredEffectQueue — commit-gated manager-write queue (FN11).
//
// buildStateCommands is pure: it returns entity/metric commands plus the
// mirroring manager writes (summarizer / goals / beliefs / effectors + the
// action-diversity ring buffer) as deferred thunks. Those thunks must run
// ONLY after the orchestrator confirms the tick committed — a pre-commit
// validator (e.g. the inhibition veto) can abort a tick and discard the
// commands, and we must not let the manager writes land for a tick whose
// entities were dropped.
//
// Commit is detected on the next react() via the committed
// `executive.last_tick` metric (set by buildStateCommands) matching the
// entry's observed tick.
//
// Extracted verbatim from ExecutiveEngine (R5-g-1) as a pure collaborator.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { ReadonlySimulationState } from '#core/types'
import type { DeferredEffect } from '#faculties/executive.engine/commands'

interface DeferredEntry {
  /** footprint.tickObserved — equals the committed `executive.last_tick`. */
  observedTick: number
  /** react() tick when the commands were returned (decision is made after this). */
  queuedAtTick: number
  effects: DeferredEffect[]
}

export class DeferredEffectQueue {
  private _entries: DeferredEntry[] = []

  /** The tick of the most recent react() call — the commit tick for queued effects. */
  private _lastReactTick = -1

  /**
   * Record the current react() tick. Effects queued after this call are
   * stamped with it as their `queuedAtTick`, so flush() knows to wait one
   * more tick before deciding whether the tick committed.
   */
  markReactTick( tick: number ): void {
    this._lastReactTick = tick
  }

  /**
   * Queue commit-gated manager writes for `observedTick`. No-op when there
   * are no effects to run.
   */
  enqueue( observedTick: number, effects: DeferredEffect[] ): void {
    if( effects.length === 0 ) return
    this._entries.push({
      observedTick,
      queuedAtTick: this._lastReactTick,
      effects,
    })
  }

  /**
   * Run deferred manager writes for committed ticks; drop them for aborted ticks.
   *
   * An entry queued during react() at tick C is resolved on the *next* react:
   *   • committed `executive.last_tick === observedTick` → the commands landed,
   *     so run the mirroring manager writes.
   *   • the queuing tick has passed without that match → the tick was aborted
   *     (e.g. inhibition veto), so drop the writes — no compensation needed
   *     because the entity commands were discarded too.
   */
  flush( state: ReadonlySimulationState, currentTick: number ): void {
    if( this._entries.length === 0 ) return

    const committedTick = state.metrics.get('executive.last_tick')
    const keep: DeferredEntry[] = []

    for( const entry of this._entries ){
      // Not yet resolved — commands were returned this same tick; wait one tick
      // for the orchestrator to commit (or abort) before deciding.
      if( currentTick <= entry.queuedAtTick ){
        keep.push( entry )
        continue
      }

      if( committedTick === entry.observedTick ){
        for( const effect of entry.effects ){
          try { effect() }
          catch( err ){
            logger.error(`[executive] deferred effect failed (tick ${entry.observedTick}):`, err )
          }
        }
      }
      else {
        logger.warn(
          `[executive] dropping deferred manager writes for aborted tick ${entry.observedTick} ` +
          `(committed executive tick: ${committedTick ?? 'none'})`
        )
      }
    }

    this._entries = keep
  }
}

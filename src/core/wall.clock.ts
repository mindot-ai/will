// ─────────────────────────────────────────────────────────────
// src/core/wall.clock.ts
// ─────────────────────────────────────────────────────────────

/**
 * The single sanctioned wall-clock boundary (R2).
 *
 * The determinism guard (tests/unit/determinism.guard.test.ts) bans bare
 * `Date.now()` / `new Date` in `src/core` and `src/cognition`, because anything
 * that feeds replayable state must read the *sim* clock (`SimulationState.time`
 * or the tick) so a run reproduces byte-for-byte from the same seed.
 *
 * Some reads, though, are intentionally NON-replay-affecting — perf timing,
 * idle detection, network/RPC metadata, snapshot ids, seed defaults. Those go
 * through `wallClock()` so the intent is explicit and greppable, and so the one
 * real `Date.now()` call lives in exactly one auditable place.
 *
 * Rule of thumb: if the value can ever land in the event log, a snapshot, or an
 * entity field, it must NOT come from here — use the sim clock instead.
 */
export function wallClock(): number {
  return Date.now() // determinism-ok: this function is the wall-clock boundary
}

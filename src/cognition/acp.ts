// ─────────────────────────────────────────────────────────────
// src/cognition/acp.ts — action-conditioned prediction constants
// ─────────────────────────────────────────────────────────────
//
// Shared by every ACP-P2 consumer (ACTION_CONDITIONED_PREDICTION §3) so the
// safety-relevant number cannot drift between engines. The pattern each
// consumer implements:
//
//   1. subscribe `agency.enacted` / `agency.communicate` / `agency.invocation`;
//   2. on any of them, setPrecision(stream, ACP_SELF_PRECISION) on the streams
//      whose prediction errors are actually CONSUMED (gate or weight a
//      publish) — anticipating unconsumed streams is theater;
//   3. restore precision to 1.0 explicitly after ONE observe in react() —
//      GenerativeModel's own mean-reversion (0.02/observe ≈ 50 ticks) would
//      keep dampening GENUINE world surprise arriving after our action.
//
// Measured on the first consumer (AttentionAllocator): after a stable
// stretch the salience denominator (EW variance) collapses, so any deviation
// saturates salience at 1.0 — precision is the only lever that stays
// measurable there; a conservative anticipate() nudge is invisible.
// ─────────────────────────────────────────────────────────────

/**
 * The weight a self-caused observe carries. Below the executive's
 * `WORKSPACE_THRESHOLD` (0.4) even when the base salience saturates at 1.0 —
 * our own action's swing does not recruit our own executive.
 */
export const ACP_SELF_PRECISION = 0.35

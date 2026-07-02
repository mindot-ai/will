// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/effort.gate.ts
// ─────────────────────────────────────────────────────────────

/**
 * Dual-process control for the master executive.
 *
 * The master reasons in one of two processes per tick:
 *   - **System 1 (`fast`)** — the single-shot call. Quick, habitual, low-effort; the
 *     default for routine ticks.
 *   - **System 2 (`deliberate`)** — an effortful propose→evaluate pass, engaged only
 *     when the situation demands the effort.
 *
 * `selectProcess` is the *a-priori* gate: it chooses BEFORE any LLM call, from signals
 * already computed this tick, so there is no wasted work and (unlike post-hoc
 * escalation) no risk of streaming an intuition we then override. It is a pure,
 * deterministic function of those signals (R2): no wall-clock, no RNG.
 *
 * This is deliberately the one seat where effort allocation lives. Two things grow
 * here later, on this same seam:
 *   - the `DELIBERATE_THRESHOLD` becomes a persona-prior-developable disposition (an
 *     analytical / conscientious Will lowers it ⇒ deliberates more readily; an impulsive
 *     one raises it), unifying dual-process with the trait system; and
 *   - a System-1→System-2 *escalation* hook (System 1 runs, then raises its hand when
 *     unsure) — which is why the deliberate path reports its own confidence.
 */

/** Which cognitive process the master runs this tick. */
export type CognitiveProcess = 'fast' | 'deliberate'

/** A-priori signals (all available before the master's LLM call) driving the choice. */
export interface EffortSignals {
  /** Epistemic uncertainty for this tick (0..1). Higher ⇒ deliberate. */
  epistemicUncertainty: number
  /** Confidence on the master's *previous* decision (0..1). Lower ⇒ deliberate. */
  priorConfidence: number
  /** Perceptual novelty (0..1). Higher ⇒ deliberate. */
  novelty: number
  /** Stress load (0..100). High load flags a situation that matters ⇒ deliberate. */
  stressLoad: number
  /** A human message is awaiting a reply this tick. A social, stakes-bearing moment. */
  hasPendingMessage: boolean
}

export interface ProcessSelection {
  process: CognitiveProcess
  /** Aggregate effort demand (0..1) that drove the choice — telemetry + future tuning. */
  effortScore: number
  /** The dominant contributor (auditability), e.g. `deliberate:uncertainty`. */
  reason: string
}

// Contribution weights sum to 1, so effortScore ∈ [0,1]. Tunable; see the module note
// on making the threshold persona-prior-developable.
const W_UNCERTAINTY    = 0.30
const W_LOW_CONFIDENCE = 0.25
const W_NOVELTY        = 0.20
const W_PENDING        = 0.15
const W_STRESS         = 0.10

/** Effort demand at/above which the master engages System 2 (deliberate). */
export const DELIBERATE_THRESHOLD = 0.5

const clamp01 = ( x: number ): number => Math.max( 0, Math.min( 1, x ) )

/**
 * Choose the master's cognitive process for this tick. Pure + deterministic.
 * System 1 (`fast`) is the default; System 2 (`deliberate`) is engaged when the
 * weighted effort demand crosses `threshold`.
 *
 * `threshold` defaults to `DELIBERATE_THRESHOLD` but is passed in by the engine as the
 * *effective* threshold (base ⊕ persona-prior): an analytical Will develops a lower
 * threshold and so deliberates more readily — effort allocation as a developing trait.
 */
export function selectProcess(
  signals: EffortSignals,
  threshold: number = DELIBERATE_THRESHOLD,
): ProcessSelection {
  const contributions: Array<[ string, number ]> = [
    [ 'uncertainty',    W_UNCERTAINTY    * clamp01( signals.epistemicUncertainty ) ],
    [ 'low_confidence', W_LOW_CONFIDENCE * ( 1 - clamp01( signals.priorConfidence ) ) ],
    [ 'novelty',        W_NOVELTY        * clamp01( signals.novelty ) ],
    [ 'pending_reply',  W_PENDING        * ( signals.hasPendingMessage ? 1 : 0 ) ],
    [ 'load',           W_STRESS         * clamp01( signals.stressLoad / 100 ) ],
  ]

  const effortScore = contributions.reduce( ( sum, [ , v ] ) => sum + v, 0 )
  const dominant    = contributions.reduce( ( a, b ) => ( b[ 1 ] > a[ 1 ] ? b : a ) )[ 0 ]
  const deliberate  = effortScore >= threshold

  return {
    process:     deliberate ? 'deliberate' : 'fast',
    effortScore,
    reason:      deliberate ? `deliberate:${dominant}` : 'fast',
  }
}

// ── Ideation temperature (closes TODO edge #4) ────────────────

/** Safe sampling-temperature band for the ideation (propose) pass. */
export const IDEATION_TEMP_MIN = 0.6
export const IDEATION_TEMP_MAX = 1.0

/**
 * Map the `creativity` self-model trait (0..1) to the ideation pass's sampling
 * temperature. A more creative Will diverges harder when proposing options. Bounded to
 * [IDEATION_TEMP_MIN, IDEATION_TEMP_MAX] so the *decision* pass (provider default) is
 * never destabilised. This closes TODO edge #4 — and cleanly, because temperature now
 * lives only on the isolated ideation call, not the fused decision call. As the
 * creativity trait develops in the self-model, this rises with it for free.
 */
export function ideationTemperature( creativity: number ): number {
  return IDEATION_TEMP_MIN + clamp01( creativity ) * ( IDEATION_TEMP_MAX - IDEATION_TEMP_MIN )
}

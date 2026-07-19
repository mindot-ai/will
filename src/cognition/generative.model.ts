// ─────────────────────────────────────────────────────────────
// src/cognition/generative.model.ts
// ─────────────────────────────────────────────────────────────

/**
 * GenerativeModel — per-engine probabilistic prediction model.
 *
 * Implements a lightweight active-inference generative model for each engine:
 *   - Maintains EMA (exponential moving average) predictions per signal stream
 *   - Computes prediction error as |actual − predicted| / adaptive scale
 *   - Supports top-down anticipatory updates via anticipate()
 *   - Tracks prediction accuracy per stream (Welford online variance)
 *
 * Usage pattern:
 *   1. Engines call predict(signal) at the start of react() to get the
 *      expected value for this tick.
 *   2. After computing the actual value, call observe(signal, actual) to get
 *      the normalized prediction error and update the model.
 *   3. If prediction error < GATE_THRESHOLD the engine may skip heavy
 *      computation (activation gating / energy saving).
 *   4. ExecutiveEngine calls anticipate(signal, value, confidence) to inject
 *      top-down priors — the model blends the anticipation with the EMA.
 *
 * Design notes:
 *   - All parameters are per-stream; different signals can have different
 *     learning rates or value ranges.
 *   - Thread-safe in a single-threaded JS event loop.
 *   - No external dependencies.
 */

// ── Defaults ─────────────────────────────────────────────────

const DEFAULT_ALPHA       = 0.15   // EMA learning rate
const DEFAULT_RANGE       = 0      // 0 ⇒ adaptive scale (learned per-stream from observed deviations)
const GATE_THRESHOLD      = 0.05   // Normalized error below which processing can be gated
const ANTICIPATION_BLEND  = 0.3    // How much top-down anticipation shifts the prior
// Adaptive normalisation: scale = SURPRISE_SCALE × mean-absolute-deviation (madEma).
// Paired with the default GATE_THRESHOLD this puts the gate at ~1 typical deviation,
// so a larger-than-usual error reads as surprising regardless of the signal's magnitude.
const SURPRISE_SCALE      = 20
const SCALE_FLOOR         = 1e-9   // guards against 0/0 on a perfectly constant signal

// ── Salience normalisation (merged from SalienceComputer) ────
// `salience` is a second view of the same prediction error, scaled against an
// exponentially-weighted variance and modulated by a top-down precision weight.
// Kept on a SEPARATE scale from gating (madEma×SURPRISE_SCALE) so neither
// behaviour changes — gating answers "should I compute?", salience answers "how
// much should this grab the Global Workspace?".
const NORMALISE_SCALE     = 3      // |error| / (stdDev × NORMALISE_SCALE) → clamp [0,1]
const SALIENCE_EPSILON    = 1e-6   // prevents div-by-zero on a zero-variance series
const PRECISION_MIN       = 0.1    // precision weight bounds
const PRECISION_MAX       = 3.0
const PRECISION_DECAY     = 0.02   // mean-reversion of precision toward 1.0 per observation

// ── Types ─────────────────────────────────────────────────────

export interface PredictionError {
  /** Raw absolute error |actual − predicted| */
  error: number
  /** Normalized error in [0, 1] relative to the signal's expected range (gating basis) */
  normalized: number
  /** Whether this signal was gated (error below threshold) */
  gated: boolean
  /**
   * Precision-weighted surprise in [0, 1] for Global-Workspace ranking — the
   * value the old SalienceComputer.observe() returned. Scaled against the
   * stream's exponentially-weighted variance × its precision weight.
   */
  salience: number
}

export interface StreamConfig {
  /** EMA learning rate (0–1) for the *prediction*. Higher = faster adaptation. Default 0.15. */
  alpha?: number
  /**
   * EMA learning rate (0–1) for the learned *deviation scale* — the gating basis
   * (madEma) and the salience variance basis (m2). Decoupled from `alpha` so the
   * scale can track at a different rate than the prediction (e.g. a fast-adapting
   * prediction over a slowly-drifting noise floor). Defaults to `alpha`, so an
   * unset value preserves the original coupled behaviour exactly.
   */
  scaleAlpha?: number
  /** Fixed full-scale range for normalization. Omit for adaptive scale (learned per-stream). */
  range?: number
  /** Custom gate threshold override. Default GATE_THRESHOLD (0.05). */
  gateThreshold?: number
}

interface StreamState {
  /** Current EMA prediction */
  prediction: number
  /** EMA of the normalized error in [0,1] — the running accuracy/surprise metric */
  errorEma: number
  /** EMA of the raw absolute deviation |actual − prediction| — the learned gating scale */
  madEma: number
  /** EMA of squared error — the adaptive variance basis for `salience` (merged from SalienceComputer) */
  m2: number
  /** EMA learning rate for the prediction */
  alpha: number
  /** EMA learning rate for the learned deviation scale (madEma + m2). Defaults to `alpha`. */
  scaleAlpha: number
  range: number
  gateThreshold: number
  /** Number of observations */
  n: number
  /** Tracks whether a top-down anticipation is active this tick */
  anticipationWeight: number
}

/**
 * Serializable, restorable snapshot of a GenerativeModel's full mutable state
 * (FN9). Unlike snapshotAll() — which is a lossy human-readable summary — this
 * captures every field needed to resume prediction identically after a restore.
 * The Map is flattened to entry arrays so the payload is plain-JSON-safe.
 */
export interface GenerativeModelSnapshot {
  defaultAlpha: number
  defaultRange: number
  streams: Array<[ string, StreamState ]>
  /** Per-stream top-down precision weights (merged from SalienceComputer). */
  precision?: Array<[ string, number ]>
}

// ── GenerativeModel ───────────────────────────────────────────

export class GenerativeModel {
  private _streams = new Map<string, StreamState>()
  // Per-stream precision weights (top-down attention). Kept separate from
  // StreamState so a precision set before the first observe() survives, matching
  // the old SalienceComputer semantics.
  private _precision = new Map<string, number>()
  private _defaultAlpha: number
  private _defaultRange: number

  constructor( defaultAlpha = DEFAULT_ALPHA, defaultRange = DEFAULT_RANGE ){
    this._defaultAlpha = defaultAlpha
    this._defaultRange = defaultRange
  }

  /**
   * Configure per-stream parameters. Call at engine construction time.
   * Streams not configured use defaults.
   */
  configureStream( signal: string, config: StreamConfig ): void {
    const existing = this._streams.get( signal )
    if( existing ){
      if( config.alpha          != null ) existing.alpha          = config.alpha
      if( config.scaleAlpha     != null ) existing.scaleAlpha     = config.scaleAlpha
      if( config.range          != null ) existing.range          = config.range
      if( config.gateThreshold  != null ) existing.gateThreshold  = config.gateThreshold
    }
    else this._streams.set( signal, this._makeStream( config ) )
  }

  /**
   * Returns the current prediction for a signal without observing anything.
   * Returns 0 if the stream hasn't been seen yet.
   */
  predict( signal: string ): number {
    return this._getOrCreate( signal ).prediction
  }

  /**
   * Observe an actual value for a signal. Updates the EMA prediction and
   * returns the prediction error for this tick.
   */
  observe( signal: string, actual: number ): PredictionError {
    const s = this._getOrCreate( signal )

    // Cold start: adopt the first observation as the prediction so the model
    // doesn't report a spurious large error against a zero-initialised prior.
    if( s.n === 0 ){
      s.prediction = actual
      s.n = 1

      return { error: 0, normalized: 0, gated: true, salience: 0 }
    }

    const rawError = Math.abs( actual - s.prediction )

    // ── Gating basis (madEma × SURPRISE_SCALE) ──
    // Scale the error against the signal's own typical deviation (madEma) so
    // surprise is meaningful regardless of magnitude. An explicitly configured
    // range (>0) pins a fixed scale instead. Seed the basis from the first
    // deviation so warm-up observations aren't all maximally surprising.
    const scaleBasis = s.madEma > 0 ? s.madEma : rawError
    const scale = s.range > 0 ? s.range : Math.max( SCALE_FLOOR, scaleBasis * SURPRISE_SCALE )

    const normalized = Math.min( 1, rawError / scale )
    const gated = normalized < s.gateThreshold

    // ── Salience basis (EW-variance × precision, merged from SalienceComputer) ──
    // A second, independent read of the same error: how much should this grab the
    // Global Workspace? Normalised against the stream's exponentially-weighted
    // variance and amplified by its top-down precision weight (which mean-reverts).
    s.m2 = ( 1 - s.scaleAlpha ) * s.m2 + s.scaleAlpha * rawError * rawError
    const variance = s.scaleAlpha * ( 1 - s.scaleAlpha ) * s.m2
    const baseSalience = Math.min( 1, rawError / ( Math.sqrt( variance ) * NORMALISE_SCALE + SALIENCE_EPSILON ) )
    const precision = this._precision.get( signal ) ?? 1.0
    if( precision !== 1.0 )
      this._precision.set( signal, Math.max( PRECISION_MIN, Math.min( PRECISION_MAX, precision + ( 1.0 - precision ) * PRECISION_DECAY ) ) )
    const salience = Math.min( 1, baseSalience * precision )

    // ── Update EMAs — blend top-down anticipation weight if present ──
    const effectiveAlpha = s.anticipationWeight > 0 ? Math.min( 1, s.alpha + s.anticipationWeight * ANTICIPATION_BLEND ) : s.alpha

    s.prediction = s.prediction + effectiveAlpha * ( actual - s.prediction )
    s.madEma = s.madEma + s.scaleAlpha * ( rawError - s.madEma )
    s.errorEma = s.errorEma + s.alpha * ( normalized - s.errorEma )
    s.n++
    s.anticipationWeight = 0 // consumed

    return { error: rawError, normalized, gated, salience }
  }

  /**
   * Set the top-down precision (attention) weight for a signal. Precision > 1
   * amplifies that stream's `salience`; < 1 attenuates it. Mean-reverts toward 1.0
   * on each observe(). (Merged from SalienceComputer.)
   */
  setPrecision( signal: string, weight: number ): void {
    this._precision.set( signal, Math.max( PRECISION_MIN, Math.min( PRECISION_MAX, weight ) ) )
  }

  getPrecision( signal: string ): number {
    return this._precision.get( signal ) ?? 1.0
  }

  /**
   * Inject a top-down anticipation from a higher-level model (e.g. ExecutiveEngine).
   * Blends the anticipation into the current prediction proportional to confidence.
   * Effect decays after one observe() call.
   */
  anticipate( signal: string, predictedValue: number, confidence: number ): void {
    const s = this._getOrCreate( signal )
    const blendWeight = Math.max( 0, Math.min( 1, confidence ) )

    s.prediction = s.prediction + blendWeight * ANTICIPATION_BLEND * ( predictedValue - s.prediction )
    s.anticipationWeight = blendWeight
  }

  /**
   * Returns the long-run mean normalized error for a signal (accuracy metric).
   * 0 = perfect prediction, 1 = maximum surprise.
   */
  meanError( signal: string ): number {
    return this._streams.get( signal )?.errorEma ?? 0
  }

  /**
   * Returns true if the stream's mean error has stabilized below the gate threshold.
   * Useful for deciding whether to skip full computation for a signal.
   */
  isStable( signal: string ): boolean {
    const s = this._streams.get( signal )
    if( !s || s.n < 5 ) return false   // need at least 5 observations
    
    return s.errorEma < s.gateThreshold
  }

  /**
   * Returns a summary snapshot of all streams (for engine.snapshot() calls).
   */
  snapshotAll(): Record<string, { prediction: number; meanError: number; n: number }> {
    const out: Record<string, { prediction: number; meanError: number; n: number }> = {}
    for( const [ key, s ] of this._streams )
      out[ key ] = { prediction: s.prediction, meanError: s.errorEma, n: s.n }

    return out
  }

  /**
   * Capture the full mutable state (FN9). Engines embed this in their own
   * snapshot() so prediction baselines/accuracy survive a restore or replay
   * instead of resetting to a freshly-zeroed model.
   */
  snapshot(): GenerativeModelSnapshot {
    return {
      defaultAlpha: this._defaultAlpha,
      defaultRange: this._defaultRange,
      streams: [ ...this._streams.entries() ].map( ([ k, v ]) => [ k, { ...v } ] ),
      precision: [ ...this._precision.entries() ]
    }
  }

  /**
   * Rehydrate from a snapshot() payload, replacing all current state. Defensive
   * against malformed input so a partial/legacy snapshot can't corrupt the run.
   */
  restore( snap: GenerativeModelSnapshot | undefined | null ): void {
    if( !snap ) return
    if( typeof snap.defaultAlpha === 'number') this._defaultAlpha = snap.defaultAlpha
    if( typeof snap.defaultRange === 'number') this._defaultRange = snap.defaultRange

    this._streams = new Map(
      ( snap.streams ?? [] ).map( ([ k, v ]) => [ k, {
        prediction: v.prediction,
        errorEma: v.errorEma,
        madEma: v.madEma ?? 0,
        m2: v.m2 ?? 0,
        alpha: v.alpha,
        // Legacy snapshots (pre-1e) coupled the scale to `alpha`; default to it.
        scaleAlpha: v.scaleAlpha ?? v.alpha ?? this._defaultAlpha,
        range: v.range,
        gateThreshold: v.gateThreshold,
        n: v.n,
        anticipationWeight: v.anticipationWeight,
      } ] )
    )
    this._precision = new Map( snap.precision ?? [] )
  }

  // ── Internal ─────────────────────────────────────────────────

  private _getOrCreate( signal: string ): StreamState {
    let s = this._streams.get( signal )
    if( !s ){
      s = this._makeStream({})
      this._streams.set( signal, s )
    }

    return s
  }

  private _makeStream( config: StreamConfig ): StreamState {
    return {
      prediction: 0,
      errorEma: 0,
      madEma: 0,
      m2: 0,
      alpha: config.alpha ?? this._defaultAlpha,
      // Defaults to the stream's own alpha → scale stays coupled to the prediction
      // rate unless explicitly decoupled (behaviour-preserving).
      scaleAlpha: config.scaleAlpha ?? config.alpha ?? this._defaultAlpha,
      range: config.range ?? this._defaultRange,
      gateThreshold: config.gateThreshold ?? GATE_THRESHOLD,
      n: 0,
      anticipationWeight: 0
    }
  }
}

// ── Gate threshold export for engines ────────────────────────
export { GATE_THRESHOLD }

// ─────────────────────────────────────────────────────────────
// src/cognition/cache/deliberation.cache.ts
// ─────────────────────────────────────────────────────────────

/**
 * DeliberationCache — deterministic fast-path for executive reasoning.
 *
 * Stores past (fingerprint, output) pairs and composes a new output by
 * interpolating neighbors of the *query* fingerprint. Pure, R2-safe, bounded.
 *
 * Determinism discipline:
 *   - Patterns live in a flat array; retrieval is a linear scan (k is small and
 *     the array is bounded, so determinism beats micro-optimisation).
 *   - The similarity that drives confidence, weighting and competence updates is
 *     always computed against the query fingerprint the caller passes in — never
 *     a self-similarity proxy.
 *   - Sort keys are scalars; ties break on storedAtTick (older first).
 *   - No hash maps over fingerprints, no Set iteration, no wall-clock, no RNG.
 */

import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { Tick } from '#core/types'
import type {
  DeliberationCacheConfig,
  CachePattern,
  CacheResult,
  ScoredNeighbor,
  DeliberationCacheSnapshot,
} from './types'
import { FINGERPRINT_VERSION, fingerprintSimilarity } from './fingerprint'
import { composeOutput } from './composition'

const DEFAULT_CONFIG: Required<DeliberationCacheConfig> = {
  maxPatterns: 5000,
  k: 5,
  minSimilarity: 0.75,
  theta: 0.70,
  tau: 0.5,
  eta: 0.1,
  decayPerCycle: 0.999,
  verifyEveryNHits: 5,
  scopes: [ 'actions' ],
}

export class DeliberationCache {
  readonly name = 'deliberation-cache'

  private _patterns: CachePattern[] = []
  private _config: Required<DeliberationCacheConfig>
  private _hitCount = 0
  private _missCount = 0
  private _verifyCounter = 0

  constructor( config: DeliberationCacheConfig = {} ){
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  get size(): number { return this._patterns.length }
  get hitCount(): number { return this._hitCount }
  get missCount(): number { return this._missCount }

  // ── Retrieval + composition ──────────────────────────────

  /**
   * Retrieve neighbors of `queryFp` and, if confident, compose an output.
   * Confidence ρ = max over neighbors of (competence × similarity), per the
   * research sketch §2.2 — a diffuse cloud of weak matches never triggers a hit.
   */
  retrieve( queryFp: Float32Array, _tick: Tick ): CacheResult {
    const neighbors = this._retrieveNeighbors( queryFp )
    if( neighbors.length === 0 ){
      this._missCount++
      return { output: null, confidence: 0, neighbors: [], hit: false }
    }

    let confidence = 0
    for( const n of neighbors ){
      const score = n.pattern.competence * n.similarity
      if( score > confidence ) confidence = score
    }

    const hit = confidence >= this._config.theta
    if( hit ) this._hitCount++
    else this._missCount++

    const output = hit
      ? composeOutput( neighbors, this._config.tau, this._config.scopes )
      : null

    return { output, confidence, neighbors, hit }
  }

  /** Store a new (fingerprint, output) pair from the slow (LLM) path. */
  learn( queryFp: Float32Array, output: ExecutiveOutputFull, tick: Tick ): void {
    this._evictIfFull( tick )
    this._patterns.push( {
      fingerprint: new Float32Array( queryFp ),
      output,
      competence: 0.5,
      storedAtTick: tick,
      retrievalCount: 0,
      successCount: 0,
    } )
  }

  /**
   * Update the competence of the pattern nearest to `queryFp`, from a reafference
   * reward in [0,1]. Called after an action outcome is confirmed.
   */
  updateCompetence( queryFp: Float32Array, reward: number, _tick: Tick ): void {
    const best = this._findBestMatch( queryFp )
    if( !best ) return
    const r = Math.max( 0, Math.min( 1, reward ) )
    best.retrievalCount++
    if( r > 0.5 ) best.successCount++
    const a = this._config.eta
    best.competence = Math.max( 0, Math.min( 1, best.competence * ( 1 - a ) + r * a ) )
  }

  /** Decay all competences one executive cycle. Slowly forgets stale patterns. */
  decay(): void {
    const f = this._config.decayPerCycle
    if( f >= 1 ) return
    for( const p of this._patterns ) p.competence *= f
  }

  /** Deterministic 1-in-N verify schedule. Increments a counter each call. */
  shouldVerify(): boolean {
    if( this._config.verifyEveryNHits <= 0 ) return false
    this._verifyCounter++
    return this._verifyCounter % this._config.verifyEveryNHits === 0
  }

  // ── Snapshot / restore (entity persistence + tests) ──────

  snapshot(): DeliberationCacheSnapshot {
    return {
      version: FINGERPRINT_VERSION,
      patterns: this._patterns.map( p => ( {
        fingerprint: Array.from( p.fingerprint ),
        output: p.output,
        competence: p.competence,
        storedAtTick: p.storedAtTick,
        retrievalCount: p.retrievalCount,
        successCount: p.successCount,
      } ) ),
      hitCount: this._hitCount,
      missCount: this._missCount,
      verifyCounter: this._verifyCounter,
    }
  }

  restore( snap: DeliberationCacheSnapshot ): void {
    // Version guard: a fingerprint layout change invalidates stored vectors.
    if( snap.version !== FINGERPRINT_VERSION ) return
    this._patterns = snap.patterns.map( p => ( {
      fingerprint: new Float32Array( p.fingerprint ),
      output: p.output,
      competence: p.competence,
      storedAtTick: p.storedAtTick,
      retrievalCount: p.retrievalCount,
      successCount: p.successCount,
    } ) )
    this._hitCount = snap.hitCount ?? 0
    this._missCount = snap.missCount ?? 0
    this._verifyCounter = snap.verifyCounter ?? 0
  }

  // ── Internal ─────────────────────────────────────────────

  private _retrieveNeighbors( queryFp: Float32Array ): ScoredNeighbor[] {
    const scored: ScoredNeighbor[] = []
    for( const p of this._patterns ){
      const similarity = fingerprintSimilarity( queryFp, p.fingerprint )
      if( similarity >= this._config.minSimilarity )
        scored.push( { pattern: p, similarity } )
    }

    // Rank by (similarity × competence) desc; ties → older pattern first.
    scored.sort( ( a, b ) => {
      const sa = a.similarity * a.pattern.competence
      const sb = b.similarity * b.pattern.competence
      if( sa !== sb ) return sb - sa
      return a.pattern.storedAtTick - b.pattern.storedAtTick
    } )

    return scored.slice( 0, this._config.k )
  }

  private _findBestMatch( queryFp: Float32Array ): CachePattern | null {
    let best: CachePattern | null = null
    let bestSim = -1
    for( const p of this._patterns ){
      const sim = fingerprintSimilarity( queryFp, p.fingerprint )
      if( sim > bestSim ){ bestSim = sim; best = p }
    }
    return best
  }

  private _evictIfFull( _tick: Tick ): void {
    if( this._patterns.length < this._config.maxPatterns ) return
    // Evict the LEAST competent pattern; ties break on the oldest (lowest
    // storedAtTick). Age is handled by decay() — stale patterns bleed competence
    // toward 0 each cycle, so competence alone already ranks them lowest. Folding
    // recency INTO the score inverts value: a high-competence *old* pattern would
    // score below a low-competence *new* one and be wrongly evicted.
    let evictIdx = 0
    let best = this._patterns[ 0 ]!
    for( let i = 1; i < this._patterns.length; i++ ){
      const p = this._patterns[ i ]!
      if( p.competence < best.competence ||
        ( p.competence === best.competence && p.storedAtTick < best.storedAtTick ) ){
        best = p
        evictIdx = i
      }
    }
    this._patterns.splice( evictIdx, 1 )
  }
}

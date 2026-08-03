// ─────────────────────────────────────────────────────────────
// src/cognition/cache/types.ts
// ─────────────────────────────────────────────────────────────

/**
 * DeliberationCache — types and contracts.
 *
 * The cache stores past executive outputs keyed by a deterministic
 * cognitive fingerprint. It is pure, deterministic, and R2-safe:
 * the same state + same history ⇒ same retrieval + same composition.
 *
 * Scope note: Phase 1 caches the ACTIONS block only. The composed output
 * is a valid `ExecutiveOutputFull` carrying the three required fields
 * (actions, reasoning, confidence) plus whatever optional blocks the
 * enabled scopes cover. Everything else stays undefined and the existing
 * downstream (`buildStateCommands`) treats it as "nothing to do", which is
 * exactly the intended Phase-1 behaviour.
 */

import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'

/** Which blocks of the executive output the cache may synthesise. */
export type CacheScope =
  | 'actions'
  | 'goals'
  | 'beliefs'

export interface DeliberationCacheConfig {
  /** Maximum patterns to retain. Lowest (competence × recency) evicted when full. */
  maxPatterns?: number
  /** Neighbors retrieved for composition. */
  k?: number
  /** Minimum similarity for a stored pattern to count as a neighbor. */
  minSimilarity?: number
  /** Confidence threshold θ — cache hit requires ρ ≥ θ. Start conservative. */
  theta?: number
  /** Temperature for softmax weights over neighbors. */
  tau?: number
  /** Learning rate (EMA) for competence updates. */
  eta?: number
  /** Competence decay per executive cycle (applied via decay()). */
  decayPerCycle?: number
  /** Verify 1-in-N cache hits against the LLM (0 = never). */
  verifyEveryNHits?: number
  /** Which output blocks to synthesise. Phase 1 default: ['actions']. */
  scopes?: CacheScope[]
}

/** A stored pattern in the cache. */
export interface CachePattern {
  /** Deterministic fingerprint vector (length FINGERPRINT_DIM). */
  fingerprint: Float32Array
  /** The executive output produced for this fingerprint (verbatim from the LLM). */
  output: ExecutiveOutputFull
  /** Competence score (0–1), learned from reafference. */
  competence: number
  /** Tick when stored. */
  storedAtTick: number
  /** Number of times this pattern won a retrieval. */
  retrievalCount: number
  /** Number of retrievals that were followed by a positive reafference. */
  successCount: number
}

/** A neighbor plus its similarity to the query fingerprint. */
export interface ScoredNeighbor {
  pattern: CachePattern
  /** Cosine similarity of this pattern's fingerprint to the query. */
  similarity: number
}

/** Result of a cache retrieve (+ compose when hit). */
export interface CacheResult {
  /** The composed output — only meaningful when `hit` is true. */
  output: ExecutiveOutputFull | null
  /** Confidence ρ = max_i (competence_i × sim_i). Used for gating. */
  confidence: number
  /** The scored neighbors that were considered. */
  neighbors: ScoredNeighbor[]
  /** Whether this was a cache hit (confidence ≥ θ). */
  hit: boolean
}

/**
 * Serialisable snapshot for deterministic persistence / restore.
 *
 * Persistence follows the same pattern as the rolling summarizer: the engine
 * writes this into a state entity (`executive-deliberation-cache`) via
 * StateCommands and rehydrates it on the first tick. Float arrays are stored
 * as plain number[] so they survive JSON round-tripping through state.
 */
export interface DeliberationCacheSnapshot {
  version: number
  patterns: Array<{
    fingerprint: number[]
    output: ExecutiveOutputFull
    competence: number
    storedAtTick: number
    retrievalCount: number
    successCount: number
  }>
  hitCount: number
  missCount: number
  verifyCounter: number
}

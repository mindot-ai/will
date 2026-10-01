// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/semantic.engine/types.ts
// ─────────────────────────────────────────────────────────────

import type { Tick } from '#core/types'
import type { CognitiveBus } from '#cognition/bus'

// Stop words to strip before text-similarity comparison.
// Keeps common filler from driving false belief merges.
export const _STOP_WORDS = new Set([
  'i','my','me','we','our','you','your','it','its',
  'the','a','an','and','or','but','in','on','at','to',
  'for','of','with','by','from','is','are','was','were',
  'be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','can',
  'this','that','these','those','not','no','so','as',
  'if','then','than','very','just','more','most','also',
])

export interface SemanticIntegratorConfig {
  minIntervalTicks?: number
  minNewEpisodes?: number
  /** Ticks without reinforcement before a belief starts losing confidence */
  beliefStalenessThreshold?: number
  /** Confidence lost per second of running time once a belief goes stale. See DEFAULT_BELIEF_DECAY_PER_SECOND. */
  beliefDecayPerSecond?: number
  /** Minimum similarity threshold for semantic pattern detection (0-1) */
  semanticSimilarityThreshold?: number
  /** Maximum episodes to query for semantic pattern detection */
  semanticQueryLimit?: number
  bus?: CognitiveBus
}

/**
 * How fast an unreinforced belief fades: per second of RUNNING time (the mind's
 * waking time, as the forgetting curve counts it), set so a weak belief (0.3)
 * reaches the 0.12 prune in ~3 days, an even one (0.5) in ~6, a firm one (0.9)
 * in ~13 — the scale of episodic forgetting, which semantic memory should not
 * undercut.
 *
 * It was 0.001 per TICK: at ~1 tick/s a fact nobody repeated was gone in about
 * 16 minutes. Measured on the real integrator, spaced repetition and consolidator
 * over a quiet run: four beliefs at 0.3–0.9, all gone inside an hour.
 */
export const DEFAULT_BELIEF_DECAY_PER_SECOND = ( 0.3 - 0.12 ) / ( 3 * 86_400 )

export interface BeliefHistoryEntry {
  tick:       Tick
  confidence: number  // confidence value after this event
  delta:      number  // change from previous (positive = gained, negative = lost)
  cause:      string  // 'created' | 'reinforced' | 'decayed' | 'executive' | 'heuristic' | 'self-model' | 'semantic'
  /** A run of consecutive decay steps, kept as one entry: the first step's tick… */
  since?:     Tick
  /** …and how many steps; `tick`/`confidence` are the last, `delta` the run's total. */
  steps?:     number
}

export interface Belief {
  id: string
  statement: string
  category: 'world_fact' | 'self_belief' | 'social_belief' | 'causal_rule' | 'pattern'
  confidence: number
  supportingEpisodes: number
  lastUpdatedAt: Tick
  tags: string[]
  /** Bounded trajectory of confidence changes. Max 20 entries; oldest dropped when full.
   *  Becomes a first-class PMM input — the causal story of how a belief formed. */
  history?: BeliefHistoryEntry[]
}

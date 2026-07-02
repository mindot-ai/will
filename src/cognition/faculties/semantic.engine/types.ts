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
  maxBeliefs?: number
  /** Ticks without reinforcement before a belief starts losing confidence */
  beliefStalenessThreshold?: number
  /** Confidence lost per tick once a belief goes stale */
  beliefDecayRate?: number
  /** Minimum similarity threshold for semantic pattern detection (0-1) */
  semanticSimilarityThreshold?: number
  /** Maximum episodes to query for semantic pattern detection */
  semanticQueryLimit?: number
  bus?: CognitiveBus
}

export interface BeliefHistoryEntry {
  tick:       Tick
  confidence: number  // confidence value after this event
  delta:      number  // change from previous (positive = gained, negative = lost)
  cause:      string  // 'created' | 'reinforced' | 'decayed' | 'executive' | 'heuristic' | 'self-model' | 'semantic'
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

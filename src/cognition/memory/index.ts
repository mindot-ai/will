// ─────────────────────────────────────────────────────────────
// src/cognition/memory/index.ts
// ─────────────────────────────────────────────────────────────

/**
 * Vector memory module exports.
 *
 * Provides semantic similarity search for episodic memory
 * without breaking deterministic replay or existing Map-based state.
 */

export {
  DefaultVectorMemoryAdapter,
  type VectorMemoryAdapter
} from '#memory/vector.adapter'

export {
  HNSWIndex,
  type VectorIndex
} from '#memory/vector.index'

export {
  OpenAICompatibleEmbedder,
  MockEmbedder,
  type EmbeddingProvider
} from '#memory/vector.embedder'

export { episodeContentToText } from '#memory/vector.content'

export type {
  VectorMemoryConfig,
  VectorRecord,
  VectorQueryResult,
  VectorQueryFilter
} from '#memory/vector.types'
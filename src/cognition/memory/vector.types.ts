// ─────────────────────────────────────────────────────────────
// src/cognition/memory/vector.types.ts
// ─────────────────────────────────────────────────────────────

/**
 * Vector memory types for semantic episodic retrieval.
 *
 * Provides similarity search over consolidated episodic memories
 * without replacing the existing _store array or StateManager.
 * Acts as a read-optimized secondary index.
 */

import type { Tick } from '#core/types'

export interface VectorMemoryConfig {
  /** Dimension of embedding vectors (default 1536 for OpenAI text-embedding-3-small) */
  dimensions?: number
  /** Similarity metric: 'cosine', 'euclidean', or 'dot' */
  similarityMetric?: 'cosine' | 'euclidean' | 'dot'
  /** Maximum number of episodes to index (older entries evicted) */
  maxIndexedEpisodes?: number
  /** Minimum similarity threshold for query results (0-1). Default 0.35, tuned
   *  for real sentence embeddings (text-embedding-3-small); raise for higher
   *  precision. */
  minSimilarity?: number
  /** Seed for the index's level-assignment PRNG — required for deterministic replay */
  seed?: number
}

export interface VectorRecord {
  id: string                    // matches EpisodicMemory.id
  vector: number[]
  embeddingModel: string        // e.g., 'text-embedding-3-small'
  createdAt: number
  metadata: {
    tick: Tick
    sourceType: string
    /** Encode-time affective valence (-1..1). Stamped here so index backends that
     *  CAN filter/rank on metadata (pgvector, Qdrant) may do affective filtering
     *  server-side. The HNSW path is similarity-only, so its mood-congruent recall
     *  (EpisodicConsolidator.semanticQuery affectiveBias) re-ranks on the
     *  authoritative resolved-episode valence instead. */
    emotionalValence: number
    tags: string[]
  }
}

export interface VectorQueryResult {
  episodeId: string
  similarity: number
}

/**
 * Query knobs for vector search.
 *
 * The HNSW index is **similarity-only**: it ranks by vector distance and
 * applies a `minSimilarity` floor, nothing else. Metadata is stored on
 * VectorRecord but is NOT indexed, so any metadata-based narrowing
 * (sourceType / valence / tags / tick range) must be done by the caller
 * AFTER the search returns. See episodic.consolidator.semanticQuery.
 */
export interface VectorQueryFilter {
  minSimilarity?: number
  maxResults?: number
}
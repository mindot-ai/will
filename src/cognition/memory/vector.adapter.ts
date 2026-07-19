// ─────────────────────────────────────────────────────────────
// src/cognition/memory/vector.adapter.ts
// ─────────────────────────────────────────────────────────────

/**
 * VectorMemoryAdapter — primary interface for cognitive engines.
 *
 * Provides semantic similarity search over episodic memory.
 * Accepts any VectorIndex implementation (HNSW, Qdrant, pgvector, Pinecone)
 * and any EmbeddingProvider (OpenAI, local, mock).
 *
 * Follows the StorageAdapter pattern from replay.ts — receives storage
 * in constructor for persistence of the index itself.
 */

import { logger } from '#core/logger'
import { wallClock } from '#core/wall.clock'
import type { StorageAdapter } from '#core/abstracts'
import type { EpisodicMemory } from '#faculties/episodic.consolidator'
import type { EmbeddingProvider } from '#memory/vector.embedder'
import type { VectorRecord, VectorQueryFilter, VectorQueryResult, VectorMemoryConfig } from '#memory/vector.types'
import type { VectorIndex } from '#memory/vector.index'
import { BunStorageAdapter } from '#core/abstracts'
import { HNSWIndex } from '#memory/vector.index'
import { episodeContentToText } from '#memory/vector.content'

export interface VectorMemoryAdapter {
  /** Index an episodic memory (called during consolidation) */
  index( episode: EpisodicMemory, content: unknown ): Promise<void>

  /** Index multiple episodes in batch */
  indexBatch( episodes: Array<{ episode: EpisodicMemory; content: unknown }> ): Promise<void>

  /** Search for semantically similar episodes — returns ID + similarity, caller resolves from store */
  search( query: unknown, filter?: VectorQueryFilter ): Promise<VectorQueryResult[]>

  /** Search with embedding vector directly */
  searchWithVector( embedding: number[], filter?: VectorQueryFilter ): Promise<VectorQueryResult[]>

  /** Delete an episode from the index (when pruned from _store) */
  delete( episodeId: string ): Promise<void>

  /** Rebuild entire index from store (called on snapshot restore when no persisted index exists) */
  rebuildFromStore( store: EpisodicMemory[] ): Promise<void>

  /** Persist index to storage */
  persist(): Promise<void>

  /** Load index from storage */
  load(): Promise<void>

  /** Get current index size */
  readonly size: number
}

export class DefaultVectorMemoryAdapter implements VectorMemoryAdapter {
  private _index: VectorIndex
  private _embedder: EmbeddingProvider
  private _storage: StorageAdapter
  private _persistPath: string
  private _metaPath: string
  private _maxIndexedEpisodes: number
  private _indexedIds: Set<string> = new Set()
  private _dirty: boolean = false
  private _persistDebounceTimer: NodeJS.Timeout | null = null
  private _minSimilarity: number
  /** Per-id access recency (insert + search hit) for LRU-style eviction. A plain
   *  monotonic counter — not persisted; rebuilt from insertion order on load. */
  private _accessTick: Map<string, number> = new Map()
  private _accessClock: number = 0

  constructor(
    embedder: EmbeddingProvider,
    config: VectorMemoryConfig & { persistPath?: string } = {},
    storage: StorageAdapter = new BunStorageAdapter(),
    indexImpl: VectorIndex = new HNSWIndex( config )
  ){
    this._embedder = embedder
    this._storage = storage
    this._index = indexImpl
    this._persistPath = config.persistPath ?? './data/vector_index'
    this._metaPath = `${this._persistPath}.meta`
    this._maxIndexedEpisodes = config.maxIndexedEpisodes ?? 10000
    // 0.35 suits real sentence embeddings (e.g. text-embedding-3-small), where
    // genuinely related-but-reworded memories commonly score 0.3–0.5 cosine. The
    // old 0.65 floor was high enough that semantic recall returned nothing for
    // most relevant memories and quietly fell back to recency. Tunable per Will.
    this._minSimilarity = config.minSimilarity ?? 0.35
  }

  /** Record that `id` was just inserted or recalled, so eviction keeps the
   *  memories the Will actually uses (LRU) and drops the genuinely cold ones. */
  private _touch( id: string ): void {
    this._accessTick.set( id, ++this._accessClock )
  }

  get size(): number {
    return this._index.size
  }

  async index( episode: EpisodicMemory, content: unknown ): Promise<void> {
    if( this._indexedIds.has( episode.id ) ) return

    if( this._index.size >= this._maxIndexedEpisodes )
      await this._evictColdest()

    const embedding = await this._embedder.embed( episodeContentToText( content ), 'index')

    const record: VectorRecord = {
      id: episode.id,
      vector: embedding,
      embeddingModel: this._embedder.modelName,
      createdAt: wallClock(),  // determinism-ok: secondary index telemetry, rebuilt from _store, never in replay state
      metadata: {
        tick: episode.timestamp,
        sourceType: episode.sourceType,
        emotionalValence: episode.affectiveContext.valence,
        tags: episode.tags
      }
    }

    await this._index.insert( record )
    this._indexedIds.add( episode.id )
    this._touch( episode.id )
    this._dirty = true
    this._schedulePersist()
  }

  async indexBatch(
    episodes: Array<{ episode: EpisodicMemory; content: unknown }>
  ): Promise<void> {
    const newEpisodes = episodes.filter( e => !this._indexedIds.has( e.episode.id ) )
    if( newEpisodes.length === 0 ) return

    // `size > 0` guards against an infinite loop when the batch alone exceeds
    // the cap — once the index is drained there is nothing left to evict.
    while( this._index.size > 0 && this._index.size + newEpisodes.length > this._maxIndexedEpisodes )
      await this._evictColdest()

    const contents = newEpisodes.map( e => episodeContentToText( e.content ) )
    const embeddings = await this._embedder.embedBatch( contents, 'index')

    for( let i = 0; i < newEpisodes.length; i++ ){
      const { episode } = newEpisodes[i]!
      const embedding = embeddings[i]!

      const record: VectorRecord = {
        id: episode.id,
        vector: embedding,
        embeddingModel: this._embedder.modelName,
        createdAt: wallClock(),  // determinism-ok: secondary index telemetry, rebuilt from _store, never in replay state
        metadata: {
          tick: episode.timestamp,
          sourceType: episode.sourceType,
          emotionalValence: episode.affectiveContext.valence,
          tags: episode.tags
        }
      }

      await this._index.insert( record )
      this._indexedIds.add( episode.id )
      this._touch( episode.id )
    }

    this._dirty = true
    this._schedulePersist()
  }

  async search( query: unknown, filter?: VectorQueryFilter ): Promise<VectorQueryResult[]> {
    const embedding = await this._embedder.embed( episodeContentToText( query ), 'recall')
    return this.searchWithVector( embedding, filter )
  }

  async searchWithVector( embedding: number[], filter?: VectorQueryFilter ): Promise<VectorQueryResult[]> {
    // HNSW search is similarity-only (see VectorQueryFilter). Metadata-based
    // narrowing, if any, is the caller's job post-search.
    const results = await this._index.search( embedding, filter?.maxResults ?? 10, {
      minSimilarity: filter?.minSimilarity ?? this._minSimilarity,
    } )
    // Recall warms the cache: bump access recency so frequently-recalled memories
    // survive eviction (LRU) — the index keeps what the Will actually uses.
    for( const r of results ) this._touch( r.episodeId )
    return results
  }

  async delete( episodeId: string ): Promise<void> {
    if( await this._index.delete( episodeId ) ){
      this._indexedIds.delete( episodeId )
      this._accessTick.delete( episodeId )
      this._dirty = true
      this._schedulePersist()
    }
  }

  async rebuildFromStore( store: EpisodicMemory[] ): Promise<void> {
    await this._index.clear()
    this._indexedIds.clear()
    this._accessTick.clear()
    this._accessClock = 0

    const episodesWithContent = store.map( episode => ( {
      episode,
      content: episode.content
    } ) )

    await this.indexBatch( episodesWithContent )
    this._dirty = true
    await this.persist()
  }

  async persist(): Promise<void> {
    if( !this._dirty ) return

    if( this._index.serialize ){
      const serialized = this._index.serialize()
      await this._storage.write( this._persistPath, serialized )
      // Stamp the embedding model + dimensions next to the index so a later
      // load() can detect drift (see load()) and rebuild instead of querying
      // vectors that live in a different model's space.
      await this._storage.write(
        this._metaPath,
        JSON.stringify({ model: this._embedder.modelName, dimensions: this._embedder.dimensions })
      )
    }

    this._dirty = false
  }

  async load(): Promise<void> {
    try {
      const exists = await this._storage.exists( this._persistPath )
      if( !exists ) return

      // Guard against embedding-model / dimension drift. A persisted index holds
      // vectors in the model's space at build time; querying it with a different
      // model (or dimension count) silently corrupts similarity — mismatched
      // lengths read past array ends → NaN, so recall quietly returns nothing.
      // On a mismatch we skip the load and leave the index empty, which makes the
      // restore path rebuild it from the store with the current embedder.
      // A missing meta file (index persisted before this stamp existed) is treated
      // as "unknown but trusted" — we proceed rather than force a mass re-embed.
      if( await this._storage.exists( this._metaPath ) ){
        try {
          const meta = JSON.parse( await this._storage.read( this._metaPath ) ) as { model?: string; dimensions?: number }
          if( meta.model !== this._embedder.modelName || meta.dimensions !== this._embedder.dimensions ){
            logger.warn(
              `[VectorMemoryAdapter] Persisted index was built with ${meta.model}/${meta.dimensions}d ` +
              `but current embedder is ${this._embedder.modelName}/${this._embedder.dimensions}d — ` +
              `discarding stale index (will rebuild from store).`
            )
            return
          }
        }
        catch { /* unreadable meta — fall through to a best-effort load */ }
      }

      const bytes = await this._storage.readBytes( this._persistPath )

      if( this._index.deserialize ){
        await this._index.deserialize( bytes )
        // Rebuild the dedup/eviction id-set from the loaded index. Without this,
        // _indexedIds stays empty after a restore while the index is full, so
        // _evictOldest (which iterates _indexedIds) becomes a no-op and the
        // indexBatch eviction loop spins forever once the index is at its cap.
        this._indexedIds.clear()
        this._accessTick.clear()
        this._accessClock = 0
        if( this._index.keys )
          for( const id of this._index.keys() ){
            this._indexedIds.add( id )
            // Seed access recency in insertion order so a freshly-loaded index
            // evicts oldest-first until real recalls warm specific entries.
            this._touch( id )
          }
      }
    }
    catch( err ){
      logger.warn(`[VectorMemoryAdapter] Failed to load index:`, err )
    }
  }

  private async _evictColdest(): Promise<void> {
    // Evict the least-recently-used entries (lowest access tick), not merely the
    // oldest-inserted: a memory that is recalled often stays warm and survives,
    // while genuinely cold ones go first — so the bounded index keeps what the
    // Will actually uses. Never-touched entries fall back to insertion order
    // (their access tick was seeded at insert/load). Drop ~10% of the cap (≥1)
    // per call to amortise the rank over many inserts; each call strictly shrinks
    // the index, so the indexBatch eviction loop is guaranteed to terminate.
    const target = Math.max( 1, Math.floor( this._maxIndexedEpisodes * 0.1 ) )

    const victims = Array.from( this._indexedIds )
      .sort( ( a, b ) => ( this._accessTick.get( a ) ?? 0 ) - ( this._accessTick.get( b ) ?? 0 ) )
      .slice( 0, target )

    for( const id of victims ){
      await this._index.delete( id )
      this._indexedIds.delete( id )
      this._accessTick.delete( id )
    }

    if( victims.length > 0 ) this._dirty = true
  }

  private _schedulePersist(): void {
    if( this._persistDebounceTimer )
      clearTimeout( this._persistDebounceTimer )

    this._persistDebounceTimer = setTimeout( () => {
      this.persist().catch( err => {
        logger.error(`[VectorMemoryAdapter] Persist failed:`, err )
      } )
      this._persistDebounceTimer = null
    }, 5000 )
  }
}
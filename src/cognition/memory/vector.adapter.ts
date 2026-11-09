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
import { paginate, itemText, estimateTokens, PAGE_TOKENS } from '#faculties/executive.engine/view'

/**
 * What an observation held — the data a remembered percept keeps under `content`.
 * Undefined for anything else.
 */
function heldData( content: unknown ): unknown {
  if( !content || typeof content !== 'object') return undefined
  const c = content as Record<string, unknown>
  const inner = c['content']
  if( inner && typeof inner === 'object' && ( inner as Record<string, unknown> )['data'] !== undefined )
    return ( inner as Record<string, unknown> )['data']
  return c['data']
}

/** `episodic-12-0#3` (page 3) or `episodic-12-0#3.2` (its second piece) → the episode and the page. */
export function chunkOf( id: string ): { episodeId: string; page?: number } {
  const m = /^(.*)#(\d+)(?:\.\d+)?$/.exec( id )
  return m ? { episodeId: m[1]!, page: Number( m[2] ) } : { episodeId: id }
}

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
  /**
   * Episodes whose embedding is on its way, and those forgotten meanwhile.
   * Indexing is fire-and-forget (the embedding is a network call); an episode
   * forgotten before its vector arrived was deleted from an index that did not
   * hold it yet, and the vector then landed for a memory that no longer
   * existed. A mind forgetting within seconds banked 9,671 of them against zero
   * live episodes, and they took recall's top-k slots from the living.
   */
  private _inFlight  = new Set<string>()
  private _cancelled = new Set<string>()
  /** Each episode's page vectors — what it held, embedded a page at a time (LOSSLESS P5e). */
  private _pageIds = new Map<string, string[]>()

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
    // No eviction unless a host asks for a bound. At 10,000 this dropped ~10% of
    // the index, least-recently-used first: the episodes stayed remembered and
    // became unreachable by meaning. The index follows the store, and the store
    // is bounded by forgetting, which deletes the vector too (LOSSLESS P3).
    this._maxIndexedEpisodes = config.maxIndexedEpisodes ?? Infinity
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
    await this.indexBatch( [ { episode, content } ] )
  }

  /**
   * What one episode is embedded as: its label, and — for an observation — every
   * page of what it held (LOSSLESS P5e). An observation was embedded by its label
   * alone, at most a hundred characters, so recall could find that she had read a
   * listing and never the part of it that answered. A page longer than the
   * embedder takes is split into pieces, never cut.
   */
  private _texts( episode: EpisodicMemory, content: unknown ): Array<{ id: string; text: string }> {
    const out = [ { id: episode.id, text: episodeContentToText( content ) } ]
    const data = heldData( content )
    if( data === undefined ) return out
    // The estimate runs high (3 bytes a token), and a quarter more is held back.
    const piece = Math.max( 64, Math.floor( ( this._embedder.maxInputTokens ?? 2_048 ) * 0.75 ) )
    paginate( itemText( data ), PAGE_TOKENS ).forEach( ( page, i ) => {
      if( !page.trim() ) return
      const pieces = estimateTokens( page ) <= piece ? [ page ] : paginate( page, piece )
      pieces.forEach( ( text, k ) => out.push( { id: pieces.length === 1 ? `${ episode.id }#${ i + 1 }` : `${ episode.id }#${ i + 1 }.${ k + 1 }`, text } ) )
    } )
    return out
  }

  async indexBatch(
    episodes: Array<{ episode: EpisodicMemory; content: unknown }>
  ): Promise<void> {
    const newEpisodes = episodes.filter( e => !this._indexedIds.has( e.episode.id ) )
    if( newEpisodes.length === 0 ) return

    // `size > 0` guards against an infinite loop when the batch alone exceeds
    // the cap — once the index is drained there is nothing left to evict.
    while( this._indexedIds.size > 0 && this._indexedIds.size + newEpisodes.length > this._maxIndexedEpisodes )
      await this._evictColdest()

    // One embedding call for every episode's label and pages: one in-flight set, so
    // an episode forgotten meanwhile cancels its pages with it (P3a).
    const texts = newEpisodes.map( e => this._texts( e.episode, e.content ) )
    const flat  = texts.flat()
    const embeddings = await this._embedInFlight( newEpisodes.map( e => e.episode.id ), () => this._embedder.embedBatch( flat.map( t => t.text ), 'index') )

    let at = 0
    for( let i = 0; i < newEpisodes.length; i++ ){
      const { episode } = newEpisodes[i]!
      const mine = texts[i]!
      const vectors = embeddings.slice( at, at + mine.length )
      at += mine.length
      if( this._cancelled.delete( episode.id ) ) continue

      for( let j = 0; j < mine.length; j++ )
        await this._index.insert( {
          id: mine[j]!.id,
          vector: vectors[j]!,
          embeddingModel: this._embedder.modelName,
          createdAt: wallClock(),  // determinism-ok: secondary index telemetry, rebuilt from _store, never in replay state
          metadata: {
            tick: episode.timestamp,
            sourceType: episode.sourceType,
            emotionalValence: episode.affectiveContext.valence,
            tags: episode.tags,
            ...( j > 0 ? { page: chunkOf( mine[j]!.id ).page } : {} ),
          }
        } satisfies VectorRecord )
      if( mine.length > 1 ) this._pageIds.set( episode.id, mine.slice( 1 ).map( t => t.id ) )
      this._indexedIds.add( episode.id )
      this._touch( episode.id )
    }

    this._dirty = true
    this._schedulePersist()
  }

  /** Run an embedding call with its ids marked in flight, so a delete meanwhile cancels them. */
  private async _embedInFlight<T>( ids: string[], embed: () => Promise<T> ): Promise<T> {
    for( const id of ids ) this._inFlight.add( id )
    try { return await embed() }
    catch( err ){
      // Nothing will be inserted; a cancel left behind would skip a later re-index.
      for( const id of ids ) this._cancelled.delete( id )
      throw err
    }
    finally { for( const id of ids ) this._inFlight.delete( id ) }
  }

  async search( query: unknown, filter?: VectorQueryFilter ): Promise<VectorQueryResult[]> {
    const embedding = await this._embedder.embed( episodeContentToText( query ), 'recall')
    return this.searchWithVector( embedding, filter )
  }

  async searchWithVector( embedding: number[], filter?: VectorQueryFilter ): Promise<VectorQueryResult[]> {
    // HNSW search is similarity-only (see VectorQueryFilter). Metadata-based
    // narrowing, if any, is the caller's job post-search.
    const k = filter?.maxResults ?? 10
    // A page is a vector of its own, so an episode can take several slots: ask for
    // more, and keep each episode once — by its best match, and the page that
    // made it (LOSSLESS P5e).
    const hits = await this._index.search( embedding, this._pageIds.size > 0 ? k * 4 : k, {
      minSimilarity: filter?.minSimilarity ?? this._minSimilarity,
    } )
    const best = new Map<string, VectorQueryResult>()
    for( const h of hits ){
      const { episodeId, page } = chunkOf( h.episodeId )
      const was = best.get( episodeId )
      if( !was || h.similarity > was.similarity ) best.set( episodeId, { episodeId, similarity: h.similarity, ...( page ? { page } : {} ) } )
    }
    const results = [ ...best.values() ]
      .sort( ( a, b ) => b.similarity - a.similarity || ( a.episodeId < b.episodeId ? -1 : 1 ) )
      .slice( 0, k )
    // Recall warms the cache: bump access recency so frequently-recalled memories
    // survive eviction (LRU) — the index keeps what the Will actually uses.
    for( const r of results ) this._touch( r.episodeId )
    return results
  }

  async delete( episodeId: string ): Promise<void> {
    if( this._inFlight.has( episodeId ) ) this._cancelled.add( episodeId )
    if( await this._deleteVectors( episodeId ) ){
      this._dirty = true
      this._schedulePersist()
    }
  }

  /** An episode's vector and every page's. True when there was any. */
  private async _deleteVectors( episodeId: string ): Promise<boolean> {
    let any = await this._index.delete( episodeId )
    for( const id of this._pageIds.get( episodeId ) ?? [] ) any = ( await this._index.delete( id ) ) || any
    this._pageIds.delete( episodeId )
    this._indexedIds.delete( episodeId )
    this._accessTick.delete( episodeId )
    return any
  }

  async rebuildFromStore( store: EpisodicMemory[] ): Promise<void> {
    await this._index.clear()
    this._indexedIds.clear()
    this._pageIds.clear()
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
        this._pageIds.clear()
        this._accessTick.clear()
        this._accessClock = 0
        if( this._index.keys )
          for( const id of this._index.keys() ){
            // A page's vector belongs to its episode, and goes when it goes.
            const { episodeId, page } = chunkOf( id )
            if( page !== undefined ){ this._pageIds.set( episodeId, [ ...( this._pageIds.get( episodeId ) ?? [] ), id ] ); continue }
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

    for( const id of victims ) await this._deleteVectors( id )

    if( victims.length > 0 ) this._dirty = true
  }

  /**
   * Throttle, NOT a debounce. The previous version cleared and re-armed the timer on
   * every index(), so it only ever fired after 5s of complete inactivity — and a mind
   * consolidating steadily indexes far more often than that, so the write was pushed
   * back indefinitely and the index never reached disk while it was awake.
   *
   * A pending timer is now left alone: the first write after a quiet period sets the
   * deadline, and everything indexed within the window rides along on it. Persist is
   * bounded at 5s from the FIRST pending change rather than the last.
   */
  private _schedulePersist(): void {
    if( this._persistDebounceTimer ) return

    this._persistDebounceTimer = setTimeout( () => {
      this._persistDebounceTimer = null
      this.persist().catch( err => {
        logger.error(`[VectorMemoryAdapter] Persist failed:`, err )
      } )
    }, 5000 )
  }
}
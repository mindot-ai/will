// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/episodic.consolidator.ts
// ─────────────────────────────────────────────────────────────

/**
 * EpisodicConsolidator — converts working memory episodes into long-term
 * episodic memory.
 *
 * Consolidation is selective:
 *   - Emotionally intense episodes consolidate more strongly
 *   - Repeatedly activated items consolidate
 *   - Sleep enhances consolidation (DreamSimulator handles this)
 *   - Novel/surprising episodes are prioritized
 *
 * Interfaces with the in-house vector/memory store for persistent storage.
 * (Initial implementation uses an in-memory store; durable persistence
 * is a later phase when the memory bridge is built.)
 *
 * Part of Shard 2 (Memory Layer) — runs every tick, synchronous.
 *
 * VECTOR MEMORY INTEGRATION:
 *   - Optional VectorMemoryAdapter for semantic similarity search
 *   - Indexes episodes automatically on consolidation
 *   - Rebuilds index from _store on snapshot restore
 *   - No storage limit (infinite _store, only vector index may have limit)
 */

import { logger } from '#core/logger'
import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { VectorMemoryAdapter } from '#memory/vector.adapter'
import type { EmbeddingProvider } from '#memory/vector.embedder'
import { GenerativeModel } from '#cognition/generative.model'

export interface EpisodicConsolidatorConfig {
  /** Threshold above which a WM item is consolidated */
  consolidationThreshold?: number
  /** How much emotional intensity boosts consolidation (multiplier) */
  emotionBoost?: number
  /** Optional vector memory adapter for semantic search */
  vectorMemory?: VectorMemoryAdapter
  /** Optional embedding provider (required if vectorMemory provided) */
  embedder?: EmbeddingProvider
  /** Whether to automatically index episodes (default true) */
  autoIndex?: boolean
  bus?: CognitiveBus
}

export interface EpisodicMemory {
  id: string
  timestamp: Tick
  content: unknown
  emotionalTags: Record<string, number>  // emotion → intensity at time of encoding
  affectiveContext: { valence: number; arousal: number; dominance: number }
  activationStrength: number
  retrievalCount: number
  lastRetrievedAt: Tick | null
  tags: string[]
  sourceType: string  // 'percept', 'goal', 'thought', 'interoception'
  /** Wall-clock ms at the moment the episode was first consolidated. */
  createdAt: number
  /**
   * Outcome lifecycle of the originating action/intent:
   *   'intended'  — goal or plan was formed but not yet attempted
   *   'attempted' — action was dispatched; outcome unknown at consolidation time
   *   'confirmed' — action was confirmed successful (e.g. message delivered)
   *   'failed'    — action failed, timed out, or was abandoned
   */
  outcomeStatus?: 'intended' | 'attempted' | 'confirmed' | 'failed'
  /**
   * Which working-memory item this was consolidated from (`sourceIdentity`). One
   * item becomes one episode — this is what `_findCandidates` dedups on. Absent
   * on episodes written before it existed, which simply never block anything.
   */
  sourceId?: string
}

/**
 * A working-memory item's identity: its id.
 *
 * Every runtime writer names an item for the thing it holds, for that thing's
 * whole life — `wm-goal-<goal>`, `wm-percept-<percept>`, `wm-plan-<plan>`, and
 * `wm-exchange-<entity>-<tick>-<hash of the words>`. So the id is the identity,
 * and content is deliberately NOT part of it: a goal's priority drifts every
 * tick, and keyed on content the same goal became a new "memory" each time it
 * moved — 1,334 episodes of a handful of goals over a 10K-tick soak once
 * forgetting ran in days instead of seconds.
 *
 * `WorkingMemory.load()` mints counter ids (`wm-N`) that restart every boot, and
 * would collide across sessions — it has no runtime caller (tests only). Any
 * runtime writer added later must name its items the same way the others do.
 */
export function sourceIdentity( id: string ): string {
  return id
}

interface WMCandidate {
  /** `sourceIdentity` of the working-memory item — what an episode remembers as its source. */
  id: string
  type: string
  content: unknown
  activation: number
  attendedCount: number
  tags: string[]
}

export class EpisodicConsolidator implements SimulationEngine, CognitiveEngine {
  readonly name = 'episodic-consolidator'

  private _consolidationThreshold: number
  private _emotionBoost: number
  // No maxStoredEpisodes — unlimited storage

  private _store:    EpisodicMemory[]              = []
  private _storeMap: Map<string, EpisodicMemory>   = new Map()
  private _restored = false

  /** Ticks between full-store state syncs (captures decay / dream mutations).
   *  Must be ≤ SnapshotManager.persistInterval (default 15) so every persisted
   *  snapshot contains up-to-date episode values. */
  private readonly _syncInterval   = 10
  private          _ticksSinceSync = 0

  private _affectValence: number = 0
  private _affectArousal: number = 0.3
  private _affectDominance: number = 0.5

  private _bus: CognitiveBus | null = null

  // Vector memory integration
  private _vectorMemory: VectorMemoryAdapter | null = null
  /**
   * In-flight background indexing. Indexing is deliberately not awaited inside
   * react() (a rate-limit retry chain would stall the whole tick loop), so this is
   * the handle for the two callers that genuinely must wait for it: shutdown,
   * before persisting the index, and tests asserting on it.
   */
  private _indexing: Promise<void> = Promise.resolve()
  private _embedder: EmbeddingProvider | null = null
  private _autoIndex: boolean

  private readonly _model    = new GenerativeModel()

  constructor( config: EpisodicConsolidatorConfig = {} ){
    this._bus = config.bus ?? null
    this._consolidationThreshold = config.consolidationThreshold ?? 0.25
    this._emotionBoost           = config.emotionBoost           ?? 2.0
    this._vectorMemory           = config.vectorMemory           ?? null
    this._embedder               = config.embedder               ?? null
    this._autoIndex              = config.autoIndex              ?? true
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-episodic')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return

    if( p.consolidationThreshold != null ) this._consolidationThreshold = p.consolidationThreshold
    if( p.emotionBoost != null ) this._emotionBoost = p.emotionBoost
  }

  subscribes(): string[] {
    return [
      'affect.state.changed',
      'executive.prediction.formed'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'affect.state.changed': {
        this._affectValence = ( e.payload as Record<string, number> )[ 'valence' ] ?? this._affectValence
        this._affectArousal = ( e.payload as Record<string, number> )[ 'arousal' ] ?? this._affectArousal
        this._affectDominance = ( e.payload as Record<string, number> )[ 'dominance' ] ?? this._affectDominance

        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('memory') )
          this._model.setPrecision('episode.rate', 1.0 + p.confidence * 0.5 )

        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      affectValence: this._affectValence,
      affectArousal: this._affectArousal,
      affectDominance: this._affectDominance,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    // On first tick after snapshot restore, rehydrate _store from
    // 'episodic_memory' entities persisted in state.
    if( !this._restored ){
      await this._restoreFromState( state )
      this._restored = true
    }

    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // 1. Scan working memory for consolidation candidates
    const candidates = this._findCandidates( state )

    // 2. Read current affective state for emotional tagging
    const affectiveContext = {
      valence:   state.metrics.get('affect.valence')   ?? 0,
      arousal:   state.metrics.get('affect.arousal')   ?? 0.3,
      dominance: this._affectDominance,
    }

    const currentEmotions = this._readCurrentEmotions( state )

    // 3. Consolidate top candidates
    let consolidated = 0
    const newEpisodes: EpisodicMemory[] = []

    for( const candidate of candidates ){
      // Every candidate that is strong enough, not the first five. What decides
      // whether something is remembered is its strength (below); a per-tick count
      // decided only which of them were lost, because an item another engine
      // writes into working memory is there for one tick. A woken mind is handed
      // its last conversation with each person that way (pma §8) and kept five of
      // them (LOSSLESS P2). A persisted `maxPerTick` in a woken mind's config is
      // ignored.

      // Compute consolidation strength
      const
      wmActivation  = candidate.activation,
      attendedCount = candidate.attendedCount,
      rehearsalBonus = Math.min( 1, attendedCount / 10 ),
      emotionalIntensity = this._computeEmotionalIntensity( currentEmotions ),
      emotionBonus  = emotionalIntensity * this._emotionBoost,
      consolidationStrength = Math.min( 1, wmActivation * 0.4 + rehearsalBonus * 0.3 + emotionBonus * 0.3 )

      if( consolidationStrength < this._consolidationThreshold ) continue

      // Infer outcomeStatus from candidate metadata so memories carry their lifecycle.
      const _inferOutcomeStatus = (
        type: string,
        tags: string[],
      ): EpisodicMemory['outcomeStatus'] => {
        if( type === 'conversation.exchange') return 'confirmed'
        if( tags.includes('failed') || tags.includes('error') || tags.includes('timed_out') ) return 'failed'
        if( tags.includes('completed') || tags.includes('success') || tags.includes('confirmed') ) return 'confirmed'
        if( tags.includes('goal') || tags.includes('plan') ) return 'intended'
        return 'attempted'
      }

      // Create episodic memory. createdAt is sim-time ms (state.time), not
      // wall-clock — it persists into entity state and must replay identically (R2).
      const now = state.time
      const episode: EpisodicMemory = {
        id: `episodic-${tick}-${consolidated}`,
        timestamp: tick,
        content: candidate.content,
        emotionalTags: { ...currentEmotions },
        affectiveContext: { ...affectiveContext },
        activationStrength: consolidationStrength,
        retrievalCount: 0,
        lastRetrievedAt: null,
        tags: candidate.tags,
        sourceType: candidate.type,
        sourceId: candidate.id,
        createdAt: now,
        outcomeStatus: _inferOutcomeStatus( candidate.type, candidate.tags ),
      }

      this._store.push( episode )
      this._storeMap.set( episode.id, episode )
      newEpisodes.push( episode )

      commands.set ??= []
      commands.set.push( this._episodeToEntity( episode ) )

      consolidated++
    }

    // 4. Index new episodes in vector memory (no storage limit).
    // Guard only on _vectorMemory — the adapter owns its embedder internally.
    // Works for both HNSW (local embedder) and pgvector (adapter-managed).
    if( this._vectorMemory && this._autoIndex && newEpisodes.length > 0 ){
      const episodesWithContent = newEpisodes.map( ep => ( {
        episode: ep,
        content: ep.content
      } ) )

      // Indexing is BEST-EFFORT, exactly like semanticQuery. It calls an embedding
      // provider, so a rate limit or an outage is an ordinary condition, not a
      // cognitive fault: the episode is already consolidated and in the store, and
      // only its vector is missing. Letting that throw took the whole engine down
      // mid-tick — observed live as `Engine "episodic-consolidator" threw at tick
      // 107: Embedding failed: 429`, which also aborted the rest of this react()
      // (store sync, forgetting-curve decay) for that tick.
      //
      // The episode itself is NOT lost: it is in `_store` and is written to state by
      // the periodic full-store sync below, so it survives snapshot/restore. Only its
      // VECTOR is missing, which costs semantic recall of that episode for the rest of
      // the session — `rebuildFromStore()` re-indexes the whole store on a later
      // restore that finds no persisted index. Nothing re-indexes it in-session; that
      // is a known gap, not a claim that this self-heals.
      // NOT awaited. Nothing in this tick reads the vector index, and the embedding
      // call is a network round-trip behind a rate-limit gate whose retry chain runs
      // ~60s (4+8+16+32s) before giving up. Awaiting it made a single 429 stall the
      // WHOLE TICK LOOP for a minute — measured: ticks 3→4 and 4→5 took 64.9s and
      // 63.5s, one per deferred batch. That is not merely slow: `AWAIT_TIMEOUT` and
      // every other agency deadline are denominated in TICKS, so a 60s tick silently
      // turned a 15-tick timeout into 15 minutes, left one communicate intent stuck
      // 'awaiting', and — because the selector is serial — blocked every subsequent
      // action. 45 executive decisions produced 1 intent and 0 delivered messages.
      this._indexing = this._vectorMemory.indexBatch( episodesWithContent ).catch( ( err: unknown ) => {
        logger.warn(
          `[EpisodicConsolidator] indexing deferred for ${ newEpisodes.length } episode(s) — ` +
          `${ err instanceof Error ? err.message : String( err ) }`
        )
      } )
    }

    // 5. Periodic full-store sync — captures activationStrength decay (forgetting curve),
    //    emotionalTag dampening (dream simulator), and any other in-memory mutations that
    //    other engines apply directly to episodes via getAllEpisodes().
    //    Without this, snapshots only ever contain creation-time field values.
    this._ticksSinceSync++
    if( this._ticksSinceSync >= this._syncInterval && this._store.length > 0 ){
      this._ticksSinceSync = 0
      commands.set ??= []
      for( const episode of this._store )
        commands.set.push( this._episodeToEntity( episode ) )
    }

    // 6. Metrics (no capacity_used since no limit)
    commands.metrics!.push(
      [ 'memory.episodic_total', this._store.length ],
      [ 'memory.episodic_consolidated', consolidated ],
    )

    if( consolidated > 0 && consolidated >= 3 )
      events.push( {
        type: 'memory.consolidation_burst',
        source: this.name,
        payload: { consolidated, storeSize: this._store.length },
      } )

    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && consolidated > 0 )
      _bus.publish( {
        type: 'episode.consolidated',
        version: 1,
        sourceEngine: this.name,
        salience: Math.max( 0.3, this._model.observe('episode.rate', consolidated ).salience ),
        payload: { total: consolidated }
      } )

    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe('memory.size', this._store.length )
      if( !predErr.gated )
        _bus.publish( {
          type: 'memory.state.changed',
          version: 1,
          sourceEngine: this.name,
          salience: predErr.salience,
          payload: { episodicTotal: this._store.length }
        } )
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Query episodic memory by tags, time range, or emotional context.
   */
  query( filters: {
    tags?: string[]
    fromTick?: Tick
    toTick?: Tick
    minEmotion?: string
    limit?: number
  } ): EpisodicMemory[] {
    let results = [ ...this._store ]

    if( filters.tags?.length )
      results = results.filter( m => filters.tags!.some( t => m.tags.includes( t ) ) )

    if( filters.fromTick !== undefined )
      results = results.filter( m => m.timestamp >= filters.fromTick! )

    if( filters.toTick !== undefined )
      results = results.filter( m => m.timestamp <= filters.toTick! )

    if( filters.minEmotion )
      results = results.filter( m => ( m.emotionalTags[ filters.minEmotion! ] ?? 0 ) > 0.3 )

    // Sort by activation strength (most strongly encoded first), then recency
    results.sort( ( a, b ) => {
      const strengthDiff = b.activationStrength - a.activationStrength
      return strengthDiff !== 0 ? strengthDiff : b.timestamp - a.timestamp
    } )

    const limit = filters.limit ?? 20
    return results.slice( 0, limit )
  }

  /**
   * Semantic query via vector memory.
   * Returns episodes with content semantically similar to the query.
   * Requires vectorMemory adapter to be configured.
   *
   * Similarity ranking, with optional mood-congruent re-ranking: when
   * `affectiveBias` is supplied, results are re-scored by blending embedding
   * similarity with affective congruence between the caller's current valence
   * and each episode's encoded valence (`affectiveContext.valence`) — modelling
   * mood-congruent recall (Bower). Similarity still dominates at low weights. To
   * let affect promote a congruent-but-slightly-less-similar memory, we
   * over-fetch candidates and re-rank before truncating to `limit`.
   *
   * Other metadata narrowing (sourceType / tags) remains the caller's job on the
   * returned episodes (which carry all metadata).
   */
  /** Await any background indexing still in flight. Shutdown and tests only. */
  async flushIndexing(): Promise<void> { await this._indexing }

  async semanticQuery(
    query: unknown,
    filters?: {
      minSimilarity?: number
      limit?: number
      /** Mood-congruent re-ranking: target valence [-1,1] + blend weight [0,1]. */
      affectiveBias?: { valence: number; weight: number }
    }
  ): Promise<EpisodicMemory[]> {
    if( !this._vectorMemory ){
      logger.warn('[EpisodicConsolidator] semanticQuery called without vectorMemory adapter')
      return []
    }

    const limit     = filters?.limit ?? 10
    const bias      = filters?.affectiveBias
    const useAffect = !!bias && bias.weight > 0

    // Over-fetch when re-ranking so affect can promote a congruent memory that
    // ranked just outside the top-`limit` by pure similarity.
    const fetch = useAffect ? Math.min( limit * 3, 50 ) : limit

    // Timeout guard — recall is BEST-EFFORT. The search embeds the query, which
    // can be a real network call (OpenAI/Google embedder); a hanging endpoint
    // must degrade to "no recall this time", never block a reasoning chain —
    // facet chains await this inside prompt building, so an unbounded hang here
    // stalls the mind's reasoning and everything downstream of it.
    // WILL_RECALL_TIMEOUT_MS (default 5000) — read lazily for tests/live tuning.
    const timeoutMs = parseInt( process.env.WILL_RECALL_TIMEOUT_MS ?? '5000')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = Symbol('recall-timeout')

    // The search keeps running after the race is lost — its own rate-limit retry
    // chain can outlive this timeout by a minute. Its rejection is caught HERE
    // rather than left to the race: a promise that loses a Promise.race still
    // settles, and an unhandled 429 rejection surfaces as a process-level warning
    // (or a crash, depending on host) long after the recall it belonged to gave up.
    const results = await Promise.race( [
      this._vectorMemory.search( query, {
        maxResults:    fetch,
        minSimilarity: filters?.minSimilarity,
      } ).catch( ( err: unknown ) => {
        logger.warn(`[EpisodicConsolidator] recall search failed — ${ err instanceof Error ? err.message : String( err ) }`)
        return []
      } ),
      new Promise<typeof timedOut>( resolve => { timer = setTimeout( () => resolve( timedOut ), timeoutMs ) } ),
    ] ).finally( () => clearTimeout( timer ) )

    if( results === timedOut ){
      logger.warn(`[EpisodicConsolidator] semanticQuery timed out after ${timeoutMs}ms — returning no recall (embedder slow/unreachable?)`)
      return []
    }

    const resolved: Array<{ episode: EpisodicMemory; similarity: number }> = []
    for( const r of results ){
      const episode = this._storeMap.get( r.episodeId )
      if( episode ) resolved.push( { episode, similarity: r.similarity } )
      // A vector for a memory that is gone took a slot a living one should have
      // had, and would take it again on every query near it. Let it go now.
      // (An index saved before the race was closed can hold thousands.)
      else void this._vectorMemory.delete( r.episodeId ).catch( () => {} )
    }

    if( useAffect ){
      const target = Math.max( -1, Math.min( 1, bias!.valence ) )
      const w      = Math.max( 0, Math.min( 1, bias!.weight ) )
      // Congruence ∈ [0,1]: 1 when an episode's encoded valence equals the
      // current mood, 0 at opposite poles (|Δ| spans [0,2] for valence∈[-1,1]).
      const score = ( s: { episode: EpisodicMemory; similarity: number } ) =>
        ( 1 - w ) * s.similarity
        + w * ( 1 - Math.abs( s.episode.affectiveContext.valence - target ) / 2 )
      // Tie-break by id keeps the ordering deterministic for replay.
      resolved.sort( ( a, b ) => ( score( b ) - score( a ) ) || ( a.episode.id < b.episode.id ? -1 : 1 ) )
    }

    return resolved.slice( 0, limit ).map( s => s.episode )
  }

  /**
   * Mark an episode as retrieved (boosts its strength slightly).
   *
   * Immutable replace (mirrors applyDecay): other engines may already hold a
   * reference to this episode this tick, so we update a copy in both _store and
   * _storeMap rather than mutating the shared object underneath them. The bumped
   * retrievalCount is the load-bearing field — it unlocks the ForgettingCurve's
   * retrievalBoost, so memories that are actively recalled decay slower than
   * ones that are never used.
   */
  markRetrieved( episodeId: string, tick: Tick ): void {
    const episode = this._storeMap.get( episodeId )
    if( !episode ) return

    const updated: EpisodicMemory = {
      ...episode,
      retrievalCount:     episode.retrievalCount + 1,
      lastRetrievedAt:    tick,
      activationStrength: Math.min( 1, episode.activationStrength + 0.01 ),
    }
    this._storeMap.set( episodeId, updated )
    const idx = this._store.findIndex( e => e.id === episodeId )
    if( idx !== -1 ) this._store[ idx ] = updated
  }

  /**
   * Get all episodes (for serialization / replay).
   */
  getAllEpisodes(): ReadonlyArray<EpisodicMemory> {
    return this._store
  }

  /**
   * Permanently remove decayed episodes from the store, the id index, and the
   * vector index. The consolidator owns the store, so the ForgettingCurve asks
   * it to prune rather than mutating the store itself. Returns the ids that
   * were actually present and removed, so the caller can emit matching state
   * deletions. Removal is order-deterministic for replay.
   */
  /**
   * Apply decayed activation strengths computed by the ForgettingCurve.
   *
   * The consolidator owns the episode store, so decay is committed here rather
   * than written onto the live objects the curve borrowed via getAllEpisodes()
   * — those references may already be held by other engines this tick. Each
   * changed episode is replaced with an updated copy (immutable update), so
   * previously handed-out references are not mutated underneath their holders.
   */
  applyDecay( updates: ReadonlyMap<string, number> ): void {
    if( updates.size === 0 ) return

    this._store = this._store.map( episode => {
      const next = updates.get( episode.id )
      if( next === undefined || next === episode.activationStrength ) return episode
      const updated = { ...episode, activationStrength: next }
      this._storeMap.set( episode.id, updated )
      return updated
    })
  }

  /**
   * Commit dream-state mutations computed by the DreamSimulator — reactivation
   * boosts (activationStrength), REM emotional dampening (emotionalTags), and
   * creative-recombination tag cross-pollination (tags).
   *
   * Like applyDecay, the consolidator owns the store, so the simulator computes
   * the new field values on its own working copies and hands them here for an
   * immutable replace, rather than mutating the shared episode objects it
   * borrowed via getAllEpisodes() — those references may be held by other
   * engines this tick. Only the fields present in each entry are replaced.
   */
  applyDreamUpdates(
    updates: ReadonlyMap<string, { activationStrength?: number; emotionalTags?: Record<string, number>; tags?: string[] }>
  ): void {
    if( updates.size === 0 ) return

    this._store = this._store.map( episode => {
      const u = updates.get( episode.id )
      if( !u ) return episode
      const updated: EpisodicMemory = {
        ...episode,
        ...( u.activationStrength !== undefined ? { activationStrength: u.activationStrength } : {} ),
        ...( u.emotionalTags     !== undefined ? { emotionalTags:      u.emotionalTags      } : {} ),
        ...( u.tags              !== undefined ? { tags:               u.tags               } : {} ),
      }
      this._storeMap.set( episode.id, updated )
      return updated
    })
  }

  async pruneEpisodes( ids: Iterable<string> ): Promise<string[]> {
    const requested = new Set<string>()
    for( const id of ids ) requested.add( id )
    if( requested.size === 0 ) return []

    // _store is the authoritative list (what getAllEpisodes exposes), so key
    // removal off it rather than _storeMap — some restore paths populate only
    // the array. removed[] is in store order, keeping replay deterministic.
    const removed: string[] = []
    this._store = this._store.filter( e => {
      if( requested.has( e.id ) ){ removed.push( e.id ); return false }
      return true
    })
    if( removed.length === 0 ) return []

    for( const id of removed ){
      this._storeMap.delete( id )
      if( this._vectorMemory )
        await this._vectorMemory.delete( id ).catch( () => {} )
    }

    return removed
  }

  /**
   * Force an immediate full sync of all in-memory episodes to StateCommands.
   *
   * Called at session end (pauseWill / archiveWill) to guarantee that episode
   * mutations accumulated since the last periodic sync — activationStrength
   * decay, emotionalTag dampening, retrieval counts — are captured in the
   * final persisted snapshot.  Without this, any session that ends between
   * two scheduled sync ticks loses those mutations on the next cold-start.
   */
  flushToState(): StateCommands {
    const commands: StateCommands = { set: [] }
    for( const episode of this._store )
      commands.set!.push( this._episodeToEntity( episode ) )
    this._ticksSinceSync = 0
    return commands
  }

  /**
   * Restore episodes from snapshot (for replay).
   */
  restoreEpisodes( episodes: EpisodicMemory[] ): void {
    this._store = episodes.map( e => ( {
      ...e,
      // Restored episodes carry their original sim-time createdAt; the fallback
      // is a deterministic sentinel (0), never wall-clock, so replay is stable (R2).
      createdAt: e.createdAt ?? 0,
    } ) )
  }

  // ── Internal helpers ─────────────────────────────────────

  /**
   * Serialize one episode into a StateCommands entity write.
   * Used both at creation time and during periodic sync.
   */
  private _episodeToEntity( episode: EpisodicMemory ): NonNullable<StateCommands[ 'set' ]>[ number ] {
    return {
      id:        episode.id,
      type:      'episodic_memory',
      createdAt: episode.createdAt,
      metadata: {
        content:            episode.content,
        affectiveContext:   episode.affectiveContext,
        activationStrength: episode.activationStrength,
        emotionalTags:      episode.emotionalTags,
        retrievalCount:     episode.retrievalCount,
        lastRetrievedAt:    episode.lastRetrievedAt,
        tags:               episode.tags,
        sourceType:         episode.sourceType,
        ...( episode.sourceId !== undefined ? { sourceId: episode.sourceId } : {} ),
        tick:               episode.timestamp,
        createdAt:          episode.createdAt,
      },
    }
  }

  /**
   * Rehydrate _store from 'episodic_memory' entities in state.
   * Called once on first tick after snapshot restore.
   * Also rebuilds vector index if configured.
   */
  private async _restoreFromState( state: ReadonlySimulationState ): Promise<void> {
    if( this._store.length > 0 ) return  // already populated (e.g. restoreEpisodes was called)

    for( const entity of state.entities.values() ){
      if( entity.type !== 'episodic_memory') continue
      const m = entity.metadata ?? {}
      const episode: EpisodicMemory = {
        id:                 entity.id,
        timestamp:          ( m[ 'tick' ]              as number ) ?? 0,
        content:            ( m[ 'content' ]           as unknown ) ?? '',
        emotionalTags:      ( m[ 'emotionalTags' ]     as Record<string, number> ) ?? {},
        affectiveContext:   ( m[ 'affectiveContext' ]  as { valence: number; arousal: number; dominance: number } )
                            ?? { valence: 0, arousal: 0.3, dominance: 0.5 },
        activationStrength: ( m[ 'activationStrength' ] as number ) ?? 0.5,
        retrievalCount:     ( m[ 'retrievalCount' ]    as number ) ?? 0,
        lastRetrievedAt:    ( m[ 'lastRetrievedAt' ]   as number | null ) ?? null,
        tags:               ( m[ 'tags' ]              as string[] ) ?? [],
        sourceType:         ( m[ 'sourceType' ]        as string ) ?? 'percept',
        ...( typeof m[ 'sourceId' ] === 'string' ? { sourceId: m[ 'sourceId' ] as string } : {} ),
        createdAt:          ( m[ 'createdAt' ]         as number ) ?? entity.createdAt,
      }
      this._store.push( episode )
      this._storeMap.set( entity.id, episode )
    }

    // Maintain insertion-order by timestamp
    this._store.sort( ( a, b ) => a.timestamp - b.timestamp )

    // Vector index: try loading persisted index from disk first.
    // Only rebuild (re-embed everything) if the loaded index is empty —
    // avoids re-embedding on every process restart when the index is already valid.
    if( this._vectorMemory ){
      await this._vectorMemory.load()
      if( this._vectorMemory.size === 0 && this._store.length > 0 ){
        // Re-embedding the whole store is a bulk network operation, and this runs on
        // the FIRST TICK after restore. Awaited, it held tick 1 for 66.7s against a
        // 500ms budget and threw on a rate limit — a mind spending its first waking
        // minute frozen, with every tick-denominated deadline stretched around it.
        // Detached: recall degrades to "not yet indexed" until it lands, which is the
        // same best-effort contract semanticQuery already has. `flushIndexing()` is
        // what shutdown drains, so a rebuild in flight is still written out.
        this._indexing = this._vectorMemory.rebuildFromStore( this._store )
          .then( () => { logger.info(`[episodic] vector index rebuilt with ${ this._store.length } episodes`) } )
          .catch( ( err: unknown ) => {
            logger.warn(`[episodic] vector index rebuild deferred — ${ err instanceof Error ? err.message : String( err ) }`)
          } )
      } else if( this._vectorMemory.size > 0 ){
        logger.info(`[episodic] vector index loaded from disk (${this._vectorMemory.size} entries)`)
      }
    }

    logger.info(`[episodic] restored ${this._store.length} episodes from snapshot`)
  }

  // ── Internal ─────────────────────────────────────────────

  private _findCandidates( state: ReadonlySimulationState ): WMCandidate[] {
    const candidates: WMCandidate[] = []

    // One working-memory item becomes one episode — deduplicated on the item's
    // identity, not its text.
    //
    // This used to compare the first 100 characters of the item's JSON against
    // the last 20 episodes. For a conversation that prefix is
    //   {"wmType":"conversation.exchange","activation":0.85,"attendedCount":3,"tags":["conversation","exchan
    // — boilerplate, identical for every exchange with every person. So once any
    // one conversation was remembered, the next was "already remembered" whenever
    // its activation matched: a different person saying a different thing was
    // dropped as a duplicate (reproduced against the live engine: Ada's message
    // consolidated, Bo's never did). A company brain that forgets every second
    // conversation is not accumulating anything (LOSSLESS P0).
    const alreadyRemembered = new Set<string>()
    for( const memory of this._store )
      if( memory.sourceId ) alreadyRemembered.add( memory.sourceId )

    for( const entity of state.entities.values() ){
      if( entity.type !== 'working_memory.item') continue

      const content = entity.metadata

      const identity = sourceIdentity( entity.id )
      if( alreadyRemembered.has( identity ) ) continue

      // A memory recalled into working memory is not a new experience.
      //
      // This also skipped every item tagged `percept` or `percept.social`, as
      // "meta-percepts (percepts about other percepts)". Every percept item carries
      // that tag, so nothing the mind perceived — a change in the world, the answer
      // an act of its own brought back — ever became an episode: held in working
      // memory, with its data, for the seconds before it decayed, then gone.
      // Percepts about percepts cannot arise any more (the sense boundary puts both
      // types inside the mind), so the guard only ever dropped the world (LOSSLESS P2).
      const category = entity.metadata?.tags as string[] | undefined
      if( category?.includes('episodic_memory') ) continue

      candidates.push( {
        id:   identity,
        type: ( entity.metadata?.wmType as string ) ?? 'unknown',
        content: entity.metadata,
        activation: ( entity.metadata?.activation as number ) ?? 0,
        attendedCount: ( entity.metadata?.attendedCount as number ) ?? 0,
        tags: ( entity.metadata?.tags as string[] ) ?? [],
      } )
    }

    candidates.sort( ( a, b ) => b.activation - a.activation )
    return candidates
  }

  private _readCurrentEmotions( state: ReadonlySimulationState ): Record<string, number> {
    const emotions: Record<string, number> = {}
    for( const [ key, value ] of state.metrics ){
      if( key.startsWith('emotion.') )
        emotions[ key.replace('emotion.', '') ] = value
    }
    return emotions
  }

  private _computeEmotionalIntensity( emotions: Record<string, number> ): number {
    const values = Object.values( emotions )
    if( values.length === 0 ) return 0

    // Emotional intensity = mean of absolute emotion values
    // (Both positive and negative emotions boost consolidation)
    return values.reduce( ( s, v ) => s + Math.abs( v ), 0 ) / values.length
  }
}
// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/semantic.engine/integrator.ts
// ─────────────────────────────────────────────────────────────

/**
 * SemanticIntegrator — satellite mode.
 * 
 * Integrates beliefs from the ExecutiveEngine and performs heuristic
 * pattern detection for simple statistical patterns.
 * No longer makes its own LLM calls.
 *
 * UPGRADE: Uses semanticQuery from EpisodicConsolidator for more
 * intelligent pattern detection when vector memory is available.
 */

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands,
} from '#core/types'
import type { SimulationEngine, EngineResult } from '#cognition/types'
import type { EpisodicConsolidator, EpisodicMemory } from '#faculties/episodic.consolidator'
import type { SessionLogger } from '#stem/tracts/session.logger'
import type { CognitiveEngine } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { EVIDENCE_TO_COUNT } from '#faculties/executive.engine/commands'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'
import { _STOP_WORDS, type Belief, type BeliefHistoryEntry, type SemanticIntegratorConfig } from '#faculties/semantic.engine/types'
import { SemanticClustering } from '#faculties/semantic.engine/clustering'

// Re-export the belief types so consumers that import SemanticIntegrator from
// this module can also pull Belief/BeliefHistoryEntry from the same path.
export type { Belief, BeliefHistoryEntry } from './types'

export class SemanticIntegrator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'semantic-integrator'
  
  private _minIntervalTicks: number
  private _minNewEpisodes: number
  private _maxBeliefs: number
  private _beliefStalenessThreshold: number
  private _beliefDecayRate: number
  private _semanticSimilarityThreshold: number
  private _semanticQueryLimit: number

  private _beliefs: Belief[] = []
  private _lastIntegrationTick: number = 0
  private _episodeCountAtLastIntegration: number = 0
  private _semanticClustering: SemanticClustering | null = null
  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _sessionLogger: SessionLogger | null = null
  private _restored = false

  /**
   * Monotonic suffix counter for belief ids. Replaces Math.random() AND the
   * former `Date.now()` component so the same seed+inputs reproduce the same
   * belief ids on replay (R2). Combined with the id prefix it is unique per
   * engine instance, which is sufficient for belief ids.
   */
  private _idSeq = 0

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: SemanticIntegratorConfig = {} ){
    this._bus = config.bus ?? null
    this._minIntervalTicks        = config.minIntervalTicks        ?? 30
    this._minNewEpisodes          = config.minNewEpisodes          ?? 10
    this._maxBeliefs              = config.maxBeliefs              ?? 500
    this._beliefStalenessThreshold = config.beliefStalenessThreshold ?? 300
    this._beliefDecayRate          = config.beliefDecayRate          ?? 0.001
    this._semanticSimilarityThreshold = config.semanticSimilarityThreshold ?? 0.65
    this._semanticQueryLimit          = config.semanticQueryLimit          ?? 20
  }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  attachConsolidator( consolidator: EpisodicConsolidator ): void { this._episodicConsolidator = consolidator }
  attachSemanticClustering( ct: SemanticClustering ): void { this._semanticClustering = ct }
  attachSessionLogger( logger: SessionLogger | null ): void { this._sessionLogger = logger }

  /**
   * Called by ExecutiveEngine when it produces new beliefs.
   * Confidence is capped by evidence count before integration — prevents the
   * executive from asserting high-certainty beliefs from thin episodic support.
   */
  integrateExecutiveBelief( belief: Belief, tick?: number, cause = 'executive'): void {
    const capped = this._capConfidenceByEvidence( belief.confidence, belief.supportingEpisodes )
    const result = this._integrateBelief({ ...belief, confidence: capped }, cause )

    this._sessionLogger?.write({
      type:              'belief.integrate',
      tick,
      id:                result.id,
      statement:         result.statement,
      category:          result.category,
      rawConfidence:     belief.confidence,
      cappedConfidence:  capped,
      storedConfidence:  result.confidence,
      supportingEpisodes: belief.supportingEpisodes,
      tags:              belief.tags,
      merged:            result.id !== belief.id,
    })
  }

  /**
   * Evidence-based confidence ceiling.
   * Thin evidence cannot support high confidence regardless of how the executive reasons.
   * Mirrors how scientific confidence scales with replications, not just reasoning quality.
   */
  /**
   * Rehydrate _beliefs from 'belief' entities in state.
   * Called once on the first tick after a snapshot restore so that beliefs
   * formed in previous sessions survive a server restart.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'belief') continue
      if( this._beliefs.some( b => b.id === entity.id ) ) continue

      const m = entity.metadata ?? {}
      // Copy the arrays out of the (frozen) restored state — the integrator mutates them
      // in place later (_recordHistory), which would crash on the frozen originals.
      this._beliefs.push({
        id:                  entity.id,
        statement:           ( m['statement']          as string   ) ?? '',
        category:            ( m['category']           as Belief['category'] ) ?? 'world_fact',
        confidence:          ( m['confidence']         as number   ) ?? 0.5,
        supportingEpisodes:  ( m['supportingEpisodes'] as number   ) ?? 0,
        lastUpdatedAt:       ( m['lastUpdatedAt']      as number   ) ?? 0,
        tags:                [ ...( ( m['tags']    as string[] )             ?? [] ) ],
        history:             [ ...( ( m['history'] as BeliefHistoryEntry[] ) ?? [] ) ],
      })
    }
  }

  private _capConfidenceByEvidence( confidence: number, episodes: number ): number {
    if( episodes < 2  ) return Math.min( confidence, 0.60 )
    if( episodes < 5  ) return Math.min( confidence, 0.72 )
    if( episodes < 10 ) return Math.min( confidence, 0.82 )
    if( episodes < 20 ) return Math.min( confidence, 0.90 )
    return Math.min( confidence, 0.97 )
  }

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'executive.facet.progress'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('memory') )
          this._model.setPrecision('belief.count', 1.0 + p.confidence * 0.5 )

        break
      }
      case 'executive.facet.progress': {
        const payload = e.payload as {
          facetId?: string
          planId?: string
          goalProgress?: number
          newGoals?: Array<{
            description: string; priority: number; tags: string[]
            completionType: string; completionCondition?: string
          }>
          goalsToAbandon?: Array<{ goalId: string; reason: string }>
          newBeliefs?: Array<{
            statement: string; category: string; confidence: number
            evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern'; tags: string[]
          }>
          knownEntityUpdates?: Array<{ keid: string; name?: string; learned?: string[]; feeling?: number }>
        }

        // Forward new beliefs to SemanticIntegrator
        if( payload.newBeliefs )
          for( const nb of payload.newBeliefs )
            this.integrateExecutiveBelief({
              id: `belief-facet-${( this._idSeq++ ).toString( 36 )}`,
              statement: nb.statement,
              category: nb.category as any,
              confidence: nb.confidence,
              supportingEpisodes: EVIDENCE_TO_COUNT[ nb.evidence ] ?? 1,
              // lastUpdatedAt is a sim Tick (used in `tick - belief.lastUpdatedAt`
              // staleness math), so use the last integration tick, not wall-clock (R2).
              lastUpdatedAt: this._lastIntegrationTick,
              tags: nb.tags
            }, undefined, 'facet')

        // Facts the facet learned about an other → keid-tagged social beliefs (the
        // conversation-side analogue of the master's buildStateCommands path).
        if( payload.knownEntityUpdates )
          for( const u of payload.knownEntityUpdates )
            for( const fact of u.learned ?? [] )
              if( fact && u.keid && u.keid !== 'agent-self')
                this.integrateExecutiveBelief({
                  id: `belief-ke-facet-${( this._idSeq++ ).toString( 36 )}`,
                  statement: fact,
                  category: 'social_belief' as any,
                  confidence: 0.7,
                  supportingEpisodes: 1,
                  lastUpdatedAt: this._lastIntegrationTick,
                  tags: [ 'social', 'known-entity', `keid:${u.keid}` ]
                }, undefined, 'facet')

        break
      }
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  /**
   * Effective config = base engine-config-semantic ⊕ persona-prior (single-source).
   * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-semantic')
    if( p.minIntervalTicks         != null ) this._minIntervalTicks         = p.minIntervalTicks
    if( p.minNewEpisodes           != null ) this._minNewEpisodes           = p.minNewEpisodes
    if( p.maxBeliefs               != null ) this._maxBeliefs               = p.maxBeliefs
    if( p.beliefStalenessThreshold != null ) this._beliefStalenessThreshold = p.beliefStalenessThreshold
    if( p.beliefDecayRate          != null ) this._beliefDecayRate          = p.beliefDecayRate
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    // Effective config = base engine-config-semantic ⊕ persona-prior (single-source).
    this._readConfigFromState( state )

    // On the very first tick (including after snapshot restore), rehydrate
    // the in-memory _beliefs array from persisted 'belief' state entities.
    // Without this, every restart begins with zero beliefs regardless of snapshot.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    const commands: StateCommands = { set: [], metrics: [] }

    // Executive beliefs are integrated in real-time via integrateExecutiveBelief()
    // called by the ExecutiveEngine's onReasoningComplete().
    // Here we just handle heuristic pattern detection and persistence.

    // Heuristic pattern detection — upgraded to use semantic query
    if( this._episodicConsolidator && this._shouldRunHeuristic( tick ) ){
      const newBeliefs = await this._heuristicPatternDetection( tick, state )
      for( const belief of newBeliefs )
        this._integrateBelief( belief, 'heuristic')
      
      this._lastIntegrationTick = tick
      if( this._episodicConsolidator )
        this._episodeCountAtLastIntegration = this._episodicConsolidator.getAllEpisodes().length
    }

    // Staleness decay — beliefs not reinforced for a long time lose confidence gradually.
    // This prevents early high-confidence beliefs from dominating forever and forces
    // the executive to re-affirm important beliefs to keep them strong.
    //
    // Guard: only decay a belief once at least one consolidation cycle has run
    // *after* the belief was created or last updated. This ensures every belief
    // gets at least one reinforcement opportunity before erosion begins. Beliefs
    // from a restored session are protected until the first heuristic cycle fires
    // this session (i.e. _lastIntegrationTick advances past their lastUpdatedAt).
    for( const belief of this._beliefs ){
      const staleness = tick - belief.lastUpdatedAt

      const hadOpportunity  = this._lastIntegrationTick > belief.lastUpdatedAt
      if( staleness > this._beliefStalenessThreshold && hadOpportunity ){
        const prev = belief.confidence
        belief.confidence = Math.max( 0.10, belief.confidence - this._beliefDecayRate )
        if( belief.confidence !== prev )
          SemanticIntegrator._recordHistory( belief, tick, prev, 'decayed')
      }
    }

    // Prune beliefs that have decayed to near-zero
    this._beliefs = this._beliefs.filter( b => b.confidence > 0.12 )

    // Persist all beliefs
    for( const belief of this._beliefs )
      commands.set!.push({
        id: belief.id,
        type: 'belief',
        metadata: {
          statement:          belief.statement,
          category:           belief.category,
          confidence:         belief.confidence,
          supportingEpisodes: belief.supportingEpisodes,
          lastUpdatedAt:      belief.lastUpdatedAt,
          // Copy the arrays into state. Applied state is deep-frozen, so handing over the
          // live reference would freeze the integrator's own working array and crash the
          // next in-place mutation (_recordHistory push/shift on a reinforced belief).
          tags:               [ ...belief.tags ],
          history:            [ ...( belief.history ?? [] ) ],
        },
      })

    if( !commands.metrics ) commands.metrics = []
    commands.metrics.push([ 'memory.beliefs_total', this._beliefs.length ])

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._beliefs.length > 0 ){
      const predErr = this._model.observe('belief.count', this._beliefs.length )
      if( !predErr.gated )
        _bus.publish({
          type: 'belief.updated',
          version: 1,
          sourceEngine: this.name,
          salience: Math.max( 0.2, predErr.salience ),
          payload: { total: this._beliefs.length }
        })
    }

    return { commands }
  }

  // ── Heuristic pattern detection (upgraded) ─────────────────

  private _shouldRunHeuristic( tick: Tick ): boolean {
    if( !this._episodicConsolidator ) return false

    const ticksSince = tick - this._lastIntegrationTick
    const totalEpisodes = this._episodicConsolidator.getAllEpisodes().length
    const newEpisodes = totalEpisodes - this._episodeCountAtLastIntegration

    return ticksSince >= this._minIntervalTicks && newEpisodes >= this._minNewEpisodes
  }

  private async _heuristicPatternDetection(
    tick: Tick,
    state: ReadonlySimulationState
  ): Promise<Belief[]> {
    if( !this._episodicConsolidator ) return []

    const beliefs: Belief[] = []
    
    // ── Try semantic pattern detection first ─────────
    const semanticBeliefs = await this._semanticPatternDetection( tick, state )
    if( semanticBeliefs.length > 0 ){
      logger.info(`[semantic] detected ${semanticBeliefs.length} semantic patterns`)
      return semanticBeliefs
    }

    // ── FALLBACK: Traditional heuristic detection ────────────
    const episodes = this._episodicConsolidator.getAllEpisodes()
    const newEpisodes = episodes.slice( this._episodeCountAtLastIntegration )
    
    // Skip if no new episodes
    if( newEpisodes.length === 0 ) return beliefs

    // Frequency-based patterns
    if( newEpisodes.length >= 5 ){
      const sourceTypes = new Map<string, number>()
      for( const ep of newEpisodes )
        sourceTypes.set( ep.sourceType, ( sourceTypes.get( ep.sourceType ) ?? 0 ) + 1 )

      for( const [ sourceType, count ] of sourceTypes ){
        if( count >= 3 )
          beliefs.push({
            id: `belief-heuristic-${( this._idSeq++ ).toString( 36 )}`,
            statement: `I frequently encounter situations of type: ${sourceType}`,
            category: 'pattern',
            confidence: Math.min( 0.6, count / 10 ),
            supportingEpisodes: count,
            lastUpdatedAt: tick,
            tags: [ sourceType, 'frequency', 'pattern' ],
          })
      }
    }

    // Emotional pattern detection
    if( newEpisodes.length >= 8 ){
      let positiveCount = 0
      let negativeCount = 0

      for( const ep of newEpisodes ){
        const valence = ep.affectiveContext?.valence ?? 0

        if( valence > 0.2 ) positiveCount++
        if( valence < -0.2 ) negativeCount++
      }

      if( positiveCount > negativeCount * 2 )
        beliefs.push({
          id: `belief-heuristic-${( this._idSeq++ ).toString( 36 )}`,
          statement: 'Recent experiences have been predominantly positive',
          category: 'pattern',
          confidence: Math.min( 0.5, positiveCount / newEpisodes.length ),
          supportingEpisodes: positiveCount,
          lastUpdatedAt: tick,
          tags: [ 'emotional', 'positive', 'pattern' ],
        })
      
      else if( negativeCount > positiveCount * 2 )
        beliefs.push({
          id: `belief-heuristic-${( this._idSeq++ ).toString( 36 )}`,
          statement: 'Recent experiences have been predominantly negative',
          category: 'pattern',
          confidence: Math.min( 0.5, negativeCount / newEpisodes.length ),
          supportingEpisodes: negativeCount,
          lastUpdatedAt: tick,
          tags: [ 'emotional', 'negative', 'pattern' ],
        })
    }

    // Semantic clustering
    if( this._semanticClustering ){
      const
      newEpisodes = this._episodicConsolidator.getAllEpisodes().slice( -30 ),
      clusterBeliefs = await this._semanticClustering.discoverClusters( tick, newEpisodes )

      beliefs.push( ...clusterBeliefs )
    }
  
    return beliefs
  }

  /**
   * UPGRADE: Semantic pattern detection using vector memory.
   * 
   * Identifies clusters of semantically similar episodes that share
   * emotional or thematic patterns not captured by simple tag/type matching.
   * 
   * Falls back to traditional heuristics if vector memory not available
   * or if no meaningful clusters are found.
   */
  private async _semanticPatternDetection(
    tick: Tick,
    state: ReadonlySimulationState
  ): Promise<Belief[]> {
    if( !this._episodicConsolidator ) return []

    // Check if vector memory is available by attempting semanticQuery
    // (will return empty or throw if not configured)
    const allEpisodes = this._episodicConsolidator.getAllEpisodes()
    if( allEpisodes.length < 10 ) return []

    // Query for semantically similar episodes — use a neutral query that
    // captures the "essence" of recent experiences
    const recentEpisodes = allEpisodes.slice( -this._semanticQueryLimit )
    if( recentEpisodes.length < 5 ) return []

    // Build a query from recent episode content
    const queryText = this._buildSemanticQueryForPatterns( recentEpisodes )
    
    let semanticResults: EpisodicMemory[] = []
    try {
      semanticResults = await this._episodicConsolidator.semanticQuery(
        queryText,
        {
          limit: this._semanticQueryLimit,
          minSimilarity: this._semanticSimilarityThreshold
        }
      )
    }
    catch( err ){
      // Vector memory not available — fall back to traditional heuristics
      return []
    }

    if( semanticResults.length < 3 ) return []

    const beliefs: Belief[] = []

    // 1. Detect emotional pattern from semantically similar episodes
    const valenceSum = semanticResults.reduce(
      ( s, ep ) => s + ( ep.affectiveContext?.valence ?? 0 ), 0
    )
    const meanValence = valenceSum / semanticResults.length
    
    if( Math.abs( meanValence ) > 0.3 ){
      beliefs.push({
        id: `belief-semantic-${( this._idSeq++ ).toString( 36 )}`,
        statement: meanValence > 0
          ? 'Recent meaningful experiences have been emotionally positive'
          : 'Recent meaningful experiences have been emotionally challenging',
        category: 'pattern',
        confidence: Math.min( 0.65, Math.abs( meanValence ) * 0.8 ),
        supportingEpisodes: semanticResults.length,
        lastUpdatedAt: tick,
        tags: [ 'semantic', 'emotional_pattern', meanValence > 0 ? 'positive' : 'negative' ],
      })
    }

    // 2. Detect thematic pattern from tags across similar episodes
    const tagFrequency = new Map<string, number>()
    for( const ep of semanticResults ){
      for( const tag of ep.tags ){
        tagFrequency.set( tag, ( tagFrequency.get( tag ) ?? 0 ) + 1 )
      }
    }

    const dominantTag = Array.from( tagFrequency.entries() )
      .sort( ( a, b ) => b[1] - a[1] )
      .find( ( [ , count ] ) => count > semanticResults.length * 0.6 )
    
    if( dominantTag ){
      beliefs.push({
        id: `belief-semantic-tag-${( this._idSeq++ ).toString( 36 )}`,
        statement: `A recurring theme in my experiences is: ${dominantTag[0]}`,
        category: 'pattern',
        confidence: Math.min( 0.55, dominantTag[1] / semanticResults.length ),
        supportingEpisodes: dominantTag[1],
        lastUpdatedAt: tick,
        tags: [ 'semantic', 'thematic_pattern', dominantTag[0] ],
      })
    }

    // 3. Detect sourceType pattern
    const sourceTypes = new Map<string, number>()
    for( const ep of semanticResults ){
      sourceTypes.set( ep.sourceType, ( sourceTypes.get( ep.sourceType ) ?? 0 ) + 1 )
    }
    
    const dominantSource = Array.from( sourceTypes.entries() )
      .sort( ( a, b ) => b[1] - a[1] )
      .find( ( [ , count ] ) => count > semanticResults.length * 0.5 )
    
    if( dominantSource && dominantSource[0] !== 'unknown'){
      beliefs.push({
        id: `belief-semantic-source-${( this._idSeq++ ).toString( 36 )}`,
        statement: `My semantically similar experiences tend to come from: ${dominantSource[0]}`,
        category: 'pattern',
        confidence: Math.min( 0.5, dominantSource[1] / semanticResults.length ),
        supportingEpisodes: dominantSource[1],
        lastUpdatedAt: tick,
        tags: [ 'semantic', 'source_pattern', dominantSource[0] ],
      })
    }

    return beliefs
  }

  /**
   * Build a semantic query string from recent episodes for pattern detection.
   * Combines content snippets and tags to create a representative query.
   */
  private _buildSemanticQueryForPatterns( episodes: EpisodicMemory[] ): string {
    const parts: string[] = []
    
    // Add dominant tags from recent episodes
    const tagFrequency = new Map<string, number>()
    for( const ep of episodes ){
      for( const tag of ep.tags ){
        tagFrequency.set( tag, ( tagFrequency.get( tag ) ?? 0 ) + 1 )
      }
    }
    
    const topTags = Array.from( tagFrequency.entries() )
      .sort( ( a, b ) => b[1] - a[1] )
      .slice( 0, 3 )
      .map( ( [ tag ] ) => tag )
    
    if( topTags.length > 0 ){
      parts.push(`Themes: ${topTags.join(', ')}`)
    }
    
    // Add a sample of recent episode content (first 3, truncated)
    const contentSamples = episodes
      .slice( 0, 3 )
      .map( ep => {
        const content = typeof ep.content === 'string' 
          ? ep.content 
          : JSON.stringify( ep.content )
        return content.slice( 0, 150 )
      })
    
    if( contentSamples.length > 0 ){
      parts.push(`Recent experiences: ${contentSamples.join('; ')}`)
    }
    
    // Add affective context if consistent
    const valenceSum = episodes.reduce( ( s, ep ) => s + ( ep.affectiveContext?.valence ?? 0 ), 0 )
    const meanValence = valenceSum / episodes.length
    if( Math.abs( meanValence ) > 0.2 ){
      parts.push(`Emotional tone: ${meanValence > 0 ? 'positive' : 'negative'}`)
    }
    
    return parts.length > 0 ? parts.join('. ') : 'What patterns emerge from my recent experiences?'
  }

  // ── Belief management ────────────────────────────────────

  private static readonly _MAX_HISTORY = 20

  /** Append a history entry to a belief, dropping the oldest if the buffer is full. */
  private static _recordHistory(
    belief: Belief,
    tick: Tick,
    prevConfidence: number,
    cause: string
  ): void {
    const entry: BeliefHistoryEntry = {
      tick,
      confidence: belief.confidence,
      delta:      belief.confidence - prevConfidence,
      cause,
    }
    // Build a fresh array rather than mutating in place: a belief loaded from a
    // PMA (or a frozen snapshot) carries a readonly `history`, and .push() on it
    // throws "Attempted to assign to readonly property".
    const next = belief.history ? [ ...belief.history, entry ] : [ entry ]
    if( next.length > SemanticIntegrator._MAX_HISTORY )
      next.shift()
    belief.history = next
  }

  private _integrateBelief( newBelief: Belief, cause = 'created'): Belief {
    const existing = this._beliefs.find( b => this._shouldMerge( b, newBelief ) )

    if( existing ){
      const prev = existing.confidence
      existing.confidence      = ( existing.confidence + newBelief.confidence ) / 2
      existing.supportingEpisodes += newBelief.supportingEpisodes
      existing.lastUpdatedAt   = newBelief.lastUpdatedAt
      SemanticIntegrator._recordHistory( existing, newBelief.lastUpdatedAt, prev, 'reinforced')
      return existing
    }

    // Seed or preserve history.
    // If the belief arrives with an existing history (e.g. from a PMM load or
    // snapshot restore), preserve it and append the load event so provenance
    // is traceable without losing the full trajectory.
    // For brand-new beliefs (no prior history) seed a single creation entry.
    if( newBelief.history && newBelief.history.length > 0 ){
      SemanticIntegrator._recordHistory( newBelief, newBelief.lastUpdatedAt, newBelief.confidence, cause )
    } else {
      newBelief.history = [{
        tick:       newBelief.lastUpdatedAt,
        confidence: newBelief.confidence,
        delta:      newBelief.confidence,
        cause,
      }]
    }
    this._beliefs.push( newBelief )

    if( this._beliefs.length > this._maxBeliefs ){
      this._beliefs = this._beliefs
        .filter( b => b.confidence >= 0.3 )
        .sort( ( a, b ) => b.confidence - a.confidence )
        .slice( 0, this._maxBeliefs )
    }

    return newBelief
  }

  /**
   * Determines whether two beliefs are similar enough to merge.
   *
   * Primary gate: same category + at least one shared substantive tag.
   * If tags overlap by ≥ 50%, we trust the category+tag match and skip
   * text comparison — this prevents Jaccard word-overlap from merging
   * semantically unrelated beliefs that share filler words.
   * Weak tag overlap falls back to stop-word-filtered content similarity.
   */
  private _shouldMerge( existing: Belief, incoming: Belief ): boolean {
    if( existing.category !== incoming.category ) return false

    const sharedTags = existing.tags.filter( t => incoming.tags.includes( t ) )
    if( sharedTags.length === 0 ) return false

    const tagSimilarity = sharedTags.length / Math.min( existing.tags.length, incoming.tags.length )
    if( tagSimilarity >= 0.5 ) return true

    // Weak tag overlap only: require text similarity as a secondary check
    return this._contentSimilarity( existing.statement, incoming.statement ) > 0.45
  }

  /**
   * Jaccard similarity on content words — stop words stripped before comparison
   * so common filler ("I", "my", "the", "have") can't drive false merges.
   */
  private _contentSimilarity( a: string, b: string ): number {
    const tokenise = ( s: string ) =>
      new Set(
        s.toLowerCase()
         .split( /\s+/ )
         .filter( w => w.length > 2 && !_STOP_WORDS.has( w ) )
      )
    const wordsA = tokenise( a )
    const wordsB = tokenise( b )
    if( wordsA.size === 0 || wordsB.size === 0 ) return 0
    const intersection = [ ...wordsA ].filter( w => wordsB.has( w ) ).length
    const union        = new Set( [ ...wordsA, ...wordsB ] ).size
    return union > 0 ? intersection / union : 0
  }

  /**
   * Restore beliefs verbatim from a PMA / snapshot — NOT through the live
   * executive-integration path. A stored belief is a known prior state: its id
   * and final confidence must be preserved exactly. integrateExecutiveBelief()
   * would corrupt a faithful reconstruction two ways: (a) _shouldMerge absorbs
   * semantically-similar stored beliefs into one another, dropping ids and
   * averaging confidence, and (b) it re-caps confidence by evidence count. The
   * live merge/decay dynamics resume once the Will ticks.
   */
  restoreBeliefs( beliefs: Belief[] ): void {
    for( const b of beliefs )
      this._beliefs.push({
        ...b,
        confidence: Math.max( 0, Math.min( 1, b.confidence ) ),
        history: ( b.history && b.history.length > 0 )
          ? [ ...b.history ]
          : [ { tick: b.lastUpdatedAt, confidence: b.confidence, delta: b.confidence, cause: 'restored' } ],
      })

    if( this._beliefs.length > this._maxBeliefs )
      this._beliefs = this._beliefs
        .filter( b => b.confidence >= 0.3 )
        .sort( ( a, b ) => b.confidence - a.confidence )
        .slice( 0, this._maxBeliefs )
  }

  getBeliefs(): ReadonlyArray<Belief> {
    return this._beliefs
  }

  queryBeliefs( filters: {
    category?: string
    tags?: string[]
    minConfidence?: number
  }): Belief[] {
    let results = [ ...this._beliefs ]

    if( filters.category )
      results = results.filter( b => b.category === filters.category )
    if( filters.tags?.length )
      results = results.filter( b => filters.tags!.some( t => b.tags.includes( t ) ) )
    if( filters.minConfidence !== undefined )
      results = results.filter( b => b.confidence >= filters.minConfidence! )

    results.sort( ( a, b ) => b.confidence - a.confidence )
    return results
  }
}
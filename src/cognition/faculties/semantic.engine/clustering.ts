// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/semantic.engine/clustering.ts
// ─────────────────────────────────────────────────────────────

/**
 * SemanticClustering — advanced pattern detection using vector similarity.
 *
 * Extends the SemanticIntegrator's pattern detection with:
 *   - Hierarchical clustering of semantically similar episodes
 *   - Prototype extraction (centroid of cluster)
 *   - Temporal trend detection (beliefs that strengthen/weaken over time)
 *   - Anomaly detection (episodes that contradict existing beliefs)
 *
 * Runs as a satellite to SemanticIntegrator, triggered during
 * heuristic pattern detection cycles.
 *
 * Part of Shard 2 (Memory Layer)
 */

import { logger } from '#core/logger'
import type { Tick } from '#core/types'
import type { EpisodicConsolidator, EpisodicMemory } from '#faculties/episodic.consolidator'
import type { CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { _STOP_WORDS, Belief } from '#faculties/semantic.engine/types'

export interface Cluster {
  id: string
  episodes: EpisodicMemory[]
  centroid: number[]  // Vector centroid of the cluster (if vector available)
  prototypeStatement: string  // Natural language description of the cluster
  valenceMean: number
  valenceStd: number
  dominantEmotions: Array<[string, number]>  // Emotion → average intensity
  dominantTags: Array<[string, number]>      // Tag → frequency
  sourceTypes: Array<[string, number]>       // SourceType → frequency
  firstSeen: Tick
  lastSeen: Tick
  episodeCount: number
  stabilityScore: number  // How consistent the cluster is (0-1)
}

export interface TemporalTrend {
  beliefStatement: string
  direction: 'increasing' | 'decreasing' | 'stable'
  slope: number
  confidence: number
  observations: Array<{ tick: Tick; valence: number; count: number }>
}

export interface SemanticClusteringConfig {
  /** Minimum episodes to form a cluster */
  minClusterSize?: number
  /** Minimum similarity threshold for cluster membership (0-1) */
  clusterSimilarityThreshold?: number
  /** Maximum distance from centroid to be considered in cluster (0-1) */
  maxCentroidDistance?: number
  /** Minimum number of temporal windows for trend detection */
  minTrendWindows?: number
  /** Ticks per temporal window for trend analysis */
  trendWindowTicks?: number
  bus?: CognitiveBus
}

export class SemanticClustering {
  readonly name = 'semantic-clustering'

  private _minClusterSize: number
  private _clusterSimilarityThreshold: number
  private _maxCentroidDistance: number
  private _minTrendWindows: number
  private _trendWindowTicks: number

  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _bus: CognitiveBus | null = null
  private _clusters: Cluster[] = []

  private _idSeq = 0
  private readonly _model = new GenerativeModel()

  constructor( config: SemanticClusteringConfig = {} ){
    this._bus = config.bus ?? null
    this._minClusterSize = config.minClusterSize ?? 5
    this._clusterSimilarityThreshold = config.clusterSimilarityThreshold ?? 0.65
    this._maxCentroidDistance = config.maxCentroidDistance ?? 0.4
    this._minTrendWindows = config.minTrendWindows ?? 3
    this._trendWindowTicks = config.trendWindowTicks ?? 200
  }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  attachConsolidator( consolidator: EpisodicConsolidator ): void { this._episodicConsolidator = consolidator }

  /**
   * Main entry point: discover clusters from recent episodes.
   * Called by SemanticIntegrator during heuristic pattern detection.
   */
  async discoverClusters( tick: Tick, recentEpisodes: EpisodicMemory[] ): Promise<Belief[]> {
    if( !this._episodicConsolidator || recentEpisodes.length < this._minClusterSize )
      return []

    const newBeliefs: Belief[] = []

    // 1. Find clusters using vector similarity
    const clusters = await this._findClusters( recentEpisodes, tick )

    // 2. For each cluster, generate belief statements
    for( const cluster of clusters ){
      const belief = this._clusterToBelief( cluster, tick )
      if( belief ){
        newBeliefs.push(belief)
        this._clusters.push(cluster)
      }
    }

    // 3. Detect temporal trends (beliefs that are becoming stronger/weaker)
    const trends = await this._detectTemporalTrends( tick )
    for( const trend of trends )
      if( trend.confidence > 0.7 ){
        const belief = this._trendToBelief( trend, tick )
        belief && newBeliefs.push( belief )
      }

    // 4. Detect anomalies (episodes that contradict existing beliefs)
    const anomalies = await this._detectAnomalies( recentEpisodes, tick )
    for( const anomaly of anomalies )
      if( anomaly.confidence > 0.6 )
        newBeliefs.push( this._anomalyToBelief( anomaly, tick ) )
    

    if( newBeliefs.length > 0 )
      logger.info(`[semantic-clustering] discovered ${newBeliefs.length} beliefs from ` +
                  `${recentEpisodes.length} episodes (${clusters.length} clusters, ` +
                  `${trends.length} trends, ${anomalies.length} anomalies)`)

    return newBeliefs
  }

  // ── Private clustering methods ───────────────────────────

  private async _findClusters( episodes: EpisodicMemory[], tick: Tick ): Promise<Cluster[]> {
    if( !this._episodicConsolidator ) return []

    const
    clusters: Cluster[] = [],
    assigned = new Set<string>()

    // Try vector-based clustering first
    let useVectorClustering = true
    
    // Test if vector memory is available by attempting a query
    try { await this._episodicConsolidator.semanticQuery('test', { limit: 1 }) }
    catch { useVectorClustering = false }

    if( useVectorClustering ){
      // Use vector similarity for clustering
      for( let i = 0; i < episodes.length && clusters.length < 10; i++ ){
        const seed = episodes[i]
        if( !seed || assigned.has( seed.id ) ) continue

        // Find similar episodes using vector query
        const similar = await this._episodicConsolidator.semanticQuery(
          this._episodeToQuery( seed ),
          {
            limit: this._minClusterSize * 2,
            minSimilarity: this._clusterSimilarityThreshold
          }
        )

        // Filter to only recent episodes and not already assigned
        const clusterEpisodes = similar.filter( ep => episodes.includes( ep ) && !assigned.has( ep.id ) )
        if( clusterEpisodes.length >= this._minClusterSize ){
          const cluster = await this._buildCluster( clusterEpisodes, tick )
          clusters.push( cluster )

          for( const ep of clusterEpisodes )
            assigned.add( ep.id )
        }
      }
    }

    // Fallback: content-similarity clustering for episodes that don't have vectors
    const unassigned = episodes.filter( ep => !assigned.has( ep.id ) )
    if( unassigned.length >= this._minClusterSize ){
      const fallbackClusters = this._fallbackClustering( unassigned, tick )
      clusters.push( ...fallbackClusters )
    }

    return clusters
  }

  private _fallbackClustering( episodes: EpisodicMemory[], tick: Tick ): Cluster[] {
    const
    clusters: Cluster[] = [],
    assigned = new Set<string>()

    for( let i = 0; i < episodes.length; i++ ){
      const seed = episodes[i]
      if( !seed || assigned.has( seed.id ) ) continue

      const clusterEpisodes: EpisodicMemory[] = [ seed ]
      
      for( let j = i + 1; j < episodes.length; j++ ){
        const other = episodes[j]
        if( !other || assigned.has( other.id ) ) continue
        
        const similarity = this._contentSimilarity(
          this._episodeToText( seed ),
          this._episodeToText( other )
        )
        
        if( similarity > this._clusterSimilarityThreshold )
          clusterEpisodes.push( other )
      }

      if( clusterEpisodes.length >= this._minClusterSize ){
        const cluster = this._buildClusterFromContent( clusterEpisodes, tick )
        clusters.push( cluster )

        for( const ep of clusterEpisodes )
          assigned.add( ep.id )
      }
    }

    return clusters
  }

  private async _buildCluster( episodes: EpisodicMemory[], tick: Tick ): Promise<Cluster> {
    const valenceSum = episodes.reduce( ( s, ep ) => s + ( ep.affectiveContext?.valence ?? 0 ), 0 )
    const valenceMean = valenceSum / episodes.length
    const valenceStd = Math.sqrt( episodes.reduce( ( s, ep ) => {
        const diff = ( ep.affectiveContext?.valence ?? 0 ) - valenceMean
        return s + diff * diff
      }, 0 ) / episodes.length
    )

    // Aggregate emotions
    const emotionMap = new Map<string, number>()
    for( const ep of episodes )
      for( const [ emotion, intensity ] of Object.entries( ep.emotionalTags ?? {} ) )
        emotionMap.set( emotion, ( emotionMap.get( emotion ) ?? 0 ) + intensity )
      
    
    const dominantEmotions = Array.from( emotionMap.entries() )
                                  .map( ([ e, sum ]) => [ e, sum / episodes.length ] as [string, number])
                                  .sort( ( a, b ) => b[1] - a[1] )
                                  .slice( 0, 3 )

    // Aggregate tags
    const tagMap = new Map<string, number>()
    for( const ep of episodes )
      for( const tag of ep.tags )
        tagMap.set( tag, ( tagMap.get( tag ) ?? 0) + 1 )
    
    const dominantTags = Array.from( tagMap.entries() )
                              .map( ([ t, count ]) => [ t, count / episodes.length ] as [string, number])
                              .sort( ( a, b ) => b[1] - a[1] )
                              .slice( 0, 5 )

    // Aggregate source types
    const sourceMap = new Map<string, number>()
    for( const ep of episodes )
      sourceMap.set( ep.sourceType, ( sourceMap.get( ep.sourceType ) ?? 0 ) + 1 )
    
    const sourceTypes = Array.from( sourceMap.entries() )
                              .map( ([  s, count ]) => [ s, count / episodes.length ] as [string, number])
                              .sort( ( a, b ) => b[1] - a[1] )

    // Find first and last seen timestamps
    const timestamps = episodes.map( ep => ep.timestamp )
    const firstSeen = Math.min( ...timestamps )
    const lastSeen = Math.max( ...timestamps )

    // Calculate stability (inverse of valence variance)
    const stabilityScore = Math.max( 0, 1 - Math.min( 1, valenceStd / 0.5 ) )

    // Generate prototype statement
    const prototypeStatement = this._generatePrototypeStatement(
      episodes,
      dominantEmotions,
      dominantTags,
      valenceMean
    )

    this._idSeq++
    return {
      id: `cluster-${tick}-${this._idSeq}`,
      episodes,
      centroid: [],  // Would be populated from vector if available
      prototypeStatement,
      valenceMean,
      valenceStd,
      dominantEmotions,
      dominantTags,
      sourceTypes,
      firstSeen,
      lastSeen,
      episodeCount: episodes.length,
      stabilityScore
    }
  }

  private _buildClusterFromContent( episodes: EpisodicMemory[], tick: Tick ): Cluster {
    // Same as _buildCluster but without vector centroid
    const valenceSum = episodes.reduce( ( s, ep ) => s + (ep.affectiveContext?.valence ?? 0), 0 )
    const valenceMean = valenceSum / episodes.length
    const valenceStd = Math.sqrt( episodes.reduce( ( s, ep ) => {
        const diff = (ep.affectiveContext?.valence ?? 0) - valenceMean
        return s + diff * diff
      }, 0 ) / episodes.length
    )

    const emotionMap = new Map<string, number>()
    for( const ep of episodes )
      for( const [ emotion, intensity ] of Object.entries( ep.emotionalTags ?? {}) )
        emotionMap.set( emotion, ( emotionMap.get( emotion ) ?? 0 ) + intensity )
      
    const dominantEmotions = Array.from( emotionMap.entries() )
                                  .map( ([ e, sum] ) => [ e, sum / episodes.length ] as [string, number])
                                  .sort( ( a, b ) => b[1] - a[1] )
                                  .slice( 0, 3 )

    const tagMap = new Map<string, number>()
    for( const ep of episodes )
      for( const tag of ep.tags )
        tagMap.set( tag, (tagMap.get( tag ) ?? 0) + 1 )
      
    const dominantTags = Array.from( tagMap.entries() )
                              .map( ([ t, count ]) => [ t, count / episodes.length ] as [string, number])
                              .sort( ( a, b ) => b[1] - a[1] )
                              .slice( 0, 5 )

    const sourceMap = new Map<string, number>()
    for( const ep of episodes )
      sourceMap.set( ep.sourceType, (sourceMap.get( ep.sourceType ) ?? 0) + 1 )
      
    const sourceTypes = Array.from( sourceMap.entries() )
                              .map( ([ s, count ]) => [ s, count / episodes.length ] as [string, number])
                              .sort( ( a, b ) => b[1] - a[1] )

    const timestamps = episodes.map( ep => ep.timestamp )
    const firstSeen = Math.min( ...timestamps )
    const lastSeen = Math.max( ...timestamps )
    const stabilityScore = Math.max( 0, 1 - Math.min( 1, valenceStd / 0.5 ) )

    const prototypeStatement = this._generatePrototypeStatement(
      episodes,
      dominantEmotions,
      dominantTags,
      valenceMean
    )

    this._idSeq++
    return {
      id: `cluster-fallback-${tick}-${this._idSeq}`,
      episodes,
      centroid: [],
      prototypeStatement,
      valenceMean,
      valenceStd,
      dominantEmotions,
      dominantTags,
      sourceTypes,
      firstSeen,
      lastSeen,
      episodeCount: episodes.length,
      stabilityScore
    }
  }

  // ── Belief generation ────────────────────────────────────

  private _clusterToBelief( cluster: Cluster, tick: Tick ): Belief | null {
    // Only form beliefs from stable clusters with meaningful patterns
    if( cluster.stabilityScore < 0.4 ) return null
    if( cluster.episodeCount < this._minClusterSize ) return null

    let statement = cluster.prototypeStatement
    let confidence = Math.min( 0.7, 0.3 + cluster.stabilityScore * 0.4 )
    let category: Belief['category'] = 'pattern'
    let tags = [ ...cluster.dominantTags.map( ([ t ]) => t ), 'semantic_cluster' ]

    // Add emotional qualifier if valence is extreme
    if( cluster.valenceMean > 0.4 ){
      statement = `Positive experiences often center around: ${statement}`
      tags.push('positive_pattern')

      confidence += 0.05
    }
    else if( cluster.valenceMean < -0.3 ){
      statement = `Challenging experiences often involve: ${statement}`
      tags.push('negative_pattern')

      confidence += 0.05
    }

    // Categorize based on source
    if( cluster.sourceTypes.some( ([ s ]) => s === 'social' || s === 'conversation') ){
      category = 'social_belief'
      tags.push('social')
    }
    else if( cluster.sourceTypes.some( ([ s ]) => s === 'interoception') ){
      category = 'self_belief'
      tags.push('self')
    }

    confidence = Math.min( 0.75, confidence )

    this._idSeq++
    return {
      id: `belief-cluster-${tick}-${this._idSeq}`,
      statement,
      category,
      confidence,
      supportingEpisodes: cluster.episodeCount,
      lastUpdatedAt: tick,
      tags: tags.slice( 0, 8 )
    }
  }

  private _generatePrototypeStatement(
    episodes: EpisodicMemory[],
    dominantEmotions: Array<[string, number]>,
    dominantTags: Array<[string, number]>,
    valenceMean: number
   ): string {
    // Extract common themes from episode content
    const contentWords = new Map<string, number>()
    
    for( const ep of episodes.slice( 0, 20 ) ){
      const text = this._episodeToText( ep )
      const words = text.toLowerCase()
                        .split(/\s+/)
                        .filter( w => w.length > 3 && !_STOP_WORDS.has( w ) )
      
      for( const word of words.slice( 0, 10 ) )
        contentWords.set( word, ( contentWords.get( word ) ?? 0 ) + 1 )
    }

    const topWords = Array.from( contentWords.entries() )
                          .sort( ( a, b ) => b[1] - a[1] )
                          .slice( 0, 4 )
                          .map( ([ w ]) => w)

    if( dominantTags.length > 0 && dominantTags[0] && dominantTags[0][1] > 0.5 )
      return `Themes related to "${dominantTags[0][0]}" appear repeatedly`

    if( topWords.length >= 2 )
      return `Patterns involving ${topWords.slice(0, 3).join(', ')} emerge in my experiences`

    if( dominantEmotions.length > 0 && dominantEmotions[0] && dominantEmotions[0][1] > 0.4 ){
      const emotion = dominantEmotions[0][0]
      return `I frequently experience ${emotion} in similar situations`
    }

    return `A recurring pattern has emerged in my recent experiences`
  }

  // ── Temporal trend detection ─────────────────────────────

  private async _detectTemporalTrends( tick: Tick ): Promise<TemporalTrend[]> {
    if( !this._episodicConsolidator ) return []

    const trends: TemporalTrend[] = []
    const windowSize = this._trendWindowTicks
    const startTick = tick - windowSize * this._minTrendWindows

    // Group episodes by time window
    const windows: Map<number, EpisodicMemory[]> = new Map()
    const allEpisodes = this._episodicConsolidator.getAllEpisodes()

    for( const ep of allEpisodes ){
      if( ep.timestamp < startTick ) continue
      const windowIndex = Math.floor( ep.timestamp / windowSize )
      const window = windows.get( windowIndex ) ?? []

      window.push( ep )
      windows.set( windowIndex, window )
    }

    const sortedWindows = Array.from( windows.keys() ).sort( ( a, b ) => a - b )
    if( sortedWindows.length < this._minTrendWindows ) return []

    // For each source type and emotion, compute trend
    const sourceTypes = [ 'percept', 'social', 'goal', 'thought', 'interoception' ]
    for( const sourceType of sourceTypes ){
      const observations: Array<{ tick: number; valence: number; count: number }> = []
      
      for( const winIdx of sortedWindows ){
        const episodes = windows.get( winIdx ) ?? []

        const filtered = episodes.filter( ep => ep.sourceType === sourceType )
        if( filtered.length === 0 ) continue
        
        const valenceSum = filtered.reduce( ( s, ep ) => s + ( ep.affectiveContext?.valence ?? 0 ), 0)
        observations.push({
          tick: winIdx * windowSize,
          valence: valenceSum / filtered.length,
          count: filtered.length,
        })
      }

      if( observations.length >= this._minTrendWindows ){
        const trend = this._computeLinearTrend( observations )
        if( Math.abs( trend.slope ) > 0.02 && trend.confidence > 0.6 )
          trends.push({
            beliefStatement: `My experiences with ${sourceType} are becoming ${trend.direction === 'increasing' ? 'more positive' : 'more negative'}`,
            direction: trend.direction,
            slope: trend.slope,
            confidence: trend.confidence,
            observations
          })
      }
    }

    return trends
  }

  private _computeLinearTrend( observations: Array<{ tick: number; valence: number; count: number }> ): {
    slope: number
    direction: 'increasing' | 'decreasing' | 'stable'
    confidence: number
  }{
    const n = observations.length
    if( n < 2 ) 
      return { slope: 0, direction: 'stable', confidence: 0 }

    // Simple linear regression
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
    for( let i = 0; i < n; i++ ){
      const x = i  // Use index as x for normalized time
      const y = observations[i]!.valence

      sumX += x
      sumY += y
      sumXY += x * y
      sumX2 += x * x
    }

    const denominator = n * sumX2 - sumX * sumX
    if( denominator === 0 )
      return { slope: 0, direction: 'stable', confidence: 0 }

    const slope = ( n * sumXY - sumX * sumY ) / denominator
    
    // Calculate R-squared for confidence
    const yMean = sumY / n
    let ssTot = 0, ssRes = 0
    for( let i = 0; i < n; i++ ){
      const x = i
      const y = observations[i]!.valence
      const yPred = yMean + slope * ( x - ( sumX / n ) )

      ssTot += (y - yMean) ** 2
      ssRes += (y - yPred) ** 2
    }

    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0
    const direction: 'increasing' | 'decreasing' | 'stable' = slope > 0.02 ? 'increasing' : slope < -0.02 ? 'decreasing' : 'stable'

    return {
      slope,
      direction,
      confidence: Math.min( 0.8, 0.3 + rSquared * 0.5 ),
    }
  }

  private _trendToBelief( trend: TemporalTrend, tick: Tick ): Belief | null {
    if( trend.confidence < 0.6) return null

    this._idSeq++
    return {
      id: `belief-trend-${tick}-${this._idSeq}`,
      statement: trend.beliefStatement,
      category: 'pattern',
      confidence: trend.confidence,
      supportingEpisodes: trend.observations.reduce( ( s, o ) => s + o.count, 0 ),
      lastUpdatedAt: tick,
      tags: [ 'temporal_trend', trend.direction, 'semantic_cluster' ],
    }
  }

  // ── Anomaly detection ────────────────────────────────────

  private async _detectAnomalies(
    episodes: EpisodicMemory[],
    tick: Tick
   ): Promise<Array<{ statement: string; confidence: number; episode: EpisodicMemory }>> {
    const anomalies: Array<{ statement: string; confidence: number; episode: EpisodicMemory }> = []
    
    // For each existing cluster, check if new episodes contradict it
    for( const cluster of this._clusters ){
      for( const episode of episodes ){
        const similarity = this._contentSimilarity( cluster.prototypeStatement, this._episodeToText( episode ) )
        
        // If episode is semantically similar but emotionally opposite, it's an anomaly
        if( similarity > 0.4 ){
          const valenceDiff = Math.abs( episode.affectiveContext?.valence ?? 0 - cluster.valenceMean )
          if( valenceDiff > 0.6 )
            anomalies.push({
              statement: `Not all experiences about ${cluster.prototypeStatement.toLowerCase()} follow the usual pattern`,
              confidence: Math.min( 0.65, 0.4 + valenceDiff * 0.3 ),
              episode,
            })
        }
      }
    }

    return anomalies.slice( 0, 3 )
  }

  private _anomalyToBelief(
    anomaly: { statement: string; confidence: number; episode: EpisodicMemory },
    tick: Tick
   ): Belief {
    this._idSeq++

    return {
      id: `belief-anomaly-${tick}-${this._idSeq}`,
      statement: anomaly.statement,
      category: 'pattern',
      confidence: anomaly.confidence,
      supportingEpisodes: 1,
      lastUpdatedAt: tick,
      tags: ['anomaly', 'exception', 'semantic_cluster']
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private _episodeToText( episode: EpisodicMemory ): string {
    if( typeof episode.content === 'string')
      return episode.content

    if( typeof episode.content === 'object' && episode.content !== null ){
      const content = episode.content as Record<string, unknown>
      if( typeof content['summary'] === 'string') return content['summary']
      if( typeof content['description'] === 'string') return content['description']
      if( typeof content['userMessage'] === 'string') return content['userMessage']

      return JSON.stringify( episode.content )
    }

    return String( episode.content )
  }

  private _episodeToQuery( episode: EpisodicMemory ): string {
    // Build a rich query string that captures emotional and thematic content
    const text = this._episodeToText( episode )
    const valence = episode.affectiveContext?.valence ?? 0
    const emotionHint = valence > 0.3 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral'
    
    return `${text} ${emotionHint} ${episode.tags.slice( 0, 3 ).join(' ')}`
  }

  private _contentSimilarity( a: string, b: string ): number {
    const tokenize = ( s: string ) => new Set( s.toLowerCase().split(/\s+/).filter( w => w.length > 2 && !_STOP_WORDS.has( w ) ) )
    
    const wordsA = tokenize(a)
    const wordsB = tokenize(b)
    
    if( wordsA.size === 0 || wordsB.size === 0 ) return 0
    
    const intersection = [ ...wordsA].filter( w => wordsB.has( w ) ).length
    const union = new Set([ ...wordsA, ...wordsB ]).size
    
    return union > 0 ? intersection / union : 0
  }

  // ── Public API ───────────────────────────────────────────

  getClusters(): ReadonlyArray<Cluster> { return this._clusters }
  clearClusters(): void { this._clusters = [] }
}
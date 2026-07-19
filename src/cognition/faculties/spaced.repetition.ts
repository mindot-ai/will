// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/spaced.repetition.ts
// ─────────────────────────────────────────────────────────────

/**
 * SpacedRepetition — active memory maintenance via scheduled review.
 *
 * Implements the SM-2 algorithm (SuperMemo 2) for optimal review intervals:
 *   - Higher confidence → longer intervals between reviews
 *   - Successful review increases confidence and interval
 *   - Failed review decreases confidence and resets interval
 *
 * Runs independently of the forgetting curve (active vs passive processes ):
 *   - ForgettingCurve = passive decay (always happening)
 *   - SpacedRepetition = active reinforcement (periodic review)
 *
 * Part of Shard 2 (Memory Layer) — runs every tick, but only triggers
 * review cycles on schedule.
 */

import { logger } from '#core/logger'
import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { SemanticIntegrator, Belief } from '#faculties/semantic.engine'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { ExecutiveEngine } from '#faculties/executive.engine'
import { GenerativeModel } from '#cognition/generative.model'
import { SessionLogger } from '#stem/tracts/session.logger'

export interface SpacedRepetitionConfig {
  /** Minimum ticks between review cycles */
  reviewIntervalTicks?: number
  /** Maximum beliefs to review per cycle */
  maxReviewsPerCycle?: number
  /** Minimum confidence before a belief qualifies for review */
  minConfidenceForReview?: number
  /** How much successful review increases confidence (0-1) */
  successBoost?: number
  /** How much failed review decreases confidence (0-1) */
  failurePenalty?: number
  /** Base interval for new beliefs (ticks) */
  baseIntervalTicks?: number
  /** Maximum interval cap (ticks) */
  maxIntervalTicks?: number
  /** Whether to surface beliefs to executive for re-evaluation */
  executiveReviewEnabled?: boolean
  /** Whether to actively rehearse salient episodic memories each review cycle
   *  (waking episodic spaced repetition). Default true. */
  episodicRehearsalEnabled?: boolean
  bus?: CognitiveBus
}

export interface ReviewRecord {
  beliefId: string
  /** Current interval length in ticks */
  interval: number
  /** Tick of the last review */
  lastReviewedAt: Tick
  /** Number of successful reviews in a row */
  consecutiveSuccesses: number
  /** Easiness factor (SM-2: 1.3 to 2.5, default 2.5) */
  easinessFactor: number
}

export class SpacedRepetition implements SimulationEngine, CognitiveEngine {
  readonly name = 'spaced-repetition'

  private _reviewIntervalTicks: number
  private _maxReviewsPerCycle: number
  private _minConfidenceForReview: number
  private _successBoost: number
  private _failurePenalty: number
  private _baseIntervalTicks: number
  private _maxIntervalTicks: number
  private _executiveReviewEnabled: boolean
  private _episodicRehearsalEnabled: boolean

  private _semanticIntegrator: SemanticIntegrator | null = null
  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _executiveEngine: ExecutiveEngine | null = null
  private _sessionLogger: SessionLogger | null = null

  /** Review records keyed by beliefId */
  private _reviewRecords = new Map<string, ReviewRecord>()
  
  /** Last tick when a review cycle ran */
  private _lastReviewCycleTick: Tick = 0
  
  private _bus: CognitiveBus | null = null
  private _restored = false

  private readonly _model = new GenerativeModel()

  constructor( config: SpacedRepetitionConfig = {} ){
    this._bus = config.bus ?? null
    this._reviewIntervalTicks = config.reviewIntervalTicks ?? 50
    this._maxReviewsPerCycle = config.maxReviewsPerCycle ?? 5
    this._minConfidenceForReview = config.minConfidenceForReview ?? 0.15
    this._successBoost = config.successBoost ?? 0.05
    this._failurePenalty = config.failurePenalty ?? 0.08
    this._baseIntervalTicks = config.baseIntervalTicks ?? 10
    this._maxIntervalTicks = config.maxIntervalTicks ?? 500
    this._executiveReviewEnabled = config.executiveReviewEnabled ?? false
    this._episodicRehearsalEnabled = config.episodicRehearsalEnabled ?? true
  }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  attachSemanticIntegrator( integrator: SemanticIntegrator ): void { this._semanticIntegrator = integrator }
  attachEpisodicConsolidator( consolidator: EpisodicConsolidator ): void { this._episodicConsolidator = consolidator }
  attachExecutiveEngine( executive: ExecutiveEngine ): void { this._executiveEngine = executive }
  attachSessionLogger( logger: SessionLogger ): void { this._sessionLogger = logger }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-spaced-repetition')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number | boolean> | undefined
    if( !p ) return

    if( p.reviewIntervalTicks != null ) this._reviewIntervalTicks = p.reviewIntervalTicks as number
    if( p.maxReviewsPerCycle != null ) this._maxReviewsPerCycle = p.maxReviewsPerCycle as number
    if( p.minConfidenceForReview != null ) this._minConfidenceForReview = p.minConfidenceForReview as number
    if( p.successBoost != null ) this._successBoost = p.successBoost as number
    if( p.failurePenalty != null ) this._failurePenalty = p.failurePenalty as number
    if( p.baseIntervalTicks != null ) this._baseIntervalTicks = p.baseIntervalTicks as number
    if( p.maxIntervalTicks != null ) this._maxIntervalTicks = p.maxIntervalTicks as number
    if( p.executiveReviewEnabled != null ) this._executiveReviewEnabled = p.executiveReviewEnabled as boolean
    if( p.episodicRehearsalEnabled != null ) this._episodicRehearsalEnabled = p.episodicRehearsalEnabled as boolean
  }

  subscribes(): string[] {
    return [
      'belief.updated',
      'executive.prediction.formed',
      'spaced_repetition.review.completed'
    ]
  }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'spaced_repetition.review.due', version: 1, validate: () => null },
      { type: 'spaced_repetition.review.completed', version: 1, validate: () => null },
      { type: 'spaced_repetition.episodes.rehearsed', version: 1, validate: () => null }
    ]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('memory') )
          // Boost the stream this engine actually publishes salience on (the
          // 'spaced_repetition.state.changed' event observes 'records'), so the
          // executive's memory-precision reaches the workspace. (Was
          // 'spaced_repetition.review_rate' — a stream never observed, so the
          // knob was dead. See METACOGNITION_CYCLE_TODO.md 1d.)
          this._model.setPrecision('spaced_repetition.records', 1.0 + p.confidence * 0.5 )

        break
      }

      case 'belief.updated': {
        // When a new belief is formed, initialize its review record
        const payload = e.payload as { total?: number; beliefId?: string }
        if( payload.beliefId && !this._reviewRecords.has( payload.beliefId ) )
          this._initializeRecord( payload.beliefId )
        
        break
      }

      case 'spaced_repetition.review.completed': {
        // External review completion (e.g., from executive decision)
        const payload = e.payload as { beliefId: string; success: boolean; tick: number }
        if( payload.beliefId )
          this._processReviewOutcome( payload.beliefId, payload.success, payload.tick )
        
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    // FN9: capture salience and model state for deterministic replay
    return {
      model: this._model.snapshot(),
      reviewRecords: Array.from( this._reviewRecords.entries() ),
      lastReviewCycleTick: this._lastReviewCycleTick,
    }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return
    if( snap.model ) this._model.restore(snap.model as import('#cognition/generative.model').GenerativeModelSnapshot)
    if( snap.reviewRecords ){
      this._reviewRecords.clear()
      for( const [ id, record ] of snap.reviewRecords as [string, ReviewRecord][])
        this._reviewRecords.set( id, record )
    }

    if( snap.lastReviewCycleTick != null ) this._lastReviewCycleTick = snap.lastReviewCycleTick as number
  }

  /**
   * Rehydrate review records from persisted 'spaced_repetition_record' entities.
   * Called once on the first tick after snapshot restore.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'spaced_repetition_record') continue
      if( this._reviewRecords.has( entity.id ) ) continue

      const m = entity.metadata ?? {}
      this._reviewRecords.set( entity.id, {
        beliefId: entity.id,
        interval: (m['interval'] as number) ?? this._baseIntervalTicks,
        lastReviewedAt: (m['lastReviewedAt'] as number) ?? 0,
        consecutiveSuccesses: (m['consecutiveSuccesses'] as number) ?? 0,
        easinessFactor: (m['easinessFactor'] as number) ?? 2.5,
      })
    }

    logger.info(`[spaced-repetition] restored ${this._reviewRecords.size} review records from snapshot`)
  }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
   ): Promise<EngineResult> {
    this._readConfigFromState( state )

    // On first tick after snapshot restore, rehydrate review records
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    const commands: StateCommands = { set: [], metrics: [] }

    // Check if it's time for a review cycle
    const ticksSinceLastCycle = tick - this._lastReviewCycleTick
    if( ticksSinceLastCycle >= this._reviewIntervalTicks ){
      await this._runReviewCycle( tick, commands )
      // Episodic rehearsal runs on the same cadence, but only while awake — the
      // DreamSimulator owns sleep-time reactivation, so gating here avoids
      // double-boosting the same memories.
      const sleeping = ( state.metrics.get('state.sleeping') ?? 0 ) > 0
      if( this._episodicRehearsalEnabled && !sleeping )
        this._rehearseEpisodes( tick, commands )
      this._lastReviewCycleTick = tick
    }

    // Persist all review records
    for( const [ beliefId, record ] of this._reviewRecords.entries() )
      commands.set!.push({
        id: beliefId,
        type: 'spaced_repetition_record',
        updatedAt: tick,
        metadata: {
          interval: record.interval,
          lastReviewedAt: record.lastReviewedAt,
          consecutiveSuccesses: record.consecutiveSuccesses,
          easinessFactor: record.easinessFactor
        }
      })

    if( !commands.metrics ) commands.metrics = []
    commands.metrics.push(
      [ 'memory.spaced_repetition_records', this._reviewRecords.size ],
      [ 'memory.spaced_repetition_last_cycle', this._lastReviewCycleTick ]
    )

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._reviewRecords.size > 0 ){
      const predErr = this._model.observe('spaced_repetition.records', this._reviewRecords.size )
      if( !predErr.gated )
        _bus.publish({
          type: 'spaced_repetition.state.changed',
          version: 1,
          sourceEngine: this.name,
          salience: Math.max(0.2, predErr.salience),
          payload: { totalRecords: this._reviewRecords.size }
        })
    }

    return { commands }
  }

  // ── Review cycle ─────────────────────────────────────────

  private async _runReviewCycle( tick: Tick, commands: StateCommands ): Promise<void> {
    if( !this._semanticIntegrator ) return

    const allBeliefs = this._semanticIntegrator.getBeliefs()
    const dueForReview: Belief[] = []

    for( const belief of allBeliefs ){
      if( belief.confidence < this._minConfidenceForReview ) continue

      const record = this._reviewRecords.get( belief.id )
      if( !record ){
        this._initializeRecord( belief.id, tick )
        // New records are due immediately for first review
        dueForReview.push( belief )
        continue
      }

      const timeSinceLastReview = tick - record.lastReviewedAt
      if( timeSinceLastReview >= record.interval )
        dueForReview.push( belief )
    }

    // Sort by priority: lowest confidence first (most at risk)
    dueForReview.sort( ( a, b ) => a.confidence - b.confidence )

    const toReview = dueForReview.slice( 0, this._maxReviewsPerCycle )
    if( toReview.length === 0 ) return

    logger.info(`[spaced-repetition] reviewing ${toReview.length} beliefs (${dueForReview.length} due total)`)

    // Publish due events for external handling
    const _bus = this._bus
    if( _bus )
      for( const belief of toReview )
        _bus.publish({
          type: 'spaced_repetition.review.due',
          version: 1,
          sourceEngine: this.name,
          salience: Math.max(0.3, this._model.observe('spaced_repetition.review_due', 1).salience),
          payload: {
            beliefId: belief.id,
            statement: belief.statement,
            currentConfidence: belief.confidence,
            interval: this._reviewRecords.get(belief.id)?.interval ?? this._baseIntervalTicks,
            tick,
          }
        })

    // Surface to executive for re-evaluation via introspection
    // This would require extending ExecutiveEngine to accept review tasks
    if( this._executiveReviewEnabled && this._executiveEngine )
      await this._surfaceToExecutive( toReview, tick )
    
    // Automatic reinforcement: assume successful recall
    else 
      for( const belief of toReview )
        this._processReviewOutcome(belief.id, true, tick, commands)
  }

  // ── Episodic rehearsal (waking episodic spaced repetition) ───

  /**
   * Active waking rehearsal of salient episodic memories.
   *
   * Beliefs get scheduled SM-2 review above; episodes previously had only
   * passive decay (ForgettingCurve) plus opportunistic sleep reactivation
   * (DreamSimulator), so an emotionally significant memory the Will happened not
   * to recall would simply fade. This selects the most worth-keeping episodes
   * that are *due* — salient, not retrieved within a review interval, still
   * above the pruning floor — and marks them retrieved. markRetrieved both nudges
   * activation and (via retrievalCount) unlocks the ForgettingCurve's
   * retrievalBoost, so rehearsed memories decay slower and persist.
   */
  private _rehearseEpisodes( tick: Tick, commands: StateCommands ): void {
    const consolidator = this._episodicConsolidator
    if( !consolidator ) return

    const episodes = consolidator.getAllEpisodes()
    if( episodes.length === 0 ) return

    const due: Array<{ id: string; score: number }> = []
    for( const ep of episodes ){
      // Leave the nearly-forgotten alone — let the ForgettingCurve retire them.
      if( ep.activationStrength < 0.05 ) continue
      // Due = never retrieved, or not retrieved within a review interval.
      const since = ep.lastRetrievedAt === null ? Infinity : tick - ep.lastRetrievedAt
      if( since < this._reviewIntervalTicks ) continue

      // Prioritise emotionally significant memories that are starting to fade.
      const emotionalIntensity = this._episodeEmotionalIntensity( ep.emotionalTags )
      due.push( { id: ep.id, score: emotionalIntensity * 0.6 + ( 1 - ep.activationStrength ) * 0.4 } )
    }
    if( due.length === 0 ) return

    // Highest score first; tie-break by id so rehearsal order is replay-stable.
    due.sort( ( a, b ) => ( b.score - a.score ) || ( a.id < b.id ? -1 : 1 ) )
    const rehearsed = due.slice( 0, this._maxReviewsPerCycle )

    for( const { id } of rehearsed )
      consolidator.markRetrieved( id, tick )

    commands.metrics ??= []
    commands.metrics.push( [ 'memory.episodic_rehearsed', rehearsed.length ] )

    this._bus?.publish({
      type: 'spaced_repetition.episodes.rehearsed',
      version: 1,
      sourceEngine: this.name,
      salience: Math.max( 0.3, this._model.observe('spaced_repetition.episodic_rehearsal', rehearsed.length ).salience ),
      payload: { rehearsed: rehearsed.length }
    })
  }

  private _episodeEmotionalIntensity( emotionalTags: Record<string, number> ): number {
    const v = Object.values( emotionalTags )
    if( v.length === 0 ) return 0
    return v.reduce( ( s, x ) => s + Math.abs( x ), 0 ) / v.length
  }

  private _initializeRecord( beliefId: string, tick: Tick = 0 ): void {
    this._reviewRecords.set( beliefId, {
      beliefId,
      interval: this._baseIntervalTicks,
      lastReviewedAt: tick,
      consecutiveSuccesses: 0,
      easinessFactor: 2.5
    })
  }

  private _processReviewOutcome(
    beliefId: string,
    success: boolean,
    tick: Tick,
    commands?: StateCommands
   ): void {
    const record = this._reviewRecords.get( beliefId )
    if( !record ){
      this._initializeRecord( beliefId, tick )
      // First review always considered success
      this._processReviewOutcome( beliefId, true, tick, commands )
      return
    }

    const belief = this._semanticIntegrator?.getBeliefs().find( b => b.id === beliefId )
    if( !belief ) return

    const prevConfidence = belief.confidence

    if( success ){
      // SM-2 algorithm for interval calculation
      let newInterval: number
      if( record.consecutiveSuccesses === 0 ) newInterval = this._baseIntervalTicks
      else if( record.consecutiveSuccesses === 1 ) newInterval = this._baseIntervalTicks * 2
      else newInterval = Math.round( record.interval * record.easinessFactor )
      
      record.interval = Math.min( newInterval, this._maxIntervalTicks )
      record.consecutiveSuccesses++
      
      // Easiness factor adjustment (SM-2: EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
      // Quality 5 (perfect recall) increases EF, lower qualities decrease
      const quality = 5  // Assume perfect recall for automatic reinforcement
      record.easinessFactor = Math.max( 1.3, record.easinessFactor + ( 0.1 - ( 5 - quality) * 0.08 ) )
      
      // Increase confidence
      const newConfidence = Math.min( 1, belief.confidence + this._successBoost )
      belief.confidence = newConfidence
      belief.lastUpdatedAt = tick
      
      // Record history if SemanticIntegrator exposes it
      this._recordBeliefHistory( belief, tick, prevConfidence, 'spaced_repetition_reinforced')
    }
    else {
      // Failed review — reset interval and decrease confidence
      record.interval = this._baseIntervalTicks
      record.consecutiveSuccesses = 0
      record.easinessFactor = Math.max( 1.3, record.easinessFactor - 0.2 )
      
      const newConfidence = Math.max( 0.1, belief.confidence - this._failurePenalty )
      belief.confidence = newConfidence
      belief.lastUpdatedAt = tick
      
      this._recordBeliefHistory( belief, tick, prevConfidence, 'spaced_repetition_failed')
    }

    record.lastReviewedAt = tick

    this._bus?.publish({
      type: 'spaced_repetition.review.completed',
      version: 1,
      sourceEngine: this.name,
      salience: Math.max( 0.4, Math.abs( belief.confidence - prevConfidence ) ),
      payload: {
        beliefId,
        success,
        oldConfidence: prevConfidence,
        newConfidence: belief.confidence,
        newInterval: record.interval,
        tick
      }
    })
  }

  /**
   * Record belief history entry (mirrors SemanticIntegrator._recordHistory).
   * This requires SemanticIntegrator to expose a public method for external updates.
   */
  private _recordBeliefHistory(
    belief: Belief,
    tick: Tick,
    prevConfidence: number,
    cause: string
   ): void {
    // This would call into SemanticIntegrator if it exposes a method
    // For now, we rely on the integrator's own decay/update mechanisms
    this._sessionLogger?.write({
      type: 'belief.spaced_repetition',
      tick,
      beliefId: belief.id,
      statement: belief.statement.slice( 0, 100 ),
      oldConfidence: prevConfidence,
      newConfidence: belief.confidence,
      cause
    } as any)
  }

  private async _surfaceToExecutive( beliefs: Belief[], tick: Tick ): Promise<void> {
    if( !this._executiveEngine ) return

    // Group beliefs by category for efficient processing
    const byCategory = new Map<string, Belief[]>()
    for( const belief of beliefs ){
      const cat = byCategory.get( belief.category ) ?? []

      cat.push( belief )
      byCategory.set( belief.category, cat )
    }

    // For each category, create a review prompt for the executive
    // This would require extending ExecutiveEngine to accept external review requests
    // via a new cognitive event type
    
    this._bus?.publish({
      type: 'executive.review.requested',
      version: 1,
      sourceEngine: this.name,
      salience: 0.7,
      payload: {
        beliefsToReview: beliefs.map( b => ({
          id: b.id,
          statement: b.statement,
          category: b.category,
          currentConfidence: b.confidence,
        })),
        tick
      }
    })
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Manually trigger a review for a specific belief.
   * Used when the executive decides to re-evaluate a belief.
   */
  requestReview( beliefId: string, tick: Tick ): void {
    const record = this._reviewRecords.get( beliefId )
    if( record ){
      // Reset interval to force immediate review
      record.interval = 0
      record.lastReviewedAt = tick - this._reviewIntervalTicks
    }
  }

  /**
   * Get the current review status for a belief.
   */
  getReviewStatus( beliefId: string ): ReviewRecord | undefined {
    return this._reviewRecords.get( beliefId )
  }

  /**
   * Get all beliefs currently due for review (without triggering cycle).
   */
  getDueForReview(tick: Tick ): Array<{ belief: Belief; record: ReviewRecord }> {
    if( !this._semanticIntegrator ) return []

    const result: Array<{ belief: Belief; record: ReviewRecord }> = []
    const allBeliefs = this._semanticIntegrator.getBeliefs()

    for( const belief of allBeliefs ){
      const record = this._reviewRecords.get( belief.id )
      if( !record ) continue
      
      const timeSinceLastReview = tick - record.lastReviewedAt
      if( timeSinceLastReview >= record.interval )
        result.push({ belief, record })
    }

    return result.sort( ( a, b ) => a.belief.confidence - b.belief.confidence )
  }
}
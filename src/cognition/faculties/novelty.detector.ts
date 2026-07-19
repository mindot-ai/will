// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/novelty.detector.ts
// ─────────────────────────────────────────────────────────────

/**
 * NoveltyDetector — compares current percepts against expectations.
 *
 * Computes prediction error by comparing incoming percept patterns
 * against a running model of expected patterns. High novelty signals:
 *   - Something unexpected happened
 *   - The world has changed in a meaningful way
 *   - The current mental model needs updating
 *
 * Novelty drives:
 *   - Curiosity (positive valence + novelty → exploration)
 *   - Anxiety (negative valence + novelty → caution)
 *   - Learning (high novelty events are consolidated more strongly)
 *
 * Uses a simple exponential moving average of recent percept counts
 * per category as the expectation baseline.
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

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
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface NoveltyDetectorConfig {
  /** Learning rate for expectation updates (0-1) */
  learningRate?: number
  /** How many ticks to look back for pattern comparison */
  windowSize?: number
  /** Threshold above which novelty is considered significant */
  significanceThreshold?: number
  bus?: CognitiveBus
}

interface CategoryStats {
  count: number
  averageSalience: number
}

export class NoveltyDetector implements SimulationEngine, CognitiveEngine {
  readonly name     = 'novelty-detector'
  
  private _learningRate: number
  private _windowSize: number
  private _significanceThreshold: number

  // Expected patterns — EMA of percept counts per category
  private _expectedCounts = new Map<string, number>()
  private _expectedSalience = new Map<string, number>()
  private _recentHistory: Array<Map<string, CategoryStats>> = []

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: NoveltyDetectorConfig = {} ){
    this._bus = config.bus ?? null
    this._learningRate          = config.learningRate          ?? 0.1
    this._windowSize            = config.windowSize            ?? 10
    this._significanceThreshold = config.significanceThreshold ?? 0.4
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-novelty ⊕ persona-prior. Channel A: an open
    // Will develops a lower significanceThreshold and so registers novelty more readily.
    const p = readEffectiveParams( state, 'engine-config-novelty')
    if( p.learningRate != null ) this._learningRate = p.learningRate
    if( p.windowSize != null ) this._windowSize = p.windowSize
    if( p.significanceThreshold != null ) this._significanceThreshold = p.significanceThreshold
  }


  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('perception') )
        this._model.setPrecision('novelty.score', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )
    
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Aggregate current percepts by category
    const currentStats = this._aggregatePercepts( state )

    // Compute novelty per category
    let totalNovelty = 0
    let categoriesWithNovelty = 0

    for( const [ category, stats ] of currentStats ){
      const
      expectedCount   = this._expectedCounts.get( category ) ?? 0,
      expectedSalience = this._expectedSalience.get( category ) ?? 0.3,
      countNovelty    = this._computeNovelty( stats.count, expectedCount ),
      salienceNovelty = this._computeNovelty( stats.averageSalience, expectedSalience ),
      categoryNovelty = ( countNovelty + salienceNovelty ) / 2

      // Update running metric per category
      commands.metrics!.push([ `novelty.${category}`, categoryNovelty ])

      if( categoryNovelty > this._significanceThreshold )
        categoriesWithNovelty++

      totalNovelty += categoryNovelty
    }

    // Overall novelty
    const overallNovelty = currentStats.size > 0
      ? totalNovelty / currentStats.size
      : 0

    commands.metrics!.push(
      [ 'perception.novelty', overallNovelty ],
      [ 'novelty.significant_categories', categoriesWithNovelty ],
    )

    // Significant novelty event
    if( overallNovelty > this._significanceThreshold )
      events.push({
        type: 'novelty.significant',
        source: this.name,
        payload: {
          overallNovelty,
          categoriesWithNovelty,
          tick,
        },
      })

    // Update expectations for next tick
    this._updateExpectations( currentStats )
    this._updateHistory( currentStats )


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && overallNovelty > 0.3 )
      _bus.publish({ type: 'perception.novelty.spike', version: 1, sourceEngine: this.name, salience: Math.min(1, overallNovelty * 2), payload: { novelty: overallNovelty } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe('novelty.score', overallNovelty )
      if( !predErr.gated )
        _bus.publish({ type: 'novelty.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { novelty: overallNovelty, socialEvaluationThreat: state.metrics.get('social.evaluation_threat') ?? 0, activeAgents: state.metrics.get('social.active_agents') ?? 0, fearLevel: state.metrics.get('emotion.fear') ?? 0 } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Aggregate current percept entities by category.
   */
  private _aggregatePercepts( state: ReadonlySimulationState ): Map<string, CategoryStats> {
    const stats = new Map<string, CategoryStats>()

    for( const entity of state.entities.values() ){
      if( entity.type !== 'percept' && entity.type !== 'percept.social')
        continue

      const category = ( entity.metadata?.category as string ) ?? 'unknown'
      const salience = ( entity.metadata?.salience as number ) ?? 0.3

      const existing = stats.get( category )
      if( existing ){
        existing.count++
        existing.averageSalience = ( existing.averageSalience * ( existing.count - 1 ) + salience ) / existing.count
      }
      else {
        stats.set( category, { count: 1, averageSalience: salience } )
      }
    }

    return stats
  }

  /**
   * Compute novelty as normalized deviation from expected value.
   */
  private _computeNovelty( current: number, expected: number ): number {
    if( expected === 0 )
      return current > 0 ? 1.0 : 0.0

    const deviation = Math.abs( current - expected )
    const normalized = deviation / Math.max( expected, 1 )

    return Math.min( 1, normalized )
  }

  /**
   * Update exponential moving averages for each category.
   */
  private _updateExpectations( stats: Map<string, CategoryStats> ): void {
    // Update for observed categories
    for( const [ category, s ] of stats ){
      const prevCount   = this._expectedCounts.get( category ) ?? 0,
            prevSalience = this._expectedSalience.get( category ) ?? 0.3

      this._expectedCounts.set(
        category,
        prevCount + this._learningRate * ( s.count - prevCount )
      )

      this._expectedSalience.set(
        category,
        prevSalience + this._learningRate * ( s.averageSalience - prevSalience )
      )
    }

    // Decay expectations for unobserved categories
    for( const [ category, count ] of this._expectedCounts ){
      if( !stats.has( category ) )
        this._expectedCounts.set( category, count * ( 1 - this._learningRate * 0.5 ) )
    }
  }

  private _updateHistory( stats: Map<string, CategoryStats> ): void {
    this._recentHistory.push( new Map( stats ) )
    if( this._recentHistory.length > this._windowSize )
      this._recentHistory.shift()
  }
}
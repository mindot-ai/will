// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/aesthetic.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * AestheticEvaluator — responds to novelty, complexity, pattern, and beauty.
 *
 * Evaluates:
 *   - Perceptual novelty (new patterns, unexpected combinations)
 *   - Complexity (information richness)
 *   - Pattern coherence (elegance, symmetry, resolution)
 *   - Cognitive challenge (optimal difficulty for engagement)
 *
 * Produces: awe, curiosity, interest, boredom
 *
 * Awe = overwhelming positive novelty + pattern (transcendent experience)
 * Curiosity = moderate novelty + safety (desire to explore)
 * Interest = sustainable engagement with moderately complex stimuli
 * Boredom = absence of novelty or excessive predictability
 *
 * The aesthetic drive fuels exploration, learning, and creative behavior.
 * It's modulated by safety (curiosity shuts down under high threat).
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult } from '#cognition/types'
import type { CognitiveEngine } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface AestheticEvaluatorConfig {
  /** Threshold for awe (extreme novelty + coherence) */
  aweThreshold?: number
  /** Optimal novelty range for curiosity [min, max] */
  curiosityRange?: [number, number]
  /** How quickly boredom escalates without stimulation */
  boredomRate?: number
  /**
   * Minimum curiosity even with zero novelty (0–1).
   * Prevents full curiosity collapse — the Will retains baseline intellectual drive.
   */
  curiosityFloor?: number
  bus?: CognitiveBus
}

export class AestheticEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'aesthetic-evaluator'
  
  private _aweThreshold: number
  private _curiosityMin: number
  private _curiosityMax: number
  private _boredomRate: number
  private _curiosityFloor: number
  private _boredomExecutiveScale = 1

  // Track stimulus history for boredom detection
  private _recentStimulusCount: number[] = []  // last N ticks of percept counts
  private _windowSize = 20

  // Rolling category buffer from percept.category.updated events (for complexity/coherence)
  private _categoryBuffer = new Map<string, number>()  // category → count this tick

  // Cached inputs from cognitive events
  private _cachedNovelty: number = 0   // from novelty.state.changed / perception.novelty.spike
  private _cachedFear:    number = 0   // future: subscribe to threat.evaluated
  private _cachedBoredom: number = 0

  private _bus: CognitiveBus | null = null

  // Consecutive ticks where boredom exceeded the significant threshold.
  // Once this reaches _boredomEscalationThreshold we push a drive.seek_engagement metric
  // and reset so the drive only fires in sustained-boredom bursts.
  private _consecutiveBoredomTicks  = 0
  private readonly _boredomEscalationThreshold = 5
  private readonly _boredomSignificantCutoff   = 0.6

  private readonly _model    = new GenerativeModel()


  constructor( config: AestheticEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._aweThreshold  = config.aweThreshold  ?? 0.8
    this._curiosityMin  = config.curiosityRange?.[0] ?? 0.2
    this._curiosityMax  = config.curiosityRange?.[1] ?? 0.7
    this._boredomRate   = config.boredomRate   ?? 0.005
    this._curiosityFloor = config.curiosityFloor ?? 0.08
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'percept.category.updated',
      'novelty.state.changed',
      'perception.novelty.spike',
    ]
  }

  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('aesthetic') )
        this._model.setPrecision( 'emotion.awe', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'percept.category.updated' ){
      const p = e.payload as { category: string; count: number }
      this._categoryBuffer.set(
        p.category,
        ( this._categoryBuffer.get( p.category ) ?? 0 ) + p.count
      )
    }
    if( e.type === 'novelty.state.changed' || e.type === 'perception.novelty.spike' ){
      const p = e.payload as { novelty: number }
      this._cachedNovelty = p.novelty
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    delta: Duration,
    _tick: Tick,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Channel A (openness → aesthetic sensitivity): the awe threshold is read live as
    // base ⊕ persona-prior. An open Will develops a lower threshold and so is moved to
    // awe by beauty/novelty more readily. (The seed entity already existed but was ignored.)
    const aweThreshold = readEffectiveParams( state, 'engine-config-aesthetic' ).aweThreshold ?? this._aweThreshold

    // Consume category buffer for this tick
    const categories = new Map( this._categoryBuffer )
    this._categoryBuffer.clear()

    // Use novelty from novelty.detector (proper expectation-based novelty signal)
    const novelty = this._cachedNovelty

    // Aesthetic dimensions from category buffer
    const
    complexity  = this._assessComplexity( categories ),
    coherence   = this._assessCoherence( categories ),
    safety      = 1 - this._cachedFear,
    perceptCount = Array.from( categories.values() ).reduce( ( s, v ) => s + v, 0 )

    // Track stimulus history
    this._recentStimulusCount.push( perceptCount )
    if( this._recentStimulusCount.length > this._windowSize )
      this._recentStimulusCount.shift()

    const stimulusVariability = this._computeStimulusVariability()

    const aweRaw = novelty * coherence * safety
    const awe = aweRaw > aweThreshold ? aweRaw : 0

    const curiosityRaw = this._curiosityCurve( novelty ) * safety * ( complexity * 0.7 + 0.3 )
    const curiosity = Math.min( 1, curiosityRaw )

    const interest = Math.min( 1,
      complexity * 0.4
      + novelty * 0.3
      + ( 1 - Math.abs( novelty - 0.5 ) * 2 ) * 0.3
    )

    const previousBoredom = this._cachedBoredom
    const boredom = stimulusVariability < 0.1
      ? Math.min( 1, previousBoredom + this._boredomRate * ( delta / 1000 ) )
      : Math.max( 0, previousBoredom - this._boredomRate * 2 * ( delta / 1000 ) )
    this._cachedBoredom = boredom

    commands.metrics!.push(
      [ 'emotion.awe', awe ],
      [ 'emotion.curiosity', curiosity ],
      [ 'emotion.interest', interest ],
      [ 'emotion.boredom', boredom ],
      [ 'aesthetic.novelty', novelty ],
      [ 'aesthetic.complexity', complexity ],
      [ 'aesthetic.coherence', coherence ],
      [ 'aesthetic.stimulus_variability', stimulusVariability ],
    )

    // Awe event (rare — transcendent moments)
    if( awe > 0.6 )
      events.push({
        type: 'emotion.awe.significant',
        source: this.name,
        payload: { awe, novelty, coherence, complexity },
      })

    // Curiosity spike
    if( curiosity > 0.7 )
      events.push({
        type: 'emotion.curiosity.elevated',
        source: this.name,
        payload: { curiosity, novelty, safety },
      })

    // Boredom alert + escalation drive
    if( boredom > this._boredomSignificantCutoff ){
      events.push({
        type: 'emotion.boredom.significant',
        source: this.name,
        payload: { boredom, stimulusVariability },
      })
      this._consecutiveBoredomTicks++
    } else {
      this._consecutiveBoredomTicks = 0
    }

    // After N consecutive significant-boredom ticks, elevate a proactive drive so
    // GoalManager can create a "seek engagement" goal rather than drifting in loops.
    const engagementDrive = this._consecutiveBoredomTicks >= this._boredomEscalationThreshold
      ? Math.min( 1, boredom * 1.2 )   // proportional intensity
      : 0

    commands.metrics!.push( [ 'drive.seek_engagement', engagementDrive ] )

    if( engagementDrive > 0 && this._bus ){
      this._bus.publish({
        type: 'drive.seek_engagement', version: 1, sourceEngine: this.name,
        salience: engagementDrive * 0.7,
        payload: {
          boredom,
          consecutiveTicks: this._consecutiveBoredomTicks,
          stimulusVariability,
        },
      })
    }


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && awe > 0.4 ){
      const predErr = this._model.observe( 'emotion.awe', awe )
      if( !predErr.gated )
        _bus.publish({ type: 'emotion.awe.experienced', version: 1, sourceEngine: this.name, salience: Math.min(1, awe * 2), payload: { awe } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Aesthetic dimension assessment ───────────────────────

  private _assessComplexity( categories: Map<string, number> ): number {
    return Math.min( 1, categories.size / 8 )
  }

  private _assessCoherence( categories: Map<string, number> ): number {
    const totalPercepts = Array.from( categories.values() ).reduce( ( s, v ) => s + v, 0 )
    if( totalPercepts === 0 ) return 0.5

    const
    uniqueCategories = categories.size,
    maxConcentration = Math.max( ...categories.values() ) / totalPercepts

    const categoryScore = uniqueCategories >= 2 && uniqueCategories <= 4 ? 1
                        : uniqueCategories === 1 ? 0.3
                        : Math.max( 0, 1 - ( uniqueCategories - 4 ) * 0.15 )

    return categoryScore * 0.5 + maxConcentration * 0.5
  }

  /**
   * Map novelty to a curiosity curve.
   * Peak curiosity at moderate novelty (not too boring, not too threatening).
   */
  private _curiosityCurve( novelty: number ): number {
    if( novelty < this._curiosityMin ) return Math.max( this._curiosityFloor, novelty / this._curiosityMin * 0.3 )
    if( novelty <= this._curiosityMax ){
      // Inverted U in the optimal range
      const mid = ( this._curiosityMin + this._curiosityMax ) / 2
      const range = ( this._curiosityMax - this._curiosityMin ) / 2
      return 1 - Math.abs( novelty - mid ) / range * 0.4
    }
    // Beyond optimal range — declining but still present (if safe)
    return Math.max( 0.2, 1 - ( novelty - this._curiosityMax ) * 1.5 )
  }

  /**
   * Compute variability in recent stimulus levels.
   * Low variability = predictable = boring.
   */
  private _computeStimulusVariability(): number {
    if( this._recentStimulusCount.length < 3 ) return 0.5

    const mean = this._recentStimulusCount.reduce( ( s, v ) => s + v, 0 )
               / this._recentStimulusCount.length

    const variance = this._recentStimulusCount.reduce( ( s, v ) => s + ( v - mean ) ** 2, 0 )
                   / this._recentStimulusCount.length

    // Normalize — variance of 0 = 0 variability, variance > 25 = high variability
    return Math.min( 1, variance / 25 )
  }
}
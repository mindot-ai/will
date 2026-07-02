// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/stress.regulator.ts
// ─────────────────────────────────────────────────────────────

/**
 * StressRegulator — tracks cumulative allostatic load.
 *
 * Stress accumulates from:
 *   - Unresolved demands (pending goals, unread messages)
 *   - Time pressure (deadlines approaching)
 *   - Resource scarcity (low energy, high sleep pressure)
 *   - Social evaluation (perceived judgment, conflict)
 *   - Novelty/uncertainty (unfamiliar situations)
 *
 * Chronic stress degrades cognitive function and biases toward
 * habitual/defensive responses. Acute stress can enhance performance
 * (Yerkes-Dodson curve) up to an optimal point.
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
  DriveSignal,
  ModulationSignal,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface StressRegulatorConfig {
  /** Maximum allostatic load */
  maxLoad?: number
  /**
   * Fractional clearance rate (per second): the proportion of the *current*
   * load shed each second. Recovery is first-order (exponential), so this also
   * sets the recovery time-constant τ ≈ 1 / rate. Emotional-stability persona
   * development raises it (sheds stress faster); see persona.consolidator #23.
   */
  baseDecayRate?: number
  /** Threshold for optimal stress (peak performance) */
  optimalThreshold?: number
  /** Threshold for distress (cognitive degradation begins) */
  distressThreshold?: number
  /** Threshold for overload (significant impairment) */
  overloadThreshold?: number
  bus?: CognitiveBus
}

interface Stressor {
  type: string
  intensity: number
  source: string
}

export class StressRegulator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'stress-regulator'
  
  private _maxLoad: number
  private _baseDecayRate: number
  private _optimalThreshold: number
  private _distressThreshold: number
  private _overloadThreshold: number

  private _energyLevel: number = 100
  private _sleepPressure: number = 0
  private _noveltyScore: number = 0
  private _activeGoalCount: number = 0
  private _metacogConfidence: number = 0.7

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel( 0.15, 100 )


  constructor( config: StressRegulatorConfig = {} ){
    this._bus = config.bus ?? null
    this._maxLoad           = config.maxLoad           ?? 100
    this._baseDecayRate     = config.baseDecayRate     ?? 0.05
    this._optimalThreshold  = config.optimalThreshold  ?? 30
    this._distressThreshold = config.distressThreshold ?? 50
    this._overloadThreshold = config.overloadThreshold ?? 75
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────


  subscribes(): string[] { return ["energy.state.changed","sleep.state.changed","novelty.state.changed","goal.state.changed","metacognition.state.changed","executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'energy.state.changed':
        this._energyLevel = (e.payload as Record<string,number>)['level'] ?? this._energyLevel
        break
      case 'sleep.state.changed':
        this._sleepPressure = (e.payload as Record<string,number>)['pressure'] ?? this._sleepPressure
        break
      case 'novelty.state.changed':
        this._noveltyScore = (e.payload as Record<string,number>)['novelty'] ?? this._noveltyScore
        break
      case 'goal.state.changed':
        this._activeGoalCount = (e.payload as Record<string,number>)['activeCount'] ?? this._activeGoalCount
        break
      case 'metacognition.state.changed':
        this._metacogConfidence = (e.payload as Record<string,number>)['confidence'] ?? this._metacogConfidence
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if (p.predictedDomains.includes('stress'))
          this._model.setPrecision('stress.load', 1.0 + p.confidence * 0.5)
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel: this._energyLevel,
      sleepPressure: this._sleepPressure,
      noveltyScore: this._noveltyScore,
      activeGoalCount: this._activeGoalCount,
      metacogConfidence: this._metacogConfidence,
    }
  }

  async react(
    delta: Duration,
    _tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    const
    currentLoad  = state.metrics.get('stress.load') ?? 0,
    events:      Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands:    StateCommands = { metrics: [] }

    // Compute stressor contributions
    const stressors = this._assessStressors( state, delta )
    const totalStressorIntensity = stressors.reduce( ( s, st ) => s + st.intensity, 0 )

    // Allostatic load as a leaky integrator with *first-order* (proportional)
    // clearance: dL/dt = Σstressor − k·L. Clearance scales with current load,
    // exactly like physiological recovery — acute spikes shed fast, residual
    // load lingers. This yields a stable, graded equilibrium L* = Σstressor / k
    // for any sustained stressor, so light load settles at a low but non-zero
    // baseline rather than collapsing to 0. A constant absolute leak (the prior
    // model) had no graded equilibrium: it pinned to 0 whenever stressors fell
    // below the leak and ran away to max otherwise.
    //
    // Example: 3 active goals (0.5 each = 1.5/s) at the base k=0.05 settle at
    // L* = 30 — the optimal/eustress band. A steadier Will (higher k, via the
    // emotional-stability prior) settles lower; a less stable one carries more.
    const deltaSeconds = delta / 1000
    const accumulation = totalStressorIntensity * deltaSeconds
    const decay        = this._baseDecayRate * currentLoad * deltaSeconds
    const newLoad      = Math.max( 0, Math.min( this._maxLoad, currentLoad + accumulation - decay ) )

    // Recovery event
    if( currentLoad > this._distressThreshold && newLoad <= this._optimalThreshold )
      events.push({
        type: 'stress.recovery',
        source: this.name,
        payload: { previous: currentLoad, current: newLoad },
      })

    commands.metrics!.push([ 'stress.load', newLoad ])

    // Identify active stressors for metrics
    for( const stressor of stressors )
      commands.metrics!.push([ `stress.${stressor.type}`, stressor.intensity ])

    // Determine stress zone
    const zone = newLoad >= this._overloadThreshold  ? 'overload'
               : newLoad >= this._distressThreshold ? 'distress'
               : newLoad >= this._optimalThreshold  ? 'optimal'
               : 'low'

    commands.metrics!.push([ 'stress.zone', zone === 'low' ? 0 : zone === 'optimal' ? 1 : zone === 'distress' ? 2 : 3 ])

    // Zone transition events
    const previousZone = this._getZone( currentLoad )
    if( zone !== previousZone )
      events.push({
        type: `stress.zone_${zone}`,
        source: this.name,
        payload: { load: newLoad, zone, previousZone },
      })

    // Drive signal — stress itself is a meta-drive (motivates resolution)
    const driveIntensity = newLoad / this._maxLoad

    // Mirror drive intensity as a metric so GoalManager._activateFromDrives() can read it
    commands.metrics!.push([ 'drive.stress_reduction', newLoad >= this._distressThreshold ? driveIntensity : 0 ])

    if( newLoad >= this._distressThreshold ){
      events.push({
        type: 'drive.stress_reduction',
        source: this.name,
        payload: {
          name: 'stress_reduction',
          intensity: driveIntensity,
          urgency: newLoad >= this._overloadThreshold ? 1.0 : 0.5,
          source: this.name,
        } satisfies DriveSignal,
      })
    }

    // Modulation signals — stress affects decision-making
    if( zone === 'overload'){
      // Overload: significant cognitive narrowing
      events.push({
        type: 'modulation.stress_overload',
        source: this.name,
        payload: {
          target: 'decision-engine',
          parameter: 'exploration',
          factor: 0.2,  // Strong bias toward habitual/defensive
          source: this.name,
        } satisfies ModulationSignal,
      })
    }
    else if( zone === 'distress'){
      // Distress: moderate impairment, reduced creativity
      events.push({
        type: 'modulation.stress_distress',
        source: this.name,
        payload: {
          target: 'decision-engine',
          parameter: 'creativity',
          factor: 0.6,
          source: this.name,
        } satisfies ModulationSignal,
      })
    }
    else if( zone === 'optimal'){
      // Optimal: enhanced focus, motivation
      events.push({
        type: 'modulation.stress_optimal',
        source: this.name,
        payload: {
          target: 'attention-allocator',
          parameter: 'capacity',
          factor: 1.1,  // Slight boost
          source: this.name,
        } satisfies ModulationSignal,
      })
    }


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && ( zone === 'distress' || zone === 'overload' ) )
      _bus.publish({ type: 'stress.zone.transition', version: 1, sourceEngine: this.name, salience: Math.min(1, newLoad / 100), payload: { zone, load: newLoad } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const zoneCode = zone === 'low' ? 0 : zone === 'optimal' ? 1 : zone === 'distress' ? 2 : 3
      const predErr  = this._model.observe( 'stress.load', newLoad )
      if( !predErr.gated || zone !== previousZone ){
        _bus.publish({ type: 'stress.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { load: newLoad, zoneCode, deadlineUrgency: state.metrics.get('deadline.urgency') ?? 0, cognitiveLoad: state.metrics.get('cognitive.load') ?? state.metrics.get('attention.usage') ?? 0 } })
      }
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Config hot-reload ────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-stress ⊕ persona-prior. Channel A: a steadier
    // (emotionally-stable) Will develops a higher baseDecayRate and so sheds stress faster.
    const p = readEffectiveParams( state, 'engine-config-stress' )
    if( p.baseDecayRate       != null ) this._baseDecayRate     = p.baseDecayRate
    if( p.optimalThreshold    != null ) this._optimalThreshold  = p.optimalThreshold
    if( p.distressThreshold   != null ) this._distressThreshold = p.distressThreshold
    if( p.overloadThreshold   != null ) this._overloadThreshold = p.overloadThreshold
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Assess active stressors from the current state.
   */
  private _assessStressors( state: ReadonlySimulationState, delta: Duration ): Stressor[] {
    const stressors: Stressor[] = []

    // Demand pressure: active goals requiring action. ~0.5/goal so a handful of
    // concurrent goals lands in the eustress band (3 goals ⇒ ≈optimal at base
    // k); capped at 2 so goals alone plateau around distress and it takes
    // compounding stressors (fatigue, low energy, deadlines) to reach overload.
    const activeGoals = this._activeGoalCount
    if( activeGoals > 0 )
      stressors.push({
        type: 'demand',
        intensity: Math.min( activeGoals * 0.5, 2 ),
        source: 'goals',
      })

    // Time pressure: deadlines approaching
    const
    nearestDeadline = state.metrics.get('deadline.nearest'),
    deadlinePressure = nearestDeadline !== undefined && nearestDeadline > 0
                         ? Math.min( 30, 300 / Math.max( nearestDeadline, 1 ) )
                         : 0

    if( deadlinePressure > 0 )
      stressors.push({
        type: 'time_pressure',
        intensity: deadlinePressure,
        source: 'deadlines',
      })

    // Resource scarcity: low energy
    const energyLevel = this._energyLevel,
          energyMax   = 100,
          energyRatio = energyLevel / energyMax

    if( energyRatio < 0.3 )
      stressors.push({
        type: 'resource_scarcity',
        intensity: Math.min( 3, ( 0.3 - energyRatio ) * 15 ),
        source: 'energy',
      })

    // Sleep pressure as stressor
    const sleepPressure = this._sleepPressure
    if( sleepPressure > 40 )
      stressors.push({
        type: 'fatigue',
        intensity: Math.min( 3, ( sleepPressure / 100 ) * 5 ),
        source: 'sleep',
      })

    // Social evaluation: perceived judgment
    const socialThreat = state.metrics.get('social.evaluation_threat') ?? 0
    if( socialThreat > 0 )
      stressors.push({
        type: 'social_evaluation',
        intensity: Math.min( 2, socialThreat * 5 ),
        source: 'social',
      })

    // Uncertainty: novelty + low predictability
    const
    novelty    = this._noveltyScore,
    confidence = this._metacogConfidence,
    uncertainty = Math.min( 2, novelty * ( 1 - confidence ) * 5 )

    if( uncertainty > 0 )
      stressors.push({
        type: 'uncertainty',
        intensity: uncertainty,
        source: 'perception',
      })

    return stressors
  }

  private _getZone( load: number ): string {
    return load >= this._overloadThreshold  ? 'overload'
         : load >= this._distressThreshold ? 'distress'
         : load >= this._optimalThreshold  ? 'optimal'
         : 'low'
  }
}
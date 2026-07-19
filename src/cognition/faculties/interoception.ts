// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/interoception.ts
// ─────────────────────────────────────────────────────────────

/**
 * Interoception — monitors internal bodily and mental state.
 *
 * Produces a unified "how I feel right now" percept by aggregating:
 *   - Energy level
 *   - Sleep pressure
 *   - Stress load
 *   - Circadian phase
 *   - Active emotions (from affective layer, once built)
 *   - Cognitive load
 *
 * This is the mind's sense of its own body — the foundation for
 * subjective feeling states. Without interoception, emotions are
 * just numbers; with it, they become felt experiences.
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

export interface InteroceptionConfig {
  /** Metric keys to include in the interoceptive percept */
  monitoredMetrics?: string[]
  /** Whether to emit a detailed interoceptive event each tick */
  emitDetailEvent?: boolean
  bus?: CognitiveBus
}

interface InteroceptiveSignal {
  metric: string
  value: number
  interpretation: string
  intensity: number  // 0-1: how strongly this signal is felt
}

export class Interoception implements SimulationEngine, CognitiveEngine {
  readonly name     = 'interoception'
  
  private _monitoredMetrics: string[]
  private _emitDetailEvent: boolean

  // Signal history for change detection
  private _previousSignals = new Map<string, number>()

  private _energyLevel: number = 100
  private _sleepPressure: number = 0
  private _stressLoad: number = 0

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: InteroceptionConfig = {} ){
    this._bus = config.bus ?? null
    this._monitoredMetrics = config.monitoredMetrics ?? [
      'energy.level',
      'sleep.pressure',
      'stress.load',
      'circadian.alertness',
      'circadian.mood_baseline',
      'attention.usage',
      'cognitive.load',
    ]
    this._emitDetailEvent = config.emitDetailEvent ?? false
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ["energy.state.changed","sleep.state.changed","stress.state.changed","executive.prediction.formed"] }
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
      case 'stress.state.changed':
        this._stressLoad = (e.payload as Record<string,number>)['load'] ?? this._stressLoad
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('interoception') )
          this._model.setPrecision('interoception.intensity', 1.0 + p.confidence * 0.5 )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel: this._energyLevel,
      sleepPressure: this._sleepPressure,
      stressLoad: this._stressLoad,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], metrics: [] }

    const signals = this._readInternalState( state )

    // Nothing to report yet — metrics haven't been seeded by regulatory engines
    if( signals.length === 0 ) return { events: undefined, commands }

    const significantChanges = this._detectChanges( signals )

    // Build unified interoceptive percept
    const
    dominantSignal   = signals.reduce( ( best, s ) => s.intensity > best.intensity ? s : best, signals[0]! ),
    overallIntensity = signals.reduce( ( sum, s ) => sum + s.intensity, 0 ) / Math.max( signals.length, 1 ),
    comfortLevel     = this._computeComfort( signals )

    // intero.mood: integrated mood signal (0-1).
    // Blend of the direct circadian mood set-point and holistic homeostatic comfort.
    // Comfort dominates (0.65) because energy/sleep/stress drive moment-to-moment
    // mood more strongly than the slow-moving circadian baseline.
    const moodBaseline = signals.find( s => s.metric === 'circadian.mood_baseline')?.value ?? 0.5
    const interoMood   = moodBaseline * 0.35 + comfortLevel * 0.65

    // Percept entity — the unified "how I feel" snapshot
    commands.set!.push({
      id: `interoception-${tick}`,
      type:     'interoception',
      metadata: {
        tick,
        dominantSignal: dominantSignal.metric,
        dominantInterpretation: dominantSignal.interpretation,
        overallIntensity,
        comfort: comfortLevel,
        signals: signals.map( s => ({
          metric: s.metric,
          value: s.value,
          interpretation: s.interpretation,
          intensity: s.intensity,
        })),
      },
    })

    // Clean up old interoception entities
    commands.delete = this._collectStale( state, tick )

    // Metrics
    commands.metrics!.push(
      [ 'interoception.comfort',   comfortLevel ],
      [ 'interoception.intensity', overallIntensity ],
      [ 'intero.mood',             interoMood ],
    )

    // Events for significant internal state changes
    for( const change of significantChanges )
      events.push({
        type: 'interoception.change',
        source: this.name,
        payload: {
          metric: change.metric,
          previous: change.previous,
          current: change.current,
          interpretation: change.interpretation,
        },
      })

    // Optional detailed event (for debugging/observability)
    if( this._emitDetailEvent )
      events.push({
        type: 'interoception.detail',
        source: this.name,
        payload: { signals: signals.map( s => ({ ...s }) ) },
      })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus )
      _bus.publish({ type: 'interoception.state.updated', version: 1, sourceEngine: this.name, salience: Math.abs(comfortLevel - 0.5) * 0.8, payload: { comfort: comfortLevel, intensity: overallIntensity } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe('interoception.intensity', overallIntensity )
      if( !predErr.gated )
        _bus.publish({ type: 'interoception.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { comfort: comfortLevel, intensity: overallIntensity } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Read all monitored internal metrics and produce interpreted signals.
   */
  private _readInternalState( state: ReadonlySimulationState ): InteroceptiveSignal[] {
    const signals: InteroceptiveSignal[] = []

    for( const metric of this._monitoredMetrics ){
      const value = state.metrics.get( metric )
      if( value === undefined ) continue

      const interpretation = this._interpret( metric, value )
      const intensity = this._computeIntensity( metric, value )

      signals.push({ metric, value, interpretation, intensity })
    }

    return signals
  }

  /**
   * Interpret a metric value into a subjective description.
   */
  private _interpret( metric: string, value: number ): string {
    switch( metric ){
      case 'energy.level':
        return value < 10 ? 'exhausted'
             : value < 30 ? 'tired'
             : value < 50 ? 'low energy'
             : value < 70 ? 'energetic'
             : 'fully energized'

      case 'sleep.pressure':
        return value < 10 ? 'well-rested'
             : value < 30 ? 'slightly tired'
             : value < 50 ? 'fatigued'
             : value < 70 ? 'very tired'
             : 'exhausted'

      case 'stress.load':
        return value < 20 ? 'calm'
             : value < 40 ? 'slightly tense'
             : value < 60 ? 'stressed'
             : value < 80 ? 'very stressed'
             : 'overwhelmed'

      case 'circadian.alertness':
        return value < 0.3 ? 'groggy'
             : value < 0.5 ? 'drowsy'
             : value < 0.7 ? 'alert'
             : 'sharp'

      case 'circadian.mood_baseline':
        return value < 0.3 ? 'low mood'
             : value < 0.5 ? 'neutral'
             : value < 0.7 ? 'good mood'
             : 'elevated mood'

      case 'attention.usage':
        return value < 0.3 ? 'unfocused'
             : value < 0.6 ? 'moderately engaged'
             : value < 0.9 ? 'focused'
             : 'overloaded'

      case 'cognitive.load':
        return value < 0.3 ? 'idle'
             : value < 0.6 ? 'thinking'
             : value < 0.9 ? 'working hard'
             : 'overloaded'

      default:
        return `${metric}: ${value.toFixed( 2 )}`
    }
  }

  /**
   * Compute how intensely a signal is felt (deviation from comfort zone).
   */
  private _computeIntensity( metric: string, value: number ): number {
    switch( metric ){
      case 'energy.level':
        // Low energy is intensely felt; high energy is barely noticed
        return Math.max( 0, 1 - value / 100 )

      case 'sleep.pressure':
        // High pressure is intensely felt
        return value / 100

      case 'stress.load':
        // Moderate stress is moderate; extreme is intense
        return value < 30 ? value / 30 * 0.3
             : value < 60 ? 0.3 + ( value - 30 ) / 30 * 0.4
             : 0.7 + ( value - 60 ) / 40 * 0.3

      case 'circadian.alertness':
        // Low alertness is felt more than high alertness
        return Math.max( 0, 0.7 - value )

      case 'circadian.mood_baseline':
        // Deviation from neutral in either direction
        return Math.abs( value - 0.5 ) * 1.4

      case 'attention.usage':
        // Both underload and overload are felt
        return value < 0.3 ? 0.5 - value
             : value > 0.8 ? ( value - 0.8 ) * 2.5
             : 0.1

      case 'cognitive.load':
        return value

      default:
        return Math.min( 1, Math.abs( value ) )
    }
  }

  /**
   * Detect significant changes in internal signals since last tick.
   */
  private _detectChanges( signals: InteroceptiveSignal[] ): Array<{
    metric: string
    previous: number
    current: number
    interpretation: string
  }> {
    const changes: Array<{
      metric: string
      previous: number
      current: number
      interpretation: string
    }> = []

    for( const signal of signals ){
      const previous = this._previousSignals.get( signal.metric )

      if( previous !== undefined && Math.abs( signal.value - previous ) > 0.1 ){
        changes.push({
          metric: signal.metric,
          previous,
          current: signal.value,
          interpretation: signal.interpretation,
        })
      }

      this._previousSignals.set( signal.metric, signal.value )
    }

    return changes
  }

  /**
   * Compute overall comfort from all signals.
   * 1.0 = completely comfortable, 0.0 = deeply uncomfortable.
   */
  private _computeComfort( signals: InteroceptiveSignal[] ): number {
    if( signals.length === 0 ) return 0.5

    const weights: Record<string, number> = {
      'energy.level':      0.25,
      'sleep.pressure':    0.25,
      'stress.load':       0.30,
      'circadian.mood_baseline': 0.10,
      'attention.usage':   0.05,
      'cognitive.load':    0.05,
    }

    let weightedComfort = 0
    let totalWeight = 0

    for( const signal of signals ){
      const weight = weights[ signal.metric ] ?? 0.05
      totalWeight += weight

      // Map each metric to a comfort contribution (0-1)
      const comfort = this._metricToComfort( signal.metric, signal.value )
      weightedComfort += comfort * weight
    }

    return totalWeight > 0 ? weightedComfort / totalWeight : 0.5
  }

  private _metricToComfort( metric: string, value: number ): number {
    switch( metric ){
      case 'energy.level':       return value / 100
      case 'sleep.pressure':     return 1 - value / 100
      case 'stress.load':        return 1 - value / 100
      case 'circadian.alertness': return value
      case 'circadian.mood_baseline': return value
      case 'attention.usage':    return value > 0.8 ? 0.3 : value < 0.2 ? 0.4 : 0.8
      case 'cognitive.load':     return 1 - value
      default:                   return 0.5
    }
  }

  private _collectStale( state: ReadonlySimulationState, currentTick: Tick ): string[] {
    const stale: string[] = []
    for( const [ id, entity ] of state.entities ){
      if( entity.type === 'interoception' && typeof entity.metadata?.tick === 'number'){
        if( currentTick - entity.metadata.tick > 2 )
          stale.push( id )
      }
    }
    return stale
  }
}
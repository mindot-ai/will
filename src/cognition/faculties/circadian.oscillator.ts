// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/circadian.oscillator.ts
// ─────────────────────────────────────────────────────────────

/**
 * CircadianOscillator — maintains an internal biological clock.
 *
 * Produces a ~24-hour rhythm that modulates:
 *   - Energy baseline (lower at night)
 *   - Cognitive performance (peaks during day)
 *   - Sleep propensity (highest at night)
 *   - Mood baseline (varies with time of day)
 *
 * The oscillator can be entrained by external light/dark signals
 * and can drift if isolated (free-running period slightly > 24h).
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
  ModulationSignal,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

export type CircadianPhase = 'morning' | 'afternoon' | 'evening' | 'night'

export interface CircadianConfig {
  /** Period of the oscillator in hours (default 24.2 — free-running human) */
  periodHours?: number
  /** Phase offset in hours (shift the peak) */
  phaseOffsetHours?: number
  /** Whether external light signals entrain the oscillator */
  entrainable?: boolean
  /** Current simulated time of day in hours (0-24). If not provided, derived from tick. */
  timeOfDayHours?: number
  bus?: CognitiveBus
}

export class CircadianOscillator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'circadian-oscillator'
  
  private _periodHours: number
  private _phaseOffsetHours: number
  private _entrainable: boolean
  private _timeOfDayHours?: number

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: CircadianConfig = {} ){
    this._bus = config.bus ?? null
    this._periodHours      = config.periodHours      ?? 24.2
    this._phaseOffsetHours = config.phaseOffsetHours ?? 0
    this._entrainable      = config.entrainable      ?? true
    this._timeOfDayHours   = config.timeOfDayHours
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────


  subscribes(): string[] {
    return [
      'executive.prediction.formed'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('circadian') )
        this._model.setPrecision( 'circadian.alertness', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Determine current time of day
    let timeOfDay = this._timeOfDayHours

    if( timeOfDay === undefined ){
      // Derive from tick, assuming 1 tick = 1 second
      const totalSeconds = tick,
            totalHours   = totalSeconds / 3600,
            dayFraction  = ( totalHours % this._periodHours ) / this._periodHours

      timeOfDay = ( dayFraction * 24 + this._phaseOffsetHours ) % 24
    }

    // Entrain to external light if available and enabled
    if( this._entrainable ){
      const externalLight = state.metrics.get('environment.light_level')
      if( externalLight !== undefined ){
        const isSubjectiveNight = timeOfDay >= 21 || timeOfDay < 6
        if( isSubjectiveNight && externalLight > 0.5 )
          timeOfDay = ( timeOfDay + ( externalLight - 0.5 ) * 0.1 ) % 24 
      }
    }

    // Clamp and normalize
    timeOfDay = ( timeOfDay % 24 + 24 ) % 24

    // Compute circadian outputs — all sinusoidal with phase offsets
    const
    radians = ( timeOfDay / 24 ) * Math.PI * 2,

    // Core body temperature rhythm (peaks ~18:00, trough ~04:00)
    temperaturePhase  = radians - Math.PI * 0.75,
    temperatureSignal = Math.sin( temperaturePhase ),

    // Cognitive performance (peaks ~10:00-12:00, trough ~02:00-04:00)
    cognitivePhase    = radians - Math.PI * 0.25,
    cognitiveSignal   = Math.sin( cognitivePhase ),

    // Sleep propensity (peaks ~02:00-04:00, secondary peak ~14:00)
    sleepPhase        = radians - Math.PI * 0.5,
    sleepSignal       = ( Math.sin( sleepPhase ) + 1 ) / 2,  // Normalize 0-1

    // Melatonin proxy (rises at dusk, peaks ~02:00, falls at dawn)
    melatoninPhase    = radians - Math.PI * 0.45,
    melatoninSignal   = Math.max( 0, Math.sin( melatoninPhase ) ),

    // Alertness (peaks ~10:00, trough ~04:00)
    alertnessPhase    = radians - Math.PI * 0.3,
    alertnessSignal   = ( Math.sin( alertnessPhase ) + 1 ) / 2,

    // Mood baseline (peaks ~12:00-14:00, trough ~03:00)
    moodPhase         = radians - Math.PI * 0.35,
    moodSignal        = ( Math.sin( moodPhase ) + 1 ) / 2

    // Current phase label
    const phaseLabel: CircadianPhase = timeOfDay >= 6  && timeOfDay < 12 ? 'morning'
                                     : timeOfDay >= 12 && timeOfDay < 17 ? 'afternoon'
                                     : timeOfDay >= 17 && timeOfDay < 21 ? 'evening'
                                     : 'night'

    // Phase transition detection
    // state.metrics stores the previous phase as a numeric code for the
    // metric system (metrics are always numbers). We compare the label
    // against our own reconstruction.
    const
    previousPhaseCode = state.metrics.get('circadian.phase'),
    previousPhaseLabel: CircadianPhase | undefined
      = previousPhaseCode === 0 ? 'morning'
      : previousPhaseCode === 1 ? 'afternoon'
      : previousPhaseCode === 2 ? 'evening'
      : previousPhaseCode === 3 ? 'night'
      : undefined

    if( previousPhaseLabel !== undefined && previousPhaseLabel !== phaseLabel )
      events.push({
        type: `circadian.${phaseLabel}`,
        source: this.name,
        payload: { timeOfDay, phase: phaseLabel, previousPhase: previousPhaseLabel },
      })

    // Phase code for metric storage (metrics are numeric)
    const phaseCode = phaseLabel === 'morning' ? 0
                    : phaseLabel === 'afternoon' ? 1
                    : phaseLabel === 'evening' ? 2
                    : 3

    // Update circadian metrics
    commands.metrics!.push(
      [ 'circadian.time_of_day', timeOfDay ],
      [ 'circadian.phase', phaseCode ],
      [ 'circadian.temperature_phase', temperatureSignal ],
      [ 'circadian.cognitive_phase', cognitiveSignal ],
      [ 'circadian.sleep_propensity', sleepSignal ],
      [ 'circadian.melatonin', melatoninSignal ],
      [ 'circadian.alertness', alertnessSignal ],
      [ 'circadian.mood_baseline', moodSignal ],
    )

    // Modulation signals for other engines
    events.push({
      type: 'modulation.circadian_alertness',
      source: this.name,
      payload: {
        target: 'attention-allocator',
        parameter: 'capacity',
        factor: 0.7 + alertnessSignal * 0.6,
        source: this.name,
      } satisfies ModulationSignal,
    })

    events.push({
      type: 'modulation.circadian_cognitive',
      source: this.name,
      payload: {
        target: 'decision-engine',
        parameter: 'cognitive_phase',
        factor: 0.8 + cognitiveSignal * 0.4,
        source: this.name,
      } satisfies ModulationSignal,
    })

    events.push({
      type: 'modulation.circadian_sleep_propensity',
      source: this.name,
      payload: {
        target: 'sleep-pressure-regulator',
        parameter: 'sleep_gate',
        factor: sleepSignal,
        source: this.name,
      } satisfies ModulationSignal,
    })

    events.push({
      type: 'modulation.circadian_mood',
      source: this.name,
      payload: {
        target: 'affective-blender',
        parameter: 'mood_baseline',
        factor: moodSignal,
        source: this.name,
      } satisfies ModulationSignal,
    })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus )
      _bus.publish({ type: 'circadian.alertness.shifted', version: 1, sourceEngine: this.name, salience: Math.abs(alertnessSignal - 0.5) * 0.6, payload: { alertness: alertnessSignal, phase: phaseLabel } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe( 'circadian.alertness', alertnessSignal )
      if( !predErr.gated )
        _bus.publish({ type: 'circadian.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { alertness: alertnessSignal, timeOfDay, phaseCode, moodBaseline: moodSignal } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Config hot-reload ────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-circadian')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return

    if( p.periodHours      != null ) this._periodHours      = p.periodHours
    if( p.phaseOffsetHours != null ) this._phaseOffsetHours = p.phaseOffsetHours
    
    const entrainable = p.entrainable != null ? !!p.entrainable : undefined
    if( entrainable != null ) this._entrainable = entrainable
  }

  // ── Public helpers ───────────────────────────────────────

  /**
   * Set the current time of day explicitly (for scenarios with controlled time).
   */
  setTimeOfDay( hours: number ): void {
    this._timeOfDayHours = ( hours % 24 + 24 ) % 24
  }

  /**
   * Get the current circadian phase.
   */
  getPhase(): CircadianPhase {
    const h = this._timeOfDayHours ?? 12
    return h >= 6 && h < 12 ? 'morning'
         : h >= 12 && h < 17 ? 'afternoon'
         : h >= 17 && h < 21 ? 'evening'
         : 'night'
  }
}
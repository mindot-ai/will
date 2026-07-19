// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/sleep.pressure.regulator.ts
// ─────────────────────────────────────────────────────────────

/**
 * SleepPressureRegulator — accumulates sleep drive during wakefulness
 * and dissipates it during rest/sleep states.
 *
 * Models the two-process sleep model:
 *   - Process S: homeostatic sleep pressure (accumulates while awake)
 *   - Process C: circadian modulation (handled by CircadianOscillator)
 *
 * High sleep pressure degrades attention, working memory, and
 * decision quality via modulation signals.
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  DriveSignal,
  ModulationSignal,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

export interface SleepPressureConfig {
  /** Rate at which sleep pressure accumulates while awake (per second of sim time) */
  wakeAccumulationRate?: number
  /** Rate at which sleep pressure dissipates during rest (per second of sim time) */
  restDissipationRate?: number
  /** Maximum sleep pressure (saturation point) */
  maxPressure?: number
  /** Pressure threshold for cognitive degradation onset */
  fatigueThreshold?: number
  /** Pressure threshold for severe impairment */
  exhaustionThreshold?: number
  bus?: CognitiveBus
}

export class SleepPressureRegulator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'sleep-pressure-regulator'
  
  private _wakeAccumulationRate: number
  private _restDissipationRate: number
  private _maxPressure: number
  private _fatigueThreshold: number
  private _exhaustionThreshold: number

  private _wasSleeping: boolean = false

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: SleepPressureConfig = {} ){
    this._bus = config.bus ?? null
    this._wakeAccumulationRate = config.wakeAccumulationRate ?? 0.008
    this._restDissipationRate  = config.restDissipationRate  ?? 0.04
    this._maxPressure          = config.maxPressure          ?? 100
    this._fatigueThreshold     = config.fatigueThreshold     ?? 40
    this._exhaustionThreshold  = config.exhaustionThreshold  ?? 70
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────


  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'sleep.begun', version: 1, validate: () => null },
      { type: 'sleep.ended', version: 1, validate: () => null },
    ]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('interoception') )
        this._model.setPrecision('sleep.pressure', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    delta: Duration,
    _tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    const
    currentPressure = state.metrics.get('sleep.pressure') ?? 0,
    isResting       = state.metrics.get('state.resting') ?? 0,
    isSleeping      = state.metrics.get('state.sleeping') ?? 0,
    events:         Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands:       StateCommands = { metrics: [] }

    const deltaSeconds = delta / 1000
    let newPressure: number

    if( isSleeping > 0 ){
      // Deep rest — rapid dissipation
      newPressure = Math.max( 0, currentPressure - this._restDissipationRate * deltaSeconds * 2 )

      // Fully rested event
      if( currentPressure > 5 && newPressure <= 5 )
        events.push({
          type: 'sleep.fully_rested',
          source: this.name,
          payload: { pressure: newPressure },
        })
    }
    else if( isResting > 0 ){
      // Light rest — moderate dissipation
      newPressure = Math.max( 0, currentPressure - this._restDissipationRate * deltaSeconds )
    }
    else {
      // Awake — accumulate pressure
      // Accumulation accelerates as pressure builds (nonlinear fatigue)
      const pressureRatio  = currentPressure / this._maxPressure,
            acceleration   = 1 + pressureRatio * 1.5,
            accumulation   = this._wakeAccumulationRate * acceleration * deltaSeconds

      newPressure = Math.min( this._maxPressure, currentPressure + accumulation )

      // Fatigue onset event
      if( currentPressure < this._fatigueThreshold && newPressure >= this._fatigueThreshold )
        events.push({
          type: 'sleep.fatigue_onset',
          source: this.name,
          payload: { pressure: newPressure, threshold: this._fatigueThreshold },
        })

      // Exhaustion event
      if( currentPressure < this._exhaustionThreshold && newPressure >= this._exhaustionThreshold )
        events.push({
          type: 'sleep.exhaustion',
          source: this.name,
          payload: { pressure: newPressure, threshold: this._exhaustionThreshold },
        })
    }

    commands.metrics!.push([ 'sleep.pressure', newPressure ])

    // Drive signal
    const
    intensity = newPressure / this._maxPressure,
    urgency   = newPressure >= this._exhaustionThreshold
                  ? 1.0
                  : newPressure >= this._fatigueThreshold
                    ? ( newPressure - this._fatigueThreshold ) / ( this._exhaustionThreshold - this._fatigueThreshold )
                    : 0

    // Mirror drive intensity as a metric so GoalManager._activateFromDrives() can read it
    commands.metrics!.push([ 'drive.sleep', intensity ])

    events.push({
      type: 'drive.sleep',
      source: this.name,
      payload: {
        name: 'sleep',
        intensity,
        urgency,
        source: this.name,
      } satisfies DriveSignal,
    })

    // Modulation signals — degrade cognition proportionally to fatigue
    if( newPressure >= this._fatigueThreshold ){
      const fatigueRatio = ( newPressure - this._fatigueThreshold )
                         / ( this._maxPressure - this._fatigueThreshold )

      // Attention degradation
      events.push({
        type: 'modulation.attention_degradation',
        source: this.name,
        payload: {
          target: 'attention-allocator',
          parameter: 'capacity',
          factor: 1 - fatigueRatio * 0.5,
          source: this.name,
        } satisfies ModulationSignal,
      })

      // Working memory degradation
      events.push({
        type: 'modulation.working_memory_degradation',
        source: this.name,
        payload: {
          target: 'working-memory',
          parameter: 'capacity',
          factor: 1 - fatigueRatio * 0.6,
          source: this.name,
        } satisfies ModulationSignal,
      })

      // Decision quality degradation (affects LLM temperature or re-evaluation threshold)
      events.push({
        type: 'modulation.decision_quality_degradation',
        source: this.name,
        payload: {
          target: 'decision-engine',
          parameter: 'quality',
          factor: 1 - fatigueRatio * 0.4,
          source: this.name,
        } satisfies ModulationSignal,
      })
    }


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && newPressure > 70 )
      _bus.publish({ type: 'sleep.pressure.critical', version: 1, sourceEngine: this.name, salience: Math.max( 0.7, this._model.observe('sleep.critical', newPressure ).salience ), payload: { pressure: newPressure } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe('sleep.pressure', newPressure )
      if( !predErr.gated )
        _bus.publish({ type: 'sleep.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { pressure: newPressure, intensity } })
    }

    // Sleep transition events — fire once on edge, not every tick
    const nowSleeping = isSleeping > 0
    if( _bus ){
      if( !this._wasSleeping && nowSleeping )
        _bus.publish({ type: 'sleep.begun', version: 1, sourceEngine: this.name, salience: 0.8, payload: { pressure: newPressure } })
      else if( this._wasSleeping && !nowSleeping )
        _bus.publish({ type: 'sleep.ended', version: 1, sourceEngine: this.name, salience: 0.7, payload: { tick: _tick } })
    }
    this._wasSleeping = nowSleeping

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Config hot-reload ────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-sleep')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return
    
    if( p.wakeAccumulationRate != null ) this._wakeAccumulationRate = p.wakeAccumulationRate
    if( p.restDissipationRate  != null ) this._restDissipationRate  = p.restDissipationRate
    if( p.fatigueThreshold     != null ) this._fatigueThreshold     = p.fatigueThreshold
    if( p.exhaustionThreshold  != null ) this._exhaustionThreshold  = p.exhaustionThreshold
  }
}
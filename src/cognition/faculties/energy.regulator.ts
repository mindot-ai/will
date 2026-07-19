// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/energy.regulator.ts
// ─────────────────────────────────────────────────────────────

/**
 * EnergyRegulator — maintains the mind's energy pool.
 *
 * Energy decays continuously (cognitive work consumes resources).
 * It replenishes during rest states or when external replenishment
 * events occur. Depletion triggers hunger-like drive signals and
 * degrades cognitive performance via modulation.
 *
 * NEW: Enforces hard system collapse when energy drops below 1.
 * This is the biological equivalent of losing consciousness —
 * the body forces recovery regardless of the Will's decisions.
 * The forced rest state clears when energy recovers past 15.
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
 */

import { logger } from '#core/logger'
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
import { GenerativeModel, type GenerativeModelSnapshot } from '#cognition/generative.model'

export interface EnergyRegulatorConfig {
  maxEnergy?: number
  baseDecayRate?: number
  restReplenishRate?: number
  lowEnergyThreshold?: number
  criticalEnergyThreshold?: number
  /** Energy level below which the system forces unconscious recovery */
  collapseThreshold?: number
  /** Energy level at which forced recovery ends and consciousness returns */
  recoveryThreshold?: number
  bus?: CognitiveBus
}

// ── Cognitive metabolic cost ──────────────────────────────────────────────────
// Being awake costs energy; attending to more (cognitive load) and voluntarily
// engaging harder (effort) cost more. This is the continuous counterpart to the
// `focus` effector's one-shot energyCost — it makes sustained focus self-limiting
// against the energy pool, closing the attention→energy half of the homeostatic
// loop (energy already caps the AttentionAllocator's capacity ceiling). Both
// inputs are read from SimulationState metrics, so they need no engine snapshot.
const LOAD_DECAY_GAIN   = 0.5   // ×base decay per unit cognitive load (attention.usage, 0–1)
const EFFORT_DECAY_GAIN = 1.0   // ×base decay per unit effort above the homeostatic baseline
const EFFORT_BASELINE   = 0.7   // attention's homeostatic effort set-point — cost-neutral
                                // (mirrors EFFORT_BASELINE in attention.allocator.ts)

export class EnergyRegulator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'energy-regulator'
  
  private _maxEnergy: number
  private _baseDecayRate: number
  private _restReplenishRate: number
  private _lowThreshold: number
  private _criticalThreshold: number
  private _collapseThreshold: number
  private _recoveryThreshold: number

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: EnergyRegulatorConfig = {} ){
    this._bus = config.bus ?? null
    this._maxEnergy         = config.maxEnergy         ?? 100
    this._baseDecayRate     = config.baseDecayRate     ?? 0.02
    this._restReplenishRate = config.restReplenishRate ?? 0.15
    this._lowThreshold      = config.lowEnergyThreshold      ?? 30
    this._criticalThreshold = config.criticalEnergyThreshold ?? 10
    this._collapseThreshold = config.collapseThreshold ?? 1
    this._recoveryThreshold = config.recoveryThreshold ?? 15
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }


  subscribes(): string[] { return ["executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('energy') )
        this._model.setPrecision('energy.level', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> {
    // FN9: cognitive load + effort are now read from SimulationState metrics
    // (already captured by the event-sourced state), and the activity multiplier
    // is recomputed from them each tick — so the only durable engine-internal
    // state left to capture is the GenerativeModel prediction baseline.
    return { model: this._model.snapshot() }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return
    if( snap.model ) this._model.restore( snap.model as GenerativeModelSnapshot )
  }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    const
    currentEnergy  = state.metrics.get('energy.level') ?? this._maxEnergy,
    isResting      = state.metrics.get('state.resting') ?? 0,
    isSleeping     = state.metrics.get('state.sleeping') ?? 0,
    isForcedRest   = state.metrics.get('state.forced_rest') ?? 0,
    // Cognitive load (how much is being attended) and voluntary effort (how hard
    // the mind is engaging its capacity ceiling) are read straight from the
    // attention metrics. effort's homeostatic baseline is cost-neutral; focusing
    // above it burns the energy pool faster, standing down (rest) slower.
    cognitiveLoad  = state.metrics.get('attention.usage')  ?? 0,
    effort         = state.metrics.get('attention.effort') ?? EFFORT_BASELINE,
    events:        Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands:      StateCommands = { metrics: [] }

    // Metabolic cost of cognition: cognitive load and sustained effort both raise
    // the rate at which being awake drains energy. Clamped ≥ 0.5 so a calm, idle
    // mind still ticks down at roughly half the base rate.
    const activityMultiplier = Math.max(
      0.5,
      1.0 + cognitiveLoad * LOAD_DECAY_GAIN + ( effort - EFFORT_BASELINE ) * EFFORT_DECAY_GAIN
    )

    let newEnergy: number

    // ── Forced rest (system collapse) — guaranteed recovery ──
    if( isForcedRest > 0 || currentEnergy < this._collapseThreshold ){
      // Body is forcing recovery. Energy always increases during forced rest.
      // This is stronger than normal rest — the system is unconscious.
      newEnergy = Math.min(
        this._maxEnergy,
        currentEnergy + this._restReplenishRate * 1.5 * ( delta / 1000 )
      )

      // Ensure forced_rest stays set
      commands.metrics!.push([ 'state.forced_rest', 1 ])
      commands.metrics!.push([ 'state.resting', 1 ])

      // Clear forced rest when recovered past the recovery threshold
      if( newEnergy >= this._recoveryThreshold ){
        commands.metrics!.push([ 'state.forced_rest', 0 ])
        commands.metrics!.push([ 'state.resting', 0 ])

        events.push({
          type: 'energy.consciousness_regained',
          source: this.name,
          payload: { energy: newEnergy, recoveryThreshold: this._recoveryThreshold },
        })
      }

      // Periodic log during forced rest
      if( tick % 100 === 0 ){
        logger.info(`[energy] forced recovery — unconscious (energy=${newEnergy.toFixed(0)}, target=${this._recoveryThreshold})`)
      }
    }
    // ── Voluntary rest or sleep ─────────────────────────────
    else if( isSleeping > 0 ){
      // Deep rest — rapid dissipation
      newEnergy = Math.min(
        this._maxEnergy,
        currentEnergy + this._restReplenishRate * 2 * ( delta / 1000 )
      )

      if( currentEnergy < this._maxEnergy * 0.5 && newEnergy >= this._maxEnergy * 0.8 )
        events.push({
          type: 'energy.replenished',
          source: this.name,
          payload: { previous: currentEnergy, current: newEnergy },
        })
    }
    else if( isResting > 0 ){
      // Light rest — moderate dissipation
      newEnergy = Math.min(
        this._maxEnergy,
        currentEnergy + this._restReplenishRate * ( delta / 1000 )
      )

      if( currentEnergy < this._maxEnergy * 0.5 && newEnergy >= this._maxEnergy * 0.8 )
        events.push({
          type: 'energy.replenished',
          source: this.name,
          payload: { previous: currentEnergy, current: newEnergy },
        })
    }
    else {
      // Awake — accumulate pressure
      const decay = this._baseDecayRate * activityMultiplier * ( delta / 1000 )
      const passiveRecovery = currentEnergy <= this._criticalThreshold
        ? this._baseDecayRate * 0.5 * ( delta / 1000 )
        : 0
      newEnergy = Math.max( 0, currentEnergy - decay + passiveRecovery )

      // ── System collapse event ───────────────────────────
      if( currentEnergy > this._collapseThreshold && newEnergy <= this._collapseThreshold ){
        events.push({
          type: 'energy.system_collapse',
          source: this.name,
          payload: {
            energy: newEnergy,
            reason: 'Energy depleted below critical threshold. Body forcing recovery.',
            collapseThreshold: this._collapseThreshold,
          },
        })

        // Immediately enter forced rest
        commands.metrics!.push([ 'state.forced_rest', 1 ])
        commands.metrics!.push([ 'state.resting', 1 ])
      }

      // Critical depletion event
      if( currentEnergy > this._criticalThreshold && newEnergy <= this._criticalThreshold )
        events.push({
          type: 'energy.critical',
          source: this.name,
          payload: { level: newEnergy, threshold: this._criticalThreshold },
        })
    }

    // Clamp and store
    newEnergy = Math.max( 0, Math.min( this._maxEnergy, newEnergy ) )
    commands.metrics!.push([ 'energy.level', newEnergy ])

    // ── Drive signal ──────────────────────────────────────
    const
    energyRatio = newEnergy / this._maxEnergy,
    intensity   = 1 - energyRatio,
    urgency     = newEnergy <= this._criticalThreshold
                    ? 1.0
                    : newEnergy <= this._lowThreshold
                      ? ( this._lowThreshold - newEnergy ) / ( this._lowThreshold - this._criticalThreshold )
                      : 0

    const driveIntensity = Math.min( 1, Math.max( 0, intensity ) )
    commands.metrics!.push([ 'drive.energy', driveIntensity ])

    events.push({
      type: 'drive.energy',
      source: this.name,
      payload: {
        name: 'energy',
        intensity: driveIntensity,
        urgency:   Math.min( 1, Math.max( 0, urgency ) ),
        source:    this.name,
      } satisfies DriveSignal,
    })

    // ── Modulation signals ────────────────────────────────
    // Don't modulate during forced rest — the system is unconscious
    if( isForcedRest === 0 && newEnergy <= this._lowThreshold ){
      const degradationFactor = Math.max(
        0.3,
        1 - ( ( this._lowThreshold - newEnergy ) / this._lowThreshold ) * 0.7
      )

      events.push({
        type: 'modulation.cognitive_degradation',
        source: this.name,
        payload: {
          target: '*',
          parameter: 'energy_degradation',
          factor: degradationFactor,
          source: this.name,
        } satisfies ModulationSignal,
      })
    }


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && newEnergy < 20 )
      _bus.publish({ type: 'energy.level.critical', version: 1, sourceEngine: this.name, salience: Math.max( 0.8, this._model.observe('energy.critical', 1 - newEnergy / 100 ).salience ), payload: { level: newEnergy } })
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const zoneCode = newEnergy < this._criticalThreshold ? 0 : newEnergy < this._lowThreshold ? 1 : 2
      const predErr  = this._model.observe('energy.level', newEnergy )
      if( !predErr.gated )
        _bus.publish({ type: 'energy.state.changed', version: 1, sourceEngine: this.name, salience: predErr.salience, payload: { level: newEnergy, zoneCode, stressLoad: state.metrics.get('stress.load') ?? 0, interoceptionComfort: state.metrics.get('interoception.comfort') ?? 0.5 } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Config hot-reload ────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-energy')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return
    
    if( p.baseDecayRate         != null ) this._baseDecayRate     = p.baseDecayRate
    if( p.restReplenishRate     != null ) this._restReplenishRate = p.restReplenishRate
    if( p.lowEnergyThreshold    != null ) this._lowThreshold      = p.lowEnergyThreshold
    if( p.criticalEnergyThreshold != null ) this._criticalThreshold = p.criticalEnergyThreshold
    if( p.collapseThreshold     != null ) this._collapseThreshold = p.collapseThreshold
    if( p.recoveryThreshold     != null ) this._recoveryThreshold = p.recoveryThreshold
  }
}
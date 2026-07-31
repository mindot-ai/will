// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/threat.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * ThreatEvaluator — assesses danger across multiple dimensions.
 *
 * Evaluates:
 *   - Hostile entities (entities marked as threatening)
 *   - Resource scarcity (low energy, time pressure)
 *   - Uncertainty (high novelty, low predictability)
 *   - Social rejection risk (negative social signals directed at self)
 *
 * Produces: fear, anxiety, vigilance
 *
 * Fear = immediate, identifiable threat
 * Anxiety = diffuse, uncertain threat
 * Vigilance = heightened alertness in response to elevated threat level
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

import type {
  StateCommands,
  Duration,
  Tick,
  ReadonlySimulationState,
  SimulationContext,
} from '#core/types'
import type { EngineResult } from '#core/orchestrator'
import type { SimulationEngine, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface ThreatEvaluatorConfig {
  /** Weight for hostile entity threats */
  hostileWeight?: number
  /** Weight for resource scarcity threats */
  scarcityWeight?: number
  /** Weight for uncertainty threats */
  uncertaintyWeight?: number
  /** Weight for social rejection threats */
  socialWeight?: number
  /** Threshold above which fear triggers a significant event */
  fearEventThreshold?: number
  bus?: CognitiveBus
}

export class ThreatEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'threat-evaluator'
  
  private _hostileWeight: number
  private _scarcityWeight: number
  private _uncertaintyWeight: number
  private _socialWeight: number
  private _fearEventThreshold: number

  // Domain state — updated per-event
  private _energyLevel: number = 100
  private _sleepPressure: number = 0
  private _stressLoad: number = 0
  private _deadlineUrgency: number = 0
  private _cognitiveLoad: number = 0
  private _cachedNovelty: number = 0
  private _cachedMetacognitionConfidence: number = 0.7
  private _socialEvaluationThreat: number = 0
  private _activeAgents: number = 0

  // Cached component threats — accumulated across events
  private _threatFromHostile: number = 0      // updated only if entity events are added
  private _threatFromScarcity: number = 0
  private _threatFromUncertainty: number = 0
  private _threatFromSocial: number = 0

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()


  constructor( config: ThreatEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._hostileWeight      = config.hostileWeight      ?? 0.35
    this._scarcityWeight     = config.scarcityWeight     ?? 0.25
    this._uncertaintyWeight  = config.uncertaintyWeight  ?? 0.20
    this._socialWeight       = config.socialWeight       ?? 0.20
    this._fearEventThreshold = config.fearEventThreshold ?? 0.6
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ["energy.state.changed","sleep.state.changed","stress.state.changed","novelty.state.changed","metacognition.state.changed","executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){

      case 'energy.state.changed': {
        const p = e.payload as { level: number }
        this._energyLevel = p.level ?? this._energyLevel
        this._threatFromScarcity = this._computeScarcityThreat()
        break
      }

      case 'sleep.state.changed': {
        const p = e.payload as { pressure: number }
        this._sleepPressure = p.pressure ?? this._sleepPressure
        this._threatFromScarcity = this._computeScarcityThreat()
        break
      }

      case 'stress.state.changed': {
        const p = e.payload as { load: number; deadlineUrgency: number; cognitiveLoad: number }
        this._stressLoad        = p.load            ?? this._stressLoad
        this._deadlineUrgency   = p.deadlineUrgency ?? this._deadlineUrgency
        this._cognitiveLoad     = p.cognitiveLoad   ?? this._cognitiveLoad
        this._threatFromScarcity    = this._computeScarcityThreat()
        this._threatFromUncertainty = this._computeUncertaintyThreat()
        break
      }

      case 'novelty.state.changed': {
        const p = e.payload as { novelty: number; socialEvaluationThreat: number; activeAgents: number; fearLevel: number }
        this._cachedNovelty             = p.novelty              ?? this._cachedNovelty
        this._socialEvaluationThreat    = p.socialEvaluationThreat ?? this._socialEvaluationThreat
        this._activeAgents              = p.activeAgents          ?? this._activeAgents
        this._threatFromUncertainty = this._computeUncertaintyThreat()
        this._threatFromSocial      = this._computeSocialThreat()
        break
      }

      case 'metacognition.state.changed': {
        const p = e.payload as { confidence: number }
        this._cachedMetacognitionConfidence = p.confidence ?? this._cachedMetacognitionConfidence
        this._threatFromUncertainty = this._computeUncertaintyThreat()
        break
      }

      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('social') )
          this._model.setPrecision('threat.level', 1.0 + p.confidence * 0.4)
        break
      }

      default:
        return
    }

    return this._computeAndEmit()
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel:   this._energyLevel,
      sleepPressure: this._sleepPressure,
      stressLoad:    this._stressLoad,
    }
  }

  // ── React (state scan) ────────────────────────────────────

  /**
   * Scans state each tick for active hostile entities (type === 'threat',
   * metadata.hostile === true). Updates _threatFromHostile and re-emits
   * the full threat/emotion metrics so that downstream engines always see
   * a current picture even when no bus event arrives.
   *
   * `threat` is a HOST SEAM, not a starved input (#114). No core engine writes
   * one — appraisal runs entirely off this engine's six bus inputs (energy,
   * sleep, stress, novelty, metacognition, prediction), all of which are live.
   * A host embedding a Will in a world with actual hostile agents writes `threat`
   * entities to make them felt. Empty here means nothing is hostile, not that
   * nothing is wired.
   */
  async react(
    _delta:   Duration,
    _tick:    Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    // Channel A (emotional-stability): how much threat it takes to fire a significant-fear
    // event is refreshed each tick as base ⊕ persona-prior, so a steadier Will develops a
    // HIGHER threshold and is less easily alarmed. _computeAndEmit (no `state`) reads the
    // cached field. (The seed entity existed but was ignored before.)
    this._fearEventThreshold = readEffectiveParams( state, 'engine-config-threat').fearEventThreshold ?? this._fearEventThreshold

    // Recompute hostile threat from state entities every tick
    let maxHostile = 0
    for( const entity of state.entities.values() ){
      if( entity.type !== 'threat') continue
      if( entity.metadata?.active === false )  continue
      if( !entity.metadata?.hostile )          continue
      const intensity = typeof entity.metadata?.intensity === 'number'
        ? entity.metadata.intensity as number
        : 0.5
      if( intensity > maxHostile ) maxHostile = intensity
    }
    this._threatFromHostile = maxHostile

    const commands = this._computeAndEmit()
    return { commands }
  }

  // ── Private helpers ──────────────────────────────────────

  private _computeScarcityThreat(): number {
    const
    energyThreat  = Math.max( 0, 1 - this._energyLevel / ( 100 * 0.3 ) ),
    timeThreat    = this._deadlineUrgency,
    sleepThreat   = this._sleepPressure > 70 ? ( this._sleepPressure - 70 ) / 30 : 0

    return Math.min( 1,
      energyThreat * 0.4
      + timeThreat  * 0.35
      + sleepThreat * 0.25
    )
  }

  private _computeUncertaintyThreat(): number {
    const
    novelty          = this._cachedNovelty,
    confidence       = this._cachedMetacognitionConfidence,
    unpredictability = novelty * ( 1 - confidence ),
    cognitiveLoad    = this._cognitiveLoad

    return Math.min( 1,
      unpredictability * 0.6
      + ( cognitiveLoad > 0.8 ? 0.3 : 0 )
      + ( novelty > 0.7 ? 0.1 : 0 )
    )
  }

  private _computeSocialThreat(): number {
    const
    evaluationThreat = this._socialEvaluationThreat,
    socialIsolation  = this._activeAgents < 1 ? 0.4 : 0

    return Math.min( 1,
      evaluationThreat * 0.5
      + socialIsolation * 0.15
    )
  }

  private _computeAndEmit(): StateCommands {
    const
    hostileThreat     = this._threatFromHostile,
    scarcityThreat    = this._threatFromScarcity,
    uncertaintyThreat = this._threatFromUncertainty,
    socialThreat      = this._threatFromSocial

    const threatLevel
      = hostileThreat     * this._hostileWeight
      + scarcityThreat    * this._scarcityWeight
      + uncertaintyThreat * this._uncertaintyWeight
      + socialThreat      * this._socialWeight

    const
    fear = Math.min( 1,
      hostileThreat * 0.7
      + socialThreat * 0.2
      + ( scarcityThreat > 0.7 ? 0.1 : 0 )
    ),

    anxiety = Math.min( 1,
      uncertaintyThreat * 0.5
      + ( threatLevel - fear ) * 0.5
      + ( socialThreat > 0.3 && hostileThreat < 0.4 ? 0.3 : 0 )
    ),

    vigilance = Math.min( 1, threatLevel * 1.2 )

    const commands: StateCommands = { metrics: [] }

    commands.metrics!.push(
      [ 'emotion.fear',        fear ],
      [ 'emotion.anxiety',     anxiety ],
      [ 'emotion.vigilance',   vigilance ],
      [ 'threat.level',        threatLevel ],
      [ 'threat.hostile',      hostileThreat ],
      [ 'threat.scarcity',     scarcityThreat ],
      [ 'threat.uncertainty',  uncertaintyThreat ],
      [ 'threat.social',       socialThreat ],
    )

    const _bus = this._bus
    if( _bus ){
      // Option B (predictive-processing): event salience is surprise × precision,
      // not raw magnitude. A CHANGE in threat grabs the workspace; a steady threat
      // habituates (its level still rides the executive's standing context — see
      // worldState.threatLevel). observe() runs every tick so the baseline tracks
      // and the executive's top-down precision (set on 'threat.level') applies;
      // the one value is reused across the tiered events.
      const threatSalience = this._model.observe('threat.level', threatLevel ).salience

      if( fear > 0.4 )
        _bus.publish({ type: 'emotion.fear.elevated', version: 1, sourceEngine: this.name, salience: threatSalience, payload: { fear } })
      if( fear > this._fearEventThreshold )
        _bus.publish({
          type: 'emotion.fear.significant', version: 1, sourceEngine: this.name,
          salience: threatSalience,
          payload: {
            fear, anxiety, vigilance, threatLevel,
            dominantThreat: hostileThreat > scarcityThreat
              ? ( hostileThreat > socialThreat ? 'hostile' : 'social')
              : ( scarcityThreat > uncertaintyThreat ? 'scarcity' : 'uncertainty'),
          },
        })
      if( anxiety > 0.7 )
        _bus.publish({ type: 'emotion.anxiety.elevated', version: 1, sourceEngine: this.name, salience: threatSalience, payload: { anxiety, uncertaintyThreat } })
    }

    return commands
  }
}
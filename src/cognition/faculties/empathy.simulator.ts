// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/empathy.simulator.ts
// ─────────────────────────────────────────────────────────────

/**
 * EmpathySimulator — simulates what another agent is feeling.
 *
 * Uses TheoryOfMind models plus observed social signals to estimate
 * another agent's emotional state. Produces empathic responses:
 *   - Emotional resonance (feeling what they feel)
 *   - Compassionate concern (wanting to help if they're distressed)
 *   - Empathic accuracy (how well the simulation matches reality)
 *
 * Part of Shard 1 (Social Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { AgentMentalModel, TheoryOfMind } from '#faculties/theory.of.mind'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

// Closeness amplifies emotion contagion — the Will resonates more with those it is bonded
// to. Scales the attachment bond (0..1, from the `bond-<keid>` entity) into the weight.
const EMPATHY_BOND_AMPLIFY = 0.5

export interface EmpathySimulatorConfig {
  /** How strongly another's emotion resonates (0-1) */
  resonanceStrength?: number
  /** Threshold for triggering compassionate response */
  compassionThreshold?: number
  bus?: CognitiveBus
}

interface EmpathicState {
  targetKeid: string
  estimatedEmotion: { valence: number; arousal: number; dominantEmotion: string }
  resonanceStrength: number    // How strongly this resonates
  compassionateConcern: number // 0-1: desire to help
  confidence: number           // How accurate the estimate is
}

export class EmpathySimulator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'empathy-simulator'
  
  private _resonanceStrength: number
  private _compassionThreshold: number

  private _theoryOfMind: TheoryOfMind | null = null
  private _currentEmpathicStates: EmpathicState[] = []
  private _pendingInteractions: Array<{
    keid: string; valence: number; intensity: number; directedAtSelf: boolean
  }> = []

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: EmpathySimulatorConfig = {} ){
    this._bus = config.bus ?? null
    this._resonanceStrength   = config.resonanceStrength   ?? 0.6
    this._compassionThreshold = config.compassionThreshold ?? 0.3
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  attachTheoryOfMind( tom: TheoryOfMind ): void {
    this._theoryOfMind = tom
  }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'interaction.occurred',
    ]
  }

  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('social') )
        this._model.setPrecision('empathy.active', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'interaction.occurred'){
      const p = e.payload as { keid: string; valence: number; intensity: number; directedAtSelf: boolean }
      if( p.keid && p.keid !== 'agent-self')
        this._pendingInteractions.push( p )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], metrics: [] }

    // Channel A (agreeableness → empathy): how strongly the Will resonates with others'
    // emotions is refreshed each tick as base ⊕ persona-prior. An agreeable Will develops
    // a higher resonance and feels others' states more. (Seed existed but was ignored.)
    this._resonanceStrength = readEffectiveParams( state, 'engine-config-empathy').resonanceStrength ?? this._resonanceStrength

    if( !this._theoryOfMind ){
      commands.metrics!.push([ 'empathy.active_models', 0 ])
      return { commands }
    }

    const empathicStates: EmpathicState[] = []
    let totalResonance = 0
    let totalCompassion = 0

    // Drain buffered interactions and simulate empathic response per agent
    for( const interaction of this._pendingInteractions.splice( 0 ) ){
      const { keid, valence: socialValence, directedAtSelf } = interaction

      const tomModel = this._theoryOfMind.getModel( keid )

      const estimatedEmotion = this._estimateEmotion( socialValence, tomModel )

      const resonance = directedAtSelf
        ? this._resonanceStrength * 1.5
        : this._resonanceStrength

      const compassion = estimatedEmotion.valence < -this._compassionThreshold
        ? Math.abs( estimatedEmotion.valence ) * resonance
        : 0

      const entry: EmpathicState = {
        targetKeid: keid,
        estimatedEmotion,
        resonanceStrength: resonance,
        compassionateConcern: compassion,
        confidence: tomModel?.modelConfidence ?? 0.3,
      }

      empathicStates.push( entry )
      totalResonance += resonance
      totalCompassion += compassion
    }

    this._currentEmpathicStates = empathicStates

    // Persist
    for( const es of empathicStates ){
      commands.set!.push({
        id: `empathy-${es.targetKeid}`,
        type:     'empathic_state',
        metadata: {
          targetKeid: es.targetKeid,
          estimatedValence: es.estimatedEmotion.valence,
          estimatedArousal: es.estimatedEmotion.arousal,
          estimatedDominantEmotion: es.estimatedEmotion.dominantEmotion,
          resonance: es.resonanceStrength,
          compassion: es.compassionateConcern,
          confidence: es.confidence,
          tick,
        },
      })
    }

    // Emotion contagion — the integration that makes empathy MOVE the Will. Each agent's
    // inferred emotion pulls the Will's own affect toward it, weighted by resonance (#24,
    // agreeableness-developable) and amplified by closeness (attachment bond). affective.
    // blender folds the vicarious valence/arousal into the blended PAD.
    let vicariousValence = 0, vicariousArousal = 0
    for( const es of empathicStates ){
      const bond = ( state.entities.get(`bond-${es.targetKeid}`)?.metadata?.attachmentStrength as number ) ?? 0
      const w = es.resonanceStrength * ( 1 + EMPATHY_BOND_AMPLIFY * bond )
      vicariousValence += es.estimatedEmotion.valence * w
      vicariousArousal += es.estimatedEmotion.arousal * w
    }
    if( empathicStates.length > 0 ){
      vicariousValence = Math.max( -1, Math.min( 1, vicariousValence / empathicStates.length ) )
      vicariousArousal = Math.max( 0, Math.min( 1, vicariousArousal / empathicStates.length ) )
    }

    commands.metrics!.push(
      [ 'empathy.active_models', empathicStates.length ],
      [ 'empathy.total_resonance', Math.min( 1, totalResonance ) ],
      [ 'empathy.total_compassion', Math.min( 1, totalCompassion ) ],
      [ 'empathy.vicarious_valence', vicariousValence ],
      [ 'empathy.vicarious_arousal', vicariousArousal ],
    )

    // Compassion event
    if( totalCompassion > 0.5 )
      events.push({
        type: 'empathy.compassion_activated',
        source: this.name,
        payload: {
          targets: empathicStates
            .filter( s => s.compassionateConcern > 0.3 )
            .map( s => s.targetKeid ),
        },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && empathicStates.length > 0 ){
      const predErr = this._model.observe('empathy.active', empathicStates.length )
      if( !predErr.gated )
        _bus.publish({ type: 'empathy.resonance', version: 1, sourceEngine: this.name, salience: Math.max( 0.3, predErr.salience ), payload: { activeModels: empathicStates.length } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  private _estimateEmotion(
    socialValence: number,
    tomModel?: AgentMentalModel
  ): { valence: number; arousal: number; dominantEmotion: string } {
    // Start with ToM model estimate if available
    if( tomModel && tomModel.modelConfidence > 0.3 )
      return tomModel.emotionalState

    // Otherwise estimate from social valence
    return {
      valence: socialValence,
      arousal: Math.abs( socialValence ) > 0.5 ? 0.7 : 0.3,
      dominantEmotion: socialValence > 0.3 ? 'positive'
                     : socialValence < -0.3 ? 'distressed'
                     : 'neutral',
    }
  }

  /**
   * Get current empathic states.
   */
  getEmpathicStates(): ReadonlyArray<EmpathicState> {
    return this._currentEmpathicStates
  }
}
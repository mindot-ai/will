// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/inhibition.controller.ts
// ─────────────────────────────────────────────────────────────

/**
 * InhibitionController — suppresses prepotent responses and delays
 * gratification.
 *
 * Functions as a somatic veto:
 *   - Monitors pending decision.record entities queued for execution
 *   - Evaluates them against affective state and long-term goals
 *   - Vetoes actions that are impulsive, risky, or misaligned
 *   - Implements gratification delay (can defer actions to future ticks)
 *
 * This engine is the "pause between impulse and action."
 * It integrates with the Orchestrator's CommitValidator system
 * to block commands before they're applied.
 *
 * Modulated by:
 *   - Stress (overload disinhibits — impulsive actions get through)
 *   - Sleep pressure (fatigue reduces inhibition)
 *   - Energy (low energy reduces inhibition capacity)
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
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

export interface InhibitionControllerConfig {
  /** Base inhibition strength (0-1, higher = more veto power) */
  baseInhibitionStrength?: number
  /** Threshold above which affective arousal triggers inhibition check */
  arousalThreshold?: number
  /** Maximum actions that can be deferred per tick */
  maxDeferralsPerTick?: number
  bus?: CognitiveBus
}

/** Communication effectors are never deferred — replies must be immediate. */
const COMMUNICATION_EFFECTORS = new Set([ 'talk', 'text', 'listen', 'gesture', 'broadcast' ])

interface DeferredAction {
  actionType: string
  metadata: Record<string, unknown> | undefined
  deferredUntil: Tick
  reason: string
}

export class InhibitionController implements SimulationEngine, CognitiveEngine {
  readonly name     = 'inhibition-controller'
  
  private _baseInhibitionStrength: number
  private _inhibitionStrength: number   // effective value, scaled by cross-reads each tick
  private _arousalThreshold: number
  private _maxDeferralsPerTick: number

  private _deferredActions: DeferredAction[] = []

  private _energyLevel: number = 100
  private _sleepPressure: number = 0
  private _stressLoad: number = 0
  private _executiveConfidence: number = 0.5

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: InhibitionControllerConfig = {} ){
    this._bus = config.bus ?? null
    this._baseInhibitionStrength = config.baseInhibitionStrength ?? 0.6
    this._inhibitionStrength     = this._baseInhibitionStrength
    this._arousalThreshold       = config.arousalThreshold       ?? 0.6
    this._maxDeferralsPerTick    = config.maxDeferralsPerTick    ?? 3
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-inhibition ⊕ persona-prior (single-source).
    // The persona-consolidator raises baseInhibitionStrength when reasoning bias
    // recurs (edge 6) → more self-restraint while the bias is being worked through.
    const p = readEffectiveParams( state, 'engine-config-inhibition')
    if( p.baseInhibitionStrength != null ) this._baseInhibitionStrength = p.baseInhibitionStrength
    if( p.arousalThreshold       != null ) this._arousalThreshold       = p.arousalThreshold
    if( p.maxDeferralsPerTick    != null ) this._maxDeferralsPerTick    = p.maxDeferralsPerTick

    // Cross-read: longer executive gap → slightly relax inhibition (fewer cycles to course-correct)
    const orbCfg = state.entities.get('engine-config-executive')
    const orbInterval = ( orbCfg?.metadata?.params as Record<string, number> | undefined )?.executiveInterval
    this._inhibitionStrength = orbInterval != null
      ? this._baseInhibitionStrength * ( 30 / Math.max( 30, orbInterval ) )
      : this._baseInhibitionStrength
  }


  subscribes(): string[] { return ["energy.state.changed","sleep.state.changed","stress.state.changed","executive.interpretation.formed","executive.prediction.formed"] }
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
      case 'executive.interpretation.formed': {
        // High executive confidence → relax veto (executive reasoned through it)
        // Low confidence → tighten veto (more caution under uncertainty)
        const confidence = (e.payload as Record<string,number>)['confidence'] ?? 0.5
        this._executiveConfidence = confidence
        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('executive') )
          this._model.setPrecision('inhibition.strength', 1.0 + p.confidence * 0.5 )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel: this._energyLevel,
      sleepPressure: this._sleepPressure,
      stressLoad: this._stressLoad,
      executiveConfidence: this._executiveConfidence,
    }
  }

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

    // 1. Compute effective inhibition strength (modulated by state)
    const inhibitionStrength = this._computeEffectiveInhibition( state )

    // 2. Scan pending decision records for veto evaluation
    const vetoedActions: string[] = []
    const deferredActions: string[] = []

    for( const entity of state.entities.values() ){
      if( entity.type !== 'decision.record') continue

      const
      actionType = entity.metadata?.actionType as string,
      confidence = ( entity.metadata?.confidence as number ) ?? 0.5,
      arousal    = state.metrics.get('affect.arousal') ?? 0.3,
      valence    = state.metrics.get('affect.valence') ?? 0

      // Communication actions are never deferred — replies must be immediate
      if( COMMUNICATION_EFFECTORS.has( actionType ) ) continue

      // Veto check: low confidence + high arousal + negative valence
      if( confidence < 0.3 && arousal > this._arousalThreshold && valence < -0.3 ){
        vetoedActions.push( actionType )
        commands.delete = [ ...(commands.delete ?? []), entity.id ]
        continue
      }

      // Veto check: action contradicts active goals
      if( this._contradictsActiveGoals( actionType, state ) ){
        vetoedActions.push( actionType )
        commands.delete = [ ...(commands.delete ?? []), entity.id ]
        continue
      }

      // Defer check: high arousal but not enough to veto — delay
      if( arousal > this._arousalThreshold && inhibitionStrength > 0.5 && deferredActions.length < this._maxDeferralsPerTick ){
        this._deferredActions.push({
          actionType,
          metadata: entity.metadata as Record<string, unknown> | undefined,
          deferredUntil: tick + 10,
          reason: 'High arousal — deferring for cooling-off',
        })
        deferredActions.push( actionType )
        commands.delete = [ ...(commands.delete ?? []), entity.id ]
      }
    }

    // 3. Release deferred actions whose time has come
    const dueDeferrals = this._deferredActions.filter( d => d.deferredUntil <= tick )
    for( const deferred of dueDeferrals ){
      commands.set ??= []
      commands.set.push({
        id: `deferred-action-${deferred.actionType}-${tick}`,
        type:     'decision.record',
        metadata: {
          ...deferred.metadata,
          actionType: deferred.actionType,
          wasDeferred: true,
          deferredReason: deferred.reason,
          tick,
        },
      })
    }
    this._deferredActions = this._deferredActions.filter( d => d.deferredUntil > tick )

    // 4. Purge decision.record entities older than 30 ticks
    const staleDecisions: string[] = []
    for( const [ id, entity ] of state.entities ){
      if( entity.type === 'decision.record' && typeof entity.metadata?.tick === 'number'){
        if( tick - entity.metadata.tick > 30 )
          staleDecisions.push( id )
      }
    }
    if( staleDecisions.length > 0 )
      commands.delete = [ ...( commands.delete ?? [] ), ...staleDecisions ]

    // 5. Metrics
    commands.metrics!.push(
      [ 'inhibition.strength', inhibitionStrength ],
      [ 'inhibition.vetoed', vetoedActions.length ],
      [ 'inhibition.deferred', deferredActions.length ],
      [ 'inhibition.pending_deferrals', this._deferredActions.length ],
    )

    if( vetoedActions.length > 0 )
      events.push({
        type: 'inhibition.veto',
        source: this.name,
        payload: { vetoedActions, inhibitionStrength },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && vetoedActions.length > 0 ){
      const predErr = this._model.observe('inhibition.strength', inhibitionStrength )
      if( !predErr.gated )
        _bus.publish({ type: 'inhibition.vetoed', version: 1, sourceEngine: this.name, salience: 0.7, payload: { vetoedActions, inhibitionStrength } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Explicitly veto a specific action type for a duration.
   */
  vetoAction( actionType: string, durationTicks: number ): void {
    this._deferredActions = this._deferredActions.filter( d => d.actionType !== actionType )
  }

  // ── Internal ─────────────────────────────────────────────

  private _computeEffectiveInhibition( state: ReadonlySimulationState ): number {
    const
    stressZone       = state.metrics.get('stress.zone') ?? 1,
    sleepPressure    = this._sleepPressure,
    energyLevel      = state.metrics.get('energy.level') ?? 50,
    circadianAlertness = state.metrics.get('circadian.alertness') ?? 0.5

    // Stress overload significantly reduces inhibition
    const stressFactor = stressZone >= 3 ? 0.3
                       : stressZone >= 2 ? 0.6
                       : 1.0

    // Fatigue reduces inhibition
    const sleepFactor = sleepPressure > 60 ? 0.5
                      : sleepPressure > 40 ? 0.7
                      : 1.0

    // Low energy reduces inhibition
    const energyFactor = Math.min( 1, energyLevel / 50 )

    // Circadian alertness affects inhibition
    const alertnessFactor = 0.6 + circadianAlertness * 0.8

    // Phase E: executive high confidence → relax inhibition (plan was reasoned through)
    const executiveFactor = this._executiveConfidence > 0.7 ? 0.85
                        : this._executiveConfidence < 0.3 ? 1.15
                        : 1.0

    return this._inhibitionStrength
         * stressFactor
         * sleepFactor
         * energyFactor
         * alertnessFactor
         * executiveFactor
  }

  private _contradictsActiveGoals( actionType: string, state: ReadonlySimulationState ): boolean {
    // Check if the action type contradicts any active goal
    for( const entity of state.entities.values() ){
      if( entity.type !== 'goal') continue
      if( entity.metadata?.status !== 'active') continue

      const blockedActions = entity.metadata?.blockedActions as string[] | undefined
      if( blockedActions?.includes( actionType ) )
        return true
    }

    return false
  }

  /**
   * Register this engine as a CommitValidator in the Orchestrator.
   * Call during setup to wire the veto into the commit pipeline.
   */
  asCommitValidator(): (
    cmds: StateCommands[],
    tick: Tick,
    ctx: SimulationContext
  ) => string[] | true {
    return ( cmds, _tick, _ctx ) => {
      // Scan commands for high-risk actions
      const highRiskActions = cmds.flatMap( c =>
        ( c.set ?? [] ).filter( e =>
          e.type === 'decision.record'
          && e.metadata?.confidence !== undefined
          && ( e.metadata.confidence as number ) < 0.2
        )
      )

      if( highRiskActions.length > 0 )
        return highRiskActions.map( a =>
          `Inhibition veto: low-confidence action '${a.metadata?.actionType}' blocked`
        )

      return true
    }
  }
}
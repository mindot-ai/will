// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/frustration.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * FrustrationEvaluator — detects blocked goals and repeated failures.
 *
 * Evaluates:
 *   - Goals stuck without progress  (via goal.blocked events)
 *   - Repeated blocked events on same goal
 *   - Violated expectations (cached confidence × goal-loss signals)
 *   - Perceived unfairness  (via interaction.occurred events)
 *
 * Produces: frustration, anger, irritability
 *
 * Frustration = goal blockage without clear target
 * Anger = goal blockage with identifiable external cause
 * Irritability = accumulated low-grade frustration lowering threshold
 *
 * Part of Shard 1 (Affective Layer) — hybrid: event-driven inputs, temporal react.
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

export interface FrustrationEvaluatorConfig {
  /** Ticks without progress before frustration begins */
  stuckThreshold?: number
  /** How quickly irritability accumulates */
  irritabilityRate?: number
  /** Decay rate when frustration resolves */
  decayRate?: number
  /**
   * Habituation rate — proportional to current irritability level.
   * Prevents the one-way ratchet to 1.0 under chronic goal blockage.
   * Natural ceiling: irritabilityRate / habituationRate (e.g. 0.02/0.03 ≈ 0.67).
   */
  habituationRate?: number
  bus?: CognitiveBus
}

export class FrustrationEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name = 'frustration-evaluator'

  private _stuckThreshold: number
  private _irritabilityRate: number
  private _decayRate: number
  private _habituationRate: number

  // Own output — cached so react() doesn't read state.metrics
  private _cachedFrustration:  number = 0
  private _cachedAnger:        number = 0
  private _cachedIrritability: number = 0

  // Inputs from cognitive events
  private _blockedGoals      = new Map<string, { ticksStuck: number; priority: number; refreshedAt: number }>()
  private _goalBlockedCounts = new Map<string, number>()   // repeated-failure proxy
  private _reactCount       = 0                           // incremented each react() for expiry
  private _unfairnessSignal: number = 0                    // from interaction.occurred
  private _cachedConfidence:    number = 0.5               // from executive.prediction.formed
  private _cachedGoalLoss:      number = 0                 // future: loss.goal event
  private _cachedDisappointment: number = 0                // future: emotion.disappointment event

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()

  constructor( config: FrustrationEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._stuckThreshold   = config.stuckThreshold   ?? 5
    this._irritabilityRate = config.irritabilityRate ?? 0.02
    this._decayRate        = config.decayRate        ?? 0.08
    this._habituationRate  = config.habituationRate  ?? 0.03
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'goal.blocked',
      'interaction.occurred',
    ]
  }

  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('affect') )
        this._model.setPrecision( 'emotion.frustration', 1.0 + p.confidence * 0.5 )
      this._cachedConfidence = p.confidence
    }

    if( e.type === 'goal.blocked' ){
      const p = e.payload as { goalId: string; ticksStuck: number; priority: number }
      this._blockedGoals.set( p.goalId, { ticksStuck: p.ticksStuck, priority: p.priority, refreshedAt: this._reactCount } )
      this._goalBlockedCounts.set( p.goalId, ( this._goalBlockedCounts.get( p.goalId ) ?? 0 ) + 1 )
    }

    if( e.type === 'interaction.occurred' ){
      const p = e.payload as { keid: string; valence: number; intensity: number; directedAtSelf: boolean }
      if( p.directedAtSelf && p.valence < -0.5 )
        this._unfairnessSignal = Math.min( 1, this._unfairnessSignal + 0.3 )
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

    // Channel A (emotional-stability): how fast low-grade frustration snowballs into
    // chronic irritability is read live as base ⊕ persona-prior. A Will that has shown
    // steady affect develops a lower build-rate here, so it stays even-keeled longer —
    // distinct from resilience's frustrationTolerance (how much is *tolerated*). Pure +
    // deterministic; falls back to the constructor default when no seed/prior is present.
    const frustrationCfg   = readEffectiveParams( state, 'engine-config-frustration' )
    const irritabilityRate = frustrationCfg.irritabilityRate ?? this._irritabilityRate

    // Channel A (agreeableness — "yielding in conflict"): how strongly provocation
    // (unfairness + blocked progress) turns into anger. An agreeable Will develops this
    // DOWN — wronged, it accommodates rather than retaliates. A distinct facet from #6's
    // warmth (reward.socialWeight): warmth = approach/connection, yielding = low antagonism.
    const angerReactivity  = frustrationCfg.angerReactivity ?? 0.7

    // Channel A (resilience — recovery): how fast frustration/anger/irritability fade is
    // refreshed each tick as base ⊕ persona-prior. A resilient Will develops a higher decay
    // rate and so recovers from a bad patch sooner — distinct from resilience's
    // frustrationTolerance (how much is endured, goal-manager #10) and from emotional-
    // stability's irritabilityRate (how fast it builds, #5).
    this._decayRate = frustrationCfg.decayRate ?? this._decayRate

    // Expire blocked-goal entries that have not been refreshed for > 1.5×STUCK_THRESHOLD
    // react() calls. goal.manager re-fires goal.blocked every STUCK_THRESHOLD ticks, so
    // a goal that resolves (stops emitting) will expire here after ~25–30 ticks.
    const expiryAge = Math.round( 20 * 1.5 )  // matches goal.manager._STUCK_THRESHOLD
    for( const [ id, g ] of this._blockedGoals ){
      if( this._reactCount - g.refreshedAt > expiryAge ){
        this._blockedGoals.delete( id )
        this._goalBlockedCounts.delete( id )
      }
    }

    this._reactCount++

    const previousFrustration  = this._cachedFrustration
    const previousAnger        = this._cachedAnger
    const previousIrritability = this._cachedIrritability

    const
    goalBlockage    = this._assessGoalBlockage(),
    repeatedFailure = this._assessRepeatedFailures(),
    violatedExpect  = this._assessViolatedExpectations(),
    unfairness      = this._unfairnessSignal

    // Decay unfairness signal between events
    this._unfairnessSignal = Math.max( 0, this._unfairnessSignal - this._decayRate * 0.5 * ( delta / 1000 ) )

    const frustrationSources = goalBlockage + repeatedFailure + violatedExpect + unfairness

    const
    // Frustration: blocked progress without clear external cause
    frustration = frustrationSources > 0.01
      ? Math.min( 1, frustrationSources )
      : Math.max( 0, previousFrustration - this._decayRate * ( delta / 1000 ) ),

    // Anger: identifiable external cause for blockage
    anger = ( goalBlockage > 0.3 && unfairness > 0.2 )
      ? Math.min( 1, ( goalBlockage + unfairness ) * angerReactivity )
      : Math.max( 0, previousAnger - this._decayRate * 0.5 * ( delta / 1000 ) ),

    // Irritability: accumulated low-grade frustration with proportional habituation.
    // Habituation (habituationRate * currentLevel) prevents the one-way ratchet to 1.0:
    // under sustained frustration, irritability converges to irritabilityRate/habituationRate
    // (default ≈ 0.67) rather than locking at ceiling indefinitely.
    irritability = frustration > 0.1
      ? Math.max( 0, Math.min( 1,
          previousIrritability
          + irritabilityRate * ( delta / 1000 )
          - this._habituationRate  * previousIrritability * ( delta / 1000 )
        ))
      : Math.max( 0, previousIrritability - this._decayRate * 2 * ( delta / 1000 ) )

    // Cache for next tick
    this._cachedFrustration  = frustration
    this._cachedAnger        = anger
    this._cachedIrritability = irritability

    commands.metrics!.push(
      [ 'emotion.frustration', frustration ],
      [ 'emotion.anger', anger ],
      [ 'emotion.irritability', irritability ],
      [ 'frustration.goal_blockage', goalBlockage ],
      [ 'frustration.repeated_failure', repeatedFailure ],
    )

    // Anger event
    if( anger > 0.5 )
      events.push({
        type: 'emotion.anger.significant',
        source: this.name,
        payload: { anger, frustration, unfairness },
      })

    // Chronic frustration event
    if( frustration > 0.6 && previousFrustration > 0.5 )
      events.push({
        type: 'emotion.frustration.chronic',
        source: this.name,
        payload: { frustration, irritability },
      })

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && frustration > 0.5 ){
      const predErr = this._model.observe( 'emotion.frustration', frustration )
      if( !predErr.gated )
        _bus.publish({ type: 'emotion.frustration.elevated', version: 1, sourceEngine: this.name, salience: Math.min(1, frustration), payload: { frustration } })
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  private _assessGoalBlockage(): number {
    if( this._blockedGoals.size === 0 ) return 0

    return Math.min( 1,
      Array.from( this._blockedGoals.values() ).reduce( ( sum, g ) =>
        sum + Math.min( 1, g.ticksStuck / ( this._stuckThreshold * 4 ) ) * 0.3,
        0
      )
    )
  }

  private _assessRepeatedFailures(): number {
    const repeatedGoals = Array.from( this._goalBlockedCounts.values() )
      .filter( count => count >= 3 )

    if( repeatedGoals.length === 0 ) return 0

    return Math.min( 1,
      repeatedGoals.reduce( ( sum, count ) =>
        sum + Math.min( 1, count / 10 ) * 0.25,
        0
      )
    )
  }

  private _assessViolatedExpectations(): number {
    // High confidence + negative outcome = violated expectation
    return this._cachedConfidence > 0.6
      ? this._cachedGoalLoss * this._cachedConfidence * 0.5
      : this._cachedDisappointment * 0.3
  }
}

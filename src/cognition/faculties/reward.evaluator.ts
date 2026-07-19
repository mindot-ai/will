// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/reward.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * RewardEvaluator — detects positive outcomes and progress.
 *
 * Evaluates:
 *   - Goal progress and completion
 *   - Positive social feedback
 *   - Resource gains
 *   - Novel discoveries (when safe)
 *
 * Produces: joy, satisfaction, excitement
 *
 * Joy = immediate positive outcome
 * Satisfaction = goal completion / steady progress
 * Excitement = anticipated positive outcome + high arousal
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
} from '#core/types'
import type { SimulationEngine, CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { readEffectiveParams } from '#cognition/persona.prior'
import { GenerativeModel } from '#cognition/generative.model'

export interface RewardEvaluatorConfig {
  /** Weight for goal-related rewards */
  goalWeight?: number
  /** Weight for social rewards */
  socialWeight?: number
  /** Weight for resource gains */
  resourceWeight?: number
  /** Weight for discovery/novelty rewards */
  discoveryWeight?: number
  /**
   * How fast the social reward signal decays per tick (0-1).
   * Default 0.02 → social warmth fades to zero over ~50 ticks after last interaction.
   */
  socialDecayRate?: number
  /** How much each positive directed interaction warms the social reward (warmth intensity) */
  socialWarmthBoost?: number
  bus?: CognitiveBus
}

export class RewardEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'reward-evaluator'
  
  private _goalWeight: number
  private _socialWeight: number
  private _resourceWeight: number
  private _discoveryWeight: number
  private _socialDecayRate: number
  private _socialWarmthBoost: number
  /**
   * How fast goal-reward signal decays per tick (0-1).
   * Default 0.05 → a priority-1.0 goal reward fades to ~0 over ~20 ticks,
   * giving a noticeable joy/satisfaction window after each completion.
   */
  private _goalRewardDecayRate: number

  // Domain state — updated per-event
  private _cachedEnergyLevel: number = 50
  private _cachedNovelty: number = 0
  private _cachedFearLevel: number = 0

  // Cached reward components
  /** Transient goal-achievement signal — spiked by goal.achieved, decays each tick. */
  private _cachedGoalReward: number = 0
  /** Transient social warmth — boosted by interaction.occurred, decays each tick. */
  private _cachedSocialReward: number = 0
  /** Count of goals completed recently — decays gradually, feeds satisfaction formula. */
  private _goalsCompletedRecently: number = 0

  // Track previous goal states for future entity-event updates
  private _previousGoalProgress = new Map<string, number>()

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()


  constructor( config: RewardEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._goalWeight         = config.goalWeight      ?? 0.40
    this._socialWeight       = config.socialWeight    ?? 0.25
    this._resourceWeight     = config.resourceWeight  ?? 0.15
    this._discoveryWeight    = config.discoveryWeight ?? 0.20
    this._socialDecayRate    = config.socialDecayRate ?? 0.02
    this._socialWarmthBoost  = config.socialWarmthBoost ?? 0.4
    this._goalRewardDecayRate = 0.05
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ["energy.state.changed","sleep.state.changed","stress.state.changed","novelty.state.changed","executive.prediction.formed","interaction.occurred","goal.achieved","action.outcome"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){

      case 'energy.state.changed': {
        const p = e.payload as { level: number }
        this._cachedEnergyLevel = p.level ?? this._cachedEnergyLevel
        break
      }

      case 'sleep.state.changed':
        // sleep pressure doesn't directly drive reward — absorbed for completeness
        break

      case 'stress.state.changed':
        // stress payload doesn't carry reward-relevant data beyond what novelty provides
        break

      case 'novelty.state.changed': {
        const p = e.payload as { novelty: number; fearLevel: number }
        this._cachedNovelty   = p.novelty   ?? this._cachedNovelty
        this._cachedFearLevel = p.fearLevel  ?? this._cachedFearLevel
        break
      }

      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('energy') )
          this._model.setPrecision('reward.value', 1.0 + p.confidence * 0.3)
        break
      }

      case 'interaction.occurred': {
        // Social warmth — each directed positive interaction boosts social reward.
        // Negative interactions dampen it. Capped at [0, 1]; decays via react().
        const p = e.payload as { keid: string; valence: number; intensity: number; directedAtSelf: boolean }
        if( p.directedAtSelf ){
          const contribution = p.valence * Math.max( 0.3, p.intensity )
          this._cachedSocialReward = Math.min( 1, Math.max( 0,
            this._cachedSocialReward + contribution * this._socialWarmthBoost
          ))
          this._model.observe('reward.social', this._cachedSocialReward )
        }
        break
      }

      case 'goal.achieved': {
        // Goal completion — spike goal reward proportional to goal priority,
        // and increment the goals-completed counter that feeds satisfaction.
        // Both decay in react() so the joy/satisfaction window is ~15-20 ticks.
        const p = e.payload as { goalId: string; priority: number; timeToComplete: number }
        const priority = p.priority ?? 0.5
        this._cachedGoalReward     = Math.min( 1, this._cachedGoalReward + priority * 0.9 )
        this._goalsCompletedRecently = Math.min( 2, this._goalsCompletedRecently + 1 )
        this._model.observe('reward.goal', this._cachedGoalReward )
        break
      }

      default:
        return
    }

    return this._computeAndEmit()
  }

  snapshot(): Record<string, unknown> {
    return {
      cachedEnergyLevel:  this._cachedEnergyLevel,
      cachedNovelty:      this._cachedNovelty,
      cachedSocialReward: this._cachedSocialReward,
    }
  }

  /**
   * Effective config = base engine-config-reward ⊕ persona-prior (single-source).
   * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-reward')
    if( p.goalWeight      != null ) this._goalWeight      = p.goalWeight
    if( p.socialWeight    != null ) this._socialWeight    = p.socialWeight
    if( p.resourceWeight  != null ) this._resourceWeight  = p.resourceWeight
    if( p.discoveryWeight != null ) this._discoveryWeight = p.discoveryWeight
    if( p.socialDecayRate != null ) this._socialDecayRate = p.socialDecayRate
    // Channel A (agreeableness → warmth): each interaction warms more, and warmth lingers
    // (socialDecayRate lowered). _socialWarmthBoost is the cached field the interaction
    // handler reads (onCognitiveEvent has no state).
    if( p.socialWarmthBoost != null ) this._socialWarmthBoost = p.socialWarmthBoost
  }

  async react(
    _delta: Duration,
    _tick:  Tick,
    state: ReadonlySimulationState,
    _ctx:   SimulationContext,
  ): Promise<EngineResult> {
    // Effective config = base engine-config-reward ⊕ persona-prior (single-source).
    this._readConfigFromState( state )

    // Decay social reward each tick so warmth fades naturally between interactions.
    // With default rate 0.02: a social reward of 1.0 decays to ~0 over ~50 ticks.
    if( this._cachedSocialReward > 0 )
      this._cachedSocialReward = Math.max( 0, this._cachedSocialReward - this._socialDecayRate )

    // Decay goal-reward signal each tick.
    // Default rate 0.05: a priority-1.0 achievement fades to ~0 over ~20 ticks,
    // giving a clear joy/satisfaction window after each completion.
    if( this._cachedGoalReward > 0 )
      this._cachedGoalReward = Math.max( 0, this._cachedGoalReward - this._goalRewardDecayRate )

    // Decay the goals-completed counter (feeds satisfaction formula).
    if( this._goalsCompletedRecently > 0 )
      this._goalsCompletedRecently = Math.max( 0, this._goalsCompletedRecently - 0.08 )

    // Re-emit emotion metrics every tick so the affective blender always has fresh values.
    return { commands: this._computeAndEmit() }
  }

  // ── Private helpers ──────────────────────────────────────

  private _computeResourceReward(): number {
    const energyRatio = this._cachedEnergyLevel / 100
    return energyRatio > 0.5
      ? ( energyRatio - 0.5 ) * 0.6
      : 0
  }

  private _computeDiscoveryReward(): number {
    const safety = 1 - this._cachedFearLevel
    return this._cachedNovelty * safety * 0.8
  }

  private _computeAndEmit(): StateCommands {
    const
    goalReward      = this._cachedGoalReward,
    socialReward    = this._cachedSocialReward,
    resourceReward  = this._computeResourceReward(),
    discoveryReward = this._computeDiscoveryReward()

    const rewardLevel
      = goalReward      * this._goalWeight
      + socialReward    * this._socialWeight
      + resourceReward  * this._resourceWeight
      + discoveryReward * this._discoveryWeight

    const
    joy = Math.min( 1,
      goalReward    * 0.5
      + socialReward  * 0.3
      + resourceReward * 0.2
    ),

    satisfaction = Math.min( 1,
      goalReward * 0.6
      + this._goalsCompletedRecently * 0.4
    ),

    excitement = Math.min( 1,
      discoveryReward * 0.4
      + goalReward    * 0.3
      + rewardLevel   * 0.3
    )

    const commands: StateCommands = { metrics: [] }

    commands.metrics!.push(
      [ 'emotion.joy',          joy ],
      [ 'emotion.satisfaction', satisfaction ],
      [ 'emotion.excitement',   excitement ],
      [ 'reward.level',         rewardLevel ],
      [ 'reward.goal',          goalReward ],
      [ 'reward.social',        socialReward ],
      [ 'reward.resource',      resourceReward ],
      [ 'reward.discovery',     discoveryReward ],
    )

    const _bus = this._bus
    if( _bus ){
      // Option B: reward-prediction-error salience — a CHANGE in reward grabs the
      // workspace, a fully-expected reward goes quiet (dopamine-RPE analogue),
      // precision-modulated (set on 'reward.value'). observe() runs every tick so
      // the baseline tracks; the one value is reused across the reward events.
      const rewardSalience = this._model.observe('reward.value', rewardLevel ).salience

      if( joy > 0.5 )
        _bus.publish({ type: 'emotion.joy.peak', version: 1, sourceEngine: this.name, salience: rewardSalience, payload: { joy } })
      if( joy > 0.6 )
        _bus.publish({ type: 'emotion.joy.significant', version: 1, sourceEngine: this.name, salience: rewardSalience, payload: { joy, satisfaction, excitement, rewardLevel } })
      if( goalReward > 0.8 )
        _bus.publish({ type: 'reward.goal_significant', version: 1, sourceEngine: this.name, salience: rewardSalience, payload: { goalReward, satisfaction } })
    }

    return commands
  }
}
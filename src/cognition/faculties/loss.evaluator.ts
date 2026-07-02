// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/loss.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * LossEvaluator — detects setbacks, failures, and losses.
 *
 * Evaluates:
 *   - Failed goals
 *   - Lost resources
 *   - Relationship damage
 *   - Missed opportunities
 *   - Degraded state (worsening metrics)
 *
 * Produces: sadness, disappointment, grief
 *
 * Sadness = generalized loss response
 * Disappointment = expected positive outcome that didn't materialize
 * Grief = significant permanent loss (relationship, major goal)
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

import type { StateCommands } from '#core/types'
import type { SimulationEngine, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

export interface LossEvaluatorConfig {
  /** Threshold for significant loss events */
  significantLossThreshold?: number
  /** How quickly sadness decays without re-triggering */
  decayRate?: number
  bus?: CognitiveBus
}

export class LossEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'loss-evaluator'

  private _significantLossThreshold: number
  private _decayRate: number

  // Track goal regressions (populated externally via entity scanning — kept for future use)
  private _previousGoalProgress = new Map<string, number>()

  // Track relationship valence history for damage detection (kept for future use)
  private _previousRelationshipValence = new Map<string, number>()

  // Cached energy / resource state from enriched energy.state.changed payload
  private _energyLevel: number = 100
  private _stressLoad: number = 0
  private _interoceptionComfort: number = 0.5
  private _previousComfort: number = 0.5

  // Cached loss dimension values — updated each time energy.state.changed fires
  private _cachedGoalLoss: number = 0
  private _cachedRelationshipLoss: number = 0

  // Cached emotion values for decay across events
  private _previousSadness: number = 0
  private _previousDisappointment: number = 0
  private _previousGrief: number = 0

  // Fixed deterministic per-event decay step (ms). This previously came from
  // wall-clock Date.now() deltas, but _decayDeltaMs feeds emotion decay into
  // replayable loss metrics, so a wall-clock source would break replay (R2).
  // onCognitiveEvent has no sim clock in scope, so we use a constant estimate.
  // (A true sim-time delta could be plumbed in later if adaptivity is wanted.)
  private _decayDeltaMs: number = 100

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: LossEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._significantLossThreshold = config.significantLossThreshold ?? 0.5
    this._decayRate                = config.decayRate                ?? 0.05
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ["energy.state.changed","executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){
      case 'energy.state.changed': {
        const p = e.payload as { level: number; zoneCode: number; stressLoad: number; interoceptionComfort: number }

        // Update energy state from enriched payload
        this._energyLevel          = p.level ?? this._energyLevel
        this._stressLoad           = p.stressLoad ?? 0
        this._previousComfort      = this._interoceptionComfort
        this._interoceptionComfort = p.interoceptionComfort ?? 0.5

        // Compute loss dimensions from available payload data
        const goalLoss         = this._cachedGoalLoss
        const resourceLoss     = this._computeResourceLoss()
        const relationshipLoss = this._cachedRelationshipLoss
        const stateDegradation = this._computeStateDegradation()

        // Weighted loss level
        const lossLevel
          = goalLoss         * 0.35
          + resourceLoss     * 0.20
          + relationshipLoss * 0.30
          + stateDegradation * 0.15

        const decayAmount = this._decayRate * ( this._decayDeltaMs / 1000 )

        // Decompose into specific emotions (with decay when no new triggers)
        const sadness = lossLevel > 0.01
          ? Math.min( 1, lossLevel * 1.1 )
          : Math.max( 0, this._previousSadness - decayAmount )

        const disappointment = goalLoss > 0.1
          ? Math.min( 1, goalLoss * 1.3 + relationshipLoss * 0.3 )
          : Math.max( 0, this._previousDisappointment - decayAmount )

        const grief = ( relationshipLoss > 0.7 || goalLoss > 0.8 )
          ? Math.min( 1, ( relationshipLoss + goalLoss ) / 2 )
          : Math.max( 0, this._previousGrief - this._decayRate * 0.3 * ( this._decayDeltaMs / 1000 ) )

        // Persist for next decay pass
        this._previousSadness       = sadness
        this._previousDisappointment = disappointment
        this._previousGrief         = grief

        const commands: StateCommands = {
          metrics: [
            [ 'emotion.sadness',         sadness ],
            [ 'emotion.disappointment',  disappointment ],
            [ 'emotion.grief',           grief ],
            [ 'loss.level',              lossLevel ],
            [ 'loss.goal',               goalLoss ],
            [ 'loss.resource',           resourceLoss ],
            [ 'loss.relationship',       relationshipLoss ],
          ],
        }

        // Publish significant loss and grief events via bus
        const _bus = this._bus
        if( _bus ){
          if( lossLevel > this._significantLossThreshold )
            _bus.publish({ type: 'emotion.sadness.significant', version: 1, sourceEngine: this.name, salience: Math.min( 1, sadness * 1.5 ), payload: { sadness, disappointment, grief, lossLevel } })

          if( grief > 0.6 )
            _bus.publish({ type: 'emotion.grief.significant', version: 1, sourceEngine: this.name, salience: Math.min( 1, grief * 1.5 ), payload: { grief, relationshipLoss, goalLoss } })

          // Publish cognitive event — gated by prediction error
          if( sadness > 0.4 ){
            const predErr = this._model.observe( 'emotion.sadness', sadness )
            if( !predErr.gated )
              _bus.publish({ type: 'emotion.sadness.elevated', version: 1, sourceEngine: this.name, salience: Math.min(1, sadness * 1.5), payload: { sadness } })
          }
        }

        return commands
      }

      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }

        if( p.predictedDomains.includes('affect') )
          this._model.setPrecision( 'emotion.sadness', 1.0 + p.confidence * 0.5 )

        // Approximate goal loss from prediction confidence:
        // Low confidence in domains signals uncertain/failing goals
        if( p.predictedDomains.includes('goal') ){
          const goalUncertainty = Math.max( 0, 1 - p.confidence )
          // Blend with cached value — don't overwrite aggressively
          this._cachedGoalLoss = Math.min( 1, this._cachedGoalLoss * 0.8 + goalUncertainty * 0.2 )
        }

        // Approximate relationship loss from social-domain prediction
        if( p.predictedDomains.includes('social') ){
          const socialUncertainty = Math.max( 0, 1 - p.confidence )
          this._cachedRelationshipLoss = Math.min( 1, this._cachedRelationshipLoss * 0.8 + socialUncertainty * 0.2 )
        }

        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel:         this._energyLevel,
      stressLoad:          this._stressLoad,
      interoceptionComfort: this._interoceptionComfort,
      cachedGoalLoss:      this._cachedGoalLoss,
      cachedRelationshipLoss: this._cachedRelationshipLoss,
      sadness:             this._previousSadness,
      disappointment:      this._previousDisappointment,
      grief:               this._previousGrief,
    }
  }

  // ── Loss dimension helpers (event-payload-driven) ─────────

  private _computeResourceLoss(): number {
    // Low energy combined with high stress = resource loss perception
    const energyDeficit = Math.max( 0, 1 - this._energyLevel / 50 )
    return Math.min( 1,
      energyDeficit * 0.5
      + this._stressLoad / 100 * 0.5
    )
  }

  private _computeStateDegradation(): number {
    // Interoceptive comfort decrease signals state degradation
    const previousComfort = this._previousComfort
    const comfort         = this._interoceptionComfort
    return previousComfort > comfort
      ? ( previousComfort - comfort ) * 1.5
      : 0
  }
}
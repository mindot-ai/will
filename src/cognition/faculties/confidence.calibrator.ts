// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/confidence.calibrator.ts
// ─────────────────────────────────────────────────────────────

/**
 * ConfidenceCalibrator — compares decision confidence against actual
 * outcomes to calibrate future confidence estimates.
 *
 * Maintains a calibration curve per action domain. If the agent
 * consistently overestimates confidence in "planning" decisions,
 * future planning confidence is adjusted downward.
 *
 * This is the mechanism behind "knowing what you don't know."
 *
 * Part of Shard 4 (Meta-Cognitive Layer) — runs every tick, synchronous.
 */

import type {
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
  Duration,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel, type GenerativeModelSnapshot } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface ConfidenceCalibratorConfig {
  /** Minimum outcome samples before calibration activates */
  minSamplesPerDomain?: number
  /** How aggressively to adjust calibration (learning rate) */
  calibrationRate?: number
  /** Maximum calibration adjustment per evaluation */
  maxAdjustment?: number
  bus?: CognitiveBus
}

interface CalibrationRecord {
  confidence: number
  outcomeQuality: number  // 0-1: how good the outcome actually was
  tick: Tick
}

export class ConfidenceCalibrator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'confidence-calibrator'
  
  private _executiveFlaggedBiasCount: number = 0
  private _minSamplesPerDomain: number
  private _calibrationRate: number
  private _maxAdjustment: number

  // Per-domain calibration records
  private _records = new Map<string, CalibrationRecord[]>()

  // Per-domain bias estimate (-1 = underconfident, +1 = overconfident)
  private _domainBias = new Map<string, number>()

  private _bus: CognitiveBus | null = null
  private _restored = false

  private readonly _model = new GenerativeModel()


  constructor( config: ConfidenceCalibratorConfig = {} ){
    this._bus = config.bus ?? null
    this._minSamplesPerDomain = config.minSamplesPerDomain ?? 5
    this._calibrationRate     = config.calibrationRate     ?? 0.1
    this._maxAdjustment       = config.maxAdjustment       ?? 0.3
  }

  // ── Public API ───────────────────────────────────────────

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  subscribes(): string[] {
    return [
      'executive.self.reflection',
      'executive.prediction.formed',
      'action.outcome'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'executive.self.reflection': {
        // Executive named biases — flag for next calibration pass
        const p = e.payload as Record<string, unknown>
        this._executiveFlaggedBiasCount = ( ( p['identifiedBiases'] as string[] ) ?? [] ).length

        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('metacognition') )
          this._model.setPrecision('metacognition.bias', 1.0 + p.confidence * 0.5 )

        break
      }
      case 'action.outcome': {
        // Pair the decision's predicted confidence against the realised outcome
        // quality so per-domain over/under-confidence can be learned in react().
        const p = e.payload as { domain?: string; confidence?: number; outcomeQuality?: number; tick?: number }
        if( typeof p.confidence === 'number' && typeof p.outcomeQuality === 'number')
          this.recordOutcome( p.domain ?? 'general', p.confidence, p.outcomeQuality, ( ( p.tick ?? 0 ) as Tick ) )

        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    // FN9: capture the learned calibration curve (_domainBias) and the raw
    // outcome records that produce it, plus the salience/generative sub-states,
    // so a restored Will keeps "knowing what it doesn't know" instead of
    // re-learning every domain bias from zero. Maps are flattened to entry
    // arrays so the payload stays plain-JSON-safe.
    return {
      executiveFlaggedBiasCount: this._executiveFlaggedBiasCount,
      records: [ ...this._records.entries() ].map( ([ k, v ]) => [ k, v.map( r => ({ ...r }) ) ] ),
      domainBias: [ ...this._domainBias.entries() ],
      model: this._model.snapshot()
    }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return

    if( typeof snap.executiveFlaggedBiasCount === 'number')
      this._executiveFlaggedBiasCount = snap.executiveFlaggedBiasCount

    if( Array.isArray( snap.records ) )
      this._records = new Map( snap.records as Array<[ string, CalibrationRecord[] ]> )

    if( Array.isArray( snap.domainBias ) )
      this._domainBias = new Map( snap.domainBias as Array<[ string, number ]> )

    if( snap.model ) this._model.restore( snap.model as GenerativeModelSnapshot )
  }

  /**
   * Rehydrate the learned calibration curve from the persisted `calibration-state`
   * entity (Phase 2, Option B — the entity-restore path that's actually wired at
   * boot). Called once on the first react after a restore. Bias is restored
   * directly so calibration is continuous immediately, rather than waiting to
   * re-accumulate minSamplesPerDomain fresh outcomes.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    const m = state.entities.get('calibration-state')?.metadata?.domainBias as Record<string, number> | undefined
    if( !m ) return

    for( const [ domain, bias ] of Object.entries( m ) )
      if( typeof bias === 'number')
        this._domainBias.set( domain, bias )
  }

  /**
   * Record a decision and its eventual outcome.
   * Called when an action's outcome is known.
   */
  recordOutcome(
    domain: string,
    confidence: number,
    outcomeQuality: number,
    tick: Tick
  ): void {
    const records = this._records.get( domain ) ?? []
    records.push({ confidence, outcomeQuality, tick })

    // Keep last 100 records per domain
    if( records.length > 100 ) records.shift()

    this._records.set( domain, records )
  }

  /**
   * Get the calibrated confidence for a given raw confidence in a domain.
   * Adjusts based on historical over/under-confidence patterns.
   */
  getCalibratedConfidence( domain: string, rawConfidence: number ): number {
    const bias = this._domainBias.get( domain ) ?? 0
    // Overconfident → reduce. Underconfident → increase.
    const adjusted = rawConfidence - bias * rawConfidence

    return Math.max( 0, Math.min( 1, adjusted ) )
  }

  /**
   * Effective config = base engine-config-confidence ⊕ persona-prior. Seeded base
   * matches the constructor defaults (no drift), so this just single-sources the
   * tunables and lets a future persona-prior modulate calibration aggressiveness.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-confidence')

    if( p.minSamplesPerDomain != null ) this._minSamplesPerDomain = p.minSamplesPerDomain
    if( p.calibrationRate     != null ) this._calibrationRate     = p.calibrationRate
    if( p.maxAdjustment       != null ) this._maxAdjustment       = p.maxAdjustment
  }

  // ── Engine interface ─────────────────────────────────────

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], metrics: [] }

    // On the first tick after a restart, rehydrate the learned calibration curve
    // from its persisted entity (Phase 2, Option B). Entity state is the wired
    // restore path, so the Will keeps "knowing what it doesn't know" across
    // restarts even though the engine-internal restore() seam isn't invoked at boot.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    // Effective config = base engine-config-confidence ⊕ persona-prior (single-source).
    this._readConfigFromState( state )

    // Recalibrate each domain with enough samples
    for( const [ domain, records ] of this._records ){
      if( records.length < this._minSamplesPerDomain ) continue

      const bias = this._computeBias( records )
      const previousBias = this._domainBias.get( domain ) ?? 0

      // Smooth update
      const newBias = previousBias + ( bias - previousBias ) * this._calibrationRate
      const clampedBias = Math.max( -this._maxAdjustment, Math.min( this._maxAdjustment, newBias ) )

      this._domainBias.set( domain, clampedBias )

      // Metric
      commands.metrics!.push([ `calibration.${domain}.bias`, clampedBias ])

      // Event if bias changed significantly
      if( Math.abs( clampedBias - previousBias ) > 0.1 )
        events.push({
          type: 'calibration.shift',
          source: this.name,
          payload: {
            domain,
            previousBias,
            newBias: clampedBias,
            interpretation: clampedBias > 0.1 ? 'overconfident'
                          : clampedBias < -0.1 ? 'underconfident'
                          : 'well_calibrated'
          }
        })
    }

    // Overall calibration metric
    const allBiases = Array.from( this._domainBias.values() )
    const overallBias = allBiases.length > 0 ? allBiases.reduce( ( s, b ) => s + b, 0 ) / allBiases.length : 0

    commands.metrics!.push([ 'metacognition.calibration_bias', overallBias ])

    // Persist the learned calibration curve as an entity so it survives restart
    // (durable persona). Written from _domainBias — independent of _records,
    // which re-accumulate from action.outcome after a restart. `tick` keeps the
    // write deterministic (R2).
    if( this._domainBias.size > 0 )
      commands.set!.push({
        id:   'calibration-state',
        type: 'calibration.state',
        metadata: {
          domainBias:    Object.fromEntries( this._domainBias ),
          updatedAtTick: tick
        }
      })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus )
      _bus.publish({
        type: 'confidence.calibrated',
        version: 1,
        sourceEngine: this.name,
        salience: Math.max( 0.2, this._model.observe('calibration.event', overallBias ).salience ),
        payload: { calibrationBias: overallBias }
      })
    
    // Phase D + F: rich state-change event — gated by prediction error
    if( _bus ){
      const predErr = this._model.observe('metacognition.bias', overallBias )
      if( !predErr.gated )
        _bus.publish({
          type: 'metacognition.state.changed',
          version: 1,
          sourceEngine: this.name,
          salience: predErr.salience,
          payload: { confidence: overallBias }
        })
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Compute calibration bias from records.
   * Positive bias = overconfident (confidence > outcome).
   * Negative bias = underconfident (confidence < outcome).
   */
  private _computeBias( records: CalibrationRecord[] ): number {
    let totalBias = 0

    for( const record of records )
      totalBias += record.confidence - record.outcomeQuality

    return totalBias / records.length
  }
}
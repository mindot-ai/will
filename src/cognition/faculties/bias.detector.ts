// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/bias.detector.ts
// ─────────────────────────────────────────────────────────────

/**
 * BiasDetector — identifies recurring patterns of error in the agent's
 * own reasoning.
 *
 * Scans decision history for:
 *   - Anchoring (over-reliance on first piece of information)
 *   - Confirmation bias (seeking evidence that confirms existing beliefs)
 *   - Recency bias (overweighting recent events)
 *   - Availability bias (overweighting vivid/salient memories)
 *   - Overgeneralization (forming broad beliefs from few samples)
 *
 * Part of Shard 4 (Meta-Cognitive Layer) — runs periodically, synchronous.
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

/** Confidence added to a detected bias the executive independently named. */
const EXECUTIVE_CORROBORATION_BOOST = 0.15

export interface BiasDetectorConfig {
  /** Minimum decisions before bias detection activates */
  minDecisions?: number
  /** Ticks between bias scans */
  scanIntervalTicks?: number
  /** Whether to flag biases as events */
  emitBiasEvents?: boolean
  bus?: CognitiveBus
}

interface DetectedBias {
  type: string
  description: string
  confidence: number
  supportingEvidence: string[]
  detectedAt: Tick
}

export class BiasDetector implements SimulationEngine, CognitiveEngine {
  readonly name     = 'bias-detector'
  
  private _executiveNamedBiases: Set<string> = new Set()
  private _minDecisions: number
  private _scanIntervalTicks: number
  private _emitBiasEvents: boolean

  private _lastScanTick: number = 0
  private _detectedBiases: DetectedBias[] = []

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()

  constructor( config: BiasDetectorConfig = {} ){
    this._bus = config.bus ?? null
    this._minDecisions    = config.minDecisions    ?? 10
    this._scanIntervalTicks = config.scanIntervalTicks ?? 100
    this._emitBiasEvents  = config.emitBiasEvents  ?? true
  }

  // ── Engine interface ─────────────────────────────────────

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  subscribes(): string[] {
    return [
      'executive.self.reflection',
      'executive.prediction.formed'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){
      case 'executive.self.reflection': {
        // Executive named biases → seed the detector's known-bias list
        const p = e.payload as Record<string, unknown>
        const named = ( p['identifiedBiases'] as string[] ) ?? []
        for( const n of named )
          this._executiveNamedBiases.add( n )
        
        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('metacognition') )
          this._model.setPrecision('bias.novelty', 1.0 + p.confidence * 0.5 )

        break
      }
    }
  }

  snapshot(): Record<string, unknown> { return { executiveNamedBiases: this._executiveNamedBiases.size } }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Effective config = base engine-config-bias-detector ⊕ persona-prior (single-source).
    this._readConfigFromState( state )

    if( tick - this._lastScanTick < this._scanIntervalTicks )
      return { commands }

    this._lastScanTick = tick

    // Scan for biases
    const newBiases = this._scanForBiases( state )

    // Update detected biases
    for( const bias of newBiases )
      this._integrateBias( bias )

    // Persist as entities
    for( const bias of this._detectedBiases ){
      commands.set ??= []
      commands.set.push({
        id: `bias-${bias.type}-${bias.detectedAt}`,
        type: 'cognitive_bias',
        createdAt: bias.detectedAt,
        metadata: {
          biasType: bias.type,
          description: bias.description,
          confidence: bias.confidence,
          evidence: bias.supportingEvidence
        }
      })
    }

    commands.metrics!.push([
      'metacognition.biases_detected', this._detectedBiases.length
    ])

    if( newBiases.length > 0 && this._emitBiasEvents )
      events.push({
        type: 'bias.detected',
        source: this.name,
        payload: { newBiases: newBiases.map( b => b.type ) },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._detectedBiases.length > 0 ){
      // Surprise is driven by how many biases *this scan* surfaced, not the
      // cumulative count (which only grows, then saturates against the prune
      // cap — a near-constant the gate could never read as surprising).
      const predErr = this._model.observe('bias.novelty', newBiases.length )
      if( !predErr.gated )
        _bus.publish({
          type: 'bias.detected',
          version: 1,
          sourceEngine: this.name,
          salience: Math.max( 0.4, predErr.salience ),
          payload: {
            count: this._detectedBiases.length,
            newCount: newBiases.length,
            types: newBiases.map( b => b.type )
          }
        })
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  /**
   * Effective config = base engine-config-bias-detector ⊕ persona-prior. Seeded
   * base matches the constructor defaults (no drift). Only the numeric tunables
   * are single-sourced here; `emitBiasEvents` is a boolean (stored 1/0 in the
   * mirror) and stays constructor-only to avoid a lossy numeric coercion.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-bias-detector')

    if( p.minDecisions      != null ) this._minDecisions      = p.minDecisions
    if( p.scanIntervalTicks != null ) this._scanIntervalTicks = p.scanIntervalTicks
  }

  // ── Bias scanning ────────────────────────────────────────

  // NOTE (R2): `detectedAt` is the sim tick (state.tick), so detection replays
  // deterministically and the field is a true Tick — no ms→tick cast.
  private _scanForBiases( state: ReadonlySimulationState ): DetectedBias[] {
    const biases: DetectedBias[] = []

    // 1. Overgeneralization: high-confidence beliefs from few episodes
    {
      const
      beliefs = [ ...state.entities.values() ].filter( e => e.type === 'belief')
                                              .map( e => ({
                                                confidence: ( e.metadata?.['confidence'] as number ) ?? 0,
                                                supportingEpisodes: ( e.metadata?.['supportingEpisodes'] as number ) ?? 0,
                                                statement: ( e.metadata?.['statement'] as string ) ?? '',
                                              })),
      overgeneralized = beliefs.filter( b => b.confidence > 0.7 && b.supportingEpisodes < 5 )

      if( overgeneralized.length > 0 )
        biases.push({
          type: 'overgeneralization',
          description: `Formed ${overgeneralized.length} high-confidence beliefs from limited experience`,
          confidence: Math.min( 0.9, overgeneralized.length * 0.2 ),
          supportingEvidence: overgeneralized.map( b => b.statement ),
          detectedAt: state.tick,
        })
    }

    // 2. Recency bias: check if decisions heavily weight recent memories
    {
      const allEpisodes = [ ...state.entities.values() ]
        .filter( e => e.type === 'episodic_memory')
        .map( e => ({ timestamp: ( e.metadata?.['tick'] as number ) ?? 0 }))
      if( allEpisodes.length > 20 ){
        // `e.timestamp` is an episode tick, so the recency window is 50 ticks.
        const recentCount = allEpisodes.filter( e => e.timestamp > state.tick - 50 ).length

        const recentRatio = recentCount / allEpisodes.length
        if( recentRatio > 0.6 )
          biases.push({
            type: 'recency_bias',
            description: `Heavy reliance on recent experiences (${( recentRatio * 100 ).toFixed( 0 )}% of weighted decisions)`,
            confidence: Math.min( 0.8, recentRatio ),
            supportingEvidence: [
              `${recentCount} of ${allEpisodes.length} weighted episodes are recent`,
            ],
            detectedAt: state.tick,
          })
      }
    }

    // 3. Confirmation bias: check if beliefs are self-reinforcing
    {
      const selfBeliefs = [ ...state.entities.values() ]
        .filter( e => e.type === 'belief'
          && (e.metadata?.['category'] as string | undefined) === 'self_belief'
          && ((e.metadata?.['confidence'] as number | undefined) ?? 0) >= 0.5
        )
        .map( e => ({
          confidence:         ( e.metadata?.['confidence']         as number ) ?? 0,
          supportingEpisodes: ( e.metadata?.['supportingEpisodes'] as number ) ?? 0,
          statement:          ( e.metadata?.['statement']          as string ) ?? '',
        }))

      // Detection: if many self-beliefs cluster around the same theme
      // and have high confidence despite limited evidence, possible confirmation bias
      const highConfidenceLowEvidence = selfBeliefs.filter( b => b.confidence > 0.7 && b.supportingEpisodes < 8 )

      if( highConfidenceLowEvidence.length >= 3 )
        biases.push({
          type: 'confirmation_bias',
          description: 'Self-beliefs may be self-reinforcing without sufficient disconfirming evidence',
          confidence: Math.min( 0.7, highConfidenceLowEvidence.length * 0.15 ),
          supportingEvidence: highConfidenceLowEvidence.map( b => b.statement ),
          detectedAt: state.tick,
        })
    }

    // 4. Decision-pattern biases (overconfidence, repetition) — consolidated here so
    //    bias-detection has a single home (introspection used to detect these too).
    {
      const decisions = [ ...state.entities.values() ]
        .filter( e => e.type === 'decision.record')
        .map( e => ({
          actionType: ( e.metadata?.['actionType'] as string ) ?? 'unknown',
          confidence: ( e.metadata?.['confidence'] as number ) ?? 0.5,
        }))

      if( decisions.length >= 5 ){
        const avgConfidence = decisions.reduce( ( s, d ) => s + d.confidence, 0 ) / decisions.length
        if( avgConfidence > 0.8 )
          biases.push({
            type: 'overconfidence',
            description: `Recent decisions made at very high average confidence (${( avgConfidence * 100 ).toFixed( 0 )}%)`,
            confidence: Math.min( 0.8, avgConfidence ),
            supportingEvidence: [ `${decisions.length} decisions, average confidence ${avgConfidence.toFixed( 2 )}` ],
            detectedAt: state.tick,
          })

        const uniqueActions = new Set( decisions.map( d => d.actionType ) )
        if( uniqueActions.size === 1 )
          biases.push({
            type: 'repetition',
            description: `Repetitive behaviour — only taking "${[ ...uniqueActions ][ 0 ]}" actions`,
            confidence: 0.6,
            supportingEvidence: [ `${decisions.length} consecutive "${[ ...uniqueActions ][ 0 ]}" decisions` ],
            detectedAt: state.tick,
          })
      }
    }

    // Executive-corroboration: when the executive independently named a bias the
    // detector also found this scan, raise that bias's confidence — two sources
    // agreeing is stronger evidence. (Wires the previously-recorded-but-unused
    // _executiveNamedBiases; Phase 1a tie-off.)
    for( const b of biases )
      if( this._executiveCorroborates( b.type ) )
        b.confidence = Math.min( 1, b.confidence + EXECUTIVE_CORROBORATION_BOOST )

    return biases
  }

  /**
   * True if the executive (via executive.self.reflection) independently named a
   * bias matching `type`. Normalised, fuzzy match — the executive names biases in
   * free text ("recency bias") while the detector uses codes ("recency_bias").
   */
  private _executiveCorroborates( type: string ): boolean {
    if( this._executiveNamedBiases.size === 0 ) return false
    const norm = ( s: string ): string => s.toLowerCase().replace( /[^a-z]/g, '')
    const t = norm( type )
    for( const named of this._executiveNamedBiases ){
      const n = norm( named )
      if( n.length > 0 && ( n.includes( t ) || t.includes( n ) ) ) return true
    }
    return false
  }

  private _integrateBias( newBias: DetectedBias ): void {
    const existing = this._detectedBiases.find( b => b.type === newBias.type )

    if( existing ){
      existing.confidence = ( existing.confidence + newBias.confidence ) / 2
      existing.supportingEvidence = [
        ...existing.supportingEvidence,
        ...newBias.supportingEvidence,
      ].slice( 0, 10 )
    }
    else this._detectedBiases.push( newBias )

    // Prune old biases
    if( this._detectedBiases.length > 20 )
      this._detectedBiases = this._detectedBiases.slice( -15 )
  }

  /**
   * Get currently detected biases.
   */
  getDetectedBiases(): ReadonlyArray<DetectedBias> {
    return this._detectedBiases
  }
}
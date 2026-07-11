// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/theory.of.mind.ts
// ─────────────────────────────────────────────────────────────

/**
 * TheoryOfMind — models what other agents know, believe, and intend.
 *
 * Maintains a mental model for each observed agent:
 *   - Knowledge state (what they've observed)
 *   - Belief state (what they think is true, may differ from reality)
 *   - Intention state (what they're trying to achieve)
 *   - Emotional state (what they're likely feeling)
 *
 * Updates models based on:
 *   - Observed actions (what the other agent did)
 *   - Shared observations (what the other agent could have seen)
 *   - Communication (what the other agent explicitly shared)
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
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

export interface TheoryOfMindConfig {
  /** Maximum agents to model simultaneously */
  maxModeledAgents?: number
  /** How quickly belief confidence decays without observation */
  beliefDecayRate?: number
  /** Minimum confidence to consider a belief reliable */
  confidenceThreshold?: number
  bus?: CognitiveBus
}

export interface AgentMentalModel {
  keid: string
  /** What this agent is known to have observed */
  knownObservations: Array<{ entityId: string; tick: Tick; confidence: number }>
  /** What this agent is believed to believe */
  beliefs: Array<{ statement: string; confidence: number; lastUpdated: Tick }>
  /** What this agent is believed to intend */
  intentions: Array<{ goal: string; confidence: number; lastUpdated: Tick }>
  /** What this agent is likely feeling */
  emotionalState: { valence: number; arousal: number; dominantEmotion: string }
  /** Last tick this model was updated */
  lastUpdated: Tick
  /** Overall model confidence */
  modelConfidence: number
}

export class TheoryOfMind implements SimulationEngine, CognitiveEngine {
  readonly name     = 'theory-of-mind'
  
  private _maxModeledAgents: number
  private _beliefDecayRate: number
  private _confidenceThreshold: number

  private _models = new Map<string, AgentMentalModel>()
  private _restored = false
  private _pendingInteractions: Array<{
    keid: string; valence: number; intensity: number
    directedAtSelf: boolean; interactionType: string
  }> = []

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: TheoryOfMindConfig = {} ){
    this._bus = config.bus ?? null
    this._maxModeledAgents   = config.maxModeledAgents   ?? 10
    this._beliefDecayRate    = config.beliefDecayRate    ?? 0.002
    this._confidenceThreshold = config.confidenceThreshold ?? 0.3
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

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
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('social') )
        this._model.setPrecision( 'tom.models', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'interaction.occurred' ){
      const p = e.payload as {
        keid: string; valence: number; intensity: number
        directedAtSelf: boolean; interactionType: string
      }
      if( p.keid && p.keid !== 'agent-self' )
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
    commands: StateCommands = { set: [], delete: [], metrics: [] }

    // On the first tick after construction (including snapshot/PMA restores), rehydrate
    // _models from the persisted tom-<id> gist — parity with attachment/reputation, which
    // already restore. Without this a restored Will keeps its bonds + trust but loses the
    // effector to *model* those same minds (empathy.getModel returns nothing; maintenance
    // stalls). The entity only ever stored a gist, so the restore is gist-level by design.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    // Drain pending interactions buffered from interaction.occurred events
    const interactions = this._pendingInteractions.splice( 0 )
    for( const interaction of interactions ){
      const model = this._getOrCreateModel( interaction.keid, tick )
      const action = interaction.interactionType

      model.knownObservations.push({
        entityId: `action-${action}-${tick}`,
        tick,
        confidence: 0.8,
      })

      this._inferIntention( model, action, tick )

      model.emotionalState = {
        valence: interaction.valence > 0.3 ? 0.5 : interaction.valence < -0.3 ? -0.5 : 0,
        arousal: Math.abs( interaction.valence ) > 0.5 ? 0.7 : 0.3,
        dominantEmotion: interaction.valence > 0.3 ? 'satisfaction' : interaction.valence < -0.3 ? 'frustration' : 'neutral',
      }

      model.lastUpdated = tick
    }

    // 3. Decay old beliefs
    this._decayBeliefs( tick )

    // 4. Prune models with low confidence
    this._pruneModels()

    // 5. Persist models
    for( const [ keid, model ] of this._models ){
      commands.set!.push({
        id: `tom-${keid}`,
        type: 'theory_of_mind',
        createdAt: model.lastUpdated,
        updatedAt: tick,
        metadata: {
          keid,
          beliefCount: model.beliefs.filter( b => b.confidence > this._confidenceThreshold ).length,
          intentionCount: model.intentions.filter( i => i.confidence > this._confidenceThreshold ).length,
          modelConfidence: model.modelConfidence,
          dominantIntention: model.intentions
            .sort( ( a, b ) => b.confidence - a.confidence )[0]?.goal ?? null,
          estimatedEmotion: model.emotionalState.dominantEmotion,
        },
      })
    }

    commands.metrics!.push(
      [ 'theory_of_mind.models_active', this._models.size ],
    )


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._models.size > 0 ){
      const predErr = this._model.observe( 'tom.models', this._models.size )
      if( !predErr.gated )
        _bus.publish({ type: 'theory_of_mind.model.updated', version: 1, sourceEngine: this.name, salience: Math.max( 0.2, predErr.salience ), payload: { modelsActive: this._models.size } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Query what another agent is likely to know/believe/intend.
   */
  getModel( keid: string ): AgentMentalModel | undefined {
    return this._models.get( keid )
  }

  /**
   * Check if another agent is likely aware of something.
   */
  isLikelyAwareOf( keid: string, entityId: string ): boolean {
    const model = this._models.get( keid )
    if( !model ) return false

    return model.knownObservations.some(
      o => o.entityId === entityId && o.confidence > this._confidenceThreshold
    )
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Rehydrate _models from persisted tom-<id> entities on the first tick after a
   * snapshot/PMA restore — mirrors AttachmentEvaluator/ReputationTracker._restoreFromState.
   * The entity stores a gist (modelConfidence + the dominant intention + estimated emotion),
   * not the full belief/observation arrays, so the restored model is a coherent gist that
   * subsequent interactions grow from — the soul-true level: the Will recovers its
   * *sense* of a mind, not every belief it once inferred about it.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'theory_of_mind' ) continue
      const m       = entity.metadata ?? {}
      const keid = m['keid'] as string | undefined
      if( !keid ) continue
      if( this._models.has( keid ) ) continue   // prefer a live model if already present

      const dominantIntention = ( m['dominantIntention'] as string | null ) ?? null
      const modelConfidence   = ( m['modelConfidence']   as number ) ?? 0.3
      const estimatedEmotion  = ( m['estimatedEmotion']  as string ) ?? 'neutral'

      this._models.set( keid, {
        keid,
        knownObservations: [],
        beliefs:           [],
        intentions: dominantIntention
          ? [ { goal: dominantIntention, confidence: modelConfidence, lastUpdated: 0 as unknown as Tick } ]
          : [],
        emotionalState: { valence: 0, arousal: 0, dominantEmotion: estimatedEmotion },
        lastUpdated:     0 as unknown as Tick,
        modelConfidence,
      })
    }
  }

  private _getOrCreateModel( keid: string, tick: Tick ): AgentMentalModel {
    const existing = this._models.get( keid )
    if( existing ) return existing

    const model: AgentMentalModel = {
      keid,
      knownObservations: [],
      beliefs: [],
      intentions: [],
      emotionalState: { valence: 0, arousal: 0.3, dominantEmotion: 'neutral' },
      lastUpdated: tick,
      modelConfidence: 0.3,
    }

    this._models.set( keid, model )
    return model
  }

  private _inferIntention(
    model: AgentMentalModel,
    action: string,
    tick: Tick
  ): void {
    const existingIntention = model.intentions.find( i => i.goal === action )

    if( existingIntention ){
      existingIntention.confidence = Math.min( 1, existingIntention.confidence + 0.1 )
      existingIntention.lastUpdated = tick
    }
    else model.intentions.push({
          goal: action,
          confidence: 0.4,
          lastUpdated: tick,
        })

    // Boost overall model confidence
    model.modelConfidence = Math.min( 1, model.modelConfidence + 0.02 )
  }

  private _decayBeliefs( currentTick: Tick ): void {
    for( const model of this._models.values() ){
      const ticksSinceUpdate = currentTick - model.lastUpdated

      if( ticksSinceUpdate > 100 ){
        model.modelConfidence = Math.max( 0.05, model.modelConfidence - this._beliefDecayRate * ticksSinceUpdate )

        for( const belief of model.beliefs )
          belief.confidence = Math.max( 0.05, belief.confidence - this._beliefDecayRate * 2 )

        for( const intention of model.intentions )
          intention.confidence = Math.max( 0.05, intention.confidence - this._beliefDecayRate * 2 )
      }
    }
  }

  private _pruneModels(): void {
    const toPrune: string[] = []

    for( const [ id, model ] of this._models ){
      if( model.modelConfidence < 0.05 )
        toPrune.push( id )
    }

    for( const id of toPrune )
      this._models.delete( id )

    // Also prune if over capacity — keep highest confidence
    if( this._models.size > this._maxModeledAgents ){
      const sorted = Array.from( this._models.entries() )
        .sort( ( a, b ) => b[1].modelConfidence - a[1].modelConfidence )

      for( const [ id ] of sorted.slice( this._maxModeledAgents ) )
        this._models.delete( id )
    }
  }
}
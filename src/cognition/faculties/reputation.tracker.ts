// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/reputation.tracker.ts
// ─────────────────────────────────────────────────────────────

/**
 * ReputationTracker — maintains models of others' reliability,
 * cooperativeness, and social standing.
 *
 * Tracks per-agent:
 *   - Reliability (did they do what they said they would?)
 *   - Cooperativeness (did they help or hinder?)
 *   - Social standing (how do others seem to regard them?)
 *   - Trustworthiness (composite of reliability + cooperativeness)
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
import { readEffectiveParams } from '#cognition/persona.prior'

export interface ReputationTrackerConfig {
  /** Maximum agents to track */
  maxTrackedAgents?: number
  /** How quickly reputation decays without new observations */
  decayRate?: number
  /** Minimum interactions before reputation is considered reliable */
  minInteractions?: number
  /** How much a cooperative interaction raises a tracked agent's cooperativeness (trust step) */
  trustGrowthStep?: number
  bus?: CognitiveBus
}

interface Reputation {
  keid: string
  reliability: number       // 0-1: keeps promises
  cooperativeness: number   // 0-1: helps vs. hinders
  socialStanding: number    // 0-1: regarded by others
  trustworthiness: number   // 0-1: composite
  interactionCount: number
  positiveInteractions: number
  negativeInteractions: number
  lastInteractionTick: Tick
  confidence: number        // 0-1: how confident in this assessment
}

export class ReputationTracker implements SimulationEngine, CognitiveEngine {
  readonly name     = 'reputation-tracker'
  
  private _maxTrackedAgents: number
  private _decayRate: number
  private _minInteractions: number
  private _trustGrowthStep: number

  private _reputations = new Map<string, Reputation>()
  /** True after reputations have been rehydrated from persisted state on first tick. */
  private _restored = false
  private _pendingInteractions: Array<{
    keid: string; valence: number; intensity: number; directedAtSelf: boolean
  }> = []

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: ReputationTrackerConfig = {} ){
    this._bus = config.bus ?? null
    this._maxTrackedAgents = config.maxTrackedAgents ?? 20
    this._decayRate        = config.decayRate        ?? 0.001
    this._minInteractions  = config.minInteractions  ?? 3
    this._trustGrowthStep  = config.trustGrowthStep  ?? 0.05
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
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('social') )
        this._model.setPrecision('reputation.tracked', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'interaction.occurred'){
      const p = e.payload as { keid: string; valence: number; intensity: number; directedAtSelf: boolean }
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

    // Channel A (agreeableness → trust): how much a cooperative interaction raises an
    // agent's cooperativeness is refreshed each tick as base ⊕ persona-prior. An agreeable
    // Will develops a larger step — it extends benefit-of-the-doubt and credits cooperation
    // more readily (the trust facet).
    this._trustGrowthStep = readEffectiveParams( state, 'engine-config-reputation').trustGrowthStep ?? this._trustGrowthStep

    // Rehydrate _reputations from persisted state on the first tick after
    // construction / snapshot restore. Without this, every session restart
    // begins with an empty reputation map and immediately overwrites all
    // saved relationship data with zeros on the first persist cycle.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    // 1. Drain buffered interactions to update reputations
    for( const interaction of this._pendingInteractions.splice( 0 ) ){
      const { keid, valence } = interaction
      if( !keid || keid === 'agent-self') continue

      const rep = this._getOrCreate( keid, tick )

      rep.interactionCount++
      rep.lastInteractionTick = tick

      if( valence > 0 ){
        rep.positiveInteractions++
        rep.cooperativeness = Math.min( 1, rep.cooperativeness + this._trustGrowthStep )
      }

      if( valence < -0.3 ){
        rep.negativeInteractions++
        rep.cooperativeness = Math.max( 0, rep.cooperativeness - 0.08 )
      }

      // Reliability proxy: strong positive valence → consistent/reliable behaviour;
      // strong negative → deceptive/unreliable. The original used explicit `reliable`
      // and `deceptive` metadata flags on percept entities; those aren't in interaction.occurred,
      // so we use extreme valence as the best available signal.
      if( valence > 0.7 )
        rep.reliability = Math.min( 1, rep.reliability + 0.04 )
      else if( valence < -0.7 )
        rep.reliability = Math.max( 0, rep.reliability - 0.08 )

      // Composite trustworthiness
      rep.trustworthiness = ( rep.reliability * 0.5 + rep.cooperativeness * 0.5 )

      // Confidence increases with more interactions
      rep.confidence = Math.min( 1, rep.interactionCount / this._minInteractions )
    }

    // 2. Decay old reputations
    for( const rep of this._reputations.values() ){
      const ticksSince = tick - rep.lastInteractionTick
      if( ticksSince > 200 ){
        rep.confidence = Math.max( 0.05, rep.confidence - this._decayRate * ticksSince )
      }
    }

    // 3. Prune
    this._prune()

    // 4. Persist
    for( const rep of this._reputations.values() ){
      if( rep.interactionCount === 0 ) continue

      commands.set!.push({
        id: `reputation-${rep.keid}`,
        type:     'reputation',
        metadata: {
          keid:              rep.keid,
          reliability:          rep.reliability,
          cooperativeness:      rep.cooperativeness,
          socialStanding:       rep.socialStanding,
          trustworthiness:      rep.trustworthiness,
          interactionCount:     rep.interactionCount,
          positiveInteractions: rep.positiveInteractions,
          negativeInteractions: rep.negativeInteractions,
          lastInteractionTick:  rep.lastInteractionTick,
          confidence:           rep.confidence,
          tick,
        },
      })
    }

    commands.metrics!.push(
      [ 'reputation.tracked_agents', this._reputations.size ],
    )


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._reputations.size > 0 ){
      const predErr = this._model.observe('reputation.tracked', this._reputations.size )
      if( !predErr.gated )
        _bus.publish({ type: 'reputation.updated', version: 1, sourceEngine: this.name, salience: Math.max( 0.2, predErr.salience ), payload: { trackedAgents: this._reputations.size } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Public API ───────────────────────────────────────────

  getReputation( keid: string ): Reputation | undefined {
    return this._reputations.get( keid )
  }

  isTrusted( keid: string, threshold: number = 0.5 ): boolean {
    const rep = this._reputations.get( keid )
    return ( rep?.trustworthiness ?? 0.5 ) >= threshold
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Rehydrate _reputations from 'reputation' entities in state.
   * Called once on the first tick after snapshot restore so that relationship
   * models formed in previous sessions survive a server restart.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'reputation') continue
      const m = entity.metadata ?? {}
      const keid = m['keid'] as string | undefined
      if( !keid ) continue
      if( this._reputations.has( keid ) ) continue  // prefer in-memory if already present

      this._reputations.set( keid, {
        keid,
        reliability:          ( m['reliability']          as number ) ?? 0.5,
        cooperativeness:      ( m['cooperativeness']      as number ) ?? 0.5,
        socialStanding:       ( m['socialStanding']       as number ) ?? 0.5,
        trustworthiness:      ( m['trustworthiness']      as number ) ?? 0.5,
        interactionCount:     ( m['interactionCount']     as number ) ?? 0,
        positiveInteractions: ( m['positiveInteractions'] as number ) ?? 0,
        negativeInteractions: ( m['negativeInteractions'] as number ) ?? 0,
        lastInteractionTick:  ( m['lastInteractionTick']  as number ) ?? 0,
        confidence:           ( m['confidence']           as number ) ?? 0.1,
      })
    }
  }

  private _getOrCreate( keid: string, tick: Tick ): Reputation {
    const existing = this._reputations.get( keid )
    if( existing ) return existing

    const rep: Reputation = {
      keid,
      reliability: 0.5,
      cooperativeness: 0.5,
      socialStanding: 0.5,
      trustworthiness: 0.5,
      interactionCount: 0,
      positiveInteractions: 0,
      negativeInteractions: 0,
      lastInteractionTick: tick,
      confidence: 0.1,
    }

    this._reputations.set( keid, rep )
    return rep
  }

  private _prune(): void {
    if( this._reputations.size <= this._maxTrackedAgents ) return

    const sorted = Array.from( this._reputations.entries() )
      .sort( ( a, b ) => b[1].interactionCount - a[1].interactionCount )

    for( const [ id ] of sorted.slice( this._maxTrackedAgents ) )
      this._reputations.delete( id )
  }
}
// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/dream.simulator.ts
// ─────────────────────────────────────────────────────────────

/**
 * DreamSimulator — reactivates and recombines memory traces during rest.
 *
 * Functions:
 *   - Memory reactivation: replays recent episodic memories
 *   - Emotional processing: dampens emotional charge of memories
 *   - Creative recombination: randomly associates related memories
 *   - Consolidation boost: strengthens reactivated memories
 *
 * Only active during sleep/rest states.
 * Models the hippocampal-neocortical dialogue during slow-wave sleep
 * and the emotional processing of REM sleep.
 *
 * Part of Shard 2 (Memory Layer) — runs every tick when sleeping.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  SeededPRNG,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { EpisodicConsolidator, EpisodicMemory } from '#faculties/episodic.consolidator'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

export interface DreamSimulatorConfig {
  /** Maximum memories to reactivate per tick */
  maxReactivationsPerTick?: number
  /** How much emotional dampening per reactivation */
  emotionalDampeningRate?: number
  /** Probability of creative recombination between two memories */
  recombinationProbability?: number
  bus?: CognitiveBus
}

export class DreamSimulator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'dream-simulator'
  
  private _maxReactivationsPerTick: number
  private _emotionalDampeningRate: number
  private _recombinationProbability: number

  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _lastReactivationIndex = 0
  private _isSleeping: boolean = false

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: DreamSimulatorConfig = {} ){
    this._bus = config.bus ?? null
    this._maxReactivationsPerTick  = config.maxReactivationsPerTick  ?? 5
    this._emotionalDampeningRate   = config.emotionalDampeningRate   ?? 0.05
    this._recombinationProbability = config.recombinationProbability ?? 0.1
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Reference to episodic consolidator ───────────────────

  attachConsolidator( consolidator: EpisodicConsolidator ): void {
    this._episodicConsolidator = consolidator
  }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'sleep.begun',
      'sleep.ended',
    ]
  }

  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('memory') )
        this._model.setPrecision( 'dream.reactivation', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'sleep.begun' ) this._isSleeping = true
    if( e.type === 'sleep.ended' ) this._isSleeping = false
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    _delta: Duration,
    tick: Tick,
    _state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    if( !this._isSleeping || !this._episodicConsolidator )
      return { commands }

    const allEpisodes = this._episodicConsolidator.getAllEpisodes()
    if( allEpisodes.length === 0 )
      return { commands }

    let reactivated = 0
    let recombinations = 0

    // Working copies of only the episodes we touch this tick. We never mutate the
    // shared objects getAllEpisodes() handed us (they may be held by other engines
    // this tick) — instead we mutate drafts and commit them through the owning
    // consolidator as an immutable replace (mirrors ForgettingCurve.applyDecay).
    type Draft = { activationStrength: number; emotionalTags: Record<string, number>; tags: string[] }
    const drafts = new Map<string, Draft>()
    const draftOf = ( ep: EpisodicMemory ): Draft => {
      let d = drafts.get( ep.id )
      if( !d ){
        d = { activationStrength: ep.activationStrength, emotionalTags: { ...ep.emotionalTags }, tags: [ ...ep.tags ] }
        drafts.set( ep.id, d )
      }
      return d
    }

    // 1. Select memories for reactivation (biased toward recent + emotional)
    const candidates = this._selectForReactivation( allEpisodes )

    for( let i = 0; i < Math.min( this._maxReactivationsPerTick, candidates.length ); i++ ){
      const episode = candidates[i]!
      if( !episode ) continue

      const d = draftOf( episode )

      // Reactivate: boost strength slightly
      d.activationStrength = Math.min( 1, d.activationStrength + 0.03 )

      // Emotional dampening: reduce emotional charge (processing)
      for( const emotion of Object.keys( d.emotionalTags ) ){
        const current = d.emotionalTags[ emotion ] ?? 0
        if( Math.abs( current ) > 0.05 )
          d.emotionalTags[ emotion ] = current * ( 1 - this._emotionalDampeningRate )
      }

      reactivated++

      // 2. Creative recombination: randomly pair with another memory.
      // Draws from the seeded PRNG (not Math.random) so a run replays identically.
      if( context.prng.nextBool( this._recombinationProbability ) ){
        const other = this._pickRandomMemory( allEpisodes, episode, context.prng )
        if( other ){
          // Create a novel association — boost both memories slightly
          const od = draftOf( other )
          d.activationStrength  = Math.min( 1, d.activationStrength + 0.02 )
          od.activationStrength = Math.min( 1, od.activationStrength + 0.02 )

          // Add each other's tags (cross-pollination)
          for( const tag of od.tags ){
            if( !d.tags.includes( tag ) )
              d.tags.push( tag )
          }

          recombinations++
        }
      }
    }

    // Commit all drafts atomically through the store owner (immutable replace).
    this._episodicConsolidator.applyDreamUpdates( drafts )

    // 3. Update pointer for next tick
    this._lastReactivationIndex = ( this._lastReactivationIndex + reactivated ) % Math.max( 1, allEpisodes.length )

    commands.metrics!.push(
      [ 'dream.reactivated', reactivated ],
      [ 'dream.recombinations', recombinations ],
    )

    if( reactivated > 0 && reactivated >= 3 )
      events.push({
        type: 'dream.activity',
        source: this.name,
        payload: { reactivated, recombinations },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && reactivated > 0 ){
      const predErr = this._model.observe( 'dream.reactivation', reactivated )
      if( !predErr.gated )
        _bus.publish({ type: 'dream.active', version: 1, sourceEngine: this.name, salience: Math.max( 0.3, predErr.salience ), payload: { reactivated } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  private _selectForReactivation( episodes: ReadonlyArray<EpisodicMemory> ): EpisodicMemory[] {
    // Score each episode for reactivation priority
    const scored = episodes.map( ep => ({
      episode: ep,
      score: this._reactivationScore( ep ),
    }))

    // Sort by score (highest first)
    scored.sort( ( a, b ) => b.score - a.score )

    return scored.slice( 0, this._maxReactivationsPerTick * 3 ).map( s => s.episode )
  }

  private _reactivationScore( episode: EpisodicMemory ): number {
    const
    emotionalIntensity = Object.values( episode.emotionalTags )
                           .reduce( ( s, v ) => s + Math.abs( v ), 0 )
                         / Math.max( 1, Object.keys( episode.emotionalTags ).length ),
    recency = 1,  // All episodes are in the store; recency implicit by position
    retrievalCount = Math.min( 1, episode.retrievalCount / 10 ),
    novelty = 1 - retrievalCount  // Less retrieved = more need for reactivation

    return emotionalIntensity * 0.4
         + recency * 0.3
         + novelty * 0.3
  }

  private _pickRandomMemory(
    episodes: ReadonlyArray<EpisodicMemory>,
    exclude: EpisodicMemory,
    prng: SeededPRNG
  ): EpisodicMemory | null {
    // Pick a memory that shares at least one tag with the source
    const related = episodes.filter( ep =>
      ep.id !== exclude.id
      && ep.tags.some( t => exclude.tags.includes( t ) )
    )

    if( related.length === 0 ) return null

    return related[ prng.nextInt( 0, related.length ) ]!
  }
}
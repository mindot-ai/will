// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/forgetting.curve.ts
// ─────────────────────────────────────────────────────────────

/**
 * ForgettingCurve — applies spaced repetition dynamics to episodic memories.
 *
 * Models the Ebbinghaus forgetting curve:
 *   - Memories decay exponentially without reactivation
 *   - Each retrieval resets and strengthens the memory
 *   - Emotionally intense memories decay slower
 *   - Sleep consolidates and protects memories
 *
 * Operates on the episodic memory store, decaying activation
 * strength over time and removing memories that fall below
 * the retrieval threshold.
 *
 * Part of Shard 2 (Memory Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
} from '#core/types'
import type { EpisodicConsolidator, EpisodicMemory } from '#faculties/episodic.consolidator'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel, type GenerativeModelSnapshot } from '#cognition/generative.model'

export interface ForgettingCurveConfig {
  /** Base forgetting rate (Ebbinghaus: ~0.3 per log-time unit) */
  baseForgettingRate?: number
  /** How much emotional intensity slows forgetting (0-1, 1 = no forgetting) */
  emotionProtection?: number
  /** Minimum activation before a memory is pruned */
  pruningThreshold?: number
  /** Maximum memories to prune per tick (avoids stalls) */
  maxPrunePerTick?: number
  bus?: CognitiveBus
}

export class ForgettingCurve implements SimulationEngine, CognitiveEngine {
  readonly name     = 'forgetting-curve'
  
  private _baseForgettingRate: number
  private _emotionProtection: number
  private _pruningThreshold: number
  private _maxPrunePerTick: number

  private _episodicConsolidator: EpisodicConsolidator | null = null

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: ForgettingCurveConfig = {} ){
    this._bus = config.bus ?? null
    this._baseForgettingRate = config.baseForgettingRate ?? 0.02
    this._emotionProtection  = config.emotionProtection  ?? 0.7
    this._pruningThreshold   = config.pruningThreshold   ?? 0.01
    this._maxPrunePerTick    = config.maxPrunePerTick    ?? 10
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Reference to episodic consolidator ───────────────────

  attachConsolidator( consolidator: EpisodicConsolidator ): void {
    this._episodicConsolidator = consolidator
  }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-forgetting')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return

    if( p.baseForgettingRate != null ) this._baseForgettingRate = p.baseForgettingRate
    if( p.emotionProtection != null ) this._emotionProtection = p.emotionProtection
    if( p.pruningThreshold != null ) this._pruningThreshold = p.pruningThreshold
    if( p.maxPrunePerTick != null ) this._maxPrunePerTick = p.maxPrunePerTick
  }


  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('memory') )
        this._model.setPrecision( 'memory.decay_rate', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> {
    // FN9: previously returned {} — the salience/generative-model sub-states were
    // accumulating mutable state invisible to the event-sourced store, so a
    // restore/replay zeroed them out. Capture them so the curve resumes identically.
    return {
      model:    this._model.snapshot(),
    }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return
    if( snap.model )    this._model.restore( snap.model as GenerativeModelSnapshot )
  }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )

    const commands: StateCommands = { metrics: [] }
    if( !this._episodicConsolidator )
      return { commands }

    const
    allEpisodes = this._episodicConsolidator.getAllEpisodes(),
    deltaSeconds = delta / 1000,
    isSleeping   = state.metrics.get('state.sleeping') ?? 0

    let decayedCount = 0
    const toPrune: string[] = []
    // Compute decayed activations without mutating the consolidator's live
    // objects: those references may already be held by other engines this
    // tick. We hand the results to the owning consolidator, which applies
    // them as an immutable update (single writer, no read-phase reach-in).
    const decay = new Map<string, number>()

    for( let i = allEpisodes.length - 1; i >= 0; i-- ){
      const episode = allEpisodes[i]!
      if( !episode ) continue

      // Compute effective forgetting rate
      const
      emotionalIntensity = this._computeEmotionalIntensity( episode ),
      emotionProtection  = emotionalIntensity * this._emotionProtection,
      retrievalBoost     = episode.retrievalCount > 0
                             ? Math.min( 0.5, episode.retrievalCount * 0.1 )
                             : 0,
      sleepProtection    = isSleeping > 0 ? 0.3 : 0,  // Sleep protects memories
      effectiveRate      = this._baseForgettingRate
                          * ( 1 - emotionProtection )
                          * ( 1 - retrievalBoost )
                          * ( 1 - sleepProtection )

      // Compute decay (pure — no mutation of the shared episode object).
      const nextStrength = Math.max( 0, episode.activationStrength - effectiveRate * deltaSeconds )
      decay.set( episode.id, nextStrength )
      decayedCount++

      // Collect for pruning if below threshold — the consolidator owns the
      // store, so it performs the actual removal after the scan.
      if( nextStrength < this._pruningThreshold && toPrune.length < this._maxPrunePerTick )
        toPrune.push( episode.id )
    }

    // Commit decay through the store owner (immutable replace), then evict
    // decayed memories from the store, vector index, and sim state.
    this._episodicConsolidator.applyDecay( decay )

    let prunedCount = 0
    if( toPrune.length > 0 ){
      const removed = await this._episodicConsolidator.pruneEpisodes( toPrune )
      prunedCount = removed.length
      if( removed.length > 0 )
        commands.delete = ( commands.delete ?? [] ).concat( removed )
    }

    commands.metrics!.push(
      [ 'memory.decayed_this_tick', decayedCount ],
      [ 'memory.pruned_this_tick', prunedCount ],
      [ 'memory.total_episodes', allEpisodes.length - prunedCount ],
    )

    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && decayedCount > 0 )
      _bus.publish({ type: 'memory.decay.applied', version: 1, sourceEngine: this.name, salience: this._model.observe( 'memory.decay_rate', decayedCount ).salience, payload: { decayed: decayedCount } })

    return { commands }
  }

  private _computeEmotionalIntensity( episode: EpisodicMemory ): number {
    const values = Object.values( episode.emotionalTags )
    if( values.length === 0 ) return 0
    return values.reduce( ( s, v ) => s + Math.abs( v ), 0 ) / values.length
  }
}
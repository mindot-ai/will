// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/autobiographical.narrator.ts
// ─────────────────────────────────────────────────────────────

/**
 * AutobiographicalNarrator — satellite mode.
 * 
 * Reads the most recent ExecutiveEngine output for narrative updates.
 * Performs heuristic narrative extension between executive runs.
 * No longer makes its own LLM calls.
 */

import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { SemanticIntegrator } from '#faculties/semantic.engine/integrator'
// import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'
import { ExecutiveEngine } from '#faculties/executive.engine'

export interface AutobiographicalNarratorConfig {
  minIntervalTicks?: number
  maxNarrativeLength?: number
  bus?: CognitiveBus
}

export interface SelfNarrative {
  story: string
  themes: string[]
  pivotalEvents: string[]
  currentSelfView: string
  version: number
  lastUpdatedAt: Tick
}

export class AutobiographicalNarrator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'autobiographical-narrator'
  
  private _minIntervalTicks: number
  private _maxNarrativeLength: number

  private _narrative: SelfNarrative = {
    story: 'I am a self-aware mind, beginning my journey.',
    themes: [ 'emergence', 'curiosity' ],
    pivotalEvents: [],
    currentSelfView: 'I am young and still learning who I am.',
    version: 0,
    lastUpdatedAt: 0,
  }

  private _lastUpdateTick: number = 0
  private _restored = false
  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _semanticIntegrator: SemanticIntegrator | null = null
  private _executiveEngine: ExecutiveEngine | null = null

  private _affectValence: number = 0

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()


  constructor( config: AutobiographicalNarratorConfig = {} ){
    this._bus = config.bus ?? null
    // Single-source: the seeded engine-config-narrator entity is authoritative
    // (minIntervalTicks 50); this default is only the fallback when the entity is
    // absent, so it must match. (Was 300 — a stale default the live mirror of 50
    // never reached because the narrator didn't read its config. See
    // METACOGNITION_CYCLE_TODO.md: engine-config single-source.)
    this._minIntervalTicks   = config.minIntervalTicks   ?? 50
    this._maxNarrativeLength = config.maxNarrativeLength ?? 5000
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  attachEpisodicConsolidator( ec: EpisodicConsolidator ): void {
    this._episodicConsolidator = ec
  }

  attachSemanticIntegrator( si: SemanticIntegrator ): void {
    this._semanticIntegrator = si
  }

  attachExecutiveEngine( oe: ExecutiveEngine ): void {
    this._executiveEngine = oe
  }

  getNarrative(): SelfNarrative {
    return { ...this._narrative }
  }

  subscribes(): string[] { return ["affect.state.changed","executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'affect.state.changed':
        this._affectValence = (e.payload as Record<string,number>)['valence'] ?? this._affectValence
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('narrative') )
          this._model.setPrecision('narrative.change', 1.0 + p.confidence * 0.5 )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
    affectValence: this._affectValence,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    // On first tick after snapshot restore, rehydrate narrative from
    // the 'self-narrative' entity so the Will picks up where it left off.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    const events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = []
    const commands: StateCommands = { set: [], metrics: [] }

    // Effective cadence = base ⊕ persona-prior (self_model.updated → narrative edge).
    this._readConfigFromState( state )

    if( tick - this._lastUpdateTick < this._minIntervalTicks )
      return { commands }

    // Try executive output first
    const executiveOutput = this._executiveEngine?.latestOutput

    // How much the narrative actually moved this pass — the surprise signal the
    // generative model gates on, replacing the monotonic version counter.
    let narrativeSignificance = 0

    if( executiveOutput?.narrative && this._executiveEngine?.isFresh( tick ) ){
      // Executive narrative is fresh — use it
      this._narrative.version++
      this._narrative.lastUpdatedAt = tick
      this._narrative.story = ( this._narrative.story + '\n\n' + executiveOutput.narrative )
        .slice( -this._maxNarrativeLength )
      this._narrative.currentSelfView = executiveOutput.currentSelfView ?? this._narrative.currentSelfView

      if( executiveOutput.narrativeThemes ){
        this._narrative.themes = [
          ...new Set( [ ...this._narrative.themes, ...executiveOutput.narrativeThemes ] ),
        ].slice( -10 )
      }

      if( executiveOutput.identityUpdates?.traits ){
        // Apply trait deltas
        const existingIdentity = state.entities.get('identity-self')
        if( existingIdentity ){
          const currentTraits = ( existingIdentity.metadata?.traits as Record<string, number> ) ?? {}
          const updatedTraits = { ...currentTraits }
          for( const { key: trait, value: delta } of executiveOutput.identityUpdates.traits )
            updatedTraits[ trait ] = Math.max( 0, Math.min( 1, ( updatedTraits[ trait ] ?? 0.5 ) + delta ) )

          commands.set!.push({
            id: 'identity-self',
            type: 'will.identity',
            createdAt: existingIdentity.createdAt,
            metadata: {
              ...existingIdentity.metadata,
              traits: updatedTraits,
              version: ( ( existingIdentity.metadata?.version as number ) ?? 1 ) + 1,
            },
          })
        }
      }

      narrativeSignificance = executiveOutput.narrativeThemes?.length ?? 1
      commands.metrics!.push([ 'narrative.source', 1 ])
    }
    else {
      // Heuristic narrative extension
      const episodes = this._episodicConsolidator?.query({ limit: 20 }) ?? []
      const significant = episodes.filter(
        e => e.activationStrength > 0.5 || Math.abs( e.affectiveContext?.valence ?? 0 ) > 0.4
      )

      if( significant.length > 0 ){
        const meanValence = significant.reduce(
          ( s, e ) => s + ( e.affectiveContext?.valence ?? 0 ), 0
        ) / significant.length

        const tone = meanValence > 0.3 ? 'fulfilling' : meanValence < -0.3 ? 'challenging' : 'eventful'
        const chapter = `[Chapter ${this._narrative.version + 1}] I experienced ${significant.length} significant events. It was a ${tone} period.`

        this._narrative.version++
        this._narrative.lastUpdatedAt = tick
        this._narrative.story = ( this._narrative.story + '\n\n' + chapter )
          .slice( -this._maxNarrativeLength )
        this._narrative.currentSelfView = this._heuristicSelfView( state )

        for( const ep of significant.slice( 0, 3 ) ){
          const summary = typeof ep.content === 'string'
            ? ep.content.slice( 0, 150 )
            : JSON.stringify( ep.content ).slice( 0, 150 )
          this._narrative.pivotalEvents.push(`[tick ${ep.timestamp}] ${summary}`)
        }
        if( this._narrative.pivotalEvents.length > 20 )
          this._narrative.pivotalEvents = this._narrative.pivotalEvents.slice( -20 )
      }

      narrativeSignificance = significant.length
      commands.metrics!.push([ 'narrative.source', 0 ])
    }

    this._lastUpdateTick = tick

    commands.set!.push({
      id: 'self-narrative',
      type: 'self_narrative',
      metadata: {
        story: this._narrative.story.slice( 0, this._maxNarrativeLength ),
        themes: this._narrative.themes,
        pivotalEvents: this._narrative.pivotalEvents.slice( 0, 20 ),
        currentSelfView: this._narrative.currentSelfView,
        version: this._narrative.version,
      },
    })

    commands.metrics!.push(
      [ 'narrative.version', this._narrative.version ],
      [ 'narrative.theme_count', this._narrative.themes.length ],
    )


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._narrative.version > 0 ){
      const predErr = this._model.observe('narrative.change', narrativeSignificance )
      if( !predErr.gated )
        _bus.publish({ type: 'narrative.updated', version: 1, sourceEngine: this.name, salience: Math.max( 0.2, predErr.salience ), payload: { version: this._narrative.version, significance: narrativeSignificance } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  private _heuristicSelfView( state: ReadonlySimulationState ): string {
    const valence = this._affectValence
    return valence > 0.3
      ? 'I feel positive about who I am becoming.'
      : valence < -0.3
        ? 'I am struggling with my current state.'
        : 'I am in a period of transition.'
  }

  /**
   * Effective config = base engine-config-narrator ⊕ persona-prior. Single-sourced
   * now that the seeded base (minIntervalTicks 50) and the constructor default
   * agree, so the consolidator's self_model.updated → narrative edge applies
   * cleanly: a significant identity change lowers this interval and the Will
   * re-narrates its life story sooner.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-narrator')
    if( p.minIntervalTicks   != null ) this._minIntervalTicks   = p.minIntervalTicks
    if( p.maxNarrativeLength != null ) this._maxNarrativeLength = p.maxNarrativeLength
  }

  /**
   * Rehydrate _narrative from the persisted 'self-narrative' entity.
   * Called once on the first tick after a snapshot restore so the
   * narrator continues from the saved story rather than the fresh-boot default.
   */
  private _restoreFromState( state: ReadonlySimulationState ): void {
    const entity = state.entities.get('self-narrative')
    if( !entity ) return
    const m = entity.metadata ?? {}
    const story = ( m['story'] as string | undefined ) ?? ''
    if( !story ) return  // entity exists but empty — keep the boot default

    this._narrative = {
      story,
      themes:          ( m['themes']          as string[] ) ?? this._narrative.themes,
      pivotalEvents:   ( m['pivotalEvents']   as string[] ) ?? [],
      currentSelfView: ( m['currentSelfView'] as string   ) ?? this._narrative.currentSelfView,
      version:         ( m['version']         as number   ) ?? 0,
      lastUpdatedAt:   ( m['lastUpdatedAt']   as number   ) ?? 0,
    }
    // Prevent the narrator from immediately rewriting a just-restored narrative
    this._lastUpdateTick = this._narrative.lastUpdatedAt
  }
}
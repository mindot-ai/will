// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/exteroception.ts
// ─────────────────────────────────────────────────────────────

/**
 * Exteroception — processes external world events into structured percepts.
 *
 * Scans the event bus and entity space for:
 *   - New entities entering the world
 *   - Changes to existing entities
 *   - Explicit events (messages, notifications, environmental changes)
 *   - Other agents' observable actions
 *
 * Each percept is an entity with salience tagging, enabling downstream
 * engines (Attention, Affective, Memory) to prioritize processing.
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  Timestamp,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
  SimulationEntity,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { CONSEQUENCE_TYPE, ATTENUATION, liveConsequences, matchConsequenceText } from '#agency/consequence'
import { REVOCATION_TYPE } from '#agency/revocation'

export interface ExteroceptionConfig {
  /** Maximum percepts to produce per tick */
  maxPerceptsPerTick?: number
  /** Default salience for unmarked percepts */
  defaultSalience?: number
  /** Whether to emit percept events */
  emitPerceptEvents?: boolean
  /** Entity types to always treat as high-salience */
  highPriorityTypes?: string[]
  bus?: CognitiveBus
}

interface RawPercept {
  entityId: string
  changeType: 'appeared' | 'modified' | 'removed'
  salience: number
  category: string
  summary: string
  /** Text the corollary-discharge matcher inspects (entity content ≻ description ≻ summary). */
  matchText?: string
}

// Skip internal entities — they're not external percepts.
// Percepts about percepts create a feedback loop that floods
// working memory and episodic storage with noise.
const internalTypes = new Set([
  'percept', 'percept.social', 'working_memory.item',
  'interoception', 'attention.focus', 'decision.record',
  'task.focus', 'self_observation',
  'goal', 'belief', 'plan', 'narrative_chapter',
  'introspection', 'self_narrative', 'cognitive_bias',
  'effector.created', 'empathic_state', 'attachment.bond',
  'theory_of_mind', 'reputation', 'episodic_memory',
  // Internal state entities written by our own engines — not external events
  'affect.blends', 'executive.summary',
  // The agency's own forward-model records (EXAFFERENCE P1/P2): perceiving our
  // expected-consequence descriptors would be a self-noise loop.
  CONSEQUENCE_TYPE,
  // The agency's own revocation tombstones (EXAFFERENCE P4) — internal bookkeeping.
  REVOCATION_TYPE,
])

export class Exteroception implements SimulationEngine, CognitiveEngine {
  readonly name     = 'exteroception'
  
  private _maxPerceptsPerTick: number
  private _defaultSalience: number
  private _emitPerceptEvents: boolean
  private _highPriorityTypes: Set<string>
  private _previousEntityVersions = new Map<string, number>()  // entityId → updatedAt

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: ExteroceptionConfig = {} ){
    this._bus = config.bus ?? null
    this._maxPerceptsPerTick = config.maxPerceptsPerTick ?? 50
    this._defaultSalience    = config.defaultSalience    ?? 0.3
    this._emitPerceptEvents  = config.emitPerceptEvents  ?? true
    this._highPriorityTypes  = new Set( config.highPriorityTypes ?? [
      'message', 'notification', 'alert', 'threat', 'goal',
    ])
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] {
    return [{ type: 'percept.category.updated', version: 1, validate: () => null }]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('perception') )
        this._model.setPrecision('percept.rate', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], delete: [], metrics: [] }

    const rawPercepts = this._scanWorld( state )

    // Cap percepts per tick
    const capped = rawPercepts.slice( 0, this._maxPerceptsPerTick )

    // Corollary discharge (EXAFFERENCE P2): everything this engine perceives is
    // world-ingress afference — split it. A percept matching a live expected-
    // consequence descriptor is *reafferent* (our own action's sensory footprint:
    // the channel echo, a quote-back) and its salience is attenuated, not zeroed;
    // everything else is *exafferent* — the world moved on its own. Endogenous
    // percepts (working memory, escalations) are created elsewhere and stay
    // untagged: they are neither.
    const consequences = liveConsequences( state.entities, tick )

    // Convert raw percepts to entities
    for( let i = 0; i < capped.length; i++ ){
      const rp = capped[i]!

      const hit = consequences.length > 0 && rp.matchText
        ? matchConsequenceText( consequences, rp.matchText )
        : null
      const salience = hit ? rp.salience * ATTENUATION : rp.salience

      const perceptEntity = {
        id: `percept-${tick}-${i}`,
        type: 'percept',
        metadata: {
          entityId: rp.entityId,
          changeType: rp.changeType,
          salience,
          category: rp.category,
          summary: rp.summary,
          provenance: hit ? 'reafferent' : 'exafferent',
          ...( hit ? { sourceIntentId: hit.intentId } : {} ),
          tick,
        },
      }

      commands.set!.push( perceptEntity )

      // Emit percept event for downstream engines
      if( this._emitPerceptEvents )
        events.push({
          type: `percept.${rp.changeType}.${rp.category}`,
          source: this.name,
          payload: {
            entityId: rp.entityId,
            salience,
            category: rp.category,
            summary: rp.summary,
          },
        })
    }

    // Clean up old percepts from previous ticks (keep last 2 ticks of percepts)
    commands.delete = this._collectStalePerceptIds( state, tick )

    // Aggregate metrics
    commands.metrics!.push(
      [ 'perception.percepts_this_tick', capped.length ],
      [ 'perception.total_entities_observed', state.entities.size ],
    )


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && capped.length > 0 ){
      const predErr = this._model.observe('percept.rate', capped.length )
      if( !predErr.gated )
        _bus.publish({ type: 'percept.batch.ingested', version: 1, sourceEngine: this.name, salience: Math.max( 0.2, predErr.salience ), payload: { count: capped.length } })
    }

    // percept.category.updated — one event per distinct category so subscribers
    // (aesthetic.evaluator etc.) get a structured signal without scanning percepts
    if( _bus && capped.length > 0 ){
      const countByCategory = new Map<string, number>()
      for( const rp of capped )
        countByCategory.set( rp.category, ( countByCategory.get( rp.category ) ?? 0 ) + 1 )
      for( const [ category, count ] of countByCategory )
        _bus.publish({ type: 'percept.category.updated', version: 1, sourceEngine: this.name, salience: Math.min( 1, count * 0.15 + 0.2 ), payload: { category, count } })
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Scan the world for perceptible changes.
   * Compares current entity state against previous versions.
   */
  // In _scanWorld(), replace the entity loop with this:

private _scanWorld( state: ReadonlySimulationState ): RawPercept[] {
    const percepts: RawPercept[] = []
    const currentIds = new Set<string>()

    for( const [ id, entity ] of state.entities ){
      currentIds.add( id )

      if( internalTypes.has( entity.type ) ){
        // Still track the version so we don't get "appeared" events
        // when these internal entities are first created
        this._previousEntityVersions.set( id, entity.updatedAt )
        continue
      }

      const previousVersion = this._previousEntityVersions.get( id )

      if( previousVersion === undefined ){
        percepts.push({
          entityId: id,
          changeType: 'appeared',
          salience: this._computeSalience( entity, 'appeared', state.time ),
          category: entity.type,
          summary: this._summarizeEntity( entity, 'appeared'),
          matchText: this._matchText( entity ),
        })
      }
      else if( entity.updatedAt > previousVersion ){
        percepts.push({
          entityId: id,
          changeType: 'modified',
          salience: this._computeSalience( entity, 'modified', state.time ),
          category: entity.type,
          summary: this._summarizeEntity( entity, 'modified'),
          matchText: this._matchText( entity ),
        })
      }

      this._previousEntityVersions.set( id, entity.updatedAt )
    }

    // Detect removed entities (not internal types)
    for( const [ id ] of this._previousEntityVersions ){
      if( !currentIds.has( id ) ){
        // Only report removal of meaningful entities
        // We can't check the type here since the entity is gone,
        // but we can infer from the ID prefix
        if( !id.startsWith('percept-') 
            && !id.startsWith('wm-')
            && !id.startsWith('attention-')
            && !id.startsWith('decision-')
            && !id.startsWith('interoception-')
            && !id.startsWith('task-')
            && !id.startsWith('self-obs-') ){
          percepts.push({
            entityId: id,
            changeType: 'removed',
            salience: 0.4,
            category: 'removed',
            summary: `Entity removed: ${id}`,
          })
        }
        this._previousEntityVersions.delete( id )
      }
    }

    percepts.sort( ( a, b ) => b.salience - a.salience )
    return percepts
  }

  /**
   * Generate a meaningful summary for an entity.
   * Instead of "New percept: percept-54-0", produce something useful.
   */
  /**
   * The text the corollary-discharge matcher inspects for this entity — its
   * content (a message body) over its description over its summary. Where our
   * own delivered words would surface if the world echoes them back.
   */
  private _matchText( entity: Readonly<SimulationEntity> ): string | undefined {
    const m = entity.metadata as Record<string, unknown> | undefined
    const content     = typeof m?.['content']     === 'string' ? m['content']     as string : undefined
    const description = typeof m?.['description'] === 'string' ? m['description'] as string : undefined
    const summary     = typeof m?.['summary']     === 'string' ? m['summary']     as string : undefined
    return content ?? description ?? summary
  }

  private _summarizeEntity(
    entity: Readonly<SimulationEntity>,
    changeType: string
  ): string {
    const name = entity.metadata?.name as string | undefined
    const description = entity.metadata?.description as string | undefined

    if( name ){
      return changeType === 'appeared'
        ? `${name} appears` : `${name} changed`
    }
    if( description ){
      return description.slice( 0, 100 )
    }

    return `New ${entity.type}: ${entity.id.slice(0, 30)}`
  }

  /**
   * Compute salience of a percept based on entity characteristics.
   */
  private _computeSalience(
    entity: Readonly<SimulationEntity>,
    _changeType: string,
    now: Timestamp
  ): number {
    let salience = this._defaultSalience

    // High-priority types get baseline boost
    if( this._highPriorityTypes.has( entity.type ) )
      salience += 0.4

    // Entity metadata can specify explicit salience
    if( typeof entity.metadata?.salience === 'number')
      salience = entity.metadata.salience

    // Urgency metadata boosts salience
    if( typeof entity.metadata?.urgency === 'number')
      salience += entity.metadata.urgency * 0.3

    // Recency boost — entities with recent updatedAt are more salient.
    // Both sides are sim-time ms (updatedAt is stamped by StateManager from the
    // sim clock), so recency is measured against sim-time, never wall-clock (R2).
    const ageSeconds = ( now - entity.updatedAt ) / 1000
    if( ageSeconds < 10 )
      salience += 0.2
    else if( ageSeconds < 60 )
      salience += 0.1

    return Math.min( 1, Math.max( 0, salience ) )
  }

  /**
   * Collect IDs of stale percept entities to clean up.
   */
  private _collectStalePerceptIds( state: ReadonlySimulationState, currentTick: Tick ): string[] {
    const stale: string[] = []

    for( const [ id, entity ] of state.entities ){
      if( entity.type === 'percept' && typeof entity.metadata?.tick === 'number'){
        if( currentTick - entity.metadata.tick > 2 )
          stale.push( id )
      }
    }

    return stale
  }
}
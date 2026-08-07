// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/social.perception.ts
// ─────────────────────────────────────────────────────────────

/**
 * SocialPerception — processes social signals from other agents.
 *
 * Detects and interprets:
 *   - Other agents' observable actions
 *   - Communication directed at this agent
 *   - Social status and relationship cues
 *   - Group dynamics and social context
 *
 * Produces social percepts with salience that feed into:
 *   - AttachmentEvaluator (to update relationship models)
 *   - TheoryOfMind (to update mental models of others)
 *   - ThreatEvaluator (social evaluation threat)
 *
 * Part of Shard 0 (Perceptual Layer) — runs every tick, synchronous.
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
import { readAliases, canonicalOf } from '#cognition/social.identity'

export interface SocialPerceptionConfig {
  /** Entity types that represent other agents */
  agentTypes?: string[]
  /** Entity types that represent social signals */
  signalTypes?: string[]
  /** Maximum social percepts per tick */
  maxPerceptsPerTick?: number
  bus?: CognitiveBus
}

interface SocialPercept {
  keid: string
  signalType: string
  action: string
  valence: number       // -1 (hostile) to +1 (affiliative)
  intensity: number     // 0-1
  directedAtSelf: boolean
  salience: number
}

export class SocialPerception implements SimulationEngine, CognitiveEngine {
  readonly name     = 'social-perception'
  
  private _agentTypes: Set<string>
  private _signalTypes: Set<string>
  private _maxPerceptsPerTick: number

  // Track previously observed actions for change detection
  private _previousActions = new Map<string, string>()  // keid → last action

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: SocialPerceptionConfig = {} ){
    this._bus = config.bus ?? null
    // These defaults must name entity types this system ACTUALLY emits. The original
    // set ('agent', 'user', 'contact', 'persona' / 'message', 'action', 'expression',
    // 'social_signal', 'communication') described a vocabulary that never existed
    // here — measured against a live session, the overlap with the emitted types was
    // empty. This engine therefore scanned every tick and matched nothing, for the
    // life of every Will, and since it is the SOLE publisher of `interaction.occurred`
    // the entire social stack downstream of it (reputation, affect, theory-of-mind,
    // attachment, frustration) never received a single input.
    //
    // The extra names are a HOST SEAM, not dead weight (#114). A Will is a
    // container something else rents: a host embedding one in its own world
    // injects social entities under its own vocabulary, and these are the names
    // that vocabulary is expected to use. Empty means nobody is speaking, not
    // that nothing is wired — the distinction matters because a starved consumer
    // and a quiet one look identical from outside.
    this._agentTypes = new Set( config.agentTypes ?? [
      'known-entity',                                   // the dossier — how this system names a someone
      'agent', 'user', 'contact', 'persona',            // legacy / host-supplied
    ])
    // Inbound only. `conversation.sent` is deliberately ABSENT: this engine perceives
    // *others* acting toward us, and our own outbound is not someone else's action —
    // scanning it would let the Will build impressions of people out of its own
    // monologue, which is worse than learning nothing.
    this._signalTypes = new Set( config.signalTypes ?? [
      'conversation.received',                          // someone spoke to us
      'message', 'action', 'expression', 'social_signal', 'communication',
    ])
    this._maxPerceptsPerTick = config.maxPerceptsPerTick ?? 20
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] {
    return [{ type: 'interaction.occurred', version: 1, validate: () => null }]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('social') )
        this._model.setPrecision('social.agent_count', 1.0 + p.confidence * 0.5 )
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

    const socialPercepts = this._scanSocialSignals( state )
    const capped = socialPercepts.slice( 0, this._maxPerceptsPerTick )

    // Convert to percept entities
    for( let i = 0; i < capped.length; i++ ){
      const sp = capped[i]!

      commands.set!.push({
        id: `social-percept-${tick}-${i}`,
        type:     'percept.social',
        metadata: {
          tick,
          keid: sp.keid,
          signalType: sp.signalType,
          action: sp.action,
          valence: sp.valence,
          intensity: sp.intensity,
          directedAtSelf: sp.directedAtSelf,
          salience: sp.salience,
        },
      })

      // Update relationship metrics for the perceived agent
      this._updateRelationshipMetrics( sp, commands.metrics! )

      if( sp.salience > 0.5 )
        events.push({
          type: `social.${sp.signalType}`,
          source: this.name,
          payload: sp,
        })
    }

    // Social presence metrics
    const activeAgents = this._countActiveAgents( state )
    commands.metrics!.push(
      [ 'social.percepts_this_tick', capped.length ],
      [ 'social.active_agents', activeAgents ],
      [ 'social.directed_at_self', capped.filter( sp => sp.directedAtSelf ).length ],
    )

    // Social evaluation threat — how much social scrutiny exists
    const evaluationThreat = this._computeEvaluationThreat( capped )
    commands.metrics!.push([ 'social.evaluation_threat', evaluationThreat ])

    // Cleanup
    commands.delete = this._collectStale( state, tick )


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && activeAgents > 0 ){
      const predErr = this._model.observe('social.agent_count', activeAgents )
      if( !predErr.gated )
        _bus.publish({ type: 'social.agents.present', version: 1, sourceEngine: this.name, salience: Math.max( 0.3, predErr.salience ), payload: { activeAgents } })
    }

    // interaction.occurred — one event per significant percept so subscribers
    // (theory.of.mind, attachment.evaluator, etc.) get rich per-agent context
    if( _bus ){
      for( const sp of capped ){
        if( !sp.directedAtSelf && Math.abs( sp.valence ) < 0.2 ) continue
        _bus.publish({
          type: 'interaction.occurred', version: 1, sourceEngine: this.name,
          salience: sp.salience,
          payload: {
            keid:       sp.keid,
            valence:       sp.valence,
            intensity:     sp.intensity,
            directedAtSelf: sp.directedAtSelf,
            interactionType: sp.signalType,
          },
        })
      }
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  private _scanSocialSignals( state: ReadonlySimulationState ): SocialPercept[] {
    const percepts: SocialPercept[] = []
    const selfId = 'agent-self'

    // Every keid leaving this engine is canonicalized here, at the SOURCE.
    //
    // This is the sole publisher of `interaction.occurred`, and it was emitting
    // the raw transport id the percept arrived with while `social.responsiveness`
    // emitted the anchor. Measured live on a fresh mind: Fabrice held TWO
    // reputation records — `discord:1019…` (trust 0.500, five observations) and
    // `ke:1sqlkux` (trust 0.590, six) — so the two halves of what the mind was
    // learning about one person accumulated into different records, and whichever
    // the competition read was missing half the evidence.
    //
    // Fixed at the emitter rather than in each consumer: reputation, attachment,
    // theory-of-mind, empathy and the moral evaluator all key off whatever this
    // hands them, and patching five of them is five chances to miss one.
    const aliases = readAliases( state.entities as never )

    for( const [ id, entity ] of state.entities ){
      // Only process signal-type entities
      if( !this._signalTypes.has( entity.type ) ) continue

      const
      sourceKeid = canonicalOf( aliases, ( entity.metadata?.sourceKeid as string )
                   ?? ( entity.metadata?.from as string )
                   ?? 'unknown'),
      action        = ( entity.metadata?.action as string )
                   ?? ( entity.metadata?.type as string )
                   ?? entity.type,
      directedAtSelf = ( entity.metadata?.recipientId as string ) === selfId
                    || ( entity.metadata?.to as string ) === selfId
                    || ( entity.metadata?.targetKeid as string ) === selfId
                    || entity.metadata?.directedAtSelf === true,
      isNew          = this._previousActions.get( sourceKeid ) !== action

      // Compute valence from entity metadata or defaults
      const valence = typeof entity.metadata?.valence === 'number'
                        ? entity.metadata.valence
                        : this._defaultValence( action )

      // Intensity from explicit metadata or salience
      const intensity = typeof entity.metadata?.intensity === 'number'
                          ? entity.metadata.intensity
                          : typeof entity.metadata?.salience === 'number'
                            ? entity.metadata.salience
                            : 0.5

      // Salience: directed at self > new action > repeated action
      const salience = directedAtSelf ? 0.8 + intensity * 0.2
                     : isNew           ? 0.4 + intensity * 0.3
                     : 0.2 + intensity * 0.2

      percepts.push({
        keid: sourceKeid,
        signalType: entity.type,
        action,
        valence,
        intensity,
        directedAtSelf,
        salience: Math.min( 1, salience ),
      })

      // Track for change detection
      this._previousActions.set( sourceKeid, action )
    }

    // Sort by salience
    percepts.sort( ( a, b ) => b.salience - a.salience )

    return percepts
  }

  /**
   * Default valence mapping for known action types.
   */
  private _defaultValence( action: string ): number {
    const positive = [ 'praise', 'help', 'cooperate', 'greet', 'smile', 'agree', 'support', 'share' ]
    const negative = [ 'criticize', 'threaten', 'ignore', 'insult', 'attack', 'reject', 'lie', 'betray' ]

    const lower = action.toLowerCase()
    if( positive.some( p => lower.includes( p ) ) ) return 0.6
    if( negative.some( n => lower.includes( n ) ) ) return -0.6
    return 0
  }

  /**
   * Update running relationship metrics for a perceived will.
   */
  private _updateRelationshipMetrics(
    percept: SocialPercept,
    metrics: Array<[string, number]>
  ): void {
    const prefix = `relationship.${percept.keid}`

    // Exponential moving average of interaction valence
    metrics.push([ `${prefix}.valence`, percept.valence ])

    // Count interactions
    metrics.push([ `${prefix}.interaction_count`, 1 ])

    // Track directed-at-self ratio
    if( percept.directedAtSelf )
      metrics.push([ `${prefix}.directed_count`, 1 ])
  }

  private _countActiveAgents( state: ReadonlySimulationState ): number {
    let count = 0
    for( const entity of state.entities.values() ){
      if( this._agentTypes.has( entity.type ) )
        count++
    }
    return count
  }

  /**
   * Compute social evaluation threat — how much social scrutiny is perceived.
   */
  private _computeEvaluationThreat( percepts: SocialPercept[] ): number {
    if( percepts.length === 0 ) return 0

    const
    directedPercepts = percepts.filter( p => p.directedAtSelf ),
    negativeDirected = directedPercepts.filter( p => p.valence < 0 )

    if( directedPercepts.length === 0 ) return 0.1

    const
    negativeRatio = negativeDirected.length / directedPercepts.length,
    intensityAvg  = directedPercepts.reduce( ( s, p ) => s + p.intensity, 0 ) / directedPercepts.length

    return Math.min( 1, ( negativeRatio * 0.7 + intensityAvg * 0.3 ) * directedPercepts.length / 3 )
  }

  private _collectStale( state: ReadonlySimulationState, currentTick: Tick ): string[] {
    const stale: string[] = []
    for( const [ id, entity ] of state.entities ){
      // A received turn is a one-shot EVENT, consumed on the tick it is scanned —
      // this same react() has already turned it into a percept and an
      // `interaction.occurred`. It is written off-tick by AuditionEngine and so
      // carries no `tick` to age on; without this it would never be collected and
      // would re-publish the same interaction every tick for the life of the mind.
      if( entity.type === 'conversation.received'){ stale.push( id ); continue }

      // Expire processed percept.social entities after 2 ticks
      if( entity.type === 'percept.social' && typeof entity.metadata?.tick === 'number'){
        if( currentTick - entity.metadata.tick > 2 )
          stale.push( id )
      }
      // Expire injected signal entities (communication, message, etc.) after 2 ticks,
      // BUT only once the executive engine has processed them.
      // communication entities must survive until the executive fires (5-tick cooldown),
      // so we must not delete them before processedByExecutive is set — otherwise
      // messages arriving within 2 ticks of an executive fire are silently lost.
      if( this._signalTypes.has( entity.type ) && entity.type !== 'percept.social'){
        if( entity.type === 'communication' && !entity.metadata?.processedByExecutive ) continue
        const createdAtTick = entity.metadata?.tick as number | undefined
                           ?? entity.metadata?.injectedAtTick as number | undefined
        if( typeof createdAtTick === 'number' && currentTick - createdAtTick > 1 )
          stale.push( id )
      }
    }
    return stale
  }
}
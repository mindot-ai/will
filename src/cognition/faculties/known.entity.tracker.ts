// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/known.entity.tracker.ts
// ─────────────────────────────────────────────────────────────

/**
 * KnownEntityTracker — the cross-modal binder, and owner of the known-entity dossier.
 *
 * This is the faculty `base.sense.engine.ts` anticipates: it subscribes to every
 * `senses.*.percept` and, per `sourceEntityId`, accretes a dossier — the node for anything
 * the Will has come to know (someone or something). It maintains the *perceptual /
 * subconscious* layer of that knowledge:
 *
 *   - familiarity   — mere-exposure: rises with each encounter, decays in absence
 *   - encounterCount, lastSeen
 *   - name          — when the channel supplies one (e.g. TextMessage.speakerName)
 *   - kind          — sentient | thing
 *   - resolutionConfidence — how identified this referent is (drives curiosity, Phase 3)
 *
 * The *conscious* layer (facts learned in reasoning, a felt valence) is written separately
 * via `knownEntityUpdates` (Phase 2.2). The executive joins both, plus the social triple,
 * in `extractKnownEntities`. Identity is provisional: the `keid` is the referent the
 * senses supply — a dossier can exist long before the Will knows the entity's name.
 *
 * Part of the Social/Perceptual layer — runs every tick, synchronous, deterministic (R2):
 * all accretion/decay is a pure function of percepts + sim-tick.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { Percept } from '#senses/index'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface KnownEntityTrackerConfig {
  /** How fast familiarity rises per encounter (saturating toward 1). Channel A: openness. */
  familiarityGrowthRate?: number
  /** How fast familiarity fades per tick without an encounter. */
  familiarityDecayRate?: number
  /** Gain on the curiosity-to-resolve drive — how readily the pull-to-know fires. Channel A: openness. */
  curiosityGain?: number
  /** EMA weight per action outcome — how fast a reliability judgment is revised. Channel A: analytical. */
  reliabilityRate?: number
  /** Maximum dossiers retained (lowest familiarity pruned). */
  maxTracked?: number
  bus?: CognitiveBus
}

export interface KnownEntity {
  keid:                 string
  kind:                 'sentient' | 'thing'
  name?:                string
  /** Mere-exposure familiarity 0–1 — rises per encounter, decays in absence. */
  familiarity:          number
  /** Felt affective tone toward the entity (−1..1). Set by the conscious layer (2.2). */
  valence:              number
  /**
   * Track-record reliability 0–1 — does it perform/behave as expected? An EMA of action
   * outcomes targeting this entity. General (a car/tool/place/person can have one), distinct
   * from a sentient's *social* reputation. 0.5 = unknown.
   */
  reliability:          number
  encounterCount:       number
  lastSeenTick:         Tick
  /** 0–1: how identified/coherent this referent is (a name + repeated encounters raise it). */
  resolutionConfidence: number
}

/** Percept domains whose entities are minds. Everything else defaults to a thing. */
const SENTIENT_DOMAINS = new Set<string>([ 'audition' ])

// Per-entity curiosity (3.b): a *familiar* (≥) yet *unresolved* (<) referent earns a
// specific "get to know them" pull; it subsides once resolution reaches RESOLVED.
const CURIOUS_FAMILIARITY = 0.5
const CURIOUS_RESOLUTION   = 0.4
const CURIOUS_RESOLVED     = 0.6

// Forgetting (Phase 4). (Reliability rate is now a Channel-A developable field — analytical.)
const FORGET_FLOOR     = 0.02    // below this familiarity, an unidentified blip is forgotten

// Recognition (Phase 5) — guards against conflating two *different* people who share a
// name. Only recognise a still-thin handle (≤) into a known person, and never when both
// were active at the same time (two people talking at once ⇒ distinct, not one on two
// handles). Better to keep two records of one person (harmless) than fuse two people.
const RECOGNITION_MERGE_MAX_ENCOUNTERS = 8
const RECOGNITION_CONCURRENCY_WINDOW   = 20

export class KnownEntityTracker implements SimulationEngine, CognitiveEngine {
  readonly name = 'known-entity-tracker'

  private _growthRate:     number
  private _decayRate:      number
  private _curiosityGain:  number
  private _reliabilityRate: number
  private _maxTracked:     number

  private _dossiers = new Map<string, KnownEntity>()
  // Recognition (Phase 5): alias keid → the canonical keid it was fused into. Incoming
  // references are redirected so an aliased referent never re-forms its own dossier.
  private _aliases = new Map<string, string>()
  /** True after dossiers have been rehydrated from persisted state on first tick. */
  private _restored = false

  // Buffered from senses.*.percept events; drained each tick in react().
  private _pendingEncounters: Array<{ keid: string; domain: string; name?: string }> = []
  // Buffered from known.entity.learned (the conscious / reasoning write-path, Phase 2.2).
  private _pendingConscious: Array<{ keid: string; name?: string; feeling?: number }> = []
  // Buffered from action.outcome — the reliability track-record signal (Phase 4).
  private _pendingOutcomes: Array<{ keid: string; signal: number }> = []

  private _bus: CognitiveBus | null = null
  private readonly _model = new GenerativeModel()

  constructor( config: KnownEntityTrackerConfig = {} ){
    this._growthRate      = config.familiarityGrowthRate ?? 0.15
    this._decayRate       = config.familiarityDecayRate  ?? 0.005
    this._curiosityGain   = config.curiosityGain         ?? 1.0
    this._reliabilityRate = config.reliabilityRate       ?? 0.2
    this._maxTracked      = config.maxTracked            ?? 50
    this._bus = config.bus ?? null
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  /**
   * Effective config = base engine-config-known-entity ⊕ persona-prior (Channel A). Read
   * each tick so the tracker's dispositions *develop*: openness raises familiarity growth +
   * the curiosity pull; analytical sharpens how fast reliability judgments are revised.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-known-entity' )
    if( p.familiarityGrowthRate != null ) this._growthRate      = p.familiarityGrowthRate
    if( p.curiosityGain         != null ) this._curiosityGain   = p.curiosityGain
    if( p.reliabilityRate       != null ) this._reliabilityRate = p.reliabilityRate
  }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] { return [ 'senses.*', 'known.entity.learned', 'action.outcome' ] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    // Conscious learning (the reasoning write-path): a learned name + felt valence.
    if( e.type === 'known.entity.learned' ){
      const u = e.payload as { keid?: string; name?: string; feeling?: number }
      if( u?.keid && u.keid !== 'agent-self' )
        this._pendingConscious.push({ keid: u.keid, name: u.name, feeling: u.feeling })
      return
    }

    // Acting on/with an entity and seeing how it went — the reliability track-record.
    if( e.type === 'action.outcome' ){
      const o = e.payload as { targetEntityId?: string; success?: boolean; outcomeQuality?: number }
      if( o?.targetEntityId && o.targetEntityId !== 'agent-self' )
        this._pendingOutcomes.push({ keid: o.targetEntityId, signal: o.success ? 1 : 0 })
      return
    }

    // Otherwise a senses.<domain>.percept — bind the perceived entity (sourceEntityId).
    const p = e.payload as Percept | undefined
    const keid = p?.sourceEntityId
    if( !keid || keid === 'agent-self' ) return

    // A channel-supplied display name rides on the raw input (e.g. TextMessage.speakerName).
    const raw  = p?.raw as { speakerName?: unknown } | undefined
    const name = typeof raw?.speakerName === 'string' ? raw.speakerName : undefined

    this._pendingEncounters.push({ keid, domain: p!.domain, name })
  }

  snapshot(): Record<string, unknown> {
    return { trackedEntities: this._dossiers.size }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    _ctx: SimulationContext,
  ): Promise<EngineResult> {
    const commands: StateCommands = { set: [], metrics: [], delete: [] }

    // Channel A: effective dispositions = base ⊕ persona-prior (developed from traits).
    this._readConfigFromState( state )

    // Rehydrate from persisted known-entity dossiers on the first tick after a
    // snapshot/PMA restore — parity with attachment/reputation/theory-of-mind.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    // Familiarity fades a little each tick — absence dims the sense of an entity.
    for( const d of this._dossiers.values() )
      if( d.familiarity > 0 )
        d.familiarity = Math.max( 0, d.familiarity - this._decayRate )

    // Drain encounters — each percept is an exposure that re-warms familiarity.
    let touched = false
    for( const enc of this._pendingEncounters.splice( 0 ) ){
      const d = this._getOrCreate( enc.keid, enc.domain, tick )
      d.encounterCount += 1
      d.familiarity     = Math.min( 1, d.familiarity + this._growthRate * ( 1 - d.familiarity ) )
      d.lastSeenTick    = tick
      if( enc.name && !d.name ) d.name = enc.name   // learn a name the channel offers
      d.resolutionConfidence = this._resolution( d )
      touched = true
    }

    // Drain conscious updates — a name learned in reasoning, and a felt valence (eased
    // toward, not slammed). A known someone can exist here with no perceptual encounter.
    for( const u of this._pendingConscious.splice( 0 ) ){
      const d = this._getOrCreate( u.keid, 'audition', tick )   // a known *someone*
      if( u.name ) d.name = u.name
      if( u.feeling != null )
        d.valence = Math.max( -1, Math.min( 1, d.valence + 0.5 * ( u.feeling - d.valence ) ) )
      d.resolutionConfidence = this._resolution( d )
      touched = true
    }

    // Drain action outcomes — reliability is a track record, earned by how the entity
    // performs when acted on (general: a tool, a place, or a person). Only updates an
    // already-known referent (acting on something you've never perceived doesn't conjure it).
    for( const o of this._pendingOutcomes.splice( 0 ) ){
      const d = this._dossiers.get( o.keid )
      if( !d ) continue
      d.reliability = Math.max( 0, Math.min( 1, d.reliability + this._reliabilityRate * ( o.signal - d.reliability ) ) )
      touched = true
    }

    // Recognition (Phase 5): two referents the Will has resolved to the *same name* are very
    // likely the same someone — fuse them. Human-mind-like: provisional (two people *can*
    // share a name — it may be wrong) and reversible (the alias entity can be removed);
    // deterministic (normalised-name match; the more-familiar referent is canonical, ties by
    // keid order). The alias record lets reads of the triple/beliefs under the old keid
    // resolve to the canonical, without destructive re-keying.
    if( this._recognise( commands ) ) touched = true

    this._prune()

    // Forgetting (Phase 4): an unidentified blip that has faded out of familiarity is let
    // go — dropped from memory and the persisted entity deleted. A named/resolved entity is
    // identity-constitutive and kept (it rides the attachment×salience PMA, not forgotten).
    for( const d of [ ...this._dossiers.values() ] )
      if( d.familiarity < FORGET_FLOOR && !d.name && d.resolutionConfidence < CURIOUS_RESOLUTION ){
        this._dossiers.delete( d.keid )
        commands.delete!.push( `ke-${d.keid}` )
      }

    // Persist dossiers (the perceptual layer of the known-entity node).
    for( const d of this._dossiers.values() ){
      if( d.encounterCount === 0 && !d.name ) continue   // keep a named-but-unseen someone
      commands.set!.push({
        id:   `ke-${d.keid}`,
        type: 'known-entity',
        metadata: {
          keid:                 d.keid,
          kind:                 d.kind,
          name:                 d.name,
          familiarity:          d.familiarity,
          valence:              d.valence,
          reliability:          d.reliability,
          encounterCount:       d.encounterCount,
          lastSeenTick:         d.lastSeenTick,
          resolutionConfidence: d.resolutionConfidence,
        },
      })
    }

    commands.metrics!.push([ 'known_entity.tracked', this._dossiers.size ])

    // Curiosity-to-resolve (Phase 3.a): a felt pull to learn more about the entities the
    // Will keeps meeting but barely knows. Peaks for a *familiar yet unresolved* referent
    // (high familiarity × low resolution); near-zero for strangers (unfamiliar) and for the
    // well-known (resolved). The aggregate is the strongest such case — GoalManager turns a
    // sustained drive into an epistemic "get to know them" goal that resolves as the Will
    // learns (keid-tagged beliefs raise resolution, lowering the drive — a clean loop).
    let curiosity = 0
    for( const d of this._dossiers.values() )
      curiosity = Math.max( curiosity, d.familiarity * ( 1 - d.resolutionConfidence ) )
    // Channel A (openness): a more open/curious Will feels the pull-to-know more readily.
    commands.metrics!.push([ 'drive.curiosity_resolve', Math.min( 1, curiosity * this._curiosityGain ) ])

    // Per-entity curiosity (Phase 3.b): the vivid "who *was* that?". For a familiar-yet-
    // unresolved someone, raise a specific pull — an attention.demand that GoalManager turns
    // into a per-keid goal "get to know <name|someone>", completing on *that* referent's
    // resolution. Cleared once resolved. (keid is sanitised for the metric-condition parser,
    // which only accepts [\w.] names — keids may contain ':' e.g. web:42.)
    for( const d of this._dossiers.values() ){
      if( d.familiarity < CURIOUS_FAMILIARITY ) continue          // only ones that matter
      const skeid = d.keid.replace( /[^\w.]/g, '_' )
      commands.metrics!.push([ `known_entity.${skeid}.resolution`, d.resolutionConfidence ])

      if( d.resolutionConfidence < CURIOUS_RESOLUTION )
        commands.set!.push({
          id:   `curiosity-${d.keid}`,
          type: 'attention.demand',
          metadata: {
            generatesGoal:           true,
            goalDescription:         `Get to know ${d.name ?? 'someone I keep encountering'}`,
            goalPriority:            0.45,
            goalTags:                [ 'curiosity', 'known-entity', `keid:${d.keid}` ],
            goalCompletionType:      'metric',
            goalCompletionCondition: `known_entity.${skeid}.resolution >= ${CURIOUS_RESOLVED}`,
          },
        })
      else if( state.entities.has( `curiosity-${d.keid}` ) )
        commands.delete!.push( `curiosity-${d.keid}` )            // resolved → the pull subsides
    }

    if( touched && this._bus ){
      const predErr = this._model.observe( 'known_entity.count', this._dossiers.size )
      if( !predErr.gated )
        this._bus.publish({ type: 'known.entity.updated', version: 1, sourceEngine: this.name,
          salience: Math.max( 0.2, predErr.salience ), payload: { tracked: this._dossiers.size } })
    }

    return { commands }
  }

  // ── Public API ───────────────────────────────────────────

  /** The dossier for a referent, if the Will has one. */
  getDossier( keid: string ): KnownEntity | undefined { return this._dossiers.get( keid ) }

  // ── Internal ─────────────────────────────────────────────

  /** Resolution confidence: a learned name plus repeated encounters identify a referent. */
  private _resolution( d: KnownEntity ): number {
    return Math.min( 1, ( d.name ? 0.4 : 0 ) + Math.min( 0.6, d.encounterCount * 0.05 ) )
  }

  /**
   * Fuse dossiers that have resolved to the same name into one canonical referent. Returns
   * true if any merge happened. Pure + deterministic.
   */
  private _recognise( commands: StateCommands ): boolean {
    const byName = new Map<string, KnownEntity[]>()
    for( const d of this._dossiers.values() )
      if( d.name ){
        const n = d.name.trim().toLowerCase()
        const g = byName.get( n ); g ? g.push( d ) : byName.set( n, [ d ] )
      }

    let merged = false
    for( const group of byName.values() ){
      if( group.length < 2 ) continue
      // canonical = most familiar; ties broken lexicographically for replay stability.
      group.sort( ( a, b ) => b.familiarity - a.familiarity || ( a.keid < b.keid ? -1 : 1 ) )
      const canon = group[0]!
      for( const alias of group.slice( 1 ) ){
        // Conservative: don't fuse two people who merely share a name. Skip if the absorbed
        // handle is already an established relationship, or if both were active concurrently
        // (two interlocutors at once ⇒ distinct). A same-name match alone is too weak.
        const gap = Math.abs( ( canon.lastSeenTick as unknown as number ) - ( alias.lastSeenTick as unknown as number ) )
        if( alias.encounterCount >= RECOGNITION_MERGE_MAX_ENCOUNTERS || gap < RECOGNITION_CONCURRENCY_WINDOW )
          continue

        canon.encounterCount       += alias.encounterCount
        canon.familiarity           = Math.max( canon.familiarity, alias.familiarity )
        canon.resolutionConfidence  = Math.max( canon.resolutionConfidence, alias.resolutionConfidence )
        canon.lastSeenTick          = Math.max( canon.lastSeenTick as unknown as number, alias.lastSeenTick as unknown as number ) as unknown as Tick
        canon.valence               = ( canon.valence + alias.valence ) / 2
        canon.reliability           = ( canon.reliability + alias.reliability ) / 2

        this._dossiers.delete( alias.keid )
        this._aliases.set( alias.keid, canon.keid )
        commands.delete!.push( `ke-${alias.keid}` )
        commands.set!.push({ id: `kea-${alias.keid}`, type: 'known-entity-alias',
          metadata: { aliasKeid: alias.keid, canonicalKeid: canon.keid } })
        merged = true
      }
    }
    return merged
  }

  private _getOrCreate( keid: string, domain: string, tick: Tick ): KnownEntity {
    keid = this._aliases.get( keid ) ?? keid   // a recognised alias lands on the canonical dossier
    const existing = this._dossiers.get( keid )
    if( existing ) return existing

    const d: KnownEntity = {
      keid,
      kind:                 SENTIENT_DOMAINS.has( domain ) ? 'sentient' : 'thing',
      familiarity:          0,
      valence:              0,
      reliability:          0.5,   // unknown until acted on
      encounterCount:       0,
      lastSeenTick:         tick,
      resolutionConfidence: 0,
    }
    this._dossiers.set( keid, d )
    return d
  }

  /** Keep the most-familiar dossiers; absence-faded acquaintances fall away (forgetting). */
  private _prune(): void {
    if( this._dossiers.size <= this._maxTracked ) return
    const sorted = [ ...this._dossiers.values() ].sort( ( a, b ) => b.familiarity - a.familiarity )
    for( const d of sorted.slice( this._maxTracked ) ) this._dossiers.delete( d.keid )
  }

  private _restoreFromState( state: ReadonlySimulationState ): void {
    // Recognised aliases first, so incoming references redirect to the canonical referent.
    for( const entity of state.entities.values() )
      if( entity.type === 'known-entity-alias' ){
        const a = entity.metadata?.['aliasKeid'] as string | undefined
        const c = entity.metadata?.['canonicalKeid'] as string | undefined
        if( a && c ) this._aliases.set( a, c )
      }

    for( const entity of state.entities.values() ){
      if( entity.type !== 'known-entity' ) continue
      const m    = entity.metadata ?? {}
      const keid = m['keid'] as string | undefined
      if( !keid || this._dossiers.has( keid ) ) continue

      this._dossiers.set( keid, {
        keid,
        kind:                 ( m['kind']                 as 'sentient' | 'thing' ) ?? 'sentient',
        name:                 ( m['name']                 as string | undefined ),
        familiarity:          ( m['familiarity']          as number ) ?? 0,
        valence:              ( m['valence']              as number ) ?? 0,
        reliability:          ( m['reliability']          as number ) ?? 0.5,
        encounterCount:       ( m['encounterCount']       as number ) ?? 0,
        lastSeenTick:         ( m['lastSeenTick']         as Tick )   ?? ( 0 as unknown as Tick ),
        resolutionConfidence: ( m['resolutionConfidence'] as number ) ?? 0,
      })
    }
  }
}

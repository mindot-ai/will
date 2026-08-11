// ─────────────────────────────────────────────────────────────
// src/agency/schemas/repertoire.ts  —  the store of what the Will can do
// ─────────────────────────────────────────────────────────────
//
// The repertoire holds two things: the schema TEMPLATES the Will can enact
// (innate floor + learned composites) and the per-schema LearnedSkill stats that
// accrete from experience. It is the competence layer — the part of a Will that
// makes it *act like itself*, and the part the PMA must carry across re-embodiment
// (Phase 6). It is an in-memory manager (like GoalManager); the ReafferenceEngine
// mirrors per-schema skills into `agency.skill` state entities AND learned
// composite templates into `agency.schema` entities, so both survive a
// snapshot/restore. The skills carry habit/value; the composites carry the
// invented multi-step *programs* the executor must resolve to run a macro.
// restoreComposites() rehydrates those templates after a restore reconstructs
// the repertoire innate-only — analogous to GoalManager rehydrating `goal`s.
//
// Learning rules (the proceduralization curve):
//   valueEstimate  — EMA toward observed outcome quality
//   habitStrength  — rises only on CONFIDENT success (low prediction error);
//                    a surprising or failed outcome erodes it. This is the
//                    instrumental→habitual gradient: an action becomes a habit
//                    by working reliably AND predictably, not merely often.
//   avgPredictionError — EMA of |predicted − actual|; the destabilizer
//   paramPriors    — last known-good parameters become defaults
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { MotorSchema, LearnedSkill } from '#agency/types'
import type { EntityInput, ReadonlySimulationState } from '#core/types'
import type { DenialFinality } from '#stem/policy/arbiter'
import { INNATE_SCHEMAS, INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'

const VALUE_ALPHA       = 0.2   // value EMA rate
const ERROR_BETA        = 0.2   // prediction-error EMA rate
const HABIT_GAIN        = 0.12  // habit growth on confident success
const HABIT_FAIL_DECAY  = 0.10  // habit erosion on surprise / failure
const CONFIDENT_ERROR   = 0.30  // prediction error below this counts as "predictable"
const PROC_THRESHOLD    = 0.60  // habit at/above this is "proceduralized"

const IDLE_TICKS        = 200   // ticks of disuse before forgetting starts
const DECAY_RATE        = 0.02  // habit lost per decay application
const DROP_HABIT        = 0.05  // below this (and learned) the skill is forgotten

// ── availability layer (POLICY_REAFFERENCE P2) ────────────────
// Availability is NOT competence. It answers "may I use this schema", learned
// from policy refusals, and is kept strictly apart from LearnedSkill so a
// refusal never teaches the Will it is *unskilled* at something it is merely
// *forbidden* to do. A `class` refusal ("never, under this policy") drives
// availability down hard; an `instance` refusal ("not with those parameters")
// dents it lightly — the Will should keep reaching for the ability, just not
// that way. Recovery is slow but real, so a policy change is re-discoverable:
// availability never floors at zero, and it climbs back toward 1 with disuse of
// the refusal. P2 keys availability by SCHEMA; per-(schema, params) envelope
// narrowing is a follow-up that belongs at selection time, not fielding time.
const AVAIL_DROP_CLASS     = 0.50  // multiplicative cut on a class-final refusal
const AVAIL_DROP_PARAMETER = 0.12  // lighter cut when only the arguments were refused
const AVAIL_FLOOR         = 0.05  // never zero — re-probe must always be possible
const AVAIL_RECOVERY      = 0.02  // per-decay climb back toward 1
const AVAIL_RECOVERED     = 0.999 // at/above this the entry is dropped (quiet path)

export interface OutcomeObservation {
  schema:         string
  success:        boolean
  outcomeQuality: number
  predictedReward: number
  /** Last-known-good parameters to fold into priors (only kept on success). */
  params?:        Record<string, unknown>
  tick:           number
}

export class SchemaRepertoire {
  private _templates = new Map<string, MotorSchema>()
  private _skills    = new Map<string, LearnedSkill>()
  /** Tracks which templates were learned at runtime (vs innate) so decay can forget them. */
  private _learned   = new Set<string>()
  /** Availability layer (P2): schema → { value 0..1, lastRefusedTick }. Empty until
   *  a refusal lands — a never-refused Will writes nothing here (byte-identical). */
  private _availability = new Map<string, { value: number; lastRefusedTick: number }>()

  constructor( seed: MotorSchema[] = INNATE_SCHEMAS ){
    for( const s of seed ) this._templates.set( s.id, s )
  }

  // ── templates ─────────────────────────────────────────────────
  schemas(): MotorSchema[] { return [ ...this._templates.values() ] }
  getSchema( id: string ): MotorSchema | undefined { return this._templates.get( id ) }

  /** Register a learned composite skill template (starts with no habit). */
  registerComposite( schema: MotorSchema ): void {
    this._templates.set( schema.id, schema )
    this._learned.add( schema.id )
    if( !this._skills.has( schema.id ) )
      this._skills.set( schema.id, freshSkill( schema.id, 0.4, 0 ) )
  }

  /**
   * Register a host effector's primitive schema at runtime (post-create
   * `.effector()`). Unlike a composite it is NOT marked learned — it is a
   * capacity the host granted, which the synthesizer surfaces immediately and
   * reafference then builds skill on. Idempotent; re-registering updates it.
   */
  registerExternal( schema: MotorSchema ): void {
    // An innate schema is part of the body, not a slot a tenant may redefine.
    //
    // This sets by id, so a host registering a handler for a name the floor
    // already uses would REPLACE the innate schema with a generated one —
    // silently dropping its `binds`, cost, preconditions and tags. `inspect` is
    // the live case: a Discord bridge answering inquiries would have overwritten
    // the very schema whose `binds: 'percept'` is how inquiry finds its targets,
    // and the mind would have lost the ability to look at what it cannot place in
    // exchange for gaining an answerer.
    //
    // Registering the HANDLER is still what the host wanted and still happens —
    // only the redeclaration is refused. The container supplies the mechanism; a
    // tenant supplies what answers it.
    if( INNATE_SCHEMA_BY_ID.has( schema.id ) ){
      logger.debug(`[repertoire] "${ schema.id }" is innate — keeping the body's schema, binding the handler only`)
      return
    }
    this._templates.set( schema.id, schema )
  }

  // ── skills ────────────────────────────────────────────────────
  skills(): ReadonlyMap<string, LearnedSkill> { return this._skills }
  getSkill( id: string ): LearnedSkill | undefined { return this._skills.get( id ) }

  // ── availability (P2) ─────────────────────────────────────────
  availability(): ReadonlyMap<string, { value: number; lastRefusedTick: number }> { return this._availability }

  /**
   * How available a schema is right now, 0..1. Absent from the ledger ⇒ 1
   * (fully available — the common case). This is the ONLY value the
   * AffordanceSynthesizer reads; it never touches competence.
   */
  availabilityOf( schema: string ): number {
    return this._availability.get( schema )?.value ?? 1
  }

  /**
   * Fold a policy refusal into the availability layer (NOT competence). A
   * `class` refusal cuts availability hard; a `parameter` refusal dents it
   * lightly. Multiplicative so repeated refusals compound toward — but never
   * reach — zero, keeping re-probe alive.
   *
   * `context` is EXCLUDED FROM THE SIGNATURE, not handled inside: a refusal
   * that was not about the action must never reach the availability layer at
   * all, and making that a type error rather than a convention means a future
   * caller cannot quietly re-introduce the dent. The routing decision lives in
   * the ReafferenceEngine's refused branch (P5).
   */
  recordRefusal( schema: string, finality: Exclude<DenialFinality, 'context'>, tick: number ): number {
    const prev = this._availability.get( schema )?.value ?? 1
    const drop = finality === 'class' ? AVAIL_DROP_CLASS : AVAIL_DROP_PARAMETER
    const value = Math.max( AVAIL_FLOOR, prev * ( 1 - drop ) )
    this._availability.set( schema, { value, lastRefusedTick: tick } )
    return value
  }

  /**
   * Fold one outcome into the schema's learned skill. Returns the updated skill
   * and whether it just crossed the proceduralization threshold this update.
   */
  recordOutcome( o: OutcomeObservation ): { skill: LearnedSkill; proceduralized: boolean } {
    const prior = this._skills.get( o.schema ) ?? freshSkill( o.schema, o.predictedReward, o.tick )
    const wasProceduralized = prior.habitStrength >= PROC_THRESHOLD

    const error     = clamp01( Math.abs( o.predictedReward - o.outcomeQuality ) )
    const confident = o.success && error < CONFIDENT_ERROR

    const habitStrength = clamp01(
      confident
        ? prior.habitStrength + HABIT_GAIN * ( 1 - prior.habitStrength )
        : prior.habitStrength - HABIT_FAIL_DECAY * prior.habitStrength,
    )

    const skill: LearnedSkill = {
      schema:             o.schema,
      habitStrength,
      valueEstimate:      clamp01( prior.valueEstimate + VALUE_ALPHA * ( o.outcomeQuality - prior.valueEstimate ) ),
      paramPriors:        o.success && o.params ? { ...prior.paramPriors, ...o.params } : prior.paramPriors,
      enactments:         prior.enactments + 1,
      successes:          prior.successes + ( o.success ? 1 : 0 ),
      avgPredictionError: prior.avgPredictionError + ERROR_BETA * ( error - prior.avgPredictionError ),
      lastEnactedTick:    o.tick,
    }

    this._skills.set( o.schema, skill )
    return { skill, proceduralized: !wasProceduralized && habitStrength >= PROC_THRESHOLD }
  }

  /**
   * Forgetting curve over the competence layer, plus availability recovery.
   * Skills unused for IDLE_TICKS lose habit; learned composites below DROP_HABIT
   * are dropped entirely (template + skill). Availability entries climb back
   * toward 1 and are dropped once fully recovered. Returns the ids that were
   * removed from each layer so their mirrored state entities can be deleted.
   */
  decay( tick: number ): { skills: string[]; availability: string[] } {
    const skills: string[] = []
    for( const [ id, skill ] of this._skills ){
      if( tick - skill.lastEnactedTick <= IDLE_TICKS ) continue

      const habitStrength = clamp01( skill.habitStrength - DECAY_RATE )
      if( this._learned.has( id ) && habitStrength < DROP_HABIT ){
        this._skills.delete( id )
        this._templates.delete( id )
        this._learned.delete( id )
        skills.push( id )
        continue
      }
      this._skills.set( id, { ...skill, habitStrength } )
    }

    // Availability recovery (P2): each entry climbs slowly back toward 1, so a
    // policy change is re-discoverable. A fully-recovered entry is dropped, so a
    // Will that was refused long ago returns to the byte-identical quiet path.
    const availability: string[] = []
    for( const [ id, avail ] of this._availability ){
      const value = avail.value + AVAIL_RECOVERY * ( 1 - avail.value )
      if( value >= AVAIL_RECOVERED ){ this._availability.delete( id ); availability.push( id ) }
      else this._availability.set( id, { ...avail, value } )
    }

    return { skills, availability }
  }

  // ── PMA portability (Phase 6 reads these) ─────────────────────
  /** Learned composite templates + all skills above a confidence floor. */
  export( minHabit = 0.0 ): { composites: MotorSchema[]; skills: LearnedSkill[] } {
    return {
      composites: [ ...this._learned ].map( id => this._templates.get( id ) ).filter( ( s ): s is MotorSchema => !!s ),
      skills:     [ ...this._skills.values() ].filter( s => s.habitStrength >= minHabit ),
    }
  }

  import( data: { composites?: MotorSchema[]; skills?: LearnedSkill[] } ): void {
    for( const c of data.composites ?? [] ){ this._templates.set( c.id, c ); this._learned.add( c.id ) }
    for( const s of data.skills ?? [] ) this._skills.set( s.schema, s )
  }

  // ── snapshot / replay portability (deterministic state path) ──
  // Skills mirror to `agency.skill`; the invented composite *definitions* must
  // travel too, or a snapshot/restore brings back an `agency.skill` whose schema
  // is gone and the MotorSchemaExecutor can't expand it (it misroutes the intent
  // to the host and times out). compositeEntities() is the write side (the
  // ReafferenceEngine pushes these each tick); restoreComposites() is the read
  // side, called from the first agency engine after a restore.

  /** Learned composite templates encoded as `agency.schema` state entities. */
  compositeEntities(): EntityInput[] {
    const out: EntityInput[] = []
    for( const id of this._learned ){
      const s = this._templates.get( id )
      if( s && s.kind === 'composite') out.push( schemaEntity( s ) )
    }
    return out
  }

  /**
   * Re-register learned composites from `agency.schema` state entities after a
   * restore rebuilt the repertoire innate-only. Idempotent — skips composites
   * already present and never seeds a fresh skill (the restored `agency.skill`
   * entity and future outcomes own the habit; seeding here would reset it).
   * Mirrors GoalManager._syncFromStateGoals.
   */
  restoreComposites( entities: ReadonlySimulationState['entities'] ): void {
    for( const e of entities.values() ){
      if( e.type !== SCHEMA_ENTITY_TYPE ) continue
      const s = readSchema( e.metadata as Record<string, unknown> | undefined )
      if( !s || this._templates.has( s.id ) ) continue
      this._templates.set( s.id, s )
      this._learned.add( s.id )
    }
  }

  /** Availability ledger encoded as `agency.availability` state entities (P2).
   *  Empty until a refusal lands, so the quiet path writes nothing. */
  availabilityEntities(): EntityInput[] {
    const out: EntityInput[] = []
    for( const [ schema, a ] of this._availability )
      out.push( availabilityEntity( schema, a.value, a.lastRefusedTick ) )
    return out
  }

  /** Rehydrate the availability ledger from state after a restore. Idempotent;
   *  keeps whichever value is more restrictive so a concurrent refusal isn't lost. */
  restoreAvailability( entities: ReadonlySimulationState['entities'] ): void {
    for( const e of entities.values() ){
      if( e.type !== AVAILABILITY_ENTITY_TYPE ) continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      const schema = typeof m['schema'] === 'string' ? m['schema'] : ''
      if( !schema ) continue
      const value = typeof m['value'] === 'number' ? m['value'] : 1
      const tick  = typeof m['lastRefusedTick'] === 'number' ? m['lastRefusedTick'] : 0
      const prev  = this._availability.get( schema )
      if( !prev || value < prev.value ) this._availability.set( schema, { value, lastRefusedTick: tick } )
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function freshSkill( schema: string, value: number, tick: number ): LearnedSkill {
  return {
    schema,
    habitStrength:      0,
    valueEstimate:      clamp01( value ),
    paramPriors:        {},
    enactments:         0,
    successes:          0,
    avgPredictionError: 0,
    lastEnactedTick:    tick,
  }
}

function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// ─── availability ⇄ state-entity codec (P2) ──────────────────────────────────

/** State-entity type for a mirrored availability entry. */
export const AVAILABILITY_ENTITY_TYPE = 'agency.availability'

/** Stable entity id for a schema's availability mirror (idempotent re-writes). */
export function availabilityEntityId( schema: string ): string { return `agency-availability-${ schema }` }

/** Encode one availability entry as a state entity. */
function availabilityEntity( schema: string, value: number, lastRefusedTick: number ): EntityInput {
  return {
    id:   availabilityEntityId( schema ),
    type: AVAILABILITY_ENTITY_TYPE,
    metadata: { schema, value, lastRefusedTick },
  }
}

// ─── composite ⇄ state-entity codec (snapshot/replay) ────────────────────────

/** State-entity type for a mirrored composite template. */
export const SCHEMA_ENTITY_TYPE = 'agency.schema'

/** Stable entity id for a schema's mirror (no timestamp → idempotent re-writes). */
export function schemaEntityId( schemaId: string ): string { return `agency-schema-${ schemaId }` }

/** Encode a composite template as a state entity (round-trips via readSchema). */
function schemaEntity( s: MotorSchema ): EntityInput {
  return {
    id:   schemaEntityId( s.id ),
    type: SCHEMA_ENTITY_TYPE,
    metadata: {
      id:            s.id,
      kind:          s.kind,
      source:        s.source,
      cost:          s.cost,
      binds:         s.binds,
      preconditions: s.preconditions,
      composedOf:    s.composedOf,
      baseValence:   s.baseValence,
      description:   s.description,
      tags:          s.tags,
    },
  }
}

/** Decode a mirrored schema entity back into a MotorSchema (undefined if malformed). */
function readSchema( m: Record<string, unknown> | undefined ): MotorSchema | undefined {
  const meta = m ?? {}
  const id   = typeof meta['id'] === 'string' ? meta['id'] as string : undefined
  const kind = meta['kind']
  if( !id || ( kind !== 'composite' && kind !== 'primitive') ) return undefined
  return {
    id,
    kind,
    source:        ( meta['source'] as MotorSchema['source'] ) ?? 'repertoire',
    cost:          typeof meta['cost'] === 'number' ? meta['cost'] as number : 0,
    binds:         ( meta['binds'] as MotorSchema['binds'] ) ?? 'none',
    preconditions: meta['preconditions'] as MotorSchema['preconditions'],
    composedOf:    Array.isArray( meta['composedOf'] ) ? meta['composedOf'] as string[] : undefined,
    baseValence:   typeof meta['baseValence'] === 'number' ? meta['baseValence'] as number : undefined,
    description:   typeof meta['description'] === 'string' ? meta['description'] as string : undefined,
    tags:          Array.isArray( meta['tags'] ) ? meta['tags'] as string[] : undefined,
  }
}

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

import type { MotorSchema, LearnedSkill } from '#agency/types'
import type { EntityInput, ReadonlySimulationState } from '#core/types'
import { INNATE_SCHEMAS } from '#agency/schemas/innate'

const VALUE_ALPHA       = 0.2   // value EMA rate
const ERROR_BETA        = 0.2   // prediction-error EMA rate
const HABIT_GAIN        = 0.12  // habit growth on confident success
const HABIT_FAIL_DECAY  = 0.10  // habit erosion on surprise / failure
const CONFIDENT_ERROR   = 0.30  // prediction error below this counts as "predictable"
const PROC_THRESHOLD    = 0.60  // habit at/above this is "proceduralized"

const IDLE_TICKS        = 200   // ticks of disuse before forgetting starts
const DECAY_RATE        = 0.02  // habit lost per decay application
const DROP_HABIT        = 0.05  // below this (and learned) the skill is forgotten

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
    this._templates.set( schema.id, schema )
  }

  // ── skills ────────────────────────────────────────────────────
  skills(): ReadonlyMap<string, LearnedSkill> { return this._skills }
  getSkill( id: string ): LearnedSkill | undefined { return this._skills.get( id ) }

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
   * Forgetting curve over the competence layer. Skills unused for IDLE_TICKS
   * lose habit; learned composites that fall below DROP_HABIT are dropped
   * entirely (template + skill). Returns the schema ids that were forgotten.
   */
  decay( tick: number ): string[] {
    const dropped: string[] = []
    for( const [ id, skill ] of this._skills ){
      if( tick - skill.lastEnactedTick <= IDLE_TICKS ) continue

      const habitStrength = clamp01( skill.habitStrength - DECAY_RATE )
      if( this._learned.has( id ) && habitStrength < DROP_HABIT ){
        this._skills.delete( id )
        this._templates.delete( id )
        this._learned.delete( id )
        dropped.push( id )
        continue
      }
      this._skills.set( id, { ...skill, habitStrength } )
    }
    return dropped
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

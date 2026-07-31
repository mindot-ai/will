// ─────────────────────────────────────────────────────────────
// src/agency/affordance.synthesizer.ts  —  head of the agency pipeline
// ─────────────────────────────────────────────────────────────
//
// The AffordanceSynthesizer is the Gibsonian move: instead of a static catalog
// the executive selects from, perception *emits* the field of what is possible
// right now, for this body, in this state. It runs every tick with no LLM.
//
// Each tick it draws on:
//   • the innate floor    — reflexive, objectless possibilities (always present)
//   • salient percepts    — "inspect this", bound to what perception surfaced
//   • known sentient minds — "reach out to them", bound to the relationship
//   • (Phase 3) the repertoire of learned composite skills
//
// Two properties make it mind-shaped, not framework-shaped:
//   1. Parameters are bound *at perception time* from the evoking thing, so an
//      affordance can never arrive at execution with empty arguments.
//   2. Attention gates the WIDTH of the field — a depleted or unfocused mind
//      literally has fewer possibilities available to it. The body shapes the
//      option set, not just the choice.
//
// Output: transient `affordance` entities (the field is rebuilt every tick),
// plus metrics and an `affordance.field.synthesized` bus event for the selector
// and telemetry. See AGENCY_PIPELINE_TODO.md.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { Affordance, AffordanceSource, MotorSchema, LearnedSkill, SchemaPrecondition } from '#agency/types'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import { INNATE_SCHEMAS } from '#agency/schemas/innate'
import { collectGoalTargets } from '#agency/selection.scoring'
import { readEffectiveParams } from '#cognition/persona.prior'
import { liveConsequences, enactionFootprint, spokenAtByEntity, CONSEQUENCE_TTL_TICKS, type ConsequenceDescriptor } from '#agency/consequence'

/** Default field width for non-innate affordances when no attention metric exists. */
const DEFAULT_ATTENTION_CAP = 5
/** Hard ceiling so a flood of percepts can never explode the field. */
const MAX_ATTENTION_CAP = 12
/** Pre-activation floor for an ideomotor candidate — the executive deliberately willed
 *  it, so it should reliably reach the field, but it still competes in the selector. */
const IDEOMOTOR_BASE_SALIENCE = 0.5

type SkillAccessor = () => ReadonlyMap<string, LearnedSkill>

interface Candidate {
  /** Coarse evoke-salience used only for attention budgeting (selection scores later). */
  salience:   number
  affordance: Affordance
}

export class AffordanceSynthesizer implements CognitiveEngine {
  readonly name = 'affordance-synthesizer'

  private _schemas:     MotorSchema[]
  private _skills:      SkillAccessor | null = null
  private _repertoire:  SchemaRepertoire | null = null

  /**
   * This tick's live consequence descriptors — the acts the mind has performed
   * whose outcome has not yet come back. Refreshed once at the top of react()
   * because `_build` runs per candidate and reading them is a full-entity scan.
   */
  private _inFlight: readonly ConsequenceDescriptor[] = []

  /** Ticks an act stays satiating (engine-config-action-selector.repeatWindowTicks). */
  private _satiationWindow: number = CONSEQUENCE_TTL_TICKS

  /** Tick of the last thing said to each entity — outlives the descriptor sweep. */
  private _spokenAt: ReadonlyMap<string, number> = new Map()
  private _bus:         CognitiveBus | null = null
  private _defaultCap:  number
  private _lastFieldSize = 0

  constructor( schemas: MotorSchema[] = INNATE_SCHEMAS, defaultCap = DEFAULT_ATTENTION_CAP ){
    this._schemas    = schemas
    this._defaultCap = defaultCap
  }

  // ── wiring ────────────────────────────────────────────────────
  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  /** Inject the repertoire's learned-skill accessor (Phase 3). */
  attachSkills( accessor: SkillAccessor ): void { this._skills = accessor }
  /**
   * Attach the live repertoire — its templates (innate floor + learned composites)
   * become the schema set, and its skills feed the affordance priors. This is how
   * a newly-learned composite shows up in the field without a restart.
   */
  attachRepertoire( repertoire: SchemaRepertoire ): void { this._repertoire = repertoire }
  /** Register an additional schema template (e.g. a learned composite). */
  registerSchema( schema: MotorSchema ): void { this._schemas.push( schema ) }

  // ── CognitiveEngine interface ─────────────────────────────────
  publishes(): CognitiveEventSchema[] {
    return [ { type: 'affordance.field.synthesized', version: 1, validate: () => null } ]
  }
  subscribes(): string[] { return [] }
  onCognitiveEvent(): void { /* pull model — reads frozen state each tick */ }
  snapshot(): Record<string, unknown> { return { lastFieldSize: this._lastFieldSize } }

  // ── react ─────────────────────────────────────────────────────
  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    // Rehydrate learned composites the executor needs to resolve. After a
    // snapshot/restore the repertoire is rebuilt innate-only; the composite
    // *definitions* come back as `agency.schema` entities (written by the
    // ReafferenceEngine). Doing this here — the first agency engine each tick —
    // means the executor, which ticks later in the SAME tick, sees a whole
    // repertoire and can expand a restored mid-flight macro. Idempotent.
    this._repertoire?.restoreComposites( state.entities )
    // Availability entries (P2) rehydrate the same way, so a restored Will keeps
    // its learned suppressions instead of re-probing forbidden abilities.
    this._repertoire?.restoreAvailability( state.entities )

    const schemas   = this._repertoire?.schemas() ?? this._schemas
    const skills    = this._skills?.() ?? this._repertoire?.skills() ?? null
    const valence   = metric( state, 'affect.valence', 0 )
    const energyLow = metric( state, 'energy.level', 0 ) < 30

    // The mind's own acts still in flight (EXAFFERENCE P5). Read once per tick —
    // `_build` runs for every candidate and this is a full-entity scan. Each
    // candidate whose (schema, target) matches one of these carries a decaying
    // `justEnacted`, so having just done a thing damps doing it again.
    this._inFlight = liveConsequences( state.entities, tick )
    // How long this mind sits with something it has already done before doing it
    // again — the tenant's, not the container's. Falls back to the echo TTL only
    // when unseeded, so a bare harness behaves as before.
    this._satiationWindow = readEffectiveParams( state, 'engine-config-action-selector').repeatWindowTicks
      ?? CONSEQUENCE_TTL_TICKS
    // Durable "when did I last speak to them". Descriptors alone cannot carry
    // satiation — the executor deletes them at their echo TTL, so any window
    // longer than that was a no-op.
    this._spokenAt = spokenAtByEntity( state.entities )

    const set:    EntityInput[] = []
    const del:    string[]      = []

    // Clear the previous tick's field — affordances are transient.
    for( const [ id, e ] of state.entities )
      if( e.type === 'affordance') del.push( id )

    // ── 1. innate floor — always emitted, never attention-capped ──
    const floor = schemas.filter( s => s.binds === 'none')
    for( const schema of floor )
      set.push( this._toEntity( this._build( schema, tick, state, valence, energyLow, skills, {} ) ) )

    // ── 2. perception-bound candidates, attention-budgeted ───────
    // Goal-relevance counts at the CAP, not only at selection: an affordance whose
    // target an active goal is directed at is lifted here so goal-driven outreach
    // isn't out-competed by ambient rumination before the selector (which also
    // scores goalRelevance) ever sees it. Same `goalTargets` notion as the selector.
    const candidates:  Candidate[]           = []
    const goalTargets: Map<string, number>   = collectGoalTargets( state )

    const perceptSchema = schemas.find( s => s.binds === 'percept')
    if( perceptSchema )
      for( const [ id, e ] of state.entities ){
        if( e.type !== 'percept') continue

        const m        = e.metadata
        const salience = num( m?.['salience'], 0 )
        const summary  = str( m?.['summary'] ) ?? str( m?.['category'] ) ?? 'something'
        const target   = str( m?.['entityId'] ) ?? str( m?.['targetEntityId'] )

        candidates.push({
          salience: salience + ( target ? goalTargets.get( target ) ?? 0 : 0 ),
          affordance: this._build( perceptSchema, tick, state, valence, energyLow, skills, {
            evokedBy:       id,
            targetEntityId: target,
            parameters:     { focus: summary },
          } ),
        })
      }

    // Target-bound schemas are bound against each perceived known-entity of the
    // matching kind: `binds: 'entity'` schemas (innate `reach-out` + host
    // person-effectors) to sentient entities, `binds: 'object'` schemas to
    // things — so the Will can direct `give`/`greet` at someone or `use`/`pick-up`
    // at something in particular. Each (schema × target) enters as a candidate at
    // the target's salience and competes through the attention cap.
    const personSchemas = schemas.filter( s => s.binds === 'entity')
    const objectSchemas = schemas.filter( s => s.binds === 'object')

    if( personSchemas.length > 0 || objectSchemas.length > 0 )
      for( const [ id, e ] of state.entities ){
        if( e.type !== 'known-entity') continue

        const m    = e.metadata
        const kind = str( m?.['kind'] )
        const applicable = kind === 'sentient' ? personSchemas : kind === 'thing' ? objectSchemas : null

        if( !applicable || applicable.length === 0 ) continue

        const keid = str( m?.['keid'] ) ?? id
        const fam  = num( m?.['familiarity'], 0 )
        const val  = num( m?.['valence'], 0 )
        const res  = num( m?.['resolutionConfidence'], 0 )
        const salience = fam * 0.6 + Math.max( 0, val ) * 0.3 + res * 0.1 + ( goalTargets.get( keid ) ?? 0 )
        const name     = str( m?.['name'] ) ?? keid

        for( const schema of applicable )
          candidates.push({
            salience,
            affordance: this._build( schema, tick, state, valence, energyLow, skills, {
              evokedBy:       id,
              targetEntityId: keid,
              parameters:     { targetEntityName: name },
            } ),
          })
      }

    // ── ideomotor candidates: the executive's imagined actions, pre-activated ──
    // The executive writes `ideomotor.intent` entities for the actions it imagines
    // (its "what if I…"). They enter the field as HIGH-salience candidates — it
    // deliberately willed them — but still COMPETE in the selector; they never bypass
    // it. This is the AffordanceSource.ideomotor leg: executive intention → an
    // affordance that competes like any other.
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'ideomotor.intent') continue

      const m        = e.metadata
      const schemaId = str( m?.['schema'] )
      const schema   = schemaId ? schemas.find( s => s.id === schemaId ) : undefined

      if( !schema ) continue

      // `priority` is the confidence the executive decided with. It sets BOTH the
      // evoke-salience (field admission) and — via willBias — the activation the
      // selector scores, so a decision made at 0.85 pushes harder than one at 0.5.
      const willBias = clamp01( num( m?.['priority'], 0.8 ) )
      candidates.push({
        salience: IDEOMOTOR_BASE_SALIENCE + willBias,
        affordance: this._build( schema, tick, state, valence, energyLow, skills, {
          evokedBy:       id,
          targetEntityId: str( m?.['targetEntityId'] ),
          parameters:     ( m?.['parameters'] as Record<string, unknown> ) ?? {},
          source:         'ideomotor',
          willBias,
        } ),
      })
    }

    // ── plan priors: an executing plan's frontier step, pre-activated ──────────
    // A plan does not dispatch its steps; it BIASES the competition toward the
    // action its current frontier needs. The PlanningEngine writes one `plan.prior`
    // per ready frontier step; each enters the field as a HIGH-salience candidate
    // (the frontier is willed) carrying a `planBias` the scorer weighs and the
    // planId/stepId provenance that flows through to action.outcome so the plan
    // advances when the field actually enacts it. Like ideomotor, it never bypasses
    // the selector — if a more pressing affordance wins, the plan simply re-projects
    // next tick. The suggested schema must resolve in the repertoire; if it does not,
    // the prior cannot surface as an action and the plan waits / replans.
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'plan.prior') continue

      const m        = e.metadata
      const schemaId = str( m?.['schema'] )
      const schema   = schemaId ? schemas.find( s => s.id === schemaId ) : undefined

      if( !schema ) continue

      const planBias = clamp01( num( m?.['planBias'], 0.6 ) )
      candidates.push({
        salience: IDEOMOTOR_BASE_SALIENCE + planBias,
        affordance: this._build( schema, tick, state, valence, energyLow, skills, {
          evokedBy:       id,
          targetEntityId: str( m?.['targetEntityId'] ),
          parameters:     ( m?.['parameters'] as Record<string, unknown> ) ?? {},
          source:         'plan',
          planBias,
          planId:         str( m?.['planId'] ),
          stepId:         str( m?.['stepId'] ),
        } ),
      })
    }

    // Attention gates the WIDTH of the field: keep only the top-salient few.
    const cap = this._attentionCap( state )
    candidates.sort( ( a, b ) => b.salience - a.salience )
    for( const c of candidates.slice( 0, cap ) )
      set.push( this._toEntity( c.affordance ) )

    // ── 3. metrics + telemetry ───────────────────────────────────
    const fieldSize      = set.length
    const availableCount = set.reduce( ( n, e ) => n + ( e.metadata?.['available'] ? 1 : 0 ), 0 )
    this._lastFieldSize  = fieldSize

    const commands: StateCommands = {
      set,
      delete:  del,
      metrics: [
        [ 'affordance.field_size',      fieldSize ],
        [ 'affordance.available_count', availableCount ],
      ],
    }

    if( this._bus ){
      try {
        this._bus.publish({
          type:         'affordance.field.synthesized',
          version:      1,
          sourceEngine: this.name,
          salience:     0.3,
          payload:      { size: fieldSize, availableCount, tick },
        })
      }
      catch( err ){
        logger.warn(`[affordance] bus publish failed: ${ err instanceof Error ? err.message : String( err ) }`)
      }
    }

    return { commands }
  }

  // ── internals ─────────────────────────────────────────────────

  /** Compose an Affordance from a schema + the evoking context, folding in learned priors. */
  private _build(
    schema:   MotorSchema,
    tick:     Tick,
    state:    ReadonlySimulationState,
    valence:  number,
    energyLow: boolean,
    skills:   ReadonlyMap<string, LearnedSkill> | null,
    ctx: {
      evokedBy?:       string
      targetEntityId?: string
      parameters?:     Record<string, unknown>
      source?:         AffordanceSource
      planBias?:       number
      willBias?:       number
      planId?:         string
      stepId?:         string
    },
  ): Affordance {
    const skill = skills?.get( schema.id )

    // Policy availability (P2): omitted when fully available (1), so a never-refused
    // Will's affordance field is byte-identical. Present only once a refusal dented it.
    const availability = this._repertoire?.availabilityOf( schema.id ) ?? 1

    // What the mind has LEARNED about the person this act is aimed at. Only for a
    // targeted act; 0 for everything else, so the field is unchanged for a mind that
    // knows no one. See Affordance.socialPrior.
    const socialPrior = ctx.targetEntityId
      ? socialStanding( state, ctx.targetEntityId )
      : 0

    // Learned value if known, else the schema's intrinsic prior mapped to 0..1.
    const expectedReward = skill?.valueEstimate ?? clamp01( ( ( schema.baseValence ?? 0 ) + 1 ) / 2 )
    const expectedValence = schema.baseValence ?? valence
    const habitStrength   = skill?.habitStrength ?? 0
    // Low energy makes everything feel costlier.
    const cost            = clamp01( schema.cost * ( energyLow ? 1.5 : 1 ) )

    // This act's own footprint, if it is still in flight toward this same person.
    // Satiation only applies to acts aimed at someone the mind SPEAKS to — the
    // `conversation.sent` half is keyed by person, so it must not damp, say,
    // inspecting them.
    const speaks = schema.tags?.includes('communication') ?? false
    const justEnacted = enactionFootprint(
      this._inFlight, schema.id, ctx.targetEntityId, tick, this._satiationWindow,
      speaks ? this._spokenAt : undefined,
    )

    const key    = ctx.targetEntityId ?? ctx.evokedBy ?? schema.id
    const source = ctx.source ?? schema.source
    // A non-default-source candidate (ideomotor) gets a distinct id so it can coexist
    // with a same-schema/target candidate evoked from another source (e.g. entity-bound).
    const idTag  = ctx.source && ctx.source !== schema.source ? `-${ ctx.source }` : ''

    return {
      id:              `affordance-${ tick }-${ schema.id }-${ key }${ idTag }`,
      schema:          schema.id,
      source,
      parameters:      { ...( skill?.paramPriors ?? {} ), ...( ctx.parameters ?? {} ) },
      targetEntityId:  ctx.targetEntityId,
      evokedBy:        ctx.evokedBy,
      expectedValence,
      expectedReward,
      cost,
      habitStrength,
      available:       this._available( schema.preconditions, ( k ) => metric( state, k, 0 ) ),
      tags:            schema.tags ?? [],
      ...( schema.description ? { description: schema.description } : {} ),
      ...( availability < 1 ? { availability } : {} ),
      ...( socialPrior !== 0 ? { socialPrior } : {} ),
      ...( justEnacted > 0 ? { justEnacted } : {} ),
      planBias:        ctx.planBias,
      willBias:        ctx.willBias,
      planId:          ctx.planId,
      stepId:          ctx.stepId,
      tick,
    }
  }

  private _toEntity( a: Affordance ): EntityInput {
    return {
      id:   a.id,
      type: 'affordance',
      metadata: {
        schema:          a.schema,
        source:          a.source,
        parameters:      a.parameters,
        targetEntityId:  a.targetEntityId,
        evokedBy:        a.evokedBy,
        expectedValence: a.expectedValence,
        expectedReward:  a.expectedReward,
        cost:            a.cost,
        habitStrength:   a.habitStrength,
        available:       a.available,
        tags:            a.tags,
        description:     a.description,
        ...( a.availability !== undefined ? { availability: a.availability } : {} ),
        ...( a.socialPrior !== undefined ? { socialPrior: a.socialPrior } : {} ),
        planBias:        a.planBias,
        willBias:        a.willBias,
        planId:          a.planId,
        stepId:          a.stepId,
        tick:            a.tick,
      },
    }
  }

  private _available(
    preconditions: SchemaPrecondition[] | undefined,
    read: ( metric: string ) => number,
  ): boolean {
    if( !preconditions ) return true
    return preconditions.every( pc => {
      const cur = read( pc.metric )
      switch( pc.op ){
        case 'gt':  return cur >  pc.value
        case 'lt':  return cur <  pc.value
        case 'gte': return cur >= pc.value
        case 'lte': return cur <= pc.value
        case 'eq':  return cur === pc.value
        default:    return false
      }
    })
  }

  private _attentionCap( state: ReadonlySimulationState ): number {
    const cap = state.metrics.get('attention.capacity') ?? this._defaultCap
    return Math.max( 1, Math.min( MAX_ATTENTION_CAP, Math.round( cap ) ) )
  }
}

// ─── module helpers ──────────────────────────────────────────────────────────

function metric( state: ReadonlySimulationState, key: string, fallback: number ): number {
  return state.metrics.get( key ) ?? fallback
}

function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * The mind's learned read on one person, −1..1 (0 = unknown or neutral).
 *
 * Every input is something the mind formed from experience, none is a constant:
 *   • ReputationTracker's `trustworthiness`, centred on 0.5 and scaled by that
 *     model's own `confidence`, so an opinion held on two interactions pushes
 *     far less than one held on fifty.
 *   • the mind's current affective tone, as a gentle tilt — feeling low makes
 *     reaching for anyone a little less attractive, which is a mood, not a verdict
 *     on them, so it is weighted small and applies the same way to everybody.
 *
 * This is the path by which "they never answer me" reaches the competition: the
 * ReputationTracker learns it from `interaction.occurred`, which only started firing
 * once inbound conversation reached social cognition (#113).
 */
function socialStanding( state: ReadonlySimulationState, keid: string ): number {
  let trust = 0
  for( const e of state.entities.values() ){
    if( e.type !== 'reputation') continue
    const m = e.metadata as Record<string, unknown> | undefined
    if( m?.['keid'] !== keid ) continue
    const t = num( m['trustworthiness'], 0.5 )
    const c = clamp01( num( m['confidence'], 0 ) )
    trust = ( t - 0.5 ) * 2 * c
    break
  }

  const mood = num( state.metrics.get('affect.valence'), 0 ) * 0.25
  return Math.max( -1, Math.min( 1, trust + mood ) )
}

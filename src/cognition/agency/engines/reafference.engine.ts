// ─────────────────────────────────────────────────────────────
// src/agency/reafference.engine.ts  —  prediction error → competence
// ─────────────────────────────────────────────────────────────
//
// Reafference is the loop that makes the Will grow. Each tick it reads the
// `agency.outcome` records the executor wrote, folds each into its schema's
// LearnedSkill (value, habit, prediction error, param priors — see
// repertoire.ts), and mirrors the updated skills into `agency.skill` state
// entities so they snapshot, surface in telemetry, and travel in the PMA. It
// likewise mirrors learned composite *templates* into `agency.schema` entities
// so the invented multi-step programs survive a restore (the executor resolves
// the template to expand a macro); restoreComposites() rehydrates them.
//
// The behavioural payoff closes the loop with selection: a schema that succeeds
// reliably AND predictably crosses the proceduralization threshold, which both
// raises its activation (additive habit bonus) and relaxes its deliberation
// threshold — so it stops recruiting the LLM. Inference spend falls as the Will
// learns. Disuse runs the forgetting curve in the other direction.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { LearnedSkill } from '#agency/types'
import type { CognitiveBus, CognitiveEvent } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import { schemaEntityId, availabilityEntityId } from '#agency/schemas/repertoire'
import { asFinality } from '#stem/policy/arbiter'
import { AWAIT_TIMEOUT } from '#agency/engines/motor.schema.executor'
import { readEffectiveParams } from '#cognition/persona.prior'
import {
  SENT_TYPE, DEFAULT_REPLY_WINDOW_TICKS, resolveReplyExpectations,
} from '#agency/conversation.aim'

const PROC_THRESHOLD = 0.60   // mirror of repertoire's threshold for the habitual-count metric

/**
 * EXAFFERENCE P5 — soft outcome quality for a purely *sensory* confirmation: the
 * world echoed our action back (a reafferent percept), but no host ack graded it.
 * A modest positive — "it manifested" — below a host ack's 0.8, enough to free the
 * awaiting intent and accrue competence instead of letting it time out as a failure.
 */
const SENSORY_SOFT_QUALITY = 0.6

/**
 * Registry #5 — the affect→percept valence seam, consumed. The echo now carries
 * how the mind FEELS about what came back (Exteroception stamps it), so a
 * sensory confirmation is graded rather than flat: quality = the soft base
 * shifted by that valence within a bounded band.
 *
 * Two spans, because the two valence sources are not equal evidence:
 *  • `'entity'` — the KnownEntityTracker's felt valence toward this very thing.
 *    Real appraisal of the outcome ⇒ the wider span.
 *  • `'ambient'` — the mind's mood at perception time. Weak context, NOT a
 *    judgement of this action ⇒ a narrow span, so a bad mood cannot teach the
 *    Will that a working skill failed.
 *
 * Neutral (or absent) valence reproduces the pre-seam 0.6 exactly.
 */
const SENSORY_VALENCE_SPAN_ENTITY  = 0.25
const SENSORY_VALENCE_SPAN_AMBIENT = 0.10
/** Below this the world's reflection reads as a failed outcome, not a success. */
const SENSORY_SUCCESS_FLOOR = 0.5

export class ReafferenceEngine implements CognitiveEngine {
  readonly name = 'reafference'

  private _repertoire: SchemaRepertoire
  private _bus: CognitiveBus | null = null

  constructor( repertoire: SchemaRepertoire ){ this._repertoire = repertoire }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'agency.skill.proceduralized', version: 1, validate: () => null },
      { type: 'agency.schema.discovered',    version: 1, validate: () => null },
      // Async-acked outcomes (host-ack reconciliation) flow through here, not the
      // executor — so for a plan-tagged reconciled outcome this engine emits the
      // action.outcome the PlanningEngine advances on. (The executor is the emitter
      // for sync/timeout outcomes; this is its async counterpart — one emitter each.)
      { type: 'action.outcome',              version: 1, validate: () => null },
      // Whether a person answers the mind when it speaks to them. Distinct from
      // `interaction.occurred`, which reports something someone DID — a silence is
      // not an act and so can never appear there, which is why "they never answer
      // me" was unlearnable despite `socialStanding` being built to carry it.
      { type: 'social.responsiveness',       version: 1, validate: () => null },
    ]
  }
  /** Creation seam: register a composite proposed by the executive/deliberation facet. */
  subscribes(): string[] { return [ 'agency.composite.proposed' ] }
  onCognitiveEvent( e: CognitiveEvent ): void {
    if( e.type !== 'agency.composite.proposed') return
    const p = e.payload as { id?: string; name?: string; composedOf?: unknown; tags?: unknown; cost?: number }
    const id    = p.id ?? p.name
    const steps = Array.isArray( p.composedOf )
      ? ( p.composedOf as unknown[] ).filter( ( s ): s is string => typeof s === 'string')
      : []
    if( !id || steps.length < 2 ) return   // a composite needs a name + ≥2 sub-schemas

    this._repertoire.registerComposite({
      id, kind: 'composite', source: 'repertoire', binds: 'none',
      cost: typeof p.cost === 'number' ? p.cost : 0.1,
      composedOf: steps,
      tags: Array.isArray( p.tags ) ? ( p.tags as unknown[] ).filter( ( t ): t is string => typeof t === 'string') : [ 'composite' ],
    })
    logger.info(`[reafference] registered proposed composite "${ id }" (${ steps.join(' → ') })`)
  }
  snapshot(): Record<string, unknown> {
    return { skills: this._repertoire.skills().size }
  }

  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    const set:     EntityInput[]            = []
    const del:     string[]                = []
    const metrics: Array<[ string, number ]> = []

    // ── 0. Gather outcomes: real ones from state + synthesized sensory ones ──
    // A `reafferent` percept (P2) carrying a `sourceIntentId` is the world echoing
    // our own action back. If that intent is still `awaiting` and no outcome graded
    // it this tick (a host ack / sync / timeout — those WIN), synthesize a soft
    // outcome so the skill learns and the intent is freed through the senses rather
    // than timing out as a failure (EXAFFERENCE P5). Ack-less awaiting intents only.
    const outcomes: Array<{ id: string; meta: Record<string, unknown>; fromState: boolean }> = []
    const gradedIntentIds = new Set<string>()
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.outcome') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      outcomes.push({ id, meta: m, fromState: true })
      const iid = str( m['intentId'] ); if( iid ) gradedIntentIds.add( iid )
    }

    const awaiting = new Map<string, { schema: string; predictedReward: number; predictedValence: number }>()
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent' || str( e.metadata?.['status'] ) !== 'awaiting') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      // Timeout boundary: at tick - dispatchedAt ≥ AWAIT_TIMEOUT the executor
      // (which ran earlier this tick, off the same frozen snapshot) is writing
      // its timeout-failure outcome right now — stand down so one enaction is
      // never scored twice (soft success here + failure next tick).
      if( tick - num( m['dispatchedAt'], tick ) >= AWAIT_TIMEOUT ) continue
      awaiting.set( id, {
        schema:           str( m['schema'] ) ?? '',
        predictedReward:  num( m['predictedReward'],  0.5 ),
        predictedValence: num( m['predictedValence'], 0 ),
      })
    }

    let sensory = 0
    const sensedIntentIds = new Set<string>()
    for( const [ , e ] of state.entities ){
      if( e.type !== 'percept') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      if( str( m['provenance'] ) !== 'reafferent') continue
      const iid = str( m['sourceIntentId'] )
      if( !iid || gradedIntentIds.has( iid ) || sensedIntentIds.has( iid ) ) continue
      const aw = awaiting.get( iid )
      if( !aw || !aw.schema ) continue          // only ack-less awaiting intents
      sensedIntentIds.add( iid )
      sensory++

      // Registry #5: grade the confirmation by how the echo FELT, within a band
      // whose width reflects how much that valence really says about THIS action.
      const feltRaw = m['valence']
      const felt    = typeof feltRaw === 'number' && Number.isFinite( feltRaw ) ? feltRaw : undefined
      const span    = str( m['valenceSource'] ) === 'entity'
        ? SENSORY_VALENCE_SPAN_ENTITY
        : SENSORY_VALENCE_SPAN_AMBIENT
      const quality = felt === undefined
        ? SENSORY_SOFT_QUALITY
        : clamp01( SENSORY_SOFT_QUALITY + Math.max( -1, Math.min( 1, felt ) ) * span )

      outcomes.push({ id: `agency-outcome-${ tick }-${ iid }-sensory`, fromState: false, meta: {
        schema:           aw.schema,
        intentId:         iid,
        success:          quality >= SENSORY_SUCCESS_FLOOR,
        outcomeQuality:   quality,
        valence:          felt ?? aw.predictedValence,
        predictedReward:  aw.predictedReward,
        predictedValence: aw.predictedValence,
        surprise:         clamp01( Math.abs( aw.predictedReward - quality ) ),
        mode:             'external',
        reconciled:       true,
        sensory:          true,
        ...( felt !== undefined ? { sensoryValence: felt, valenceSource: str( m['valenceSource'] ) } : {} ),
        tick,
      } })
    }

    // ── 1. Fold each outcome into its skill ──────────────────────
    let updates    = 0
    let discovered = 0
    let refused    = 0
    for( const { id, meta: m, fromState } of outcomes ){
      const schema = str( m['schema'] )
      if( !schema ){ if( fromState ) del.push( id ); continue }

      // POLICY_REAFFERENCE P2 — a refusal is NOT a failure. Route it to the
      // availability layer and stop: it must never touch LearnedSkill (value,
      // habit, param priors), or the Will learns it is unskilled at something it
      // is merely forbidden to do. The awaiting intent is still freed, and a
      // refused plan step is signalled unsuccessful so the plan doesn't hang.
      if( m['refused'] === true ){
        const finality = asFinality( m['finality'] )

        // P5 — 'context' means the refusal was NOT ABOUT THE ACTION (tainted
        // context, an unavailable dependency, the arbiter itself down). Denting
        // availability here would teach a lesson the policy never taught:
        // "reach for this less", when nothing about the ability was the problem.
        // So the intent is freed and the plan step signalled — the mind must not
        // hang — and NOTHING else is written. Not competence, not availability.
        if( finality !== 'context')
          this._repertoire.recordRefusal( schema, finality, tick )

        if( fromState ) del.push( id )
        const refusedIntent = str( m['intentId'] )
        if( refusedIntent ) del.push( refusedIntent )
        const refusedPlan = str( m['planId'] )
        if( refusedPlan ) this._emitPlanOutcome( refusedPlan, str( m['stepId'] ), schema, false, 0, 0, tick )
        refused++
        continue
      }

      const { skill, proceduralized } = this._repertoire.recordOutcome({
        schema,
        success:         m['success'] === true,
        outcomeQuality:  num( m['outcomeQuality'],  0 ),
        predictedReward: num( m['predictedReward'], 0.5 ),
        params:          ( m['params'] as Record<string, unknown> ) ?? undefined,
        tick,
      })

      set.push( skillEntity( skill ) )
      if( fromState ) del.push( id )       // real outcome consumed (synthetic ones were never in state)
      // Host-ack reconciliation OR sensory confirmation: the outcome carries the
      // awaiting intent's id — free it so the serial Will can act again. The
      // executor's own sync outcomes already deleted their intent, so this is a
      // harmless no-op there.
      const intentId = str( m['intentId'] )
      if( intentId ) del.push( intentId )
      updates++

      // Plan advancement for the async path: a host-acked outcome that carries plan
      // provenance is the ONLY signal the PlanningEngine will get (the executor never
      // saw the ack — the intent was 'awaiting'). Emit the action.outcome it advances
      // on. Sync/timeout outcomes never carry planId here (the executor emitted their
      // action.outcome already), so this never double-advances.
      const planId = str( m['planId'] )
      if( planId )
        this._emitPlanOutcome( planId, str( m['stepId'] ), schema, m['success'] === true, num( m['outcomeQuality'], 0 ), num( m['surprise'], 0 ), tick )

      // Discovery: the first time the Will enacts a schema, it becomes a known part
      // of its repertoire (the new model's "discovered" — earned by doing, not catalogued).
      if( skill.enactments === 1 ){
        discovered++
        this._emitDiscovered( schema, tick )
      }

      if( proceduralized ){
        this._emitProceduralized( skill, tick )
        logger.info(`[reafference] "${ schema }" proceduralized (habit ${ skill.habitStrength.toFixed( 2 ) })`)
      }
    }

    // ── 2. Forgetting curve over the competence layer + availability recovery ──
    const dropped = this._repertoire.decay( tick )
    for( const id of dropped.skills ){
      del.push(`agency-skill-${ id }`)
      del.push( schemaEntityId( id ) )   // composite mirror (harmless no-op for primitives)
    }
    for( const id of dropped.availability )
      del.push( availabilityEntityId( id ) )   // fully-recovered ⇒ remove the mirror

    // ── 3. Mirror learned composite templates + availability ─────
    // Skills become `agency.skill` (above); the invented composite *definitions*
    // must travel too, or a snapshot/restore brings back a skill whose schema is
    // gone and the executor can't expand it. Idempotent re-write each tick, like
    // GoalManager._persistGoals. Empty until a composite is actually learned.
    for( const e of this._repertoire.compositeEntities() )   set.push( e )
    // Availability entries (P2) mirror the same way — empty until a refusal lands.
    for( const e of this._repertoire.availabilityEntities() ) set.push( e )

    // ── 3.5 Did the words achieve what they were for? ────────────
    // The motor loop above graded whether each act EXECUTED. For a communicative
    // act that is the smaller half of the question: the outbox accepting a message
    // is not the world answering it. Both were the same fact until now, which is
    // how `reach-out` came to sit at 28 enactments / 28 successes while the person
    // it kept reaching had said nothing back.
    //
    // Folded here rather than in a new engine because this is the same question
    // this engine already exists to ask, one layer out — reafference over a social
    // act instead of a motor one. The resolution itself is pure (conversation.aim);
    // all that happens here is writing it down and saying it out loud.
    const replied = this._resolveReplies( tick, state, set )

    // ── 4. Telemetry ─────────────────────────────────────────────
    const skills    = this._repertoire.skills()
    const habitual  = [ ...skills.values() ].filter( s => s.habitStrength >= PROC_THRESHOLD ).length
    metrics.push(
      [ 'agency.learning.updates', updates ],
      [ 'agency.discovered.count', discovered ],
      [ 'agency.skill.count',      skills.size ],
      [ 'agency.habitual.count',   habitual ],
      [ 'agency.sensory.confirmed', sensory ],
    )
    // Quiet path stays byte-identical: a Will that has spoken to nobody, or whose
    // every turn was answered, writes nothing here (cf. EXAFFERENCE P3).
    if( replied.answered   > 0 ) metrics.push([ 'social.answered.count',   replied.answered ])
    if( replied.unanswered > 0 ) metrics.push([ 'social.unanswered.count', replied.unanswered ])
    // Only emit the refusal metric when it fired — a never-refused Will writes
    // nothing here, preserving the byte-identical quiet path (cf. EXAFFERENCE P3).
    if( refused > 0 ) metrics.push([ 'agency.refused.count', refused ])

    return { commands: { set, delete: del, metrics } }
  }

  /**
   * Latch each open turn's fate onto its own record and announce it once.
   *
   * Two rules earn their keep here:
   *
   *  • MERGE, never replace. `StateManager.setEntity` overwrites the whole entity,
   *    and a `conversation.sent` carries `outboxMessageIds` — the sole key by which
   *    a later delivery ack can find it. Rewriting the record with only the fields
   *    this method cares about would sever that, silently, for every turn that got
   *    an answer.
   *
   *  • Latch, don't recompute. `answeredAt`/`unansweredAt` persist, so the event
   *    fires on the one tick the fact changed rather than every tick for the rest
   *    of the session — which for an unanswered turn would be thousands of
   *    identical reputation hits against one person for one silence.
   */
  private _resolveReplies(
    tick:  Tick,
    state: ReadonlySimulationState,
    set:   EntityInput[],
  ): { answered: number; unanswered: number } {
    // A trait, not a constant: how long a silence takes to mean something differs
    // between minds, so it tunes through the persona prior like every other
    // developable parameter. Absent ⇒ the default ⇒ the pre-seam behaviour.
    //
    // Read from the SELECTOR's config despite being applied here, because it and
    // `repeatWindowTicks` are two readings of one disposition — how long this mind
    // sits with something it has said. Held apart, a mind could tune itself into
    // saying a thing again while still calling the silence too fresh to count.
    const window = Math.max(
      1,
      Math.round(
        readEffectiveParams( state, 'engine-config-action-selector').replyWindowTicks
          ?? DEFAULT_REPLY_WINDOW_TICKS
      ),
    )

    const { answered, unanswered } = resolveReplyExpectations( state.entities, tick, window )
    if( answered.length === 0 && unanswered.length === 0 ) return { answered: 0, unanswered: 0 }

    const merge = ( id: string, patch: Record<string, unknown> ): void => {
      const existing = state.entities.get( id )
      if( !existing ) return
      set.push({
        id, type: SENT_TYPE,
        metadata: { ...( existing.metadata as Record<string, unknown> ?? {} ), ...patch },
      })
    }

    for( const { turn, at, with: said } of answered ){
      // Their words, not merely the fact of them — see SpokenTurn.answeredWith.
      merge( turn.entityId, { answeredAt: at, ...( said ? { answeredWith: said } : {} ) } )
      this._emitResponsiveness( turn.targetEntityId, true, at - turn.tick, tick )
    }

    for( const turn of unanswered ){
      merge( turn.entityId, { unansweredAt: tick } )
      this._emitResponsiveness( turn.targetEntityId, false, tick - turn.tick, tick )
      logger.info(
        `[reafference] no answer from ${ turn.targetEntityName ?? turn.targetEntityId } ` +
        `after ${ tick - turn.tick } ticks — "${ turn.preview.slice( 0, 60 ) }"`
      )
    }

    return { answered: answered.length, unanswered: unanswered.length }
  }

  /**
   * Publish how a person responded to being spoken to.
   *
   * Deliberately NOT an `interaction.occurred`: that event means "someone did
   * something toward us" and carries a valence for what they did. A silence is
   * nobody doing anything, and forcing it through that channel would have the
   * ReputationTracker book a hostile *act* where there was only an absence — the
   * mind would come to think it was being rebuffed rather than simply not
   * answered yet. Separate signal, separate meaning, one consumer decides what
   * either is worth.
   */
  private _emitResponsiveness( keid: string, answered: boolean, waitedTicks: number, tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'social.responsiveness', version: 1, sourceEngine: this.name,
        // An answer is ordinary; being ignored is the one worth interrupting for.
        salience: answered ? 0.3 : 0.55,
        payload: { keid, answered, waitedTicks, tick },
      })
    }
    catch( err ){ logger.warn(`[reafference] responsiveness publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }

  private _emitProceduralized( skill: LearnedSkill, tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'agency.skill.proceduralized', version: 1, sourceEngine: this.name,
        salience: 0.6,
        payload: { schema: skill.schema, habitStrength: skill.habitStrength, tick },
      })
    }
    catch( err ){ logger.warn(`[reafference] publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }

  /**
   * Emit the `action.outcome{planId,stepId}` for an async (host-acked) plan-step
   * enaction. Mirrors the executor's `_emitActionOutcome` payload so the
   * PlanningEngine's consumer can't tell which path produced it.
   */
  private _emitPlanOutcome(
    planId: string, stepId: string | undefined, schema: string,
    success: boolean, outcomeQuality: number, surprise: number, tick: Tick,
  ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'action.outcome', version: 1, sourceEngine: this.name,
        salience: Math.min( 1, outcomeQuality * 0.6 ),
        payload: {
          actionType: schema, domain: schema, success, outcomeQuality, surprise,
          description: success ? 'The world confirmed the action.' : 'The world rejected the action.',
          planId,
          ...( stepId ? { stepId } : {} ),
          tick,
        },
      })
    }
    catch( err ){ logger.warn(`[reafference] plan outcome publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }

  private _emitDiscovered( schema: string, tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'agency.schema.discovered', version: 1, sourceEngine: this.name,
        salience: 0.5, payload: { schema, tick },
      })
    }
    catch( err ){ logger.warn(`[reafference] discovered publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }
}

// ─── entity mirroring ────────────────────────────────────────────────────────

function skillEntity( s: LearnedSkill ): EntityInput {
  return {
    id: `agency-skill-${ s.schema }`,
    type: 'agency.skill',
    metadata: {
      schema:             s.schema,
      habitStrength:      s.habitStrength,
      valueEstimate:      s.valueEstimate,
      paramPriors:        s.paramPriors,
      enactments:         s.enactments,
      successes:          s.successes,
      avgPredictionError: s.avgPredictionError,
      lastEnactedTick:    s.lastEnactedTick,
    },
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}
function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// ─────────────────────────────────────────────────────────────
// src/agency/motor.schema.executor.ts  —  enaction & the efference copy
// ─────────────────────────────────────────────────────────────
//
// The MotorSchemaExecutor consumes the committed `agency.intent`, predicts its
// own consequences (the efference copy), enacts it, and writes `agency.outcome`
// — the reafference record whose prediction error becomes the teaching signal in
// Phase 4. No LLM.
//
// Three things happen here that the old catalog executor could not:
//   1. Every enaction emits an efference copy (predicted reward/valence) BEFORE
//      the result is known, so an async outcome can still be compared on arrival.
//   2. Parameters are already bound (by the synthesizer), so there is no
//      "empty args" failure mode.
//   3. A COMPOSITE schema actually executes — it expands into ordered primitive
//      sub-intents that run one per tick, accumulate, and finalize into the
//      composite's own outcome. Created skills are runnable, not inert records.
//
// Intent lifecycle (the selector commits 'selected' and then defers while busy):
//   selected ─┬─ primitive sync      → outcome written, intent deleted
//             ├─ composite           → 'expanding' + first sub-intent ('selected')
//             └─ communicate/external→ 'awaiting' (reconciled in Phase 4)
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext, SimulationEvent,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { ProactiveCommunicator } from '#agency/proactive.communicator'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import type { SessionLogger } from '#stem/tracts/session.logger'
import type { MotorSchema, EfferenceCopy } from '#agency/types'
import type { AccessGrants } from '#agency/access.grants'
import type { ActionRequest, ActionResult } from '#types'
import { INNATE_SCHEMAS } from '#agency/schemas/innate'
import { enact, type Enaction } from '#agency/execution.primitives'
import { revokedIntentIds, revocationId, staleRevocationIds } from '#agency/revocation'
import { addressesOf } from '#cognition/social.identity'
import { lastAnsweredByEntity } from '#agency/conversation.aim'
import {
  CONSEQUENCE_TYPE, CONSEQUENCE_TTL_TICKS, ENACTED_TYPE,
  consequenceEntity, enactedEntity, fnv1a, paramsKey, spokenAtByEntity } from '#agency/consequence'

/**
 * How long a durable enaction record is kept. Generous against the satiation
 * window (`repeatWindowTicks`, 60 by default) rather than equal to it, because
 * the window is persona-tunable and read in the synthesizer, not here — a
 * retention shorter than some tenant's window would silently reintroduce the
 * very gap this record exists to close. Past this the satiation term is 0
 * regardless, so keeping it longer buys nothing.
 */
const ENACTED_RETENTION_TICKS = 600

/** Ticks an async (communicate/external) intent may stay 'awaiting' before it is
 *  abandoned. Exported: the ReafferenceEngine's sensory-confirmation path (P5)
 *  stands down at this boundary so the executor's timeout-failure wins. */
export const AWAIT_TIMEOUT = 15

/** Map a communicate schema to the ProactiveCommunicator effector + the permission name. */
const COMM_SCHEMA_TO_EFFECTOR: Record<string, string> = {
  'reach-out': 'text', talk: 'talk', text: 'text', gesture: 'gesture', broadcast: 'broadcast',
}

interface Intent {
  id:              string
  schema:          string
  affordanceId?:   string
  targetEntityId?: string
  parameters:      Record<string, unknown>
  expectedReward:  number
  expectedValence: number
  parentIntentId?: string
  stepIndex?:      number
  /**
   * Provenance: set when this intent was committed from a plan's frontier-step prior
   * that won the competition (NOT a dispatched step — there is no dispatch). Threaded
   * out on `action.outcome` so the PlanningEngine advances the plan that biased it.
   */
  planId?:         string
  planStepId?:     string
  /**
   * The entity that evoked this — for an ideomotor winner, the `ideomotor.intent`
   * the executive wrote. Read so enaction can retire it (see _dischargeWill).
   */
  evokedBy?:       string
}

/**
 * What an authoring pass produced.
 *
 * `bubbles` empty is AMBIGUOUS on its own — it is also what a timed-out facet, a
 * full facet budget, and a pass deferring to one already in flight all return.
 * `withheld` is the one case that is an ANSWER: the mind considered speaking and
 * declared silence. Only that resolves the intent; the others keep holding, and
 * the clock still abandons a genuinely dead author.
 */
export interface OutreachResult {
  bubbles:   string[]
  withheld?: boolean
}

/** Authors the words for a self-initiated communicate the agency selected (no inbound triggered it). */
export interface OutreachAuthor {
  /** An array return is still honoured — it reads as "no words, and I am not saying why". */
  authorOutreach( entityId: string, entityName: string, gist?: string ): Promise<string[] | OutreachResult>
}

export class MotorSchemaExecutor implements CognitiveEngine {
  readonly name = 'motor-schema-executor'

  private _schemas = new Map<string, MotorSchema>()
  private _repertoire: SchemaRepertoire | null = null
  private _comms:  ProactiveCommunicator | null = null
  private _author: OutreachAuthor | null = null
  private _grants: AccessGrants | null = null
  private _bus: CognitiveBus | null = null

  /**
   * Two-phase outreach authoring. A facet cannot be awaited from inside a tick:
   * `ExecutiveFacet.report()` only QUEUES in tick-discipline mode and the reasoning
   * launches from `pump()`, which the ExecutiveEngine calls once per tick — so an
   * in-tick `await` blocks the very loop that would produce the answer. Observed
   * live: a 61s freeze of the whole mind inside one tick, then an empty result.
   * (It passes unit tests because bare facets have no inbox and author inline.)
   *
   * So `_deliver` REQUESTS words and returns false (the intent holds 'awaiting'),
   * the facet answers off-tick, and a later tick delivers. Process-local by design:
   * an authoring call in flight cannot survive a restart, and the intent would
   * simply re-request.
   */
  private _authoring = new Set<string>()
  private _authored  = new Map<string, string[]>()
  /**
   * Intents whose facet considered speaking and chose NOT to.
   *
   * A declined outreach used to resolve by rotting: no words arrived, so the
   * intent sat 'awaiting' until AWAIT_TIMEOUT abandoned it as a FAILURE — and
   * reafference folded that into `reach-out`'s competence. The mind was learning
   * it is bad at speaking from the times it decided not to speak. Live, a COO
   * declining correctly ("nothing new to add — a sixth message would repeat")
   * took a competence hit for the judgement.
   *
   * Silence is an ANSWER, not the absence of one. Held here so the sweep can
   * resolve it as what it is: the intent is freed, and nothing is taught about
   * an ability that was never in question.
   */
  private _withheld  = new Map<string, string>()

  /**
   * The tick at which each held intent's words were REQUESTED from a facet.
   *
   * Authoring is off-tick and can take 10–30s of real time. In that window the
   * situation the words were composed for can move — and until now nothing
   * looked. See `situationMoved`.
   */
  private _composedAt = new Map<string, Tick>()

  constructor( schemas: MotorSchema[] = INNATE_SCHEMAS ){
    for( const s of schemas ) this._schemas.set( s.id, s )
  }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  /** Resolve schemas (incl. learned composites) from the live repertoire first. */
  attachRepertoire( repertoire: SchemaRepertoire ): void { this._repertoire = repertoire }
  /** Inject the communicate-enaction handler (owned here; the only caller). */
  attachProactiveCommunicator( c: ProactiveCommunicator ): void { this._comms = c }
  /** Inject the outreach author — words for a self-initiated communicate are authored on selection. */
  attachOutreachAuthor( a: OutreachAuthor ): void { this._author = a }
  /** Forward the session logger to the owned ProactiveCommunicator (it audits outbound). */
  attachSessionLogger( logger: SessionLogger | null ): void { this._comms?.attachSessionLogger( logger ) }
  /** Inject the permission gate so outbound communication is grant-checked. */
  attachGrants( g: AccessGrants ): void { this._grants = g }
  registerSchema( schema: MotorSchema ): void { this._schemas.set( schema.id, schema ) }

  /** Repertoire-first schema resolution, falling back to the local seed set. */
  private _resolve( id: string ): MotorSchema | undefined {
    return this._repertoire?.getSchema( id ) ?? this._schemas.get( id )
  }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'agency.enacted',    version: 1, validate: () => null },
      { type: 'agency.invocation', version: 1, validate: () => null },
      { type: 'agency.communicate', version: 1, validate: () => null },
      { type: 'action.withheld',    version: 1, validate: () => null },
    ]
  }
  subscribes(): string[] { return [] }

  /**
   * The executor is plan-agnostic. A plan does NOT dispatch steps here — it biases
   * the affordance competition (see PLANNING_AS_PRIOR_TODO.md), so a plan-driven
   * action reaches the executor as an ordinary committed `agency.intent` the
   * selector won. That intent already carries planId/stepId provenance (stamped by
   * the selector from the winning affordance); `_emitActionOutcome` threads it back
   * out, which is how the PlanningEngine advances. Nothing plan-specific here.
   */
  onCognitiveEvent(): void { /* pull model — reads committed intents from frozen state */ }

  snapshot(): Record<string, unknown> { return { schemas: this._schemas.size } }

  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    const set: EntityInput[]        = []
    const del: string[]            = []
    const metrics: Array<[ string, number ]> = []
    // Dispatch announcements bound for the SIMULATION bus — the only one the host
    // hears. See _emitDispatch: the cognitive copy reaches the mind's own
    // faculties and reaches no host at all.
    const events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = []

    const energy = state.metrics.get('energy.level') ?? 100
    const stress = state.metrics.get('stress.load'  ) ?? 0

    // ── Expire consequence descriptors (EXAFFERENCE P1) ──────────
    // Descriptors deliberately outlive intent resolution (the sensory echo of a
    // reconciled action still arrives); their only cleanup is this TTL sweep.
    for( const [ id, e ] of state.entities ){
      if( e.type !== CONSEQUENCE_TYPE ) continue
      if( tick >= num( e.metadata?.['expiresAt'], 0 ) ) del.push( id )
    }

    // ── Expire durable enaction records ──────────────────────────
    // One per (schema, target), refreshed in place, so the live set is bounded
    // by pairs actually enacted rather than by enactions — but a Will that meets
    // many people would still accrete one per person per schema forever, and the
    // soak test asserts entities plateau. Dropped once no satiation window could
    // still be reading them: past ENACTED_RETENTION_TICKS the term is 0 anyway,
    // so the record is indistinguishable from its own absence.
    for( const [ id, e ] of state.entities ){
      if( e.type !== ENACTED_TYPE ) continue
      const at = num( e.metadata?.['tick'], 0 )
      // A record stamped later than now is a restored one from a previous
      // session (the tick counter restarts on wake) — same trap `liveConsequences`
      // documents. Drop it rather than let it read as "just now" all session.
      if( at > tick || tick - at > ENACTED_RETENTION_TICKS ) del.push( id )
    }

    // ── Revocation tombstones (EXAFFERENCE P4) ───────────────────
    // Reap expired tombstones (intent vanished otherwise), and collect live ones
    // so the selected-processing loop can refuse the half-race case: Deliberation
    // committed `selected` the same tick the tombstone was written (both read the
    // pre-tombstone snapshot), so the intent surfaces here still needing to die.
    del.push( ...staleRevocationIds( state.entities, tick ) )
    const revoked = revokedIntentIds( state.entities, tick )

    // A tombstoned intent dies whatever its status — including an 'expanding'
    // composite parent preempted mid-routine (registry #4) — and takes its
    // sub-intents with it, in any state ('selected' queued by the executor's
    // own in-tick advance, or 'awaiting' a host). The selected-loop guard below
    // additionally prevents enacting any of them this tick.
    if( revoked.size > 0 )
      for( const [ id, e ] of state.entities ){
        if( e.type !== 'agency.intent') continue
        const parentId = str( e.metadata?.['parentIntentId'] )
        if( revoked.has( id ) ) del.push( id, revocationId( id ) )
        else if( parentId && revoked.has( parentId ) ) del.push( id )
      }

    // ── Words that landed off-tick → deliver now ─────────────────
    // Second half of two-phase authoring: a previous tick asked a facet for the words
    // and held the intent 'awaiting'; the facet answered between ticks. Runs BEFORE
    // the timeout sweep so words arriving on the same tick the clock would expire are
    // still spoken rather than discarded.
    const spokeThisTick = new Set<string>()
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent' || str( e.metadata?.['status'] ) !== 'awaiting') continue
      if( !this._authored.has( id ) ) continue

      const intent = readIntent( id, e.metadata )
      const predicted: EfferenceCopy = {
        expectedReward:  num( e.metadata?.['predictedReward'],  intent.expectedReward ),
        expectedValence: num( e.metadata?.['predictedValence'], intent.expectedValence ),
      }
      if( await this._deliver( id, intent, predicted, state, tick, set, del, metrics ) )
        spokeThisTick.add( id )
    }

    // Words whose intent no longer exists (revoked, timed out, superseded) are words
    // that will never be said — drop them so the map cannot grow without bound.
    for( const id of this._authored.keys() )
      if( !state.entities.has( id ) ) this._authored.delete( id )
    for( const id of this._withheld.keys() )
      if( !state.entities.has( id ) ) this._withheld.delete( id )
    for( const id of this._composedAt.keys() )
      if( !state.entities.has( id ) ) this._composedAt.delete( id )

    // ── Timeout stranded async intents ───────────────────────────
    // An 'awaiting' intent whose host/delivery never returned would block the
    // serial Will forever. After AWAIT_TIMEOUT ticks, abandon it as a failed
    // outcome (which also teaches reafference the action is unreliable here).
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent' || str( e.metadata?.['status'] ) !== 'awaiting') continue
      // Already delivered above — its outcome and deletion are queued for this tick.
      if( spokeThisTick.has( id ) ) continue
      // Words are being authored right now. The clock PAUSES rather than extends: a
      // facet LLM call is 10–30s of latency we do not control, and any fixed budget
      // large enough to cover a slow one is also large enough to strand a dead one.
      // While a call is genuinely in flight the world has not failed to answer. The
      // pause is bounded, not open-ended: `authorOutreach` always settles (its own 60s
      // timeout resolves empty), so `_authoring` always clears and the clock resumes.
      if( this._authoring.has( id ) ) continue
      // The facet was asked and chose silence. Resolve it as that rather than
      // letting the clock abandon it as a failure — see `_withheld`.
      if( this._withheld.has( id ) ){
        const intent = readIntent( id, e.metadata )
        const why    = this._withheld.get( id ) ?? 'I considered speaking and chose not to.'
        set.push({
          id: `agency-outcome-${ tick }-${ id }`,
          type: 'agency.outcome',
          metadata: {
            schema: intent.schema, intentId: id,
            targetEntityId: intent.targetEntityId,
            withheld: true,
            description: why,
            mode: 'communicate', tick,
            ...( intent.planId ? { planId: intent.planId } : {} ),
            ...( intent.planStepId ? { stepId: intent.planStepId } : {} ),
          },
        })
        del.push( id )
        this._withheld.delete( id )
        metrics.push([ 'agency.communicate.withheld', 1 ])
        // A DISTINCT event, never `action.outcome`: six faculties learn from that
        // one's `success`, and a withheld turn published as `success: false`
        // teaches the mind it is bad at speaking from the times it decided not to
        // speak — the exact regression #123 exists to prevent. This one is read
        // only by the executive's record of what it did.
        if( this._bus ){
          try {
            this._bus.publish({
              type: 'action.withheld', version: 1, sourceEngine: this.name,
              salience: 0.4,
              payload: {
                actionType: intent.schema, targetEntityId: intent.targetEntityId,
                description: why, tick,
                ...( intent.planId ? { planId: intent.planId } : {} ),
              },
            })
          }
          catch { /* unregistered schema is telemetry-only */ }
        }
        continue
      }
      // POLICY_REAFFERENCE P4 — an escalated intent is HELD: the stem owns its
      // lifecycle (extended TTL → approve/deny/expire), so the executor must not
      // time it out at AWAIT_TIMEOUT and reconcile it as a phantom failure.
      if( e.metadata?.['escalated'] === true ) continue
      const dispatchedAt = num( e.metadata?.['dispatchedAt'], tick )
      const age          = tick - dispatchedAt

      // Dispatched LATER than now ⇒ it was in flight when the mind went to sleep.
      // Intents snapshot with the state and the tick counter restarts at 1 on wake,
      // so a restored `awaiting` intent has a NEGATIVE age — and every guard here
      // inverts on it: `age < AWAIT_TIMEOUT` is trivially true for -589, so it never
      // timed out, and the selector's staleness went negative, INFLATING the
      // incumbent's strength instead of decaying it. Measured on a live Will:
      // incumbent 9.742 against challengers of 0.52, unpreemptable and immortal.
      // One person's stale intent held the channel and every attempt to contact
      // anyone else was refused, indefinitely, across restarts.
      //
      // Cleared WITHOUT a failure outcome: hibernating is not the world declining
      // to answer. Reconciling it as a timeout would teach reafference that
      // reaching that person does not work, which is a lesson about the process
      // lifecycle, not about them.
      if( age < 0 ){
        del.push( id )
        logger.info(
          `[motor] cleared "${ str( e.metadata?.['schema'] ) ?? 'intent' }" left awaiting ` +
          `across a restart (dispatched at tick ${ dispatchedAt }, now ${ tick })`
        )
        continue
      }

      if( age < AWAIT_TIMEOUT ) continue

      const intent    = readIntent( id, e.metadata )
      const predicted: EfferenceCopy = {
        expectedReward:  num( e.metadata?.['predictedReward'],  intent.expectedReward ),
        expectedValence: num( e.metadata?.['predictedValence'], intent.expectedValence ),
      }
      const timedOut: Enaction = {
        mode: 'sync', success: false, outcomeQuality: 0, valence: -0.1,
        description: `"${ intent.schema }" timed out — the world never answered.`,
      }
      set.push( outcomeEntity( tick, intent, timedOut, predicted ) )
      del.push( id )
      this._emitEnacted( intent, timedOut, predicted, tick )
      if( intent.planId && intent.planStepId )
        this._emitActionOutcome( intent, false, 0, 1, tick,
          `No answer came back — I gave up waiting after ${ tick - dispatchedAt } ticks.` )
      logger.info(`[motor] ⏱ "${ intent.schema }" timed out after ${ tick - dispatchedAt } ticks`)
    }

    // Process committed intents in a stable order (determinism / replay).
    const selected = [ ...state.entities.entries() ]
      .filter( ( [ , e ] ) => e.type === 'agency.intent' && str( e.metadata?.['status'] ) === 'selected')
      .sort( ( a, b ) => ( a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0 ) )

    let enactedCount = 0

    for( const [ id, e ] of selected ){
      // Revoked mid-commit (P4), or a sub of a preempted composite (#4) — refuse
      // to enact; the sweep above already queued the deletes.
      if( revoked.has( id ) ) continue
      const parentOf = str( e.metadata?.['parentIntentId'] )
      if( parentOf && revoked.has( parentOf ) ) continue
      const intent = readIntent( id, e.metadata )
      const schema = this._resolve( intent.schema )

      // ── composite → expand into ordered primitive sub-intents ──
      if( schema?.kind === 'composite' && schema.composedOf && schema.composedOf.length > 0 ){
        this._expand( id, e.metadata, schema.composedOf, intent, tick, set )
        continue
      }

      const predicted: EfferenceCopy = {
        expectedReward:  intent.expectedReward,
        expectedValence: intent.expectedValence,
      }

      const enaction: Enaction = schema
        ? enact({ schema, parameters: intent.parameters, targetEntityId: intent.targetEntityId, energy, stress })
        : { mode: 'external', success: true, outcomeQuality: 0.5, valence: 0,
            description: `Unknown schema "${ intent.schema }" routed to the host.` }

      if( enaction.mode === 'sync'){
        set.push( outcomeEntity( tick, intent, enaction, predicted ) )
        del.push( id )
        if( enaction.metricDeltas ) metrics.push( ...enaction.metricDeltas )
        enactedCount++
        this._emitEnacted( intent, enaction, predicted, tick )
        this._emitActionOutcome( intent, enaction.success, enaction.outcomeQuality,
          clamp01( Math.abs( predicted.expectedReward - enaction.outcomeQuality ) ), tick,
          enaction.description )

        // If this was a macro step, advance (or finalize) its parent.
        if( intent.parentIntentId )
          this._advance( intent, enaction, state, tick, set, del )
      }
      else {
        // Communicate: deliver through the shared ProactiveCommunicator (Phase 5b).
        // Returns false when it can't (no delivery layer, no content to send) → fall
        // through to the async 'awaiting' hold (host delivers, or it times out).
        const delivered = enaction.mode === 'communicate'
          && await this._deliver( id, intent, predicted, state, tick, set, del, metrics )

        if( delivered ){
          enactedCount++
        } else {
          // Async hold: persist the efference copy so reconciliation can score it.
          set.push({
            id, type: 'agency.intent',
            metadata: {
              ...( e.metadata as Record<string, unknown> ),
              status:           'awaiting',
              dispatchedAt:     tick,
              predictedReward:  predicted.expectedReward,
              predictedValence: predicted.expectedValence,
            },
          })
          // EXAFFERENCE P1 — the dispatched action's expected sensory footprint,
          // so the world's answer can be recognized as ours when it arrives
          // through the senses (P2). Host acks correlate by intent id already.
          // For a communicate whose words are authored, also carry the text so an
          // echo of them can be matched (P2) and, if the intent is still awaiting,
          // confirm it through the senses (P5) instead of timing out as a failure.
          const awaitingText = enaction.mode === 'communicate'
            ? ( str( intent.parameters['content'] ) ?? firstMessage( intent.parameters['messages'] ) )
            : undefined
          set.push( consequenceEntity({
            intentId: id, schema: intent.schema,
            mode: enaction.mode === 'communicate' ? 'communicate' : 'external',
            // A communicate with no words yet has not happened. The footprint is
            // still written (P1/P2 want it the moment the words land), but it must
            // not satiate — attempting to speak is not speaking. See
            // ConsequenceDescriptor.pending. An EXTERNAL dispatch IS the act: the
            // host is doing it now, and not asking twice while waiting is exactly
            // what satiation is for.
            ...( enaction.mode === 'communicate' && !awaitingText ? { pending: true } : {} ),
            ...( enaction.mode === 'communicate'
              ? { effector: COMM_SCHEMA_TO_EFFECTOR[ intent.schema ] ?? intent.schema }
              : {} ),
            ...( intent.targetEntityId ? { targetEntityId: intent.targetEntityId } : {} ),
            ...( awaitingText ? { text: awaitingText, textHash: fnv1a( awaitingText ) } : {} ),
            paramsHash: fnv1a( paramsKey( intent.parameters ) ),
            expiresAt: tick + CONSEQUENCE_TTL_TICKS, tick,
          }) )
          // The durable half, for an act with an object that is not speech.
          // Speech has `conversation.sent` and objectless acts have
          // `LearnedSkill.lastEnactedTick`; this is the peer those two left out,
          // and without it satiation expired with the descriptor at the ECHO
          // window rather than lasting the satiation window. Written at the same
          // moment as the descriptor — the dispatch IS the act for an external
          // effector — and keyed per (schema, target) so it refreshes in place.
          if( intent.targetEntityId && enaction.mode !== 'communicate')
            set.push( enactedEntity( intent.schema, intent.targetEntityId, tick ) )
          events.push( ...this._emitDispatch( intent, enaction.mode, tick, state ) )
          metrics.push([ enaction.mode === 'communicate'
            ? 'agency.communicate.dispatched'
            : 'agency.invocation.dispatched', 1 ])
        }
      }
    }

    metrics.push([ 'agency.executor.enacted', enactedCount ])
    return { commands: { set, delete: del, metrics }, ...( events.length > 0 ? { events } : {} ) }
  }

  // ── composite machinery ──────────────────────────────────────

  private _expand(
    parentId:   string,
    parentMeta: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined,
    steps:      string[],
    intent:     Intent,
    tick:       Tick,
    set:        EntityInput[],
  ): void {
    const meta = ( parentMeta ?? {} ) as Record<string, unknown>
    // Parent stays open as 'expanding' and tracks progress.
    set.push({
      id: parentId, type: 'agency.intent',
      metadata: { ...meta, status: 'expanding', steps, cursor: 0, accumQuality: 0, accumValence: 0, completed: 0 },
    })
    set.push( this._subIntent( parentId, intent.targetEntityId, intent.parameters, steps[0]!, 0, tick ) )
    logger.info(`[motor] composite "${ intent.schema }" → ${ steps.length } steps`)
  }

  private _advance(
    sub:      Intent,
    enaction: Enaction,
    state:    ReadonlySimulationState,
    tick:     Tick,
    set:      EntityInput[],
    del:      string[],
  ): void {
    const parentId = sub.parentIntentId!
    const parent   = state.entities.get( parentId )
    if( !parent ){ return }  // parent already finalized / gone

    const pm           = ( parent.metadata ?? {} ) as Record<string, unknown>
    const steps        = Array.isArray( pm['steps'] ) ? ( pm['steps'] as string[] ) : []
    const accumQuality = num( pm['accumQuality'], 0 ) + enaction.outcomeQuality
    const accumValence = num( pm['accumValence'], 0 ) + enaction.valence
    const completed    = num( pm['completed'], 0 ) + 1
    const nextK        = ( sub.stepIndex ?? 0 ) + 1

    if( nextK < steps.length ){
      set.push({ id: parentId, type: 'agency.intent',
        metadata: { ...pm, cursor: nextK, accumQuality, accumValence, completed } })
      set.push( this._subIntent(
        parentId,
        str( pm['targetEntityId'] ),
        ( pm['parameters'] as Record<string, unknown> ) ?? {},
        steps[nextK]!, nextK, tick,
      ) )
      return
    }

    // All steps done → finalize the composite's own outcome.
    const avgQuality = completed > 0 ? accumQuality / completed : 0
    const avgValence = completed > 0 ? accumValence / completed : 0
    const compIntent: Intent = {
      id:              parentId,
      schema:          str( pm['schema'] ) ?? 'composite',
      affordanceId:    str( pm['affordanceId'] ),
      targetEntityId:  str( pm['targetEntityId'] ),
      parameters:      ( pm['parameters'] as Record<string, unknown> ) ?? {},
      expectedReward:  num( pm['expectedReward'], 0.5 ),
      expectedValence: num( pm['expectedValence'], 0 ),
    }
    const compEnaction: Enaction = {
      mode: 'sync', success: true, outcomeQuality: avgQuality, valence: avgValence,
      description: `Composite "${ compIntent.schema }" completed — ${ completed } steps.`,
    }
    set.push( outcomeEntity( tick, compIntent, compEnaction,
      { expectedReward: compIntent.expectedReward, expectedValence: compIntent.expectedValence } ) )
    del.push( parentId )
    this._emitEnacted( compIntent, compEnaction,
      { expectedReward: compIntent.expectedReward, expectedValence: compIntent.expectedValence }, tick )
    this._emitActionOutcome( compIntent, true, avgQuality,
      clamp01( Math.abs( compIntent.expectedReward - avgQuality ) ), tick,
      compEnaction.description )
  }

  private _subIntent(
    parentId:        string,
    targetEntityId:  string | undefined,
    parameters:      Record<string, unknown>,
    subSchemaId:     string,
    k:               number,
    tick:            Tick,
  ): EntityInput {
    const sub   = this._resolve( subSchemaId )
    const baseV = sub?.baseValence ?? 0
    return {
      id: `${ parentId }-sub-${ k }`,
      type: 'agency.intent',
      metadata: {
        schema:          subSchemaId,
        parentIntentId:  parentId,
        stepIndex:       k,
        status:          'selected',
        targetEntityId,
        parameters,
        expectedReward:  clamp01( ( baseV + 1 ) / 2 ),
        expectedValence: baseV,
        tick,
      },
    }
  }

  // ── communication delivery (Phase 5b) ────────────────────────

  /**
   * Deliver a communicate intent through the shared ProactiveCommunicator, gated by
   * AccessGrants. Returns true when it handled the intent (delivered + outcome written),
   * false when it cannot (no delivery layer / no authored content) so the caller holds
   * the intent 'awaiting'. Message *content* is authored upstream (the deliberation /
   * conversation facet); this is the single enaction → delivery path.
   */
  private async _deliver(
    id: string, intent: Intent, predicted: EfferenceCopy,
    state: ReadonlySimulationState, tick: Tick,
    set: EntityInput[], del: string[], metrics: Array<[ string, number ]>,
  ): Promise<boolean> {
    if( !this._comms ) return false
    const effector = COMM_SCHEMA_TO_EFFECTOR[ intent.schema ] ?? intent.schema

    // Permission gate — denial RESOLVES as a failed outcome (not an awaiting hold).
    if( this._grants && !this._grants.isAllowed( effector ) ){
      const blocked: Enaction = {
        mode: 'communicate',
        success: false,
        outcomeQuality: 0,
        valence: -0.1,
        description: `"${ effector }" is not permitted for this Will.`
      }
      set.push( outcomeEntity( tick, intent, blocked, predicted ) )
      del.push( id )
      this._emitEnacted( intent, blocked, predicted, tick )
      metrics.push([ 'agency.communicate.blocked', 1 ])
      return true
    }

    // Content authored upstream when present (host / host-facet), else words a facet
    // authored off-tick and landed since a previous tick asked for them. Neither ⇒
    // request authoring (never awaited here — see `_authoring`) and hold 'awaiting'.
    const authored = str( intent.parameters['content'] ) ?? firstMessage( intent.parameters['messages'] )
    const fromFacet = !authored
    let bubbles: string[] = authored ? [ authored ] : ( this._authored.get( id ) ?? [] )
    this._authored.delete( id )
    if( bubbles.length === 0 ){
      this._requestAuthoring( id, intent, tick )
      return false   // nothing to send yet → await
    }

    // ── Is this still what I want to say? ─────────────────────────
    // Words a facet composed off-tick were formed against the situation as it
    // stood when they were asked for. Delivering them into a situation that has
    // since moved is not the act that was decided on — it is an older act
    // arriving late wearing the present's clothes.
    //
    // Live: a COO committed to outreach, was told "I need my full attention on
    // that right now, will brief you later", acknowledged that correctly — and
    // 41 seconds later delivered the three-bubble message composed beforehand,
    // asking for a brain-dump. Same shape at 3am with a colleague who had just
    // said goodnight: "Night. Talk soon." followed one second later by two
    // unprompted messages. Satiation cannot damp either, because satiation gates
    // SELECTION and these were already selected. Nothing looked at the door.
    //
    // Only facet-composed words are checked. Content supplied upstream
    // (`parameters.content`) came from the host or a host-facet with the present
    // situation in hand, and a reply never reaches this path at all — it is
    // delivered by the audition facet through the outbox.
    const moved = fromFacet
      ? situationMoved( state, intent.targetEntityId, this._composedAt.get( id ) )
      : null
    if( moved ){
      this._withheld.set( id, moved )
      this._composedAt.delete( id )
      logger.debug(`[motor] "${ intent.schema }" withheld — ${ moved }`)
      metrics.push([ 'agency.communicate.stale', 1 ])
      return false   // resolved as withheld by the sweep: freed, and nothing taught
    }
    this._composedAt.delete( id )

    const request: ActionRequest = {
      effector,
      parameters:      { ...intent.parameters, messages: bubbles },
      targetEntityId:  intent.targetEntityId,
      reasoning:       '',
      expectedOutcome: '',
      decidedAt:       tick,
    }
    let result: ActionResult
    try { result = await this._comms.executeAction( request, state ) }
    catch( err ){ logger.warn(`[motor] communicate delivery failed: ${ errMsg( err ) }`); return false }

    if( result.commands.set?.length ) set.push( ...result.commands.set )
    const out: Enaction = { mode: 'communicate', success: result.success,
      outcomeQuality: result.feedback.outcomeQuality, valence: 0, description: result.description }
    set.push( outcomeEntity( tick, intent, out, predicted ) )
    del.push( id )
    // EXAFFERENCE P1 — the delivered words' sensory footprint: the channel echo
    // or a quote-back of this exact text should read as ours, not as the world
    // surprising us (P2 matches on the content hash).
    if( result.success )
      set.push( consequenceEntity({
        intentId: id, schema: intent.schema, mode: 'communicate', effector,
        ...( intent.targetEntityId ? { targetEntityId: intent.targetEntityId } : {} ),
        textHash: fnv1a( bubbles.join('\n') ),
        text:     bubbles.join('\n'),
        expiresAt: tick + CONSEQUENCE_TTL_TICKS, tick,
      }) )
    // The words are out. Whatever willed them is DONE being an intention.
    //
    // Discharged here rather than at dispatch on purpose: `_deliver` holds the
    // intent 'awaiting' while a facet authors, and that authoring can time out or
    // return nothing. Clearing the will at dispatch would lose the intention
    // silently — the mind would have decided to say something and simply never
    // have, which is the failure `commands.ts` calls "the whole intention
    // evaporated without a trace". Enaction is the discharge; a request is not.
    if( result.success ) this._dischargeWill( intent, del )

    this._emitEnacted( intent, out, predicted, tick )
    this._emitActionOutcome( intent, result.success, result.feedback.outcomeQuality,
      clamp01( Math.abs( predicted.expectedReward - result.feedback.outcomeQuality ) ), tick,
      out.description )
    metrics.push([ 'agency.communicate.delivered', 1 ])
    return true
  }

  /**
   * Ask a facet for the words, off-tick. Fire-and-forget on purpose: awaiting this
   * from inside `react()` deadlocks the tick loop against the facet pump. Idempotent
   * per intent — a request already in flight is not duplicated, so the intent may sit
   * 'awaiting' across many ticks with exactly one LLM call behind it.
   */
  private _requestAuthoring( id: string, intent: Intent, tick: Tick ): void {
    if( !this._author || this._authoring.has( id ) ) return

    const name = str( intent.parameters['targetEntityName'] ) ?? intent.targetEntityId ?? 'them'
    this._authoring.add( id )
    this._composedAt.set( id, tick )
    void this._author
      .authorOutreach( intent.targetEntityId ?? '', name, str( intent.parameters['gist'] ) )
      .then( result => {
        const bubbles  = Array.isArray( result ) ? result : result.bubbles
        const declared = !Array.isArray( result ) && result.withheld === true

        if( bubbles.length > 0 ){ this._authored.set( id, bubbles ); return }

        // Not a warning: the facet was asked and answered. Choosing not to speak
        // is a decision the mind is entitled to make.
        if( declared ){
          this._withheld.set( id, 'I considered speaking and chose not to.')
          logger.debug(`[motor] "${ intent.schema }" withheld — the facet chose silence`)
          return
        }
        // No words and no decision — a dead author, a full budget, or a pass
        // deferring to one in flight. Keep holding: the clock is the right judge
        // of those, and the deferring case wants to come back round.
        logger.warn(`[motor] outreach authoring returned nothing for "${ intent.schema }"`)
      } )
      .catch( err => { logger.warn(`[motor] outreach authoring failed: ${ errMsg( err ) }`) } )
      .finally( () => { this._authoring.delete( id ) } )
  }

  // ── bus emission ─────────────────────────────────────────────

  private _emitEnacted( intent: Intent, enaction: Enaction, predicted: EfferenceCopy, tick: Tick ): void {
    if( !this._bus ) return
    const surprise = clamp01( Math.abs( predicted.expectedReward - enaction.outcomeQuality ) )
    try {
      this._bus.publish({
        type: 'agency.enacted', version: 1, sourceEngine: this.name,
        salience: Math.min( 1, 0.4 + surprise ),
        payload: { schema: intent.schema, success: enaction.success, outcomeQuality: enaction.outcomeQuality, surprise, tick },
      })
    }
    catch( err ){ logger.warn(`[motor] enacted publish failed: ${ errMsg( err ) }`) }
  }

  /**
   * Publish `action.outcome` for EVERY enaction — the shared metacognitive/affective
   * sink. The PlanningEngine consumes it (when planId/stepId are present) to advance
   * a plan; the ConfidenceCalibrator calibrates predicted-vs-actual from it; the
   * RewardEvaluator reads it as a reward signal. `confidence` carries the agency's
   * own forward-model prior so calibration has a real prediction to score.
   */
  /**
   * Retire the `ideomotor.intent` that produced this act.
   *
   * Nothing deleted these. They were cleared only when the executive next ran and
   * declined to name the same action again — and the executive runs on an interval,
   * so between cycles a willed reach-out STOOD in state, was rebuilt into an
   * affordance every single tick, and competed every single tick. Observed as
   * dozens of identical lines:
   *
   *   [selector] willed reach-out → … NOT selected: 0.297 < inspect… 0.340
   *
   * losing by four thousandths, over and over, until it won — twice. Fabrice got
   * the same message byte-for-byte 25 ticks apart, two outbox ids.
   *
   * `justEnacted` was built to hold this line and cannot: it is a DECAYING
   * quantity, capped at `repeatDamping` (0.30), and a standing intent outlasts it
   * by construction. Damping a permanent pull only ever delays it. So the intention
   * is discharged by being acted on, which is what an intention is — you meant to
   * tell someone something, you told them, and it is finished. If the mind still
   * wants to say more, the next executive cycle forms a new one, now seeing "I said
   * this 25 ticks ago and have had no answer" in front of it.
   *
   * Satiation stays exactly as it was, and still earns its keep: it damps saying
   * the same thing again for reasons that did NOT come from a standing will.
   */
  private _dischargeWill( intent: Intent, del: string[] ): void {
    const willId = intent.evokedBy
    if( !willId || !willId.startsWith('ideomotor-') ) return
    del.push( willId )
    logger.info(`[motor] discharged the will behind "${ intent.schema }" (${ willId })`)
  }

  private _emitActionOutcome(
    intent: Intent, success: boolean, outcomeQuality: number, surprise: number, tick: Tick,
    /**
     * What happened, in words. This payload builds `action.record`, which the
     * prompt renders as `## Recent Action Outcomes` — and until now this method
     * published no description at all, so that section showed the action's NAME
     * and nothing else. Sixty-five lookups rendered as sixty-five lines saying
     * `discord_lookup_member` and never once what was found.
     */
    description?: string,
  ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'action.outcome', version: 1, sourceEngine: this.name,
        salience: Math.min( 1, outcomeQuality * 0.6 ),
        payload: {
          actionType:     intent.schema,
          domain:         intent.schema,
          confidence:     intent.expectedReward,
          ...( description ? { description } : {} ),
          success,
          outcomeQuality,
          surprise,
          targetEntityId: intent.targetEntityId,
          ...( intent.planId     ? { planId: intent.planId }     : {} ),
          ...( intent.planStepId ? { stepId: intent.planStepId } : {} ),
          tick,
        },
      })
    }
    catch( err ){ logger.warn(`[motor] action outcome publish failed: ${ errMsg( err ) }`) }
  }

  /**
   * Announce a dispatched act to its TWO audiences, which live on two buses.
   *
   * The mind's own faculties appraise it — affective.blender, stress.regulator
   * and attention.allocator all subscribe to `agency.invocation` on the
   * CognitiveBus, the internal fabric. But the act is host-owned, and the HOST
   * hears only `simulation.eventBus`: `WillStem` buffers an invocation for
   * delivery from `eventBus.subscribeAll`, and that is the sole path by which an
   * external effector ever reaches a handler.
   *
   * Only the cognitive half was ever published. The two buses have no bridge, so
   * `bufferInvocation` was subscribed to a bus that has never carried the event
   * — measured on a live boot: `agency.invocation.dispatched` incremented,
   * `pendingEffectorInvocations` stayed empty, the intent held `awaiting`, and
   * fifteen ticks later `[motor] ⏱ "inspect" timed out`. **No host-owned
   * effector invocation has ever been delivered.** Communication is unaffected —
   * the outbox is a separate mechanism, which is why a Will could always speak.
   *
   * Both ends were unit-tested and the crossing was not: `policy.*.test.ts` calls
   * `bufferInvocation` directly, which is true about the controller and silent
   * about whether anything reaches it. Same shape as the affordance-field hop.
   */
  private _emitDispatch(
    intent: Intent, mode: 'communicate' | 'external', tick: Tick,
    state?: ReadonlySimulationState,
  ): Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> {
    const payload = this._dispatchPayload( intent, tick, state )
    const type    = mode === 'communicate' ? 'agency.communicate' : 'agency.invocation'

    if( this._bus )
      try {
        this._bus.publish({ type, version: 1, sourceEngine: this.name, salience: 0.6, payload })
      }
      catch( err ){ logger.warn(`[motor] dispatch publish failed: ${ errMsg( err ) }`) }

    // The observable bus — where the host is listening.
    return [ { type, source: this.name, payload } ]
  }

  private _dispatchPayload(
    intent: Intent, tick: Tick, state?: ReadonlySimulationState,
  ): Record<string, unknown> {
    return {
          schema: intent.schema, intentId: intent.id,
          targetEntityId: intent.targetEntityId, parameters: intent.parameters, tick,
          // The ability's declared meaning, carried to the host handler.
          description: this._resolve( intent.schema )?.description,
          // Where in the world this referent is, so a host can act on it at all.
          //
          // The target is an ANCHOR (`ke:1sqlkux`) — 0.9.0 made identity opaque and
          // separate from address on purpose. A bridge holds channel ids and knows
          // nothing of anchors, so an invocation naming only the referent is one no
          // surface can serve. The outbox hit this first and solved it the same way
          // (mind.ts attachRouting): resolve inside, where the alias table lives.
          //
          // Outbound only. This is the mind telling the world which of its own
          // handles it means — the reverse direction, a surface writing an address
          // into the mind, is what perception is for.
          ...( state && intent.targetEntityId
            ? { targetAddresses: addressesOf( state.entities, intent.targetEntityId ) } : {} ),
    }
  }
}

// ─── entity helpers ──────────────────────────────────────────────────────────

function outcomeEntity( tick: Tick, intent: Intent, enaction: Enaction, predicted: EfferenceCopy ): EntityInput {
  const surprise = clamp01( Math.abs( predicted.expectedReward - enaction.outcomeQuality ) )
  return {
    id: `agency-outcome-${ tick }-${ intent.id }`,
    type: 'agency.outcome',
    metadata: {
      schema:           intent.schema,
      affordanceId:     intent.affordanceId,
      intentId:         intent.id,
      targetEntityId:   intent.targetEntityId,
      success:          enaction.success,
      outcomeQuality:   enaction.outcomeQuality,
      valence:          enaction.valence,
      predictedReward:  predicted.expectedReward,
      predictedValence: predicted.expectedValence,
      surprise,
      description:      enaction.description,
      mode:             enaction.mode,
      tick,
    },
  }
}

function readIntent( id: string, m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined ): Intent {
  const meta = ( m ?? {} ) as Record<string, unknown>
  return {
    id,
    schema:          str( meta['schema'] ) ?? '',
    affordanceId:    str( meta['affordanceId'] ),
    targetEntityId:  str( meta['targetEntityId'] ),
    parameters:      ( meta['parameters'] as Record<string, unknown> ) ?? {},
    expectedReward:  num( meta['expectedReward'],  0.5 ),
    expectedValence: num( meta['expectedValence'], 0 ),
    parentIntentId:  str( meta['parentIntentId'] ),
    stepIndex:       typeof meta['stepIndex'] === 'number' ? ( meta['stepIndex'] as number ) : undefined,
    planId:          str( meta['planId'] ),
    planStepId:      str( meta['stepId'] ),
    evokedBy:        str( meta['evokedBy'] ),
  }
}

// ─── primitives ──────────────────────────────────────────────────────────────

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function firstMessage( v: unknown ): string | undefined {
  return Array.isArray( v ) ? v.find( ( m ): m is string => typeof m === 'string' && m.length > 0 ) : undefined
}
function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}
function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
function errMsg( err: unknown ): string {
  return err instanceof Error ? err.message : String( err )
}

/**
 * Has the situation these words were composed for moved on?
 *
 * Returns the mind's own account of what changed, or null if the moment still
 * stands. The account is what the withheld outcome records, so the mind's
 * history says why it did not speak rather than merely that it didn't.
 *
 * The evidence is `conversation.sent` — the durable record of having spoken,
 * written by every path that speaks (ProactiveCommunicator, the audition facet,
 * the outbox). If I have said something to this person SINCE these words were
 * asked for, then these are not my current words to them: I have already
 * responded to whatever moved in between, and this is an older turn arriving on
 * top of a newer one.
 *
 * And `answeredAt` — when they last spoke to ME. This arm was missing at first,
 * excluded on the argument that `conversation.received` is a one-shot entity
 * swept on the tick it is scanned so nothing durable records the other
 * direction. That was wrong: `answeredAt` is the durable half, folded onto the
 * mind's own sent turns, and it is what renders "they answered" in the prompt.
 *
 * The gap was the COMMON case, not an edge. Live, a COO delivered a pre-composed
 * agenda message ("I need a list of what's actively in flight…") two seconds
 * after the person changed the subject, having said nothing in between — so the
 * stale words arrived BEFORE her real reply and the spoken-since arm had not
 * fired yet. The two signals were assumed to coincide and do not: whoever moved
 * the situation, it moved.
 *
 * A missing `composedAt` means the words were never requested through
 * `_requestAuthoring` — nothing is known about when they were formed, so nothing
 * is claimed and they go out. Silence beats a guess here: withholding on absent
 * evidence would mute a mind for reasons it could not name.
 */
export function situationMoved(
  state:          ReadonlySimulationState,
  targetEntityId: string | undefined,
  composedAt:     Tick | undefined,
): string | null {
  if( composedAt === undefined || !targetEntityId ) return null

  const heard = lastAnsweredByEntity( state.entities as never ).get( targetEntityId )
  if( heard !== undefined && heard > composedAt )
    return 'They said something after I composed this, so it is an answer to a moment that has passed.'

  const spoke = spokenAtByEntity( state.entities as never ).get( targetEntityId )
  if( spoke !== undefined && spoke > composedAt )
    return 'I had already spoken to them since composing this, so it was no longer what I had to say.'

  return null
}

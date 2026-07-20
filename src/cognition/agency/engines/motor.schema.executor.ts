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
  Duration, Tick, SimulationContext,
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
import {
  CONSEQUENCE_TYPE, CONSEQUENCE_TTL_TICKS,
  consequenceEntity, fnv1a, paramsKey,
} from '#agency/consequence'

/** Ticks an async (communicate/external) intent may stay 'awaiting' before it is abandoned. */
const AWAIT_TIMEOUT = 15

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
}

/** Authors the words for a self-initiated communicate the agency selected (no inbound triggered it). */
export interface OutreachAuthor {
  authorOutreach( entityId: string, entityName: string, gist?: string ): Promise<string[]>
}

export class MotorSchemaExecutor implements CognitiveEngine {
  readonly name = 'motor-schema-executor'

  private _schemas = new Map<string, MotorSchema>()
  private _repertoire: SchemaRepertoire | null = null
  private _comms:  ProactiveCommunicator | null = null
  private _author: OutreachAuthor | null = null
  private _grants: AccessGrants | null = null
  private _bus: CognitiveBus | null = null

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

    const energy = state.metrics.get('energy.level') ?? 100
    const stress = state.metrics.get('stress.load'  ) ?? 0

    // ── Expire consequence descriptors (EXAFFERENCE P1) ──────────
    // Descriptors deliberately outlive intent resolution (the sensory echo of a
    // reconciled action still arrives); their only cleanup is this TTL sweep.
    for( const [ id, e ] of state.entities ){
      if( e.type !== CONSEQUENCE_TYPE ) continue
      if( tick >= num( e.metadata?.['expiresAt'], 0 ) ) del.push( id )
    }

    // ── Timeout stranded async intents ───────────────────────────
    // An 'awaiting' intent whose host/delivery never returned would block the
    // serial Will forever. After AWAIT_TIMEOUT ticks, abandon it as a failed
    // outcome (which also teaches reafference the action is unreliable here).
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent' || str( e.metadata?.['status'] ) !== 'awaiting') continue
      const dispatchedAt = num( e.metadata?.['dispatchedAt'], tick )
      if( tick - dispatchedAt < AWAIT_TIMEOUT ) continue

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
        this._emitActionOutcome( intent, false, 0, 1, tick )
      logger.info(`[motor] ⏱ "${ intent.schema }" timed out after ${ tick - dispatchedAt } ticks`)
    }

    // Process committed intents in a stable order (determinism / replay).
    const selected = [ ...state.entities.entries() ]
      .filter( ( [ , e ] ) => e.type === 'agency.intent' && str( e.metadata?.['status'] ) === 'selected')
      .sort( ( a, b ) => ( a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0 ) )

    let enactedCount = 0

    for( const [ id, e ] of selected ){
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
          clamp01( Math.abs( predicted.expectedReward - enaction.outcomeQuality ) ), tick )

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
          set.push( consequenceEntity({
            intentId: id, schema: intent.schema,
            mode: enaction.mode === 'communicate' ? 'communicate' : 'external',
            ...( enaction.mode === 'communicate'
              ? { effector: COMM_SCHEMA_TO_EFFECTOR[ intent.schema ] ?? intent.schema }
              : {} ),
            ...( intent.targetEntityId ? { targetEntityId: intent.targetEntityId } : {} ),
            paramsHash: fnv1a( paramsKey( intent.parameters ) ),
            expiresAt: tick + CONSEQUENCE_TTL_TICKS, tick,
          }) )
          this._emitDispatch( intent, enaction.mode, tick )
          metrics.push([ enaction.mode === 'communicate'
            ? 'agency.communicate.dispatched'
            : 'agency.invocation.dispatched', 1 ])
        }
      }
    }

    metrics.push([ 'agency.executor.enacted', enactedCount ])
    return { commands: { set, delete: del, metrics } }
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
      clamp01( Math.abs( compIntent.expectedReward - avgQuality ) ), tick )
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

    // Content authored upstream when present (host / host-facet); otherwise, for a
    // self-initiated communicate the agency just selected, author it now via a facet
    // — the unified conversation voice, since no inbound triggered it. Empty ⇒ await.
    const authored = str( intent.parameters['content'] ) ?? firstMessage( intent.parameters['messages'] )
    let bubbles: string[] = authored ? [ authored ] : []
    if( bubbles.length === 0 && this._author ){
      const name = str( intent.parameters['targetEntityName'] ) ?? intent.targetEntityId ?? 'them'
      try { bubbles = await this._author.authorOutreach( intent.targetEntityId ?? '', name, str( intent.parameters['gist'] ) ) }
      catch( err ){ logger.warn(`[motor] outreach authoring failed: ${ errMsg( err ) }`) }
    }
    if( bubbles.length === 0 ) return false   // nothing authored to send → await

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
    this._emitEnacted( intent, out, predicted, tick )
    this._emitActionOutcome( intent, result.success, result.feedback.outcomeQuality,
      clamp01( Math.abs( predicted.expectedReward - result.feedback.outcomeQuality ) ), tick )
    metrics.push([ 'agency.communicate.delivered', 1 ])
    return true
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
  private _emitActionOutcome(
    intent: Intent, success: boolean, outcomeQuality: number, surprise: number, tick: Tick,
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

  private _emitDispatch( intent: Intent, mode: 'communicate' | 'external', tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: mode === 'communicate' ? 'agency.communicate' : 'agency.invocation',
        version: 1, sourceEngine: this.name, salience: 0.6,
        payload: {
          schema: intent.schema, intentId: intent.id,
          targetEntityId: intent.targetEntityId, parameters: intent.parameters, tick,
          // The ability's declared meaning, carried to the host handler.
          description: this._resolve( intent.schema )?.description,
        },
      })
    }
    catch( err ){ logger.warn(`[motor] dispatch publish failed: ${ errMsg( err ) }`) }
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

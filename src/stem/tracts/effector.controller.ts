// ─────────────────────────────────────────────────────────────
// src/stem/tracts/effector.controller.ts  —  per-Will external-effector subsystem
// ─────────────────────────────────────────────────────────────
//
// effectorController owns the external-effector machinery extracted from
// WillStem (R5-d): the runtime allow-list (setAllowed), the host
// execution-feedback / reafference loop (confirmExecution), buffering of
// externally-dispatched invocations off the `agency.invocation` bus event
// (bufferInvocation), and draining that buffer for the delivery layer (drain).
//
// Agency-native (no legacy effector/decision.record stack): the MotorSchemaExecutor
// holds a host-owned action as an 'awaiting' `agency.intent` and publishes
// `agency.invocation` (carrying the intentId as the correlation handle). The host
// executes it and acks; `confirmExecution` turns that ack into an `agency.outcome`
// via `reconcileInvocation`, which the ReafferenceEngine consumes — learning the
// real result, freeing the awaiting intent, and (when the intent was a plan's
// frontier step) emitting the `action.outcome` the PlanningEngine advances on.
//
// The ops touch only WillInstance fields (no Will id needed), so these
// methods take the resolved instance directly. WillStem still validates
// existence via _get(id) before delegating.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { reconcileInvocation } from '#agency/reconcile.learning'
import { NULL_ARBITER, isNullArbiter } from '#stem/policy/arbiter'
import type { PolicyArbiter, PolicyInvocation, Verdict } from '#stem/policy/arbiter'
import {
  getVerdictRecorder, getVerdictSource, type PolicyVerdictRecord,
} from '#stem/policy/verdict.recorder'
import type { effectorInvocation } from '#types'
import type { WillInstance } from '#stem/index'

/** A denial awaiting application as a refusal ack at the next tick boundary. */
interface PendingRefusal {
  intentId:   string
  schema:     string
  reasonCode: string
  finality:   string
}

export class effectorController {
  /** The Policy Decision Point consulted before an invocation reaches the world.
   *  Defaults to the no-op arbiter, so an unconfigured Will is byte-identical. */
  private _arbiter: PolicyArbiter = NULL_ARBITER

  /**
   * Denials queued during a step's flush, drained at the NEXT tick boundary
   * (POLICY_REAFFERENCE P1). Keyed by willId — harness state, exactly like
   * `pendingEffectorInvocations`; never simulation state, so it does not touch
   * `simulation.step` determinism and is regenerated on any re-execution.
   */
  private _pendingRefusals = new Map<string, PendingRefusal[]>()

  /**
   * Install a Policy Decision Point (POLICY_REAFFERENCE P0). Passing null
   * restores the no-op default. The arbiter sees only the proposed act — never
   * simulation state — and its verdict decides whether the invocation is
   * handed to the host at all.
   */
  setArbiter( arbiter: PolicyArbiter | null ): void {
    this._arbiter = arbiter ?? NULL_ARBITER
  }

  /**
   * Update the set of allowed communication effectors at runtime via AccessGrants
   * (the permission / sense gate the senses + reply path read).
   */
  setAllowed( instance: WillInstance, effectors: string[] | null ): void {
    instance.cognition.accessGrants.setAllowed( effectors )
  }

  /**
   * Buffer a host-owned effector invocation for delivery. Called from the WillStem
   * `agency.invocation` bus subscription with the event payload
   * (`{ schema, intentId, targetEntityId, parameters, tick }`). The awaiting
   * `agency.intent` id is the **correlation handle** (`decisionRecordId`): the host
   * echoes it on its result-ack, and `confirmExecution` uses it to find the intent.
   */
  bufferInvocation( instance: WillInstance, payload: Record<string, unknown> ): void {
    const willId = instance.config.id

    // Replay: a registered source re-feeds the recorded verdict instead of
    // re-consulting a live (or absent) PDP — the arbiter is an external oracle,
    // exactly like the LLM. Checked FIRST so replay never re-enters the arbiter.
    const source = getVerdictSource( willId )
    if( source ){
      const invocation = toPolicyInvocation( instance, payload )
      const record     = source.verdictFor( invocation.tick, invocation.intentId )
      // A miss means the live run had no verdict here (null arbiter at record
      // time) — the invocation was simply buffered, so reproduce that.
      if( record ) this._applyVerdict( instance, payload, invocation, recordToVerdict( record ) )
      else         this._buffer( instance, payload )
      return
    }

    // Fast path: no policy configured ⇒ the seam does not exist. No allocation,
    // no branch beyond this one — the byte-identical guarantee.
    if( isNullArbiter( this._arbiter ) ){
      this._buffer( instance, payload )
      return
    }

    const invocation = toPolicyInvocation( instance, payload )
    let verdict: Verdict | Promise<Verdict>

    // An arbiter that throws must never become an implicit allow.
    try { verdict = this._arbiter.evaluate( invocation ) }
    catch( err ){
      logger.error(`[policy] arbiter "${this._arbiter.name}" threw for "${invocation.schema}" — failing closed:`, err )
      return
    }

    if( verdict instanceof Promise ){
      // An external PDP resolves out of tick. Safe by construction: the executor
      // holds the intent 'awaiting' for AWAIT_TIMEOUT (15 ticks), and the refusal
      // queue drains each tick, so a verdict landing a few ticks late still lands.
      void verdict.then(
        v => this._recordAndApply( instance, payload, invocation, v ),
        err => logger.error(`[policy] arbiter "${this._arbiter.name}" rejected for "${invocation.schema}" — failing closed:`, err ),
      )
      return
    }

    this._recordAndApply( instance, payload, invocation, verdict )
  }

  /** Capture the verdict on the tape (if a recorder is attached), then enforce it. */
  private _recordAndApply(
    instance:   WillInstance,
    payload:    Record<string, unknown>,
    invocation: PolicyInvocation,
    verdict:    Verdict,
  ): void {
    const sink = getVerdictRecorder( instance.config.id )
    sink?.recordVerdict({
      tick:       invocation.tick,
      willId:     instance.config.id,
      intentId:   invocation.intentId,
      schema:     invocation.schema,
      arbiter:    this._arbiter.name,
      decision:   verdict.decision,
      ...( verdict.reasonCode     ? { reasonCode:     verdict.reasonCode     } : {} ),
      ...( verdict.finality       ? { finality:       verdict.finality       } : {} ),
      ...( verdict.counterfactual ? { counterfactual: verdict.counterfactual } : {} ),
      timestamp:  Date.now(),
    })
    this._applyVerdict( instance, payload, invocation, verdict )
  }

  /**
   * Enforce a verdict (POLICY_REAFFERENCE P1).
   *
   *   • allow    → hand the invocation to the world.
   *   • deny     → queue a refusal ack, applied at the next tick boundary via
   *                `confirmExecution` — the same lifecycle as a host rejection,
   *                so the mind meets *world resistance*, not a permission dialog.
   *   • escalate → withhold, but do NOT refuse: the intent stays 'awaiting'.
   *                P1 stops here (it still expires at the executor's 15-tick
   *                timeout); P4 makes escalate a first-person speech act with a
   *                resolution path and an extended TTL.
   *
   * P1's refusal reconciles as a plain FAILURE — safe, but the wrong learning
   * signal (forbidden ≠ unskilled). P2 routes it to affordance AVAILABILITY
   * instead of competence.
   */
  private _applyVerdict(
    instance:   WillInstance,
    payload:    Record<string, unknown>,
    invocation: PolicyInvocation,
    verdict:    Verdict,
  ): void {
    if( verdict.decision === 'allow'){
      this._buffer( instance, payload )
      return
    }

    const cf = verdict.counterfactual
    logger.info(
      `[policy] ${verdict.decision.toUpperCase()} "${invocation.schema}" intent "${invocation.intentId}"` +
      ` — ${verdict.reasonCode ?? 'no reason code'}` +
      ( verdict.finality ? ` (${verdict.finality})` : '') +
      ( cf ? ` [${cf.field}: requested ${JSON.stringify( cf.requested )}, allowed ${JSON.stringify( cf.allowed )}]` : ''),
    )

    if( verdict.decision === 'deny'){
      const queue = this._pendingRefusals.get( instance.config.id ) ?? []
      queue.push({
        intentId:   invocation.intentId,
        schema:     invocation.schema,
        reasonCode: verdict.reasonCode ?? 'POLICY_DENIED',
        finality:   verdict.finality ?? 'instance',
      })
      this._pendingRefusals.set( instance.config.id, queue )
    }
    // 'escalate' falls through: withheld, left awaiting for P4.
  }

  /**
   * Apply queued policy refusals as failure acks (POLICY_REAFFERENCE P1).
   * Called by the tick loop at the same boundary as inbound acks — BEFORE the
   * step, stamped to this tick — so a denial reconciled here is the exact
   * lifecycle of a host rejection that arrived between ticks.
   */
  applyPolicyOutcomes( instance: WillInstance ): void {
    const queue = this._pendingRefusals.get( instance.config.id )
    if( !queue || queue.length === 0 ) return
    this._pendingRefusals.set( instance.config.id, [] )

    for( const refusal of queue )
      this.confirmExecution( instance, refusal.intentId, {
        success:     false,
        description: `refused by policy: ${refusal.reasonCode} (${refusal.finality})`,
      } )
  }

  /** Queue an approved invocation for the delivery layer. */
  private _buffer( instance: WillInstance, payload: Record<string, unknown> ): void {
    const intentId = ( payload.intentId as string ) ?? ''
    instance.pendingEffectorInvocations.push({
      id:               intentId,
      decisionRecordId: intentId,   // correlation handle — the awaiting agency.intent id
      effectorName:      ( payload.schema as string ) ?? '',
      parameters:       ( payload.parameters as Record<string, unknown> ) ?? {},
      targetEntityId:   payload.targetEntityId as string | undefined,
      reasoning:        ( payload.reasoning as string ) ?? '',
      ...( typeof payload.description === 'string' ? { description: payload.description } : {} ),
      tick:             ( payload.tick as number ) ?? 0,
      timestamp:        Date.now()
    })
  }

  /**
   * Drain all pending external effector invocations.
   * Called by the SSE delivery layer each tick after drainOutbox.
   */
  drain( instance: WillInstance ): effectorInvocation[] {
    return instance.pendingEffectorInvocations.splice( 0 )
  }

  // ── External Effector Feedback (agency-native reafference) ─────────────────
  /**
   * Called by the host/WorldInterface after executing a host-owned effector.
   * `invocationId` is the correlation handle the host echoed — the awaiting
   * `agency.intent`'s id (= the `decisionRecordId` field of the effectorInvocation).
   *
   * It reconciles the ack into an `agency.outcome` (via `reconcileInvocation`),
   * carrying the intent's efference copy (predicted reward/valence) so surprise is
   * honest, and its plan provenance (planId/stepId) when it was a plan's frontier
   * step. The ReafferenceEngine consumes that next tick: it learns the real result,
   * frees the awaiting intent, and — for a plan-tagged outcome — emits the
   * `action.outcome` the PlanningEngine advances on. No decision.record, no legacy
   * `effector.confirmed`: the agency pipeline owns the loop end to end.
   */
  confirmExecution(
    instance:     WillInstance,
    invocationId: string,
    result: {
      success:     boolean
      description: string
      metrics?:    Record<string, number>
    },
  ): void {
    const tick = instance.tickCount

    const intent = instance.simulation.stateManager.snapshot().entities.get( invocationId )
    if( !intent || intent.type !== 'agency.intent'){
      // No awaiting intent for this id. Expected when the executor's 15-tick await
      // timeout already abandoned it (writing a failed outcome + advancing any plan)
      // before the host's late ack arrived, or the id is unknown. Drop the straggler.
      logger.warn(`[effector] confirmExecution: no awaiting agency.intent "${invocationId}" (timed out / already reconciled?) — ignored`)
      return
    }

    const m       = ( intent.metadata ?? {} ) as Record<string, unknown>
    const schema  = ( m['schema'] as string ) ?? 'unknown'
    const predicted = {
      reward:  num( m['predictedReward'],  num( m['expectedReward'],  0.5 ) ),
      valence: num( m['predictedValence'], num( m['expectedValence'], 0 ) ),
    }
    const provenance = { planId: m['planId'] as string | undefined, stepId: m['stepId'] as string | undefined }

    // Reconcile → agency.outcome. ReafferenceEngine consumes it next tick (learn +
    // free the intent + emit the plan's action.outcome when plan-tagged).
    instance.simulation.stateManager.setEntity(
      reconcileInvocation( invocationId, schema, result, tick, predicted, provenance )
    )

    // Optional host-supplied metric deltas (e.g. the world moved a body metric).
    // Validate each value is a finite number before it touches simulation state —
    // a NaN/Infinity/garbage value from a buggy host would persist and corrupt
    // cognition (it isn't recomputed away like blended affect is).
    if( result.metrics )
      for( const [ k, v ] of Object.entries( result.metrics ) ){
        if( typeof v === 'number' && Number.isFinite( v ) )
          instance.simulation.stateManager.setMetric( k, v )
        else
          logger.warn(`[effector] confirmExecution: dropped non-finite metric "${k}"=${String( v )} from host ack (${schema})`)
      }

    instance.sessionLogger?.write({
      type:                'action.outcome',
      tick,
      actionType:          schema,
      success:             result.success,
      outcome:             result.description.slice( 0, 300 ),
      outcomeQuality:      result.success ? 0.8 : 0.2,
      confirmedExternally: true,
    } as never)

    logger.info(`[effector] ✓ reconciled ${result.success ? 'success' : 'failure'}: intent "${invocationId}" (${schema})`)
  }
}

function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}

/** Reconstruct an enforceable Verdict from a recorded verdict (replay path). */
function recordToVerdict( record: PolicyVerdictRecord ): Verdict {
  return {
    decision: record.decision,
    ...( record.reasonCode     ? { reasonCode:     record.reasonCode     } : {} ),
    ...( record.finality       ? { finality:       record.finality       } : {} ),
    ...( record.counterfactual ? { counterfactual: record.counterfactual } : {} ),
  }
}

/**
 * Project the `agency.invocation` payload onto the policy boundary's view of a
 * proposed act. Only the act crosses — no cognitive internals, no state handle.
 */
function toPolicyInvocation( instance: WillInstance, payload: Record<string, unknown> ): PolicyInvocation {
  return {
    willId:     instance.config.id,
    intentId:   ( payload.intentId as string ) ?? '',
    schema:     ( payload.schema as string ) ?? '',
    parameters: ( payload.parameters as Record<string, unknown> ) ?? {},
    ...( typeof payload.targetEntityId === 'string' ? { targetEntityId: payload.targetEntityId } : {} ),
    ...( typeof payload.description    === 'string' ? { description:    payload.description    } : {} ),
    tick:       ( payload.tick as number ) ?? 0,
  }
}

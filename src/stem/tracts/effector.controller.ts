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
//
// ── SIGNAL_BOUNDARY P1a ───────────────────────────────────────
// This file used to hold seven jobs. Two are now their own:
//
//   ./effector/policy.enforcement.ts    arbiter · verdicts · refusals
//   ./effector/escalation.lifecycle.ts  hold · resolve · expire
//
// What is left is the one job the name describes — the AGENCY↔HOST crossing:
// take an act the mind committed to, put it on the wire, and turn what comes
// back into something the mind can learn from. Plus the tick-boundary ordering
// the two collaborators share, which is a real responsibility and lives here
// because neither of them owns the tick.
//
// A pure move: no behaviour change, gated by replay.equivalence, same discipline
// as the planning.engine split. The import surface is unchanged — `effectorController`
// is still the export, so no caller moved.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { reconcileInvocation } from '#agency/reconcile.learning'
import type { PolicyArbiter, PolicyInvocation } from '#stem/policy/arbiter'
import type { effectorInvocation } from '#types'
import type { WillInstance } from '#stem/index'
import { PolicyEnforcement } from './effector/policy.enforcement'
import { EscalationLifecycle } from './effector/escalation.lifecycle'
import type { EffectorAck } from './effector/types'

export class effectorController {
  // The two collaborators are wired with arrow closures rather than a shared
  // `this` reference, which is what lets the cycle exist without either class
  // importing the other: policy raises an escalation, an escalation queues a
  // refusal. Resolution is deferred to call time, so field order does not matter.
  private readonly _escalations = new EscalationLifecycle({
    buffer:           ( i, p )       => this._buffer( i, p ),
    confirmExecution: ( i, id, r )   => this.confirmExecution( i, id, r ),
    queueRefusal:     ( i, id, s, rc, f ) => this._policy.queueRefusal( i, id, s, rc, f ),
  })

  private readonly _policy = new PolicyEnforcement({
    buffer:           ( i, p )     => this._buffer( i, p ),
    confirmExecution: ( i, id, r ) => this.confirmExecution( i, id, r ),
    raiseEscalation:  ( i, esc )   => this._escalations.raise( i, esc ),
  })

  /**
   * Install a Policy Decision Point (POLICY_REAFFERENCE P0). Passing null
   * restores the no-op default.
   */
  setArbiter( arbiter: PolicyArbiter | null ): void {
    this._policy.setArbiter( arbiter )
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
   *
   * Policy sits between here and the wire — see `PolicyEnforcement.evaluate`.
   */
  bufferInvocation( instance: WillInstance, payload: Record<string, unknown> ): void {
    this._policy.evaluate( instance, payload, toPolicyInvocation )
  }

  /**
   * Record a host's answer to an escalation (POLICY_REAFFERENCE P4). Applied at
   * the next tick boundary. A no-op if the intent id is not (or no longer) an
   * active escalation.
   */
  resolveEscalation( instance: WillInstance, intentId: string, approved: boolean ): void {
    this._escalations.resolve( instance, intentId, approved )
  }

  /**
   * The tick-boundary ordering both collaborators depend on, and the reason this
   * stays in the controller: neither of them owns the tick, and the sequence is
   * load-bearing. Called by the tick loop at the same boundary as inbound acks —
   * BEFORE the step, stamped to this tick — so a denial reconciled here has the
   * exact lifecycle of a host rejection that arrived between ticks.
   */
  applyPolicyOutcomes( instance: WillInstance ): void {
    const tick = instance.tickCount
    this._escalations.applyResolutions( instance )   // host answers land first
    this._escalations.expire( instance, tick )       // then time out the unanswered
    this._escalations.applyNew( instance, tick )     // then raise + voice the newest
    this._policy.applyRefusals( instance )           // then the plain denials
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
      // Without this a host receives an anchor it cannot resolve to anything in
      // its own world — see effectorInvocation.targetAddresses.
      ...( Array.isArray( payload.targetAddresses )
        ? { targetAddresses: payload.targetAddresses as string[] } : {} ),
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
    result:       EffectorAck,
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
    //
    // This is the FATE half, and it is unchanged: what the mind learns about its
    // own competence at this act.
    instance.simulation.stateManager.setEntity(
      reconcileInvocation( invocationId, schema, result, tick, predicted, provenance )
    )

    // ── The FACTS half (SIGNAL_BOUNDARY P2) ────────────────────
    //
    // An ack that carries an `observation` is not only feedback about an act —
    // it is new information about the world, and information about the world
    // reaches this mind exactly one way: as afference it can weigh, remember and
    // recall. So it goes in through a sense, tagged REAFFERENT and tied to the
    // act by `sourceIntentId`, rather than being flattened into a description
    // the executive reads at 120 characters and nothing ever stores.
    //
    // Somatosensation, because that is what it is for: "webhooks, system
    // signals, and external API callbacks — awareness of interaction with
    // external systems". An effector ack is precisely an external callback.
    //
    // This is what replaces the two-call dance a host used to need — return the
    // ack, then separately call `perceive()` and dress the answer up as
    // something somebody said. `discord_inspect_channel` still does that; it can
    // stop once it moves onto this.
    //
    // Fire-and-forget for the same reason the wake is: `ingest` is async and the
    // tick boundary is not. Audition has ingested off-tick since it existed.
    if( result.observation !== undefined && result.observation !== null )
      void instance.cognition.somatosensationEngine.ingest({
        kind:           'system',
        signal:         schema,
        provenance:     'reafferent',
        sourceIntentId: invocationId,
        // The observation itself, in whatever shape the host had it. The sense
        // renders it for reading; nothing reshapes or shortens it here.
        data:           result.observation,
      })

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
      outcome:             result.description,
      outcomeQuality:      result.success ? 0.8 : 0.2,
      confirmedExternally: true,
    } as never)

    logger.info(`[effector] ✓ reconciled ${result.success ? 'success' : 'failure'}: intent "${invocationId}" (${schema})`)
  }
}

function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}

/**
 * Project the `agency.invocation` payload onto the policy boundary's view of a
 * proposed act. Only the act crosses — no cognitive internals, no state handle.
 *
 * It lives here rather than with enforcement because the payload shape is the
 * translation seam's business: this file is the one that knows what an
 * `agency.invocation` carries.
 */
function toPolicyInvocation( instance: WillInstance, payload: Record<string, unknown> ): PolicyInvocation {
  return {
    willId:     instance.config.id,
    intentId:   ( payload.intentId as string ) ?? '',
    schema:     ( payload.schema as string ) ?? '',
    parameters: ( payload.parameters as Record<string, unknown> ) ?? {},
    ...( typeof payload.targetEntityId === 'string' ? { targetEntityId: payload.targetEntityId } : {} ),
    ...( Array.isArray( payload.targetAddresses )
      ? { targetAddresses: payload.targetAddresses as string[] } : {} ),
    ...( typeof payload.description    === 'string' ? { description:    payload.description    } : {} ),
    tick:       ( payload.tick as number ) ?? 0,
  }
}

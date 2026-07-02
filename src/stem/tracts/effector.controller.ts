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
import type { effectorInvocation } from '#types'
import type { WillInstance } from '#stem/index'

export class effectorController {
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
    const intentId = ( payload.intentId as string ) ?? ''
    instance.pendingEffectorInvocations.push({
      id:               intentId,
      decisionRecordId: intentId,   // correlation handle — the awaiting agency.intent id
      effectorName:      ( payload.schema as string ) ?? '',
      parameters:       ( payload.parameters as Record<string, unknown> ) ?? {},
      targetEntityId:   payload.targetEntityId as string | undefined,
      reasoning:        ( payload.reasoning as string ) ?? '',
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
    if( !intent || intent.type !== 'agency.intent' ){
      // No awaiting intent for this id. Expected when the executor's 15-tick await
      // timeout already abandoned it (writing a failed outcome + advancing any plan)
      // before the host's late ack arrived, or the id is unknown. Drop the straggler.
      logger.warn( `[effector] confirmExecution: no awaiting agency.intent "${invocationId}" (timed out / already reconciled?) — ignored` )
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
          logger.warn( `[effector] confirmExecution: dropped non-finite metric "${k}"=${String( v )} from host ack (${schema})` )
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

    logger.info( `[effector] ✓ reconciled ${result.success ? 'success' : 'failure'}: intent "${invocationId}" (${schema})` )
  }
}

function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}

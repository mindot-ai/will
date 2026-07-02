// ─────────────────────────────────────────────────────────────
// src/agency/reconcile.learning.ts  —  host-ack reconciliation
// ─────────────────────────────────────────────────────────────
//
// Closes the async loop for `external` / `communicate` enactions. When the
// MotorSchemaExecutor dispatches a host-owned effector it leaves the intent
// 'awaiting' and emits `agency.invocation`. The host later executes it and calls
// back; `reconcileInvocation` turns that callback into the `agency.outcome` the
// ReafferenceEngine already consumes — which both teaches the skill the real
// result AND frees the serial Will (reafference deletes the awaiting intent via
// the outcome's `intentId`).
//
// This is the agency-native equivalent of the legacy effectorController.
// confirmExecution — same efference-copy / reafference contract, new vocabulary.
// The stem wires its host ack endpoint to call this and write the returned entity.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export interface HostAckResult {
  success:        boolean
  /** 0..1 — how good the world's reply was. Defaults from `success` when omitted. */
  outcomeQuality?: number
  /** −1..1 felt valence of the outcome. */
  valence?:       number
  description?:   string
}

/**
 * Build the `agency.outcome` entity that confirms an awaiting invocation. The
 * caller (stem host-ack endpoint) writes it via `stateManager.setEntity`; the
 * ReafferenceEngine consumes it next tick — learning from it and deleting the
 * awaiting intent identified by `intentId`.
 *
 * `schema` is the awaiting intent's schema (the host has it from the
 * `agency.invocation` payload); `predictedReward`/`predictedValence` are the
 * efference copy the executor persisted on the intent, so surprise is honest.
 *
 * `provenance` carries the awaiting intent's plan link (planId/stepId) when it was
 * committed from a plan's frontier prior. It rides on the agency.outcome so the
 * ReafferenceEngine — the engine that consumes async-acked outcomes — can emit the
 * `action.outcome{planId,stepId}` the PlanningEngine advances on. (The executor
 * emits that itself for sync/timeout outcomes; the host-ack path has no executor in
 * the loop, so reafference is the single emitter for it — see ReafferenceEngine.)
 */
export function reconcileInvocation(
  intentId: string,
  schema:   string,
  result:   HostAckResult,
  tick:     Tick,
  predicted: { reward: number; valence: number } = { reward: 0.5, valence: 0 },
  provenance: { planId?: string; stepId?: string } = {},
): EntityInput {
  const outcomeQuality = result.outcomeQuality ?? ( result.success ? 0.8 : 0.1 )
  const valence        = result.valence ?? ( result.success ? 0.2 : -0.2 )
  const surprise       = clamp01( Math.abs( predicted.reward - outcomeQuality ) )

  return {
    id:   `agency-outcome-${ tick }-${ intentId }`,
    type: 'agency.outcome',
    metadata: {
      schema,
      intentId,
      success:          result.success,
      outcomeQuality,
      valence,
      predictedReward:  predicted.reward,
      predictedValence: predicted.valence,
      surprise,
      description:      result.description ?? ( result.success ? 'The world confirmed the action.' : 'The world rejected the action.' ),
      mode:             'external',
      tick,
      reconciled:       true,
      ...( provenance.planId ? { planId: provenance.planId } : {} ),
      ...( provenance.stepId ? { stepId: provenance.stepId } : {} ),
    },
  }
}

function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// ─────────────────────────────────────────────────────────────
// src/stem/tracts/effector/policy.enforcement.ts
// ─────────────────────────────────────────────────────────────
//
// SIGNAL_BOUNDARY P1a — the policy seam, extracted verbatim from
// `effector.controller.ts`. Arbiter, verdicts, refusals.
//
// This is the PEP: the Policy Enforcement Point that consults the arbiter (the
// PDP) before an invocation reaches the world, records the verdict on the tape,
// and enforces it. A refusal does not raise a dialog — it is reconciled as a
// failure ack, so the mind meets *world resistance* and learns from it
// (POLICY_REAFFERENCE P1/P2).

import { logger } from '#core/logger'
import { NULL_ARBITER, isNullArbiter, finalityOf } from '#stem/policy/arbiter'
import type {
  PolicyArbiter, PolicyInvocation, Verdict, DenialFinality,
} from '#stem/policy/arbiter'
import {
  getVerdictRecorder, getVerdictSource, type PolicyVerdictRecord,
} from '#stem/policy/verdict.recorder'
import type { WillInstance } from '#stem/index'
import type { EffectorOps, Escalation, PendingRefusal } from './types'

/**
 * The verdict a fault produces (POLICY_REAFFERENCE P5, conformance S9).
 *
 * An arbiter that throws or rejects has always failed CLOSED — the effect is
 * withheld — but it used to withhold *silently*, queueing no refusal. The held
 * intent then expired at the executor's AWAIT_TIMEOUT and reconciled as a plain
 * failure, landing on COMPETENCE: a PDP outage taught the mind it was unskilled
 * at something it is perfectly capable of. So a fault now yields a real verdict:
 *
 *   • 'deny'    — still fail-closed, unchanged. The effect never reaches the world.
 *   • 'context' — but it teaches NOTHING. The arbiter being unreachable is not a
 *                 fact about the ability, so nothing about the ability may move.
 *
 * It goes through `_recordAndApply` rather than straight to the refusal queue so
 * the fault lands on the VERDICT TAPE too. That closes a replay hole: an
 * unrecorded fault left the source with nothing to re-feed, and a source miss
 * reproduces a buffered ALLOW — so a live run that withheld the effect would
 * have replayed as one that dispatched it.
 */
const ARBITER_FAULT_VERDICT: Readonly<Verdict> = Object.freeze({
  decision:   'deny' as const,
  reasonCode: 'ARBITER_UNAVAILABLE',
  finality:   'context' as const,
})

/** What enforcement needs from the seams either side of it. */
export interface PolicyDeps extends EffectorOps {
  /** Hand an escalate verdict to the escalation lifecycle. */
  raiseEscalation( instance: WillInstance, esc: Escalation ): void
}

export class PolicyEnforcement {
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

  constructor( private readonly _deps: PolicyDeps ){}

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
   * Consult the PDP for this invocation and enforce the answer. Falls through to
   * a plain buffer when no policy is configured — the byte-identical fast path.
   *
   * `toPolicyInvocation` is supplied by the caller so the projection onto the
   * policy boundary stays with the translation seam that owns the payload shape.
   */
  evaluate(
    instance: WillInstance,
    payload:  Record<string, unknown>,
    project:  ( instance: WillInstance, payload: Record<string, unknown> ) => PolicyInvocation,
  ): void {
    const willId = instance.config.id

    // Replay: a registered source re-feeds the recorded verdict instead of
    // re-consulting a live (or absent) PDP — the arbiter is an external oracle,
    // exactly like the LLM. Checked FIRST so replay never re-enters the arbiter.
    const source = getVerdictSource( willId )
    if( source ){
      const invocation = project( instance, payload )
      const record     = source.verdictFor( invocation.tick, invocation.intentId )
      // A miss means the live run had no verdict here (null arbiter at record
      // time) — the invocation was simply buffered, so reproduce that.
      if( record ) this._applyVerdict( instance, payload, invocation, recordToVerdict( record ) )
      else         this._deps.buffer( instance, payload )
      return
    }

    // Fast path: no policy configured ⇒ the seam does not exist. No allocation,
    // no branch beyond this one — the byte-identical guarantee.
    if( isNullArbiter( this._arbiter ) ){
      this._deps.buffer( instance, payload )
      return
    }

    const invocation = project( instance, payload )
    let verdict: Verdict | Promise<Verdict>

    // An arbiter that throws must never become an implicit allow.
    try { verdict = this._arbiter.evaluate( invocation ) }
    catch( err ){
      logger.error(`[policy] arbiter "${this._arbiter.name}" threw for "${invocation.schema}" — failing closed:`, err )
      this._recordAndApply( instance, payload, invocation, ARBITER_FAULT_VERDICT )
      return
    }

    if( verdict instanceof Promise ){
      // An external PDP resolves out of tick. Safe by construction: the executor
      // holds the intent 'awaiting' for AWAIT_TIMEOUT (15 ticks), and the refusal
      // queue drains each tick, so a verdict landing a few ticks late still lands.
      void verdict.then(
        v => this._recordAndApply( instance, payload, invocation, v ),
        err => {
          logger.error(`[policy] arbiter "${this._arbiter.name}" rejected for "${invocation.schema}" — failing closed:`, err )
          this._recordAndApply( instance, payload, invocation, ARBITER_FAULT_VERDICT )
        },
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
   * Enforce a verdict (POLICY_REAFFERENCE P1). THE ROUTER, and the one method
   * that reaches across both seams by design:
   *
   *   • allow    → hand the invocation to the world.
   *   • deny     → queue a refusal ack, applied at the next tick boundary via
   *                `confirmExecution` — the same lifecycle as a host rejection,
   *                so the mind meets *world resistance*, not a permission dialog.
   *   • escalate → raise a held escalation (POLICY_REAFFERENCE P4): the intent is
   *                held (the executor stops timing it out), the Will voices a
   *                first-person ask once, and a host resolution later approves
   *                (dispatch) or denies (refuse). Unresolved, it degrades to a
   *                refusal at ESCALATION_TTL_TICKS.
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
      this._deps.buffer( instance, payload )
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
        finality:   finalityOf( verdict ),
        ...( verdict.counterfactual ? { counterfactual: verdict.counterfactual } : {} ),
      })
      this._pendingRefusals.set( instance.config.id, queue )
      return
    }

    // 'escalate' — raise a held escalation, applied (marked + voiced) at the boundary.
    this._deps.raiseEscalation( instance, {
      intentId:   invocation.intentId,
      schema:     invocation.schema,
      reasonCode: verdict.reasonCode ?? 'APPROVAL_REQUIRED',
      payload,
      expiresAt:  0,   // stamped when applied (we don't have the current tick here)
    } )
  }

  /** Push a refusal onto the queue drained by `applyRefusals` this same tick. */
  queueRefusal(
    instance: WillInstance, intentId: string, schema: string, reasonCode: string, finality: DenialFinality,
  ): void {
    const queue = this._pendingRefusals.get( instance.config.id ) ?? []
    queue.push({ intentId, schema, reasonCode, finality })
    this._pendingRefusals.set( instance.config.id, queue )
  }

  /** Drain queued refusals into failure acks (POLICY_REAFFERENCE P1). */
  applyRefusals( instance: WillInstance ): void {
    const queue = this._pendingRefusals.get( instance.config.id )
    if( !queue || queue.length === 0 ) return
    this._pendingRefusals.set( instance.config.id, [] )

    for( const refusal of queue )
      this._deps.confirmExecution( instance, refusal.intentId, {
        success:     false,
        refused:     true,
        finality:    refusal.finality,
        ...( refusal.counterfactual ? { counterfactual: refusal.counterfactual } : {} ),
        description: `refused by policy: ${refusal.reasonCode} (${refusal.finality})`,
      } )
  }
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

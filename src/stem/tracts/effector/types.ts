// ─────────────────────────────────────────────────────────────
// src/stem/tracts/effector/types.ts  —  the efference crossing, shared shapes
// ─────────────────────────────────────────────────────────────
//
// SIGNAL_BOUNDARY P1a. `effector.controller.ts` had seven jobs; these are the
// shapes its three real seams pass between them:
//
//   policy enforcement   arbiter · verdicts · refusals
//   escalation lifecycle hold · resolve · expire
//   agency↔host          buffer · drain · ack   (the controller itself)
//
// The seams were verified before the cut, not assumed: no method touched both
// the policy fields (`_arbiter`, `_pendingRefusals`) and the escalation fields
// (`_newEscalations`, `_activeEscalations`, `_pendingResolutions`) except
// `_applyVerdict`, which is the ROUTER — deny goes one way, escalate the other.
// A router across a seam is the seam working, not a tangle.

import type { DenialFinality, PolicyCounterfactual } from '#stem/policy/arbiter'
import type { WillInstance } from '#stem/index'

/** A denial awaiting application as a refusal ack at the next tick boundary. */
export interface PendingRefusal {
  intentId:   string
  schema:     string
  reasonCode: string
  finality:   DenialFinality
  /** ENVELOPE_NARROWING P0 — what WOULD have been allowed, carried through to
   *  the outcome the mind learns from. Absent on refusals that have no bound to
   *  report (a flat ban, a fault, an unanswered escalation). */
  counterfactual?: PolicyCounterfactual
}

/** An escalation the Will has raised: the intent is held, the ask is voiced once,
 *  and the original payload is kept so an approval can dispatch it to the world. */
export interface Escalation {
  intentId:   string
  schema:     string
  reasonCode: string
  /** The withheld invocation payload — replayed to the host on approval. */
  payload:    Record<string, unknown>
  expiresAt:  number
}

/** A host's answer to an escalation, applied at the next tick boundary. */
export interface PendingResolution {
  intentId: string
  approved: boolean
}

/** What a host says came back. */
export interface EffectorAck {
  success:     boolean
  /**
   * How the act WENT. The fate of the attempt — landed, refused, failed — which
   * is what the mind learns competence from. Not what the act revealed.
   */
  description: string
  /**
   * What the act REVEALED: new information about the world, as distinct from how
   * the act went (SIGNAL_BOUNDARY P2).
   *
   * Present ⇒ this ack is ALSO afference. It arrives as a reafferent percept
   * carrying `sourceIntentId`, so the mind perceives it, remembers it and can
   * recall it — rather than only learning from it. `lookup`, `list_warnings`,
   * `snapshot` carry one; `kick`, `warn`, a refusal do not.
   *
   * WHY THE HOST DECIDES, AND WHY THIS IS NOT INFERRED FROM `description`.
   * An ack is not *always* new world information, and nothing inside the mind
   * can tell "the kick landed" from "there are 47 people here" — both are
   * strings that came back from an act. Only the host knows which it wrote.
   * Same contract as `provenance`: asserted at the boundary, never guessed.
   *
   * Forcing every ack through the sense door would be the over-unification this
   * epoch warns about — a mind perceiving "the kick landed" as a fresh event in
   * the world, every time it kicks.
   *
   * ANY SHAPE, AND CARRIED WHOLE. A host with a member record, a channel
   * snapshot, a list of warnings sends the record — not a paragraph about it.
   * Making a host flatten its own data to prose is a quieter kind of cutting:
   * it destroys the structure rather than the tail. Nothing here is truncated
   * at any point on the way in; what the host sent is what the mind gets.
   */
  observation?: unknown
  metrics?:    Record<string, number>
  /** POLICY_REAFFERENCE P2 — set when the ack is a policy refusal, so the
   *  ReafferenceEngine routes it to availability rather than competence. */
  refused?:    boolean
  finality?:   DenialFinality
  /** ENVELOPE_NARROWING P0 — the bound that was exceeded, if the arbiter said. */
  counterfactual?: PolicyCounterfactual
}

/**
 * The translation seam, as the other two see it.
 *
 * Both collaborators need to put an invocation on the wire, and policy also
 * needs to reconcile a refusal as an ack. Injected as plain functions rather
 * than a controller reference: it keeps the dependency one-way at the type
 * level, and it is what lets the controller wire a cycle (policy raises an
 * escalation, an escalation queues a refusal) without either class importing
 * the other.
 */
export interface EffectorOps {
  buffer( instance: WillInstance, payload: Record<string, unknown> ): void
  confirmExecution( instance: WillInstance, invocationId: string, result: EffectorAck ): void
}

/** How long an escalated intent is held awaiting a resolution before it degrades
 *  to a refusal — 2× the host-ack timeout, so a human has real time to answer. */
export const ESCALATION_TTL_TICKS = 30

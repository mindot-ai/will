// ─────────────────────────────────────────────────────────────
// src/stem/policy/arbiter.ts  —  the policy seam (PEP side)
// ─────────────────────────────────────────────────────────────
//
// POLICY_REAFFERENCE P0. A Policy Decision Point is consulted before a
// host-owned effector invocation is handed to the world. This file is the
// *interface* only — the enforcement point lives in effectorController
// (`bufferInvocation`), which is the single tract every external effect
// already passes through.
//
// Deliberately provider-agnostic: no transport, no vendor types, no Go. The
// null arbiter below is the default and is a strict no-op, so a Will with no
// policy configured runs byte-identically to one built before this file
// existed. `RuleTableArbiter` (rule.table.ts) is the local reference adapter;
// an external PDP (e.g. helm-ai-kernel) is a later phase and must implement
// nothing more than this interface.
//
// WHY THE STEM AND NOT COGNITION: the mind must never meet a permission
// dialog. It dispatches an intent and the world either yields or resists —
// a refusal arrives as reafference, in the same currency as any other
// outcome. Keeping the arbiter below the SDK and outside the cognition layer
// is what preserves that (and is the honest model besides: a body that
// cannot do the thing).
//
// SYNC OR ASYNC: `evaluate` may return a Verdict or a Promise of one. An
// external PDP will be async, and that is fine by construction — the intent
// is already held 'awaiting' for AWAIT_TIMEOUT (15 ticks) by the executor, so
// arbiter latency is absorbed by machinery that already exists. Both P0
// adapters are synchronous, which is why P0 changes no behaviour.
// ─────────────────────────────────────────────────────────────

/** What the boundary decided about a proposed effect. */
export type PolicyDecision = 'allow' | 'deny' | 'escalate'

/**
 * Is this denial a property of the ACTION CLASS (never permitted under the
 * active policy) or of THIS INSTANCE (wrong target, exceeded bound)?
 *
 * This is the distinction that makes a refusal learnable rather than a wall to
 * re-probe forever, and it is the field we are proposing upstream to HELM. A
 * 'class' denial should suppress the affordance; an 'instance' denial should
 * only narrow the parameter envelope the Will reaches for.
 */
export type DenialFinality = 'class' | 'instance'

/**
 * The nearest allowed envelope — what WOULD have been permitted. Structured so
 * a learner can consume it; `field` names the constraint that bit.
 *
 * Every denial branch of a policy evaluator already computes this and usually
 * discards it. We keep it.
 */
export interface PolicyCounterfactual {
  /** The constrained field, e.g. 'ttl_days', 'target', 'amount'. */
  field:      string
  /** What the Will asked for. */
  requested?: unknown
  /** The bound or permitted set, e.g. 30, or [ 'a', 'b' ]. */
  allowed?:   unknown
}

/** A boundary decision about one proposed invocation. */
export interface Verdict {
  decision:        PolicyDecision
  /** Stable machine-readable code, e.g. 'TARGET_NOT_ALLOWED'. Never prose. */
  reasonCode?:     string
  /** Meaningful on 'deny' only. Absent ⇒ treat as 'instance' (the safe default:
   *  it narrows rather than suppresses, so a mis-tagged denial cannot silently
   *  delete an ability from the Will's reach). */
  finality?:       DenialFinality
  counterfactual?: PolicyCounterfactual
  /** Free-text for logs and host UX. NEVER parsed by cognition. */
  detail?:         string
}

/**
 * The proposed effect, as the stem sees it. Mirrors the `agency.invocation`
 * bus payload the MotorSchemaExecutor emits — no cognitive internals cross
 * this boundary, only the act itself.
 */
export interface PolicyInvocation {
  willId:          string
  /** The awaiting `agency.intent` id — the correlation handle, end to end. */
  intentId:        string
  /** The motor schema id, i.e. the ability being enacted. */
  schema:          string
  parameters:      Record<string, unknown>
  targetEntityId?: string
  /** The ability's declared meaning, as given by the host at wiring time. */
  description?:    string
  tick:            number
}

/**
 * A Policy Decision Point. Implementations must be PURE with respect to the
 * Will: an arbiter may read its own policy and the invocation, and nothing
 * else. It must not reach into simulation state.
 *
 * DETERMINISM CONTRACT: an arbiter is an external oracle, exactly like the LLM.
 * Its verdicts are recorded on the tape and replayed back — replay never
 * re-consults an arbiter (see P1). Implementations therefore need not be
 * deterministic themselves, but MUST be free of side effects on the Will.
 */
export interface PolicyArbiter {
  /** Stable identifier, recorded alongside the verdict for audit. */
  readonly name: string
  evaluate( invocation: PolicyInvocation ): Verdict | Promise<Verdict>
}

/** The single allow verdict, frozen and shared — the null arbiter allocates nothing. */
const ALLOW: Readonly<Verdict> = Object.freeze({ decision: 'allow' as const })

/**
 * The default. Allows everything, allocates nothing, logs nothing.
 *
 * A Will running this must be byte-identical to one built before the policy
 * seam existed — that property is asserted by test, and it is what lets this
 * ship dark.
 */
export const NULL_ARBITER: PolicyArbiter = {
  name: 'null',
  evaluate(): Verdict { return ALLOW },
}

/** True when the arbiter is the no-op default (used to skip the seam entirely). */
export function isNullArbiter( arbiter: PolicyArbiter | null | undefined ): boolean {
  return !arbiter || arbiter === NULL_ARBITER
}

/**
 * Normalize a denial's finality. Absent ⇒ 'instance', the conservative reading:
 * an unlabelled refusal narrows the envelope but never removes the ability.
 */
export function finalityOf( verdict: Verdict ): DenialFinality {
  return verdict.finality === 'class' ? 'class' : 'instance'
}

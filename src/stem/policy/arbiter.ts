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
 * WHY this denial is final — the distinction that makes a refusal learnable
 * rather than a wall to re-probe forever. Each value selects a different
 * cognitive fate; they are not degrees of one severity.
 *
 *   • 'class'     — the ACTION ITSELF is never permitted. Suppress the
 *                   affordance hard, erase any learned envelope, and let go of
 *                   a commitment currently deliberating toward it.
 *   • 'parameter' — the action is fine; THESE ARGUMENTS were not (bound
 *                   exceeded, wrong target). Narrow the envelope the Will
 *                   reaches for; the ability stays.
 *   • 'context'   — the refusal was NOT ABOUT THE ACTION at all (tainted
 *                   context, unavailable dependency). Touch nothing: no
 *                   availability delta, no envelope, no competence.
 *
 * POLICY_REAFFERENCE P5 widened this from 'class' | 'instance' after the HELM
 * joint RFC ("Denials That Teach") identified that an instance-scoped refusal
 * splits in two, and that the two halves demand opposite responses. These are
 * OUR names for the distinctions, deliberately not HELM's wire spellings — see
 * the naming-boundary note in .TODO/POLICY_REAFFERENCE.md. A provider adapter
 * translates; this interface stays vendor-neutral.
 */
export type DenialFinality = 'class' | 'parameter' | 'context'

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
  /** Meaningful on 'deny' only. Absent ⇒ treat as 'parameter' — see
   *  `asFinality` for why that, and not 'context', is the safe default. */
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
  /**
   * The addresses this host knows `targetEntityId` by (e.g. `discord:123…`) —
   * the same enrichment a host effector handler already receives on `ctx`
   * (`EffectorHandler`'s `ctx.targetAddresses`, `surface/sdk/will.ts`). The
   * arbiter sits at the identical boundary, one step earlier in the same flow,
   * so withholding it here bought no extra privacy — a handler downstream of an
   * ALLOW already sees it. Absent when the invocation binds no target or the
   * entity has no known address.
   */
  targetAddresses?: readonly string[]
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

/** Normalize a denial's finality. Absent ⇒ 'parameter' (see `asFinality`). */
export function finalityOf( verdict: Verdict ): DenialFinality {
  return asFinality( verdict.finality )
}

/**
 * Normalize an UNTYPED finality — one read back off entity metadata, a verdict
 * tape, or a host ack, where the type system cannot help.
 *
 * Every such read goes through here rather than comparing string literals at
 * the call site: the enum is a moving target (it widened once for the HELM
 * joint RFC and may again), and a hand-written `=== 'class'` scattered through
 * cognition is a mis-route that still typechecks.
 *
 * THE DEFAULT IS 'parameter', AND NEVER 'context'. The intuitive reading — an
 * unlabelled denial should do the LEAST, so default to the fate that touches
 * nothing — is wrong, and dangerously so. 'context' means *the mind learns
 * nothing from this denial*, so it re-probes the same wall forever: the exact
 * failure this whole epoch exists to fix, silently re-enabled for any provider
 * that doesn't tag its refusals. 'context' is a claim only a provider that
 * actually knows can make — it must be ASSERTED, never defaulted to.
 * 'parameter' narrows without deleting, which is the honest conservative
 * reading and preserves pre-P5 behaviour for an untagged denial exactly.
 *
 * Legacy 'instance' (the pre-P5 spelling) normalizes to 'parameter' by the same
 * fallback, so tapes and snapshots written before the split replay unchanged.
 */
export function asFinality( raw: unknown ): DenialFinality {
  return raw === 'class' ? 'class' : raw === 'context' ? 'context' : 'parameter'
}

// ─────────────────────────────────────────────────────────────
// src/llm/routing.ts
// ─────────────────────────────────────────────────────────────
//
// MODEL_ROUTING W2 — per-call model selection.
//
// A Will runs one LLMDirector, and every call site shares it: the master's
// decision, each facet, the propose pass, the rolling summariser, the identity
// guard. They are not the same cognitive act, and they need not be the same
// inference. This module lets a host decide which model serves which call,
// without the engine learning anything it should not know.
//
// WHAT THIS IS NOT. This is a mechanism, never a policy. The engine may know
// that a call is routine or consequential — that is a cognitive fact it already
// computes (`LLMCallMeta.demand`). It must never know who is paying, what plan
// they are on, or what anything costs us. A router that needs commercial
// information is the host's to write; the seam below carries none of it.
//
// DETERMINISM CONTRACT. A router is an external oracle, exactly like the LLM
// itself and the policy arbiter. Its choice is already captured: the completion
// tape records `provider` and `model` on every call, and replay re-feeds the
// recorded completion rather than re-deciding. So replay never consults a
// router, and a run replays byte-for-byte whether the router is absent,
// present, or since reconfigured.
//
// SCOPE. A router may read the call meta and its own configuration, and nothing
// else. It must not reach into simulation state — that is what keeps this
// module below cognition (src/llm imports no cognition behaviour) and keeps
// routing from becoming a hidden input to the mind.
// ─────────────────────────────────────────────────────────────

import type { LLMProvider, LLMCallMeta } from '#llm/index'

/**
 * Where a single call should go. Every field except `provider`/`model` falls
 * back to the Will's default when omitted.
 */
export interface ModelRoute {
  provider: LLMProvider
  model: string
  /** Override the provider's API base (self-hosted / OpenAI-compatible servers). */
  baseUrl?: string
  /** Override the output-token ceiling for this call. */
  maxOutputTokens?: number
}

/**
 * Chooses a model for a call.
 *
 * Returning `null` means "no opinion" — the Will's default model is used. A
 * router should return `null` rather than guess when it does not recognise a
 * call: falling back is always safe, and a wrong route is not.
 */
export interface ModelRouter {
  /** Stable identifier, recorded alongside routing telemetry. */
  readonly name: string
  route( meta: LLMCallMeta ): ModelRoute | null
}

/**
 * The default. Has no opinion about anything, allocates nothing.
 *
 * A Will running this must be byte-identical to one built before the routing
 * seam existed — that property is asserted by test, and it is what lets this
 * ship dark.
 */
export const NULL_ROUTER: ModelRouter = {
  name: 'null',
  route(): ModelRoute | null { return null },
}

/** True when the router is the no-op default (used to skip the seam entirely). */
export function isNullRouter( router: ModelRouter | null | undefined ): boolean {
  return !router || router === NULL_ROUTER
}

// ── Reference implementation ──────────────────────────────────

/**
 * One entry in a {@link TableRouter}'s table. All present conditions must match
 * (logical AND); an absent condition matches anything.
 */
export interface RoutingRule {
  /** Match `LLMCallMeta.category` exactly (e.g. 'executive', 'summarizer'). */
  category?: string
  /** Match `LLMCallMeta.attribute` exactly (e.g. 'master', 'facet', 'guard'). */
  attribute?: string
  /** Match `LLMCallMeta.function` exactly (e.g. 'decision', 'consolidation'). */
  function?: string
  /**
   * Inclusive lower bound on `LLMCallMeta.demand`. A call with no demand
   * reported never matches a rule that sets this — absent means unknown, and
   * unknown must not be treated as zero.
   */
  minDemand?: number
  /** Exclusive upper bound on `LLMCallMeta.demand`. Same absence rule. */
  maxDemand?: number
  /** Where a matching call goes. */
  route: ModelRoute
}

/**
 * A worked example of the seam: first matching rule wins, otherwise no opinion.
 *
 * This ships so that the interface has a reference implementation and so that
 * hosts have something to copy — it is deliberately dumb. It is not a routing
 * strategy, and the engine ships no table of its own: what belongs where is the
 * host's decision, expressed as configuration.
 *
 * Rules are evaluated in order, so put specific rules before general ones.
 */
export class TableRouter implements ModelRouter {
  readonly name: string
  private readonly _rules: readonly RoutingRule[]

  constructor( rules: readonly RoutingRule[], name = 'table' ){
    this._rules = [ ...rules ]
    this.name   = name
  }

  route( meta: LLMCallMeta ): ModelRoute | null {
    for( const rule of this._rules ){
      if( matches( rule, meta ) ) return rule.route
    }
    return null
  }
}

function matches( rule: RoutingRule, meta: LLMCallMeta ): boolean {
  if( rule.category  !== undefined && rule.category  !== meta.category  ) return false
  if( rule.attribute !== undefined && rule.attribute !== meta.attribute ) return false
  if( rule.function  !== undefined && rule.function  !== meta.function  ) return false

  // Absent demand is UNKNOWN, not zero: a demand-bounded rule cannot claim a
  // call whose demand was never measured.
  const bounded = rule.minDemand !== undefined || rule.maxDemand !== undefined
  if( bounded ){
    const d = meta.demand
    if( typeof d !== 'number' || Number.isNaN( d ) ) return false
    if( rule.minDemand !== undefined && d <  rule.minDemand ) return false
    if( rule.maxDemand !== undefined && d >= rule.maxDemand ) return false
  }

  return true
}

// ─────────────────────────────────────────────────────────────
// src/stem/policy/rule.table.ts  —  the local reference PDP
// ─────────────────────────────────────────────────────────────
//
// POLICY_REAFFERENCE P0. A declarative, in-process arbiter: enough policy to
// prove the seam is sufficient WITHOUT an external dependency, and the
// fallback if an external-PDP track stalls.
//
// It is also a working demonstration of the two receipt fields we are
// proposing upstream (`finality`, `counterfactual`): when a bound is violated
// this arbiter *returns what would have been allowed* instead of discarding
// it. That is the whole argument, implemented in ~40 lines — a denial that
// says "never" and one that says "not with these parameters" are different
// facts, and a learner needs to tell them apart.
//
// Evaluation is first-match-wins over an ordered rule array, so a verdict is a
// pure function of ( rules, invocation ) — no clock, no IO, no iteration-order
// surprises. Deterministic by construction, which keeps replay honest.
// ─────────────────────────────────────────────────────────────

import type {
  PolicyArbiter, PolicyInvocation, Verdict,
  PolicyDecision, DenialFinality, PolicyCounterfactual,
} from '#stem/policy/arbiter'

/** A bound on one parameter. Checked in declaration order: max, min, equals, oneOf. */
export interface ParamConstraint {
  max?:    number
  min?:    number
  equals?: unknown
  oneOf?:  readonly unknown[]
}

/**
 * One rule. `schema`/`target` scope it (omitted ⇒ matches any); the FIRST rule
 * whose scope matches decides, so order is policy.
 *
 * `require` is meaningful with `decision: 'allow'` only: the scope matched, and
 * these constraints must hold for the allow to stand. A violation flips the
 * verdict to deny — carrying the counterfactual — with finality 'instance',
 * because the ability itself was permitted and only these arguments were not.
 *
 * A rule with `decision: 'deny'` and no `require` is a flat class-level ban;
 * it reports finality 'class' unless told otherwise.
 */
export interface PolicyRule {
  schema?:     string
  target?:     string
  decision:    PolicyDecision
  require?:    Record<string, ParamConstraint>
  reasonCode?: string
  finality?:   DenialFinality
}

export interface RuleTableOptions {
  rules: readonly PolicyRule[]
  /**
   * The verdict when NO rule matches. Required — deliberately not defaulted.
   * A policy component that silently defaults open is a trap; make the posture
   * an explicit decision at the call site. 'deny' is fail-closed and is the
   * right choice once a rule set is complete.
   */
  fallthrough: PolicyDecision
  /** Recorded with every verdict for audit. Defaults to 'rule-table'. */
  name?: string
}

export class RuleTableArbiter implements PolicyArbiter {
  readonly name: string
  private readonly _rules:       readonly PolicyRule[]
  private readonly _fallthrough: PolicyDecision

  constructor( opts: RuleTableOptions ){
    this.name         = opts.name ?? 'rule-table'
    this._rules       = opts.rules
    this._fallthrough = opts.fallthrough
  }

  evaluate( invocation: PolicyInvocation ): Verdict {
    for( const rule of this._rules ){
      if( !scopeMatches( rule, invocation ) ) continue

      if( rule.decision !== 'allow')
        return {
          decision: rule.decision,
          ...( rule.reasonCode ? { reasonCode: rule.reasonCode } : {} ),
          ...( rule.decision === 'deny'
            ? { finality: rule.finality ?? 'class' }
            : {} ),
        }

      const violation = firstViolation( rule.require, invocation.parameters )
      if( violation )
        return {
          decision:       'deny',
          reasonCode:     rule.reasonCode ?? violation.reasonCode,
          finality:       rule.finality ?? 'instance',
          counterfactual: violation.counterfactual,
        }

      return { decision: 'allow' }
    }

    return {
      decision: this._fallthrough,
      ...( this._fallthrough !== 'allow' ? { reasonCode: 'NO_MATCHING_RULE', finality: 'class' as const } : {} ),
    }
  }
}

// ── matching ─────────────────────────────────────────────────────────────────

function scopeMatches( rule: PolicyRule, inv: PolicyInvocation ): boolean {
  if( rule.schema !== undefined && rule.schema !== '*' && rule.schema !== inv.schema ) return false
  if( rule.target !== undefined && rule.target !== '*' && rule.target !== inv.targetEntityId ) return false
  return true
}

interface Violation {
  reasonCode:     string
  counterfactual: PolicyCounterfactual
}

/**
 * The first constraint that fails, in declared order — so the counterfactual a
 * caller receives is stable, not whichever check happened to run first.
 *
 * An ABSENT parameter is a violation: a bound cannot be honoured by a value
 * that was never supplied, and habitual enaction (which carries no args) must
 * not slip past a constraint the deliberate path would have to satisfy.
 */
function firstViolation(
  require:    Record<string, ParamConstraint> | undefined,
  parameters: Record<string, unknown>,
): Violation | null {
  if( !require ) return null

  for( const [ field, constraint ] of Object.entries( require ) ){
    const present = Object.prototype.hasOwnProperty.call( parameters, field )
    if( !present )
      return {
        reasonCode:     'PARAM_MISSING',
        counterfactual: { field, allowed: describe( constraint ) },
      }

    const value = parameters[ field ]

    if( constraint.max !== undefined && !( typeof value === 'number' && value <= constraint.max ) )
      return { reasonCode: 'PARAM_ABOVE_MAX', counterfactual: { field, requested: value, allowed: constraint.max } }

    if( constraint.min !== undefined && !( typeof value === 'number' && value >= constraint.min ) )
      return { reasonCode: 'PARAM_BELOW_MIN', counterfactual: { field, requested: value, allowed: constraint.min } }

    if( 'equals' in constraint && value !== constraint.equals )
      return { reasonCode: 'PARAM_NOT_EQUAL', counterfactual: { field, requested: value, allowed: constraint.equals } }

    if( constraint.oneOf !== undefined && !constraint.oneOf.includes( value ) )
      return { reasonCode: 'PARAM_NOT_IN_SET', counterfactual: { field, requested: value, allowed: [ ...constraint.oneOf ] } }
  }

  return null
}

/** A compact description of a constraint, for the missing-parameter case. */
function describe( c: ParamConstraint ): unknown {
  if( c.oneOf !== undefined )  return [ ...c.oneOf ]
  if( 'equals' in c )          return c.equals
  if( c.max !== undefined && c.min !== undefined ) return { min: c.min, max: c.max }
  if( c.max !== undefined )    return { max: c.max }
  if( c.min !== undefined )    return { min: c.min }
  return null
}

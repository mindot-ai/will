// ─────────────────────────────────────────────────────────────
// src/agency/types.ts  —  core contracts for the agency pipeline
// ─────────────────────────────────────────────────────────────
//
// The vocabulary of a mind that *finds* its actions in the situation rather
// than looking them up in a catalog. An Affordance is a possibility the current
// state affords; a MotorSchema is the control program that would enact it; a
// LearnedSkill is what the Will has accreted about running that schema; a
// SchemaOutcome is the reafference that teaches it. Nothing here owns behaviour —
// these are the stable nouns every agency engine references.
//
// See AGENCY_PIPELINE_TODO.md for the end-to-end design.
// ─────────────────────────────────────────────────────────────

/** Where an affordance came from — its evoking origin in the perception field. */
export type AffordanceSource =
  | 'innate'      // always-on floor; needs no object (orient, rest, reflect, wait)
  | 'perceptual'  // evoked by a salient percept (inspect this, attend to that)
  | 'social'      // evoked by a known sentient entity (reach out to them)
  | 'repertoire'  // a learned composite skill whose trigger matches now
  | 'ideomotor'   // pre-activated by the executive imagining the outcome
  | 'plan'        // pre-activated by an executing plan's current frontier step (top-down prior)
  | 'external'    // a host-owned domain effector (move, attack, trade …) dispatched to the world

/** A body-state gate. If any precondition fails, the affordance is unavailable. */
export interface SchemaPrecondition {
  metric: string
  op:     'gt' | 'lt' | 'gte' | 'lte' | 'eq'
  value:  number
}

/**
 * What kind of target a schema binds when it becomes an affordance.
 * 'entity' = a sentient known-entity (a person); 'object' = a non-sentient
 * known-entity (a thing); 'percept' = a salient percept; 'none' = objectless.
 */
export type SchemaBinding = 'none' | 'entity' | 'object' | 'percept'

/**
 * A MotorSchema — a parameterized control program, not a flat effector row.
 * `kind: 'primitive'` runs a body directly (an internal stance, a communication,
 * or an external host invocation). `kind: 'composite'` expands into an ordered
 * policy over sub-schemas (this is where a *created* skill actually executes).
 */
export interface MotorSchema {
  id:            string
  kind:          'primitive' | 'composite'
  source:        AffordanceSource
  /** Normalized intrinsic cost 0..1 (effort / energy demand). */
  cost:          number
  /** What this schema binds to when afforded. */
  binds:         SchemaBinding
  /** Body-state gates evaluated against live metrics. */
  preconditions?: SchemaPrecondition[]
  /** Sub-schema ids, in policy order — composite schemas only. */
  composedOf?:   string[]
  /** Intrinsic affective prior (−1..1) before any learning has occurred. */
  baseValence?:  number
  /** What the schema is *for* — its meaning, carried to the host on enaction. */
  description?:  string
  tags?:         string[]
}

/**
 * How a host declares a domain effector to a Will. A bare string is the
 * name-only form (`CUSTOM_ABILITY_WIRING.md` Phase 1). The object form seeds the
 * ability as a *learnable affordance*: `description` is its meaning; `cost`,
 * `valence`, and `preconditions` are the intrinsic priors the mind starts from
 * before reafference refines them through use. Args still bind from the
 * situation — this is not a tool-call parameter form.
 */
export type EffectorDeclaration =
  | string
  | {
      name:           string
      /** What the ability is for — its meaning, carried to perception + the host. */
      description?:   string
      /** Intrinsic effort/energy demand 0..1 (default 0.15). */
      cost?:          number
      /** Intrinsic affective prior −1..1 the mind expects before learning (default 0). */
      valence?:       number
      /** Body-state gates; the affordance is unavailable unless all pass. */
      preconditions?: SchemaPrecondition[]
      /**
       * Whether the ability targets a specific *perceived* target (default
       * 'none'). 'entity' binds it to each sentient known-entity (a person),
       * 'object' to each non-sentient one (a thing) — so the Will can
       * `give`/`greet` someone or `use`/`pick-up` something in particular; the
       * bound target reaches the host as `ctx.targetEntityId`.
       */
      binds?:         'none' | 'entity' | 'object'
      /**
       * Routing tags folded into the schema (merged with 'external'/'host').
       * A tag the drive system recognises (e.g. 'social', 'nourishment') lets a
       * homeostatic drive lift this ability in the competition when pressing.
       */
      tags?:          string[]
    }

/** The effector name of a declaration, whichever form it takes. */
export function effectorName( d: EffectorDeclaration ): string {
  return typeof d === 'string' ? d : d.name
}

/**
 * An Affordance — a possibility the current state affords *for this body now*,
 * with its parameters already bound from the thing that evoked it. Parameters
 * are never separated from the situation that supplies them, so there is no
 * "empty params" failure mode. Affordances are transient: the field is rebuilt
 * every tick from live perception.
 */
export interface Affordance {
  id:              string
  /** The MotorSchema this would enact. */
  schema:          string
  source:          AffordanceSource
  /** Parameters bound from the evoking context (e.g. focus text, target name). */
  parameters:      Record<string, unknown>
  /** Bound target entity id, when the schema binds an entity. */
  targetEntityId?: string
  /** Entity id of the percept / known-entity that evoked this (provenance). */
  evokedBy?:       string
  /** Anticipated affective outcome −1..1 (learned, falling back to schema prior). */
  expectedValence: number
  /** Learned value estimate 0..1 for this schema in like contexts. */
  expectedReward:  number
  /** Normalized cost 0..1 in the current body state. */
  cost:            number
  /** Proceduralization 0..1 of the underlying schema (0 = deliberate, 1 = habit). */
  habitStrength:   number
  /** Preconditions satisfied in the current state. */
  available:       boolean
  /** Schema tags, carried so selection can route drives/risk without the registry. */
  tags:            string[]
  /** The ability's declared meaning (external effectors) — what it is for. */
  description?:    string
  /**
   * Top-down planning bias 0..1 — set when an executing plan's frontier step
   * projected this affordance (source 'plan'). It lifts activation in the
   * competition WITHOUT bypassing it (the plan biases; the field still decides).
   */
  planBias?:       number
  /** Provenance: the plan whose frontier step projected this affordance. */
  planId?:         string
  /** Provenance: the frontier step id — flows through to action.outcome so the plan advances. */
  stepId?:         string
  tick:            number
}

/**
 * EfferenceCopy — the forward model's prediction of an action's own consequences,
 * emitted *before* enaction so reafference has something to compare against.
 */
export interface EfferenceCopy {
  expectedValence:       number
  expectedReward:        number
  /** Optional predicted metric deltas the schema expects to cause. */
  predictedMetricDeltas?: Record<string, number>
}

/**
 * SchemaOutcome — reafference. The actual result of an enaction paired with what
 * was predicted, yielding the prediction error that drives all learning.
 */
export interface SchemaOutcome {
  schema:         string
  affordanceId:   string
  success:        boolean
  /** Actual outcome quality 0..1. */
  outcomeQuality: number
  predicted:      EfferenceCopy
  /** |predicted − actual| — the teaching signal. */
  surprise:       number
  tick:           number
}

/**
 * LearnedSkill — the persisted competence unit. This, not the transient
 * affordance field, is what travels in the PMA and makes a grown Will *act like
 * itself* after re-embodiment.
 */
export interface LearnedSkill {
  schema:            string
  /** Proceduralization 0..1 — rises with low-error success, decays with disuse. */
  habitStrength:     number
  /** Expected reward 0..1 (EMA over outcomes). */
  valueEstimate:     number
  /** Learned default parameters for this schema. */
  paramPriors:       Record<string, unknown>
  enactments:        number
  successes:         number
  /** Rolling mean |prediction error|. */
  avgPredictionError: number
  lastEnactedTick:   number
}

/** An affordance with its computed competition activation. */
export interface ScoredAffordance {
  affordance: Affordance
  activation: number
}

/**
 * SelectionResult — the outcome of the competition. `needsDeliberation` is set
 * when the field is ambiguous (high entropy) or the stakes are high, recruiting
 * the executive (LLM); otherwise the winner is enacted directly (System 1).
 */
export interface SelectionResult {
  winner:           ScoredAffordance | null
  field:            ScoredAffordance[]
  /** 0..1 ambiguity of the competition (1 = flat field, no clear winner). */
  entropy:          number
  needsDeliberation: boolean
}

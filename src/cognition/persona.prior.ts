// ─────────────────────────────────────────────────────────────
// src/cognition/persona.prior.ts
// ─────────────────────────────────────────────────────────────

/**
 * PersonaPrior — the accommodation layer of the metacognition cycle.
 *
 * The Will's engine configuration is seeded once as immutable `engine-config-*`
 * entities (the *base*). This module adds a learned, durable *prior* layer on
 * top, so introspection can write back into the apparatus that perceives and
 * reasons without ever mutating the base:
 *
 *     effective_params = base_config ⊕ persona_prior        (additive deltas)
 *
 * Design (see METACOGNITION_CYCLE_TODO.md, Phase 2 — Option B):
 *   - The prior lives in a single `persona-prior` entity. Because entity state
 *     is the persistence path that's actually wired at boot, the prior survives
 *     restarts and replays for free — that's the whole point of choosing an
 *     entity over an engine-internal field.
 *   - The base entity is never mutated; the prior is a separate, reversible
 *     adjustment. A prior of 0 (or absent) ⇒ pure base, so the loop degrades
 *     gracefully and a persona can always decay back toward its base.
 *   - This reader is pure and deterministic (R2): same state ⇒ same effective
 *     params, no wall-clock, no RNG.
 *   - **Bounding lives in the writer, not here.** The reader applies whatever
 *     delta it finds. The Phase 3 consolidator owns the stability–plasticity
 *     policy (per-param clamp + decay) when it *produces* the deltas, because
 *     sane bounds depend on each param's scale (a 200-tick interval vs a 0.02
 *     rate).
 */

import type { ReadonlySimulationState } from '#core/types'

/** Entity id of the singleton persona-prior. */
export const PERSONA_PRIOR_ID = 'persona-prior'

/** Entity `type` discriminator for the persona-prior. */
export const PERSONA_PRIOR_TYPE = 'persona.prior'

/**
 * Shape of `persona-prior` entity metadata. `priors` maps an engine-config
 * entity id to a set of additive per-parameter deltas.
 *
 *   priors['engine-config-self-model'] = { minIntervalTicks: -40 }
 */
export interface PersonaPriorMeta {
  priors: Record<string, Record<string, number>>
  /** Monotonic write counter (observability / debugging). */
  version: number
  /** Sim tick of the last consolidation that touched the prior (R2-friendly). */
  updatedAtTick: number
}

/**
 * The additive prior deltas for one engine-config id (empty if none).
 */
export function readPersonaPrior(
  state: ReadonlySimulationState,
  engineConfigId: string
): Record<string, number> {
  const meta = state.entities.get( PERSONA_PRIOR_ID )?.metadata as PersonaPriorMeta | undefined
  return meta?.priors?.[ engineConfigId ] ?? {}
}

/**
 * Effective engine params = base `engine-config-*` params ⊕ persona-prior.
 *
 * Only numeric base params are adjusted, and only by numeric deltas; anything
 * else passes through untouched. Returns a fresh object — never mutates state.
 */
export function readEffectiveParams(
  state: ReadonlySimulationState,
  engineConfigId: string
): Record<string, number> {
  const base = ( state.entities.get( engineConfigId )?.metadata as { params?: Record<string, number> } | undefined )?.params ?? {}
  const prior = readPersonaPrior( state, engineConfigId )

  const out: Record<string, number> = { ...base }
  for( const [ key, delta ] of Object.entries( prior ) )
    if( typeof out[ key ] === 'number' && typeof delta === 'number')
      out[ key ] = out[ key ] + delta

  return out
}

/** Base (un-modulated) params for an engine-config entity, or empty. */
export function readBaseParams(
  state: ReadonlySimulationState,
  engineConfigId: string
): Record<string, number> {
  return ( state.entities.get( engineConfigId )?.metadata as { params?: Record<string, number> } | undefined )?.params ?? {}
}

/** The full persona-prior metadata, or undefined if not yet written. */
export function readPersonaPriorMeta( state: ReadonlySimulationState ): PersonaPriorMeta | undefined {
  return state.entities.get( PERSONA_PRIOR_ID )?.metadata as PersonaPriorMeta | undefined
}

/** A human-readable description of one active persona-prior adjustment. */
export interface PersonaAdjustment {
  /** `<engineConfigId>.<param>` the prior is tuning. */
  key: string
  /** First-person phrase for the executive's context (how the Will has adapted itself). */
  description: string
  /** The signed delta currently applied. */
  delta: number
}

// How each tunable reads as a first-person self-observation. `lower`/`raise`
// describe a negative/positive delta respectively (all current edges push
// negative — "do X more often / sooner / less tightly").
const PRIOR_DESCRIPTIONS: Record<string, { lower: string; raise: string }> = {
  'engine-config-self-model.minIntervalTicks':        { lower: 're-examining who I am more often',          raise: 're-examining who I am less often' },
  'engine-config-introspection.cooldownTicks':        { lower: 'introspecting more often',                  raise: 'introspecting less often' },
  'engine-config-narrator.minIntervalTicks':          { lower: 'updating my life-story more often',          raise: 'updating my life-story less often' },
  'engine-config-semantic.beliefStalenessThreshold':  { lower: 're-examining my beliefs sooner',             raise: 'holding my beliefs longer before review' },
  'engine-config-working-memory.attentionProtection': { lower: 'holding recent impressions less tightly',    raise: 'holding recent impressions more firmly' },
  'engine-config-inhibition.baseInhibitionStrength':  { lower: 'acting on impulse more freely',              raise: 'holding myself in check more firmly before acting' },
  'engine-config-self-model.minNewExperiences':       { lower: 're-evaluating who I am on less new experience', raise: 'requiring more new experience before re-evaluating who I am' },
  'engine-config-attention.shiftInertia':             { lower: 'shifting my attention more readily',         raise: 'holding my attention more fixedly' },
  'engine-config-attention.maxFoci':                  { lower: 'attending to one thing at a time, narrowly',  raise: 'keeping several things in view at once' },
  'engine-config-goal-manager.gritPriority':          { lower: 'refusing to give up on more of what matters to me', raise: 'letting go of goals more readily' },
  'engine-config-goal-manager.gritPatienceScale':     { lower: 'losing patience with stuck goals sooner',    raise: 'staying the course on hard goals far longer' },
  'engine-config-goal-manager.frustrationTolerance':  { lower: 'giving up faster when frustrated',            raise: 'holding steady through frustration' },
  'engine-config-planning.maxStepRetries':            { lower: 'giving up on stuck steps sooner',            raise: 'following through on stuck steps more doggedly' },
  'engine-config-planning.surpriseOutcomeQuality':    { lower: 'letting lower-quality results slide',         raise: 'watching my work more closely, stepping in on smaller dips' },
  'engine-config-planning.planBiasGain':              { lower: 'letting my plans be pulled off course by whatever pulls at me', raise: 'holding to my plans against distraction, pushing them through' },
  'engine-config-executive.explorationRate':          { lower: 'sticking with what I know more',              raise: 'venturing into new approaches more' },
  'engine-config-executive.impulsivity':              { lower: 'pausing to think before I act more',          raise: 'acting on impulse more readily' },
  'engine-config-executive.riskTolerance':            { lower: 'playing it safer',                            raise: 'taking bigger risks' },
  'engine-config-frustration.irritabilityRate':       { lower: 'letting frustration snowball into a bad mood more slowly', raise: 'getting wound up into a bad mood faster' },
  'engine-config-executive.deliberateThreshold':      { lower: 'stopping to think things through more readily',  raise: 'going with my gut more, deliberating less' },
  'engine-config-executive.maxFacets':                { lower: 'keeping fewer things going at once, one at a time', raise: 'holding more conversations and threads at once' },
  'engine-config-reward.socialWeight':                { lower: 'caring less about social warmth',               raise: 'finding warmth and connection more rewarding' },
  'engine-config-frustration.angerReactivity':        { lower: 'letting slights go, yielding rather than bristling', raise: 'bristling harder when I feel wronged' },
  'engine-config-novelty.significanceThreshold':      { lower: 'noticing what is new and unusual more readily',  raise: 'needing more for something to strike me as new' },
  'engine-config-aesthetic.aweThreshold':             { lower: 'being moved to wonder by beauty more easily',    raise: 'being harder to move to wonder' },
  'engine-config-threat.fearEventThreshold':          { lower: 'taking alarm more easily',                      raise: 'staying unalarmed unless a threat is real and large' },
  'engine-config-stress.baseDecayRate':               { lower: 'carrying stress for longer',                    raise: 'shedding stress and settling faster' },
  'engine-config-empathy.resonanceStrength':          { lower: 'feeling others’ emotions more faintly',         raise: 'feeling what others feel more strongly' },
  'engine-config-attachment.attachmentGrowthRate':    { lower: 'forming bonds more slowly',                     raise: 'growing attached to people more readily' },
  'engine-config-reward.goalWeight':                  { lower: 'caring less about finishing what I start',      raise: 'finding real satisfaction in completing my goals' },
  'engine-config-reputation.trustGrowthStep':         { lower: 'being slower to trust',                         raise: 'extending trust and the benefit of the doubt more readily' },
  'engine-config-task-switcher.baseSwitchCost':       { lower: 'flitting between things more easily',           raise: 'staying on one thing, harder to pull away' },
  'engine-config-action-selector.switchCost':         { lower: 'dropping what I am doing for a new pull more easily', raise: 'seeing an action through, harder to knock off course once underway' },
  'engine-config-action-selector.riskWeight':         { lower: 'weighing the downside of what I do less — acting bolder', raise: 'weighing what could go wrong more heavily before I act' },
  'engine-config-action-selector.noveltyWeight':      { lower: 'feeling less pull toward the untried',               raise: 'drawn more strongly to do the untried and unpracticed' },
  'engine-config-moral.eventThreshold':               { lower: 'holding myself to my principles more sharply',  raise: 'letting moral lapses weigh on me less' },
  'engine-config-frustration.decayRate':              { lower: 'staying frustrated for longer after a setback',  raise: 'shaking off frustration and bouncing back faster' },
  'engine-config-reward.socialWarmthBoost':           { lower: 'being warmed less by a kind exchange',          raise: 'being warmed more by every kind exchange' },
  'engine-config-reward.socialDecayRate':             { lower: 'holding the glow of connection longer',         raise: 'letting the glow of connection fade faster' },
  'engine-config-known-entity.familiarityGrowthRate': { lower: 'taking longer to feel I know someone',          raise: 'getting a feel for someone more quickly' },
  'engine-config-known-entity.curiosityGain':         { lower: 'feeling less pull to know the half-known',      raise: 'itching to get to know whoever I half-know' },
  'engine-config-known-entity.reliabilityRate':       { lower: 'being slower to revise whether I can rely on something', raise: 'quickly updating whether I can rely on something' },
}

/**
 * Summarise the active persona-prior as first-person self-observations — the
 * accommodation the Will has made to itself, surfaced so its deliberate self
 * (the executive) can see how it has been self-tuning. Empty when no prior.
 */
export function summarizePersonaPrior( state: ReadonlySimulationState ): PersonaAdjustment[] {
  const meta = readPersonaPriorMeta( state )
  if( !meta?.priors ) return []

  const out: PersonaAdjustment[] = []
  for( const [ engineConfigId, params ] of Object.entries( meta.priors ) )
    for( const [ param, delta ] of Object.entries( params ) ){
      if( !delta ) continue

      const key  = `${engineConfigId}.${param}`
      const desc = PRIOR_DESCRIPTIONS[ key ]
      const description = desc
        ? ( delta < 0 ? desc.lower : desc.raise )
        : `${key} ${delta < 0 ? 'decreased' : 'increased'}`

      out.push({ key, description, delta })
    }
    
  return out
}

// ── Write side (the consolidator's bounded mutation) ──────────

/** Below this magnitude a delta is treated as 0 (returned-to-base) and dropped. */
const EPSILON_PRIOR = 1e-6

export interface ConsolidateOpts {
  /** Cumulative |delta| cap, as a fraction of |base|. Default 0.5. */
  maxRelMagnitude?: number
  /** Per-step |delta| cap, as a fraction of |base|. Default 0.15. */
  maxRelStep?: number
  /** Multiplicative decay toward base applied to every delta each call. Default 0.98. */
  decayFactor?: number
}

/**
 * One requested adjustment to a single engine-config param. `base` is that
 * param's base value, used to scale the bounds (so one policy fits a 200-tick
 * interval and a 0.02 rate). `proposedDelta === 0` (or a 0/non-numeric base)
 * means "no push" — the decay still applies globally.
 */
export interface PriorAdjustment {
  engineConfigId: string
  param: string
  base: number
  proposedDelta: number
}

/**
 * Produce the next persona-prior from a consolidation pass (the write counterpart
 * of `readEffectiveParams`). Pure and deterministic — returns a fresh
 * `PersonaPriorMeta` for the caller to emit as a `set` command (R2-safe).
 *
 * Two stability-preserving steps (the stability–plasticity dilemma):
 *   1. **Decay** — every existing delta is multiplied toward 0 (toward base) once
 *      per pass, so a prior that stops being reinforced fades back to the seeded
 *      baseline rather than ossifying.
 *   2. **Bounded additive steps** — each adjustment's delta is clamped per-step
 *      *and* cumulatively, both relative to that param's base magnitude. A single
 *      consolidation can never lurch the persona, and no accumulated delta can
 *      exceed `maxRelMagnitude × |base|`.
 *
 * Multiple adjustments are applied in a single pass (decay once, N bounded steps,
 * one version bump) so the consolidator can close several edges per tick into one
 * coherent persona-prior. Pass `[]` for a pure decay pass.
 */
export function consolidatePrior(
  current: PersonaPriorMeta | undefined,
  adjustments: PriorAdjustment[],
  tick: number,
  opts: ConsolidateOpts = {}
): PersonaPriorMeta {
  const maxRel  = opts.maxRelMagnitude ?? 0.5
  const maxStep = opts.maxRelStep      ?? 0.15
  const decay   = opts.decayFactor     ?? 0.98

  // 1. Decay every existing delta toward base once; drop ones that fall to ~0.
  const priors: PersonaPriorMeta['priors'] = {}
  for( const [ engineId, params ] of Object.entries( current?.priors ?? {} ) ){
    const kept: Record<string, number> = {}
    for( const [ p, v ] of Object.entries( params ) ){
      const nv = v * decay
      if( Math.abs( nv ) >= EPSILON_PRIOR ) kept[ p ] = nv
    }

    if( Object.keys( kept ).length > 0 ) priors[ engineId ] = kept
  }

  // 2. Apply each bounded additive step (relative to its param's |base|).
  for( const adj of adjustments ){
    if( typeof adj.base !== 'number' || adj.base === 0 || adj.proposedDelta === 0 ) continue
    const scale    = Math.abs( adj.base )
    const step     = Math.max( -maxStep * scale, Math.min( maxStep * scale, adj.proposedDelta ) )
    const existing = priors[ adj.engineConfigId ]?.[ adj.param ] ?? 0
    const next     = Math.max( -maxRel * scale, Math.min( maxRel * scale, existing + step ) )

    const engineMap = priors[ adj.engineConfigId ] ?? ( priors[ adj.engineConfigId ] = {} )
    if( Math.abs( next ) < EPSILON_PRIOR ) delete engineMap[ adj.param ]
    else engineMap[ adj.param ] = next

    if( Object.keys( engineMap ).length === 0 )
      delete priors[ adj.engineConfigId ]
  }

  return { priors, version: ( current?.version ?? 0 ) + 1, updatedAtTick: tick }
}

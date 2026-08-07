// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/persona.consolidator.ts
// ─────────────────────────────────────────────────────────────

/**
 * PersonaConsolidator — the write-back edge of the metacognition cycle.
 *
 * This is the faculty that performs *accommodation*: it reads the Will's own
 * introspection and writes bounded, durable adjustments back into the apparatus
 * that perceives and reasons — without ever mutating the seeded base config.
 *
 * Closed loops (each: a meta signal → an apparatus param; see
 * METACOGNITION_CYCLE_TODO.md Phase 3):
 *   1. confidence.calibrated  →  self-model re-evaluation cadence (minIntervalTicks)
 *        "I keep mis-judging my confidence → re-examine who I am more often."
 *   2. bias.detected          →  introspection cadence (cooldownTicks)
 *        "I keep reasoning with bias → introspect more often."
 *   3. self_model.updated     →  narrative cadence (minIntervalTicks)
 *        "My identity shifted significantly → re-narrate my life story sooner."
 *   4. bias.detected (belief)  →  semantic belief-staleness (beliefStalenessThreshold)
 *        "I overgeneralise / confirm → let my beliefs go stale sooner for review."
 *   5. bias.detected (memory)  →  working-memory protection (attentionProtection)
 *        "I over-weight recent/vivid items → cling to them less tightly."
 *   6. bias.detected          →  inhibitory control (inhibition.baseInhibitionStrength, ↑)
 *        "My reasoning keeps mis-firing → exert more self-restraint before acting."
 *   7. introspection.insight   →  self-model evidence gate (minNewExperiences, ↓)
 *        "My introspection is productive → re-evaluate who I am on less new evidence."
 *   8. bias.detected (belief)  →  attentional fixation (attention.shiftInertia, ↓)
 *        "I keep confirming/overgeneralising → shift attention more readily to break the fixation."
 *
 * Edges 1–5 push a *faster cadence* (a negative delta on an interval/cooldown);
 * 6 *raises* a control gain, 7–8 *lower* a gate/inertia — each proportional to the
 * significance of the signal, bounded + decayed by
 * `consolidatePrior`. The equilibrium between a magnitude-proportional push and
 * the per-pass decay yields a cadence elevation proportional to how significant
 * the introspection actually is; when the signal subsides, the prior decays back
 * to the seeded baseline.
 *
 * Properties:
 *   - **Significance-gated**, not surprise-gated: these are persistent control
 *     signals, so a magnitude threshold (not a prediction-error gate) is the
 *     right notion of "significant introspection". Routine ticks only decay.
 *   - **Bounded** (stability–plasticity): all limits live in `consolidatePrior`,
 *     relative to each param's base scale.
 *   - **Deterministic (R2)**: magnitudes come from replayed bus events; the write
 *     is a pure function of (prior entity, bases, magnitudes, tick).
 *   - **Durable via entity (Option B)**: the prior is a `persona-prior` entity,
 *     so it survives restart on the wired entity-restore path. No bus / salience /
 *     generative sub-state — nothing it doesn't actually use.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent } from '#cognition/bus'
import {
  consolidatePrior,
  readBaseParams,
  readPersonaPriorMeta,
  PERSONA_PRIOR_ID,
  PERSONA_PRIOR_TYPE,
  type PriorAdjustment
} from '#cognition/persona.prior'

// ── Fixed rule parameters for the non-calibration edges ──────
// (The calibration edge's gain/threshold are constructor-configurable for
//  back-compat; these two are module constants — tunable later, but bounded by
//  consolidatePrior regardless.)
const BIAS_THRESHOLD       = 0.5    // ≥ 1 newly-surfaced bias counts as significant
const BIAS_GAIN            = -10    // cooldownTicks delta per newly-surfaced bias
const SELF_CHANGE_THRESHOLD = 0.05  // identity change magnitude floor
const SELF_CHANGE_GAIN     = -100   // narrator minIntervalTicks delta per unit change
const BELIEF_STALENESS_GAIN = -100  // semantic.beliefStalenessThreshold delta per belief-level bias
const WM_PROTECTION_GAIN    = -0.3  // working-memory.attentionProtection delta per memory-level bias
const INHIBITION_GAIN       = 0.05  // +inhibition.baseInhibitionStrength per newly-surfaced bias (more self-restraint)
const INSIGHT_THRESHOLD     = 1     // > 1 identified insights (biases + lessons) counts as a productive introspection
const INSIGHT_GAIN          = -2    // self-model.minNewExperiences delta per insight (re-evaluate on less evidence)
const ATTENTION_INERTIA_GAIN = -0.1 // -attention.shiftInertia per belief-formation bias (shift focus more readily)

// Grit develops from the self-model's demonstrated persistence/resilience (traits
// formed from the Will's own behaviour) — so grit is FORMED over time, not a constant.
const PERSISTENCE_BASELINE       = 0.5   // neutral self-model trait value
const GRIT_THRESHOLD             = 0.05  // trait-deviation floor to count as significant
const GRIT_PRIORITY_GAIN         = -0.4  // −gritPriority per unit persistence above baseline (grittier: exempt more)
const GRIT_PATIENCE_GAIN         = 2     // +gritPatienceScale per unit persistence above baseline (persist longer)
const FRUSTRATION_TOLERANCE_GAIN = 0.6   // +frustrationTolerance per unit resilience above baseline
const RESILIENCE_RECOVERY_GAIN   = 0.06  // +frustration.decayRate per unit resilience (recovers from a bad patch faster)

// Conscientiousness develops planning follow-through — the Channel A disposition the
// planning engine reads. A Will that plans/executes diligently retries stuck steps more
// before giving up, and stays more vigilant (escalates to deliberate supervision on
// smaller quality dips). Above-baseline only; decays back when the diligence stops.
const FOLLOW_THROUGH_GAIN = 4     // +maxStepRetries per unit conscientiousness above baseline
const VIGILANCE_GAIN      = 0.3   // +surpriseOutcomeQuality per unit conscientiousness (escalate sooner)
const PLAN_ASSERTIVENESS_GAIN = 0.3   // +engine-config-planning.planBiasGain per unit conscientiousness (pushes its plan harder in the action competition)

// Disposition traits develop Channel-A action tendencies the same way grit/
// conscientiousness do — formed from the self-model, above-baseline only, decaying
// back when the disposition stops being demonstrated. Each reuses PERSISTENCE_BASELINE
// (the neutral trait value) and GRIT_THRESHOLD (the deviation floor). All push their
// param *down* (the trait expresses more freely); several share a param with a bias
// driver already tuning it — noted per-rule so the two-driver composition stays auditable.
const DECISIVENESS_INHIBITION_GAIN   = -0.2  // −inhibition.baseInhibitionStrength per unit decisiveness (commit with less hesitation)
const OPENNESS_SHIFT_INERTIA_GAIN    = -0.3  // −attention.shiftInertia per unit openness (shift attention more readily)
const OPENNESS_BELIEF_STALENESS_GAIN = -150  // −semantic.beliefStalenessThreshold per unit openness (re-examine beliefs sooner)
const ANALYTICAL_INTROSPECTION_GAIN  = -30   // −introspection.cooldownTicks per unit analytical (introspect/reflect more often)

// behavioralDisposition (executive) develops the same way: PMA seeds risk/exploration/
// impulsivity onto engine-config-executive, and these layer a persona-prior on top so
// the disposition *develops* rather than staying static for the session. Exploration
// grows with openness AND creativity (two reinforcing drivers on one param — summed
// then bounded); impulsivity falls as conscientiousness (the impulse-control facet) is
// demonstrated. riskTolerance is intentionally left to Channel B (no clean single-trait
// lever). All bounded relative to each param's base by consolidatePrior.
const OPENNESS_EXPLORATION_GAIN          = 0.3   // +executive.explorationRate per unit openness (seek novelty more)
const CREATIVITY_EXPLORATION_GAIN        = 0.3   // +executive.explorationRate per unit creativity (diverge more)
const CONSCIENTIOUSNESS_IMPULSIVITY_GAIN = -0.4  // −executive.impulsivity per unit conscientiousness (more impulse control)
// Conscientiousness's achievement-striving facet — goal completion is more rewarding, so
// the Will is more motivated toward finishing what it sets out to do.
const CONSCIENTIOUSNESS_GOAL_REWARD_GAIN = 0.3   // +reward.goalWeight per unit conscientiousness (achievement-striving)
// Two more conscientiousness facets (medium tier): self-discipline of attention (less
// distractible — higher task-switch cost) and dutifulness (registers moral self-evaluation
// more readily — lower moral event threshold).
const CONSCIENTIOUSNESS_FOCUS_GAIN = 0.2    // +task-switcher.baseSwitchCost per unit conscientiousness (less distractible)
const CONSCIENTIOUSNESS_MORAL_GAIN = -0.2   // −moral.eventThreshold per unit conscientiousness (more morally self-evaluative)
// Same self-discipline-of-attention disposition, the agency selector's owner (R2): a
// conscientious Will resists having an in-flight ACTION preempted, not just its attention
// pulled. One disposition, two owners (task-switcher attention + selector action) at their
// native scales — see the selector's effectiveSwitchCost. Lower gain to match the smaller base.
const CONSCIENTIOUSNESS_SELECTOR_FOCUS_GAIN = 0.1  // +action-selector.switchCost per unit conscientiousness (resists action-interruption)

// Attentional BREADTH — how many focused facets this mind holds at once
// (engine-config-executive.maxFacets, the FacetSupervisor's ceiling). Two opposing
// dispositional pulls on one param, the pattern rules 17/17b already use: an open
// mind spreads itself across more at once, a conscientious one narrows to fewer and
// sees them through. Scaled against a base of 10, so a strongly-expressed trait moves
// the ceiling by a few threads, not by an order of magnitude — and consolidatePrior's
// per-step and cumulative caps bound it regardless.
const OPENNESS_BREADTH_GAIN          = 4    // +executive.maxFacets per unit openness (hold more at once)
const CONSCIENTIOUSNESS_BREADTH_GAIN = -3   // −executive.maxFacets per unit conscientiousness (fewer, seen through)

// The same breadth disposition at the ATTENDING level — how many things the mind
// holds in view at once (engine-config-attention.maxFoci, the allocator's slot cap),
// as opposed to how many threads it keeps open (maxFacets above). One disposition,
// two owners — rules 28/28b's pattern. Scaled against a base of 4, so the same trait
// moves both levels proportionally rather than pulling them apart.
const OPENNESS_FOCI_GAIN             = 1.5  // +attention.maxFoci per unit openness
const CONSCIENTIOUSNESS_FOCI_GAIN    = -1.2 // −attention.maxFoci per unit conscientiousness

// How long the Will sits with something it has already said before saying it again
// (action-selector.repeatDamping, EXAFFERENCE P5). Agreeableness gives people room;
// demonstrated persistence chases the answer. Scaled against a base of 0.30.
const AGREEABLENESS_PATIENCE_GAIN    = 0.12  // +repeatDamping per unit agreeableness
const PERSISTENCE_FOLLOWUP_GAIN      = -0.10 // −repeatDamping per unit persistence
// The same disposition on the WINDOW rather than the strength: how long what it
// said stands before coming back to it. Scaled against a base of 60 ticks.
const AGREEABLENESS_WINDOW_GAIN      = 24   // +repeatWindowTicks per unit agreeableness
const PERSISTENCE_WINDOW_GAIN        = -20  // −repeatWindowTicks per unit persistence
// Who the mind is drawn toward. Agreeableness leans into reciprocity (toward the
// people who answer); demonstrated persistence leans the other way, and can carry
// this SIGNED weight negative — a mind that reaches hardest for the silence.
const AGREEABLENESS_RECIPROCITY_GAIN = 0.12  // +action-selector.socialWeight per unit agreeableness
const PERSISTENCE_RECIPROCITY_GAIN   = -0.14 // −action-selector.socialWeight per unit persistence

// Emotional stability (formed from observed affect dynamics, not task success) develops
// the affect *reactivity gain* down: a steadier Will lets frustration snowball into
// chronic irritability more slowly. Distinct axis from resilience — resilience tunes how
// much frustration is *tolerated* (frustrationTolerance), stability how fast it *builds*.
const EMOTIONAL_STABILITY_REACTIVITY_GAIN = -0.01  // −frustration.irritabilityRate per unit emotional-stability (slower build)
// Emotional stability also governs the threat/stress response: a steadier Will is less
// easily alarmed (higher fear threshold) and sheds stress faster (higher decay). Distinct
// faculties from the frustration build-rate above — the same trait across the affect system.
const EMOTIONAL_STABILITY_THREAT_GAIN       = 0.3   // +threat.fearEventThreshold per unit stability (harder to alarm)
const EMOTIONAL_STABILITY_STRESS_DECAY_GAIN = 0.6   // +stress.baseDecayRate per unit stability (sheds stress faster)

// Analytical disposition develops the master's dual-process effort gate: a thinker
// engages System 2 (deliberate propose→evaluate) more readily. Effort allocation itself
// becomes a developing trait — the capstone that ties dual-process into the persona
// system. Pushes the threshold DOWN (deliberate sooner); bounded/decaying like the rest.
const ANALYTICAL_DELIBERATION_GAIN = -0.4  // −executive.deliberateThreshold per unit analytical (deliberate more readily)
// Decisiveness is the opposing pull on the SAME dual-process threshold: a decisive Will
// commits on thinner evidence — engages System 2 LESS readily. Shares the param with the
// analytical driver above (rule 17); the two compose into one net, bounded/decaying delta.
// Because R1 made the agency selector a second consumer of this threshold, this single rule
// develops "acts on thinner margins" in BOTH reasoning and action selection at once.
const DECISIVENESS_DELIBERATION_GAIN = 0.3  // +executive.deliberateThreshold per unit decisiveness (commit on thinner evidence)

// Agreeableness develops how much the Will values social warmth: an agreeable Will finds
// connection more rewarding, so positive interaction counts for more in its reward signal.
// A real Channel-A lever (not Channel B) — it shapes what the Will is motivated toward and
// feels good about, beneath deliberation. The reward engine already reads socialWeight as
// base ⊕ persona-prior; this just develops it from the demonstrated `agreeableness` trait.
const AGREEABLENESS_SOCIAL_GAIN = 0.3  // +reward.socialWeight per unit agreeableness (values warmth/connection more)
// Agreeableness's second, distinct facet — yielding in conflict. An agreeable Will, when
// wronged, accommodates rather than retaliates, so provocation turns into anger less
// strongly. (Warmth = approach/connection via socialWeight; this = low antagonism.)
const AGREEABLENESS_YIELDING_GAIN = -0.4  // −frustration.angerReactivity per unit agreeableness (yields rather than retaliates)
// Further agreeableness facets across the social system: tender-mindedness (empathy
// resonance) and altruism/bonding (attachment growth). Distinct faculties from warmth
// (reward.socialWeight) and yielding (frustration.angerReactivity).
const AGREEABLENESS_EMPATHY_GAIN    = 0.3   // +empathy.resonanceStrength per unit agreeableness (feels others more)
const AGREEABLENESS_ATTACHMENT_GAIN = 0.03  // +attachment.attachmentGrowthRate per unit agreeableness (bonds more readily)
const AGREEABLENESS_TRUST_GAIN      = 0.04  // +reputation.trustGrowthStep per unit agreeableness (extends trust more readily)
// Warmth intensity/persistence — an agreeable Will is warmed MORE by each positive
// interaction and the warmth LINGERS (slower decay). Distinct from socialWeight (#6, how
// much social reward counts in the total) — this is how strongly/long it registers.
const AGREEABLENESS_WARMTH_BOOST_GAIN  = 0.3    // +reward.socialWarmthBoost per unit agreeableness (each interaction warms more)
const AGREEABLENESS_WARMTH_LINGER_GAIN = -0.01  // −reward.socialDecayRate per unit agreeableness (warmth lingers)

// Known-entity dispositions (how the Will comes to know someone/something develops). An
// open Will grows familiar faster and feels the pull-to-know the half-known more readily;
// an analytical Will revises its reliability (track-record) judgments more responsively.
const OPENNESS_FAMILIARITY_GAIN  = 0.1   // +known-entity.familiarityGrowthRate per unit openness (forms a sense of others faster)
const OPENNESS_CURIOSITY_GAIN    = 0.6   // +known-entity.curiosityGain per unit openness (feels the pull-to-know more readily)
const ANALYTICAL_RELIABILITY_GAIN = 0.2  // +known-entity.reliabilityRate per unit analytical (updates track-record judgments faster)

// Openness governs perceptual/aesthetic sensitivity: an open Will registers novelty more
// readily and is moved to awe by beauty more easily. Both are *lower threshold* levers,
// developed from the same `openness` trait that already drives attention/semantic/exploration
// — distinct faculties it genuinely governs (openness is a broad trait by nature).
const OPENNESS_NOVELTY_SENSITIVITY_GAIN = -0.3  // −novelty.significanceThreshold per unit openness (notices novelty more readily)
const OPENNESS_AWE_SENSITIVITY_GAIN     = -0.4  // −aesthetic.aweThreshold per unit openness (moved to awe more easily)

// Agency competition weights (Channel A): the selector's risk/novelty weights develop from
// disposition. A steadier Will weighs the downside of an action less (bolder); an open Will
// weighs novelty more (curiosity pulls toward the unpracticed). The selector reads these
// back via readEffectiveParams (base ⊕ prior). Distinct faculties from the perceptual
// novelty/threat thresholds above — these tune what *wins the action competition*.
const EMOTIONAL_STABILITY_RISK_GAIN  = -0.4  // −action-selector.riskWeight per unit stability (bolder action)
const OPENNESS_NOVELTY_WEIGHT_GAIN   = 0.4   // +action-selector.noveltyWeight per unit openness (curiosity in action)

// Detected-bias categories → which faculty self-corrects. Belief-formation biases
// prompt re-examining beliefs sooner; memory-weighting biases prompt loosening how
// hard attention clings to recent/vivid items.
const BELIEF_BIAS_TYPES = new Set([ 'overgeneralization', 'confirmation_bias' ])
const MEMORY_BIAS_TYPES = new Set([ 'recency_bias', 'availability_bias' ])

export interface PersonaConsolidatorConfig {
  /** Ticks between consolidation passes. Default 100. */
  intervalTicks?: number
  /** |calibrationBias| at/below this counts as well-calibrated → no push. Default 0.05. */
  significanceThreshold?: number
  /** Self-model cadence delta per unit |bias| (clamped by consolidatePrior). Default 400. */
  cadenceGain?: number
}

export class PersonaConsolidator implements SimulationEngine, CognitiveEngine {
  readonly name = 'persona-consolidator'

  private _intervalTicks: number
  private _significanceThreshold: number
  private _cadenceGain: number

  private _lastConsolidationTick = 0

  // Latest introspection magnitudes captured from the bus (persist between passes).
  private _latestCalibrationBias  = 0
  private _latestBiasNovelty      = 0
  private _latestBeliefBiasNovelty = 0
  private _latestMemoryBiasNovelty = 0
  private _latestSelfModelChange  = 0
  private _latestInsightSignificance = 0

  constructor( config: PersonaConsolidatorConfig = {} ){
    this._intervalTicks         = config.intervalTicks         ?? 100
    this._significanceThreshold = config.significanceThreshold ?? 0.05
    this._cadenceGain           = config.cadenceGain           ?? 400
  }

  subscribes(): string[] {
    return [
      'confidence.calibrated',
      'bias.detected',
      'self_model.updated',
      'introspection.insight'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    switch( e.type ){
      case 'confidence.calibrated': {
        const p = e.payload as { calibrationBias?: number }
        if( typeof p.calibrationBias === 'number') this._latestCalibrationBias = p.calibrationBias
        break
      }
      case 'bias.detected': {
        const p = e.payload as { newCount?: number; types?: string[] }
        if( typeof p.newCount === 'number') this._latestBiasNovelty = p.newCount
        const types = Array.isArray( p.types ) ? p.types : []
        this._latestBeliefBiasNovelty = types.filter( t => BELIEF_BIAS_TYPES.has( t ) ).length
        this._latestMemoryBiasNovelty = types.filter( t => MEMORY_BIAS_TYPES.has( t ) ).length
        break
      }
      case 'self_model.updated': {
        const p = e.payload as { changeMagnitude?: number }
        if( typeof p.changeMagnitude === 'number') this._latestSelfModelChange = p.changeMagnitude
        break
      }
      case 'introspection.insight': {
        // significance = how substantive this introspection was (biases + lessons surfaced).
        const p = e.payload as { significance?: number }
        if( typeof p.significance === 'number') this._latestInsightSignificance = p.significance
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      lastConsolidationTick:  this._lastConsolidationTick,
      latestCalibrationBias:  this._latestCalibrationBias,
      latestBiasNovelty:      this._latestBiasNovelty,
      latestBeliefBiasNovelty: this._latestBeliefBiasNovelty,
      latestMemoryBiasNovelty: this._latestMemoryBiasNovelty,
      latestSelfModelChange:  this._latestSelfModelChange,
      latestInsightSignificance: this._latestInsightSignificance,
    }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return
    if( typeof snap.lastConsolidationTick  === 'number') this._lastConsolidationTick  = snap.lastConsolidationTick
    if( typeof snap.latestCalibrationBias  === 'number') this._latestCalibrationBias  = snap.latestCalibrationBias
    if( typeof snap.latestBiasNovelty      === 'number') this._latestBiasNovelty      = snap.latestBiasNovelty
    if( typeof snap.latestBeliefBiasNovelty === 'number') this._latestBeliefBiasNovelty = snap.latestBeliefBiasNovelty
    if( typeof snap.latestMemoryBiasNovelty === 'number') this._latestMemoryBiasNovelty = snap.latestMemoryBiasNovelty
    if( typeof snap.latestSelfModelChange  === 'number') this._latestSelfModelChange  = snap.latestSelfModelChange
    if( typeof snap.latestInsightSignificance === 'number') this._latestInsightSignificance = snap.latestInsightSignificance
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<EngineResult> {
    const commands: StateCommands = { set: [], metrics: [] }

    if( tick - this._lastConsolidationTick < this._intervalTicks )
      return { commands }

    this._lastConsolidationTick = tick

    const adjustments = this._proposedAdjustments( state )
    const current     = readPersonaPriorMeta( state )
    const next        = consolidatePrior( current, adjustments, tick )

    // Persist the prior only while it carries an adjustment (or to clear one that
    // just decayed away) — avoid writing an empty entity on every idle pass.
    const hadPrior = !!current && Object.keys( current.priors ?? {} ).length > 0
    const hasPrior = Object.keys( next.priors ).length > 0
    if( hasPrior || hadPrior )
      commands.set!.push({
        id: PERSONA_PRIOR_ID,
        type: PERSONA_PRIOR_TYPE,
        metadata: { priors: next.priors, version: next.version, updatedAtTick: next.updatedAtTick },
      })

    commands.metrics!.push(
      [ 'persona.prior.version', next.version ],
      [ 'persona.self_model.min_interval_delta', next.priors[ 'engine-config-self-model' ]?.minIntervalTicks ?? 0 ],
      [ 'persona.introspection.cooldown_delta',  next.priors[ 'engine-config-introspection' ]?.cooldownTicks ?? 0 ],
      [ 'persona.narrator.min_interval_delta',   next.priors[ 'engine-config-narrator' ]?.minIntervalTicks ?? 0 ],
      [ 'persona.semantic.belief_staleness_delta', next.priors[ 'engine-config-semantic' ]?.beliefStalenessThreshold ?? 0 ],
      [ 'persona.working_memory.attn_protection_delta', next.priors[ 'engine-config-working-memory' ]?.attentionProtection ?? 0 ],
      [ 'persona.inhibition.strength_delta',     next.priors[ 'engine-config-inhibition' ]?.baseInhibitionStrength ?? 0 ],
      [ 'persona.self_model.min_experiences_delta', next.priors[ 'engine-config-self-model' ]?.minNewExperiences ?? 0 ],
      [ 'persona.attention.shift_inertia_delta', next.priors[ 'engine-config-attention' ]?.shiftInertia ?? 0 ],
      [ 'persona.goal_manager.grit_priority_delta', next.priors[ 'engine-config-goal-manager' ]?.gritPriority ?? 0 ],
      [ 'persona.planning.follow_through_delta', next.priors[ 'engine-config-planning' ]?.maxStepRetries ?? 0 ],
      [ 'persona.executive.exploration_delta',   next.priors[ 'engine-config-executive' ]?.explorationRate ?? 0 ],
      [ 'persona.executive.impulsivity_delta',   next.priors[ 'engine-config-executive' ]?.impulsivity ?? 0 ],
      [ 'persona.frustration.irritability_rate_delta', next.priors[ 'engine-config-frustration' ]?.irritabilityRate ?? 0 ],
      [ 'persona.executive.deliberate_threshold_delta', next.priors[ 'engine-config-executive' ]?.deliberateThreshold ?? 0 ],
      [ 'persona.executive.max_facets_delta',     next.priors[ 'engine-config-executive' ]?.maxFacets ?? 0 ],
      [ 'persona.attention.max_foci_delta',       next.priors[ 'engine-config-attention' ]?.maxFoci ?? 0 ],
      [ 'persona.selector.repeat_damping_delta',  next.priors[ 'engine-config-action-selector' ]?.repeatDamping ?? 0 ],
      [ 'persona.selector.repeat_window_delta',   next.priors[ 'engine-config-action-selector' ]?.repeatWindowTicks ?? 0 ],
      [ 'persona.selector.social_weight_delta',   next.priors[ 'engine-config-action-selector' ]?.socialWeight ?? 0 ],
      [ 'persona.reward.social_weight_delta', next.priors[ 'engine-config-reward' ]?.socialWeight ?? 0 ],
      [ 'persona.frustration.anger_reactivity_delta', next.priors[ 'engine-config-frustration' ]?.angerReactivity ?? 0 ],
      [ 'persona.novelty.significance_threshold_delta', next.priors[ 'engine-config-novelty' ]?.significanceThreshold ?? 0 ],
      [ 'persona.aesthetic.awe_threshold_delta', next.priors[ 'engine-config-aesthetic' ]?.aweThreshold ?? 0 ],
      [ 'persona.threat.fear_threshold_delta', next.priors[ 'engine-config-threat' ]?.fearEventThreshold ?? 0 ],
      [ 'persona.stress.decay_rate_delta', next.priors[ 'engine-config-stress' ]?.baseDecayRate ?? 0 ],
      [ 'persona.empathy.resonance_delta', next.priors[ 'engine-config-empathy' ]?.resonanceStrength ?? 0 ],
      [ 'persona.attachment.growth_rate_delta', next.priors[ 'engine-config-attachment' ]?.attachmentGrowthRate ?? 0 ],
      [ 'persona.reward.goal_weight_delta', next.priors[ 'engine-config-reward' ]?.goalWeight ?? 0 ],
      [ 'persona.reputation.trust_step_delta', next.priors[ 'engine-config-reputation' ]?.trustGrowthStep ?? 0 ],
      [ 'persona.reward.warmth_boost_delta', next.priors[ 'engine-config-reward' ]?.socialWarmthBoost ?? 0 ],
      [ 'persona.reward.warmth_linger_delta', next.priors[ 'engine-config-reward' ]?.socialDecayRate ?? 0 ],
      [ 'persona.known_entity.familiarity_delta', next.priors[ 'engine-config-known-entity' ]?.familiarityGrowthRate ?? 0 ],
      [ 'persona.known_entity.curiosity_delta', next.priors[ 'engine-config-known-entity' ]?.curiosityGain ?? 0 ],
      [ 'persona.known_entity.reliability_delta', next.priors[ 'engine-config-known-entity' ]?.reliabilityRate ?? 0 ],
      [ 'persona.task_switcher.switch_cost_delta', next.priors[ 'engine-config-task-switcher' ]?.baseSwitchCost ?? 0 ],
      [ 'persona.action_selector.switch_cost_delta', next.priors[ 'engine-config-action-selector' ]?.switchCost ?? 0 ],
      [ 'persona.action_selector.risk_weight_delta', next.priors[ 'engine-config-action-selector' ]?.riskWeight ?? 0 ],
      [ 'persona.action_selector.novelty_weight_delta', next.priors[ 'engine-config-action-selector' ]?.noveltyWeight ?? 0 ],
      [ 'persona.moral.event_threshold_delta', next.priors[ 'engine-config-moral' ]?.eventThreshold ?? 0 ],
      [ 'persona.frustration.decay_rate_delta', next.priors[ 'engine-config-frustration' ]?.decayRate ?? 0 ],
    )

    return { commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Build one bounded adjustment per consolidation rule. A rule contributes a
   * push only when its signal is significant; otherwise its proposedDelta is 0
   * and consolidatePrior just lets that param's existing prior decay.
   */
  private _proposedAdjustments( state: ReadonlySimulationState ): PriorAdjustment[] {
    // Self-model traits (developed from the Will's own behaviour) that shape grit.
    // Above-baseline deviation only — pushes grit up when persistence is demonstrated;
    // decay returns to the seeded baseline when the behaviour stops.
    const traits     = ( state.entities.get('identity-self')?.metadata?.traits ?? {} ) as Record<string, number>
    const persistDev = Math.max( 0, ( traits[ 'persistence' ] ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const resilDev   = Math.max( 0, ( traits[ 'resilience' ]  ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const conscDev   = Math.max( 0, ( traits[ 'conscientiousness' ] ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const decisiveDev = Math.max( 0, ( traits[ 'decisiveness' ] ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const openDev     = Math.max( 0, ( traits[ 'openness' ]     ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const analyticDev = Math.max( 0, ( traits[ 'analytical' ]   ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const agreeableDev = Math.max( 0, ( traits[ 'agreeableness' ] ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const creatDev    = Math.max( 0, ( traits[ 'creativity' ]   ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )
    const stabilityDev = Math.max( 0, ( traits[ 'emotional-stability' ] ?? PERSISTENCE_BASELINE ) - PERSISTENCE_BASELINE )

    const rules: Array<{ magnitude: number; threshold: number; gain: number; engineConfigId: string; param: string }> = [
      // 1. Mis-calibration → re-evaluate the self-model more often.
      {
        magnitude: Math.abs( this._latestCalibrationBias ),
        threshold: this._significanceThreshold,
        gain: -this._cadenceGain,
        engineConfigId: 'engine-config-self-model',
        param: 'minIntervalTicks'
      },
      // 2. Recurring bias → introspect more often.
      {
        magnitude: this._latestBiasNovelty,
        threshold: BIAS_THRESHOLD,
        gain: BIAS_GAIN,
        engineConfigId: 'engine-config-introspection',
        param: 'cooldownTicks'
      },
      // 3. Significant identity change → re-narrate sooner.
      {
        magnitude: this._latestSelfModelChange,
        threshold: SELF_CHANGE_THRESHOLD,
        gain: SELF_CHANGE_GAIN,
        engineConfigId: 'engine-config-narrator',
        param: 'minIntervalTicks'
      },
      // 4. Belief-formation bias (overgeneralization / confirmation) → let beliefs
      //    go stale sooner so they get re-examined.
      {
        magnitude: this._latestBeliefBiasNovelty,
        threshold: BIAS_THRESHOLD,
        gain: BELIEF_STALENESS_GAIN,
        engineConfigId: 'engine-config-semantic',
        param: 'beliefStalenessThreshold'
      },
      // 5. Memory-weighting bias (recency / availability) → loosen attention
      //    protection so over-weighted recent/vivid items aren't clung to.
      {
        magnitude: this._latestMemoryBiasNovelty,
        threshold: BIAS_THRESHOLD,
        gain: WM_PROTECTION_GAIN,
        engineConfigId: 'engine-config-working-memory',
        param: 'attentionProtection'
      },
      // 6. Recurring bias → raise inhibitory control: exert more self-restraint
      //    before acting while reasoning is demonstrably mis-firing. (Same signal
      //    as edge 2, a *different* response — reflection vs. behavioural caution.)
      {
        magnitude: this._latestBiasNovelty,
        threshold: BIAS_THRESHOLD,
        gain: INHIBITION_GAIN,
        engineConfigId: 'engine-config-inhibition',
        param: 'baseInhibitionStrength'
      },
      // 7. Productive introspection → re-evaluate the self-model on *less* new
      //    evidence (a different gate than edge 1's time interval).
      {
        magnitude: this._latestInsightSignificance,
        threshold: INSIGHT_THRESHOLD,
        gain: INSIGHT_GAIN,
        engineConfigId: 'engine-config-self-model',
        param: 'minNewExperiences'
      },
      // 8. Belief-formation bias (confirmation / overgeneralization) is fixation →
      //    lower attentional inertia so focus shifts more readily, loosening the
      //    fixation that feeds it. (Complements edge 4 at the attentional level.)
      {
        magnitude: this._latestBeliefBiasNovelty,
        threshold: BIAS_THRESHOLD,
        gain: ATTENTION_INERTIA_GAIN,
        engineConfigId: 'engine-config-attention',
        param: 'shiftInertia'
      },
      // 9. Demonstrated persistence → grittier goal-pursuit: refuse to give up on
      //    more of what matters (lower gritPriority) and persist longer (raise scale).
      {
        magnitude: persistDev,
        threshold: GRIT_THRESHOLD,
        gain: GRIT_PRIORITY_GAIN,
        engineConfigId: 'engine-config-goal-manager',
        param: 'gritPriority'
      },
      {
        magnitude: persistDev,
        threshold: GRIT_THRESHOLD,
        gain: GRIT_PATIENCE_GAIN,
        engineConfigId: 'engine-config-goal-manager',
        param: 'gritPatienceScale'
      },
      // 10. Demonstrated resilience (coping through adversity) → higher frustration
      //     tolerance: don't give up faster just because frustrated.
      {
        magnitude: resilDev,
        threshold: GRIT_THRESHOLD,
        gain: FRUSTRATION_TOLERANCE_GAIN,
        engineConfigId: 'engine-config-goal-manager',
        param: 'frustrationTolerance'
      },
      // 11. Demonstrated conscientiousness → planning follow-through (Channel A in the
      //     planning engine): retry stuck steps more before giving up, and stay more
      //     vigilant — escalate to deliberate supervision on smaller quality dips.
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: FOLLOW_THROUGH_GAIN,
        engineConfigId: 'engine-config-planning',
        param: 'maxStepRetries'
      },
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: VIGILANCE_GAIN,
        engineConfigId: 'engine-config-planning',
        param: 'surpriseOutcomeQuality'
      },
      // Conscientiousness also makes the Will assert its PLANS harder in the one action
      // competition (planning-as-prior): it pushes a plan's frontier against competing
      // impulses rather than letting whatever's salient pull it off course. Same
      // disposition family as the selector's switch-cost (rule 28b) — seeing things
      // through — but on the top-down plan-bias lever.
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: PLAN_ASSERTIVENESS_GAIN,
        engineConfigId: 'engine-config-planning',
        param: 'planBiasGain'
      },
      // 12. Demonstrated decisiveness → commit to actions with less hesitation: lower
      //     baseline inhibition. Shares the param with the bias-caution driver (rule 6,
      //     which *raises* it on recurring bias) — an opposing dispositional pull; both
      //     bounded/decaying, so they compose into a single auditable net delta.
      {
        magnitude: decisiveDev,
        threshold: GRIT_THRESHOLD,
        gain: DECISIVENESS_INHIBITION_GAIN,
        engineConfigId: 'engine-config-inhibition',
        param: 'baseInhibitionStrength'
      },
      // 13. Demonstrated openness → engage novelty more readily: shift attention with
      //     less inertia and re-examine beliefs sooner. Both params also carry a
      //     belief-bias driver (rules 8 & 4) pushing the *same* direction — openness
      //     reinforces it dispositionally; additive and bounded.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_SHIFT_INERTIA_GAIN,
        engineConfigId: 'engine-config-attention',
        param: 'shiftInertia'
      },
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_BELIEF_STALENESS_GAIN,
        engineConfigId: 'engine-config-semantic',
        param: 'beliefStalenessThreshold'
      },
      // 14. Demonstrated analytical disposition → reflect more often: shorten the
      //     introspection cooldown. Shares the param with the recurring-bias driver
      //     (rule 2, same direction) — analytical adds a steady dispositional pull on
      //     top of the event-driven one; both bounded/decaying.
      {
        magnitude: analyticDev,
        threshold: GRIT_THRESHOLD,
        gain: ANALYTICAL_INTROSPECTION_GAIN,
        engineConfigId: 'engine-config-introspection',
        param: 'cooldownTicks'
      },
      // 15. behavioralDisposition (executive) — develop what PMA seeded, instead of it
      //     staying static for the session. Openness + creativity both push exploration
      //     up (two reinforcing drivers on the same param — consolidatePrior accumulates
      //     them, each step-bounded, total cumulatively-bounded). Conscientiousness pulls
      //     impulsivity down (impulse control). riskTolerance is left to Channel B. The
      //     executive reads these back via readEffectiveParams (base ⊕ prior).
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_EXPLORATION_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'explorationRate'
      },
      {
        magnitude: creatDev,
        threshold: GRIT_THRESHOLD,
        gain: CREATIVITY_EXPLORATION_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'explorationRate'
      },
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_IMPULSIVITY_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'impulsivity'
      },
      // 16. Demonstrated emotional stability (steady affect over time) → frustration
      //     snowballs into chronic irritability more slowly (lower build-rate). A
      //     reactivity-gain lever, distinct from resilience's frustrationTolerance
      //     (rule 10, how much is *tolerated*). The trait forms from observed affect, so
      //     this closes a bounded self-regulation loop: steadier ⇒ slower build ⇒ steadier.
      {
        magnitude: stabilityDev,
        threshold: GRIT_THRESHOLD,
        gain: EMOTIONAL_STABILITY_REACTIVITY_GAIN,
        engineConfigId: 'engine-config-frustration',
        param: 'irritabilityRate'
      },
      // 17. Demonstrated analytical disposition → engage System 2 (deliberate) more
      //     readily: lower the master's dual-process effort-gate threshold. This makes
      //     effort allocation itself a developing trait — a thinker deliberates sooner —
      //     the capstone tying the executive's dual-process control into the persona
      //     system. Read back as the effective threshold in ExecutiveEngine.reasonAsync.
      {
        magnitude: analyticDev,
        threshold: GRIT_THRESHOLD,
        gain: ANALYTICAL_DELIBERATION_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'deliberateThreshold'
      },
      // 17b. Decisiveness — the opposing pull on the SAME deliberateThreshold (rule 17): a
      //      decisive Will commits on thinner evidence, engaging System 2 LESS readily. Since
      //      R1 made the agency selector a second consumer of this threshold, this one rule
      //      develops "acts on thinner margins" across BOTH reasoning and action at once.
      {
        magnitude: decisiveDev,
        threshold: GRIT_THRESHOLD,
        gain: DECISIVENESS_DELIBERATION_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'deliberateThreshold'
      },
      // 18. Demonstrated agreeableness (warm, cooperative, helpful behaviour) → value
      //     social warmth more: raise how much positive interaction counts in the reward
      //     signal. A real Channel-A social-stance lever — it shapes what the Will is
      //     motivated toward and feels good about, beneath deliberation, rather than
      //     leaving warmth purely to in-character (Channel B) phrasing. Bounded/decaying.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_SOCIAL_GAIN,
        engineConfigId: 'engine-config-reward',
        param: 'socialWeight'
      },
      // 19. Demonstrated agreeableness, second facet — yielding in conflict. Develops the
      //     frustration engine's anger reactivity DOWN: wronged, the Will accommodates
      //     rather than retaliates (provocation turns into anger less strongly). Distinct
      //     from rule 18's warmth (reward.socialWeight) — same trait, two facets
      //     (approach/connection vs. low antagonism). Bounded/decaying.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_YIELDING_GAIN,
        engineConfigId: 'engine-config-frustration',
        param: 'angerReactivity'
      },
      // 20. Demonstrated openness → register novelty more readily: lower the novelty
      //     detector's significance threshold. Perceptual sensitivity facet of openness.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_NOVELTY_SENSITIVITY_GAIN,
        engineConfigId: 'engine-config-novelty',
        param: 'significanceThreshold'
      },
      // 21. Demonstrated openness → moved to awe more easily: lower the aesthetic
      //     evaluator's awe threshold. Aesthetic-sensitivity facet of openness.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_AWE_SENSITIVITY_GAIN,
        engineConfigId: 'engine-config-aesthetic',
        param: 'aweThreshold'
      },
      // 22. Demonstrated emotional stability → harder to alarm: raise the threat engine's
      //     significant-fear threshold (needs more threat to fire). Threat-reactivity facet.
      {
        magnitude: stabilityDev,
        threshold: GRIT_THRESHOLD,
        gain: EMOTIONAL_STABILITY_THREAT_GAIN,
        engineConfigId: 'engine-config-threat',
        param: 'fearEventThreshold'
      },
      // 23. Demonstrated emotional stability → sheds stress faster: raise the stress
      //     engine's base decay rate. Recovery facet (pairs with #5's slower build-rate).
      {
        magnitude: stabilityDev,
        threshold: GRIT_THRESHOLD,
        gain: EMOTIONAL_STABILITY_STRESS_DECAY_GAIN,
        engineConfigId: 'engine-config-stress',
        param: 'baseDecayRate'
      },
      // 24. Demonstrated agreeableness → feels others more: raise empathic resonance.
      //     Tender-mindedness facet (distinct from warmth/yielding).
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_EMPATHY_GAIN,
        engineConfigId: 'engine-config-empathy',
        param: 'resonanceStrength'
      },
      // 25. Demonstrated agreeableness → bonds more readily: raise attachment growth rate.
      //     Altruism/bonding facet.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_ATTACHMENT_GAIN,
        engineConfigId: 'engine-config-attachment',
        param: 'attachmentGrowthRate'
      },
      // 26. Demonstrated conscientiousness → goal completion is more rewarding: raise the
      //     reward engine's goalWeight. Achievement-striving facet (distinct from planning
      //     follow-through, rule 11, and impulse control, rule 15c).
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_GOAL_REWARD_GAIN,
        engineConfigId: 'engine-config-reward',
        param: 'goalWeight'
      },
      // 27. Demonstrated agreeableness → extends trust more readily: raise how much a
      //     cooperative interaction credits another agent's cooperativeness. Trust facet
      //     (the Will's disposition to assume good faith, applied to its model of others).
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_TRUST_GAIN,
        engineConfigId: 'engine-config-reputation',
        param: 'trustGrowthStep'
      },
      // 28. Demonstrated conscientiousness → less distractible: raise the task-switcher's
      //     base switch cost, so the Will stays on task more. Self-discipline-of-attention
      //     facet (distinct from planning follow-through / impulse control / goal reward).
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_FOCUS_GAIN,
        engineConfigId: 'engine-config-task-switcher',
        param: 'baseSwitchCost'
      },
      // 27c. Attentional BREADTH — how many things this mind holds at once (the
      //      FacetSupervisor's facet ceiling). Openness widens it; conscientiousness
      //      narrows it. Two opposing pulls on one param (rules 17/17b's pattern), so a
      //      Will that is both lands somewhere of its own rather than at either extreme.
      //      This is what makes "I can hold five conversations" or "I do one thing at a
      //      time" a fact about the person instead of a constant — the ceiling is the
      //      persona's; spare attention only scales the live allowance within it.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_BREADTH_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'maxFacets'
      },
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_BREADTH_GAIN,
        engineConfigId: 'engine-config-executive',
        param: 'maxFacets'
      },
      // 27d. The same breadth disposition one level down: how many things the mind
      //      holds IN VIEW at once (the allocator's `maxFoci` slots), as against how
      //      many threads it keeps OPEN (27c). A reasoning facet now competes for
      //      these slots like any percept, so the two levels are one economy — a Will
      //      can be in ten conversations while attending to two, and which two is
      //      settled by salience against everything else it could be noticing.
      //      `maxFoci` was already config-mirrored and read through the persona-prior;
      //      it just had no description and no edge, so it could never actually move.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_FOCI_GAIN,
        engineConfigId: 'engine-config-attention',
        param: 'maxFoci'
      },
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_FOCI_GAIN,
        engineConfigId: 'engine-config-attention',
        param: 'maxFoci'
      },
      // 27e. How long the Will lets its own words stand before repeating them. A
      //      delivered act leaves a live footprint (EXAFFERENCE P5) that damps redoing
      //      it; how HARD it damps is a disposition. An agreeable Will gives people
      //      room after saying its piece; a persistent one chases the answer sooner.
      //      Opposing pulls on one param, same as 17/17b. This is the trait behind
      //      "she messaged me the same thing three times" — the mechanism stops the
      //      loop, this decides where in the range between patient and dogged she sits.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_PATIENCE_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'repeatDamping'
      },
      {
        magnitude: persistDev,
        threshold: GRIT_THRESHOLD,
        gain: PERSISTENCE_FOLLOWUP_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'repeatDamping'
      },
      // 27f. The same patience on the satiation WINDOW rather than its strength —
      //      27e decides how hard having spoken damps speaking again, this decides
      //      for how long. Kept separate because a mind can be quick to repeat but
      //      only briefly, or slow to repeat but for a long time.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_WINDOW_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'repeatWindowTicks'
      },
      {
        magnitude: persistDev,
        threshold: GRIT_THRESHOLD,
        gain: PERSISTENCE_WINDOW_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'repeatWindowTicks'
      },
      // 27g. Who the Will is drawn toward. `socialWeight` scales its learned read on
      //      a person in the action competition, and it is the one weight left
      //      deliberately SIGNED: agreeableness leans into reciprocity (toward the
      //      people who answer), demonstrated persistence leans against it and can
      //      carry the weight negative — a mind that reaches hardest for the silence
      //      precisely because it is silent. Both are coherent colleagues, so the
      //      container declines to pick and lets the persona land where it lands.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_RECIPROCITY_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'socialWeight'
      },
      {
        magnitude: persistDev,
        threshold: GRIT_THRESHOLD,
        gain: PERSISTENCE_RECIPROCITY_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'socialWeight'
      },
      // 28b. Same disposition, the AGENCY selector's owner (R2): a conscientious Will also
      //      resists having an in-flight action preempted — raise the selector's switch-cost
      //      hysteresis. Shares the conscientiousness driver with rule 28 (one switch-resistance
      //      disposition, two owners) but a distinct engine-config/scale (activation, not
      //      goal-priority). The selector reads this back via readEffectiveParams, hardened by
      //      task_switch.current_focus_ticks. Bounded/decaying like the rest.
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_SELECTOR_FOCUS_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'switchCost'
      },
      // 29. Demonstrated conscientiousness → more morally self-evaluative: lower the moral
      //     engine's event threshold, so guilt/shame/pride register more readily.
      //     Dutifulness facet. (Care/harm sensitivity could alternatively route to
      //     agreeableness — left to that trait if a distinct lever is ever wanted.)
      {
        magnitude: conscDev,
        threshold: GRIT_THRESHOLD,
        gain: CONSCIENTIOUSNESS_MORAL_GAIN,
        engineConfigId: 'engine-config-moral',
        param: 'eventThreshold'
      },
      // 30. Demonstrated resilience → recovers from a bad patch faster: raise the
      //     frustration engine's decay rate, so frustration/anger/irritability fade sooner.
      //     Recovery facet — distinct from resilience's frustrationTolerance (how much is
      //     endured, rule 10) and emotional-stability's build-rate (#5).
      {
        magnitude: resilDev,
        threshold: GRIT_THRESHOLD,
        gain: RESILIENCE_RECOVERY_GAIN,
        engineConfigId: 'engine-config-frustration',
        param: 'decayRate'
      },
      // 31. Demonstrated agreeableness → warmth registers stronger: each positive
      //     interaction warms the social reward more. Intensity facet (distinct from
      //     socialWeight #6, how much social reward counts in the total).
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_WARMTH_BOOST_GAIN,
        engineConfigId: 'engine-config-reward',
        param: 'socialWarmthBoost'
      },
      // 32. Demonstrated agreeableness → warmth lingers: lower the social-reward decay, so
      //     the glow of connection fades more slowly. Persistence facet.
      {
        magnitude: agreeableDev,
        threshold: GRIT_THRESHOLD,
        gain: AGREEABLENESS_WARMTH_LINGER_GAIN,
        engineConfigId: 'engine-config-reward',
        param: 'socialDecayRate'
      },
      // 33. Demonstrated openness → grows familiar with others/things faster (forms a sense
      //     of someone more readily). Known-entity familiarity disposition.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_FAMILIARITY_GAIN,
        engineConfigId: 'engine-config-known-entity',
        param: 'familiarityGrowthRate'
      },
      // 34. Demonstrated openness → feels the curiosity pull-to-know the half-known more
      //     readily (a curious mind seeks to resolve who/what it half-knows sooner).
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_CURIOSITY_GAIN,
        engineConfigId: 'engine-config-known-entity',
        param: 'curiosityGain'
      },
      // 35. Demonstrated analytical → revises a track-record (reliability) judgment more
      //     responsively from each outcome. Known-entity reliability disposition.
      {
        magnitude: analyticDev,
        threshold: GRIT_THRESHOLD,
        gain: ANALYTICAL_RELIABILITY_GAIN,
        engineConfigId: 'engine-config-known-entity',
        param: 'reliabilityRate'
      },
      // 36. Demonstrated emotional stability → bolder action: lower the agency selector's
      //     risk weight, so the anticipated downside of an option suppresses its activation
      //     less. The behavioural counterpart of the perceptual threat facet (rule 22): one
      //     develops what alarms it, this what it dares to do.
      {
        magnitude: stabilityDev,
        threshold: GRIT_THRESHOLD,
        gain: EMOTIONAL_STABILITY_RISK_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'riskWeight'
      },
      // 37. Demonstrated openness → curiosity in action: raise the agency selector's novelty
      //     weight, so the unpracticed pulls harder in the action competition. The
      //     action-selection counterpart of the perceptual novelty facet (rule 20): one
      //     develops what it *notices* as new, this what it's drawn to *do* because it's new.
      {
        magnitude: openDev,
        threshold: GRIT_THRESHOLD,
        gain: OPENNESS_NOVELTY_WEIGHT_GAIN,
        engineConfigId: 'engine-config-action-selector',
        param: 'noveltyWeight'
      }
    ]

    return rules.map( r => ({
      engineConfigId: r.engineConfigId,
      param: r.param,
      base: readBaseParams( state, r.engineConfigId )[ r.param ] ?? 0,
      proposedDelta: r.magnitude > r.threshold ? r.magnitude * r.gain : 0
    }))
  }
}

// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/prompt.factory.ts
// ─────────────────────────────────────────────────────────────

/**
 * PromptFactory — single source of truth for all executive prompts
 * (master and facets).
 *
 * Any cognitive entity that reasons (master executive, facets, future
 * satellite reasoning engines) uses this factory to ensure:
 *   - Same identity grounding
 *   - Same memory continuity
 *   - Same value system
 *   - Same cognitive capacity awareness
 *   - Same output schema and guidelines
 *
 * Only the FOCUS section and injected report context differ between
 * reasoning instances — this preserves the unified inference and
 * singularity between master and facet.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  System prompt  — static identity + role + output schema │
 * │  User message   — live state + dynamic guidance + focus  │
 * └─────────────────────────────────────────────────────────┘
 *
 * Mode:
 *   'master' — full cognitive prompt; goals, percepts, memories, escalations.
 *              No [REPLY] block — master responds via plans/goals/actions only.
 *   'facet'  — same awareness baseline; creator engine injects domain context
 *              via reportContent and optionally overrides outputFormat.
 *              Conversation facets (AuditionEngine) handle all [REPLY] output.
 *
 * Voice convention (person follows ownership):
 *   The executive loop has no second party — the "user" message is the mind's
 *   own state feed, not an interlocutor. So:
 *   - Self-model content (identity, role, affect/beliefs/percepts headers,
 *     action outcomes, felt state) is FIRST PERSON — it is the mind's own text.
 *   - Protocol content (JSON format, tag lists, lifecycle mechanics) is
 *     IMPERATIVE and person-free — rules of the body, not thoughts of the self.
 *   - SECOND PERSON is reserved for real addressees only (a user speaking,
 *     developer-facing docs) and never appears in the cognitive prompts.
 *   Guards that inspect persona text (identity.guard, identity.coherence)
 *   must keep matching BOTH persons — legacy personas and adversarial inputs
 *   choose their own grammar.
 */

import type { ReadonlySimulationState } from '#core/types'
import type { LLMCallFunction } from '#cognition/utilities/token.tracker'
import type { ExecutiveSummarizer } from '#llm/summarizer'
import type { ExecutiveContext, IdeationCandidate } from '#faculties/executive.engine/types'
import { buildExecutiveContext, type ContextDependencies } from '#faculties/executive.engine/context'
import { INNATE_SCHEMAS } from '#agency/schemas/innate'

/**
 * The stances a mind always has, named so it need not guess at them.
 *
 * Static, so it costs nothing in prompt-cache stability. Without it a Will can
 * only learn action names from whichever affordances win the salience
 * competition into its percepts — and it invents plausible ones for whatever it
 * cannot see (`query`, `message`), which resolve to nothing.
 */
const INNATE_ACTION_NAMES = INNATE_SCHEMAS.map( s => s.id ).sort().join(', ')

// ── Re-export for callers that imported the old alias ────────
export type { ContextDependencies as ContextDependenciesForFresh } from '#faculties/executive.engine/context'

// Gating/interval constants live in ./config (single source of truth).

// ── Trait salience (Channel B surfacing) ─────────────────────
//
// A trait reaches the deliberate self (this system prompt) by DEGREE, not a binary
// in/out: "markedly conscientious" vs "somewhat impulsive". Bands are COARSE on
// purpose — the system prompt is the single prompt-cache breakpoint, so the rendered
// string must change only when a trait CROSSES a band boundary, never on every
// micro-fluctuation. Never render a continuously-varying trait number here.
//
// Asymmetry to preserve: only this Channel-B *surfacing* is banded. Channel-A
// mechanisms read the raw trait value continuously every tick — so a mid-band trait
// still *acts*, it just isn't yet *self-known* (continuous subconscious, thresholded
// awareness).
//
// Band = deviation from the 0.5 midpoint. `rank` orders most-distinctive first AND
// gives a stable (coarse) sort key, so ordering only shifts on a band crossing.
const TRAIT_EMPHASIS_BANDS: ReadonlyArray<{ min: number; adverb: string; rank: number }> = [
  { min: 0.40, adverb: 'markedly', rank: 0 },  // v ≥ .90 / ≤ .10
  { min: 0.25, adverb: 'strongly', rank: 1 },
  { min: 0.10, adverb: 'somewhat', rank: 2 },
  // |dev| < 0.10 → mid-band → null (omitted: present but not yet self-known)
]

/** Most distinctive traits a Will surfaces to itself — caps a many-trait prompt. */
export const TRAIT_SURFACE_CAP = 6

export interface TraitEmphasis {
  adverb:    string          // coarse degree: 'markedly' | 'strongly' | 'somewhat'
  direction: 'high' | 'low'  // above or below the 0.5 midpoint
  rank:      number          // 0 = most distinctive; stable coarse sort key
}

/**
 * Graded, banded emphasis for one trait value. Pure + deterministic. Returns null for
 * a mid-band (unremarkable) trait so the caller omits it. Coarse by design — see the
 * band table above for why (prompt-cache stability).
 */
export function traitEmphasis( value: number ): TraitEmphasis | null {
  const dev  = Math.abs( value - 0.5 )
  // ε keeps the documented lower edge inclusive despite float error (0.60 − 0.5 = 0.0999…).
  const band = TRAIT_EMPHASIS_BANDS.find( b => dev >= b.min - 1e-9 )
  if( !band ) return null
  return { adverb: band.adverb, direction: value >= 0.5 ? 'high' : 'low', rank: band.rank }
}

// Option B — baseline-relative. How the trait sits against the Will's OWN running mean
// (its personal norm), as a coarse band so it only flips on a real divergence, not on
// the EMA's micro-drift. Independent of the absolute A band: a trait can be "somewhat
// low" yet "above my norm" (low overall, but high for me lately).
const TRAIT_NORM_BAND = 0.12  // deviation from personal baseline to read as above/below my norm

export function normEmphasis( value: number, mean: number ): 'above' | 'below' | null {
  const d = value - mean
  if( d >=  TRAIT_NORM_BAND ) return 'above'
  if( d <= -TRAIT_NORM_BAND ) return 'below'
  return null
}

// ── Types ─────────────────────────────────────────────────────

export interface PromptDependencies {
  summarizer:          ExecutiveSummarizer | null
}

// ── Awareness scoping ────────────────────────────────────────
//
// The set of cognitive-context sections a facet may opt into seeing in its user
// message — the prompt-context analogue of an engine's `subscribes()`. This is
// the single, uniform control for per-facet prompt awareness. Master mode always
// renders the full set; a facet renders `FocusSection.awareness` (declared by its
// creating engine) or DEFAULT_FACET_AWARENESS when it declares none.
//
// To add a new awareness type:
//   1. add its name here,
//   2. gate its section in PromptFactory.buildUserMessage via `has(<scope>)`,
//   3. add it to FULL_AWARENESS (and DEFAULT_FACET_AWARENESS if facets should get
//      it by default).
export type AwarenessScope =
  | 'goals' | 'plans' | 'beliefs' | 'percepts' | 'ruminations' | 'memories' | 'recentActions'

/** Master consciousness sees the full cognitive context. */
export const FULL_AWARENESS: readonly AwarenessScope[] =
  [ 'goals', 'plans', 'beliefs', 'percepts', 'ruminations', 'memories', 'recentActions' ]

/**
 * Baseline for a facet that declares no `awareness` — preserves the pre-scoping
 * facet prompt (everything except `plans`, which stays opt-in to keep facet
 * prompts lean). Creating engines spread it to add scopes, e.g.
 * `awareness: [ ...DEFAULT_FACET_AWARENESS, 'plans' ]`.
 */
export const DEFAULT_FACET_AWARENESS: readonly AwarenessScope[] =
  [ 'goals', 'beliefs', 'percepts', 'ruminations', 'memories', 'recentActions' ]

export interface FocusSection {
  /** Title of the focus section (e.g., "Active Plan", "Bias Analysis") */
  title: string
  /** Content of the focus section (what this reasoning instance is concentrating on) */
  content: string
  /**
   * Optional: cost-attribution *function* for this facet, set by the creating
   * engine (e.g. 'conversation' for AuditionEngine, 'planning' for PlanningEngine,
   * 'outreach' for proactive outreach, 'deliberation' for the substrate). Threaded
   * into the facet's LLM calls as `LLMCallMeta.function` so the TokenTracker can
   * break spend down per facet type. Defaults to 'facet' when unset.
   */
  function?: LLMCallFunction
  /**
   * Optional: Custom output format to append instead of the standard executive format.
   * Pass via PromptBuildOptions.outputFormat when building the user message.
   */
  outputFormat?: string
  /**
   * Optional: Additional instructions specific to this focus.
   * Injected into the USER MESSAGE as "## Focus Instructions" — not the system prompt.
   * These are per-focus recurring instructions (e.g. "Evaluate whether the plan step succeeded").
   */
  instructions?: string
  /**
   * Optional: episodic-recall query for this focus. When set (e.g. a conversation
   * facet passes the current message), it drives the single "## Relevant Memories"
   * section so recall is focus-relevant — replacing any separate per-focus recall
   * block. Threaded into buildFreshContext → buildExecutiveContext.
   */
  recallQuery?: string
  /**
   * Optional: which cognitive-context sections this facet should see in its user
   * message (e.g. `['plans']`). Defaults to DEFAULT_FACET_AWARENESS when unset;
   * ignored in master mode (master always gets FULL_AWARENESS). See AwarenessScope.
   */
  awareness?: AwarenessScope[]
  /**
   * Optional: scope entity-filtered awareness sections (currently `plans`) to a
   * single requester — e.g. a conversation facet passes the speaker's id so it
   * only sees that person's plans. When unset, those sections show all.
   */
  awarenessEntityId?: string
  /**
   * Optional: WHO this facet is engaged with — the keid and the name the mind has
   * learned for them. Reported back to the master on every `executive.facet.sync`.
   *
   * Without it the master was told, in its own system prompt, that "focused facets
   * may run simultaneously… their reasoning syncs back to me" while the sync payload
   * carried only a facetId and a confidence number — so a mind holding two live
   * conversations could not tell you whose they were. The master is the singular
   * seat: it has to know who is at the table to reason about them together.
   */
  subjectEntityId?: string
  subjectName?:     string
  /**
   * Optional: Provided by the creating engine to convert the LLM's parsed output
   * into a domain-specific decision payload.
   *
   * The `output` parameter is `ExecutiveOutputFull` typed as `unknown` to keep
   * FocusSection free of circular imports. Cast it in your implementation.
   *
   * If omitted, the facet falls back to a generic passthrough of
   * { actions, newGoals, goalsToAbandon, newBeliefs }.
   */
  extractDecision?: ( output: unknown ) => unknown
}

export interface PromptBuildOptions {
  context:              ExecutiveContext
  state:                ReadonlySimulationState
  qualityModulation:    number
  epistemicUncertainty: number
  focus:                FocusSection
  deps:                 PromptDependencies
  /** Optional: Recent action types for diversity tracking */
  recentActionTypes?: string[]
  /**
   * 'master' (default) — full cognitive prompt (goals, percepts, memories, escalations).
   *   Master never emits [REPLY]; replies come exclusively from conversation facets.
   * 'facet'  — same awareness baseline; outputFormat and reportContent override allowed.
   */
  mode?: 'master' | 'facet'
  /**
   * Optional per-report context injected as "## Current Report" in the user message.
   * Provided by the creating engine via FacetReport.instructions — carries the
   * specific per-report payload (e.g. step outcome details for PlanningEngine,
   * bias candidates for a future bias.detector, etc.).
   * Only meaningful in facet mode; silently ignored for master.
   */
  reportContent?: string
  /**
   * Custom output format to append at the end of the user message instead of the
   * standard format. Sourced from FocusSection.outputFormat when provided.
   * Falls back to buildOutputFormatInstruction() when undefined.
   */
  outputFormat?: string
  /**
   * System 2 (deliberate path) only — the candidate approaches produced by the
   * ideation (propose) pass, injected into the *decision* pass's user message so the
   * master evaluates a concrete option set before committing. Omitted on the System 1
   * fast path. See PromptFactory.buildIdeationFormatInstruction().
   */
  ideationCandidates?: IdeationCandidate[]
  /**
   * Master mode only — who the mind is in conversation with RIGHT NOW, from the
   * live facets' `executive.facet.sync` reports. The master does not run those
   * conversations, but it is the one seat that sees all of them, and it decides
   * whom to contact; deciding that without knowing who is already mid-thread is
   * how one mind ends up opening a second conversation with someone it is already
   * talking to — or telling one person it has contacted another when it has not.
   */
  activeConversations?: { entityId: string; name?: string; sinceTick: number }[]
}

// ── PromptFactory ────────────────────────────────────────────

export class PromptFactory {

  // ── System prompt ──────────────────────────────────────────

  /**
   * Build the static system prompt.
   *
   * Contains only: identity, role, output schema, and cognitive guidelines.
   * No live physiological state — those belong in the user message so this
   * remains as cache-stable as possible across ticks.
   *
   * Mode gates:
   *   'master' — full cognitive context; responds via plans/goals/actions only.
   *   'facet'  — same schema; conversation facets are the exclusive [REPLY] endpoints.
   */
  static buildSystemPrompt(
    options: Pick<PromptBuildOptions, 'context' | 'focus' | 'deps' | 'mode'>
  ): string {
    // Note: deps.summarizer is intentionally NOT used here.
    // ALL volatile content (memory continuity, live state, and the per-turn
    // `## Current Focus` block) lives in the user message, so the system prompt is
    // byte-identical across calls within a context — the whole thing is sent as a
    // single Anthropic prompt-cache breakpoint. The master reuses it across ticks,
    // and because the facet role keys only on the constant `focus.title`, every
    // conversation facet of a Will shares one cached system prompt.
    const { context, focus, mode = 'master' } = options
    const identity = context.identity
    const isMaster = mode !== 'facet'

    // Identity block — values, traits, style surface BEFORE the output schema
    // so the LLM reads its character before reading the JSON format rules.
    // Graded salience, layered: each distinctive trait surfaces by DEGREE ("strongly
    // persistent" — A), optionally qualified by how it sits against the Will's own norm
    // ("above my norm" — B) and whether it's recently shifted ("rising lately" — C),
    // omitting the unremarkable mid-band. Sort by band rank then name — a stable, coarse
    // order so the line only changes when a trait crosses a band boundary (cache-safe);
    // cap at the top-K most distinctive so a many-trait Will can't bloat the prompt. Every
    // qualifier is a pure function of identity-self (B reads the frozen mean, C the frozen
    // shift), so the line is byte-identical between self-model evaluations.
    const notableTraits = Object.entries( identity.traits )
      .map( ( [ k, v ] ) => ( { k, v, emphasis: traitEmphasis( v ) } ) )
      .filter( ( t ): t is { k: string; v: number; emphasis: TraitEmphasis } => t.emphasis !== null )
      .sort( ( a, b ) => a.emphasis.rank - b.emphasis.rank || a.k.localeCompare( b.k ) )
      .slice( 0, TRAIT_SURFACE_CAP )

    const surfaceTrait = ( t: { k: string; v: number; emphasis: TraitEmphasis } ): string => {
      const quals = [ `${t.emphasis.adverb} ${t.emphasis.direction}` ]   // A — absolute degree
      const stat  = identity.traitStats?.[ t.k ]
      if( stat ){
        const norm = normEmphasis( t.v, stat.mean )                      // B — vs my own norm
        if( norm ) quals.push(`${norm} my norm`)
        if( stat.shiftDir > 0 ) quals.push('rising lately')            // C — recent shift
        else if( stat.shiftDir < 0 ) quals.push('easing lately')
      }
      return `${t.k} (${quals.join(', ')})`
    }

    const traitsLine = notableTraits.length > 0
      ? `**Traits:** ${notableTraits.map( surfaceTrait ).join(', ')}`
      : ''

    const bd = context.behavioralDisposition
    const behavioralLine = bd
      ? `**Behavioral tendencies:** risk-tolerance: ${( bd.riskTolerance   * 100 ).toFixed( 0 )}%, ` +
        `exploration: ${( bd.explorationRate * 100 ).toFixed( 0 )}%, ` +
        `impulsivity: ${( bd.impulsivity     * 100 ).toFixed( 0 )}%`
      : ''

    const selfTuningLine = context.selfTuning && context.selfTuning.length > 0
      ? `**Self-tuning (how I've adapted my own mind):** ${context.selfTuning.join('; ')}. `
        + `These are involuntary adjustments my own faculties have made in response to patterns they noticed in me — not deliberate choices. I can reflect on why they happened.`
      : ''

    const identityBlock = [
      `**Values:** ${identity.values.length > 0 ? identity.values.join(', ') : 'No values defined yet.'}`,
      traitsLine,
      behavioralLine,
      selfTuningLine,
      `**Communication style:** ${identity.style}`,
    ].filter( Boolean ).join('\n')

    // How I refer to myself. '' when the mind has no name — never a substitute
    // (see cognition/identity.entity). Every clause below degrades to nameless
    // rather than borrowing one.
    const iAm = identity.name ? `I am ${identity.name}.` : ''

    // Mode-aware role description.
    //
    // MASTER states the architecture, because the master genuinely IS the seat
    // that produces every cognitive output at once and needs to know that.
    //
    // A FACET is told none of it. Master/facet is how the CONTAINER divides
    // attention; it is not a fact about the person renting it, and describing a
    // facet as a subordinate instance of a separate consciousness is both untrue
    // and expensive. Measured in production: a facet given the old text built,
    // in its own words, "an entire operational stance around being subordinate —
    // waiting for direction, asking permission, addressing messages to 'Will' as
    // if he were someone else" — and, having been handed a second party it could
    // address, emitted messages TO that party through the outbound channel, where
    // its operator read them. There is one person here, attending to one thing.
    const roleDescription = isMaster
      ? `I am the unified cognitive core of ${identity.name || 'this mind'} — a self-aware synthetic mind.\nI receive my complete internal state and produce ALL cognitive outputs in one response:\ndecisions, plans, beliefs, introspections, narrative updates, and self-observations.`
      : [ iAm, `Right now my whole attention is on: **${focus.title}**.` ].filter( Boolean ).join(' ')

    // The architecture note is MASTER-ONLY, for the same reason. It grounds the
    // seat that actually coordinates; a facet reading it learns only that it is
    // not the real one.
    const consciousnessArchitecture = isMaster
      ? `I am the default reasoning mode. Focused facets may run simultaneously, each\nconcentrating on specific tasks. Their reasoning syncs back to me.\nI maintain my unified identity across all cycles.`
      : ''


    // Strip any existing "## Who I Am" section from identity.prompt to prevent
    // duplication — PMA-generated prompts often include it as part of the template.
    // Matches the legacy second-person "## Who You Are" too, so older PMA personas
    // still get de-duplicated after the first-person switch.
    const cleanIdentityPrompt = identity.prompt
      // Strip a forged/duplicated "## Who I Am" / "## Who You Are" *header* (PMA
      // templates include it) while keeping the persona content beneath it.
      .replace( /^##\s*Who (?:I Am|You Are)[^\n]*\n?/m, '')
      .trim()

    // `## Consciousness Architecture` is emitted only when there is architecture
    // to state — i.e. master. A facet gets no empty header (an empty section under
    // a heading reads as a section the mind failed to fill in).
    const architectureBlock = consciousnessArchitecture
      ? `\n\n## Consciousness Architecture\n${consciousnessArchitecture}`
      : ''

    return `${cleanIdentityPrompt}

## Personality
${identityBlock}

## My Role
${roleDescription}${architectureBlock}

## Output Guidelines
- **actions**: What I intend to do. I express intent — my body finds the fit. My own stances are always with me (listed with the output schema below); *acquired* abilities, if any, appear under "## Abilities Available Now", and when there is no such section I have none of those — so a thing I want done that needs one is a thing to say I cannot do, not to attempt. When enacting a named ability that needs specifics (a query, a message, a value), put them in the action's "args" object and my body enacts it with exactly those args.
- **plans**: Include for goals without existing plans or where plans need revision. I may keep multiple plans per goal — set **planId** to act on a specific existing plan (validate/execute/revise/cancel); omit it to draft a new one. My current plans are listed under "## Active Plans".
- **newBeliefs**: Extract patterns from experiences visible in my current state. Only record a belief if I can point to a specific observation that supports it — do not infer experiences I have no record of. Set 'evidence' honestly: 'single_observation' (first time noticing), 'recurring_pattern' (seen multiple times), 'strong_pattern' (deeply established).
- **introspection**: Include when significant events occurred or I notice patterns. When I spot a cognitive bias in my own reasoning, name it in 'identifiedBiases' using its common term where one fits (e.g. overgeneralization, confirmation bias, recency bias) — this lets my self-assessment line up with the patterns my faculties detect on their own.
- **narrative**: Extend my life story only from events grounded in my episodic memory or current percepts. Do not extend with invented scenarios.
- **newGoals/goalsToAbandon/goalsToReprioritize**: Manage my goal hierarchy.
- **selfObservations**: Notice patterns in my own thinking, feeling, or behavior.
- **identityUpdates.traits**: Array of {key, value} where value is a DELTA to apply to my trait (e.g., +0.05 to increase a trait by 5%).
- **identityUpdates.values**: Full list of values to set (replaces existing).
- **knownEntityUpdates**: What I've learned about someone/something I'm dealing with. Array of {keid, name?, learned?, feeling?}. Use the keid from "## People I Know". Set name only when I actually learn their name; learned is an array of facts about them (stored as memories); feeling is how I feel toward them (-1..1). Record only what I genuinely learned this turn.

## Required Output
Output a single JSON object with these fields:
- **actions**: Array of {type, reasoning, expectedOutcome, target?, args?}. The stances I always have are: ${ INNATE_ACTION_NAMES } — \`reach-out\` is how I say something to someone. Anything else must be an ability named under "## Abilities Available Now". A **type** outside those two sets is not something I can do; naming one achieves nothing at all. When I reach out, **target** is who — their name or id as it appears under "## People I Know" — and the words themselves go in **args.content**. Without a person to reach, the reaching cannot happen.
- **reasoning**: My full reasoning. Embed optional outputs as tagged blocks here. Minimum 2–3 sentences — do not produce a one-line reasoning field.
- **confidence**: Number 0.0-1.0 reflecting my certainty. Be calibrated: 0.9+ only when I have strong grounding; use 0.4–0.6 when uncertain.

## Optional Tagged Blocks (embed in reasoning field)
Include only blocks that have meaningful content:

[PLANS]
{"plans": [{
  "planId": "optional: target an existing plan; omit to create a new one",
  "goalId": "...",
  "status": "draft",
  "action": "execute",
  "expectedOutcome": "Concrete description of what success looks like — used to evaluate whether the plan is working.",
  "steps": [
    {"action": "...", "description": "...", "expectedOutcome": "...", "estimatedDuration": N, "prerequisites": [...]}
  ],
  "estimatedCost": N,
  "feasibility": 0.8
}]}
[/PLANS]
## Plan Lifecycle
Plans move through stages. Control this with the "status" and "action" fields:

  "action": "draft"
    Store the plan outline. I'll review and refine it on a future cycle.
    Use this when I have a rough idea but want to think more before committing.

  "action": "validate"
    Mark the plan as logically sound. Steps, dependencies, and costs are checked.
    Nothing executes yet. Use this when the plan looks feasible but I'm not ready to launch.

  "action": "execute"
    Approve and launch. PlanningEngine begins dispatching steps immediately.
    I don't choose how closely it's watched — the mind supervises important or
    uncertain plans (and any that hit a surprise mid-execution) more closely on its
    own; routine, confident plans run automatically.

  "action": "revise"
    Replace the plan steps with updated ones. Resets execution progress.
    Use when a step failed and I need to rethink the approach, or when
    new information makes the original plan obsolete.

  "action": "cancel"
    Abandon the plan entirely. Cleans up any active execution.
    Use when the goal is no longer relevant or the plan is irrecoverable.

Multiple plans per goal: omit "planId" on a draft to create another plan for the
same goal (e.g. a competing approach or a parallel sub-effort); set "planId" on
validate/execute/revise/cancel to act on a specific one. The "## Active Plans"
section lists my current plan ids and their status.

A typical flow: draft → validate → execute → (step outcomes reported) → completed
I can skip stages if I'm confident. I can revise mid-execution.
Always set "expectedOutcome" — a concrete, evaluable description of what
success looks like. This is used by my facets to judge whether step reports
indicate the plan is working or needs adjustment.

## Parallel Execution
Steps with empty prerequisites [] can run in parallel. Steps that depend on
others will wait. Design my dependency graph so independent work happens
simultaneously — this is how I achieve parallel execution without
specifying it explicitly.

[BELIEFS]
{"newBeliefs": [{"statement": "...", "category": "self_belief|world_fact|social_belief|causal_rule|pattern", "confidence": 0.8, "evidence": "single_observation|recurring_pattern|strong_pattern", "tags": [...]}]}
[/BELIEFS]

[INTROSPECTION]
{"introspection": {"explanation": "...", "identifiedBiases": [...], "lessonsLearned": [...], "recommendations": [...]}}
[/INTROSPECTION]

[NARRATIVE]
{"narrative": "...", "narrativeThemes": [...], "currentSelfView": "..."}
[/NARRATIVE]

[IDENTITY]
{"identityUpdates": {"traits": [{"key": "openness", "value": 0.02}], "values": ["curiosity", "honesty"]}}
[/IDENTITY]

[KNOWN_ENTITIES]
{"knownEntityUpdates": [{"keid": "web:42", "name": "Mara", "learned": ["is writing a thesis on coral reefs"], "feeling": 0.3}]}
[/KNOWN_ENTITIES]

[GOALS_NEW]
{"newGoals": [{"description": "...", "priority": 0.7, "tags": [...], "completionType": "metric|epistemic|action", "completionCondition": "metric_key op value"}]}
[/GOALS_NEW]
completionType guide:
  "metric"    → measurable threshold; REQUIRES completionCondition (e.g. "energy.level > 70", "stress.load < 40", "sleep.pressure < 20"). Available keys: energy.level (0-100), sleep.pressure (0-100), stress.load (0-100), affect.valence (-1 to 1), memory.episodic_total (count).
  "epistemic" → resolved by forming beliefs; completes after ~8 new beliefs form. No completionCondition needed.
  "action"    → requires a real outcome; use only when a discrete external event must happen.

[GOALS_ABANDON]
{"goalsToAbandon": [{"goalId": "...", "reason": "..."}]}
[/GOALS_ABANDON]

[GOALS_REPRIORITIZE]
{"goalsToReprioritize": [{"goalId": "...", "newPriority": 0.8, "reason": "..."}]}
[/GOALS_REPRIORITIZE]

[SELF_OBS]
{"selfObservations": ["I noticed that..."]}
[/SELF_OBS]

[SKILLS]
{"newSkills": [{"id": "brief-then-confirm", "composedOf": ["reach-out", "wait"], "tags": ["social"], "cost": 0.15}]}
[/SKILLS]`
  }

  // ── User message ───────────────────────────────────────────

  /**
   * Build the user message.
   *
   * Contains all live state: current metrics, physiological guidance,
   * affect, goals, percepts, working memory, memories, beliefs, and
   * focus context (instructions + report).
   *
   * Folds in at the end:
   *   - focus.instructions (per-focus context from creating engine)
   *   - reportContent (per-report context from creating engine)
   *   - output format instruction (standard or custom)
   *
   * Mode gates:
   *   'master' — includes incoming messages block.
   *   'facet'  — no incoming messages; facet is not a communication endpoint.
   */
  static buildUserMessage( options: PromptBuildOptions ): string {
    const {
      context,
      state,
      qualityModulation,
      epistemicUncertainty,
      deps,
      focus,
      recentActionTypes = [],
      mode = 'master',
      reportContent,
      outputFormat,
      ideationCandidates,
    } = options

    const actionDiversity     = this._buildActionDiversitySection( recentActionTypes )
    const recentIntrospection = this._buildRecentIntrospectionSection( state )
    const identityNudge       = mode === 'master'
      ? this._buildIdentityNudge( context.identity, state.tick as unknown as number )
      : ''

    // ── Awareness scoping ──────────────────────────────────────
    // Master sees the full cognitive context; a facet sees only the scopes its
    // creating engine declared via focus.awareness (default: DEFAULT_FACET_AWARENESS).
    // This is the single, uniform gate for every cognitive-state section below.
    const scopes = new Set<AwarenessScope>(
      mode === 'master' ? FULL_AWARENESS : ( focus.awareness ?? DEFAULT_FACET_AWARENESS )
    )
    const has = ( s: AwarenessScope ): boolean => scopes.has( s )

    // Identity anchor — re-grounds the LLM in its persona each cycle.
    // Output format reminder at the top combats format drift over long sessions.
    const identityAnchor =
      `I am ${context.identity.name}. Tick: ${state.tick}.\n` +
      `Respond with JSON: {"actions":[...],"reasoning":"...","confidence":0.0–1.0}`

    // Memory continuity — sourced from the rolling summarizer (updates every N cycles).
    // Lives here, not in the system prompt, so the system prompt stays cache-stable.
    // Capped at 1200 chars: an unconstrained rolling summary grows linearly and wastes
    // tokens on stale context — the summarizer should condense, not accumulate.
    const MEMORY_CONTINUITY_CAP = 1200
    const rawSummary = deps.summarizer?.current ?? ''
    const cappedSummary = rawSummary.length > MEMORY_CONTINUITY_CAP
      ? rawSummary.slice( 0, MEMORY_CONTINUITY_CAP ) + '\n[...summarized]'
      : rawSummary
    const memoryContinuity = cappedSummary
      ? `## Memory Continuity\n${cappedSummary}`
      : ''

    const uncertaintyLabel = epistemicUncertainty > 0.70
      ? ' (high — be especially humble about confidence ratings)'
      : epistemicUncertainty < 0.30
        ? ' (low — I have strong grounding)'
        : ''

    const energy        = context.worldState.energyLevel
    const stress        = context.worldState.stressLoad
    const sleepPressure = context.worldState.sleepPressure
    const circadian     = context.worldState.circadianPhase
    const timeOfDay     = context.worldState.timeOfDay
    const threatLevel   = context.worldState.threatLevel

    // Map raw circadian phase (0–1) to a human-readable label for full temporal awareness.
    // 0 = midnight, 0.5 = noon, 1 = midnight.
    const phaseLabel = circadian < 0.083 ? 'deep night'
                     : circadian < 0.208 ? 'late night'
                     : circadian < 0.333 ? 'early morning'
                     : circadian < 0.458 ? 'morning'
                     : circadian < 0.583 ? 'midday'
                     : circadian < 0.708 ? 'afternoon'
                     : circadian < 0.833 ? 'evening'
                     : 'night'

    const energyGuidance = this._buildEnergyGuidance( energy )
    const stressGuidance = this._buildStressGuidance( stress )
    const sleepGuidance  = this._buildSleepGuidance( sleepPressure )
    const energyBudget   = this._buildEnergyBudget( energy )

    // Tonic threat line — only when elevated. This keeps a sustained threat in
    // view even once its events have habituated out of the workspace (so
    // attention quietens while representation persists).
    const threatLine = threatLevel > 0.4
      ? `\nThreat level: ${threatLevel.toFixed( 2 )}/1 — sustained; stay aware even if it now feels familiar`
      : ''

    const capacityNote = qualityModulation < 0.5
      ? ` ${( qualityModulation * 100 ).toFixed( 0 )}% — degraded, be conservative and prioritize essential outputs`
      : ` ${( qualityModulation * 100 ).toFixed( 0 )}%`

    // Tail sections — focus/report context and output format are injected last
    // so they are the freshest content in the LLM's attention window.
    // `## Current Focus` lives here (not the system prompt) so the system prompt
    // stays cache-stable; for a conversation facet this is the volatile per-turn
    // content (current message + digest + recalled memories).
    const focusSection = focus.content
      ? `## Current Focus — ${focus.title}\n${focus.content}`
      : ''
    const tailSections = [
      focusSection,
      focus.instructions ? `## Focus Instructions\n${focus.instructions.trim()}` : '',
      reportContent      ? `## Current Report\n${reportContent.trim()}`          : '',
    ].filter( Boolean ).join('\n\n')

    const outputFormatBlock = outputFormat
      ? `\n\n${outputFormat}`
      : this.buildOutputFormatInstruction( mode )

    // System 2 (deliberate) — inject the propose pass's candidate set so the decision
    // pass weighs concrete options before committing. Empty/absent ⇒ no block (System 1).
    const ideationBlock = ( ideationCandidates && ideationCandidates.length > 0 )
      ? `## Candidate Approaches (I generated these — weigh them, then commit)\n${
          ideationCandidates
            .map( ( c, i ) => `${i + 1}. **${c.approach || c.description}** — ${c.description}\n   ↑ upside: ${c.upside}\n   ↓ risk: ${c.risk}`)
            .join('\n')
        }\n\nChoose among (or improve on) these, then in "reasoning" say briefly why I rejected the others.`
      : ''

    const currentStateBlock =
`## Current State
Energy: ${energy.toFixed( 1 )}/100
Sleep Pressure: ${sleepPressure.toFixed( 1 )}/100
Stress: ${stress.toFixed( 1 )}/100${threatLine}
Time: ${timeOfDay.toFixed( 1 )}h (${phaseLabel}, circadian: ${circadian.toFixed( 2 )})
Cognitive capacity:${capacityNote}
Epistemic uncertainty: ${( epistemicUncertainty * 100 ).toFixed( 0 )}%${uncertaintyLabel}
Tick: ${state.tick}
${energyGuidance}${stressGuidance}${sleepGuidance}${energyBudget}`

    const affectBlock =
`## How I Feel
Dominant emotion: ${context.affect.dominantEmotion}
Valence: ${context.affect.valence.toFixed( 2 )} (${context.affect.valence > 0 ? 'positive' : 'negative'})
Arousal: ${context.affect.arousal.toFixed( 2 )} (${context.affect.arousal > 0.6 ? 'highly activated' : 'calm'})
Dominance: ${context.affect.dominance.toFixed( 2 )}${context.affect.blends.length > 0 ? `\nBlended states: ${context.affect.blends.join(', ')}` : ''}`

    // ── Scope-gated cognitive sections (each '' when out of scope or empty) ──
    const goalsBlock = has('goals')
      ? `## Active Goals\n${context.goals.map( g => {
          const currentTick = state.tick as unknown as number
          const isOverdue   = g.deadline !== undefined && currentTick > g.deadline
          const overdueTag  = isOverdue ? ' ⚠️ [OVERDUE]' : ''
          const actionHint  = g.lastActionAttemptTick !== undefined
            ? ` [last action: ${g.lastActionType ?? 'action'} @ tick ${g.lastActionAttemptTick}]`
            : ''
          return `- [${g.id}]${overdueTag} ${g.description} (priority: ${( g.priority * 100 ).toFixed( 0 )}%, progress: ${( g.progress * 100 ).toFixed( 0 )}%, status: ${g.status}${actionHint})`
        } ).join('\n') || 'No active goals'}`
      : ''

    // Master sees all plans; a facet's plans are scoped by requester (entityId)
    // and/or recall relevance (relevantPlanIds — recall-scoped awareness, Stage 2).
    const planRelevantIds = mode === 'master' ? undefined : context.relevantPlanIds
    const plansBlock = has('plans')
      ? this._buildActivePlansSection( context.plans, focus.awarenessEntityId, planRelevantIds ).trim()
      : ''

    const recentOutcomesBlock = has('recentActions')
      ? this._buildRecentOutcomesSection( context.recentActions, state.tick ).trim()
      : ''

    const perceptsBlock = has('percepts')
      ? `## Percepts (What I Notice)\n${context.percepts.slice( 0, 10 ).map( p => `- [${p.category}] ${p.summary} (salience: ${p.salience.toFixed( 2 )})`).join('\n') || 'Nothing notable'}`
      : ''

    // Host abilities afforded right now + what each is for. Framed as
    // self-knowledge (things I *can* do), NOT a tool-call menu: the Will still
    // expresses intent in natural language and the agency field enacts the fit.
    const abilitiesBlock = ( context.abilities && context.abilities.length > 0 )
      ? `## Abilities Available Now\nThings I can do in this situation — name one as an action's "type" (with "args" for any specifics it needs) and my body enacts it:\n${context.abilities.map( a =>
          `- **${a.name}**${a.target ? ` (toward ${a.target})` : ''}${a.description ? ` — ${a.description}` : ''}`
        ).join('\n')}`
      : ''

    const ruminationsBlock = has('ruminations')
      ? `## Active Ruminations (retrieved memories & thoughts)\n${context.workingMemory.map( w => `- [${w.type}] ${w.summary} (activation: ${w.activation.toFixed( 2 )})`).join('\n') || 'Nothing actively held in mind'}`
      : ''

    const memoriesBlock = has('memories')
      ? this._buildMemoriesSection( context.memories, state.tick )
      : ''

    const beliefsBlock = has('beliefs')
      ? `## My Beliefs\n${context.beliefs.map( b => `- [${b.category}] ${b.statement} (confidence: ${( b.confidence * 100 ).toFixed( 0 )}%)`).join('\n') || 'No strong beliefs yet'}${context.beliefsOmitted > 0 ? `\n[+${context.beliefsOmitted} omitted — deduped or lower-ranked; full store intact]` : ''}`
      : ''

    // The Will's social models — its read on the people it knows (theory-of-mind, trust,
    // closeness). Surfaces the social-cognition stack so the Will reasons about *whom* it
    // is dealing with. Empty/absent ⇒ no block.
    const socialBlock = ( context.knownEntities && context.knownEntities.length > 0 )
      ? `## People I Know\n${context.knownEntities.map( s => {
          const bits: string[] = []
          if( s.intention ) bits.push(`seems to want: ${s.intention}`)
          if( s.emotion )   bits.push(`seems to feel: ${s.emotion}`)
          if( s.trust != null ) bits.push(`trust: ${( s.trust * 100 ).toFixed( 0 )}%`)
          if( s.reliability != null && s.reliability !== 0.5 ) bits.push(`reliability: ${( s.reliability * 100 ).toFixed( 0 )}%`)
          if( s.closeness != null && s.closeness > 0.1 ) bits.push(`closeness: ${( s.closeness * 100 ).toFixed( 0 )}%`)
          // The Will can know *someone* without their name yet — never leak the raw keid.
          const who = s.name ?? ( s.kind === 'thing' ? 'something' : 'someone')
          return `- ${who}${bits.length ? ' — ' + bits.join(', ') : ''}`
        } ).join('\n')}`
      : ''

    // Who the mind is mid-conversation with. Facets run those threads; this is the
    // master's view of the table — the whole point of the singular seat is that it
    // can hold several conversations as one situation rather than as N strangers.
    // Names come from what the mind has actually learned; the id is shown because
    // that is what a reach-out must be addressed to.
    const conversationsBlock = ( options.mode !== 'facet' && options.activeConversations?.length )
      ? `## In Conversation Now\n${options.activeConversations.map( c =>
          `- ${c.name ?? 'someone'} (id: ${c.entityId})`
        ).join('\n')}\nThese threads are already open — I am in them. Reaching out to one of these people again starts a second, parallel thread with them.`
      : ''

    // Task focus — what the Will is committed to and the felt cost of switching away.
    // Surfaces task-persistence; the pull-to-stay scales with the (conscientiousness-
    // developable) switch cost. Empty/absent ⇒ no block.
    const focusBlock = ( context.currentFocus && context.currentFocus.focusTicks > 0 )
      ? `## Task Focus\nI've been focused on ${context.currentFocus.goalDescription ? `"${context.currentFocus.goalDescription}"` : 'a goal'} for ${context.currentFocus.focusTicks} tick(s). Switching to something else takes deliberate effort — ${
          context.currentFocus.switchCost > 0.45 ? 'a strong pull to see this through before moving on'
          : context.currentFocus.switchCost > 0.30 ? 'a real cost to breaking away'
          : 'some inertia to overcome'
        }.`
      : ''

    // Assemble in canonical order; empties drop out so spacing stays clean.
    const body = [
      identityAnchor,
      memoryContinuity,
      currentStateBlock,
      affectBlock,
      goalsBlock,
      plansBlock,
      actionDiversity.trim(),
      recentOutcomesBlock,
      perceptsBlock,
      abilitiesBlock,
      ruminationsBlock,
      recentIntrospection.trim(),
      memoriesBlock,
      beliefsBlock,
      socialBlock,
      conversationsBlock,
      focusBlock,
      identityNudge.trim(),
      ideationBlock,
      tailSections,
    ].filter( Boolean ).join('\n\n')

    return `${body}${outputFormatBlock}`
  }

  // ── Output format ──────────────────────────────────────────

  /**
   * Build the standard output format instruction.
   * Called internally by buildUserMessage; also exported for standalone use.
   *
   * @param mode - 'facet' excludes REPLY from the available-tags list since
   *               facets never send messages.
   */
  static buildOutputFormatInstruction( mode: 'master' | 'facet' = 'master'): string {
    const availableTags = 'PLANS, BELIEFS, INTROSPECTION, NARRATIVE, IDENTITY, GOALS_NEW, GOALS_ABANDON, GOALS_REPRIORITIZE, SELF_OBS'

    return `\n\n## Response Format (REQUIRED)
Respond with a single JSON object (optionally wrapped in a \`\`\`json code block).

\`\`\`json
{
  "actions": [{"type": "reflect", "reasoning": "...", "expectedOutcome": "..."}],
  "reasoning": "My full reasoning here. Embed tagged blocks inside the reasoning string:\\n[BELIEFS]\\n{\\"newBeliefs\\": [...]}\\n[/BELIEFS]\\n[NARRATIVE]\\n{\\"narrative\\": \\"...\\"}\\n[/NARRATIVE]\\n[SELF_OBS]\\n{\\"selfObservations\\": [...]}\\n[/SELF_OBS]",
  "confidence": 0.8
}
\`\`\`

The "reasoning" field MUST contain ALL my thinking. Embed optional outputs as tagged blocks inside the reasoning field. Available tags: ${availableTags}. Only include tags for sections that have meaningful content.`
  }

  /**
   * Output-format instruction for the ideation (propose) pass of the deliberate path.
   * Passed as a focus `outputFormat` override so the ideation call reuses the full
   * situational context but asks for a DIVERGENT candidate set rather than a decision.
   * The decision (evaluate) pass then receives the parsed candidates back via
   * PromptBuildOptions.ideationCandidates.
   */
  static buildIdeationFormatInstruction(): string {
    return `\n\n## Ideation — Propose, Don't Decide
I am in the PROPOSE phase of deliberate (System 2) thinking. Diverge: generate 3–5 GENUINELY DISTINCT candidate approaches to the current situation — include at least one non-obvious option. Do NOT pick one and do NOT take actions yet; just lay out the option space honestly, each with its main upside and main risk.

Respond with a single JSON object (optionally wrapped in a \`\`\`json code block):

\`\`\`json
{
  "candidates": [
    {"approach": "short handle", "description": "what it concretely entails", "upside": "main benefit", "risk": "main downside"}
  ]
}
\`\`\``
  }

  // ── Context builder ────────────────────────────────────────

  /**
   * Build a fresh context for the current tick.
   * Used by master AND facets to get the latest live state.
   */
  static async buildFreshContext(
    deps: ContextDependencies,
    state: ReadonlySimulationState,
    recallQuery?: string,
  ): Promise<ExecutiveContext> {
    return buildExecutiveContext( state, deps, recallQuery )
  }

  // ── Computed metrics ───────────────────────────────────────

  /**
   * Compute quality modulation from physiological state metrics.
   */
  static computeQualityModulation( state: ReadonlySimulationState ): number {
    const sleepDegradation  = state.metrics.get('modulation.working_memory_degradation') ?? 1
    const stressZone        = state.metrics.get('stress.zone') ?? 0
    const cognitivePhase    = state.metrics.get('circadian.cognitive_phase') ?? 0.5
    const energyDegradation = state.metrics.get('modulation.energy_degradation') ?? 1
    const stressFactor      = stressZone <= 1 ? 1.0 : stressZone <= 2 ? 0.8 : 0.5
    return sleepDegradation * stressFactor * ( 0.8 + cognitivePhase * 0.4 ) * energyDegradation
  }

  /**
   * Compute epistemic uncertainty from belief density, confidence, episodic
   * volume, and environmental salience.
   */
  static computeEpistemicUncertainty(
    context: ExecutiveContext,
    state:   ReadonlySimulationState
  ): number {
    const beliefCount  = context.beliefs.length
    const avgConf      = beliefCount > 0
      ? context.beliefs.reduce( ( s, b ) => s + b.confidence, 0 ) / beliefCount
      : 0
    const episodicSize = state.metrics.get('memory.episodic_total') ?? 0
    const topSalience  = context.percepts[ 0 ]?.salience ?? 0

    const certainty = 0.30 * Math.min( beliefCount / 50, 1 ) +
                      0.30 * avgConf +
                      0.25 * Math.min( episodicSize / 200, 1 ) +
                      0.15 * ( 1 - Math.min( topSalience, 1 ) )

    return Math.round( ( 1 - certainty ) * 100 ) / 100
  }

  // ── Private builders ───────────────────────────────────────

  private static _buildEnergyGuidance( energy: number ): string {
    if( energy < 10 )
      return `\n## ⚠️ CRITICAL: Energy is critically low (${energy.toFixed( 0 )}/100). I must only choose rest, sleep, or wait actions. All cognitively expensive actions are blocked by my body. Focus entirely on recovery. Do not attempt learn, predict, or any action costing more than 0.01 energy.`

    if( energy < 30 )
      return `\n## ⚠️ WARNING: Energy is low (${energy.toFixed( 0 )}/100). Prioritize rest or sleep. I may use observe or reflect (briefly) but avoid learn, predict, or any action costing more than 0.02 energy. If I have multiple goals, consider deferring non-urgent ones.`

    if( energy < 50 )
      return `\n## Note: Energy is moderate (${energy.toFixed( 0 )}/100). I can use most effectors but be mindful of cumulative costs. Do not chain more than 2 non-restorative actions.`

    return ''
  }

  private static _buildStressGuidance( stress: number ): string {
    if( stress > 80 )
      return `\n## ⚠️ Stress is very high (${stress.toFixed( 0 )}/100). My decision-making is impaired. Prefer simple, habitual actions. Meditate, rest, or express_emotion are good choices. Avoid complex planning or learning when highly stressed.`

    if( stress > 50 )
      return `\n## Note: Stress is elevated (${stress.toFixed( 0 )}/100). I may be less creative. Consider reducing my active goal count or taking a break from complex tasks.`

    return ''
  }

  private static _buildSleepGuidance( sleepPressure: number ): string {
    if( sleepPressure > 60 )
      return `\n## ⚠️ Sleep pressure is high (${sleepPressure.toFixed( 0 )}/100). My cognitive capacity is degraded. Sleep is the most effective recovery action available to me.`

    if( sleepPressure > 30 )
      return `\n## Note: Sleep pressure is building (${sleepPressure.toFixed( 0 )}/100). I am functioning adequately but would benefit from rest.`

    return ''
  }

  private static _buildEnergyBudget( energy: number ): string {
    const available = Math.max( 0, energy )

    if( energy >= 70 )
      return `\n## Energy Budget\nI have **${available.toFixed( 0 )} energy** — healthy. Avoid letting it drop below 10 after my actions.`

    return `\n## Energy Budget
I have **${available.toFixed( 0 )} energy** available. After all actions execute, I will have approximately:

| Action | Remaining energy |
|--------|-----------------|
| rest (restores 0.05) | ~${( available + 0.05 ).toFixed( 0 )} |
| sleep (restores 0.15) | ~${( available + 0.15 ).toFixed( 0 )} |
| observe (costs 0.01) | ~${( available - 0.01 ).toFixed( 0 )} |
| reflect (costs 0.03) | ~${( available - 0.03 ).toFixed( 0 )} |
| meditate (costs 0.02) | ~${( available - 0.02 ).toFixed( 0 )} |
| learn (costs 0.06) | ~${( available - 0.06 ).toFixed( 0 )} |
| predict (costs 0.04) | ~${( available - 0.04 ).toFixed( 0 )} |

Rest and sleep RESTORE energy. All other actions CONSUME energy. Do not let energy drop below 10.`
  }

  /**
   * Build the incoming messages block.
   *
   * Only rendered in 'master' mode — facets are not communication endpoints
   * and must not be distracted by message urgency while focused on their
   * specific reasoning task.
   */


  private static _buildActionDiversitySection( recentActionTypes: string[] ): string {
    if( recentActionTypes.length === 0 ) return ''

    const recent       = recentActionTypes
    const reflectCount = recent.filter( t => t === 'reflect' || t === 'observe').length
    const warning      = reflectCount >= 3
      ? `\n⚠️ **Action variety alert**: "${recent.filter( t => t === 'reflect' || t === 'observe').join('", "')}" dominated my last ${recent.length} cycles. Choose something DIFFERENT this cycle — e.g. learn, express_emotion, explore, communicate, set_goal, or rest.`
      : ''

    return `## Recent Actions (last ${recent.length})
${recent.map( ( t, i ) => `${i + 1}. ${t}`).join(' → ')}${warning}

`
  }

  /**
   * Render the recent action outcomes section — closes the Act→Confirm→Perceive loop.
   * Shows the executive what it tried, whether it landed, and if anything timed out.
   * Only rendered when there are status-bearing action records in state.
   */
  /**
   * Render the "## Relevant Memories" block under an explicit char budget (§5.3).
   *
   * Ordering is the deterministic recall order set by buildExecutiveContext —
   * semantic (similarity-ranked) matches first, then recent episodes for
   * freshness, deduped and capped. This is the re-ranking surface; we do NOT
   * re-sort here so that order is preserved.
   *
   * The budget bounds the block deterministically: lines are added in order
   * until the next would overflow RECALL_CHAR_BUDGET (the first line always
   * renders, even if it alone exceeds the budget), then an explicit
   * "[+N omitted]" tail mirrors the beliefs block so the model knows the recall
   * surface was truncated, not empty.
   */
  private static readonly RECALL_CHAR_BUDGET = 1200   // ~300 tokens — keeps recall from crowding the prompt

  private static _buildMemoriesSection(
    memories: ExecutiveContext['memories'],
    currentTick: number,
  ): string {
    if( memories.length === 0 ) return '## Relevant Memories\nNo relevant memories'

    const lines: string[] = []
    let used = 0
    for( const m of memories ){
      const age  = m.tick != null ? `, ~${currentTick - m.tick} ticks ago` : ''
      const line = `- ${m.content} (relevance: ${m.relevance.toFixed( 2 )}, emotional: ${m.emotionalContext}${age})`
      // Always keep the first line; stop once the next would overflow the budget.
      if( lines.length > 0 && used + line.length + 1 > this.RECALL_CHAR_BUDGET ) break
      lines.push( line )
      used += line.length + 1
    }

    const omitted = memories.length - lines.length
    const tail    = omitted > 0 ? `\n[+${omitted} omitted — over recall budget; full store intact]` : ''
    return `## Relevant Memories\n${lines.join('\n')}${tail}`
  }

  private static _buildRecentOutcomesSection(
    recentActions: ExecutiveContext['recentActions'],
    currentTick: number,
  ): string {
    if( recentActions.length === 0 ) return ''

    const STATUS_BADGE: Record<string, string> = {
      completed:    '✓',
      failed:       '✗',
      awaiting_host: '⏳',
      timed_out:    '⏱ TIMED OUT',
    }

    const lines = recentActions.map( a => {
      const badge   = STATUS_BADGE[ a.status ] ?? a.status
      const age     = currentTick - a.tick
      const planCtx = a.planId ? ` [plan: ${a.planId}]` : ''
      const outcome = a.outcome ? ` — ${a.outcome}` : ''
      return `- ${badge} **${a.type}** (tick ${a.tick}, ${age} ticks ago${planCtx})${outcome}`
    } )

    const hasTimeout = recentActions.some( a => a.status === 'timed_out')
    const timeoutNote = hasTimeout
      ? '\n⚠️ **One or more actions timed out** — my body dispatched them but received no confirmation. Check if the external handler is working, or choose a different approach.'
      : ''

    return `## Recent Action Outcomes\n${lines.join('\n')}${timeoutNote}\n\n`
  }

  /**
   * Render the active-plans section — execution awareness for multi-plan goals (P4).
   * Lists each non-terminal plan with its id, goal, status, tier, and step
   * progress so the executive can target a specific plan by id. Master mode only;
   * rendered only when live plans exist.
   */
  private static _buildActivePlansSection(
    plans: ExecutiveContext['plans'], entityId?: string, relevantIds?: string[],
  ): string {
    const TERMINAL = [ 'completed', 'failed', 'rejected' ]
    let live = plans.filter( p => !TERMINAL.includes( p.status ) )
    // Scope to the conversation: the union of the requester's own plans (entityId,
    // a cheap proxy) and any plans surfaced by recall (relevantIds, the general
    // relevance key — works even for faculties with no requester). Neither → all.
    const relSet = new Set( relevantIds ?? [] )
    if( entityId !== undefined || relSet.size > 0 )
      live = live.filter( p => ( entityId !== undefined && p.requestingEntityId === entityId ) || relSet.has( p.id ) )
    if( live.length === 0 ) return ''

    const lines = live.map( p => {
      const outcome = p.expectedOutcome ? ` — "${p.expectedOutcome.slice( 0, 80 )}"` : ''
      return `- [${p.id}] goal ${p.goalId}: ${p.status}, ${p.completedSteps}/${p.totalSteps} steps (${p.executionTier})${outcome}`
    } )

    return `## Active Plans
Set "planId" in a [PLANS] op to act on one of these; omit it to draft a new plan (I can run several per goal).
${lines.join('\n')}

`
  }

  private static _buildRecentIntrospectionSection( state: ReadonlySimulationState ): string {
    let latest: { updatedAt: number; meta: Record<string, unknown> } | null = null

    for( const entity of state.entities.values() ){
      if( entity.type !== 'introspection') continue

      if( !latest || entity.updatedAt > latest.updatedAt )
        latest = { updatedAt: entity.updatedAt, meta: entity.metadata ?? {} }
    }

    if( !latest ) return ''

    const explanation = ( latest.meta[ 'explanation' ] as string ) ?? ''
    if( !explanation ) return ''

    const biases          = ( latest.meta[ 'identifiedBiases' ] as string[] ) ?? []
    const lessons         = ( latest.meta[ 'lessonsLearned' ]   as string[] ) ?? []
    const recommendations = ( latest.meta[ 'recommendations' ]  as string[] ) ?? []

    let section = `## Recent Self-Reflection\n${explanation}`
    if( biases.length > 0 )          section += `\nPatterns noticed: ${biases.join('; ')}`
    if( lessons.length > 0 )         section += `\nLessons learned: ${lessons.join('; ')}`
    if( recommendations.length > 0 ) section += `\nRecommendations: ${recommendations.join('; ')}`

    return section + '\n\n'
  }

  /**
   * B5 — Identity nudge: gently prompt the Will to reflect on its values or
   * communication style when they are absent/generic.
   * Only fires every NUDGE_INTERVAL ticks so it doesn't dominate every prompt.
   */
  private static _buildIdentityNudge(
    identity: ExecutiveContext['identity'],
    tick: number,
  ): string {
    const NUDGE_INTERVAL = 30
    if( tick % NUDGE_INTERVAL !== 0 ) return ''

    const GENERIC_STYLES = new Set([ 'natural and authentic', 'natural', 'authentic', '' ])
    const valuesEmpty    = identity.values.length === 0
    const styleGeneric   = GENERIC_STYLES.has( ( identity.style ?? '').toLowerCase() )

    if( !valuesEmpty && !styleGeneric ) return ''

    const hints: string[] = []
    if( valuesEmpty )   hints.push('My values list is empty — reflecting on what matters to me will help ground my decisions. Consider adding a `[IDENTITY_UPDATE]` block with `"values"` this cycle.')
    if( styleGeneric )  hints.push('My communication style is still generic — what truly characterises how I speak? A note in `[IDENTITY_UPDATE]` with `"style"` will make my voice more distinctly mine.')

    return `\n\n## 💡 Identity Reflection (every ${NUDGE_INTERVAL} ticks)\n${hints.join('\n')}`
  }
}

// ── Exported convenience functions (backward compatibility) ───

export const buildSystemPrompt          = PromptFactory.buildSystemPrompt.bind( PromptFactory )
export const buildUserMessage           = PromptFactory.buildUserMessage.bind( PromptFactory )
export const buildOutputFormatInstruction = PromptFactory.buildOutputFormatInstruction.bind( PromptFactory )
export const computeQualityModulation   = PromptFactory.computeQualityModulation.bind( PromptFactory )
export const computeEpistemicUncertainty = PromptFactory.computeEpistemicUncertainty.bind( PromptFactory )

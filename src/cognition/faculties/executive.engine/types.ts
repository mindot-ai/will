// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/types.ts
// ─────────────────────────────────────────────────────────────

import type { CognitiveBus } from '#cognition/bus'
import type { PlanStep } from '#cognition/faculties/planning.engine/engine'

// ── Full executive output ────────────────────────────────────

export interface ExecutiveOutputFull {
  actions: Array<{
    type: string; reasoning: string; expectedOutcome: string; target?: string
    /**
     * Arguments the executive consciously supplies when enacting an ability
     * that needs them (e.g. a search ability's query). Ride the ideomotor
     * intent into the affordance competition and, if the action wins, reach
     * the host handler as the invocation's parameters.
     */
    args?: Record<string, unknown>
  }>
  reasoning: string
  confidence: number
  /** Plans — the executive controls lifecycle via status + action fields */
  plans?: ExecutivePlanOutput[]
  newBeliefs?: Array<{
    statement: string
    category: string
    confidence: number
    /**
     * Evidence strength — replaces the hallucination-prone numeric count.
     * The LLM picks a categorical label it can honestly assign; the runtime
     * maps it to a numeric `supportingEpisodes` value for the belief store.
     */
    evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern'
    tags: string[]
  }>
  introspection?: {
    explanation: string
    identifiedBiases: string[]
    lessonsLearned: string[]
    recommendations: string[]
  }
  narrative?: string
  narrativeThemes?: string[]
  currentSelfView?: string
  identityUpdates?: {
    traits: Array<{ key: string; value: number }>
    values: string[]
  }
  /**
   * What the Will consciously learned about the *others* it is dealing with (the analogue
   * of identityUpdates, but about someone/something else). `keid` is the referent from the
   * known-entity dossier / "## People I Know" context. `name` is a learned identifying
   * name; `learned` are facts (→ keid-tagged social beliefs, so they ride the memory
   * pipeline); `feeling` is a felt valence toward them (a bounded nudge).
   */
  knownEntityUpdates?: Array<{
    keid:     string
    name?:    string
    learned?: string[]
    feeling?: number
    /**
     * "This is the same someone as that" — another keid I now believe is this
     * same referent, fusing two of my records into one.
     *
     * The mind's own verdict on an identity, and it may do what the recognition
     * heuristic will not: absorb an ESTABLISHED relationship. The heuristic is
     * right to refuse — fusing two real people who share a name would take one of
     * them's whole history — but the mind has evidence a name-match does not,
     * usually because somebody just told it. Without this, the same human
     * well-established on two channels stayed two people permanently.
     */
    sameAs?:  string
  }>
  newGoals?: Array<{
    description: string
    priority: number
    tags: string[]
    completionType: string
    completionCondition?: string
  }>
  goalsToAbandon?: Array<{ goalId: string; reason: string }>
  goalsToReprioritize?: Array<{ goalId: string; newPriority: number; reason: string }>
  selfObservations?: string[]
  /** Compound actions the mind is naming as single skills (see ProposedSkill). */
  newSkills?: ProposedSkill[]
  /**
   * Plain-text reply from a conversation facet — populated by parseResponse()
   * from the [REPLY_TEXT]...[/REPLY_TEXT] block.
   * Only present in facet mode (AuditionEngine). Undefined for master cycles.
   * Paragraphs (double-newline separated) map to separate reply bubbles.
   */
  replyText?: string
  /**
   * Set when the facet declared it is NOT speaking this cycle, carrying why.
   * Present ⇒ nothing is sent, whatever else the response contains.
   */
  noMessage?: string
  /**
   * @deprecated Legacy JSON reply format — no longer emitted by conversation facets.
   * Kept for backward compatibility with any tests/tooling that inspect parsed output.
   */
  conversationReplies?: Array<{
    targetEntityId: string
    targetEntityName: string
    messages: string[]
  }>
  /**
   * System 2 only — the distinct approaches the master generated and weighed before
   * committing, retained for explainability/auditability (and a future regret /
   * counterfactual substrate). Populated on the deliberate (propose→evaluate) path;
   * undefined for System 1 (the fast single-shot).
   */
  consideredAlternatives?: string[]
}

// ── Ideation (System 2 propose pass) ─────────────────────────

/**
 * One candidate approach from the deliberate path's ideation (propose) pass — a
 * divergent option the master generated *before* deciding. The evaluate pass weighs
 * these and commits; the chosen-against set is retained as `consideredAlternatives`.
 */
export interface IdeationCandidate {
  /** Short handle for the option (e.g. "ask for clarification"). */
  approach: string
  /** One-line description of what this option concretely entails. */
  description: string
  /** Its main upside. */
  upside: string
  /** Its main risk or downside. */
  risk: string
}

/** Output of the ideation (propose) pass — a divergent candidate set, not a decision. */
export interface IdeationOutput {
  candidates: IdeationCandidate[]
}

/**
 * Plan output from the executive LLM.
 *
 * This is what the LLM produces in the [PLANS] tagged block.
 * It includes lifecycle control fields (status, action, executionTier,
 * expectedOutcome) that only the executive sets, plus the step structure
 * that feeds into PlanningEngine's Plan type.
 */
export interface ExecutivePlanOutput {
  /**
   * Target an EXISTING plan for validate/execute/revise/cancel. Omit on a fresh
   * `draft` to create a new plan. Enables managing multiple plans per goal (P4);
   * when omitted, the op falls back to the goal's active plan.
   */
  planId?: string
  goalId: string
  /** Lifecycle stage the executive is setting */
  status: 'draft' | 'validated' | 'approved' | 'revised' | 'rejected'
  /** What PlanningEngine should do with this plan */
  action: 'draft' | 'validate' | 'execute' | 'revise' | 'cancel'
  /** Concrete description of what successful completion looks like */
  expectedOutcome?: string
  /** The steps — mirrors PlanStep structure from PlanningEngine */
  steps: Array<Pick<PlanStep, 'action' | 'description' | 'expectedOutcome' | 'estimatedDuration' | 'prerequisites'>>
  estimatedCost: number
  feasibility: number
}

// ── Minimal output from LLM (before tagged-block parsing) ────

export interface ExecutiveOutputMinimal {
  actions: Array<{ type: string; reasoning: string; expectedOutcome: string; target?: string; args?: Record<string, unknown> }>
  reasoning: string
  confidence: number
}

// ── Engine config ────────────────────────────────────────────

export interface ExecutiveEngineConfig {
  executiveInterval?: number
  cooldownTicks?: number
  bus?: CognitiveBus
}

// ── Context ──────────────────────────────────────────────────

export type ExecutiveAttentionType = 'available' | 'full'
export interface ExecutiveContext {
  identity: {
    /** Canonical persona name — from WillConfig.name (e.g. "Aria", "Guard-1"). */
    name: string
    prompt: string
    values: string[]
    traits: Record<string, number>
    /**
     * Per-trait self-knowledge (personal baseline + recent-shift direction) accumulated
     * by the self-model, for graded-salience options B (relative to my own norm) and C
     * ("rising/easing lately"). Absent until the self-model has evaluated at least once.
     */
    traitStats?: Record<string, { mean: number; shiftDir: number; shiftTick: number }>
    style: string
  }
  worldState: {
    energyLevel: number
    sleepPressure: number
    stressLoad: number
    circadianPhase: number
    timeOfDay: number
    /**
     * Tonic threat level (0–1). Always present in the standing context so a
     * *sustained* threat stays represented even after its events habituate out of
     * the workspace — representation (this) is kept separate from attention
     * (event salience). See reward/threat Option-B salience.
     */
    threatLevel: number
  }
  affect: {
    dominantEmotion: string
    valence: number
    arousal: number
    dominance: number
    blends: string[]
  }
  goals: Array<{
    id: string
    description: string
    priority: number
    progress: number
    status: string
    deadline?: number
    lastActionAttemptTick?: number
    lastActionType?: string
  }>
  /**
   * Active/known plans, read from persisted `plan` entities — gives the executive
   * execution awareness: which plans exist per goal, their status and step
   * progress, so it can target a specific plan by id when managing several. (P4)
   */
  plans: Array<{
    id: string
    goalId: string
    status: string
    executionTier: string
    totalSteps: number
    completedSteps: number
    expectedOutcome: string
    /** Causal link to the requester whose message spawned the plan (for scoping). */
    requestingEntityId?: string
  }>
  /**
   * Plan ids surfaced by the latest episodic recall (plan descriptors carry their
   * planId) — drives recall-scoped plan awareness (AWARENESS Stage 2). Generalizes
   * the scope filter from `requestingEntityId` to relevance.
   */
  relevantPlanIds: string[]
  percepts: Array<{
    category: string
    summary: string
    salience: number
  }>
  /**
   * Host-declared abilities afforded to the Will *right now* — what it can do in
   * this situation and what each is for. Surfaced so System 2 reasons with
   * knowledge of its options; the Will still expresses intent (it does not fill a
   * tool form) and the agency field competes + binds. Only *available* external
   * affordances appear; absent when there are none.
   */
  abilities?: Array<{
    name: string
    description?: string
    /** Bound target's display name, when the ability is directed at someone. */
    target?: string
  }>
  workingMemory: Array<{
    type: string
    summary: string
    activation: number
  }>
  memories: Array<{
    content: string
    relevance: number
    emotionalContext: string
    /** Simulation tick when this memory was consolidated. Used to render approximate age. */
    tick?: number
  }>
  beliefs: Array<{
    statement: string
    category: string
    confidence: number
  }>
  /** How many beliefs exist but were not included due to the relevance cap. */
  beliefsOmitted: number
  /**
   * What became of what it did — the Act→Confirm→Perceive loop, surfaced.
   *
   * Built from `action.record` entities the executive writes from the
   * `action.outcome` / `action.withheld` events it already receives. It used to
   * be built from `decision.record` entities carrying an `actionStatus`, a field
   * read in one place and written in none — so this was empty in every prompt a
   * live mind ever received, and it could see what it had SAID but never what it
   * had DONE. See `action.record.ts`.
   */
  recentActions: Array<{
    /** Effector name that was invoked */
    type: string
    /** How it resolved. `withheld` is distinct from `failed` on purpose: the
     *  mind formed the act and chose not to complete it. */
    status: 'completed' | 'failed' | 'withheld'
    /** Tick the action was executed or dispatched */
    tick: number
    /** Short outcome description — truncated to 120 chars */
    outcome: string
    /** planId if this action came from a plan step */
    planId?: string
  }>
  /**
   * What the mind has said to people lately, and who has answered.
   *
   * The one thing it could never see about itself. `conversation.sent` has been in
   * state since the beginning — 57 records on the Will this was found on — and
   * reached no prompt at all, so the sole evidence of having spoken was a `✓
   * reach-out` line under Recent Action Outcomes: no words, no person, and a tick
   * mark asserting it had worked. That is why the same question went out eleven
   * times in two and a half minutes; from the inside each one was the first.
   *
   * Newest first. Answered turns are kept alongside open ones deliberately — "I
   * asked and they replied" and "I asked and heard nothing" only mean anything
   * against each other.
   */
  spokenTurns: Array<{
    /** Who it was said to, by name where the mind knows one. */
    target:  string
    /** The opening words — enough to recognise a thing already said. */
    preview: string
    /** Ticks since it was said. */
    age:     number
    /** Unset while still in the air; the mind is told which. */
    answered: boolean
    /** What they said back, when they did. The fact of an answer without its
     *  content is worse than silence — it invites acting as though it is known. */
    answeredWith?: string
  }>
  /** Behavioral disposition loaded from PMA at session start — stable per session. */
  behavioralDisposition?: {
    riskTolerance:   number
    explorationRate: number
    impulsivity:     number
  }
  /**
   * How the Will has self-tuned its own faculties (the metacognition cycle's
   * persona-prior), as first-person phrases — lets the deliberate self see its
   * own accommodation. Omitted when no prior is active.
   */
  selfTuning?: string[]
  /**
   * What the Will knows about the others it has encountered — the known-entity dossier
   * view, surfaced for reasoning. Joins theory-of-mind (what they seem to want/feel),
   * reputation (trust/cooperativeness/reliability) and attachment (closeness) per `keid`,
   * sorted by interaction recency, capped. `name` may be absent — the Will can know
   * *someone* without yet knowing their name (provisional identity). `kind` is `sentient`
   * for everything modelled here today; `thing` arrives with the generalised dossier.
   * Omitted when the Will knows no one.
   */
  knownEntities?: Array<{
    /** Where this referent is reachable, and how each place has gone. */
    handles?: Array<{ keid: string; kind: string; answeredAgo?: number }>
    /** Names of referents this one may be the same as — an unsettled identity. */
    mayBeSameAs?: string[]
    keid:            string
    kind:            'sentient' | 'thing'
    name?:           string
    intention?:      string
    emotion?:        string
    trust?:          number
    cooperativeness?: number
    closeness?:      number
    reliability?:    number
    confidence?:     number
  }>
  /**
   * What the Will is currently focused on (task.switcher) and how committed — surfaces
   * task-persistence so the deliberate self weighs the cost of switching away. The
   * `switchCost` (= effective `baseSwitchCost`, conscientiousness-developable, #28) scales
   * how strong the pull to stay is. Omitted when nothing is in focus.
   */
  currentFocus?: {
    goalId:          string
    goalDescription?: string
    focusTicks:      number
    switchCost:      number
  }
}

// ── Pending message ──────────────────────────────────────────

/**
 * A compound action the mind names as one thing it does — "when I do A then B,
 * that is <name>". Registered into the SchemaRepertoire as a composite, after
 * which it competes as a single affordance and can proceduralize into a habit.
 *
 * This is the creation seam for the instrumental→habitual gradient. Before it,
 * `agency.composite.proposed` was subscribed by ReafferenceEngine — whose handler
 * is the only caller of `registerComposite()` anywhere — and published by nothing,
 * so no Will could ever hold a skill beyond the innate floor (#114).
 */
export interface ProposedSkill {
  /** What the mind calls it. Becomes the schema id. */
  id: string
  /** The sub-schemas it is made of, in order. Two or more, or it is not compound. */
  composedOf: string[]
  tags?: string[]
  cost?: number
}

export interface PendingMessage {
  id: string
  content: string
  sender: string
  senderId: string
  tick: number
}
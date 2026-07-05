// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/types.ts
// ─────────────────────────────────────────────────────────────

import type { CognitiveBus } from '#cognition/bus'
import type { PlanStep } from '#cognition/faculties/planning.engine/engine'

// ── Full executive output ────────────────────────────────────

export interface ExecutiveOutputFull {
  actions: Array<{ type: string; reasoning: string; expectedOutcome: string; target?: string }>
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
   * known-entity dossier / "## People You Know" context. `name` is a learned identifying
   * name; `learned` are facts (→ keid-tagged social beliefs, so they ride the memory
   * pipeline); `feeling` is a felt valence toward them (a bounded nudge).
   */
  knownEntityUpdates?: Array<{
    keid:     string
    name?:    string
    learned?: string[]
    feeling?: number
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
  /**
   * Plain-text reply from a conversation facet — populated by parseResponse()
   * from the [REPLY_TEXT]...[/REPLY_TEXT] block.
   * Only present in facet mode (AuditionEngine). Undefined for master cycles.
   * Paragraphs (double-newline separated) map to separate reply bubbles.
   */
  replyText?: string
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
  actions: Array<{ type: string; reasoning: string; expectedOutcome: string; target?: string }>
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
   * Recent action outcomes — shows the executive what it already tried and whether it
   * landed.  Built from `decision.record` entities with an `actionStatus` set.
   * Surfaces the Act→Confirm→Perceive feedback loop into the executive's reasoning.
   */
  recentActions: Array<{
    /** Effector name that was invoked */
    type: string
    /** Lifecycle status set by ActionExecutor */
    status: 'completed' | 'failed' | 'awaiting_host' | 'timed_out'
    /** Tick the action was executed or dispatched */
    tick: number
    /** Short outcome description — truncated to 120 chars */
    outcome: string
    /** planId if this action came from a plan step */
    planId?: string
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

export interface PendingMessage {
  id: string
  content: string
  sender: string
  senderId: string
  tick: number
}
// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning/types.ts — shared planning types
// ─────────────────────────────────────────────────────────────
//
// Extracted verbatim from planning.engine.ts (the 1,500-line file split along
// its natural seams: types / store / frontier / supervision / engine shell).
// All names are re-exported by planning.engine.ts — external imports unchanged.
// ─────────────────────────────────────────────────────────────

import type { Tick } from '#core/types'
import type { CognitiveBus } from '#cognition/bus'

export interface Plan {
  id: string
  goalId: string
  steps: PlanStep[]
  estimatedCost: number
  confidence: number
  /** Full lifecycle: draft → validated → approved → ready → executing → completed/failed/rejected */
  status: 'draft' | 'validated' | 'approved' | 'ready' | 'executing' | 'paused' | 'completed' | 'failed' | 'rejected' | 'revised'
  executionTier: 'deliberate' | 'automatic'
  /** Concrete description of what successful completion looks like — set by executive */
  expectedOutcome: string
  createdAt: Tick
  /**
   * Causal link — the entity whose message triggered the goal that spawned this plan.
   * Copied from GoalState.requestingEntityId at plan-creation time.
   * Stamped on all bus events so the activity SSE stream can filter by entity.
   */
  requestingEntityId?: string
  /** Matching thread ID for reply correlation. */
  requestingThreadId?: string
}

export interface PlanStep {
  id: string
  order: number
  /**
   * Advisory suggested schema — the action this step would LIKE to recruit. It is
   * projected as a `plan.prior` that biases the competition toward this schema; it
   * is NOT dispatched. If the schema does not resolve in the repertoire the prior
   * cannot surface and the plan waits / replans (no forced execution of a string).
   */
  action: string
  description: string
  expectedOutcome: string
  prerequisites: string[]
  estimatedDuration: number
  /** `active` = on the frontier, biasing the competition this tick (was `dispatched`). */
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped'
  /** Optional entity the step's action is directed at — biases goal-relevance + binds the affordance. */
  targetEntityId?: string
  /** Optional schema tags to route the prior (currently unused by projection; reserved). */
  tags?: string[]
  /** Re-attempt count (the `retry` directive); capped by maxStepRetries. */
  retries?: number
  /** The outcome from ActionExecutor when the step completes */
  outcome?: {
    success: boolean
    description: string
    outcomeQuality: number
  }
}

export interface PlanContext {
  goalId: string
  goalDescription: string
  /** Concrete description of what successful completion looks like */
  expectedOutcome: string
  steps: Array<{
    id: string
    action: string
    description: string
    expectedOutcome: string
    status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped'
    prerequisites: string[]
  }>
  totalSteps: number
  completedSteps: number
  skippedSteps: string[]  // stepIds that were skipped, not completed
  executionTier: 'deliberate' | 'automatic'
}

/**
 * A normalised activity event forwarded to activity-stream listeners.
 * Maps 1-to-1 onto the SSE event types emitted by GET /wills/:id/activity.
 */
export interface ActivityEvent {
  /** SSE event type name. */
  type: 'plan_started' | 'step_activated' | 'step_outcome' | 'plan_complete' | 'plan_failed' | 'plan_cancelled'
  planId: string
  goalId?: string
  requestingEntityId?: string
  requestingThreadId?: string
  /** Additional per-event fields (steps, outcomes, etc.). */
  [key: string]: unknown
}

export type ActivityEventHandler = ( event: ActivityEvent ) => void

export interface PlanningEngineConfig {
  bus?: CognitiveBus
  /**
   * Ticks a terminal (completed/failed/rejected) plan is retained before it and
   * its state entity are GC'd. Bounds unbounded plan accretion on long-lived
   * minds. Default 300.
   */
  planRetentionTicks?: number
  /**
   * Emergent-supervision thresholds. The executive no longer sets the tier; the
   * engine starts a plan `deliberate` when its goal is important (top-down) or the
   * plan is uncertain, and escalates an `automatic` plan to `deliberate` on a
   * surprising step outcome (bottom-up). All extensible in _inferInitialTier /
   * _shouldEscalate.
   */
  deliberateGoalPriority?: number   // goal priority ≥ this → start deliberate (default 0.7)
  lowPlanConfidence?: number        // plan confidence < this → start deliberate (default 0.5)
  surpriseOutcomeQuality?: number   // step outcomeQuality < this → escalate (default 0.25)
  maxStepRetries?: number           // cap on the `retry` directive per step (default 3)
}

/**
 * Trait-driven dispositions, refreshed from the persona-prior mirror each tick
 * (Channel A) and read LIVE by the store/frontier/supervisor. One mutable object
 * owned by the engine — a single source of truth instead of copies drifting
 * across the split modules.
 */
export interface PlanningDispositions {
  deliberateGoalPriority: number
  lowPlanConfidence: number
  surpriseOutcomeQuality: number
  maxStepRetries: number
  /** Channel A: how hard the plan asserts its frontier in the action competition
   *  (base 1 ⊕ conscientiousness prior). Multiplies the projected plan-prior bias. */
  planBiasGain: number
}

/** Terminal plan statuses — never change again once entered. */
export const TERMINAL_STATUSES: readonly string[] = [ 'completed', 'failed', 'rejected' ]

export function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

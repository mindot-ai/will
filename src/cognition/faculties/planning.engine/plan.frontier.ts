// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning.engine/plan.frontier.ts — the ready frontier
// ─────────────────────────────────────────────────────────────
//
// Planning-as-prior's mechanical heart: resolve the prerequisite DAG to find the
// ready frontier, and project active steps as transient `plan.prior` entities the
// AffordanceSynthesizer turns into competing affordances. A prior BIASES the one
// action competition — it never dispatches (see the engine header).
//
// Pure functions over (plan, state) — no engine state, no bus. Extracted
// verbatim from planning.engine.ts; behavior identical.
// ─────────────────────────────────────────────────────────────

import type { Tick, ReadonlySimulationState, StateCommands } from '#core/types'
import { clamp01, type Plan, type PlanStep } from '#faculties/planning.engine/types'

/** Steps whose prerequisites are all completed/skipped — ready to activate. */
export function computeReadySet( plan: Plan ): PlanStep[] {
  const ready: PlanStep[] = []

  for( const step of plan.steps ){
    if( step.status !== 'pending' ) continue

    const allPrereqsSatisfied = step.prerequisites.every( prereqId => {
      const prereqStep = plan.steps.find( s => s.id === prereqId )
      return prereqStep && ( prereqStep.status === 'completed' || prereqStep.status === 'skipped' )
    } )

    allPrereqsSatisfied && ready.push( step )
  }

  return ready
}

/**
 * Project every executing plan's active frontier as transient `plan.prior`
 * entities — the top-down bias the AffordanceSynthesizer reads. Rebuilt each tick
 * (cleared then re-emitted, like the affordance field), so a frontier that
 * advances or a plan that ends stops biasing automatically. The prior carries the
 * planId/stepId provenance that flows affordance → intent → action.outcome, and a
 * `planBias` strength from the goal's importance ⊕ the plan's confidence. It never
 * forces an action — if a more pressing affordance wins, the plan re-projects next
 * tick (no orphaning).
 */
export function projectFrontier(
  plans:        Iterable<Plan>,
  commands:     StateCommands,
  tick:         Tick,
  state:        ReadonlySimulationState,
  goalPriority: ( goalId: string ) => number,
  biasGain:     number,
): void {
  // Clear the previous tick's priors — they are transient.
  for( const [ id, e ] of state.entities )
    if( e.type === 'plan.prior' ) commands.delete!.push( id )

  for( const plan of plans ){
    if( plan.status !== 'executing' ) continue

    // Channel A: conscientiousness develops `planBiasGain` UP, so a conscientious
    // Will pushes its plan's frontier harder against competing impulses.
    const strength = clamp01( ( 0.5 * goalPriority( plan.goalId ) + 0.5 * plan.confidence ) * biasGain )

    for( const step of plan.steps ){
      if( step.status !== 'active' ) continue
      commands.set!.push({
        // tick in the id (like the affordance field) so this tick's fresh prior
        // never collides with last tick's cleared one in the same command batch.
        id:   `plan-prior-${ tick }-${ plan.id }-${ step.id }`,
        type: 'plan.prior',
        metadata: {
          schema:         step.action,        // advisory suggested schema (not dispatched)
          planId:         plan.id,
          stepId:         step.id,
          planBias:       strength,
          targetEntityId: step.targetEntityId,
          parameters:     {},
          tick,
        },
      })
    }
  }
}

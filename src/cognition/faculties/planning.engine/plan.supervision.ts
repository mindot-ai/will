// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning.engine/plan.supervision.ts — the judgment faculty
// ─────────────────────────────────────────────────────────────
//
// Deliberate-tier supervision: a facet of the executive consciousness watches a
// plan's execution, judges each step outcome against the plan's expectedOutcome,
// and issues a supervisory directive (continue / retry / skip / pause / replan /
// escalate / abandon / complete). This module owns:
//
//   • emergent-tier inference — important/uncertain plans start deliberate
//     (top-down); an automatic plan escalates on a surprising outcome (bottom-up);
//   • the facet lifecycle (spawn via the ExecutiveEngine, reap-degradation,
//     teardown) and the plan-focus that defines the judgment vocabulary;
//   • step reporting (facts only — the facet IS the executive's cognition; the
//     engine reports state, never prescribes the decision);
//   • directive dispatch — effects flow back into the engine through the narrow
//     SupervisionHost interface, keeping the dependency one-directional.
//
// Extracted verbatim from planning.engine.ts — prompt strings byte-identical
// (the replay-equivalence capstone gates this: any drift breaks byte-identity).
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { ExecutiveFacetHandle, FacetReport, FacetDecision } from '#faculties/executive.engine/facet'
import type { FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { GoalManager } from '#faculties/goal.manager'
import type { Plan, PlanStep, PlanContext, PlanningDispositions } from '#faculties/planning.engine/types'

/**
 * The engine-side effects a supervisory directive can trigger. Narrow by design:
 * the supervisor judges and directs; the engine executes and owns plan lifecycle.
 */
export interface SupervisionHost {
  /** Re-run the execution pass (advance the frontier after a directive). */
  executePlans(): void
  /** Terminal transitions — the engine owns status, terminal bookkeeping + bus events. */
  planCompleted( plan: Plan ): void
  planFailed( plan: Plan, reason: string ): void
  /** Publish a planning bus event (plan.escalated / plan.replanned). */
  publish( event: { type: string; version: number; salience: number; payload: Record<string, unknown> } ): void
}

export class PlanSupervisor {
  private _activeFacets = new Map<string, ExecutiveFacetHandle>()

  /**
   * Cumulative count of each supervisory directive the facet has issued
   * (continue/retry/skip/pause/replan/escalate/abandon/complete). Pure observability —
   * surfaced as `planning.supervision.*` metrics so the planning-quality eval harness
   * can measure how the mind supervises execution (how often it corrects course). Not
   * restored from snapshot; re-accrues deterministically as the same decisions replay.
   */
  private _supervisionCounts = new Map<string, number>()

  constructor(
    private readonly _host: SupervisionHost,
    private readonly _dispositions: PlanningDispositions,
  ){}

  private _executiveEngine: ExecutiveEngine | null = null
  private _goalManager: GoalManager | null = null

  attachExecutiveEngine( oe: ExecutiveEngine ): void { this._executiveEngine = oe }
  attachGoalManager( gm: GoalManager ): void { this._goalManager = gm }

  // ── Observability ──────────────────────────────────────────

  get activeFacetCount(): number { return this._activeFacets.size }
  supervisionCount( directive: string ): number { return this._supervisionCounts.get( directive ) ?? 0 }
  hasFacet( planId: string ): boolean { return this._activeFacets.has( planId ) }

  // ── Supervision inference (emergent tier) ──────────────────

  /**
   * Top-down initial supervision mode for a plan being launched. Important
   * (high-priority goal) or uncertain (low-confidence) plans are supervised from
   * the first step; everything else runs automatically. Pure + deterministic.
   */
  inferInitialTier( plan: Plan ): 'automatic' | 'deliberate' {
    const priority = this._goalManager?.getGoal( plan.goalId )?.priority ?? 0
    if( priority >= this._dispositions.deliberateGoalPriority ) return 'deliberate'
    if( plan.confidence < this._dispositions.lowPlanConfidence ) return 'deliberate'
    return 'automatic'
  }

  /**
   * Bottom-up: should an AUTOMATIC plan recruit deliberate supervision on this step
   * outcome? Surprise (failure / outcome well below expectation) captures attention.
   * EXTENSION POINT — add triggers here (timeouts, prediction error, repeated
   * retries, threat/stress spikes, …) as more edge cases surface.
   */
  shouldEscalate(
    _plan: Plan, _step: PlanStep, outcome: { success: boolean; outcomeQuality: number }
  ): boolean {
    if( !outcome.success ) return true                                  // a failure always demands attention
    if( outcome.outcomeQuality < this._dispositions.surpriseOutcomeQuality ) return true   // succeeded, but well below expectation
    return false
  }

  // ── Facet lifecycle ────────────────────────────────────────

  activateFacet( plan: Plan, prime: boolean = true ): void {
    if( !this._executiveEngine ) return

    try {
      const { attention, handle: facet } = this._executiveEngine.spawnFacet('supervision')
      if( !facet || attention === 'full'){
        plan.executionTier = 'automatic'
        logger.info(`[planning] attention full — plan ${plan.id} stays automatic (no facet)`)
        return
      }

      // Build the plan-specific focus section for the facet
      const planFocus = this._buildPlanFocusSection( plan )
      facet.setFocus( planFocus )

      facet.subscribe( ( decision: FacetDecision ) => this._onFacetDecision( plan, decision ) )
      this._activeFacets.set( plan.id, facet )

      // If the supervisor reaps this facet out from under us (idle TTL or LRU
      // eviction under attention pressure), drop the now-dead handle and degrade
      // the plan to autonomous completion — otherwise it stalls on a destroyed
      // facet whose report() silently no-ops. (P2)
      facet.onReaped( () => {
        this._activeFacets.delete( plan.id )
        if( plan.status === 'executing' || plan.status === 'ready')
          plan.executionTier = 'automatic'
        logger.info(
          `[planning] facet for plan ${plan.id} reaped — degraded to automatic`
        )
      } )

      // Prime the facet with initial context. Skipped on lazy escalation (prime=
      // false), where the triggering step report follows immediately.
      if( prime ){
        const initialReport: FacetReport = {
          type: 'plan.initialized',
          contextId: plan.id,
          instructions: this._buildDecisionGuidance('plan.initialized', undefined ),
          payload: {
            planId: plan.id,
            goalId: plan.goalId,
            totalSteps: plan.steps.length,
            expectedOutcome: plan.expectedOutcome,
            executionTier: plan.executionTier
          }
        }
        facet.report( initialReport )
      }

      logger.info(`[planning] facet activated: plan=${plan.id} facetId=${facet.facetId}`)
    }
    catch( err ){
      logger.error(`[planning] facet failed for plan ${plan.id}:`, err )
      plan.executionTier = 'automatic'
    }
  }

  cleanupFacet( planId: string ): void {
    const facet = this._activeFacets.get( planId )
    if( facet ){
      facet.destroy()
      this._activeFacets.delete( planId )
    }
  }

  // ── Focus + guidance (the judgment vocabulary) ─────────────

  /**
   * Build the plan-specific focus section for the facet.
   * Provided to the facet via setFocus() before any reports.
   *
   * Uses the STANDARD executive output format (no custom outputFormat).
   * The facet LLM expresses its directive as the FIRST action type
   * (e.g. { type: "continue" }), which the extractDecision callback reads.
   * A [PLANS] tagged block in reasoning carries revised steps for "replan".
   */
  private _buildPlanFocusSection( plan: Plan ): FocusSection {
    const goalDescription = this._goalManager
      ?.getActiveGoals()
      .find( g => g.id === plan.goalId )
      ?.description ?? plan.goalId

    const stepList = plan.steps.map( s => {
      const marker = s.status === 'completed'  ? '✓' :
                     s.status === 'failed'     ? '✗' :
                     s.status === 'active'     ? '→' : '○'
      return `${marker} [${s.id}] ${s.action}: ${s.description}`
    } ).join('\n')

    const completedCount = plan.steps.filter(
      s => s.status === 'completed' || s.status === 'skipped'
    ).length

    const focusContent =
      `Goal: ${goalDescription} (${plan.goalId})\n` +
      `Expected Outcome: ${plan.expectedOutcome || 'Not specified'}\n` +
      `Progress: ${completedCount}/${plan.steps.length} steps\n\n` +
      `## Plan Steps\n${stepList}`

    return {
      title: 'Plan Execution',
      function: 'planning',
      content: focusContent,
      outputFormat: undefined,   // use standard executive output format
      instructions:
        `I am monitoring plan "${plan.id}" for goal "${plan.goalId}".\n`+
        `My ONLY role: evaluate step outcomes and decide what happens next.\n`+
        `Do not create new goals or beliefs unless directly relevant to this plan.\n\n`+
        `## Decision Vocabulary\n`+
        `Express my decision as the FIRST action in my actions array:\n`+
        `- { "type": "continue" }  — proceed to the next step\n`+
        `- { "type": "retry" }     — re-attempt the failed step (capped)\n`+
        `- { "type": "skip" }      — skip the failed step and move on\n`+
        `- { "type": "pause" }     — hold the plan; resume it later (no progress now)\n`+
        `- { "type": "replan" }    — include a [PLANS] block with revised steps\n`+
        `- { "type": "escalate" }  — hand the decision up to my master self\n`+
        `- { "type": "abandon" }   — plan is unrecoverable; give up entirely\n`+
        `- { "type": "complete" }  — all meaningful work is done; close the plan\n\n`+
        `For "replan", include a [PLANS] block inside my reasoning with new steps.\n`+
        `The plan's expectedOutcome tells me what success looks like — use it to judge step reports.`,
      extractDecision: ( rawOutput: unknown ) => {
        const output = rawOutput as ExecutiveOutputFull

        // Directive comes from the first action type the facet chose
        const actionType  = output.actions[ 0 ]?.type ?? 'continue'
        const DIRECTIVES  = [ 'continue', 'retry', 'skip', 'pause', 'replan', 'escalate', 'abandon', 'complete' ] as const
        const directive   = DIRECTIVES.includes( actionType as typeof DIRECTIVES[number] )
          ? actionType
          : 'continue'

        // goalProgress: complete → 1.0, otherwise ratio of finished steps
        const total       = plan.steps.length
        const done        = plan.steps.filter(
          s => s.status === 'completed' || s.status === 'skipped'
        ).length
        const goalProgress = directive === 'complete'
          ? 1.0
          : total > 0 ? done / total : 0

        // updatedSteps: present only for replan (facet emits a [PLANS] block)
        const updatedSteps = directive === 'replan'
          ? output.plans?.[ 0 ]?.steps?.map( s => ( {
              action:          s.action,
              description:     s.description,
              expectedOutcome: s.expectedOutcome,
              prerequisites:   s.prerequisites ?? []
            } ) )
          : undefined

        return {
          directive,
          goalId:         plan.goalId,
          goalProgress,
          updatedSteps,
          newGoals:       output.newGoals,
          goalsToAbandon: output.goalsToAbandon,
          newBeliefs:     output.newBeliefs
        }
      }
    }
  }

  /**
   * Per-report status for the facet: FACTS ONLY — what happened — not coaching on
   * which directive to pick. The facet IS the executive's cognition and already has
   * the decision vocabulary from its focus instructions; the engine's job is to
   * report state, not prescribe the decision. (Lean guidance — the engine no longer
   * does the mind's thinking for it.)
   */
  private _buildDecisionGuidance( statusType: string, step?: PlanStep ): string {
    switch( statusType ){
      case 'step_completed':
        return `## Report\nStep ${step?.id} completed. Outcome: ${step?.outcome?.description ?? 'ok'}`

      case 'step_failed':
        return `## Report\nStep ${step?.id} failed. Outcome: ${step?.outcome?.description ?? 'unknown'}`

      case 'plan_completed':
        return `## Report\nAll steps are complete or skipped.`

      case 'plan_failed':
        return `## Report\nThe plan can no longer progress — one or more steps failed with no remaining path.`

      case 'plan.initialized':
        return `## Report\nPlan initialized and ready for execution.`

      default:
        return `## Report\nProgress update.`
    }
  }

  // ── Step reporting ─────────────────────────────────────────

  reportToFacet(
    plan: Plan,
    step: PlanStep,
    outcome: { success: boolean; description: string; outcomeQuality: number }
  ): boolean {
    const facet = this._activeFacets.get( plan.id )
    if( !facet ) return false

    const allDone   = plan.steps.every( s => s.status === 'completed' || s.status === 'skipped')
    const anyFailed = plan.steps.some( s => s.status === 'failed')
    const pendingCount = plan.steps.filter( s => s.status !== 'completed' && s.status !== 'skipped').length

    let statusType: string
    if( allDone && !anyFailed )      statusType = 'plan_completed'
    else if( anyFailed && pendingCount === 0 ) statusType = 'plan_failed'
    else if( outcome.success )       statusType = 'step_completed'
    else                             statusType = 'step_failed'

    // Update step outcome for guidance generation
    step.outcome = outcome

    const report: FacetReport = {
      type: statusType,
      contextId: plan.id,
      instructions: this._buildDecisionGuidance( statusType, step ),
      payload: {
        planId: plan.id,
        stepId: step.id,
        outcome: {
          success: outcome.success,
          description: outcome.description,
          outcomeQuality: outcome.outcomeQuality
        },
        planContext: this._buildFacetPlanContext( plan )
      }
    }

    facet.report( report )
    return true
  }

  private _buildFacetPlanContext( plan: Plan ): PlanContext {
    return {
      goalId: plan.goalId,
      goalDescription: this._goalManager?.getActiveGoals()
                                          .find( g => g.id === plan.goalId )?.description ?? plan.goalId,
      expectedOutcome: plan.expectedOutcome,
      steps: plan.steps.map( s => ( {
        id: s.id,
        action: s.action,
        description: s.description,
        expectedOutcome: s.expectedOutcome,
        status: s.status,
        prerequisites: s.prerequisites,
      } ) ),
      totalSteps: plan.steps.length,
      completedSteps: plan.steps.filter( s => s.status === 'completed' || s.status === 'skipped').length,
      skippedSteps: plan.steps.filter( s => s.status === 'skipped').map( s => s.id ),
      executionTier: plan.executionTier
    }
  }

  // ── Directive dispatch ─────────────────────────────────────

  private _onFacetDecision( plan: Plan, decision: FacetDecision ): void {
    // The decision payload structure is defined by the focus.outputFormat
    const payload = decision.decision as {
      directive?: string
      updatedSteps?: Array<{ action: string; description: string; expectedOutcome: string; prerequisites: string[] }>
      goalProgress?: number
      newGoals?: Array<{ description: string; priority: number; tags: string[]; completionType: string; completionCondition?: string }>
      goalsToAbandon?: Array<{ goalId: string; reason: string }>
      newBeliefs?: Array<{ statement: string; category: string; confidence: number; evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern'; tags: string[] }>
    }

    const directive = payload.directive ?? 'continue'

    // Measure: tally the supervisory decision (surfaced as planning.supervision.*).
    this._supervisionCounts.set( directive, ( this._supervisionCounts.get( directive ) ?? 0 ) + 1 )

    logger.info(
      `[planning] facet decision: plan=${plan.id} ` +
      `${directive} (confidence=${decision.confidence.toFixed( 2 )})`
    )

    switch( directive ){
      case 'continue':
        this._host.executePlans()
        break

      case 'skip': {
        const failedStep = plan.steps.find( s => s.status === 'failed')
        if( failedStep ) failedStep.status = 'skipped'
        this._host.executePlans()
        break
      }

      case 'abandon': {
        this._host.planFailed( plan, `Facet abandoned: ${decision.reasoning.slice( 0, 100 )}`)
        this.cleanupFacet( plan.id )
        break
      }

      case 'replan': {
        if( payload.updatedSteps && payload.updatedSteps.length > 0 ){
          plan.steps = payload.updatedSteps.map( ( s, i ) => ( {
            id: `step-${i}`,
            order: i,
            action: s.action,
            description: s.description,
            expectedOutcome: s.expectedOutcome,
            prerequisites: s.prerequisites,
            estimatedDuration: 5,
            status: 'pending' as const,
          } ) )

          logger.info(`[planning] plan ${plan.id} replanned (${plan.steps.length} steps)`)

          // Surface: the mind rewrote the plan mid-flight — a course-correction the
          // master should be aware of (mirrors plan.escalated). Only fires when steps
          // actually changed, not on an empty replan directive.
          this._host.publish( {
            type: 'plan.replanned', version: 1,
            salience: 0.7,
            payload: {
              planId:             plan.id,
              goalId:             plan.goalId,
              reason:             decision.reasoning.slice( 0, 120 ),
              stepCount:          plan.steps.length,
              requestingEntityId: plan.requestingEntityId,
              requestingThreadId: plan.requestingThreadId,
            }
          } )
        }
        this._host.executePlans()
        break
      }

      case 'complete': {
        this._host.planCompleted( plan )
        this.cleanupFacet( plan.id )
        break
      }

      case 'retry': {
        // Re-attempt failed step(s) — reset to pending so computeReadySet
        // re-activates it on the frontier; capped per step so a stuck step can't loop forever.
        let retried = 0
        for( const s of plan.steps ){
          if( s.status !== 'failed') continue
          const n = s.retries ?? 0
          if( n >= this._dispositions.maxStepRetries ){
            logger.info(`[planning] step ${s.id} retry exhausted (${n}/${this._dispositions.maxStepRetries}); left failed`)
            continue
          }
          s.retries = n + 1
          s.status  = 'pending'
          s.outcome = undefined
          retried++
        }
        logger.info(`[planning] plan ${plan.id} retrying ${retried} step(s)`)
        this._host.executePlans()
        break
      }

      case 'pause': {
        // Hold the plan without failing/abandoning it (resumes when re-executed).
        // Free the facet's attention while held.
        plan.status = 'paused'
        this.cleanupFacet( plan.id )
        logger.info(`[planning] plan ${plan.id} paused by facet`)
        break
      }

      case 'escalate': {
        // The facet defers to the master self: hold the plan + cleanup, and raise a
        // high-salience signal the master notices (alongside its Active Plans
        // awareness, which shows the paused plan) so it can re-decide.
        plan.status = 'paused'
        this.cleanupFacet( plan.id )
        this._host.publish( {
          type: 'plan.escalated', version: 1,
          salience: 0.85,
          payload: {
            planId:             plan.id,
            goalId:             plan.goalId,
            reason:             decision.reasoning.slice( 0, 120 ),
            requestingEntityId: plan.requestingEntityId,
            requestingThreadId: plan.requestingThreadId,
          }
        } )
        logger.info(`[planning] plan ${plan.id} escalated to master`)
        break
      }
    }
  }
}


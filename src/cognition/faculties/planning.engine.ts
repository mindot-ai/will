// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * PlanningEngine — plan executor with two-tier execution.
 *
 * Supervision modes (the cognitive dual-process axis, not a mechanism name):
 *
 * deliberate (System 2):
 *   Spawns a facet of the executive consciousness. Each step outcome is reported
 *   to the facet, which decides: continue / skip / abandon / replan / complete.
 *   The facet syncs bidirectionally with the master executive.
 *
 * automatic (System 1):
 *   Executes all steps without per-step supervision. Reports final status
 *   (completed or failed) to the master executive via salience-buffered events.
 *
 * A plan does NOT dispatch steps to an executor. It BIASES the one action
 * competition: each tick it projects its ready frontier step(s) as `plan.prior`
 * entities the AffordanceSynthesizer turns into competing affordances (top-down
 * prior, never a bypass — see PLANNING_AS_PRIOR_TODO.md). The ordinary selector
 * enacts the winner; the executor emits `action.outcome{planId,stepId}` (provenance
 * carried through the affordance→intent chain), which this engine consumes to
 * advance the frontier. Resolves the prerequisite DAG to choose the ready frontier.
 */

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands,
} from '#core/types'
import type { ExecutiveFacetHandle, FacetReport, FacetDecision } from '#faculties/executive.engine/facet'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { GoalManager } from '#faculties/goal.manager'
import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

// ── Types ─────────────────────────────────────────────────────

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

// ── PlanningEngine ────────────────────────────────────────────

export class PlanningEngine implements SimulationEngine, CognitiveEngine {
  readonly name = 'planning-engine'

  private _planRetentionTicks: number
  private _deliberateGoalPriority: number
  private _lowPlanConfidence: number
  private _surpriseOutcomeQuality: number
  private _maxStepRetries: number
  /** Channel A: how hard the plan asserts its frontier in the action competition
   *  (base 1 ⊕ conscientiousness prior). Multiplies the projected plan-prior bias. */
  private _planBiasGain = 1

  private _goalManager: GoalManager | null = null
  private _executiveEngine: ExecutiveEngine | null = null

  /**
   * Canonical plan store, keyed by plan.id ("plan-N") — the id the execution,
   * outcome (`action.outcome.planId`) and facet (`_activeFacets`) paths all use.
   */
  private _plans = new Map<string, Plan>()
  /**
   * Secondary index goalId → ordered plan.ids (creation order). Multiple plans
   * per goal supported (P4); terminal plans stay in the list as history and are
   * filtered out by _activePlanForGoal. Goal-scoped reads route through the
   * helpers below.
   */
  private _planByGoal = new Map<string, string[]>()
  /**
   * Plan ids already persisted in a terminal state. Terminal plans never change
   * again, so they are persisted once and then skipped by _persistPlans — avoids
   * unbounded state-write amplification as completed/failed plans accumulate. (P5)
   */
  private _persistedTerminal = new Set<string>()
  /** planId → sim tick it became terminal; drives retention GC (_gcTerminalPlans). */
  private _terminalAt = new Map<string, number>()
  /** Plan ids needing a recall descriptor emitted (created/revised this cycle). */
  private _newPlanDescriptors: string[] = []
  private _planCounter = 0

  /**
   * Last tick react() ran — used only to stamp session-log telemetry (never
   * replay state) from off-tick callbacks like _activateStep / _onStepOutcome.
   */
  private _lastTick = 0

  /**
   * Monotonic suffix counter for activity-listener subscription ids. These ids
   * are transient bus-subscription keys (HTTP/SSE-driven, never entering the
   * event log or snapshot), so they must NOT draw from the seeded PRNG — that
   * would consume sim-random draws and perturb determinism. A plain counter
   * replaces Math.random() here (R2).
   */
  private _subCounter = 0

  // ── Facet management (Tier 1) ──────────────────────────────
  private _activeFacets = new Map<string, ExecutiveFacetHandle>()

  /**
   * Cumulative count of each supervisory directive the facet has issued
   * (continue/retry/skip/pause/replan/escalate/abandon/complete). Pure observability —
   * surfaced as `planning.supervision.*` metrics so the planning-quality eval harness
   * can measure how the mind supervises execution (how often it corrects course). Not
   * restored from snapshot; re-accrues deterministically as the same decisions replay.
   */
  private _supervisionCounts = new Map<string, number>()

  private _energyLevel: number = 100

  private _bus: CognitiveBus | null = null
  private _sessionLogger: SessionLogger | null = null

  private readonly _model    = new GenerativeModel()

  // Tracks the last executive output object we ingested so we only process
  // each executive cycle once — prevents re-logging on every non-executive tick.
  private _lastIngestedOutput: ExecutiveOutputFull | null = null

  constructor( config: PlanningEngineConfig = {} ){
    this._bus               = config.bus ?? null
    this._planRetentionTicks = config.planRetentionTicks ?? 300
    this._deliberateGoalPriority = config.deliberateGoalPriority ?? 0.7
    this._lowPlanConfidence      = config.lowPlanConfidence ?? 0.5
    this._surpriseOutcomeQuality = config.surpriseOutcomeQuality ?? 0.25
    this._maxStepRetries         = config.maxStepRetries ?? 3
  }

  attachGoalManager( gm: GoalManager ): void { this._goalManager = gm }
  attachExecutiveEngine( oe: ExecutiveEngine ): void { this._executiveEngine = oe }
  attachSessionLogger( logger: SessionLogger | null ): void { this._sessionLogger = logger }
  /**
   * Give the engine its CognitiveBus. Called by the orchestrator's addEngine()
   * during assembly (every other faculty already exposes this). Without it the
   * bus stayed null, so plan-lifecycle events (plan.started / plan.step.* /
   * plan.completed) never published and addActivityListener no-op'd.
   */
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Goal-scoped plan lookups (P4: multiple plans per goal) ──

  private static readonly _TERMINAL: readonly string[] = [ 'completed', 'failed', 'rejected' ]

  /** All plans for a goal, in creation order (any status). */
  private _plansForGoal( goalId: string ): Plan[] {
    const ids = this._planByGoal.get( goalId )
    if( !ids ) return []
    const out: Plan[] = []
    for( const id of ids ){
      const p = this._plans.get( id )
      if( p ) out.push( p )
    }
    return out
  }

  /** The most-recently-created non-terminal plan for a goal, if any. */
  private _activePlanForGoal( goalId: string ): Plan | undefined {
    const all = this._plansForGoal( goalId )
    for( let i = all.length - 1; i >= 0; i-- )
      if( !PlanningEngine._TERMINAL.includes( all[ i ]!.status ) ) return all[ i ]
    return undefined
  }

  /**
   * Resolve which plan an executive plan-op targets. Prefers an explicit
   * `planId` (must belong to the same goal); otherwise falls back to the goal's
   * active plan. Returns undefined when neither resolves (caller may create one).
   */
  private _resolveIngestTarget( goalId: string, planId?: string ): Plan | undefined {
    if( planId ){
      const p = this._plans.get( planId )
      if( p && p.goalId === goalId ) return p
    }
    return this._activePlanForGoal( goalId )
  }

  /** Register a plan in both the canonical store and the goal index. */
  private _indexPlan( plan: Plan ): void {
    this._plans.set( plan.id, plan )
    const ids = this._planByGoal.get( plan.goalId ) ?? []
    ids.push( plan.id )
    this._planByGoal.set( plan.goalId, ids )
  }

  // ── CognitiveEngine interface ──────────────────────────────

  subscribes(): string[] {
    return [
      'energy.state.changed',
      'executive.prediction.formed',
      'action.outcome',
      // Goal lifecycle — a terminal goal makes its plans moot; cancel them so they
      // stop dispatching steps for a goal that's already done/dropped.
      'goal.achieved',
      'goal.abandoned',
    ]
  }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'plan.started',         version: 1, validate: () => null },
      { type: 'plan.step.activated',  version: 1, validate: () => null },
      { type: 'plan.step.outcome',    version: 1, validate: () => null },
      { type: 'plan.completed',       version: 1, validate: () => null },
      { type: 'plan.failed',          version: 1, validate: () => null },
      { type: 'plan.cancelled',       version: 1, validate: () => null },
      { type: 'plan.escalated',       version: 1, validate: () => null },
      { type: 'plan.replanned',       version: 1, validate: () => null },
      { type: 'planning.plan.created', version: 1, validate: () => null },
    ]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )

    switch( e.type ){
      case 'energy.state.changed':
        this._energyLevel = (e.payload as Record<string,number>)['level'] ?? this._energyLevel
        break

      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('planning') )
          this._model.setPrecision( 'planning.plans', 1.0 + p.confidence * 0.5 )
        break
      }

      case 'action.outcome': {
        const p = e.payload as {
          actionType: string; domain: string; success: boolean
          outcomeQuality: number; description: string
          planId?: string; stepId?: string
        }

        if( !p.planId || !p.stepId ) return
        if( !this._plans.has( p.planId ) ) return

        this._onStepOutcome( p.planId, p.stepId, {
          success: p.success,
          description: p.description ?? ( p.success ? 'Completed' : 'Failed' ),
          outcomeQuality: p.outcomeQuality,
        } )
        break
      }

      case 'goal.achieved':
        this._cancelPlansForGoal( ( e.payload as { goalId?: string } ).goalId, 'goal achieved' )
        break

      case 'goal.abandoned':
        this._cancelPlansForGoal( ( e.payload as { goalId?: string } ).goalId, 'goal abandoned' )
        break
    }
  }

  /**
   * Cancel every still-active plan for a goal that has reached a terminal state
   * (achieved/abandoned). Marks them rejected (→ retention GC cleans the entity)
   * and tears down any step-aware facet. A plan whose own completion triggered the
   * goal is already terminal and is skipped, so this only reaps siblings still
   * pursuing a goal that's now done/dropped. (planning↔goal sync)
   */
  private _cancelPlansForGoal( goalId: string | undefined, reason: string ): void {
    if( !goalId ) return
    for( const plan of this._plansForGoal( goalId ) ){
      if( PlanningEngine._TERMINAL.includes( plan.status ) ) continue
      plan.status = 'rejected'
      this._terminalAt.set( plan.id, this._lastTick )
      this._cleanupFacet( plan.id )

      // Terminal activity signal so SSE/socket watchers of this plan get explicit
      // closure (the plan stopped because its goal ended, not via complete/fail).
      this._bus?.publish( {
        type: 'plan.cancelled', version: 1, sourceEngine: this.name,
        salience: 0.6,
        payload: {
          planId:             plan.id,
          goalId:             plan.goalId,
          reason,
          completedSteps:     plan.steps.filter( s => s.status === 'completed' ).length,
          totalSteps:         plan.steps.length,
          requestingEntityId: plan.requestingEntityId,
          requestingThreadId: plan.requestingThreadId,
        }
      } )

      logger.info( `[planning] plan ${plan.id} cancelled — ${reason} (goal ${goalId})` )
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel: this._energyLevel,
      totalPlans:  this._plans.size,
      activeFacets: this._activeFacets.size,
    }
  }

  // ── Engine react ──────────────────────────────────────────

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._lastTick = tick as unknown as number
    const commands: StateCommands = { set: [], delete: [], metrics: [] }

    // 0. Channel A (subconscious): refresh trait-driven dispositions from the
    //    persona-prior mirror before acting on them this tick.
    this._readConfigFromState( state )

    // 1. Ingest new plans from executive output (the executive is the planner)
    this._ingestExecutivePlans( tick )

    // 2. Execute plans — advance the ready frontier (marks steps `active`)
    this._executePlans()

    // 2b. Project the active frontier as `plan.prior` entities — the top-down bias
    //     the AffordanceSynthesizer turns into competing affordances (no dispatch).
    this._projectFrontier( commands, tick, state )

    // 3. Emit recall descriptors for new/revised plans (awareness Stage 2)
    this._flushPlanDescriptors( commands )

    // 5. GC long-terminal plans (bound accretion), then persist the rest
    this._gcTerminalPlans( tick, commands )
    this._persistPlans( commands, tick )

    // 5. Metrics
    const executingPlans = Array.from( this._plans.values() )
                                .filter( p => p.status === 'executing' || p.status === 'ready' )

    commands.metrics!.push(
      [ 'planning.total_plans',     this._plans.size ],
      [ 'planning.executing_plans', executingPlans.length ],
      [ 'planning.active_facets',    this._activeFacets.size ],
      // Supervision distribution — how the mind corrects course mid-execution. The
      // raw signal the planning-quality eval harness reads (replan/abandon rates etc).
      [ 'planning.supervision.replan',   this._supervisionCounts.get( 'replan' )   ?? 0 ],
      [ 'planning.supervision.retry',    this._supervisionCounts.get( 'retry' )    ?? 0 ],
      [ 'planning.supervision.skip',     this._supervisionCounts.get( 'skip' )     ?? 0 ],
      [ 'planning.supervision.escalate', this._supervisionCounts.get( 'escalate' ) ?? 0 ],
      [ 'planning.supervision.abandon',  this._supervisionCounts.get( 'abandon' )  ?? 0 ],
    )

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._plans.size > 0 ){
      const predErr = this._model.observe( 'planning.plans', this._plans.size )
      if( !predErr.gated )
        _bus.publish( {
          type: 'planning.plan.created', version: 1, sourceEngine: this.name,
          salience: Math.max( 0.3, predErr.salience ),
          payload: { totalPlans: this._plans.size },
        } )
    }

    return { commands }
  }

  // ── Plan ingestion ─────────────────────────────────────────

  private _ingestExecutivePlans( tick: Tick ): void {
    const executiveOutput = this._executiveEngine?.latestOutput

    if( !executiveOutput?.plans || executiveOutput.plans.length === 0 ) return
    if( !this._executiveEngine?.isFresh( tick ) ) return
    // Guard: only ingest each executive cycle's output once.
    // latestOutput is the same object reference until the next executive fires,
    // so comparing by reference is sufficient to skip re-processing.
    if( executiveOutput === this._lastIngestedOutput ) return
    this._lastIngestedOutput = executiveOutput

    for( const planData of executiveOutput.plans ){
      // P4: an explicit planId targets a specific plan; otherwise the goal's
      // active plan. draft (below) intentionally bypasses this to stack new plans.
      const existingPlan = this._resolveIngestTarget( planData.goalId, planData.planId )

      switch( planData.action ){
        case 'draft': {
          // P4: a draft creates a NEW plan rather than being skipped when one
          // already exists — this is how multiple plans per goal are formed.
          // Guard only against exact re-assertions: an active plan with the same
          // (non-empty) expectedOutcome is the same candidate restated.
          const expected = planData.expectedOutcome ?? ''
          const isReassertion = expected.length > 0 && this._plansForGoal( planData.goalId ).some(
            p => p.expectedOutcome === expected && !PlanningEngine._TERMINAL.includes( p.status )
          )
          if( isReassertion ){
            logger.info(
              `[planning] draft for goal ${planData.goalId} skipped — ` +
              `matches active plan "${expected.slice( 0, 40 )}"`
            )
            break
          }

          this._createPlan( planData, tick, 'draft' )
          break
        }

        case 'validate': {
          if( !existingPlan ){
            this._createPlan( planData, tick, 'validated' )
            break
          }

          existingPlan.status = 'validated'
          logger.info( `[planning] plan ${existingPlan.id} validated` )
          break
        }

        case 'execute': {
          if( !existingPlan ){
            const newPlan = this._createPlan( planData, tick, 'approved' )
            newPlan.status = 'ready'
            // Infer supervision (emergent tier): important/uncertain plans start
            // deliberate (a facet supervises from the first step); else automatic.
            newPlan.executionTier = this._inferInitialTier( newPlan )
            if( newPlan.executionTier === 'deliberate' && this._executiveEngine )
              this._activateFacet( newPlan )
            break
          }

          existingPlan.status = 'ready'
          existingPlan.executionTier = this._inferInitialTier( existingPlan )
          existingPlan.expectedOutcome = planData.expectedOutcome ?? existingPlan.expectedOutcome

          logger.info(
            `[planning] plan ${existingPlan.id} approved for execution ` +
            `(tier=${existingPlan.executionTier} — inferred)`
          )

          if( existingPlan.executionTier === 'deliberate' && this._executiveEngine ){
            this._activateFacet( existingPlan )
          }
          break
        }

        case 'revise': {
          if( !existingPlan ){ this._createPlan( planData, tick, 'revised' ); break }

          existingPlan.steps = planData.steps.map( ( s, i ) => ( {
            id: `step-${i}`,
            order: i,
            action: s.action,
            description: s.description,
            expectedOutcome: s.expectedOutcome,
            prerequisites: s.prerequisites ?? ( i > 0 ? [`step-${i - 1}`] : [] ),
            estimatedDuration: s.estimatedDuration,
            status: 'pending' as const,
          } ) )
          // Re-arm so the revised steps actually dispatch. An in-flight plan stays
          // `executing` (new pending steps dispatch in place, like the facet replan
          // path); an idle one returns to `ready` so _executePlans (re)starts it.
          // Leaving it `revised` would strand it — _executePlans only runs
          // ready/executing. (P3)
          existingPlan.status = existingPlan.status === 'executing' ? 'executing' : 'ready'
          existingPlan.expectedOutcome = planData.expectedOutcome ?? existingPlan.expectedOutcome

          logger.info(
            `[planning] plan ${existingPlan.id} revised ` +
            `(${existingPlan.steps.length} steps, status=${existingPlan.status})`
          )
          this._newPlanDescriptors.push( existingPlan.id )   // re-describe (outcome may have changed)
          break
        }

        case 'cancel': {
          if( !existingPlan ) continue

          existingPlan.status = 'rejected'
          this._terminalAt.set( existingPlan.id, this._lastTick )
          this._cleanupFacet( existingPlan.id )

          logger.info( `[planning] plan ${existingPlan.id} cancelled` )
          break
        }
      }
    }
  }

  private _createPlan(
    planData: ExecutiveEngine extends { latestOutput: infer O }
      ? O extends { plans?: Array<infer P> } ? P : never
      : never,
    tick: Tick,
    status: Plan['status']
  ): Plan {
    this._planCounter++
    const planId = `plan-${this._planCounter}`

    const steps: PlanStep[] = planData.steps.map( ( s, i ) => ( {
      id: `step-${i}`,
      order: i,
      action: s.action,
      description: s.description,
      expectedOutcome: s.expectedOutcome,
      prerequisites: s.prerequisites ?? ( i > 0 ? [`step-${i - 1}`] : [] ),
      estimatedDuration: s.estimatedDuration,
      status: 'pending' as const,
    } ) )

    // Copy causal link from the GoalState so all downstream bus events carry it.
    const goalState = this._goalManager?.getGoal( planData.goalId )

    const plan: Plan = {
      id: planId,
      goalId: planData.goalId,
      steps,
      estimatedCost: planData.estimatedCost,
      confidence: planData.feasibility,
      status,
      executionTier: 'automatic',   // engine-inferred at execute (emergent tier), not executive-set
      expectedOutcome: planData.expectedOutcome ?? '',
      createdAt: tick,
      requestingEntityId: goalState?.requestingEntityId,
      requestingThreadId: goalState?.requestingThreadId,
    }

    this._indexPlan( plan )
    this._newPlanDescriptors.push( plan.id )

    logger.info(
      `[planning] plan created: ${planId} → goal ${plan.goalId} ` +
      `(${steps.length} steps, status=${status}, tier=${plan.executionTier}` +
      `${plan.requestingEntityId ? `, requester=${plan.requestingEntityId}` : ''})`
    )

    return plan
  }

  // ── Plan execution ─────────────────────────────────────────

  private _executePlans(): void {
    for( const plan of this._plans.values() ){
      if( plan.status !== 'ready' && plan.status !== 'executing' ) continue

      if( plan.status === 'ready' ){
        plan.status = 'executing'

        // Emit plan.started so the activity stream knows execution has begun.
        this._bus?.publish( {
          type: 'plan.started', version: 1, sourceEngine: this.name,
          salience: 0.65,
          payload: {
            planId:              plan.id,
            goalId:              plan.goalId,
            totalSteps:          plan.steps.length,
            executionTier:       plan.executionTier,
            requestingEntityId:  plan.requestingEntityId,
            requestingThreadId:  plan.requestingThreadId,
          }
        } )
      }

      const readySteps = this._computeReadySet( plan )

      if( readySteps.length > 0 )
        for( const step of readySteps )
          this._activateStep( plan, step )

      // Check for plan completion
      const allDone   = plan.steps.every( s => s.status === 'completed' || s.status === 'skipped' )
      const anyFailed = plan.steps.some( s => s.status === 'failed' )

      if( allDone && !anyFailed )
        this._onPlanCompleted( plan )

      else if( anyFailed && plan.executionTier === 'automatic' )
        this._onPlanFailed( plan, 'One or more steps failed' )
    }
  }

  private _computeReadySet( plan: Plan ): PlanStep[] {
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
   * Move a ready step onto the frontier: it starts biasing the competition (via
   * `_projectFrontier`) instead of being dispatched. Emits `plan.step.activated`
   * for the activity stream — the awareness analog of the old `plan.step.dispatched`.
   */
  private _activateStep( plan: Plan, step: PlanStep ): void {
    step.status = 'active'

    this._bus?.publish( {
      type: 'plan.step.activated', version: 1, sourceEngine: this.name,
      salience: 0.6,
      payload: {
        planId:             plan.id,
        stepId:             step.id,
        action:             step.action,
        description:        step.description,
        expectedOutcome:    step.expectedOutcome,
        reasoning:          `Pursuing plan step: ${step.description}`,
        stepIndex:          step.order,
        requestingEntityId: plan.requestingEntityId,
        requestingThreadId: plan.requestingThreadId,
      }
    } )

    this._sessionLogger?.write({
      type:        'plan.step.activated',
      tick:        this._lastTick,
      planId:      plan.id,
      stepId:      step.id,
      action:      step.action,
      description: step.description,
      stepIndex:   step.order,
      totalSteps:  plan.steps.length,
    } as any)

    logger.info( `[planning] step active: ${plan.id}/${step.id}=${step.action} (biasing the field)` )
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
  private _projectFrontier( commands: StateCommands, tick: Tick, state: ReadonlySimulationState ): void {
    // Clear the previous tick's priors — they are transient.
    for( const [ id, e ] of state.entities )
      if( e.type === 'plan.prior' ) commands.delete!.push( id )

    for( const plan of this._plans.values() ){
      if( plan.status !== 'executing' ) continue

      const goalPriority = this._goalManager?.getGoal( plan.goalId )?.priority ?? 0.5
      // Channel A: conscientiousness develops `planBiasGain` UP, so a conscientious
      // Will pushes its plan's frontier harder against competing impulses.
      const strength     = clamp01( ( 0.5 * goalPriority + 0.5 * plan.confidence ) * this._planBiasGain )

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

  // ── Step outcome handling ──────────────────────────────────

  private _onStepOutcome(
    planId: string,
    stepId: string,
    outcome: { success: boolean; description: string; outcomeQuality: number },
  ): void {
    const plan = this._plans.get( planId )
    if( !plan ) return

    // Late-outcome guard. A plan biases the field only while 'executing'; once it
    // leaves that state — the executive's `complete` directive, a failure, abandon,
    // pause/escalate, or a terminal goal — it stops projecting its frontier. But an
    // `agency.intent` the competition had ALREADY committed from a frontier prior can
    // still resolve a few ticks later (sync this tick, or an awaiting one timing out).
    // That outcome carries this plan's provenance, so it lands here. We must NOT act on
    // it: completion is the executive's call, not the late arrival of a step it has
    // already moved past — and re-running supervision below could re-spawn the facet
    // we just tore down. The enaction itself still happened (and still taught the
    // repertoire via reafference); the plan simply no longer cares.
    if( plan.status !== 'executing' ){
      logger.info( `[planning] ignoring late step outcome ${planId}/${stepId} — plan is ${plan.status}, not executing` )
      return
    }

    const step = plan.steps.find( s => s.id === stepId )
    if( !step ) return

    step.status  = outcome.success ? 'completed' : 'failed'
    step.outcome = outcome

    logger.info(
      `[planning] step outcome: ${planId}/${stepId} ` +
      `${outcome.success ? '✓' : '✗'} (quality=${outcome.outcomeQuality.toFixed( 2 )})`
    )

    // Publish step outcome to the bus so the activity stream can forward it.
    this._bus?.publish( {
      type: 'plan.step.outcome', version: 1, sourceEngine: this.name,
      salience: 0.6,
      payload: {
        planId,
        stepId,
        action:             step.action,
        success:            outcome.success,
        outcomeQuality:     outcome.outcomeQuality,
        description:        outcome.description.slice( 0, 300 ),
        completedSteps:     plan.steps.filter( s => s.status === 'completed' || s.status === 'skipped' ).length,
        totalSteps:         plan.steps.length,
        requestingEntityId: plan.requestingEntityId,
        requestingThreadId: plan.requestingThreadId,
      }
    } )

    this._sessionLogger?.write({
      type:           'plan.step.outcome',
      tick:           this._lastTick,
      planId,
      stepId,
      action:         step.action,
      success:        outcome.success,
      outcomeQuality: outcome.outcomeQuality,
      description:    outcome.description.slice( 0, 300 ),
      completedSteps: plan.steps.filter( s => s.status === 'completed' || s.status === 'skipped' ).length,
      totalSteps:     plan.steps.length,
    } as any)

    // Supervision (emergent tier): a deliberate plan reports to its facet. An
    // automatic plan ESCALATES to deliberate on a surprising outcome — attention
    // recruited by prediction error — then reports. _shouldEscalate is the
    // extension point for more triggers.
    if( plan.executionTier !== 'deliberate' && this._shouldEscalate( plan, step, outcome ) ){
      plan.executionTier = 'deliberate'
      logger.info( `[planning] plan ${planId} escalated to deliberate (surprise on ${stepId})` )
      this._activateFacet( plan, false )   // lazy spawn; the step report below follows
    }

    if( plan.executionTier === 'deliberate' ){
      const facet = this._activeFacets.get( planId )
      if( facet ) this._reportToFacet( facet, plan, step, outcome )
      else {
        // attention saturated / spawn failed → _activateFacet downgraded to automatic
        logger.warn( `[planning] no facet to supervise plan ${planId}; continuing automatically` )
        this._executePlans()
      }
    }
  }

  // ── Supervision inference (emergent tier) ──────────────────

  /**
   * Top-down initial supervision mode for a plan being launched. Important
   * (high-priority goal) or uncertain (low-confidence) plans are supervised from
   * the first step; everything else runs automatically. Pure + deterministic.
   */
  /**
   * Channel A (subconscious disposition): refresh trait-driven supervision params
   * from the persona-prior mirror (base `engine-config-planning` ⊕ metacog deltas).
   * Demonstrated conscientiousness develops planning follow-through — it raises
   * `maxStepRetries` (re-attempt a stuck step more before giving up) and
   * `surpriseOutcomeQuality` (vigilance: escalate to deliberate supervision on
   * smaller quality dips). Only present params override; absent config/prior leaves
   * the constructor defaults standing. Pure + deterministic (R2): same state ⇒ same
   * dispositions, no wall-clock, no RNG.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-planning' )
    if( typeof p.maxStepRetries         === 'number' ) this._maxStepRetries         = p.maxStepRetries
    if( typeof p.surpriseOutcomeQuality === 'number' ) this._surpriseOutcomeQuality = p.surpriseOutcomeQuality
    if( typeof p.planBiasGain           === 'number' ) this._planBiasGain           = p.planBiasGain
  }

  private _inferInitialTier( plan: Plan ): 'automatic' | 'deliberate' {
    const priority = this._goalManager?.getGoal( plan.goalId )?.priority ?? 0
    if( priority >= this._deliberateGoalPriority ) return 'deliberate'
    if( plan.confidence < this._lowPlanConfidence ) return 'deliberate'
    return 'automatic'
  }

  /**
   * Bottom-up: should an AUTOMATIC plan recruit deliberate supervision on this step
   * outcome? Surprise (failure / outcome well below expectation) captures attention.
   * EXTENSION POINT — add triggers here (timeouts, prediction error, repeated
   * retries, threat/stress spikes, …) as more edge cases surface.
   */
  private _shouldEscalate(
    _plan: Plan, _step: PlanStep, outcome: { success: boolean; outcomeQuality: number }
  ): boolean {
    if( !outcome.success ) return true                                  // a failure always demands attention
    if( outcome.outcomeQuality < this._surpriseOutcomeQuality ) return true   // succeeded, but well below expectation
    return false
  }

  // ── Facet management (Tier 1) ───────────────────────────────

  private _activateFacet( plan: Plan, prime: boolean = true ): void {
    if( !this._executiveEngine ) return

    try {
      const { attention, handle: facet } = this._executiveEngine.spawnFacet()
      if( !facet || attention === 'full' ){
        plan.executionTier = 'automatic'
        logger.info( `[planning] attention full — plan ${plan.id} stays automatic (no facet)` )
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
        if( plan.status === 'executing' || plan.status === 'ready' )
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
          instructions: this._buildDecisionGuidance( 'plan.initialized', undefined ),
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

      logger.info( `[planning] facet activated: plan=${plan.id} facetId=${facet.facetId}` )
    }
    catch( err ){
      logger.error( `[planning] facet failed for plan ${plan.id}:`, err )
      plan.executionTier = 'automatic'
    }
  }

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
    } ).join( '\n' )

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
        `You are monitoring plan "${plan.id}" for goal "${plan.goalId}".\n`+
        `Your ONLY role: evaluate step outcomes and decide what happens next.\n`+
        `Do not create new goals or beliefs unless directly relevant to this plan.\n\n`+
        `## Decision Vocabulary\n`+
        `Express your decision as the FIRST action in your actions array:\n`+
        `- { "type": "continue" }  — proceed to the next step\n`+
        `- { "type": "retry" }     — re-attempt the failed step (capped)\n`+
        `- { "type": "skip" }      — skip the failed step and move on\n`+
        `- { "type": "pause" }     — hold the plan; resume it later (no progress now)\n`+
        `- { "type": "replan" }    — include a [PLANS] block with revised steps\n`+
        `- { "type": "escalate" }  — hand the decision up to your master self\n`+
        `- { "type": "abandon" }   — plan is unrecoverable; give up entirely\n`+
        `- { "type": "complete" }  — all meaningful work is done; close the plan\n\n`+
        `For "replan", include a [PLANS] block inside your reasoning with new steps.\n`+
        `The plan's expectedOutcome tells you what success looks like — use it to judge step reports.`,
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

  private _reportToFacet(
    facet: ExecutiveFacetHandle,
    plan: Plan,
    step: PlanStep,
    outcome: { success: boolean; description: string; outcomeQuality: number }
  ): void {
    const allDone   = plan.steps.every( s => s.status === 'completed' || s.status === 'skipped' )
    const anyFailed = plan.steps.some( s => s.status === 'failed' )
    const pendingCount = plan.steps.filter( s => s.status !== 'completed' && s.status !== 'skipped' ).length

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
  }

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
        this._executePlans()
        break

      case 'skip': {
        const failedStep = plan.steps.find( s => s.status === 'failed' )
        if( failedStep ) failedStep.status = 'skipped'
        this._executePlans()
        break
      }

      case 'abandon': {
        this._onPlanFailed( plan, `Facet abandoned: ${decision.reasoning.slice( 0, 100 )}` )
        this._cleanupFacet( plan.id )
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
          
          logger.info( `[planning] plan ${plan.id} replanned (${plan.steps.length} steps)` )

          // Surface: the mind rewrote the plan mid-flight — a course-correction the
          // master should be aware of (mirrors plan.escalated). Only fires when steps
          // actually changed, not on an empty replan directive.
          this._bus?.publish( {
            type: 'plan.replanned', version: 1, sourceEngine: this.name,
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
        this._executePlans()
        break
      }

      case 'complete': {
        this._onPlanCompleted( plan )
        this._cleanupFacet( plan.id )
        break
      }

      case 'retry': {
        // Re-attempt failed step(s) — reset to pending so _computeReadySet
        // re-activates it on the frontier; capped per step so a stuck step can't loop forever.
        let retried = 0
        for( const s of plan.steps ){
          if( s.status !== 'failed' ) continue
          const n = s.retries ?? 0
          if( n >= this._maxStepRetries ){
            logger.info( `[planning] step ${s.id} retry exhausted (${n}/${this._maxStepRetries}); left failed` )
            continue
          }
          s.retries = n + 1
          s.status  = 'pending'
          s.outcome = undefined
          retried++
        }
        logger.info( `[planning] plan ${plan.id} retrying ${retried} step(s)` )
        this._executePlans()
        break
      }

      case 'pause': {
        // Hold the plan without failing/abandoning it (resumes when re-executed).
        // Free the facet's attention while held.
        plan.status = 'paused'
        this._cleanupFacet( plan.id )
        logger.info( `[planning] plan ${plan.id} paused by facet` )
        break
      }

      case 'escalate': {
        // The facet defers to the master self: hold the plan + cleanup, and raise a
        // high-salience signal the master notices (alongside its Active Plans
        // awareness, which shows the paused plan) so it can re-decide.
        plan.status = 'paused'
        this._cleanupFacet( plan.id )
        this._bus?.publish( {
          type: 'plan.escalated', version: 1, sourceEngine: this.name,
          salience: 0.85,
          payload: {
            planId:             plan.id,
            goalId:             plan.goalId,
            reason:             decision.reasoning.slice( 0, 120 ),
            requestingEntityId: plan.requestingEntityId,
            requestingThreadId: plan.requestingThreadId,
          }
        } )
        logger.info( `[planning] plan ${plan.id} escalated to master` )
        break
      }
    }
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
      completedSteps: plan.steps.filter( s => s.status === 'completed' || s.status === 'skipped' ).length,
      skippedSteps: plan.steps.filter( s => s.status === 'skipped' ).map( s => s.id ),
      executionTier: plan.executionTier
    }
  }

  private _cleanupFacet( planId: string ): void {
    const facet = this._activeFacets.get( planId )
    if( facet ){
      facet.destroy()
      this._activeFacets.delete( planId )
    }
  }

  // ── Plan completion / failure ──────────────────────────────

  private _onPlanCompleted( plan: Plan ): void {
    plan.status = 'completed'
    this._terminalAt.set( plan.id, this._lastTick )

    this._bus?.publish( {
      type: 'plan.completed',
      version: 1,
      sourceEngine: this.name,
      salience: 0.7,
      payload: {
        planId:             plan.id,
        goalId:             plan.goalId,
        completedSteps:     plan.steps.filter( s => s.status === 'completed' ).length,
        skippedSteps:       plan.steps.filter( s => s.status === 'skipped' ).map( s => s.id ),
        totalSteps:         plan.steps.length,
        requestingEntityId: plan.requestingEntityId,
        requestingThreadId: plan.requestingThreadId,
      }
    } )

    logger.info( `[planning] plan completed: ${plan.id} → goal ${plan.goalId}` )
  }

  private _onPlanFailed( plan: Plan, reason: string ): void {
    plan.status = 'failed'
    this._terminalAt.set( plan.id, this._lastTick )

    this._bus?.publish( {
      type: 'plan.failed',
      version: 1,
      sourceEngine: this.name,
      salience: 0.7,
      payload: {
        planId:             plan.id,
        goalId:             plan.goalId,
        reason,
        completedSteps:     plan.steps.filter( s => s.status === 'completed' ).length,
        skippedSteps:       plan.steps.filter( s => s.status === 'skipped' ).map( s => s.id ),
        totalSteps:         plan.steps.length,
        requestingEntityId: plan.requestingEntityId,
        requestingThreadId: plan.requestingThreadId,
      }
    } )

    logger.info( `[planning] plan failed: ${plan.id} — ${reason}` )
  }

  // ── Recall descriptors (awareness Stage 2) ─────────────────

  /**
   * Emit a stable, embeddable descriptor for newly created/revised plans as a
   * `working_memory.item`, so the EpisodicConsolidator indexes it into vector
   * memory and a later message can RECALL the plan (→ `context.relevantPlanIds` →
   * the Active Plans awareness filter). Only the stable descriptor (goal +
   * expectedOutcome) is embedded — never the live step state (which changes every
   * tick) — so recall stays match-stable while the projector renders live state.
   * The WorkingMemory faculty GCs the item after consolidation, so it doesn't
   * accrete. Follows the established external-injection pattern (AuditionEngine).
   */
  private _flushPlanDescriptors( commands: StateCommands ): void {
    for( const id of this._newPlanDescriptors ){
      const plan = this._plans.get( id )
      if( !plan ) continue
      commands.set!.push( {
        id: `wm-plan-${plan.id}`,
        type: 'working_memory.item',
        createdAt: plan.createdAt,
        updatedAt: this._lastTick,
        metadata: {
          wmType: 'plan',
          content: {
            summary: `Plan ${plan.id} for goal "${plan.goalId}": ${plan.expectedOutcome || 'achieve the goal'}`,
            planId: plan.id,
            goalId: plan.goalId,
          },
          activation: 0.8,
          attendedCount: 1,
          tags: [ 'plan', 'plan.descriptor' ],
          tick: this._lastTick,
        },
      } )
    }
    this._newPlanDescriptors.length = 0
  }

  // ── Retention GC ───────────────────────────────────────────

  /**
   * Evict terminal plans (and delete their state entity) once they've been
   * terminal longer than the retention window. Terminal plans never change, so
   * retaining them forever accretes memory + state entities on a long-lived mind.
   * Deterministic: the window is compared against sim ticks (R2-safe).
   */
  private _gcTerminalPlans( tick: Tick, commands: StateCommands ): void {
    const now = tick as unknown as number
    let evicted = 0

    for( const [ id, plan ] of this._plans ){
      if( !PlanningEngine._TERMINAL.includes( plan.status ) ) continue
      const since = this._terminalAt.get( id ) ?? now
      if( now - since <= this._planRetentionTicks ) continue

      this._plans.delete( id )
      this._persistedTerminal.delete( id )
      this._terminalAt.delete( id )
      this._cleanupFacet( id )   // safety — a terminal plan shouldn't still hold a facet

      const ids = this._planByGoal.get( plan.goalId )
      if( ids ){
        const next = ids.filter( x => x !== id )
        if( next.length ) this._planByGoal.set( plan.goalId, next )
        else              this._planByGoal.delete( plan.goalId )
      }

      commands.delete!.push( id )
      evicted++
    }

    if( evicted > 0 )
      commands.metrics!.push( [ 'planning.plans_evicted', evicted ] )
  }

  // ── Persistence ────────────────────────────────────────────

  private _persistPlans( commands: StateCommands, tick: Tick ): void {
    for( const plan of this._plans.values() ){
      // Terminal plans never change again — persist once (in their terminal state)
      // then skip, so completed/failed/rejected plans don't re-serialize every
      // tick forever (unbounded write amplification on long sessions). (P5)
      const terminal = PlanningEngine._TERMINAL.includes( plan.status )
      if( terminal && this._persistedTerminal.has( plan.id ) ) continue

      commands.set!.push( {
        id: plan.id, type: 'plan',
        createdAt: plan.createdAt, updatedAt: tick,
        metadata: {
          goalId: plan.goalId,
          steps: plan.steps.map( s => ( {
            id: s.id, order: s.order, action: s.action,
            description: s.description, expectedOutcome: s.expectedOutcome,
            prerequisites: s.prerequisites, estimatedDuration: s.estimatedDuration,
            status: s.status, outcome: s.outcome,
          } ) ),
          estimatedCost: plan.estimatedCost, confidence: plan.confidence,
          status: plan.status, executionTier: plan.executionTier,
          expectedOutcome: plan.expectedOutcome,
          requestingEntityId: plan.requestingEntityId,
          requestingThreadId: plan.requestingThreadId,
          source: 'planning-engine'
        }
      } )

      if( terminal ) this._persistedTerminal.add( plan.id )
    }
  }

  // ── Public API ─────────────────────────────────────────────

  /** The goal's active plan, or its most-recent plan if all are terminal. */
  getPlan( goalId: string ): Plan | undefined {
    const active = this._activePlanForGoal( goalId )
    if( active ) return active
    const all = this._plansForGoal( goalId )
    return all.length > 0 ? all[ all.length - 1 ] : undefined
  }

  /** All plans for a goal (any status), in creation order. (P4) */
  getPlansForGoal( goalId: string ): Plan[] {
    return this._plansForGoal( goalId )
  }

  /**
   * Subscribe to plan activity events for a specific requesting entity.
   *
   * Subscribes to the internal CognitiveBus and forwards all plan-lifecycle
   * events (`plan.started`, `plan.step.activated`, `plan.step.outcome`,
   * `plan.completed`, `plan.failed`) that were triggered by `entityId` to
   * the provided `handler`.
   *
   * Used by WillManager to back the `GET /wills/:id/activity` SSE stream.
   *
   * @returns Unsubscribe function — call it to remove the subscription.
   */
  addActivityListener(
    entityId: string,
    handler:  ActivityEventHandler,
  ): () => void {
    if( !this._bus ){
      logger.warn('[planning] addActivityListener called before bus is attached — listener is a no-op')
      return () => {}
    }

    const subId = `activity-listener-${entityId}-${this._subCounter++}`

    const PLAN_TOPICS = [
      'plan.started',
      'plan.step.activated',
      'plan.step.outcome',
      'plan.completed',
      'plan.failed',
      'plan.cancelled',
    ]

    const TYPE_MAP: Record<string, ActivityEvent['type']> = {
      'plan.started':          'plan_started',
      'plan.step.activated':   'step_activated',
      'plan.step.outcome':     'step_outcome',
      'plan.completed':        'plan_complete',
      'plan.failed':           'plan_failed',
      'plan.cancelled':        'plan_cancelled',
    }

    this._bus.subscribe( subId, PLAN_TOPICS, ev => {
      const p = ev.payload as Record<string, unknown>

      // Filter: only forward events that originated from this entity's request.
      // `'*'` is a wildcard — forward all activity (used by the transport projection).
      if( entityId !== '*' && p.requestingEntityId !== entityId ) return

      const mapped = TYPE_MAP[ ev.type ]
      if( !mapped ) return

      handler({
        type:               mapped,
        planId:             p.planId             as string,
        goalId:             p.goalId             as string | undefined,
        requestingEntityId: p.requestingEntityId as string | undefined,
        requestingThreadId: p.requestingThreadId as string | undefined,
        ...p,
      })
    })

    return () => this._bus?.unsubscribe( subId )
  }
}

// ─── module helpers ────────────────────────────────────────────────────────────

function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
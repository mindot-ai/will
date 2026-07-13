// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning.engine/engine.ts
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
 *
 * Structure (split along its seams — each module carries its own docs):
 *   planning/types.ts            — shared types + dispositions + terminal set
 *   planning/plan.store.ts       — canonical store, goal index, GC, persistence
 *   planning/plan.frontier.ts    — ready-set DAG + `plan.prior` projection
 *   planning/plan.supervision.ts — emergent tier, facet judgment, directives
 *   (this file)                  — engine shell: bus events, react loop,
 *                                  ingestion, execution, lifecycle, activity API
 */

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { GoalManager } from '#faculties/goal.manager'
import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

import {
  TERMINAL_STATUSES,
  type Plan, type PlanStep, type PlanContext, type PlanningDispositions,
  type ActivityEvent, type ActivityEventHandler, type PlanningEngineConfig,
} from './types'
import { PlanStore } from './plan.store'
import { computeReadySet, projectFrontier } from './plan.frontier'
import { PlanSupervisor, type SupervisionHost } from './plan.supervision'

export type {
  Plan, PlanStep, PlanContext,
  ActivityEvent, ActivityEventHandler, PlanningEngineConfig,
}
export { PlanStore, PlanSupervisor }

// ── PlanningEngine ────────────────────────────────────────────

export class PlanningEngine implements SimulationEngine, CognitiveEngine {
  readonly name = 'planning-engine'

  private _planRetentionTicks: number

  /**
   * Trait-driven dispositions (Channel A) — ONE mutable object, refreshed from
   * the persona-prior mirror each tick (_readConfigFromState) and read live by
   * the supervisor + frontier projection. See PlanningDispositions.
   */
  private readonly _dispositions: PlanningDispositions

  private _goalManager: GoalManager | null = null
  private _executiveEngine: ExecutiveEngine | null = null

  /** Canonical plan state — store, goal index, terminal bookkeeping, GC, persistence. */
  private readonly _store = new PlanStore()

  /** Deliberate-tier judgment — facet lifecycle, reports, directive dispatch. */
  private readonly _supervisor: PlanSupervisor

  /** Plan ids needing a recall descriptor emitted (created/revised this cycle). */
  private _newPlanDescriptors: string[] = []

  /**
   * Last tick react() ran — used only to stamp session-log telemetry (never
   * replay state) from off-tick callbacks like _activateStep / _onStepOutcome.
   */
  private _lastTick = 0
  /** One-time deletion of legacy `plan-executive-*` entities (see react step 0a). */
  private _legacyPlanSweepDone = false

  /**
   * Monotonic suffix counter for activity-listener subscription ids. These ids
   * are transient bus-subscription keys (HTTP/SSE-driven, never entering the
   * event log or snapshot), so they must NOT draw from the seeded PRNG — that
   * would consume sim-random draws and perturb determinism. A plain counter
   * replaces Math.random() here (R2).
   */
  private _subCounter = 0

  private _energyLevel: number = 100

  private _bus: CognitiveBus | null = null
  private _sessionLogger: SessionLogger | null = null

  private readonly _model = new GenerativeModel()

  // Tracks the last executive output object we ingested so we only process
  // each executive cycle once — prevents re-logging on every non-executive tick.
  private _lastIngestedOutput: ExecutiveOutputFull | null = null

  constructor( config: PlanningEngineConfig = {} ){
    this._bus                = config.bus ?? null
    this._planRetentionTicks = config.planRetentionTicks ?? 300

    this._dispositions = {
      deliberateGoalPriority: config.deliberateGoalPriority ?? 0.7,
      lowPlanConfidence:      config.lowPlanConfidence ?? 0.5,
      surpriseOutcomeQuality: config.surpriseOutcomeQuality ?? 0.25,
      maxStepRetries:         config.maxStepRetries ?? 3,
      planBiasGain:           1,
    }

    // The supervisor's effects flow back through this narrow host interface —
    // the engine owns plan lifecycle, bus identity, and the execution pass.
    const host: SupervisionHost = {
      executePlans:  () => this._executePlans(),
      planCompleted: plan => this._onPlanCompleted( plan ),
      planFailed:    ( plan, reason ) => this._onPlanFailed( plan, reason ),
      publish:       event => this._bus?.publish( { ...event, sourceEngine: this.name } ),
    }
    this._supervisor = new PlanSupervisor( host, this._dispositions )
  }

  attachGoalManager( gm: GoalManager ): void {
    this._goalManager = gm
    this._supervisor.attachGoalManager( gm )
  }
  attachExecutiveEngine( oe: ExecutiveEngine ): void {
    this._executiveEngine = oe
    this._supervisor.attachExecutiveEngine( oe )
  }
  attachSessionLogger( logger: SessionLogger | null ): void { this._sessionLogger = logger }
  /**
   * Give the engine its CognitiveBus. Called by the orchestrator's addEngine()
   * during assembly (every other faculty already exposes this). Without it the
   * bus stayed null, so plan-lifecycle events (plan.started / plan.step.* /
   * plan.completed) never published and addActivityListener no-op'd.
   */
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

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

        // Conscious-enaction credit: outcomes carry plan provenance only when
        // the plan's OWN frontier prior won the competition. But the plan is a
        // prior over WHAT to do — if the self does the very thing an active
        // step calls for by any route (executive action via ideomotor, habit),
        // the step is done. Without this, a mind that consciously performs its
        // plan starves the plan of credit: steps stay active, the goal reads
        // blocked, and the executive re-authors the same plan over and over
        // (observed live: 8 authorings for one goal, zero completions).
        // Deterministic: stores iterate in insertion order; first match wins.
        if( !p.planId || !p.stepId ){
          if( !p.actionType || typeof p.success !== 'boolean' ) return
          for( const plan of this._store.all() ){
            if( plan.status !== 'executing' ) continue
            const step = plan.steps.find( s => s.status === 'active' && s.action === p.actionType )
            if( !step ) continue
            logger.info( `[planning] conscious-enaction credit: ${plan.id}/${step.id}=${step.action} (no provenance on outcome)` )
            this._onStepOutcome( plan.id, step.id, {
              success: p.success,
              description: p.description ?? ( p.success ? 'Completed' : 'Failed' ),
              outcomeQuality: p.outcomeQuality,
            } )
            return   // credit exactly one step per outcome
          }
          return
        }
        if( !this._store.has( p.planId ) ) return

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
    for( const plan of this._store.plansForGoal( goalId ) ){
      if( TERMINAL_STATUSES.includes( plan.status ) ) continue
      plan.status = 'rejected'
      this._store.markTerminal( plan.id, this._lastTick )
      this._supervisor.cleanupFacet( plan.id )

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
      totalPlans:  this._store.size,
      activeFacets: this._supervisor.activeFacetCount,
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

    // 0a. Legacy sweep (once per session): delete the raw `plan-executive-*`
    //     entities the executive commands path used to write in parallel with
    //     this engine's ingest. They froze at 'ready' forever and polluted the
    //     Active-Plans awareness (phantom drafts → re-authoring pressure).
    if( !this._legacyPlanSweepDone ){
      this._legacyPlanSweepDone = true
      for( const entity of state.entities.values() )
        if( entity.type === 'plan' && entity.id.startsWith('plan-executive-') )
          commands.delete!.push( entity.id )
    }

    // 0. Channel A (subconscious): refresh trait-driven dispositions from the
    //    persona-prior mirror before acting on them this tick.
    this._readConfigFromState( state )

    // 1. Ingest new plans from executive output (the executive is the planner)
    this._ingestExecutivePlans( tick )

    // 2. Execute plans — advance the ready frontier (marks steps `active`)
    this._executePlans()

    // 2b. Project the active frontier as `plan.prior` entities — the top-down bias
    //     the AffordanceSynthesizer turns into competing affordances (no dispatch).
    projectFrontier(
      this._store.all(), commands, tick, state,
      goalId => this._goalManager?.getGoal( goalId )?.priority ?? 0.5,
      this._dispositions.planBiasGain,
    )

    // 3. Emit recall descriptors for new/revised plans (awareness Stage 2)
    this._flushPlanDescriptors( commands )

    // 5. GC long-terminal plans (bound accretion), then persist the rest
    this._store.gcTerminal( tick, commands, this._planRetentionTicks, id => this._supervisor.cleanupFacet( id ) )
    this._store.persist( commands, tick )

    // 5. Metrics
    const executingPlans = Array.from( this._store.all() )
                                .filter( p => p.status === 'executing' || p.status === 'ready' )

    commands.metrics!.push(
      [ 'planning.total_plans',     this._store.size ],
      [ 'planning.executing_plans', executingPlans.length ],
      [ 'planning.active_facets',    this._supervisor.activeFacetCount ],
      // Supervision distribution — how the mind corrects course mid-execution. The
      // raw signal the planning-quality eval harness reads (replan/abandon rates etc).
      [ 'planning.supervision.replan',   this._supervisor.supervisionCount( 'replan' ) ],
      [ 'planning.supervision.retry',    this._supervisor.supervisionCount( 'retry' ) ],
      [ 'planning.supervision.skip',     this._supervisor.supervisionCount( 'skip' ) ],
      [ 'planning.supervision.escalate', this._supervisor.supervisionCount( 'escalate' ) ],
      [ 'planning.supervision.abandon',  this._supervisor.supervisionCount( 'abandon' ) ],
    )

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && this._store.size > 0 ){
      const predErr = this._model.observe( 'planning.plans', this._store.size )
      if( !predErr.gated )
        _bus.publish( {
          type: 'planning.plan.created', version: 1, sourceEngine: this.name,
          salience: Math.max( 0.3, predErr.salience ),
          payload: { totalPlans: this._store.size },
        } )
    }

    return { commands }
  }

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
    if( typeof p.maxStepRetries         === 'number' ) this._dispositions.maxStepRetries         = p.maxStepRetries
    if( typeof p.surpriseOutcomeQuality === 'number' ) this._dispositions.surpriseOutcomeQuality = p.surpriseOutcomeQuality
    if( typeof p.planBiasGain           === 'number' ) this._dispositions.planBiasGain           = p.planBiasGain
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
      const existingPlan = this._store.resolveIngestTarget( planData.goalId, planData.planId )

      switch( planData.action ){
        case 'draft': {
          // P4: a draft creates a NEW plan rather than being skipped when one
          // already exists — this is how multiple plans per goal are formed.
          // Guard only against exact re-assertions: an active plan with the same
          // (non-empty) expectedOutcome is the same candidate restated.
          const expected = planData.expectedOutcome ?? ''
          const isReassertion = expected.length > 0 && this._store.plansForGoal( planData.goalId ).some(
            p => p.expectedOutcome === expected && !TERMINAL_STATUSES.includes( p.status )
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
            newPlan.executionTier = this._supervisor.inferInitialTier( newPlan )
            if( newPlan.executionTier === 'deliberate' && this._executiveEngine )
              this._supervisor.activateFacet( newPlan )
            break
          }

          existingPlan.status = 'ready'
          existingPlan.executionTier = this._supervisor.inferInitialTier( existingPlan )
          existingPlan.expectedOutcome = planData.expectedOutcome ?? existingPlan.expectedOutcome

          logger.info(
            `[planning] plan ${existingPlan.id} approved for execution ` +
            `(tier=${existingPlan.executionTier} — inferred)`
          )

          if( existingPlan.executionTier === 'deliberate' && this._executiveEngine ){
            this._supervisor.activateFacet( existingPlan )
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
          this._store.markTerminal( existingPlan.id, this._lastTick )
          this._supervisor.cleanupFacet( existingPlan.id )

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
    const planId = this._store.nextId()

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

    this._store.index( plan )
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
    for( const plan of this._store.all() ){
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

      const readySteps = computeReadySet( plan )

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

  /**
   * Move a ready step onto the frontier: it starts biasing the competition (via
   * `projectFrontier`) instead of being dispatched. Emits `plan.step.activated`
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

  // ── Step outcome handling ──────────────────────────────────

  private _onStepOutcome(
    planId: string,
    stepId: string,
    outcome: { success: boolean; description: string; outcomeQuality: number },
  ): void {
    const plan = this._store.get( planId )
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
    // recruited by prediction error — then reports. shouldEscalate is the
    // extension point for more triggers.
    if( plan.executionTier !== 'deliberate' && this._supervisor.shouldEscalate( plan, step, outcome ) ){
      plan.executionTier = 'deliberate'
      logger.info( `[planning] plan ${planId} escalated to deliberate (surprise on ${stepId})` )
      this._supervisor.activateFacet( plan, false )   // lazy spawn; the step report below follows
    }

    if( plan.executionTier === 'deliberate' ){
      const reported = this._supervisor.reportToFacet( plan, step, outcome )
      if( !reported ){
        // attention saturated / spawn failed → activateFacet downgraded to automatic
        logger.warn( `[planning] no facet to supervise plan ${planId}; continuing automatically` )
        this._executePlans()
      }
    }
  }

  // ── Plan completion / failure ──────────────────────────────

  private _onPlanCompleted( plan: Plan ): void {
    plan.status = 'completed'
    this._store.markTerminal( plan.id, this._lastTick )

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
    this._store.markTerminal( plan.id, this._lastTick )

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
      const plan = this._store.get( id )
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

  // ── Public API ─────────────────────────────────────────────

  /** The goal's active plan, or its most-recent plan if all are terminal. */
  getPlan( goalId: string ): Plan | undefined {
    const active = this._store.activePlanForGoal( goalId )
    if( active ) return active
    const all = this._store.plansForGoal( goalId )
    return all.length > 0 ? all[ all.length - 1 ] : undefined
  }

  /** All plans for a goal (any status), in creation order. (P4) */
  getPlansForGoal( goalId: string ): Plan[] {
    return this._store.plansForGoal( goalId )
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

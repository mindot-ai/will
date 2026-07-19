// ─────────────────────────────────────────────────────────────
// src/eval/planning.eval.ts  —  Planning-quality eval harness
// ─────────────────────────────────────────────────────────────
//
// A deterministic, no-LLM harness that measures how WELL a Will plans and
// supervises execution — a peer to PMAEvalHarness (which measures reconstruction
// *fidelity*; this measures planning *quality*).
//
// It drives the real PlanningEngine + GoalManager through a scripted scenario
// (authored plans + scripted step outcomes + a deterministic supervisor policy
// standing in for the LLM facet) and returns a PlanningScorecard. No executive
// LLM, no wall-clock, no RNG — same scenario ⇒ same scorecard (R2-safe), so it
// runs in CI and gates regressions.
//
// ── Correlation with the PMA ───────────────────────────────────
// Planning quality now depends on personality: the PMA seeds the Channel-A
// dispositions (goal-manager grit, planning conscientiousness/maxStepRetries) that
// govern how doggedly a Will retries, escalates, and refuses to abandon goals. The
// `persona` field of a scenario IS those PMA-seeded `engine-config-*` params:
//   • pin it  → reproducible regression scoring (measure the engine, not the persona)
//   • sweep it → measure how personality shapes planning outcomes (e.g. does higher
//                conscientiousness raise goal-completion, at what retry cost?)
// So the harness doesn't just *correlate* with the PMA — the PMA persona is its
// primary independent variable.
// ─────────────────────────────────────────────────────────────

import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { GoalManager }    from '#faculties/goal.manager'
import { planShapeKey }   from '#faculties/planning.engine/plan.store'
import { createTestBus }  from '#cognition/bus'
import type { StateCommands } from '#core/types'

// ── Scenario / scorecard types ─────────────────────────────────

/** PMA-seeded persona = the engine-config params the PMA assembles per Will. */
export interface EvalPersona {
  /** engine-config-planning params (e.g. maxStepRetries, surpriseOutcomeQuality). */
  planning?:    Record<string, number>
  /** engine-config-goal-manager params (e.g. gritPriority, gritPatienceScale). */
  goalManager?: Record<string, number>
  /** persona-prior deltas (the metacog-developed layer), keyed by engine-config id. */
  priors?:      Record<string, Record<string, number>>
}

export interface EvalGoal {
  description: string
  priority:    number          // ≥ deliberateGoalPriority (0.7) starts the plan deliberate
  tags?:       string[]
}

export interface EvalStep {
  action:          string
  description:     string
  expectedOutcome: string
  prerequisites?:  string[]
}

export interface EvalPlan {
  /** Index into scenario.goals this plan pursues. */
  goalIndex:        number
  steps:            EvalStep[]
  feasibility?:     number      // < lowPlanConfidence (0.5) also starts the plan deliberate
  expectedOutcome?: string
}

/** Outcome of one step attempt (1-based). Default: success at quality 0.9. */
export type OutcomeScript = ( stepId: string, attempt: number ) => { success: boolean; quality: number }

/** Deterministic supervisor — the facet's decision policy. Returns a directive (and
 *  revised steps for replan) or null to issue no decision. */
export type SupervisorPolicy = ( report: SupervisorReport ) => { directive: string; updatedSteps?: EvalStep[] } | null

export interface SupervisorReport {
  type:    string                                   // 'step_failed' | 'step_completed' | …
  planId:  string
  completedSteps: number
  totalSteps:     number
}

export interface PlanningScenario {
  name:        string
  persona?:    EvalPersona
  goals:       EvalGoal[]
  plans:       EvalPlan[]
  outcome?:    OutcomeScript      // default: always succeed
  supervisor?: SupervisorPolicy   // default: retry-on-fail / advance-on-success / complete-when-done
  tickBudget:  number
}

export interface PlanningScorecard {
  scenario:        string
  plansTotal:      number
  plansCompleted:  number
  plansFailed:     number
  plansStuck:      number          // non-terminal at budget end (e.g. retries exhausted)
  goalsTotal:      number
  goalsRetained:   number          // still active (grit kept them)
  goalsAbandoned:  number          // dropped by the goal-manager (staleness/frustration)
  supervision:     Record<string, number>   // replan/retry/skip/escalate/abandon counts
  ticksUsed:       number
  /** plans-completion fraction (0..1); the headline planning-quality number. */
  completionRate:  number
  /** Decomposition-shape stats over the authored plans (planShapeKey) — the
   *  demonstrated-need needle: repeats = re-derived shapes. */
  planShapes:      { distinct: number; repeats: number }
}

// ── Author comparison (the emergent-planning promotion gate) ───
// docs/strategy/__EMERGENT_PLANNING.md: a strategy is promoted only where it
// *dominates* executive planning on the same scenario class. This wraps two
// runs of the same scenario shell — one per author's plan decomposition — in
// a Pareto verdict. The harness is no-LLM, so authoring cost is a *declared*
// attribute of the authoring path (executive ≈ 1 LLM call per plan authored;
// strategy instantiation ≈ 0), not something measured here.

export interface PlanAuthorSpec {
  /** Who authored these plans — e.g. 'executive' (recorded) or a strategy id. */
  name:           string
  plans:          EvalPlan[]
  /** Declared authoring cost in LLM-call units. Default 0. */
  authoringCost?: number
}

export interface AuthorScorecard extends PlanningScorecard {
  author:        string
  authoringCost: number
}

export interface AuthorComparison {
  scenario: string
  a:        AuthorScorecard
  b:        AuthorScorecard
  /**
   * Pareto verdict over (completionRate ↑, goalsAbandoned ↓, ticksUsed ↓,
   * authoringCost ↓): an author dominates iff no axis is worse and at least
   * one is strictly better. 'mixed' is a trade-off — never a promotion.
   */
  verdict: 'a_dominates' | 'b_dominates' | 'tie' | 'mixed'
}

// ── Default supervisor: a competent, persona-agnostic baseline ──
// Retry a failed step (the persona's maxStepRetries cap decides if it sticks),
// advance on success, and close the plan when every step is done. Deterministic.
const defaultSupervisor: SupervisorPolicy = ( report ) => {
  if( report.type === 'step_failed')    return { directive: 'retry' }
  if( report.type === 'step_completed')
    return { directive: report.completedSteps >= report.totalSteps ? 'complete' : 'continue' }
  return null
}

// ── Harness ────────────────────────────────────────────────────

const TERMINAL = new Set( [ 'completed', 'failed', 'rejected' ] )

export class PlanningEvalHarness {

  /** Run one scenario deterministically and return its scorecard. */
  async run( scenario: PlanningScenario ): Promise<PlanningScorecard> {
    const bus     = createTestBus()
    const outcome = scenario.outcome    ?? ( () => ( { success: true, quality: 0.9 } ) )
    const supervise = scenario.supervisor ?? defaultSupervisor

    // Mutable replayable state seeded with the PMA persona (engine-config ⊕ priors).
    const state: any = { tick: 0, entities: new Map(), metrics: new Map( [ [ 'energy.level', 90 ] ] ) }
    this._seedPersona( state.entities, scenario.persona )

    // Goal-manager with the scenario's goals; capture the engine-assigned ids.
    const gm = new GoalManager()
    const goalIds = scenario.goals.map( g => gm.addGoal( g.description, g.priority, g.tags ?? [] ) )

    // Pending facet reports, drained after each tick (avoids re-entrant decisions).
    const pendingReports: Array<{ facet: any; report: SupervisorReport }> = []
    let facetSeq = 0
    const makeFacet = () => {
      const facet: any = {
        facetId: `eval-facet-${facetSeq++}`,
        setFocus: () => {}, setStateRef: () => {},
        subscribe: ( l: ( d: any ) => void ) => { facet.__decide = l; return () => {} },
        report: ( r: any ) => pendingReports.push( {
          facet,
          report: {
            type:           r.type,
            planId:         r.payload?.planId ?? '',
            completedSteps: r.payload?.planContext?.completedSteps ?? 0,
            totalSteps:     r.payload?.planContext?.totalSteps ?? 0,
          },
        } ),
        onChunk: () => {}, onReaped: () => {}, destroy: () => {},
      }
      return facet
    }

    // Scripted executive: authors the scenario's plans once, hands out fake facets.
    const latestOutput = {
      plans: scenario.plans.map( p => ( {
        action:          'execute',
        goalId:          goalIds[ p.goalIndex ],
        expectedOutcome: p.expectedOutcome ?? 'done',
        estimatedCost:   3,
        feasibility:     p.feasibility ?? 0.8,
        steps:           p.steps.map( s => ( {
          action: s.action, description: s.description,
          expectedOutcome: s.expectedOutcome, prerequisites: s.prerequisites ?? [], estimatedDuration: 3,
        } ) ),
      } ) ),
    }

    const planning = new PlanningEngine( { bus } )
    planning.attachGoalManager( gm )
    planning.attachExecutiveEngine( {
      isFresh: () => true,
      spawnFacet: () => ( { attention: 'available', handle: makeFacet() } ),
      latestOutput,
    } as any )

    const supervision: Record<string, number> = {}
    const attempts = new Map<string, number>()   // `${planId}:${stepId}` → attempt count
    let ticksUsed = scenario.tickBudget

    for( let tick = 1; tick <= scenario.tickBudget; tick++ ){
      state.tick = tick

      // Goal-manager first (grit / staleness abandonment reads the persona).
      const gr = await gm.react( 0 as any, tick as any, state, {} as any )
      applyCommands( state, [ gr.commands as StateCommands ] )

      // Planning: ingest (tick 1) + advance the ready frontier; capture supervision metrics.
      const pr = await planning.react( 0 as any, tick as any, state, {} as any )
      applyCommands( state, [ pr.commands as StateCommands ] )
      for( const [ k, v ] of ( pr.commands?.metrics ?? [] ) )
        if( typeof k === 'string' && k.startsWith('planning.supervision.') )
          supervision[ k.replace('planning.supervision.', '') ] = v as number

      // Inject scripted outcomes for every active frontier step — this deterministic
      // harness short-circuits the agency competition (it scores the planner's
      // supervision policy, not action-selection) by feeding the action.outcome the
      // competition would have produced when the plan's frontier prior won + enacted.
      for( const goalId of goalIds ){
        const plan = planning.getPlan( goalId )
        if( !plan ) continue
        for( const step of plan.steps ){
          if( step.status !== 'active') continue
          const key     = `${plan.id}:${step.id}`
          const attempt = ( attempts.get( key ) ?? 0 ) + 1
          attempts.set( key, attempt )
          const o = outcome( step.id, attempt )
          planning.onCognitiveEvent( stepOutcome( plan.id, step.id, o ) )
        }
      }

      // Drain facet reports → supervisor → decision (deliberate-plan supervision).
      while( pendingReports.length > 0 ){
        const { facet, report } = pendingReports.shift()!
        const decision = supervise( report )
        if( decision )
          facet.__decide?.( {
            facetId: facet.facetId, respondingToType: report.type,
            decision, reasoning: 'eval', confidence: 1,
          } )
      }

      // Early-exit only once every *scripted* plan is terminal. Plan-less scenarios
      // (e.g. a grit/persistence probe) must run the full budget so goal staleness
      // can play out — they never satisfy this and fall through to tickBudget.
      const plansSettled = scenario.plans.length > 0 && scenario.plans.every( pl => {
        const p = planning.getPlan( goalIds[ pl.goalIndex ]! )
        return !!p && TERMINAL.has( p.status )
      } )
      if( plansSettled ){ ticksUsed = tick; break }
    }

    return this._scorecard( scenario, planning, gm, goalIds, supervision, ticksUsed )
  }

  /**
   * Run the same scenario shell under two plan authors and return the Pareto
   * verdict — the promotion gate for emergent planning strategies. Both runs
   * share goals, outcome script, supervisor policy, persona, and tick budget;
   * only the authored decomposition (and its declared cost) differs.
   */
  async compareAuthors(
    shell: Omit<PlanningScenario, 'plans'>,
    a: PlanAuthorSpec,
    b: PlanAuthorSpec,
  ): Promise<AuthorComparison> {
    const sa = await this.run( { ...shell, name: `${ shell.name }·${ a.name }`, plans: a.plans } )
    const sb = await this.run( { ...shell, name: `${ shell.name }·${ b.name }`, plans: b.plans } )
    const A: AuthorScorecard = { ...sa, author: a.name, authoringCost: a.authoringCost ?? 0 }
    const B: AuthorScorecard = { ...sb, author: b.name, authoringCost: b.authoringCost ?? 0 }
    return { scenario: shell.name, a: A, b: B, verdict: paretoVerdict( A, B ) }
  }

  // ── Internals ────────────────────────────────────────────────

  private _seedPersona( entities: Map<string, any>, persona?: EvalPersona ): void {
    if( !persona ) return
    if( persona.planning )
      entities.set('engine-config-planning', { id: 'engine-config-planning', type: 'engine-config', metadata: { params: persona.planning } } )
    if( persona.goalManager )
      entities.set('engine-config-goal-manager', { id: 'engine-config-goal-manager', type: 'engine-config', metadata: { params: persona.goalManager } } )
    if( persona.priors )
      entities.set('persona-prior', { id: 'persona-prior', type: 'persona.prior', metadata: { priors: persona.priors, version: 1, updatedAtTick: 0 } } )
  }

  private _scorecard(
    scenario: PlanningScenario, planning: PlanningEngine, gm: GoalManager,
    goalIds: string[], supervision: Record<string, number>, ticksUsed: number,
  ): PlanningScorecard {
    let plansTotal = 0, plansCompleted = 0, plansFailed = 0, plansStuck = 0
    for( const id of goalIds ){
      const p = planning.getPlan( id )
      if( !p ) continue
      plansTotal++
      if( p.status === 'completed')      plansCompleted++
      else if( p.status === 'failed' || p.status === 'rejected') plansFailed++
      else plansStuck++
    }

    const retained = gm.getActiveGoals().filter( g => goalIds.includes( g.id ) ).length

    const shapeKeys = scenario.plans.map( p => planShapeKey( p.steps ) )
    const distinct  = new Set( shapeKeys ).size

    return {
      scenario:       scenario.name,
      plansTotal, plansCompleted, plansFailed, plansStuck,
      goalsTotal:     goalIds.length,
      goalsRetained:  retained,
      goalsAbandoned: goalIds.length - retained,
      supervision,
      ticksUsed,
      completionRate: plansTotal > 0 ? Math.round( ( plansCompleted / plansTotal ) * 1000 ) / 1000 : 0,
      planShapes:     { distinct, repeats: shapeKeys.length - distinct },
    }
  }
}

/** Pareto dominance over the promotion axes — see AuthorComparison.verdict. */
function paretoVerdict( a: AuthorScorecard, b: AuthorScorecard ): AuthorComparison['verdict'] {
  // Each axis normalized so HIGHER is better.
  const axes: Array<[ number, number ]> = [
    [ a.completionRate,  b.completionRate  ],
    [ -a.goalsAbandoned, -b.goalsAbandoned ],
    [ -a.ticksUsed,      -b.ticksUsed      ],
    [ -a.authoringCost,  -b.authoringCost  ],
  ]
  let aBetter = false, bBetter = false
  for( const [ av, bv ] of axes ){
    if( av > bv )      aBetter = true
    else if( bv > av ) bBetter = true
  }
  if( aBetter && bBetter ) return 'mixed'
  if( aBetter )            return 'a_dominates'
  if( bBetter )            return 'b_dominates'
  return 'tie'
}

// ── Module utilities ───────────────────────────────────────────

/** Apply a batch of StateCommands to the mutable eval state (mirrors the Orchestrator). */
function applyCommands( state: any, batches: StateCommands[] ): void {
  for( const c of batches ){
    for( const e of c.set ?? [] )            state.entities.set( e.id, e )
    for( const id of c.delete ?? [] )        state.entities.delete( id )
    for( const [ k, v ] of c.metrics ?? [] ) state.metrics.set( k, v )
  }
}

/** A scripted action.outcome event that echoes the plan/step ids (PLANNING P1 contract). */
function stepOutcome( planId: string, stepId: string, o: { success: boolean; quality: number } ): any {
  return {
    type: 'action.outcome', salience: 0.6,
    payload: {
      actionType: 'observe', domain: 'eval',
      success: o.success, outcomeQuality: o.quality,
      description: o.success ? 'ok' : 'failed', planId, stepId,
    },
  }
}

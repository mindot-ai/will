// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/planning.engine/plan.store.ts — canonical plan state
// ─────────────────────────────────────────────────────────────
//
// Owns every map the engine used to hold: the canonical plan store, the
// goal-scoped index (P4: multiple plans per goal), terminal bookkeeping
// (persist-once + retention GC — P5), and the id counter. Pure state +
// deterministic bookkeeping; no bus, no facets, no LLM.
//
// Extracted verbatim from planning.engine.ts — behavior identical.
// ─────────────────────────────────────────────────────────────

import type { Tick, StateCommands } from '#core/types'
import { TERMINAL_STATUSES, type Plan } from '#faculties/planning.engine/types'

export class PlanStore {
  /**
   * Canonical plan store, keyed by plan.id ("plan-N") — the id the execution,
   * outcome (`action.outcome.planId`) and facet paths all use.
   */
  private _plans = new Map<string, Plan>()
  /**
   * Secondary index goalId → ordered plan.ids (creation order). Multiple plans
   * per goal supported (P4); terminal plans stay in the list as history and are
   * filtered out by activePlanForGoal. Goal-scoped reads route through the
   * helpers below.
   */
  private _planByGoal = new Map<string, string[]>()
  /**
   * Plan ids already persisted in a terminal state. Terminal plans never change
   * again, so they are persisted once and then skipped by persist() — avoids
   * unbounded state-write amplification as completed/failed plans accumulate. (P5)
   */
  private _persistedTerminal = new Set<string>()
  /** planId → sim tick it became terminal; drives retention GC (gcTerminal). */
  private _terminalAt = new Map<string, number>()
  private _planCounter = 0

  // ── Reads ──────────────────────────────────────────────────

  get size(): number { return this._plans.size }

  get( planId: string ): Plan | undefined { return this._plans.get( planId ) }
  has( planId: string ): boolean          { return this._plans.has( planId ) }
  all(): IterableIterator<Plan>           { return this._plans.values() }

  isTerminal( plan: Plan ): boolean { return TERMINAL_STATUSES.includes( plan.status ) }

  /** All plans for a goal, in creation order (any status). */
  plansForGoal( goalId: string ): Plan[] {
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
  activePlanForGoal( goalId: string ): Plan | undefined {
    const all = this.plansForGoal( goalId )
    for( let i = all.length - 1; i >= 0; i-- )
      if( !TERMINAL_STATUSES.includes( all[ i ]!.status ) ) return all[ i ]
    return undefined
  }

  /**
   * Resolve which plan an executive plan-op targets. Prefers an explicit
   * `planId` (must belong to the same goal); otherwise falls back to the goal's
   * active plan. Returns undefined when neither resolves (caller may create one).
   */
  resolveIngestTarget( goalId: string, planId?: string ): Plan | undefined {
    if( planId ){
      const p = this._plans.get( planId )
      if( p && p.goalId === goalId ) return p
    }
    return this.activePlanForGoal( goalId )
  }

  // ── Writes ─────────────────────────────────────────────────

  /** Next sequential plan id ("plan-N") — deterministic, never PRNG. */
  nextId(): string {
    this._planCounter++
    return `plan-${this._planCounter}`
  }

  /** Register a plan in both the canonical store and the goal index. */
  index( plan: Plan ): void {
    this._plans.set( plan.id, plan )
    const ids = this._planByGoal.get( plan.goalId ) ?? []
    ids.push( plan.id )
    this._planByGoal.set( plan.goalId, ids )
  }

  /** Record the tick a plan entered a terminal status (drives retention GC). */
  markTerminal( planId: string, tick: number ): void {
    this._terminalAt.set( planId, tick )
  }

  // ── Retention GC ───────────────────────────────────────────

  /**
   * Evict terminal plans (and delete their state entity) once they've been
   * terminal longer than the retention window. Terminal plans never change, so
   * retaining them forever accretes memory + state entities on a long-lived mind.
   * Deterministic: the window is compared against sim ticks (R2-safe).
   * `onEvict` lets the engine tear down any facet still keyed to the plan.
   */
  gcTerminal( tick: Tick, commands: StateCommands, retentionTicks: number, onEvict: ( planId: string ) => void ): void {
    const now = tick as unknown as number
    let evicted = 0

    for( const [ id, plan ] of this._plans ){
      if( !TERMINAL_STATUSES.includes( plan.status ) ) continue
      const since = this._terminalAt.get( id ) ?? now
      if( now - since <= retentionTicks ) continue

      this._plans.delete( id )
      this._persistedTerminal.delete( id )
      this._terminalAt.delete( id )
      onEvict( id )   // safety — a terminal plan shouldn't still hold a facet

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

  persist( commands: StateCommands, tick: Tick ): void {
    for( const plan of this._plans.values() ){
      // Terminal plans never change again — persist once (in their terminal state)
      // then skip, so completed/failed/rejected plans don't re-serialize every
      // tick forever (unbounded write amplification on long sessions). (P5)
      const terminal = TERMINAL_STATUSES.includes( plan.status )
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
}

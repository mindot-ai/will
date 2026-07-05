// ─────────────────────────────────────────────────────────────
// tests/unit/planning.execution.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression coverage for the plan-execution feedback loop (PLANNING_PIPELINE P1).
 *
 * The bug: `_plans` was keyed by `goalId` while the `action.outcome` path looks
 * plans up by `plan.id` ("plan-N"). ActionExecutor echoes `plan.id` back as
 * `action.outcome.payload.planId`, so the lookup always missed → step outcomes
 * were silently dropped → no plan ever reached `completed`/`failed`.
 *
 * These tests drive a plan from executive output through dispatch, feed matching
 * `action.outcome` events into `onCognitiveEvent` (the same entry the orchestrator
 * uses), and assert the plan actually progresses and terminates.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PlanningEngine }  from '#cognition/faculties/planning.engine/engine'
import { createTestBus }   from '#cognition/bus'

// ── Minimal collaborators ─────────────────────────────────────

/** Executive stub: exposes a single, stable `latestOutput` (ref-stable so the
 *  engine's once-per-cycle ingest guard skips re-ingest on later ticks). */
function makeExecutiveStub( steps: Array<{
  action: string; description: string; expectedOutcome: string
  prerequisites?: string[]; estimatedDuration: number
}>, tier: 'automatic' | 'deliberate' = 'automatic' ){
  const latestOutput = {
    plans: [ {
      action:        'execute',
      goalId:        'goal-1',
      executionTier: tier,
      expectedOutcome: 'goal reached',
      estimatedCost: 5,
      feasibility:   0.8,
      steps,
    } ],
  }
  return { latestOutput, isFresh: () => true } as any
}

const goalStub = { getGoal: () => undefined, getActiveGoals: () => [] } as any

/** A bare ReadonlySimulationState good enough for react() with heuristics off. */
const makeState = ( tick: number ) =>
  ( { tick, metrics: new Map(), entities: new Map() } as any )

const outcome = (
  planId: string, stepId: string, success = true, outcomeQuality = 0.8,
) => ( {
  type: 'action.outcome',
  salience: 0.6,
  payload: {
    actionType: 'observe', domain: 'general',
    success, outcomeQuality, description: success ? 'ok' : 'nope',
    planId, stepId,
  },
} as any )

// ── Tests ─────────────────────────────────────────────────────

describe( 'PlanningEngine — step outcome resolution (P1)', () => {
  let bus:    ReturnType<typeof createTestBus>
  let engine: PlanningEngine
  let published: Array<{ type: string; payload: any }>

  beforeEach( () => {
    bus       = createTestBus()
    published = []
    bus.subscribe( 'collector',
      [ 'plan.started', 'plan.step.activated', 'plan.step.outcome', 'plan.completed', 'plan.failed' ],
      e => { published.push( { type: e.type, payload: e.payload as any } ) },
    )
    engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )
  } )

  it( 'completes a two-step dependent plan as outcomes arrive (keyed by plan.id)', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 },
      { action: 'reflect', description: 'think', expectedOutcome: 'insight', prerequisites: [ 'step-0' ], estimatedDuration: 5 },
    ] ) )

    // Tick 1: ingest + start + activate step-0 (step-1 blocked on its prereq).
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    const plan = engine.getPlan( 'goal-1' )
    expect( plan ).toBeDefined()
    expect( plan!.id ).toBe( 'plan-1' )
    expect( plan!.status ).toBe( 'executing' )
    expect( plan!.steps[ 0 ]?.status ).toBe( 'active' )
    expect( plan!.steps[ 1 ]?.status ).toBe( 'pending' )

    // step-0 outcome → resolves by plan.id, marks step-0 completed.
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    expect( plan!.steps[ 0 ]?.status ).toBe( 'completed' )

    // Tick 2: prereq satisfied → step-1 activated.
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )
    expect( plan!.steps[ 1 ]?.status ).toBe( 'active' )

    // step-1 outcome → completed.
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-1' ) )
    expect( plan!.steps[ 1 ]?.status ).toBe( 'completed' )

    // Tick 3: all steps done → plan completes + emits plan.completed.
    await engine.react( 0 as any, 3 as any, makeState( 3 ), {} as any )
    expect( plan!.status ).toBe( 'completed' )

    const completedEvt = published.find( e => e.type === 'plan.completed' )
    expect( completedEvt ).toBeDefined()
    expect( completedEvt!.payload.planId ).toBe( 'plan-1' )
    expect( completedEvt!.payload.goalId ).toBe( 'goal-1' )
  } )

  it( 'ignores a late step outcome once the plan is no longer executing (executive-complete / in-flight resolution)', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )   // executing, step-0 active
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )              // its prior won + enacted
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )   // all done → plan completes
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )

    const outcomesBefore = published.filter( e => e.type === 'plan.step.outcome' ).length

    // A second outcome carrying the same plan provenance arrives LATE — e.g. an intent
    // the competition had committed from the frontier before completion finally resolves
    // (or the executive force-completed mid-flight). The terminal plan must ignore it:
    // status unchanged, no new step.outcome re-published, no torn-down facet resurrected.
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )

    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )
    expect( published.filter( e => e.type === 'plan.step.outcome' ).length ).toBe( outcomesBefore )
  } )

  it( 'fails a completion-tier plan when a step fails', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', /* success */ false, 0.1 ) )
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )

    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'failed' )
    expect( published.find( e => e.type === 'plan.failed' ) ).toBeDefined()
  } )

  it( 'ignores an outcome whose planId is not a known plan.id (e.g. the goalId)', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    // The old bug keyed by goalId — prove an outcome stamped with the goalId is
    // NOT resolved; only the real plan.id ("plan-1") advances a step.
    engine.onCognitiveEvent( outcome( 'goal-1', 'step-0' ) )
    expect( engine.getPlan( 'goal-1' )!.steps[ 0 ]?.status ).toBe( 'active' )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    expect( engine.getPlan( 'goal-1' )!.steps[ 0 ]?.status ).toBe( 'completed' )
  } )
} )

// ── P2: facet reaping degrades to completion tier ─────────────

describe( 'PlanningEngine — reaped facet degrades the plan (P2)', () => {
  it( 'drops the dead handle and finishes via completion tier when the facet is reaped', async () => {
    const bus = createTestBus()
    const published: Array<{ type: string }> = []
    bus.subscribe( 'collector', [ 'plan.completed' ], e => { published.push( { type: e.type } ) } )

    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )

    // Fake facet handle that captures the onReaped callback the engine registers.
    let reaped: ( () => void ) | undefined
    const fakeFacet = {
      facetId:     'facet-1',
      setFocus:    () => {},
      setStateRef: () => {},
      subscribe:   () => () => {},
      report:      () => {},
      onChunk:     () => {},
      onReaped:    ( h: () => void ) => { reaped = h },
      destroy:     () => {},
    }

    // Mutable executive output: draft first, then a fresh `execute`. Low feasibility
    // (0.3 < lowPlanConfidence) makes the engine INFER deliberate at execute (emergent
    // tier) → _activateFacet → spawnFacet. The executive no longer sets the tier.
    const steps = [ { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 } ]
    const exec: any = {
      isFresh: () => true,
      spawnFacet: () => ( { attention: 'available', handle: fakeFacet } ),
      latestOutput: { plans: [ { action: 'draft', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.3, steps } ] },
    }
    engine.attachExecutiveEngine( exec )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )   // draft
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'draft' )

    exec.latestOutput = { plans: [ { action: 'execute', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.3, steps } ] }
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )   // execute → facet
    const plan = engine.getPlan( 'goal-1' )!
    expect( plan.executionTier ).toBe( 'deliberate' )
    expect( plan.steps[ 0 ]?.status ).toBe( 'active' )
    expect( reaped ).toBeTypeOf( 'function' )

    // Supervisor reaps the facet out from under the plan.
    reaped!()
    expect( plan.executionTier ).toBe( 'automatic' )

    // Step outcome now flows through the completion path — no dead-handle stall.
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    expect( plan.steps[ 0 ]?.status ).toBe( 'completed' )

    await engine.react( 0 as any, 3 as any, makeState( 3 ), {} as any )
    expect( plan.status ).toBe( 'completed' )
    expect( published.find( e => e.type === 'plan.completed' ) ).toBeDefined()
  } )

  it( 'spawns a facet on a first-cycle (no prior draft) step-aware execute (P2b)', async () => {
    const bus = createTestBus()
    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )

    let spawned = 0
    const fakeFacet = {
      facetId: 'facet-1', setFocus: () => {}, setStateRef: () => {},
      subscribe: () => () => {}, report: () => {}, onChunk: () => {},
      onReaped: () => {}, destroy: () => {},
    }
    const steps = [ { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 } ]
    engine.attachExecutiveEngine( {
      isFresh: () => true,
      spawnFacet: () => { spawned++; return { attention: 'available', handle: fakeFacet } },
      latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.3, steps } ] },
    } as any )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( spawned ).toBe( 1 )
  } )
} )

// ── P3: revised plans re-dispatch instead of stalling ─────────

describe( 'PlanningEngine — revise re-arms the plan (P3)', () => {
  it( 'dispatches revised steps instead of stranding the plan in "revised"', async () => {
    const bus = createTestBus()
    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )

    const step = ( action: string ) => ( { action, description: action, expectedOutcome: 'x', prerequisites: [], estimatedDuration: 3 } )
    const exec: any = {
      isFresh: () => true,
      latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', executionTier: 'automatic', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.8, steps: [ step( 'observe' ) ] } ] },
    }
    engine.attachExecutiveEngine( exec )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    const plan = engine.getPlan( 'goal-1' )!
    expect( plan.status ).toBe( 'executing' )
    expect( plan.steps ).toHaveLength( 1 )

    // Executive revises mid-flight with a different two-step approach.
    exec.latestOutput = { plans: [ { action: 'revise', goalId: 'goal-1', executionTier: 'automatic', expectedOutcome: 'x',
      steps: [ step( 'reflect' ), { action: 'talk', description: 'talk', expectedOutcome: 'x', prerequisites: [ 'step-0' ], estimatedDuration: 3 } ] } ] }
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )

    // Plan stays runnable, carries the revised steps, and dispatches the new step-0.
    expect( plan.status ).toBe( 'executing' )
    expect( plan.steps ).toHaveLength( 2 )
    expect( plan.steps[ 0 ]?.action ).toBe( 'reflect' )
    expect( plan.steps[ 0 ]?.status ).toBe( 'active' )
  } )
} )

// ── P5: terminal plans persist once, not every tick ───────────

describe( 'PlanningEngine — persists terminal plans once (P5)', () => {
  it( 'stops re-serializing a plan after it completes', async () => {
    const bus = createTestBus()
    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )
    const exec: any = {
      isFresh: () => true,
      latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', executionTier: 'automatic', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.8,
        steps: [ { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 } ] } ] },
    }
    engine.attachExecutiveEngine( exec )

    const planPersisted = ( r: { commands?: { set?: Array<{ id: string }> } } ) =>
      ( r.commands?.set ?? [] ).some( c => c.id === 'plan-1' )

    // Tick 1: created + executing → persisted (non-terminal).
    const r1 = await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( planPersisted( r1 ) ).toBe( true )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )

    // Tick 2: completes → persisted once in terminal state.
    const r2 = await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )
    expect( planPersisted( r2 ) ).toBe( true )

    // Tick 3+: terminal & already persisted → skipped.
    const r3 = await engine.react( 0 as any, 3 as any, makeState( 3 ), {} as any )
    expect( planPersisted( r3 ) ).toBe( false )
  } )
} )

// ── Retention GC: terminal plans are evicted after the window ──

describe( 'PlanningEngine — retention GC of terminal plans', () => {
  it( 'evicts a completed plan + deletes its entity once past the retention window', async () => {
    const bus = createTestBus()
    const engine = new PlanningEngine( { bus, planRetentionTicks: 5 } )
    engine.attachGoalManager( goalStub )
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { action: 'observe', description: 'look', expectedOutcome: 'info', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )   // dispatch step-0
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )   // completes (terminal @ tick 2)
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )

    // Within the window (5 - 2 = 3 ≤ 5) → retained.
    await engine.react( 0 as any, 5 as any, makeState( 5 ), {} as any )
    expect( engine.getPlansForGoal( 'goal-1' ) ).toHaveLength( 1 )

    // Past the window (9 - 2 = 7 > 5) → evicted + entity delete emitted.
    const r = await engine.react( 0 as any, 9 as any, makeState( 9 ), {} as any )
    expect( engine.getPlansForGoal( 'goal-1' ) ).toHaveLength( 0 )
    expect( engine.getPlan( 'goal-1' ) ).toBeUndefined()
    expect( ( r.commands?.delete ?? [] ).includes( 'plan-1' ) ).toBe( true )
  } )
} )

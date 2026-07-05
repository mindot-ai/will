// ─────────────────────────────────────────────────────────────
// tests/unit/planning.goal-sync.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Planning ↔ GoalManager lifecycle sync.
 *
 * A terminal goal (achieved/abandoned) makes its plans moot — the PlanningEngine
 * must cancel them so they stop dispatching steps. Previously PlanningEngine
 * reacted to no goal event, and `goal.abandoned` wasn't even a bus event.
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { GoalManager }    from '#faculties/goal.manager'
import { createTestBus }  from '#cognition/bus'

const makeState = ( tick: number ) => ( { tick, metrics: new Map(), entities: new Map() } as any )
const goalStub = { getGoal: () => undefined, getActiveGoals: () => [] } as any

const execStub = ( steps: any[] ) => ( {
  isFresh: () => true,
  latestOutput: { plans: [ {
    action: 'execute', goalId: 'goal-1', executionTier: 'automatic',
    expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.8, steps,
  } ] },
} as any )

const step = () => ( { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } )
const outcome = ( planId: string, stepId: string ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'general', success: true, outcomeQuality: 0.8, description: 'ok', planId, stepId },
} as any )
const goalEvent = ( type: string, goalId: string ) => ( { type, salience: 0.6, payload: { goalId } } as any )

// ── PlanningEngine cancels plans on terminal goal events ──────

describe( 'PlanningEngine — cancels plans when their goal goes terminal', () => {
  const armedEngine = async () => {
    const engine = new PlanningEngine( { bus: createTestBus() } )
    engine.attachGoalManager( goalStub )
    engine.attachExecutiveEngine( execStub( [ step() ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'executing' )
    return engine
  }

  it( 'cancels an active plan when its goal is achieved', async () => {
    const engine = await armedEngine()
    engine.onCognitiveEvent( goalEvent( 'goal.achieved', 'goal-1' ) )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'rejected' )
  } )

  it( 'emits a plan.cancelled activity event so SSE/socket watchers get closure', async () => {
    const bus = createTestBus()
    const cancelled: Array<{ type: string }> = []
    bus.subscribe( 'collector', [ 'plan.cancelled' ], e => { cancelled.push( { type: 'plan_cancelled' } ) } )

    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )
    engine.attachExecutiveEngine( execStub( [ step() ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( goalEvent( 'goal.abandoned', 'goal-1' ) )

    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'rejected' )
    expect( cancelled ).toHaveLength( 1 )   // bus event published → activity listener forwards it
  } )

  it( 'cancels an active plan when its goal is abandoned', async () => {
    const engine = await armedEngine()
    engine.onCognitiveEvent( goalEvent( 'goal.abandoned', 'goal-1' ) )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'rejected' )
  } )

  it( 'leaves an already-completed plan untouched (no double-handling)', async () => {
    const engine = new PlanningEngine( { bus: createTestBus() } )
    engine.attachGoalManager( goalStub )
    engine.attachExecutiveEngine( execStub( [ step() ] ) )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )   // dispatch
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )   // completes
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )

    engine.onCognitiveEvent( goalEvent( 'goal.achieved', 'goal-1' ) )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'completed' )   // unchanged
  } )
} )

// ── GoalManager publishes goal.abandoned on the bus ───────────

describe( 'GoalManager — abandonGoal emits a bus event', () => {
  it( 'publishes goal.abandoned with the goalId (so planning can react)', () => {
    const bus = createTestBus()
    const gm = new GoalManager( { bus } )
    const events: Array<{ payload: any }> = []
    bus.subscribe( 'collector', [ 'goal.abandoned' ], e => { events.push( { payload: e.payload } ) } )

    const goalId = gm.addGoal( 'a goal', 0.8, [ 'x' ] )
    gm.abandonGoal( goalId, 'no longer needed' )

    expect( events ).toHaveLength( 1 )
    expect( events[ 0 ]?.payload.goalId ).toBe( goalId )
  } )
} )

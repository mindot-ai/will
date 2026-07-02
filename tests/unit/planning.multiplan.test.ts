// ─────────────────────────────────────────────────────────────
// tests/unit/planning.multiplan.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * P4 — multiple plans per goal.
 *
 * Covers the engine data model (Set index, planId-addressed ingest, draft
 * stacking with re-assertion dedupe, parallel multi-plan execution, getPlan /
 * getPlansForGoal semantics) and the executive execution-awareness surface
 * (plan entities → ExecutiveContext.plans).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PlanningEngine }      from '#faculties/planning.engine'
import { createTestBus }       from '#cognition/bus'
import { buildExecutiveContext } from '#faculties/executive.engine/context'

// ── Helpers ───────────────────────────────────────────────────

const goalStub = { getGoal: () => undefined, getActiveGoals: () => [] } as any
const makeState = ( tick: number ) => ( { tick, metrics: new Map(), entities: new Map() } as any )

const step = ( action = 'observe' ) =>
  ( { action, description: action, expectedOutcome: 'x', prerequisites: [], estimatedDuration: 3 } )

const draftOp = ( goalId: string, expected: string, steps = [ step() ] ) =>
  ( { action: 'draft', goalId, status: 'draft', executionTier: 'automatic', expectedOutcome: expected, estimatedCost: 3, feasibility: 0.8, steps } )

const executeOp = ( planId: string | undefined, goalId: string, expected: string, steps = [ step() ] ) =>
  ( { action: 'execute', planId, goalId, status: 'approved', executionTier: 'automatic', expectedOutcome: expected, estimatedCost: 3, feasibility: 0.8, steps } )

const outcome = ( planId: string, stepId: string, success = true ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'general', success, outcomeQuality: 0.8, description: 'ok', planId, stepId },
} as any )

// ── Engine: multiple plans per goal ───────────────────────────

describe( 'PlanningEngine — multiple plans per goal (P4)', () => {
  let bus:    ReturnType<typeof createTestBus>
  let engine: PlanningEngine
  let exec:   { isFresh: () => boolean; latestOutput: any }

  beforeEach( () => {
    bus    = createTestBus()
    engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( goalStub )
    exec = { isFresh: () => true, latestOutput: null }
    engine.attachExecutiveEngine( exec as any )
  } )

  const feed = async ( plans: any[], tick: number ) => {
    exec.latestOutput = { plans }   // fresh object each cycle → re-ingested
    await engine.react( 0 as any, tick as any, makeState( tick ), {} as any )
  }

  it( 'stacks distinct drafts into separate plans for the same goal', async () => {
    await feed( [ draftOp( 'goal-1', 'Outcome A' ) ], 1 )
    await feed( [ draftOp( 'goal-1', 'Outcome B' ) ], 2 )

    const plans = engine.getPlansForGoal( 'goal-1' )
    expect( plans ).toHaveLength( 2 )
    expect( plans.map( p => p.id ) ).toEqual( [ 'plan-1', 'plan-2' ] )
    expect( plans.map( p => p.expectedOutcome ) ).toEqual( [ 'Outcome A', 'Outcome B' ] )
  } )

  it( 'dedupes a re-asserted draft (same expectedOutcome) instead of stacking', async () => {
    await feed( [ draftOp( 'goal-1', 'Same outcome' ) ], 1 )
    await feed( [ draftOp( 'goal-1', 'Same outcome' ) ], 2 )

    expect( engine.getPlansForGoal( 'goal-1' ) ).toHaveLength( 1 )
  } )

  it( 'execute with explicit planId targets that specific plan', async () => {
    await feed( [ draftOp( 'goal-1', 'Outcome A' ) ], 1 )   // plan-1
    await feed( [ draftOp( 'goal-1', 'Outcome B' ) ], 2 )   // plan-2

    // Without a planId this would hit the active (most-recent) plan, plan-2.
    await feed( [ executeOp( 'plan-1', 'goal-1', 'Outcome A' ) ], 3 )

    const all = engine.getPlansForGoal( 'goal-1' )
    expect( all.find( p => p.id === 'plan-1' )!.status ).toBe( 'executing' )
    expect( all.find( p => p.id === 'plan-2' )!.status ).toBe( 'draft' )
  } )

  it( 'runs two plans for one goal in parallel and completes each independently', async () => {
    await feed( [ draftOp( 'goal-1', 'A' ) ], 1 )   // plan-1
    await feed( [ draftOp( 'goal-1', 'B' ) ], 2 )   // plan-2
    await feed( [ executeOp( 'plan-1', 'goal-1', 'A' ), executeOp( 'plan-2', 'goal-1', 'B' ) ], 3 )

    const all = engine.getPlansForGoal( 'goal-1' )
    expect( all.every( p => p.status === 'executing' ) ).toBe( true )
    expect( all.every( p => p.steps[ 0 ]?.status === 'active' ) ).toBe( true )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0' ) )
    engine.onCognitiveEvent( outcome( 'plan-2', 'step-0' ) )
    await engine.react( 0 as any, 4 as any, makeState( 4 ), {} as any )

    expect( engine.getPlansForGoal( 'goal-1' ).find( p => p.id === 'plan-1' )!.status ).toBe( 'completed' )
    expect( engine.getPlansForGoal( 'goal-1' ).find( p => p.id === 'plan-2' )!.status ).toBe( 'completed' )
  } )

  it( 'getPlan returns the active plan; falls back to most-recent when all terminal', async () => {
    await feed( [ draftOp( 'goal-1', 'A' ) ], 1 )
    await feed( [ draftOp( 'goal-1', 'B' ) ], 2 )
    expect( engine.getPlan( 'goal-1' )!.id ).toBe( 'plan-2' )   // most-recent active

    // Cancel both → all terminal → getPlan falls back to the most-recent (plan-2).
    await feed( [ { action: 'cancel', planId: 'plan-1', goalId: 'goal-1', status: 'rejected', steps: [], estimatedCost: 0, feasibility: 0 },
                  { action: 'cancel', planId: 'plan-2', goalId: 'goal-1', status: 'rejected', steps: [], estimatedCost: 0, feasibility: 0 } ], 3 )
    expect( engine.getPlan( 'goal-1' )!.id ).toBe( 'plan-2' )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'rejected' )
  } )
} )

// ── Executive context: execution awareness ────────────────────

describe( 'buildExecutiveContext — plan awareness (P4)', () => {
  it( 'surfaces persisted plan entities into context.plans', async () => {
    const planEntity = {
      id: 'plan-1', type: 'plan',
      metadata: {
        goalId: 'goal-1', status: 'executing', executionTier: 'automatic',
        expectedOutcome: 'Reach X',
        steps: [ { status: 'completed' }, { status: 'pending' } ],
      },
    }
    const state = { tick: 5, metrics: new Map(), entities: new Map( [ [ 'plan-1', planEntity ] ] ) } as any

    const ctx = await buildExecutiveContext( state, {
      workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null,
    } )

    expect( ctx.plans ).toHaveLength( 1 )
    expect( ctx.plans[ 0 ] ).toMatchObject( {
      id: 'plan-1', goalId: 'goal-1', status: 'executing',
      executionTier: 'automatic', totalSteps: 2, completedSteps: 1, expectedOutcome: 'Reach X',
    } )
  } )
} )

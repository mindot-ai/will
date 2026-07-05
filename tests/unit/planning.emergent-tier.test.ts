// ─────────────────────────────────────────────────────────────
// tests/unit/planning.emergent-tier.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Emergent supervision tier — the executive no longer sets the tier; the engine
 * infers it. Top-down: important (high-priority goal) or uncertain (low-confidence)
 * plans start `deliberate` (a facet supervises). Bottom-up: an `automatic` plan
 * escalates to `deliberate` on a surprising step outcome (failure / very low quality).
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { createTestBus }  from '#cognition/bus'

const makeState = ( tick: number ) => ( { tick, metrics: new Map(), entities: new Map() } as any )
const step = () => ( { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } )

const outcome = ( planId: string, stepId: string, success = true, q = 0.8 ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'g', success, outcomeQuality: q, description: 'd', planId, stepId },
} as any )

function setup( { priority = 0, feasibility = 0.8 }: { priority?: number; feasibility?: number } ) {
  const bus = createTestBus()
  let spawned = 0
  const fakeFacet = {
    facetId: 'f', setFocus: () => {}, setStateRef: () => {}, subscribe: () => () => {},
    report: () => {}, onChunk: () => {}, onReaped: () => {}, destroy: () => {},
  }
  const engine = new PlanningEngine( { bus } )
  engine.attachGoalManager( { getGoal: () => ( { id: 'goal-1', priority } ), getActiveGoals: () => [] } as any )
  engine.attachExecutiveEngine( {
    isFresh: () => true,
    spawnFacet: () => { spawned++; return { attention: 'available', handle: fakeFacet } },
    latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility, steps: [ step() ] } ] },
  } as any )
  return { engine, spawned: () => spawned }
}

describe( 'PlanningEngine — emergent supervision tier', () => {
  it( 'starts DELIBERATE for a high-priority goal (top-down)', async () => {
    const { engine, spawned } = setup( { priority: 0.9 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'deliberate' )
    expect( spawned() ).toBe( 1 )
  } )

  it( 'starts DELIBERATE for a low-confidence plan (top-down)', async () => {
    const { engine, spawned } = setup( { priority: 0, feasibility: 0.3 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'deliberate' )
    expect( spawned() ).toBe( 1 )
  } )

  it( 'stays AUTOMATIC for a routine confident plan; a clean success does not escalate', async () => {
    const { engine, spawned } = setup( { priority: 0.3, feasibility: 0.8 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'automatic' )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', true, 0.8 ) )   // success → no surprise
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'automatic' )
    expect( spawned() ).toBe( 0 )
  } )

  it( 'ESCALATES an automatic plan to deliberate on step FAILURE (bottom-up)', async () => {
    const { engine, spawned } = setup( { priority: 0.3, feasibility: 0.8 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'automatic' )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', false, 0.1 ) )   // failure → escalate
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'deliberate' )
    expect( spawned() ).toBe( 1 )
  } )

  it( 'ESCALATES on a surprising low-quality success (quality < threshold)', async () => {
    const { engine, spawned } = setup( { priority: 0.3, feasibility: 0.8 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', true, 0.1 ) )   // 0.1 < 0.25 → escalate
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'deliberate' )
    expect( spawned() ).toBe( 1 )
  } )
} )

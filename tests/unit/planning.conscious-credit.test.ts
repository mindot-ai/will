// ─────────────────────────────────────────────────────────────
// tests/unit/planning.conscious-credit.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Conscious-enaction credit + legacy plan-entity sweep.
 *
 * The bug (observed live): `action.outcome` credits a plan step only when it
 * carries planId/stepId provenance — i.e. when the plan's own frontier prior
 * won the competition. When the executive consciously performs the very action
 * an active step calls for (via ideomotor), the outcome has no provenance, the
 * step starves, the goal reads blocked, and the executive re-authors the same
 * plan over and over (8 authorings for one goal, zero completions).
 *
 * Fix: outcomes without provenance fall back to matching an executing plan's
 * *active* step by action name — deterministic first match, one credit per
 * outcome. Plus: the executive commands path no longer writes raw
 * `plan-executive-*` entities, and the engine sweeps legacy ones once on wake.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { createTestBus }  from '#cognition/bus'

function makeExecutiveStub( plans: Array<{
  goalId: string
  steps:  Array<{ action: string; description: string; expectedOutcome: string; estimatedDuration: number }>
}> ){
  const latestOutput = {
    plans: plans.map( p => ( {
      action:          'execute',
      goalId:          p.goalId,
      executionTier:   'automatic',
      expectedOutcome: 'goal reached',
      estimatedCost:   5,
      feasibility:     0.8,
      steps:           p.steps,
    } ) ),
  }
  return { latestOutput, isFresh: () => true } as any
}

const goalStub  = { getGoal: () => undefined, getActiveGoals: () => [] } as any
const makeState = ( tick: number, entities = new Map() ) =>
  ( { tick, metrics: new Map(), entities } as any )

const step = ( action: string ) =>
  ( { action, description: 'd', expectedOutcome: 'o', estimatedDuration: 3 } )

/** An outcome WITHOUT plan provenance — as conscious/ideomotor enactions emit. */
const bareOutcome = ( actionType: string, success = true ) => ( {
  type: 'action.outcome',
  salience: 0.6,
  payload: {
    actionType, domain: 'general',
    success, outcomeQuality: 0.8, description: success ? 'ok' : 'nope',
  },
} as any )

describe( 'PlanningEngine — conscious-enaction credit (no-provenance outcomes)', () => {
  let engine: PlanningEngine

  beforeEach( () => {
    engine = new PlanningEngine( { bus: createTestBus() } )
    engine.attachGoalManager( goalStub )
  } )

  it( 'credits the matching active step when the outcome carries no provenance', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [ { goalId: 'goal-1', steps: [ step('remember') ] } ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )   // ingest + activate

    engine.onCognitiveEvent( bareOutcome('remember') )
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )   // advance

    expect( engine.getPlan('goal-1')?.status ).toBe( 'completed' )
  } )

  it( 'does not credit when no active step matches the action', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [ { goalId: 'goal-1', steps: [ step('remember') ] } ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( bareOutcome('express') )                     // unrelated action
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )

    const plan = engine.getPlan('goal-1')!
    expect( plan.status ).toBe( 'executing' )
    expect( plan.steps[0]!.status ).toBe( 'active' )
  } )

  it( 'credits exactly one step per outcome when two plans want the same action', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [
      { goalId: 'goal-1', steps: [ step('observe') ] },
      { goalId: 'goal-2', steps: [ step('observe') ] },
    ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( bareOutcome('observe') )
    await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )

    const done = [ engine.getPlan('goal-1')!, engine.getPlan('goal-2')! ]
      .filter( p => p.status === 'completed' ).length
    expect( done ).toBe( 1 )                                              // first match only

    engine.onCognitiveEvent( bareOutcome('observe') )
    await engine.react( 0 as any, 3 as any, makeState( 3 ), {} as any )
    expect( engine.getPlan('goal-2')?.status ).toBe( 'completed' )
  } )

  it( 'failed conscious enactions also land (step fails, supervision can react)', async () => {
    engine.attachExecutiveEngine( makeExecutiveStub( [ { goalId: 'goal-1', steps: [ step('inquire') ] } ] ) )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( bareOutcome('inquire', false ) )
    expect( engine.getPlan('goal-1')!.steps[0]!.status ).toBe( 'failed' )
  } )
} )

describe( 'PlanningEngine — legacy plan-executive-* sweep', () => {
  it( 'deletes legacy raw plan entities once, on the first react', async () => {
    const engine = new PlanningEngine( { bus: createTestBus() } )
    engine.attachGoalManager( goalStub )

    const legacy = new Map( [ [ 'plan-executive-goal-5-626', {
      id: 'plan-executive-goal-5-626', type: 'plan',
      metadata: { goalId: 'goal-5', status: 'ready', source: 'executive' },
    } ] ] )

    const r1 = await engine.react( 0 as any, 1 as any, makeState( 1, legacy ), {} as any )
    expect( r1.commands?.delete ).toContain( 'plan-executive-goal-5-626' )

    const r2 = await engine.react( 0 as any, 2 as any, makeState( 2, legacy ), {} as any )
    expect( r2.commands?.delete ?? [] ).not.toContain( 'plan-executive-goal-5-626' )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/planning.supervision.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Phase 2 remainder — replan is surfaced + measured. A mid-flight `replan` (the mind
 * rewriting its own plan) now raises a `plan.replanned` signal the master can notice,
 * and every supervisory directive is tallied into `planning.supervision.*` metrics so
 * the planning-quality eval harness can measure how the mind corrects course.
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { createTestBus }  from '#cognition/bus'

const makeState = ( t: number ) => ( { tick: t, metrics: new Map(), entities: new Map() } as any )
const step = () => ( { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } )
const outcome = ( planId: string, stepId: string ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'g', success: false, outcomeQuality: 0.1, description: 'd', planId, stepId },
} as any )
const replanWith = ( steps: any[] ) =>
  ( { facetId: 'f', respondingToType: 'step_failed',
      decision: { directive: 'replan', updatedSteps: steps }, reasoning: 'try another way', confidence: 0.8 } )

function setup() {
  const bus = createTestBus()
  let decide: ( ( d: any ) => void ) | undefined
  const fakeFacet = {
    facetId: 'f', setFocus: () => {}, setStateRef: () => {},
    subscribe: ( l: ( d: any ) => void ) => { decide = l; return () => {} },
    report: () => {}, onChunk: () => {}, onReaped: () => {}, destroy: () => {},
  }
  const engine = new PlanningEngine( { bus } )
  engine.attachGoalManager( { getGoal: () => ( { id: 'goal-1', priority: 0.9 } ), getActiveGoals: () => [] } as any )
  engine.attachExecutiveEngine( {
    isFresh: () => true,
    spawnFacet: () => ( { attention: 'available', handle: fakeFacet } ),
    latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.8, steps: [ step() ] } ] },
  } as any )
  return { engine, bus, decide: () => decide! }
}

describe('PlanningEngine — replan is surfaced + measured (Phase 2 remainder)', () => {
  it('a replan that rewrites steps raises plan.replanned for the master', async () => {
    const { engine, bus, decide } = setup()
    const replans: Array<{ payload: any }> = []
    bus.subscribe('collector', [ 'plan.replanned' ], e => { replans.push( { payload: e.payload } ) } )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    engine.onCognitiveEvent( outcome('plan-1', 'step-0') )
    decide()( replanWith( [ step(), step() ] ) )   // rewrite to 2 steps

    expect( replans ).toHaveLength( 1 )
    expect( replans[ 0 ]?.payload.planId ).toBe('plan-1')
    expect( replans[ 0 ]?.payload.stepCount ).toBe( 2 )
    expect( engine.getPlan('goal-1')!.steps ).toHaveLength( 2 )
  } )

  it('an empty replan (no steps) does not raise the signal', async () => {
    const { engine, bus, decide } = setup()
    const replans: any[] = []
    bus.subscribe('collector', [ 'plan.replanned' ], e => { replans.push( e ) } )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    engine.onCognitiveEvent( outcome('plan-1', 'step-0') )
    decide()( replanWith( [] ) )   // directive only, no revised steps

    expect( replans ).toHaveLength( 0 )
  } )

  it('supervisory decisions are tallied into planning.supervision.* metrics', async () => {
    const { engine, decide } = setup()
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    engine.onCognitiveEvent( outcome('plan-1', 'step-0') )
    decide()( replanWith( [ step() ] ) )

    const r = await engine.react( 0 as any, 2 as any, makeState( 2 ), {} as any )
    const m = new Map( r.commands!.metrics as Array<[ string, number ]> )
    expect( m.get('planning.supervision.replan') ).toBe( 1 )
    expect( m.get('planning.supervision.abandon') ).toBe( 0 )
  } )
} )

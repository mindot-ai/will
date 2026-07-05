// ─────────────────────────────────────────────────────────────
// tests/unit/planning.vocabulary.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Extended supervisory decision vocabulary: retry / pause / escalate (alongside
 * continue / skip / replan / abandon / complete). Drives a deliberate plan, captures
 * the facet's decision listener, and exercises each new directive's engine op.
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import { createTestBus }  from '#cognition/bus'

const makeState = ( t: number ) => ( { tick: t, metrics: new Map(), entities: new Map() } as any )
const step = () => ( { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } )
const outcome = ( planId: string, stepId: string, success: boolean, q: number ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'g', success, outcomeQuality: q, description: 'd', planId, stepId },
} as any )
const decision = ( directive: string ) =>
  ( { facetId: 'f', respondingToType: 'step_failed', decision: { directive }, reasoning: 'because', confidence: 0.8 } )

function setupDeliberate( config: Record<string, unknown> = {} ) {
  const bus = createTestBus()
  let decide: ( ( d: any ) => void ) | undefined
  let destroyed = 0
  const fakeFacet = {
    facetId: 'f', setFocus: () => {}, setStateRef: () => {},
    subscribe: ( l: ( d: any ) => void ) => { decide = l; return () => {} },
    report: () => {}, onChunk: () => {}, onReaped: () => {}, destroy: () => { destroyed++ },
  }
  const engine = new PlanningEngine( { bus, ...config } )
  engine.attachGoalManager( { getGoal: () => ( { id: 'goal-1', priority: 0.9 } ), getActiveGoals: () => [] } as any )  // high priority → deliberate
  engine.attachExecutiveEngine( {
    isFresh: () => true,
    spawnFacet: () => ( { attention: 'available', handle: fakeFacet } ),
    latestOutput: { plans: [ { action: 'execute', goalId: 'goal-1', expectedOutcome: 'x', estimatedCost: 3, feasibility: 0.8, steps: [ step() ] } ] },
  } as any )
  return { engine, bus, decide: () => decide!, destroyed: () => destroyed }
}

describe( 'PlanningEngine — extended decision vocabulary', () => {
  it( 'retry re-attempts the failed step (and counts retries)', async () => {
    const { engine, decide } = setupDeliberate()
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    expect( engine.getPlan( 'goal-1' )!.executionTier ).toBe( 'deliberate' )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', false, 0.1 ) )
    expect( engine.getPlan( 'goal-1' )!.steps[ 0 ]?.status ).toBe( 'failed' )

    decide()( decision( 'retry' ) )
    const s = engine.getPlan( 'goal-1' )!.steps[ 0 ]
    expect( s?.status ).toBe( 'active' )   // reset to pending → re-activated on the frontier
    expect( s?.retries ).toBe( 1 )
  } )

  it( 'retry is capped (maxStepRetries) — exhausted retries leave the step failed', async () => {
    const { engine, decide } = setupDeliberate( { maxStepRetries: 0 } )
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', false, 0.1 ) )
    decide()( decision( 'retry' ) )   // cap 0 → exhausted immediately
    expect( engine.getPlan( 'goal-1' )!.steps[ 0 ]?.status ).toBe( 'failed' )
  } )

  it( 'pause holds the plan (status paused) and frees the facet', async () => {
    const { engine, decide, destroyed } = setupDeliberate()
    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )

    decide()( decision( 'pause' ) )
    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'paused' )
    expect( destroyed() ).toBe( 1 )   // facet torn down
  } )

  it( 'escalate holds the plan and raises a plan.escalated signal for the master', async () => {
    const { engine, bus, decide } = setupDeliberate()
    const escalations: Array<{ payload: any }> = []
    bus.subscribe( 'collector', [ 'plan.escalated' ], e => { escalations.push( { payload: e.payload } ) } )

    await engine.react( 0 as any, 1 as any, makeState( 1 ), {} as any )
    decide()( decision( 'escalate' ) )

    expect( engine.getPlan( 'goal-1' )!.status ).toBe( 'paused' )
    expect( escalations ).toHaveLength( 1 )
    expect( escalations[ 0 ]?.payload.planId ).toBe( 'plan-1' )
  } )
} )

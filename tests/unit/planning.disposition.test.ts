// ─────────────────────────────────────────────────────────────
// tests/unit/planning.disposition.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Channel A: the planning engine reads its supervision dispositions (maxStepRetries,
 * surpriseOutcomeQuality) live from the persona-prior mirror each react — base
 * `engine-config-planning` (PMA-seeded) ⊕ metacog deltas. So conscientiousness
 * developed by the PersonaConsolidator actually changes how doggedly a Will retries a
 * stuck step, below deliberation. Proven behaviourally via the retry cap.
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine } from '#faculties/planning.engine'
import { createTestBus }  from '#cognition/bus'

const step = () => ( { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } )
const outcome = ( planId: string, stepId: string, success: boolean, q: number ) => ( {
  type: 'action.outcome', salience: 0.6,
  payload: { actionType: 'observe', domain: 'g', success, outcomeQuality: q, description: 'd', planId, stepId },
} as any )
const retry = () =>
  ( { facetId: 'f', respondingToType: 'step_failed', decision: { directive: 'retry' }, reasoning: 'r', confidence: 0.8 } )

// State carrying the planning config mirror: base params ⊕ optional persona-prior delta.
const stateWith = ( t: number, base?: Record<string, number>, prior?: Record<string, number> ) => {
  const entities = new Map<string, any>()
  if( base )
    entities.set( 'engine-config-planning', { id: 'engine-config-planning', type: 'engine-config', metadata: { params: base } } )
  if( prior )
    entities.set( 'persona-prior', {
      id: 'persona-prior', type: 'persona.prior',
      metadata: { priors: { 'engine-config-planning': prior }, version: 1, updatedAtTick: t },
    } )
  return { tick: t, metrics: new Map<string, number>(), entities } as any
}

// Deliberate plan with a captured facet decision listener (constructor sets NO cap,
// so the only source of maxStepRetries is the state mirror read each react).
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
  return { engine, decide: () => decide! }
}

describe( 'PlanningEngine — Channel A dispositions read from the persona-prior mirror', () => {
  it( 'a base maxStepRetries of 0 (from state) exhausts retries immediately', async () => {
    const { engine, decide } = setup()
    await engine.react( 0 as any, 1 as any, stateWith( 1, { maxStepRetries: 0 } ), {} as any )
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', false, 0.1 ) )
    decide()( retry() )
    expect( engine.getPlan( 'goal-1' )!.steps[ 0 ]?.status ).toBe( 'failed' )   // cap 0 → no re-dispatch
  } )

  it( 'a metacog-developed persona-prior delta lifts the cap so a stuck step is re-attempted', async () => {
    const { engine, decide } = setup()
    // base 0 ⊕ persona-prior +5 → effective 5 → conscientious follow-through retries.
    await engine.react( 0 as any, 1 as any, stateWith( 1, { maxStepRetries: 0 }, { maxStepRetries: 5 } ), {} as any )
    engine.onCognitiveEvent( outcome( 'plan-1', 'step-0', false, 0.1 ) )
    decide()( retry() )
    const s = engine.getPlan( 'goal-1' )!.steps[ 0 ]
    expect( s?.status ).toBe( 'active' )   // reset to pending → re-activated on the frontier
    expect( s?.retries ).toBe( 1 )
  } )
} )

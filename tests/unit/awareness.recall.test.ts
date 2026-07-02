// ─────────────────────────────────────────────────────────────
// tests/unit/awareness.recall.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * AWARENESS Stage 2 — recall-scoped plan awareness plumbing.
 *
 *   plan create/revise → PlanningEngine emits a stable `working_memory.item`
 *   descriptor (carries planId) → EpisodicConsolidator indexes it → recall →
 *   buildExecutiveContext collects the planId into context.relevantPlanIds →
 *   the Active Plans awareness filter renders that plan's LIVE state.
 *
 * These cover the two deterministic seams (descriptor emission + recall→planId
 * collection); the projector relevance filter itself is covered in
 * awareness.scope.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { PlanningEngine }        from '#faculties/planning.engine'
import { createTestBus }         from '#cognition/bus'
import { buildExecutiveContext } from '#faculties/executive.engine/context'

describe( 'PlanningEngine — emits a recall descriptor for new plans (Stage 2)', () => {
  it( 'writes a stable working_memory.item carrying the planId + summary', async () => {
    const bus = createTestBus()
    const engine = new PlanningEngine( { bus } )
    engine.attachGoalManager( { getGoal: () => undefined, getActiveGoals: () => [] } as any )
    engine.attachExecutiveEngine( {
      isFresh: () => true,
      latestOutput: { plans: [ {
        action: 'execute', goalId: 'goal-1', executionTier: 'automatic',
        expectedOutcome: 'reach the summit', estimatedCost: 3, feasibility: 0.8,
        steps: [ { action: 'observe', description: 'd', expectedOutcome: 'o', prerequisites: [], estimatedDuration: 3 } ],
      } ] },
    } as any )

    const r = await engine.react( 0 as any, 1 as any, { tick: 1, metrics: new Map(), entities: new Map() } as any, {} as any )

    const desc = ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'wm-plan-plan-1' ) as any
    expect( desc ).toBeDefined()
    expect( desc.type ).toBe( 'working_memory.item' )
    expect( desc.metadata.wmType ).toBe( 'plan' )
    expect( desc.metadata.content.planId ).toBe( 'plan-1' )
    expect( desc.metadata.content.summary ).toContain( 'reach the summit' )
    expect( desc.metadata.tags ).toContain( 'plan' )
  } )
} )

describe( 'buildExecutiveContext — collects relevant planIds from recall (Stage 2)', () => {
  it( 'pulls the planId from a recalled plan-descriptor episode into relevantPlanIds', async () => {
    const episode = {
      id: 'ep-1', sourceType: 'plan', activationStrength: 0.7, emotionalTags: {}, createdAt: 1,
      content: { wmType: 'plan', content: { summary: 'Plan plan-7 for goal g', planId: 'plan-7', goalId: 'g' } },
    }
    const ctx = await buildExecutiveContext(
      { tick: 5, metrics: new Map(), entities: new Map() } as any,
      {
        workingMemory: null, goalManager: null, semanticIntegrator: null,
        episodicConsolidator: { semanticQuery: async () => [ episode ], query: () => [], markRetrieved: () => {} } as any,
      },
    )
    expect( ctx.relevantPlanIds ).toContain( 'plan-7' )
  } )
} )

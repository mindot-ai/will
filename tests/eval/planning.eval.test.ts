// ─────────────────────────────────────────────────────────────
// tests/eval/planning.eval.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Planning-quality eval harness — deterministic scenario scoring + the PMA
 * correlation. Each scenario drives the real PlanningEngine + GoalManager (no LLM)
 * and returns a PlanningScorecard. Two of the scenarios sweep the PMA-seeded persona
 * to show that personality measurably shapes planning outcomes — and to guard the
 * Channel-A wiring shipped in #134 (grit) and #136 (conscientiousness).
 */

import { describe, it, expect } from 'vitest'
import { PlanningEvalHarness, type PlanningScenario } from './planning.eval'

const harness = new PlanningEvalHarness()
const step = ( action = 'observe' ) => ( { action, description: 'd', expectedOutcome: 'o' } )

describe( 'PlanningEvalHarness — deterministic planning-quality scoring', () => {

  it( 'scores a clean automatic run as fully completed with no course-correction', async () => {
    const scenario: PlanningScenario = {
      name: 'clean-automatic',
      goals: [ { description: 'tidy up', priority: 0.3 } ],   // < 0.7 + feasible → automatic
      plans: [ { goalIndex: 0, steps: [ step(), step() ], feasibility: 0.8 } ],
      tickBudget: 10,
    }
    const card = await harness.run( scenario )
    expect( card.completionRate ).toBe( 1 )
    expect( card.plansCompleted ).toBe( 1 )
    expect( card.supervision.retry ).toBe( 0 )      // automatic: never needed a facet
    expect( card.supervision.escalate ).toBe( 0 )
  } )

  // ── PMA correlation: conscientiousness (#136) ────────────────
  // Same scenario, a step that fails once then succeeds. The PMA-seeded persona's
  // maxStepRetries decides whether the Will follows through. Higher conscientiousness
  // ⇒ it retries and completes; a non-persistent persona gives up.
  describe( 'persona sweep — conscientiousness shapes follow-through', () => {
    const recoverable: Omit<PlanningScenario, 'persona' | 'name'> = {
      goals: [ { description: 'finish the hard thing', priority: 0.9 } ],   // ≥ 0.7 → deliberate
      plans: [ { goalIndex: 0, steps: [ step() ] } ],
      outcome: ( _id, attempt ) => ( { success: attempt >= 2, quality: attempt >= 2 ? 0.8 : 0.1 } ),
      tickBudget: 12,
    }

    it( 'a conscientious persona retries the stuck step and completes', async () => {
      const card = await harness.run( { name: 'consc-high', persona: { planning: { maxStepRetries: 5 } }, ...recoverable } )
      expect( card.completionRate ).toBe( 1 )
      expect( card.plansCompleted ).toBe( 1 )
      expect( card.supervision.retry ).toBeGreaterThanOrEqual( 1 )
    } )

    it( 'a non-persistent persona (cap 0) gives up — the same plan goes incomplete', async () => {
      const card = await harness.run( { name: 'consc-low', persona: { planning: { maxStepRetries: 0 } }, ...recoverable } )
      expect( card.completionRate ).toBe( 0 )
      expect( card.plansStuck ).toBe( 1 )
    } )
  } )

  // ── PMA correlation: grit (#134) ─────────────────────────────
  // A stuck, unimportant goal over a long horizon. The PMA-seeded gritPriority decides
  // whether the Will abandons it on a timer or holds on.
  describe( 'persona sweep — grit shapes goal persistence', () => {
    const stuck: Omit<PlanningScenario, 'persona' | 'name'> = {
      goals: [ { description: 'a low-priority whim', priority: 0.2 } ],
      plans: [],                 // never acted on → zero progress → staleness pressure
      tickBudget: 300,           // past the ~280-tick patience window for priority 0.2
    }

    it( 'a low-grit persona abandons the stale goal', async () => {
      const card = await harness.run( { name: 'grit-low', persona: { goalManager: { gritPriority: 0.8 } }, ...stuck } )
      expect( card.goalsAbandoned ).toBe( 1 )
      expect( card.goalsRetained ).toBe( 0 )
    } )

    it( 'a gritty persona holds on to the same goal', async () => {
      const card = await harness.run( { name: 'grit-high', persona: { goalManager: { gritPriority: 0.15 } }, ...stuck } )
      expect( card.goalsAbandoned ).toBe( 0 )
      expect( card.goalsRetained ).toBe( 1 )
    } )
  } )

  it( 'is deterministic — identical scenario ⇒ byte-identical scorecard (R2)', async () => {
    const scenario: PlanningScenario = {
      name: 'determinism',
      persona: { planning: { maxStepRetries: 5 } },
      goals: [ { description: 'x', priority: 0.9 } ],
      plans: [ { goalIndex: 0, steps: [ step() ] } ],
      outcome: ( _id, attempt ) => ( { success: attempt >= 2, quality: 0.8 } ),
      tickBudget: 12,
    }
    const a = await harness.run( scenario )
    const b = await harness.run( scenario )
    expect( a ).toEqual( b )
  } )
} )

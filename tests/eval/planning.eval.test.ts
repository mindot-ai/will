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
const step = ( action = 'observe') => ( { action, description: 'd', expectedOutcome: 'o' } )

describe('PlanningEvalHarness — deterministic planning-quality scoring', () => {

  it('scores a clean automatic run as fully completed with no course-correction', async () => {
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
  describe('persona sweep — conscientiousness shapes follow-through', () => {
    const recoverable: Omit<PlanningScenario, 'persona' | 'name'> = {
      goals: [ { description: 'finish the hard thing', priority: 0.9 } ],   // ≥ 0.7 → deliberate
      plans: [ { goalIndex: 0, steps: [ step() ] } ],
      outcome: ( _id, attempt ) => ( { success: attempt >= 2, quality: attempt >= 2 ? 0.8 : 0.1 } ),
      tickBudget: 12,
    }

    it('a conscientious persona retries the stuck step and completes', async () => {
      const card = await harness.run( { name: 'consc-high', persona: { planning: { maxStepRetries: 5 } }, ...recoverable } )
      expect( card.completionRate ).toBe( 1 )
      expect( card.plansCompleted ).toBe( 1 )
      expect( card.supervision.retry ).toBeGreaterThanOrEqual( 1 )
    } )

    it('a non-persistent persona (cap 0) gives up — the same plan goes incomplete', async () => {
      const card = await harness.run( { name: 'consc-low', persona: { planning: { maxStepRetries: 0 } }, ...recoverable } )
      expect( card.completionRate ).toBe( 0 )
      expect( card.plansStuck ).toBe( 1 )
    } )
  } )

  // ── PMA correlation: grit (#134) ─────────────────────────────
  // A stuck, unimportant goal over a long horizon. The PMA-seeded gritPriority decides
  // whether the Will abandons it on a timer or holds on.
  describe('persona sweep — grit shapes goal persistence', () => {
    const stuck: Omit<PlanningScenario, 'persona' | 'name'> = {
      goals: [ { description: 'a low-priority whim', priority: 0.2 } ],
      plans: [],                 // never acted on → zero progress → staleness pressure
      tickBudget: 300,           // past the ~280-tick patience window for priority 0.2
    }

    it('a low-grit persona abandons the stale goal', async () => {
      const card = await harness.run( { name: 'grit-low', persona: { goalManager: { gritPriority: 0.8 } }, ...stuck } )
      expect( card.goalsAbandoned ).toBe( 1 )
      expect( card.goalsRetained ).toBe( 0 )
    } )

    it('a gritty persona holds on to the same goal', async () => {
      const card = await harness.run( { name: 'grit-high', persona: { goalManager: { gritPriority: 0.15 } }, ...stuck } )
      expect( card.goalsAbandoned ).toBe( 0 )
      expect( card.goalsRetained ).toBe( 1 )
    } )
  } )

  // ── Author comparison — the emergent-planning promotion gate ──
  // (docs/strategy/__EMERGENT_PLANNING.md): a strategy is promoted only where
  // it Pareto-dominates executive planning on the same scenario shell.
  describe('author comparison — strategy vs executive promotion gate', () => {
    const shell = {
      name:  'compare',
      goals: [ { description: 'recurring chore', priority: 0.3 } ],
      tickBudget: 20,
    }
    const twoSteps = [ { goalIndex: 0, steps: [ step(), step() ], feasibility: 0.8 } ]

    it('an equally-good but cheaper author dominates (the strategy win case)', async () => {
      const cmp = await harness.compareAuthors(
        shell,
        { name: 'executive', plans: twoSteps, authoringCost: 1 },
        { name: 'strategy',  plans: twoSteps, authoringCost: 0 },
      )
      expect( cmp.verdict ).toBe('b_dominates')
      expect( cmp.a.completionRate ).toBe( cmp.b.completionRate )   // same outcome…
      expect( cmp.b.authoringCost ).toBeLessThan( cmp.a.authoringCost )  // …for free
    } )

    it('a cheaper author that fails the goal is a trade-off — mixed, never promoted', async () => {
      const cmp = await harness.compareAuthors(
        { ...shell, outcome: ( stepId: string ) => ( { success: !stepId.includes('step-2'), quality: 0.5 } ) },
        { name: 'executive', plans: twoSteps, authoringCost: 1 },
        // The strategy's decomposition has a third step the outcome script always fails.
        { name: 'strategy',  plans: [ { goalIndex: 0, steps: [ step(), step(), step('verify') ], feasibility: 0.8 } ], authoringCost: 0 },
      )
      expect( cmp.b.completionRate ).toBeLessThan( cmp.a.completionRate )
      expect( cmp.verdict ).toBe('mixed')
    } )

    it('identical authors tie', async () => {
      const cmp = await harness.compareAuthors(
        shell,
        { name: 'x', plans: twoSteps },
        { name: 'y', plans: twoSteps },
      )
      expect( cmp.verdict ).toBe('tie')
    } )
  } )

  it('reports decomposition-shape recurrence — the demonstrated-need needle', async () => {
    const card = await harness.run( {
      name:  'shapes',
      goals: [ { description: 'a', priority: 0.3 }, { description: 'b', priority: 0.3 } ],
      plans: [
        { goalIndex: 0, steps: [ step(), step() ], feasibility: 0.8 },
        { goalIndex: 1, steps: [ step(), step() ], feasibility: 0.8 },   // same shape re-derived
      ],
      tickBudget: 20,
    } )
    expect( card.planShapes.distinct ).toBe( 1 )
    expect( card.planShapes.repeats ).toBe( 1 )
  } )

  it('is deterministic — identical scenario ⇒ byte-identical scorecard (R2)', async () => {
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

// ─────────────────────────────────────────────────────────────
// tests/unit/goal.resilience.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Resilience / grit — importance-weighted goal persistence. A high-priority goal is
 * never auto-abandoned by staleness (the mind only lets it go deliberately); below
 * that threshold, the patience window scales with priority. Perseveration is still
 * capped elsewhere (maxStepRetries) — this is goal-level persistence, not blind
 * repetition.
 */

import { describe, it, expect } from 'vitest'
import { GoalManager } from '#faculties/goal.manager'

const makeState = ( tick: number, frustration = 0 ) => ( {
  tick, entities: new Map(),
  metrics: new Map<string, number>( [ [ 'emotion.frustration', frustration ] ] ),
} as any )

describe( 'GoalManager — resilience / grit', () => {
  it( 'never auto-abandons a high-priority stuck goal (deliberate-only)', async () => {
    const gm = new GoalManager()
    const id = gm.addGoal( 'save the mission', 0.95, [] )   // ≥ gritPriority (0.8)
    await gm.react( 0 as any, 1000 as any, makeState( 1000 ), {} as any )   // far past any window
    expect( gm.getActiveGoals().some( g => g.id === id ) ).toBe( true )     // still active — grit
  } )

  it( 'auto-abandons a low-priority stuck zero-progress goal past its window', async () => {
    const gm = new GoalManager()
    const id = gm.addGoal( 'idle whim', 0.2, [] )
    await gm.react( 0 as any, 1000 as any, makeState( 1000 ), {} as any )
    expect( gm.getActiveGoals().some( g => g.id === id ) ).toBe( false )    // given up
  } )

  it( 'importance extends the patience window (mid-priority outlasts low-priority)', async () => {
    const gm = new GoalManager()
    const lowId = gm.addGoal( 'low', 0.2, [] )   // window ≈ 200·(1+0.2·2) = 280
    const midId = gm.addGoal( 'mid', 0.6, [] )   // window ≈ 200·(1+0.6·2) = 440
    await gm.react( 0 as any, 360 as any, makeState( 360 ), {} as any )     // 280 < 360 < 440
    const active = gm.getActiveGoals().map( g => g.id )
    expect( active ).not.toContain( lowId )   // past its window → abandoned
    expect( active ).toContain( midId )       // still within its (longer) window → persists
  } )
} )

// ── Grit as a personality disposition (engine-config ⊕ persona-prior) ──

const stateWithConfig = (
  tick: number, params: Record<string, number>, prior?: Record<string, number>, frustration = 0,
) => {
  const entities = new Map<string, any>()
  entities.set( 'engine-config-goal-manager', { id: 'engine-config-goal-manager', type: 'engine-config', metadata: { params } } )
  if( prior )
    entities.set( 'persona-prior', {
      id: 'persona-prior', type: 'persona.prior',
      metadata: { priors: { 'engine-config-goal-manager': prior }, version: 1, updatedAtTick: tick },
    } )
  return { tick, entities, metrics: new Map<string, number>( [ [ 'emotion.frustration', frustration ] ] ) } as any
}

describe( 'GoalManager — grit is a personality disposition, not a constant', () => {
  it( 'grit threshold comes from engine-config (PMA-seeded per Will)', async () => {
    const gm = new GoalManager()
    const id = gm.addGoal( 'mid', 0.6, [] )   // default 0.8 → not exempt; config 0.5 → exempt
    await gm.react( 0 as any, 1000 as any, stateWithConfig( 1000, { gritPriority: 0.5 } ), {} as any )
    expect( gm.getActiveGoals().some( g => g.id === id ) ).toBe( true )
  } )

  it( 'persona-prior delta develops grit over time (metacognitive self-tuning)', async () => {
    const gm = new GoalManager()
    const id = gm.addGoal( 'mid', 0.6, [] )
    // base 0.7 (0.6 not exempt) ⊕ persona-prior −0.2 → effective 0.5 → 0.6 now exempt
    await gm.react( 0 as any, 1000 as any, stateWithConfig( 1000, { gritPriority: 0.7 }, { gritPriority: -0.2 } ), {} as any )
    expect( gm.getActiveGoals().some( g => g.id === id ) ).toBe( true )
  } )

  it( 'frustrationTolerance dampens frustration-driven giving-up', async () => {
    const fickle = new GoalManager()
    const fid = fickle.addGoal( 'task', 0.5, [] )
    await fickle.react( 0 as any, 250 as any, stateWithConfig( 250, { frustrationTolerance: 0.0 }, undefined, 0.7 ), {} as any )
    expect( fickle.getActiveGoals().some( g => g.id === fid ) ).toBe( false )   // frustrated + intolerant → gave up

    const tough = new GoalManager()
    const tid = tough.addGoal( 'task', 0.5, [] )
    await tough.react( 0 as any, 250 as any, stateWithConfig( 250, { frustrationTolerance: 0.8 }, undefined, 0.7 ), {} as any )
    expect( tough.getActiveGoals().some( g => g.id === tid ) ).toBe( true )     // tolerance preserved patience
  } )
} )

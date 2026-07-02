// ─────────────────────────────────────────────────────────────
// tests/unit/goal.task-persistence.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Channel-A task persistence (end-to-end). The goal task.switcher is focused on gets a
 * bounded commitment boost to its priority — built from focus duration, amplified by sunk
 * cost in an in-progress plan (planning.engine), and scaled by the switch cost (= the
 * conscientiousness-developable baseSwitchCost, #28). This is what makes the focus
 * mechanically "stick" for goal selection, the executive, and planning.
 */

import { describe, it, expect } from 'vitest'
import { GoalManager } from '#faculties/goal.manager'

const goalEntity = ( id: string, basePriority: number ) => ( {
  id, type: 'goal',
  metadata: { description: id, status: 'active', basePriority, priority: basePriority, tags: [] },
} )

const planEntity = ( goalId: string, done: number, total: number ) => ( {
  id: `plan-${goalId}`, type: 'plan',
  metadata: { goalId, steps: Array.from( { length: total }, ( _, i ) => ( { status: i < done ? 'completed' : 'pending' } ) ) },
} )

async function focusedPriority( opts: { focus?: boolean; focusTicks?: number; plan?: [number, number]; switchCost?: number } ): Promise<number> {
  const gm = new GoalManager()
  const entities = new Map<string, any>()
  entities.set( 'g1', goalEntity( 'g1', 0.5 ) )
  if( opts.focus )
    entities.set( 'task-switch-focus', { id: 'task-switch-focus', type: 'task.focus', metadata: { goalId: 'g1', focusTicks: opts.focusTicks ?? 30 } } )
  if( opts.plan )
    entities.set( 'plan-g1', planEntity( 'g1', opts.plan[0], opts.plan[1] ) )
  const metrics = new Map<string, number>( [ [ 'task_switch.switch_cost', opts.switchCost ?? 0.4 ] ] )
  await gm.react( 1000 as any, 100 as any, { tick: 100, entities, metrics } as any, {} as any )
  return gm.getGoal( 'g1' )?.priority ?? NaN
}

describe( 'GoalManager — task-persistence commitment boost', () => {
  it( 'boosts the focused goal above an unfocused baseline', async () => {
    expect( await focusedPriority( { focus: true } ) ).toBeGreaterThan( await focusedPriority( {} ) )
  } )

  it( 'plan sunk cost amplifies the commitment (half-done plan > no plan)', async () => {
    expect( await focusedPriority( { focus: true, plan: [ 2, 4 ] } ) )
      .toBeGreaterThan( await focusedPriority( { focus: true } ) )
  } )

  it( 'a higher (conscientious) switch cost commits harder', async () => {
    expect( await focusedPriority( { focus: true, switchCost: 0.45 } ) )
      .toBeGreaterThan( await focusedPriority( { focus: true, switchCost: 0.2 } ) )
  } )

  it( 'the boost is bounded — a clearly higher-priority goal still wins', async () => {
    const focused = await focusedPriority( { focus: true, plan: [ 4, 4 ], switchCost: 0.45 } )
    expect( focused ).toBeLessThan( 0.5 + 0.2 + 0.01 ) // base + cap + slack
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/goal.capacity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Capacity is a queue, not a cliff.
 *
 * `_resolveConflicts` demoted the lowest-priority goal to `'pending'` when the
 * active set went over `maxActiveGoals` — and nothing ever promoted one back.
 * `pending` is excluded from `getActiveGoals()`, from progress updates, and from
 * the patience/grit sweep (which skips any status but `'active'`), yet it is
 * re-persisted every tick and rehydrated on every restore. So a demoted goal
 * became inert AND immortal, and the active set could only ever drain.
 *
 * Measured on a live COO before this was fixed: 96 goal entities — 83 pending,
 * 0 active, 92 of them the same drive-spawned goal. `activeGoalCount` sat at 0,
 * so `goalless_crisis` fired every 20 ticks forever while she was carrying 83
 * goals, and the `goal` term (joint-largest weight in the affordance
 * competition) contributed nothing to any choice she made. What looked like
 * obsessive repetition was a mind with no organising force left in the field.
 */

import { describe, it, expect } from 'vitest'
import { GoalManager } from '#faculties/goal.manager'

const makeState = ( tick: number ) => ( {
  tick, entities: new Map(),
  metrics: new Map<string, number>(),
} as any )

/** Run one manager cycle — this is what invokes _resolveConflicts. */
const tickOnce = ( gm: GoalManager, tick: number ) =>
  gm.react( 0 as any, tick as any, makeState( tick ), {} as any )

describe('GoalManager — capacity reconciles in both directions', () => {
  it('demotes the lowest-priority goal when over capacity', async () => {
    const gm = new GoalManager()
    // Six goals against the default cap of five. All well above the grit
    // threshold so the patience sweep cannot confound the result.
    const ids = [ 0.99, 0.98, 0.97, 0.96, 0.95, 0.94 ].map( ( p, i ) => gm.addGoal(`goal ${ i }`, p, [] ) )
    await tickOnce( gm, 1 )

    const active = gm.getActiveGoals()
    expect( active ).toHaveLength( 5 )
    expect( active.some( g => g.id === ids[5] ) ).toBe( false )   // the lowest waits
  } )

  it('promotes a waiting goal when capacity frees — pending is not a one-way door', async () => {
    const gm = new GoalManager()
    const ids = [ 0.99, 0.98, 0.97, 0.96, 0.95, 0.94 ].map( ( p, i ) => gm.addGoal(`goal ${ i }`, p, [] ) )
    await tickOnce( gm, 1 )
    expect( gm.getActiveGoals().some( g => g.id === ids[5] ) ).toBe( false )

    // A slot opens.
    gm.completeGoal( ids[0]! )
    await tickOnce( gm, 2 )

    const active = gm.getActiveGoals()
    expect( active ).toHaveLength( 5 )
    expect( active.some( g => g.id === ids[5] ) ).toBe( true )    // taken back up
  } )

  it('takes the HIGHEST-priority waiting goal first', async () => {
    const gm = new GoalManager()
    const ids = [ 0.99, 0.98, 0.97, 0.96, 0.95 ].map( ( p, i ) => gm.addGoal(`goal ${ i }`, p, [] ) )
    const low  = gm.addGoal('low waiter',  0.90, [] )
    const high = gm.addGoal('high waiter', 0.93, [] )
    await tickOnce( gm, 1 )

    gm.completeGoal( ids[0]! )
    await tickOnce( gm, 2 )

    const active = gm.getActiveGoals()
    expect( active.some( g => g.id === high ) ).toBe( true )
    expect( active.some( g => g.id === low  ) ).toBe( false )
  } )

  it('never exceeds capacity while promoting', async () => {
    const gm = new GoalManager()
    for( let i = 0; i < 12; i++ ) gm.addGoal(`goal ${ i }`, 0.99 - i * 0.001, [] )
    for( let t = 1; t <= 4; t++ ){
      await tickOnce( gm, t )
      expect( gm.getActiveGoals().length ).toBeLessThanOrEqual( 5 )
    }
  } )

  /**
   * The quieter half of the fix. A goal can only be retired while it is active,
   * so a demoted-and-forgotten one could never be given up on — which is how 83
   * of them accumulated. Promotion restores reachability, and the existing
   * patience sweep then does its job without any new GC.
   */
  it('a promoted stale goal becomes reachable by the patience sweep again', async () => {
    const gm = new GoalManager()
    const ids = [ 0.99, 0.98, 0.97, 0.96, 0.95 ].map( ( p, i ) => gm.addGoal(`goal ${ i }`, p, [] ) )
    const stale = gm.addGoal('stale low-priority whim', 0.2, [] )   // below grit (0.8)
    await tickOnce( gm, 1 )
    expect( gm.getActiveGoals().some( g => g.id === stale ) ).toBe( false )   // waiting

    gm.completeGoal( ids[0]! )
    // Far past any patience window: promoted, then legitimately given up on.
    // `activatedAt` is deliberately not refreshed on promotion, so its real age
    // still counts — a goal that could reset its own patience by cycling
    // demote→promote would be exactly the immortality this fix removes.
    await tickOnce( gm, 5000 )

    // Assert the STATUS, not merely absence from the active set. `pending` is
    // also absent from `getActiveGoals()`, so an absence check passes whether the
    // goal was retired or is simply still stuck waiting — it cannot tell the fix
    // from the bug. Only 'abandoned' distinguishes the two.
    expect( gm.getGoal( stale )?.status ).toBe('abandoned')
  } )
} )

/**
 * The accretion half. A drive re-spawns its goal whenever its threshold is
 * crossed and no matching goal already exists — and "exists" was written as
 * `status === 'active'`, so a copy demoted to `pending` stopped blocking its own
 * replacement. Every crossing minted another. Measured live: 92 identical copies
 * of one drive goal, all of them re-persisted every tick and rehydrated on every
 * restore, none of them reachable by any sweep that could have retired them.
 */
describe('GoalManager — a waiting goal still counts as existing', () => {
  /** Boredom high enough that the drive fires and its completion condition
   *  (`emotion.boredom < 0.4`) is NOT already met. */
  const engagedState = ( tick: number ) => ( {
    tick, entities: new Map(),
    metrics: new Map<string, number>( [
      [ 'drive.seek_engagement', 0.9 ],
      [ 'emotion.boredom',       0.9 ],
    ] ),
  } as any )

  const countEngagement = ( gm: GoalManager ) =>
    [ ...( gm as any )._goals.values() ]
      .filter( ( g: any ) => g.tags?.includes('boredom') ).length

  it('does not mint a duplicate while an identical goal is only waiting', async () => {
    const gm = new GoalManager()
    // Fill capacity with goals that outrank the drive's (0.55), so the
    // drive-spawned one is the first to be demoted.
    for( let i = 0; i < 5; i++ ) gm.addGoal(`important ${ i }`, 0.99, [] )

    await gm.react( 0 as any, 1 as any, engagedState( 1 ), {} as any )
    const afterFirst = countEngagement( gm )
    expect( afterFirst ).toBeGreaterThan( 0 )        // the drive did fire

    // Several more crossings while the copy sits pending.
    for( let t = 2; t <= 6; t++ )
      await gm.react( 0 as any, t as any, engagedState( t ), {} as any )

    expect( countEngagement( gm ) ).toBe( afterFirst )   // still exactly one
  } )
} )

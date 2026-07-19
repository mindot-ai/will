// ─────────────────────────────────────────────────────────────
// tests/unit/goal.no-instant-complete.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression — drive goals must not be *born done*. A session log showed the
 * `seek_engagement` drive spawning a goal whose completion condition (`emotion.boredom <
 * 40`) was ALREADY met at creation (a unit mismatch: the drive fires on a 0–1 boredom
 * signal, the condition checks the 0–100 metric). The goal completed on its creation tick
 * (age 0) and respawned the next — one spurious "achievement" per tick, 26 in a row.
 *
 * Two guards: (1) never create a drive goal whose completionCondition is already satisfied;
 * (2) a goal can never complete on the same tick it was created.
 */

import { describe, it, expect } from 'vitest'
import { GoalManager } from '#faculties/goal.manager'

const stateWith = ( tick: number, metrics: Record<string, number> ) =>
  ( { tick, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) } as any )

const engagementGoals = ( gm: GoalManager ) => gm.getActiveGoals().filter( g => g.tags.includes('boredom') )

describe('GoalManager — drive goals are not born done (session-log regression)', () => {
  it('does NOT spawn a drive goal whose completion condition is already met', async () => {
    const gm = new GoalManager()
    // drive firing, but emotion.boredom (0–1 scale) already < 0.4 → the goal would be born done.
    for( let t = 100; t < 105; t++ )
      await gm.react( 1000 as any, t as any, stateWith( t, { 'drive.seek_engagement': 0.8, 'emotion.boredom': 0.2 } ), {} as any )
    expect( engagementGoals( gm ) ).toHaveLength( 0 )   // never created, never the age-0 spam loop
  } )

  it('creates the goal when there IS work, completes it later (age > 0), and does not respawn', async () => {
    const gm = new GoalManager()

    // boredom 0.7 (sustained > 0.6 fired the drive) → `< 0.4` not met → genuine work → persists.
    await gm.react( 1000 as any, 100 as any, stateWith( 100, { 'drive.seek_engagement': 0.8, 'emotion.boredom': 0.7 } ), {} as any )
    const created = engagementGoals( gm )
    expect( created ).toHaveLength( 1 )
    const id = created[0]!.id
    expect( created[0]!.status ).toBe('active')       // NOT completed on its creation tick (age-0 guard)
    expect( created[0]!.progress ).toBeLessThan( 1 )

    // Boredom falls back under 0.4 (hysteresis) on a LATER tick → the goal completes (age > 0).
    await gm.react( 1000 as any, 101 as any, stateWith( 101, { 'drive.seek_engagement': 0.8, 'emotion.boredom': 0.2 } ), {} as any )
    expect( gm.getGoal( id )!.status ).toBe('completed')

    // And it must NOT respawn while the condition stays met — the loop is dead.
    await gm.react( 1000 as any, 102 as any, stateWith( 102, { 'drive.seek_engagement': 0.8, 'emotion.boredom': 0.2 } ), {} as any )
    expect( engagementGoals( gm ) ).toHaveLength( 0 )
  } )
} )

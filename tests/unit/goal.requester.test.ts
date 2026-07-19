// ─────────────────────────────────────────────────────────────
// tests/unit/goal.requester.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the requestingEntityId / requestingThreadId causal-link
 * fields introduced on GoalState and GoalManager.addGoal().
 *
 * Tests:
 *   - addGoal() with requestingEntityId → getGoal() returns it
 *   - addGoal() with requestingThreadId → getGoal() returns it
 *   - addGoal() without requester fields → both are undefined
 *   - getGoal() for unknown id returns undefined
 *   - Multiple goals in same manager each carry their own requester
 *   - The returned goalId can be used to retrieve the goal immediately
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { GoalManager } from '#faculties/goal.manager'

describe('GoalManager — requestingEntityId propagation', () => {
  let gm: GoalManager
  beforeEach( () => { gm = new GoalManager() } )

  it('getGoal() returns undefined for an unknown goalId', () => {
    expect( gm.getGoal('no-such-id') ).toBeUndefined()
  } )

  it('addGoal() returns a non-empty string goalId', () => {
    const id = gm.addGoal('Test goal', 0.5 )
    expect( typeof id ).toBe('string')
    expect( id.length ).toBeGreaterThan( 0 )
  } )

  it('getGoal() returns the goal immediately after addGoal()', () => {
    const id   = gm.addGoal('Learn something', 0.6 )
    const goal = gm.getGoal( id )
    expect( goal ).toBeDefined()
    expect( goal?.id ).toBe( id )
    expect( goal?.description ).toBe('Learn something')
  } )

  it('addGoal() with requestingEntityId — getGoal() returns it', () => {
    const id   = gm.addGoal(
      'Entity-triggered goal',
      0.7,
      [],         // tags
      undefined,  // parentGoalId
      undefined,  // deadline
      'epistemic',// completionType
      undefined,  // completionCondition
      undefined,  // id
      'entity-abc',
    )
    const goal = gm.getGoal( id )
    expect( goal?.requestingEntityId ).toBe('entity-abc')
  } )

  it('addGoal() with requestingThreadId — getGoal() returns it', () => {
    const id = gm.addGoal(
      'Thread-correlated goal',
      0.6,
      [],
      undefined,
      undefined,
      'epistemic',
      undefined,
      undefined,
      'entity-xyz',
      'thread-42',
    )
    const goal = gm.getGoal( id )
    expect( goal?.requestingEntityId ).toBe('entity-xyz')
    expect( goal?.requestingThreadId ).toBe('thread-42')
  } )

  it('addGoal() without requester fields — both fields are undefined', () => {
    const id   = gm.addGoal('Organic goal', 0.5 )
    const goal = gm.getGoal( id )
    expect( goal?.requestingEntityId ).toBeUndefined()
    expect( goal?.requestingThreadId ).toBeUndefined()
  } )

  it('multiple goals each carry their own requester independently', () => {
    const id1 = gm.addGoal('Goal A', 0.5, [], undefined, undefined, 'epistemic', undefined, undefined, 'entity-1', 'thread-1')
    const id2 = gm.addGoal('Goal B', 0.5, [], undefined, undefined, 'epistemic', undefined, undefined, 'entity-2', 'thread-2')
    const id3 = gm.addGoal('Goal C', 0.5 )

    expect( gm.getGoal( id1 )?.requestingEntityId ).toBe('entity-1')
    expect( gm.getGoal( id1 )?.requestingThreadId ).toBe('thread-1')
    expect( gm.getGoal( id2 )?.requestingEntityId ).toBe('entity-2')
    expect( gm.getGoal( id2 )?.requestingThreadId ).toBe('thread-2')
    expect( gm.getGoal( id3 )?.requestingEntityId ).toBeUndefined()
    expect( gm.getGoal( id3 )?.requestingThreadId ).toBeUndefined()
  } )

  it('goal has status "active" immediately after addGoal()', () => {
    const id = gm.addGoal('Active goal', 0.5 )
    expect( gm.getGoal( id )?.status ).toBe('active')
  } )

  it('goal description and priority are stored correctly', () => {
    const id   = gm.addGoal('High priority task', 0.9 )
    const goal = gm.getGoal( id )
    expect( goal?.description ).toBe('High priority task')
    expect( goal?.priority ).toBe( 0.9 )
    expect( goal?.basePriority ).toBe( 0.9 )
  } )

  it('goal tags are stored correctly', () => {
    const id   = gm.addGoal('Tagged goal', 0.5, ['planning', 'urgent'] )
    const goal = gm.getGoal( id )
    expect( goal?.tags ).toEqual( ['planning', 'urgent'] )
  } )

  it('getActiveGoals() includes the newly added goal', () => {
    const id     = gm.addGoal('Active goal', 0.5 )
    const active = gm.getActiveGoals()
    expect( active.some( g => g.id === id ) ).toBe( true )
  } )
} )

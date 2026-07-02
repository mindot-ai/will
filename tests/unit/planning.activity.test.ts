// ─────────────────────────────────────────────────────────────
// tests/unit/planning.activity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for PlanningEngine.addActivityListener().
 *
 * Behaviour under test:
 *   - No bus attached → returns a no-op unsubscribe and logs a warning
 *   - Bus attached → listener receives correct ActivityEvent for each plan topic
 *   - Listener is filtered by requestingEntityId (wrong entity → not called)
 *   - Unsubscribe stops delivery of subsequent events
 *   - Multiple independent listeners coexist without cross-talk
 *   - All six mapped bus topics produce the correct ActivityEvent.type
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlanningEngine, type ActivityEvent }   from '#faculties/planning.engine'
import { createTestBus }                         from '#cognition/bus'

// ── Helpers ──────────────────────────────────────────────────

/**
 * Publish a synthetic plan bus event directly so we can test the listener
 * without needing to run a full planning cycle.
 */
function publishPlanEvent(
  bus:    ReturnType<typeof createTestBus>,
  type:   string,
  extra:  Record<string, unknown> = {},
) {
  bus.publish( {
    type,
    version:      1,
    sourceEngine: 'planning-engine',
    salience:     0.6,
    payload:      { planId: 'plan-001', goalId: 'goal-001', ...extra },
  } )
}

// ── No-bus path ───────────────────────────────────────────────

describe( 'addActivityListener() — no bus attached', () => {
  it( 'returns a callable no-op unsubscribe function', () => {
    const engine = new PlanningEngine()  // no bus in config
    const warn   = vi.spyOn( console, 'warn' ).mockImplementation( () => {} )

    const unsub = engine.addActivityListener( 'entity-1', vi.fn() )
    expect( typeof unsub ).toBe( 'function' )
    expect( () => unsub() ).not.toThrow()

    warn.mockRestore()
  } )

  it( 'logs a warning when no bus is attached', () => {
    const engine = new PlanningEngine()
    const warn   = vi.spyOn( console, 'warn' ).mockImplementation( () => {} )

    engine.addActivityListener( 'entity-1', vi.fn() )
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining( 'no-op' ) )

    warn.mockRestore()
  } )

  it( 'handler is never called when no bus is attached', () => {
    const engine  = new PlanningEngine()
    vi.spyOn( console, 'warn' ).mockImplementation( () => {} )
    const handler = vi.fn()

    engine.addActivityListener( 'entity-1', handler )
    expect( handler ).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  } )
} )

// ── With bus — entity filtering ───────────────────────────────

describe( 'addActivityListener() — with bus attached', () => {
  let bus:    ReturnType<typeof createTestBus>
  let engine: PlanningEngine

  beforeEach( () => {
    bus    = createTestBus()
    engine = new PlanningEngine( { bus } )
  } )

  it( 'does NOT call listener for events from a different entity', () => {
    const handler = vi.fn()
    engine.addActivityListener( 'entity-MINE', handler )

    publishPlanEvent( bus, 'plan.completed', { requestingEntityId: 'entity-OTHER' } )

    expect( handler ).not.toHaveBeenCalled()
  } )

  it( 'calls listener for events matching the subscribed entity', () => {
    const events: ActivityEvent[] = []
    engine.addActivityListener( 'entity-1', e => events.push( e ) )

    publishPlanEvent( bus, 'plan.completed', { requestingEntityId: 'entity-1' } )

    expect( events ).toHaveLength( 1 )
    expect( events[0]?.type ).toBe( 'plan_complete' )
    expect( events[0]?.planId ).toBe( 'plan-001' )
  } )

  it( 'skips events with no requestingEntityId', () => {
    const handler = vi.fn()
    engine.addActivityListener( 'entity-1', handler )

    // No requestingEntityId in payload
    publishPlanEvent( bus, 'plan.started' )

    expect( handler ).not.toHaveBeenCalled()
  } )
} )

// ── Topic → ActivityEvent.type mapping ───────────────────────

describe( 'addActivityListener() — topic-to-type mapping', () => {
  let bus:    ReturnType<typeof createTestBus>
  let engine: PlanningEngine

  beforeEach( () => {
    bus    = createTestBus()
    engine = new PlanningEngine( { bus } )
  } )

  const CASES: [ busType: string, activityType: ActivityEvent['type'] ][] = [
    [ 'plan.started',         'plan_started'    ],
    [ 'plan.step.activated',  'step_activated'  ],
    [ 'plan.step.outcome',    'step_outcome'    ],
    [ 'plan.completed',       'plan_complete'   ],
    [ 'plan.failed',          'plan_failed'     ],
    [ 'plan.cancelled',       'plan_cancelled'  ],
  ]

  for( const [busType, expectedType] of CASES ) {
    it( `"${busType}" → ActivityEvent.type "${expectedType}"`, () => {
      const events: ActivityEvent[] = []
      engine.addActivityListener( 'entity-1', e => events.push( e ) )

      publishPlanEvent( bus, busType, { requestingEntityId: 'entity-1' } )

      expect( events ).toHaveLength( 1 )
      expect( events[0]?.type ).toBe( expectedType )
    } )
  }
} )

// ── Unsubscribe ───────────────────────────────────────────────

describe( 'addActivityListener() — unsubscribe', () => {
  it( 'stops delivery after unsub() is called', () => {
    const bus    = createTestBus()
    const engine = new PlanningEngine( { bus } )
    const events: ActivityEvent[] = []

    const unsub = engine.addActivityListener( 'entity-1', e => events.push( e ) )

    // Deliver one event — should arrive
    publishPlanEvent( bus, 'plan.started', { requestingEntityId: 'entity-1' } )
    expect( events ).toHaveLength( 1 )

    // Unsubscribe, then deliver another — should NOT arrive
    unsub()
    publishPlanEvent( bus, 'plan.completed', { requestingEntityId: 'entity-1' } )
    expect( events ).toHaveLength( 1 )
  } )

  it( 'calling unsub() more than once does not throw', () => {
    const bus    = createTestBus()
    const engine = new PlanningEngine( { bus } )
    const unsub  = engine.addActivityListener( 'entity-1', vi.fn() )

    expect( () => { unsub(); unsub() } ).not.toThrow()
  } )
} )

// ── Multiple listeners ────────────────────────────────────────

describe( 'addActivityListener() — multiple listeners', () => {
  it( 'two listeners for the same entity both receive events', () => {
    const bus    = createTestBus()
    const engine = new PlanningEngine( { bus } )
    const evA: ActivityEvent[] = []
    const evB: ActivityEvent[] = []

    engine.addActivityListener( 'entity-1', e => evA.push( e ) )
    engine.addActivityListener( 'entity-1', e => evB.push( e ) )

    publishPlanEvent( bus, 'plan.started', { requestingEntityId: 'entity-1' } )

    expect( evA ).toHaveLength( 1 )
    expect( evB ).toHaveLength( 1 )
  } )

  it( 'listeners for different entities do not cross-talk', () => {
    const bus    = createTestBus()
    const engine = new PlanningEngine( { bus } )
    const evA: ActivityEvent[] = []
    const evB: ActivityEvent[] = []

    engine.addActivityListener( 'entity-A', e => evA.push( e ) )
    engine.addActivityListener( 'entity-B', e => evB.push( e ) )

    publishPlanEvent( bus, 'plan.started', { requestingEntityId: 'entity-A' } )
    publishPlanEvent( bus, 'plan.completed', { requestingEntityId: 'entity-B' } )

    expect( evA ).toHaveLength( 1 )
    expect( evA[0]?.type ).toBe( 'plan_started' )

    expect( evB ).toHaveLength( 1 )
    expect( evB[0]?.type ).toBe( 'plan_complete' )
  } )

  it( 'additional payload fields are forwarded in the ActivityEvent', () => {
    const bus    = createTestBus()
    const engine = new PlanningEngine( { bus } )
    const events: ActivityEvent[] = []

    engine.addActivityListener( 'entity-1', e => events.push( e ) )

    publishPlanEvent( bus, 'plan.step.outcome', {
      requestingEntityId: 'entity-1',
      stepId:             'step-007',
      outcome:            'success',
      cost:               3,
    } )

    expect( events[0]?.['stepId'] ).toBe( 'step-007' )
    expect( events[0]?.['outcome'] ).toBe( 'success' )
    expect( events[0]?.['cost'] ).toBe( 3 )
  } )
} )

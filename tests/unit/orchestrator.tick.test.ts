// ─────────────────────────────────────────────────────────────
// tests/unit/orchestrator.tick.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Orchestrator tick-loop + double-buffer commit contract (REORIENT R7 / FIX F3).
 *
 * `DefaultOrchestrator._executeTick` is the heart of the simulation: it advances
 * the clock, hands every engine ONE frozen snapshot, collects their commands,
 * runs pre-commit validation, then applies all commands atomically and publishes
 * events. The ordering guarantees here are load-bearing — replay fidelity and the
 * "no engine sees another's mid-tick write" invariant both depend on them — yet
 * the loop had no direct, deterministic coverage.
 *
 * Driven via `step()` (which calls `_executeTick` directly) with a deterministic
 * `fixedDeltaMs` clock so no wall-clock time leaks in. The contracts pinned:
 *
 *   1. A tick advances the clock and syncs the state manager's clock.
 *   2. Engines run in registration order.
 *   3. Double-buffer: every engine reads the same pre-tick snapshot, so an
 *      engine never sees a same-tick write from an earlier engine — only on the
 *      NEXT tick.
 *   4. Commands (entities + metrics) are applied after all engines have run.
 *   5. onBeforeCommit returning errors aborts the commit — no commands applied,
 *      no events published. Returning true/void lets it through.
 *   6. onError isolates a throwing engine: a fallback result is collected, and a
 *      throw with no onError is logged without aborting the rest of the tick.
 *   7. onBeforeTick sees the pre-commit snapshot; onAfterTick sees the
 *      post-commit snapshot.
 *   8. Engine events are published with the tick stamped and flushed AFTER
 *      commands apply, so handlers observe post-commit state.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DefaultOrchestrator,
  type SimulationEngine,
  type EngineResult,
  type CommitValidator,
  type OrchestratorConfig,
} from '#core/orchestrator'
import { DefaultSimulationClock } from '#core/clock'
import { DefaultEventBus } from '#core/event.bus'
import { DefaultStateManager } from '#core/state.manager'

// ── Harness ───────────────────────────────────────────────────

/** A deterministic orchestrator: fixed 100ms/tick clock, real bus + state. */
function makeHarness( config: OrchestratorConfig = {} ){
  const clock        = new DefaultSimulationClock({ fixedDeltaMs: 100, startTime: 0 } )
  const eventBus     = new DefaultEventBus()
  const stateManager = new DefaultStateManager()
  const orch         = new DefaultOrchestrator( clock, eventBus, stateManager, config )
  return { clock, eventBus, stateManager, orch }
}

/** A thin engine whose react() is the given function. */
function makeEngine( name: string, react: SimulationEngine['react'] ): SimulationEngine {
  return { name, react }
}

afterEach( () => { vi.restoreAllMocks() } )

// ── 1. Clock advance ──────────────────────────────────────────

describe('Orchestrator — tick advances + syncs the clock (R7)', () => {
  it('advances currentTick and pushes the sim time into the state manager', async () => {
    const { orch, clock, stateManager } = makeHarness()

    await orch.step( 1 )
    expect( orch.currentTick ).toBe( 1 )
    expect( clock.currentTick ).toBe( 1 )
    expect( stateManager.currentTick ).toBe( 1 )
    expect( stateManager.currentTime ).toBe( 100 )   // fixedDeltaMs, startTime 0

    await orch.step( 2 )
    expect( orch.currentTick ).toBe( 3 )
    expect( stateManager.currentTime ).toBe( 300 )
  } )
} )

// ── 2. Registration order ─────────────────────────────────────

describe('Orchestrator — engines run in registration order (R7)', () => {
  it('reacts engines sequentially in the order they were added', async () => {
    const { orch } = makeHarness()
    const order: string[] = []

    orch.addEngine( makeEngine('a', async () => { order.push('a'); return {} } ) )
    orch.addEngine( makeEngine('b', async () => { order.push('b'); return {} } ) )
    orch.addEngine( makeEngine('c', async () => { order.push('c'); return {} } ) )

    await orch.step( 1 )
    expect( order ).toEqual( [ 'a', 'b', 'c' ] )
  } )
} )

// ── 3. Double-buffer snapshot isolation ───────────────────────

describe('Orchestrator — frozen snapshot isolates same-tick writes (R7)', () => {
  it('a later engine does not see an earlier engine\'s write until the next tick', async () => {
    const { orch, stateManager } = makeHarness()
    const sees: boolean[] = []

    // writer sets 'x' every tick; reader (registered after) records visibility.
    orch.addEngine( makeEngine('writer', async () => (
      { commands: { set: [ { id: 'x', type: 'thing' } ] } }
    ) ) )
    orch.addEngine( makeEngine('reader', async ( _d, _t, state ) => {
      sees.push( state.entities.has('x') )
      return {}
    } ) )

    await orch.step( 1 )
    expect( sees ).toEqual( [ false ] )            // not visible within the same tick

    await orch.step( 1 )
    expect( sees ).toEqual( [ false, true ] )      // visible on the next tick's snapshot
    expect( stateManager.getEntity('x') ).toBeDefined()
  } )
} )

// ── 4. Atomic command application ─────────────────────────────

describe('Orchestrator — commands applied after all engines run (R7)', () => {
  it('commits entity sets and metric writes returned by an engine', async () => {
    const { orch, stateManager } = makeHarness()

    orch.addEngine( makeEngine('e', async () => (
      { commands: { set: [ { id: 'y', type: 'thing' } ], metrics: [ [ 'm', 5 ] ] } }
    ) ) )

    await orch.step( 1 )
    expect( stateManager.getEntity('y')?.id ).toBe('y')
    expect( stateManager.getMetric('m') ).toBe( 5 )
  } )
} )

// ── 5. Pre-commit validation ──────────────────────────────────

describe('Orchestrator — onBeforeCommit gates the commit (R7)', () => {
  it('aborts the commit when a validator returns errors: no commands, no events', async () => {
    vi.spyOn( console, 'error').mockImplementation( () => {} )

    const blocking: CommitValidator = () => [ 'blocked' ]
    const { orch, stateManager, eventBus } = makeHarness({ onBeforeCommit: [ blocking ] } )

    const fired: string[] = []
    eventBus.subscribe('test.evt', () => { fired.push('fired') } )

    orch.addEngine( makeEngine('e', async () => ({
      commands: { set: [ { id: 'z', type: 'thing' } ] },
      events:   [ { type: 'test.evt', source: 'e', payload: {} } ],
    } ) ) )

    await orch.step( 1 )
    expect( stateManager.getEntity('z') ).toBeUndefined()   // commit aborted
    expect( fired ).toEqual( [] )                             // events not published
  } )

  it('applies the commit when every validator passes', async () => {
    const passing: CommitValidator = () => true
    const { orch, stateManager, eventBus } = makeHarness({ onBeforeCommit: [ passing ] } )

    const fired: string[] = []
    eventBus.subscribe('test.evt', () => { fired.push('fired') } )

    orch.addEngine( makeEngine('e', async () => ({
      commands: { set: [ { id: 'z', type: 'thing' } ] },
      events:   [ { type: 'test.evt', source: 'e', payload: {} } ],
    } ) ) )

    await orch.step( 1 )
    expect( stateManager.getEntity('z') ).toBeDefined()
    expect( fired ).toEqual( [ 'fired' ] )
  } )
} )

// ── 6. Engine error isolation ─────────────────────────────────

describe('Orchestrator — engine failures are isolated (R7)', () => {
  it('routes a throw to onError, collects its fallback, and keeps running later engines', async () => {
    const { orch, stateManager } = makeHarness()
    const order: string[] = []

    const bad: SimulationEngine = {
      name:  'bad',
      react: async () => { throw new Error('boom') },
      onError: async () => {
        order.push('onError')
        return { commands: { metrics: [ [ 'recovered', 1 ] ] } }
      },
    }

    orch.addEngine( bad )
    orch.addEngine( makeEngine('good', async () => {
      order.push('good')
      return { commands: { set: [ { id: 'g', type: 'thing' } ] } }
    } ) )

    await orch.step( 1 )                              // must not throw
    expect( order ).toEqual( [ 'onError', 'good' ] )
    expect( stateManager.getMetric('recovered') ).toBe( 1 )   // fallback applied
    expect( stateManager.getEntity('g') ).toBeDefined()       // later engine still ran
  } )

  it('logs and continues when a throwing engine has no onError', async () => {
    const errSpy = vi.spyOn( console, 'error').mockImplementation( () => {} )
    const { orch, stateManager } = makeHarness()

    orch.addEngine( makeEngine('bad', async () => { throw new Error('boom') } ) )
    orch.addEngine( makeEngine('good', async () => (
      { commands: { set: [ { id: 'g', type: 'thing' } ] } }
    ) ) )

    await orch.step( 1 )                              // must not throw
    expect( stateManager.getEntity('g') ).toBeDefined()
    expect( errSpy ).toHaveBeenCalled()
  } )
} )

// ── 7. Before/after-tick snapshot phases ──────────────────────

describe('Orchestrator — before/after-tick snapshot phases (R7)', () => {
  it('onBeforeTick sees pre-commit state, onAfterTick sees post-commit state', async () => {
    const before: boolean[] = []
    const after:  boolean[] = []

    const { orch } = makeHarness({
      onBeforeTick: ( _t, s ) => { before.push( s.entities.has('w') ) },
      onAfterTick:  ( _t, s ) => { after.push( s.entities.has('w') ) },
    } )

    orch.addEngine( makeEngine('w-writer', async () => (
      { commands: { set: [ { id: 'w', type: 'thing' } ] } }
    ) ) )

    await orch.step( 1 )
    expect( before ).toEqual( [ false ] )   // engine hasn't committed yet
    expect( after ).toEqual( [ true ] )     // post-commit snapshot includes the write
  } )
} )

// ── 8. Event publishing order ─────────────────────────────────

describe('Orchestrator — events published post-commit with tick stamp (R7)', () => {
  it('stamps the current tick and flushes events after commands apply', async () => {
    const { orch, stateManager, eventBus } = makeHarness()

    let stampedTick: number | undefined
    let entityVisibleInHandler = false
    eventBus.subscribe('test.evt', evt => {
      stampedTick = evt.tick
      entityVisibleInHandler = stateManager.getEntity('q') !== undefined
    } )

    orch.addEngine( makeEngine('e', async () => ({
      commands: { set: [ { id: 'q', type: 'thing' } ] },
      events:   [ { type: 'test.evt', source: 'e', payload: {} } ],
    } ) ) )

    await orch.step( 1 )
    expect( stampedTick ).toBe( 1 )                 // tick stamped by orchestrator
    expect( entityVisibleInHandler ).toBe( true )   // flush ran after commit
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/async.engine.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * AsyncEngine optimistic-concurrency contract (REORIENT R7 / FIX F3).
 *
 * `src/core/async.engine.ts` is the base every LLM-driven faculty extends, yet
 * it had no direct coverage. Its whole reason to exist is to let reasoning span
 * multiple ticks WITHOUT blocking the tick loop, then re-validate the result
 * against the world as it stands when the answer finally arrives. These tests
 * pin that lifecycle against a controllable subclass, independent of any real
 * LLM:
 *
 *   1. Non-blocking — react() returns this tick even while reasoning is still
 *      in flight; the engine reports queue depth via the pending_depth metric.
 *   2. shouldAct gating — the default engine starts at most one reasoning at a
 *      time (no new work while a promise is pending).
 *   3. Cross-tick clean completion — a result that arrived on a later tick, with
 *      no intervening conflict, is committed via onReasoningComplete().
 *   4. Conflict + FORCE — when an observed entity changed under it, FORCE still
 *      applies the full reasoning result.
 *   5. Conflict + REJECT — drops the result's commands and (rerunOnRejection)
 *      schedules a fresh reasoning against current state.
 *   6. Stale prune — a reasoning that never settles is dropped once it exceeds
 *      maxPendingTicks.
 *   7. reasonAsync rejection — a thrown reasoning is swallowed (logged), the
 *      pending entry is removed, and nothing is committed.
 *
 * Conflict DETECTION itself (tick-vs-tick comparison, resolve() strategies) is
 * covered separately in conflict.detector.test.ts; here we exercise how the
 * engine *drives* the detector across ticks.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsyncEngine, type IntermediateStream } from '#core/async.engine'
import type { EngineResult } from '#core/orchestrator'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import type {
  ReadonlySimulationState,
  ReasoningFootprint,
  StateCommands,
  SimulationContext,
  AsyncEngineConfig,
  Tick,
} from '#core/types'

// ── Controllable test subclass ────────────────────────────────

/**
 * A minimal AsyncEngine whose every extension point is a swappable function,
 * so each test scripts the exact reasoning / completion / gating behaviour it
 * needs. Counters record how many times each hook fired.
 */
class TestEngine extends AsyncEngine {
  readonly name = 'test-engine'

  reasonImpl:   () => Promise<unknown>            = async () => 'output'
  completeImpl: ( output: unknown ) => StateCommands = () => ({})
  readStateImpl?: ( state: ReadonlySimulationState, tick: Tick ) => ReasoningFootprint
  actEnabled = true

  reasonCalls   = 0
  completeCalls = 0

  constructor( config: AsyncEngineConfig = {} ){ super( config ) }

  protected shouldAct(): boolean {
    // Default engine acts when idle; the flag lets a test freeze new reasoning
    // so it can observe a single in-flight operation in isolation.
    return this.actEnabled && !this.hasPendingWork
  }

  protected readState( state: ReadonlySimulationState, tick: Tick ): ReasoningFootprint {
    return this.readStateImpl ? this.readStateImpl( state, tick ) : super.readState( state, tick )
  }

  protected async reasonAsync(
    _footprint: ReasoningFootprint,
    _state: ReadonlySimulationState,
    _context: SimulationContext,
    _stream: IntermediateStream
  ): Promise<unknown> {
    this.reasonCalls++
    return this.reasonImpl()
  }

  protected onReasoningComplete( output: unknown ): StateCommands {
    this.completeCalls++
    return this.completeImpl( output )
  }
}

// ── Helpers ───────────────────────────────────────────────────

const ctx = createContext( 'test', 'async', 42 )

/** Drain all pending microtasks + the current macrotask so `.then` settle
 *  callbacks have fired before the next react(). */
const flush = () => new Promise<void>( r => setTimeout( r, 0 ) )

/** Pull the engine's pending_depth metric out of a react() result. */
function pendingDepth( result: EngineResult, name = 'test-engine' ): number | undefined {
  return result.commands?.metrics?.find( ( [ k ] ) => k === `engine.${name}.pending_depth` )?.[1]
}

/** Snapshot a state manager as the readonly view react() expects. */
function snap( sm: DefaultStateManager ): ReadonlySimulationState {
  return sm.snapshot() as unknown as ReadonlySimulationState
}

afterEach( () => { vi.restoreAllMocks() } )

// ── 1. Non-blocking ───────────────────────────────────────────

describe( 'AsyncEngine — non-blocking react (R7)', () => {
  it( 'returns the tick while reasoning is still in flight and reports depth=1', async () => {
    const engine = new TestEngine()
    engine.reasonImpl = () => new Promise<unknown>( () => {} )  // never settles

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    const result = await engine.react( 100, 0, snap( sm ), ctx )

    expect( engine.reasonCalls ).toBe( 1 )
    expect( engine.hasPendingWork ).toBe( true )
    expect( pendingDepth( result ) ).toBe( 1 )
  } )
} )

// ── 2. shouldAct gating ───────────────────────────────────────

describe( 'AsyncEngine — single in-flight reasoning (R7)', () => {
  it( 'does not start a second reasoning while one is pending', async () => {
    const engine = new TestEngine()
    engine.reasonImpl = () => new Promise<unknown>( () => {} )  // stays pending

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    await engine.react( 100, 0, snap( sm ), ctx )
    expect( engine.reasonCalls ).toBe( 1 )

    sm.updateClock( 1, 100 )
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.reasonCalls ).toBe( 1 )      // gated — still just the first
    expect( pendingDepth( r2 ) ).toBe( 1 )
  } )
} )

// ── 3. Cross-tick clean completion ────────────────────────────

describe( 'AsyncEngine — cross-tick completion without conflict (R7)', () => {
  it( 'commits onReasoningComplete commands on a later tick when nothing changed', async () => {
    const engine = new TestEngine()
    engine.reasonImpl   = async () => 'done'
    engine.completeImpl = () => ({ metrics: [ [ 'reasoning.committed', 1 ] ] })

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })   // updatedAtTick 0

    // Tick 0: start reasoning (footprint observes tick 0, reads { e1 }).
    await engine.react( 100, 0, snap( sm ), ctx )
    await flush()                               // let the promise settle

    // Tick 1: e1 untouched → no conflict. Freeze new reasoning so the only
    // commands are the completion's.
    engine.actEnabled = false
    sm.updateClock( 1, 100 )
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.completeCalls ).toBe( 1 )
    expect( r2.commands?.metrics ).toContainEqual( [ 'reasoning.committed', 1 ] )
    expect( engine.hasPendingWork ).toBe( false )
    expect( pendingDepth( r2 ) ).toBe( 0 )
  } )
} )

// ── 4. Conflict + FORCE ───────────────────────────────────────

describe( 'AsyncEngine — conflict resolved with FORCE (R7)', () => {
  it( 'applies the full result despite an intervening write', async () => {
    vi.spyOn( console, 'warn' ).mockImplementation( () => {} )       // silence conflict log

    const engine = new TestEngine({ defaultStrategy: 'FORCE' } )
    engine.reasonImpl   = async () => 'forced'
    engine.completeImpl = () => ({ metrics: [ [ 'forced.commit', 1 ] ] })

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })   // updatedAtTick 0

    // Tick 0: reasoning observes e1 at tick 0.
    await engine.react( 100, 0, snap( sm ), ctx )
    await flush()

    // Someone rewrites e1 at tick 1 → read conflict against the footprint.
    sm.updateClock( 1, 100 )
    sm.setEntity({ id: 'e1', type: 'thing' })   // updatedAtTick 1

    engine.actEnabled = false                   // isolate the completion
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.completeCalls ).toBe( 1 )                          // committed anyway
    expect( engine.reasonCalls ).toBe( 1 )                           // no rerun under FORCE
    expect( r2.commands?.metrics ).toContainEqual( [ 'forced.commit', 1 ] )
  } )
} )

// ── 5. Conflict + REJECT ──────────────────────────────────────

describe( 'AsyncEngine — conflict resolved with REJECT (R7)', () => {
  it( 'drops the result and reruns reasoning against current state', async () => {
    vi.spyOn( console, 'warn' ).mockImplementation( () => {} )       // silence conflict log

    const engine = new TestEngine({ defaultStrategy: 'REJECT', rerunOnRejection: true } )
    engine.reasonImpl   = async () => 'stale'
    engine.completeImpl = () => ({ metrics: [ [ 'should.not.commit', 1 ] ] })

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    await engine.react( 100, 0, snap( sm ), ctx )
    await flush()

    sm.updateClock( 1, 100 )
    sm.setEntity({ id: 'e1', type: 'thing' })   // conflict at tick 1

    engine.actEnabled = false                   // rerun must come from REJECT, not shouldAct
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.completeCalls ).toBe( 0 )                         // never committed
    expect( engine.reasonCalls ).toBe( 2 )                           // original + rerun
    expect( r2.commands?.metrics ).not.toContainEqual( [ 'should.not.commit', 1 ] )
    expect( engine.hasPendingWork ).toBe( true )                     // the rerun is pending
  } )

  it( 'drops the result silently when rerunOnRejection is false', async () => {
    vi.spyOn( console, 'warn' ).mockImplementation( () => {} )

    const engine = new TestEngine({ defaultStrategy: 'REJECT', rerunOnRejection: false } )
    engine.reasonImpl   = async () => 'stale'
    engine.completeImpl = () => ({ metrics: [ [ 'should.not.commit', 1 ] ] })

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    await engine.react( 100, 0, snap( sm ), ctx )
    await flush()

    sm.updateClock( 1, 100 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    engine.actEnabled = false
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.completeCalls ).toBe( 0 )
    expect( engine.reasonCalls ).toBe( 1 )                           // no rerun
    expect( engine.hasPendingWork ).toBe( false )
    expect( pendingDepth( r2 ) ).toBe( 0 )
  } )
} )

// ── 6. Stale prune ────────────────────────────────────────────

describe( 'AsyncEngine — stale reasoning pruning (R7)', () => {
  it( 'drops a reasoning that exceeds maxPendingTicks', async () => {
    vi.spyOn( console, 'warn' ).mockImplementation( () => {} )

    const engine = new TestEngine({ maxPendingTicks: 2 } )
    engine.reasonImpl = () => new Promise<unknown>( () => {} )       // never settles

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    await engine.react( 100, 0, snap( sm ), ctx )                    // startedAtTick 0
    engine.actEnabled = false                                       // no fresh reasoning

    // Ticks 1 and 2: age 1 and 2, both <= maxPendingTicks (2) → kept.
    for( const t of [ 1, 2 ] ){
      sm.updateClock( t, t * 100 )
      const r = await engine.react( 100, t, snap( sm ), ctx )
      expect( pendingDepth( r ) ).toBe( 1 )
    }

    // Tick 3: age 3 > 2 → pruned.
    sm.updateClock( 3, 300 )
    const r3 = await engine.react( 100, 3, snap( sm ), ctx )

    expect( engine.hasPendingWork ).toBe( false )
    expect( pendingDepth( r3 ) ).toBe( 0 )
  } )
} )

// ── 7. reasonAsync rejection ──────────────────────────────────

describe( 'AsyncEngine — reasoning that throws (R7)', () => {
  it( 'swallows the error, removes the pending entry, and commits nothing', async () => {
    const errSpy = vi.spyOn( console, 'error' ).mockImplementation( () => {} )

    const engine = new TestEngine()
    engine.reasonImpl   = () => Promise.reject( new Error( 'reasoning blew up' ) )
    engine.completeImpl = () => ({ metrics: [ [ 'should.not.commit', 1 ] ] })

    const sm = new DefaultStateManager()
    sm.updateClock( 0, 0 )
    sm.setEntity({ id: 'e1', type: 'thing' })

    await engine.react( 100, 0, snap( sm ), ctx )
    await flush()

    engine.actEnabled = false
    sm.updateClock( 1, 100 )
    const r2 = await engine.react( 100, 1, snap( sm ), ctx )

    expect( engine.completeCalls ).toBe( 0 )
    expect( engine.hasPendingWork ).toBe( false )
    expect( pendingDepth( r2 ) ).toBe( 0 )
    expect( errSpy ).toHaveBeenCalled()
  } )
} )

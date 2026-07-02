// ─────────────────────────────────────────────────────────────
// tests/unit/event.bus.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * DefaultEventBus dispatch contract (REORIENT R7 — invariants over leaves).
 *
 * The event bus carries every signal between engines and lands events in the
 * replay stream, yet it had no direct coverage. These tests pin its observable
 * contract, deterministically (an injected `now` keeps timestamps fixed — no
 * wall-clock leak — and event ids are a per-bus monotonic counter for R2 replay
 * fidelity):
 *
 *   1. publish() queues; flush() stamps (id/timestamp/tick) and dispatches.
 *   2. Event ids are deterministic and monotonic in publish order.
 *   3. Type, filtered, and catch-all handlers all fire for a match; a handler
 *      bound to another type does not. Unsubscribe stops delivery.
 *   4. scheduleAt() + prepareTick() release future events only once due, in
 *      ascending tick order regardless of insertion order.
 *   5. An event published by a handler mid-flush is dispatched in the same
 *      flush (cascade), without re-entrant double-processing.
 *   6. clear() drops pending events and every handler.
 *   7. publish() throws once the pending queue exceeds maxQueueSize.
 *   8. publishAsync() flushes inline when below the sync threshold.
 */

import { describe, it, expect } from 'vitest'
import { DefaultEventBus } from '#core/event.bus'
import { createContext } from '#core/utils'
import type { SimulationEvent } from '#core/types'

const ctx = createContext( 'test', 'bus', 1 )

/** Build the publish-side event shape (orchestrator stamps id/timestamp/tick). */
function evt( type: string, payload: unknown = {} ){
  return { type, source: 'test', payload }
}

// ── 1–2. Publish / flush / stamping ───────────────────────────

describe( 'DefaultEventBus — publish + flush dispatch (R7)', () => {
  it( 'queues a published event, then stamps and dispatches it on flush', async () => {
    const bus = new DefaultEventBus({ now: () => 1000 } )
    const received: SimulationEvent[] = []
    bus.subscribe( 'a', e => { received.push( e ) } )

    bus.publish( evt( 'a', { n: 1 } ), ctx, 5 )
    expect( bus.getPendingCount() ).toBe( 1 )       // queued, not yet dispatched

    await bus.flush()
    expect( received ).toHaveLength( 1 )
    expect( received[0]!.type ).toBe( 'a' )
    expect( received[0]!.tick ).toBe( 5 )           // caller-provided tick
    expect( received[0]!.timestamp ).toBe( 1000 )   // injected now
    expect( received[0]!.id ).toBe( 'evt-0' )       // first id off this bus
    expect( received[0]!.payload ).toEqual( { n: 1 } )
    expect( bus.getPendingCount() ).toBe( 0 )
  } )

  it( 'assigns deterministic monotonic ids in publish order', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    const ids: string[] = []
    bus.subscribeAll( e => { ids.push( e.id ) } )

    bus.publish( evt( 'a' ), ctx, 1 )
    bus.publish( evt( 'b' ), ctx, 1 )
    await bus.flush()

    expect( ids ).toEqual( [ 'evt-0', 'evt-1' ] )
  } )
} )

// ── 3. Handler tiers + unsubscribe ────────────────────────────

describe( 'DefaultEventBus — handler tiers (R7)', () => {
  it( 'delivers to type, filtered, and catch-all handlers; skips other-type handlers', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    const hits: string[] = []
    bus.subscribe( 'match', () => { hits.push( 'type' ) } )
    bus.subscribe( 'other', () => { hits.push( 'other-type' ) } )
    bus.subscribeFiltered( e => e.type === 'match', () => { hits.push( 'filtered' ) } )
    bus.subscribeAll( () => { hits.push( 'all' ) } )

    bus.publish( evt( 'match' ), ctx, 1 )
    await bus.flush()

    expect( hits ).toContain( 'type' )
    expect( hits ).toContain( 'filtered' )
    expect( hits ).toContain( 'all' )
    expect( hits ).not.toContain( 'other-type' )
  } )

  it( 'stops delivering after the unsubscribe handle is called', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    let count = 0
    const off = bus.subscribe( 'a', () => { count++ } )

    bus.publish( evt( 'a' ), ctx, 1 )
    await bus.flush()
    expect( count ).toBe( 1 )

    off()
    bus.publish( evt( 'a' ), ctx, 1 )
    await bus.flush()
    expect( count ).toBe( 1 )                       // no further delivery
  } )
} )

// ── 4. Scheduled future events ────────────────────────────────

describe( 'DefaultEventBus — scheduled future events (R7)', () => {
  it( 'releases scheduled events only once due, in ascending tick order', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    const order: string[] = []
    bus.subscribeAll( e => { order.push( e.type ) } )

    // Scheduled out of order — the bus keeps them sorted by tick.
    bus.scheduleAt( 5, evt( 'late' ),  ctx )
    bus.scheduleAt( 3, evt( 'early' ), ctx )

    bus.prepareTick( 2 )
    expect( bus.getPendingCount() ).toBe( 0 )       // nothing due yet

    bus.prepareTick( 3 )
    expect( bus.getPendingCount() ).toBe( 1 )       // only the tick-3 event

    bus.prepareTick( 5 )
    expect( bus.getPendingCount() ).toBe( 2 )       // tick-5 now due too

    await bus.flush()
    expect( order ).toEqual( [ 'early', 'late' ] )
  } )
} )

// ── 5. Flush cascade + re-entrancy ────────────────────────────

describe( 'DefaultEventBus — flush cascade (R7)', () => {
  it( 'dispatches an event a handler publishes within the same flush', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    const order: string[] = []
    bus.subscribe( 'first', e => {
      order.push( 'first' )
      bus.publish( evt( 'second' ), ctx, e.tick )   // published mid-flush
    } )
    bus.subscribe( 'second', () => { order.push( 'second' ) } )

    bus.publish( evt( 'first' ), ctx, 1 )
    await bus.flush()

    expect( order ).toEqual( [ 'first', 'second' ] )
    expect( bus.getPendingCount() ).toBe( 0 )
  } )
} )

// ── 6–7. Housekeeping + backpressure ──────────────────────────

describe( 'DefaultEventBus — housekeeping (R7)', () => {
  it( 'clear() drops pending events and all handlers', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    let count = 0
    bus.subscribe( 'a', () => { count++ } )

    bus.publish( evt( 'a' ), ctx, 1 )
    expect( bus.getPendingCount() ).toBe( 1 )

    bus.clear()
    expect( bus.getPendingCount() ).toBe( 0 )

    bus.publish( evt( 'a' ), ctx, 1 )
    await bus.flush()
    expect( count ).toBe( 0 )                       // handler was cleared
  } )

  it( 'throws once the pending queue exceeds maxQueueSize', () => {
    const bus = new DefaultEventBus({ maxQueueSize: 2, now: () => 0 } )
    bus.publish( evt( 'a' ), ctx, 1 )
    bus.publish( evt( 'a' ), ctx, 1 )
    expect( () => bus.publish( evt( 'a' ), ctx, 1 ) ).toThrow( /queue full/ )
  } )
} )

// ── 8. publishAsync ───────────────────────────────────────────

describe( 'DefaultEventBus — publishAsync (R7)', () => {
  it( 'flushes inline when the queue is below the sync threshold', async () => {
    const bus = new DefaultEventBus({ now: () => 0 } )
    let count = 0
    bus.subscribe( 'a', () => { count++ } )

    await bus.publishAsync( evt( 'a' ), ctx, 1 )

    expect( count ).toBe( 1 )                       // dispatched without an explicit flush
    expect( bus.getPendingCount() ).toBe( 0 )
  } )
} )

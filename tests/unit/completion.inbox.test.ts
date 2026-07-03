// ─────────────────────────────────────────────────────────────
// tests/unit/completion.inbox.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Tick-boundary landing for async completion effects (the fix for the one path
 * that broke the frozen-snapshot rule: facet decision listeners firing at raw
 * LLM-promise resolution).
 *
 * Pins the contract:
 *   1. enqueue() NEVER applies inline — effects wait for drain().
 *   2. drain() applies FIFO, exactly once, and reports the count.
 *   3. A throwing thunk is isolated — later thunks still land, the drain returns.
 *   4. Thunks enqueued DURING a drain land on the NEXT drain (no same-cycle
 *      reentrancy — the tick's snapshot stays coherent).
 *   5. clear() discards staged work (mind teardown).
 */

import { describe, it, expect } from 'vitest'
import { CompletionInbox } from '#cognition/completion.inbox'

describe( 'CompletionInbox — tick-boundary landing', () => {
  it( 'defers effects: enqueue never applies inline, drain applies FIFO', () => {
    const inbox = new CompletionInbox()
    const applied: string[] = []

    inbox.enqueue( 'a', () => applied.push( 'a' ) )
    inbox.enqueue( 'b', () => applied.push( 'b' ) )

    expect( applied ).toEqual( [] )          // staged, not applied
    expect( inbox.size ).toBe( 2 )

    const landed = inbox.drain( 7 )

    expect( landed ).toBe( 2 )
    expect( applied ).toEqual( [ 'a', 'b' ] ) // FIFO
    expect( inbox.size ).toBe( 0 )
    expect( inbox.drain( 8 ) ).toBe( 0 )      // exactly once
  } )

  it( 'isolates a throwing thunk — the rest of the batch still lands', () => {
    const inbox = new CompletionInbox()
    const applied: string[] = []

    inbox.enqueue( 'ok-1',  () => applied.push( 'ok-1' ) )
    inbox.enqueue( 'boom',  () => { throw new Error( 'listener exploded' ) } )
    inbox.enqueue( 'ok-2',  () => applied.push( 'ok-2' ) )

    expect( inbox.drain( 1 ) ).toBe( 3 )
    expect( applied ).toEqual( [ 'ok-1', 'ok-2' ] )
  } )

  it( 'work enqueued during a drain lands on the NEXT drain, not the same one', () => {
    const inbox = new CompletionInbox()
    const applied: string[] = []

    inbox.enqueue( 'first', () => {
      applied.push( 'first' )
      // A landing effect triggers more async work whose completion staged
      // synchronously (e.g. a re-fed replay completion) — must NOT land in
      // this same cycle.
      inbox.enqueue( 'second', () => applied.push( 'second' ) )
    } )

    expect( inbox.drain( 1 ) ).toBe( 1 )
    expect( applied ).toEqual( [ 'first' ] )
    expect( inbox.size ).toBe( 1 )

    expect( inbox.drain( 2 ) ).toBe( 1 )
    expect( applied ).toEqual( [ 'first', 'second' ] )
  } )

  it( 'clear() discards staged work and reports the count', () => {
    const inbox = new CompletionInbox()
    let fired = false

    inbox.enqueue( 'never', () => { fired = true } )
    expect( inbox.clear() ).toBe( 1 )
    expect( inbox.drain( 1 ) ).toBe( 0 )
    expect( fired ).toBe( false )
  } )
} )

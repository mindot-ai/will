// ─────────────────────────────────────────────────────────────
// tests/unit/llm.gate.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LLM concurrency gate (REORIENT R7 — invariants over leaves).
 *
 * `src/llm/gate.ts` is load-bearing infra with no direct coverage: every LLM
 * call in the engine funnels through `withGate`, which caps global concurrency
 * via `LLMSemaphore` and retries 429s with exponential backoff. These tests pin
 * the three contracts independently of the env-driven knobs:
 *
 *   1. LLMSemaphore — never exceeds its cap, wakes queued waiters FIFO, and a
 *      release is idempotent (a double-call must not underflow the counter).
 *   2. isRateLimitError — only Errors that look like a 429 are retryable.
 *   3. withGate — succeeds without retrying, propagates non-429 errors
 *      immediately, retries a 429 to eventual success, and gives up after the
 *      retry budget is exhausted.
 *
 * Slot release during backoff: withGate releases its semaphore slot *before*
 * the backoff wait (the `finally` runs before the `await setTimeout`), so a
 * rate-limited call does not hold a slot while it sleeps. The injectable `gate`
 * arg (defaulting to the module singleton) lets us pin this deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LLMSemaphore, isRateLimitError, withGate } from '#llm/gate'

function deferred<T = void>() {
  let resolve!: ( value: T | PromiseLike<T> ) => void
  let reject!: ( reason?: unknown ) => void
  const promise = new Promise<T>( ( res, rej ) => { resolve = res; reject = rej } )
  return { promise, resolve, reject }
}

describe('LLMSemaphore — concurrency cap (R7)', () => {
  it('admits up to max acquisitions without queueing, then frees them', async () => {
    const sem = new LLMSemaphore( 2 )

    const r1 = await sem.acquire()
    const r2 = await sem.acquire()

    expect( sem.running ).toBe( 2 )
    expect( sem.queued ).toBe( 0 )

    r1()
    r2()
    expect( sem.running ).toBe( 0 )
  } )

  it('queues acquisitions beyond max and wakes them FIFO on release', async () => {
    const sem = new LLMSemaphore( 1 )

    const r1 = await sem.acquire()        // running=1, the only slot
    expect( sem.running ).toBe( 1 )

    // Two more contenders — both must park in the queue (synchronously enqueued).
    const order: number[] = []
    const a2 = sem.acquire().then( rel => { order.push( 2 ); return rel } )
    const a3 = sem.acquire().then( rel => { order.push( 3 ); return rel } )
    expect( sem.queued ).toBe( 2 )

    // Releasing the slot wakes the FIRST waiter only.
    r1()
    const rel2 = await a2
    expect( order ).toEqual( [ 2 ] )
    expect( sem.running ).toBe( 1 )
    expect( sem.queued ).toBe( 1 )

    // Releasing again wakes the second, in arrival order.
    rel2()
    const rel3 = await a3
    expect( order ).toEqual( [ 2, 3 ] )

    rel3()
    expect( sem.running ).toBe( 0 )
    expect( sem.queued ).toBe( 0 )
  } )

  it('treats a double release as a no-op (no counter underflow)', async () => {
    const sem = new LLMSemaphore( 1 )

    const rel = await sem.acquire()
    rel()
    rel()                                 // second call must be ignored
    expect( sem.running ).toBe( 0 )

    // The slot is genuinely free again — a fresh acquire succeeds immediately.
    const rel2 = await sem.acquire()
    expect( sem.running ).toBe( 1 )
    rel2()
  } )

  it('does not start a queued waiter until a slot actually opens', async () => {
    const sem = new LLMSemaphore( 1 )
    const rel = await sem.acquire()

    let started = false
    const waiter = sem.acquire().then( r => { started = true; return r } )

    // Give microtasks a chance — the waiter must still be parked.
    await Promise.resolve()
    expect( started ).toBe( false )
    expect( sem.queued ).toBe( 1 )

    rel()
    const rel2 = await waiter
    expect( started ).toBe( true )
    rel2()
  } )
} )

describe('isRateLimitError — only 429-shaped Errors retry (R7)', () => {
  it('returns true for a statusCode 429 Error', () => {
    const err = Object.assign( new Error('boom'), { statusCode: 429 } )
    expect( isRateLimitError( err ) ).toBe( true )
  } )

  it('returns true for rate-limit message variants', () => {
    expect( isRateLimitError( new Error('rate_limit_error: slow down') ) ).toBe( true )
    expect( isRateLimitError( new Error('hit the rate limit') ) ).toBe( true )
    expect( isRateLimitError( new Error('HTTP 429 Too Many Requests') ) ).toBe( true )
  } )

  it('returns false for ordinary errors and non-Error values', () => {
    expect( isRateLimitError( new Error('network unreachable') ) ).toBe( false )
    expect( isRateLimitError('429') ).toBe( false )              // string, not Error
    expect( isRateLimitError( { statusCode: 429 } ) ).toBe( false ) // plain object, not Error
    expect( isRateLimitError( null ) ).toBe( false )
    expect( isRateLimitError( undefined ) ).toBe( false )
  } )
} )

describe('withGate — retry semantics (R7)', () => {
  // Real timers with a tiny env-tuned backoff (WILL_LLM_RETRY_BASE_MS, read
  // lazily by withGate) — bun:test's `vi` has no async fake-timer helpers, and
  // real waits of a few ms exercise the genuine code path anyway.
  let _envBase:    string | undefined
  let _envRetries: string | undefined

  beforeEach( () => {
    _envBase    = process.env.WILL_LLM_RETRY_BASE_MS
    _envRetries = process.env.WILL_LLM_MAX_RETRIES
    process.env.WILL_LLM_RETRY_BASE_MS = '1'   // backoff ≈ 2, 4 ms
    process.env.WILL_LLM_MAX_RETRIES   = '2'
    // Pin the backoff jitter so delays are deterministic.
    vi.spyOn( Math, 'random').mockReturnValue( 0 )
  } )

  afterEach( () => {
    if( _envBase    === undefined ) delete process.env.WILL_LLM_RETRY_BASE_MS
    else process.env.WILL_LLM_RETRY_BASE_MS = _envBase
    if( _envRetries === undefined ) delete process.env.WILL_LLM_MAX_RETRIES
    else process.env.WILL_LLM_MAX_RETRIES = _envRetries
    vi.restoreAllMocks()
  } )

  it('calls fn once and returns its value on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')

    const result = await withGate( fn, 'success')

    expect( result ).toBe('ok')
    expect( fn ).toHaveBeenCalledTimes( 1 )
  } )

  it('propagates a non-rate-limit error immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue( new Error('fatal') )

    await expect( withGate( fn, 'fatal') ).rejects.toThrow('fatal')
    expect( fn ).toHaveBeenCalledTimes( 1 )
  } )

  it('retries after a 429 and resolves on the next attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce( new Error('rate_limit_error') )
      .mockResolvedValueOnce('recovered')

    // Backoff is ~2 ms (env-tuned) — await straight through it.
    await expect( withGate( fn, 'retry-once') ).resolves.toBe('recovered')
    expect( fn ).toHaveBeenCalledTimes( 2 )
  } )

  it('gives up and rejects with the 429 after exhausting the retry budget', async () => {
    const rateLimit = Object.assign( new Error('too many requests'), { statusCode: 429 } )
    const fn = vi.fn().mockRejectedValue( rateLimit )

    await expect( withGate( fn, 'persistent-429') ).rejects.toBe( rateLimit )
    // Initial attempt + the full retry budget (WILL_LLM_MAX_RETRIES=2) = 3 calls.
    expect( fn ).toHaveBeenCalledTimes( 3 )
  } )

  it('releases its slot during backoff so other engines are not starved (R7)', async () => {
    // A single-slot gate makes starvation observable: if the rate-limited call
    // held its slot through the backoff, the competitor below could never run.
    // Use a WIDE real backoff (200 ms) so "mid-backoff" is unambiguous.
    process.env.WILL_LLM_RETRY_BASE_MS = '100'   // first retry ≈ 200 ms out
    const gate = new LLMSemaphore( 1 )

    const blocked = vi.fn()
      .mockRejectedValueOnce( Object.assign( new Error('rate_limit_error'), { statusCode: 429 } ) )
      .mockResolvedValueOnce('recovered')
    const competitor = vi.fn().mockResolvedValue('through')

    const pBlocked    = withGate( blocked, 'blocked', gate )
    const pCompetitor = withGate( competitor, 'competitor', gate )

    // `blocked` attempts once, hits the 429, releases its slot, and parks in
    // setTimeout for ~200 ms. The freed slot lets `competitor` acquire and
    // resolve right now — mid-backoff (would hang under the old slot-holding bug).
    await expect( pCompetitor ).resolves.toBe('through')

    expect( blocked ).toHaveBeenCalledTimes( 1 )   // attempted once, still backing off
    expect( competitor ).toHaveBeenCalledTimes( 1 )
    expect( gate.running ).toBe( 0 )               // competitor released; the sleeping call holds nothing

    // Let the backoff elapse: `blocked` re-acquires, retries, and resolves.
    await expect( pBlocked ).resolves.toBe('recovered')
    expect( blocked ).toHaveBeenCalledTimes( 2 )
  } )
} )

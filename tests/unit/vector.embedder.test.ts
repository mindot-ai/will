// ─────────────────────────────────────────────────────────────
// tests/unit/vector.embedder.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for OpenAICompatibleEmbedder hardening (FN16).
 *
 * Regression target: embed()'s `fetch` had no timeout (a hung connection
 * blocked forever) and `data.data[0]!.embedding` threw an opaque TypeError on
 * an empty/malformed response. embedBatch() fanned every request out at once
 * via Promise.all with no concurrency gate.
 *
 * The fix adds an AbortSignal.timeout, a response-shape guard with a clear
 * error, and a bounded worker pool for embedBatch that preserves order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleEmbedder } from '#memory/vector.embedder'

const realFetch = globalThis.fetch

function okEmbedding( embedding: number[] ){
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [ { embedding } ] }) } as unknown as Response
}

function make( extra: Partial<{ maxConcurrency: number; timeoutMs: number }> = {} ){
  return new OpenAICompatibleEmbedder({ modelName: 'm', dimensions: 3, apiUrl: 'http://x', ...extra })
}

afterEach( () => { globalThis.fetch = realFetch } )

describe('OpenAICompatibleEmbedder — timeout + response guard (FN16)', () => {
  it('passes an AbortSignal to fetch so a hung request can be cancelled', async () => {
    let seenSignal: unknown
    globalThis.fetch = ( async ( _url: string, init: RequestInit ) => {
      seenSignal = init.signal
      return okEmbedding( [ 0.1, 0.2, 0.3 ] )
    } ) as unknown as typeof fetch

    await make().embed('hello')
    expect( seenSignal ).toBeInstanceOf( AbortSignal )
  })

  it('translates an abort/timeout into a clear error message', async () => {
    globalThis.fetch = ( async () => {
      throw Object.assign( new Error('The operation timed out.'), { name: 'TimeoutError' } )
    } ) as unknown as typeof fetch

    await expect( make({ timeoutMs: 1234 }).embed('x') ).rejects.toThrow( /timed out after 1234ms/ )
  })

  it('throws a descriptive error on an empty response array', async () => {
    globalThis.fetch = ( async () => ( { ok: true, status: 200, json: async () => ({ data: [] }) } ) ) as unknown as typeof fetch
    await expect( make().embed('x') ).rejects.toThrow( /empty or malformed/ )
  })

  it('throws on a present-but-embedding-less entry instead of an opaque TypeError', async () => {
    globalThis.fetch = ( async () => ( { ok: true, status: 200, json: async () => ({ data: [ {} ] }) } ) ) as unknown as typeof fetch
    await expect( make().embed('x') ).rejects.toThrow( /empty or malformed/ )
  })

  it('returns the embedding on a well-formed response', async () => {
    globalThis.fetch = ( async () => okEmbedding( [ 1, 2, 3 ] ) ) as unknown as typeof fetch
    expect( await make().embed('x') ).toEqual( [ 1, 2, 3 ] )
  })

  it('still surfaces non-ok HTTP statuses', async () => {
    globalThis.fetch = ( async () => ( { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) } ) ) as unknown as typeof fetch
    await expect( make().embed('x') ).rejects.toThrow( /Embedding failed: 503/ )
  })
})

describe('OpenAICompatibleEmbedder — embedBatch concurrency gate (FN16)', () => {
  it('never exceeds maxConcurrency in-flight requests and preserves order', async () => {
    let active = 0
    let peak = 0
    globalThis.fetch = ( async ( _url: string, init: RequestInit ) => {
      active++
      peak = Math.max( peak, active )
      await new Promise( r => setTimeout( r, 10 ) )
      active--
      const input = Number( JSON.parse( init.body as string ).input )
      return okEmbedding( [ input ] )
    } ) as unknown as typeof fetch

    const contents = Array.from( { length: 10 }, ( _, i ) => String( i ) )
    const out = await make({ maxConcurrency: 3 }).embedBatch( contents )

    // The gate held: at most 3 requests overlapped (and it did saturate to 3).
    expect( peak ).toBe( 3 )
    // Output order matches input order despite out-of-order completion.
    expect( out.map( e => e[ 0 ] ) ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 ] )
  })

  it('handles an empty input list without firing any requests', async () => {
    let calls = 0
    globalThis.fetch = ( async () => { calls++; return okEmbedding( [ 0 ] ) } ) as unknown as typeof fetch
    expect( await make().embedBatch( [] ) ).toEqual( [] )
    expect( calls ).toBe( 0 )
  })
})

describe('OpenAICompatibleEmbedder — independent embed() callers share the gate', () => {
  /** Count peak overlap across whatever requests the body fires. */
  function peakCounter(){
    const c = { active: 0, peak: 0 }
    globalThis.fetch = ( async () => {
      c.active++; c.peak = Math.max( c.peak, c.active )
      await new Promise( r => setTimeout( r, 10 ) )
      c.active--
      return okEmbedding( [ 1 ] )
    } ) as unknown as typeof fetch
    return c
  }

  it('bounds fan-out across separate embed() calls, not only within one embedBatch', async () => {
    // The production shape: N facets each recall once, concurrently. embedBatch was
    // already bounded; this path was not. Measured against gemini-embedding-001, 8
    // unbounded requests had the slowest three land at 10.7s — past the 5s recall
    // budget, so their answers were discarded on arrival and the mind recalled nothing.
    const c = peakCounter()
    const embedder = make({ maxConcurrency: 2 })

    await Promise.all( Array.from( { length: 8 }, () => embedder.embed('recall me') ) )

    expect( c.peak ).toBe( 2 )
  })

  it('defaults to 4 in flight — the measured safe fan-out for this provider', async () => {
    const c = peakCounter()
    const embedder = make()

    await Promise.all( Array.from( { length: 8 }, () => embedder.embed('recall me') ) )

    expect( c.peak ).toBe( 4 )
  })

  it('retries a 429 instead of failing the recall outright', async () => {
    let calls = 0
    globalThis.fetch = ( async () => {
      calls++
      if( calls === 1 ) return { ok: false, status: 429, statusText: 'Too Many Requests' } as unknown as Response
      return okEmbedding( [ 7 ] )
    } ) as unknown as typeof fetch

    process.env.WILL_LLM_RETRY_BASE_MS = '1'
    try {
      expect( await make().embed('x') ).toEqual( [ 7 ] )
      expect( calls ).toBe( 2 )   // a rate limit is a wait, not a lost recall
    }
    finally { delete process.env.WILL_LLM_RETRY_BASE_MS }
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/llm.stream-idle-deadline.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A stream that stops arriving has to settle. Silence is not patience.
 *
 * The deadline used to be first-byte only — armed before the fetch and cleared
 * the moment the response headers landed, so that a healthy long generation was
 * never truncated mid-sentence. That left the read loop with no clock at all. A
 * socket that went quiet after the first byte produced a promise that could
 * never settle.
 *
 * Downstream, the executive's AsyncEngine keeps every in-flight reasoning pass
 * in `_pending`, and `hasPendingWork` closes the master's gate while anything is
 * there. One unsettleable stream therefore muted the deliberative seat until the
 * stale prune dropped it 600 ticks later. Observed live: master cycles at
 * 11:55:49, 11:55:58, 11:56:05 — then nothing until 12:06:11, ten minutes of a
 * mind not deliberating while thirty-three facets churned beneath it, all
 * stamped with the tick the master had stopped at.
 *
 * So the clock is IDLE, not total: restarted by every chunk that arrives. A live
 * generation keeps it alive indefinitely; a dead one runs it out. Both halves
 * matter, and the second is the one a naive "just add a timeout" fix breaks.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { LLMDirector } from '#llm/index'

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch } )

const enc = ( s: string ) => new TextEncoder().encode( s )

const START = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n'
const delta = ( t: string ) =>
  `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( t ) }}}\n`

/** A Response whose body is driven by the test, and which honours the abort signal. */
function streamedResponse( drive: ( c: ReadableStreamDefaultController<Uint8Array> ) => void ){
  globalThis.fetch = ( async ( _url: string, init: RequestInit ) => ({
    ok: true, status: 200, statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start( c ){
        // Real fetch ties the body stream to the signal; a fake that does not
        // would pass this test with no deadline in the code at all.
        init?.signal?.addEventListener('abort', () => {
          try { c.error( new DOMException('aborted', 'AbortError') ) } catch { /* already closed */ }
        } )
        drive( c )
      },
    } ),
  } ) as unknown as Response ) as unknown as typeof fetch
}

function director( timeoutMs: number ){
  return new LLMDirector({
    willId: 'w1', model: 'claude-sonnet-5', maxOutputTokens: 64,
    apiKey: 'k', provider: 'anthropic', sessionLogger: null, timeoutMs,
  })
}

describe('a stream that goes quiet', () => {
  it('settles as a failure instead of hanging forever', async () => {
    streamedResponse( c => { c.enqueue( enc( START + delta('I think ') ) ) } )   // then nothing, ever

    const started = Date.now()
    await expect(
      director( 80 ).callStream('sys', 'user', 1, () => {} )
    ).rejects.toThrow( /stalled/i )

    // Bounded by the deadline, not by the test runner giving up on it.
    expect( Date.now() - started ).toBeLessThan( 3_000 )
    // Own timeout, well under the suite's 120s: if this regresses the call never
    // settles at all, and a two-minute hang is a bad way to be told so.
  }, 5_000 )

  it('names the stall rather than reporting no response at all', async () => {
    // "no response" is the FIRST-byte failure and a different fault to chase:
    // that one never reached the model, this one reached it and lost it.
    streamedResponse( c => { c.enqueue( enc( START ) ) } )

    await expect(
      director( 80 ).callStream('sys', 'user', 1, () => {} )
    ).rejects.toThrow( /no data for 80ms/ )
  }, 5_000 )
} )

describe('a stream that is slow but alive', () => {
  it('is not cut off, however long it runs in total', async () => {
    // Five chunks, 40ms apart: 200ms of streaming against an 80ms deadline. A
    // whole-response timeout kills this; an idle one must not touch it.
    streamedResponse( c => {
      c.enqueue( enc( START ) )
      let n = 0
      const t = setInterval( () => {
        if( n < 5 ) c.enqueue( enc( delta(`chunk${ n++ } `) ) )
        else { clearInterval( t ); c.enqueue( enc('data: [DONE]\n') ); c.close() }
      }, 40 )
    } )

    const chunks: string[] = []
    const r = await director( 80 ).callStream('sys', 'user', 1, ch => { chunks.push( ch ) } )

    expect( chunks.length ).toBe( 5 )
    expect( r.text ).toBe('chunk0 chunk1 chunk2 chunk3 chunk4 ')
  } )
} )

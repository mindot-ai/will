// ─────────────────────────────────────────────────────────────
// tests/unit/audition.chunk.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Section 2.2 — multi-subscriber chunk fan-out.
 *
 * The AuditionEngine chunk callback is now a Set, so several consumers (transport
 * emit + SSE fan-out) receive the filtered [REPLY_TEXT] token stream at once. Each
 * handler gets (entityId, threadId, chunk); only content between [REPLY_TEXT] and
 * [/REPLY_TEXT] leaks — internal reasoning/JSON never does.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import { createTestBus }  from '#cognition/bus'
import type { TextMessage } from '#senses/index'

const text = ( content: string, entityId = 'alice'): TextMessage =>
  ({ kind: 'text', entityId, threadId: 't1', content })

/** Executive whose facet captures the chunk pipe so the test can drive raw tokens. */
function makeChunkExecutive(){
  let pipe: (( raw: string ) => void) | null = null
  const engine = {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      const handle = {
        facetId: 'f1',
        report(){ sub?.({ decision: { reply: 'x', replyBubbles: ['x'], targetEntityId: 'alice', requiresMasterAttention: false }, reasoning: '', confidence: 0.9 }) },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus(){}, setStateRef(){},
        onChunk( h: any ){ pipe = h },   // capture the pipe AuditionEngine registers
        onReaped(){},
        destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }
  return { engine, drive: ( raw: string ) => pipe?.( raw ) }
}

describe('AuditionEngine — chunk fan-out (Section 2.2)', () => {
  it('fans filtered [REPLY_TEXT] tokens to every subscriber with the current threadId', async () => {
    const exec   = makeChunkExecutive()
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine as any )

    const a: Array<[string, string, string]> = []
    const b: string[] = []
    engine.addChunkCallback( ( e, t, c ) => a.push( [e, t, c] ) )
    engine.addChunkCallback( ( _e, _t, c ) => b.push( c ) )

    await engine.ingest( text('hi') )

    exec.drive('[REPLY_TEXT]Hello')
    exec.drive(' world[/REPLY_TEXT]')

    expect( a.map( x => x[2] ).join('') ).toBe('Hello world')
    expect( b.join('') ).toBe('Hello world')                   // second subscriber too
    expect( a.every( x => x[0] === 'alice' && x[1] === 't1') ).toBe( true )
  } )

  it('does not leak internal reasoning / JSON before [REPLY_TEXT]', async () => {
    const exec   = makeChunkExecutive()
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine as any )

    const got: string[] = []
    engine.addChunkCallback( ( _e, _t, c ) => got.push( c ) )
    await engine.ingest( text('hi') )

    exec.drive('```json\n{"actions":[]}\n```\n[REPLY_TEXT]Hi[/REPLY_TEXT]')
    expect( got.join('') ).toBe('Hi')   // only the reply leaked
  } )

  it('does not register the chunk pipe when there are no subscribers', async () => {
    const exec   = makeChunkExecutive()
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine as any )

    await engine.ingest( text('hi') )            // no addChunkCallback → no pipe registered
    expect( () => exec.drive('[REPLY_TEXT]x[/REPLY_TEXT]') ).not.toThrow()
  } )

  it('unsubscribe stops delivery to that subscriber only', async () => {
    const exec   = makeChunkExecutive()
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine as any )

    const got: string[] = []
    const unsub = engine.addChunkCallback( ( _e, _t, c ) => got.push( c ) )
    engine.addChunkCallback( () => {} )            // keep size > 0 so the pipe registers
    await engine.ingest( text('hi') )

    unsub()
    exec.drive('[REPLY_TEXT]nope[/REPLY_TEXT]')
    expect( got ).toEqual( [] )
  } )
} )

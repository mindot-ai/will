// ─────────────────────────────────────────────────────────────
// tests/integration/audition.reply.reliability.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Done-criterion (b) of .TODO/AUDITION_REPLY_DETERMINISM.md: a mock Will
 * RELIABLY replies to a direct message within a bounded tick budget —
 * regardless of phrasing (greeting vs instruction) and of registered
 * effectors (the original flake's sensitivities).
 *
 * Deliberately does NOT force recall off via env: with a dev .env auto-loaded
 * (WILL_SEMANTIC_RECALL=true + a live embedding key) this test doubles as the
 * end-to-end sentinel for the testMode network-embedder guard in
 * _resolveVectorMemory — if the guard regresses, live embeds return, reply
 * latency blows past the budget, and this fails loudly.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { Will } from '#sdk/will'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
afterAll( () => resetLogger() )

/** Generous CI budget; the healthy path replies ~1 tick after ingest. */
const REPLY_BUDGET_TICKS = 60
const WAIT_MS            = 8_000

async function replyLatency( message: string, withEffector: boolean ): Promise<{ replied: boolean; latency: number }> {
  const will = await Will.create( {
    name: 'Echo', identity: { prompt: 'I am Echo, a friendly presence.' },
    llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 7,
    ...( withEffector ? { effectors: { remember_note: { handler: async () => 'ok', description: 'Store a note' } } } : {} ),
  } )
  try {
    let replyTick = -1
    const done = new Promise<void>( resolve => {
      will.stem.addTickListener( will.id, ( _s, tick, outbox ) => {
        if( replyTick < 0 && outbox.length > 0 ){ replyTick = tick; resolve() }
      } )
    } )

    while( will.state().tick < 30 ) await new Promise( r => setTimeout( r, 5 ) )
    const ingestTick = will.state().tick
    await will.tell( 'sam', 'Sam', message )
    await Promise.race( [ done, new Promise( r => setTimeout( r, WAIT_MS ) ) ] )

    return { replied: replyTick >= 0, latency: replyTick >= 0 ? replyTick - ingestTick : -1 }
  }
  finally { await will.stop() }
}

describe( 'Audition reply reliability (mock, bounded tick budget)', () => {
  it( 'replies to a greeting within budget', async () => {
    const r = await replyLatency( 'Hello, who are you?', false )
    expect( r.replied ).toBe( true )
    expect( r.latency ).toBeLessThanOrEqual( REPLY_BUDGET_TICKS )
  }, 30_000 )

  it( 'replies to instruction-shaped phrasing within budget (the original suppressor)', async () => {
    const r = await replyLatency( 'Please remember that my favorite color is blue.', false )
    expect( r.replied ).toBe( true )
    expect( r.latency ).toBeLessThanOrEqual( REPLY_BUDGET_TICKS )
  }, 30_000 )

  it( 'replies with a custom effector registered within budget (the original starver)', async () => {
    const r = await replyLatency( 'Hello, who are you?', true )
    expect( r.replied ).toBe( true )
    expect( r.latency ).toBeLessThanOrEqual( REPLY_BUDGET_TICKS )
  }, 30_000 )
} )

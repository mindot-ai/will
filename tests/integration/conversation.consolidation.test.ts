// ─────────────────────────────────────────────────────────────
// tests/integration/conversation.consolidation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §7.2 — conversation turns consolidated to episodic + embedded (mock embedder).
 *
 * The full §5 memory pipeline, end to end:
 *   AuditionEngine exchange → working_memory.item (conversation.exchange) via the
 *   memory sink → EpisodicConsolidator scans it on its tick → episode in the store
 *   → indexed into the vector adapter (MockEmbedder) → recallable via semanticQuery.
 *
 * This closes the integration gap left by the unit tests, which stop at the
 * working_memory.item shape and never run the consolidator/vector leg.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine }            from '#senses/audition.engine/engine'
import { createTestBus }             from '#cognition/bus'
import { EpisodicConsolidator }      from '#faculties/episodic.consolidator'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder }              from '#memory/vector.embedder'
import type { TextMessage }          from '#senses/index'

/** Executive whose facet fires a canned decision synchronously on report(). */
function syncExecutive( reply: string ){
  return {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      const handle = {
        facetId: 'f1',
        report(){
          sub?.({
            decision: { reply, replyBubbles: [ reply ], targetEntityId: 'alice', requiresMasterAttention: false },
            reasoning: '',
            confidence: 0.9,
          })
        },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus(){}, setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }
}

/** Produce the working_memory.item entity the AuditionEngine emits for one exchange. */
async function captureExchangeEntity( inbound: string, reply: string ): Promise<any> {
  const captured: any[] = []
  const engine = new AuditionEngine()
  engine.attachBus( createTestBus() )
  engine.attachExecutiveEngine( syncExecutive( reply ) as any )
  engine.attachMemorySink( e => captured.push( e ) )

  const msg: TextMessage = { kind: 'text', entityId: 'alice', threadId: 't1', content: inbound }
  await engine.ingest( msg )

  expect( captured ).toHaveLength( 1 )
  expect( captured[0].metadata.wmType ).toBe( 'conversation.exchange' )
  return captured[0]
}

function makeState( entities: Map<string, any> ){
  return { tick: 1, time: 1000, metrics: new Map<string, number>(), entities } as any
}

/** Pure in-memory storage so the adapter never touches Bun's filesystem. */
const memStorage = {
  async write(){}, async read(){ return '' }, async readBytes(){ return new Uint8Array() },
  async exists(){ return false }, async delete(){},
}

/** In-memory vector adapter (no disk persistence, deterministic mock embedder). */
function makeAdapter(){
  return new DefaultVectorMemoryAdapter(
    new MockEmbedder( 42 ),
    { dimensions: 128, minSimilarity: 0, seed: 42 },
    memStorage as any,
  )
}

describe( 'conversation → episodic + embedded (§7.2)', () => {
  it( 'consolidates a conversation.exchange WM item into an embedded, recallable episode', async () => {
    const adapter = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    // 1. AuditionEngine produces the exchange WM item …
    const entity = await captureExchangeEntity( 'hello there', 'Mock reply' )

    // 2. … which the consolidator scans on its tick (state carries the WM item).
    const entities = new Map<string, any>( [ [ entity.id, entity ] ] )
    await consolidator.react( 0 as any, 1 as any, makeState( entities ), {} as any )

    // 3. Episode landed in the store, tagged as a confirmed conversation exchange.
    const episodes = consolidator.getAllEpisodes()
    expect( episodes ).toHaveLength( 1 )
    expect( episodes[0]!.sourceType ).toBe( 'conversation.exchange' )
    expect( episodes[0]!.outcomeStatus ).toBe( 'confirmed' )

    // 4. Episode was embedded into the vector index (the "embedded" leg).
    expect( adapter.size ).toBe( 1 )

    // 5. Recallable via the vector path. minSimilarity:-1 isolates the test from
    //    the MockEmbedder's similarity geometry — we assert reachability + payload,
    //    not the hash embedder's semantic quality.
    const recalled = await consolidator.semanticQuery( 'hello there', { minSimilarity: -1, limit: 5 } )
    expect( recalled.length ).toBeGreaterThanOrEqual( 1 )

    const summary = ( recalled[0]!.content as any ).summary as string
    expect( summary ).toContain( 'hello there' )   // inbound preserved through the pipeline
    expect( summary ).toContain( 'Mock reply' )    // reply preserved through the pipeline
  } )

  it( 'does not consolidate a duplicate of an already-stored exchange (dedup)', async () => {
    const adapter = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    const entity = await captureExchangeEntity( 'hello there', 'Mock reply' )
    const entities = new Map<string, any>( [ [ entity.id, entity ] ] )

    // Same entity present across two ticks — the consolidator's content-hash dedup
    // must not double-store it.
    await consolidator.react( 0 as any, 1 as any, makeState( entities ), {} as any )
    await consolidator.react( 0 as any, 2 as any, makeState( entities ), {} as any )

    expect( consolidator.getAllEpisodes() ).toHaveLength( 1 )
    expect( adapter.size ).toBe( 1 )
  } )
} )

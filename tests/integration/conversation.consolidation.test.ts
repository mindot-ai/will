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
import { DefaultStateManager }       from '#core/state.manager'
import { WorkingMemory }             from '#faculties/working.memory'

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

  const msg: TextMessage = { kind: 'text', entityId: 'alice', threadId: 't1', content: inbound, provenance: 'exafferent' }
  await engine.ingest( msg )

  // The sink also receives the inbound social signal (conversation.received);
  // the exchange is the working_memory.item among them.
  const exchanges = captured.filter( e => e.type === 'working_memory.item')
  expect( exchanges ).toHaveLength( 1 )
  expect( exchanges[0].metadata.wmType ).toBe('conversation.exchange')
  return exchanges[0]
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

describe('conversation → episodic, through the REAL memory sink', () => {
  /**
   * The test below this one hand-places the exchange entity into a plain state map,
   * so it verifies audition → consolidator → vector → recall while skipping the one
   * hop production actually uses: `attachMemorySink( e => stateManager.setEntity(e) )`
   * (mind.ts), which runs OFF-TICK. This closes that gap with a real DefaultStateManager.
   *
   * Live symptom being chased: a mind replied to a message and, two minutes and ~117
   * ticks later, its own prompt still read "No relevant memories" — with no
   * `lastConversationDigest` in the artifact at hibernation.
   */
  it('lands the exchange in live state off-tick, and consolidates from there', async () => {
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )

    const adapter      = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive('Sure — whenever works for you.') as any )
    engine.attachMemorySink( e => sm.setEntity( e ) )        // the production wiring

    await engine.ingest( {
      kind: 'text', entityId: 'alice', threadId: 't1',
      content: 'Not ready to talk now. Can we connect later?',
    } as TextMessage )

    // 1. The sink's off-tick write is visible in live state.
    const wm = [ ...sm.snapshot().entities.values() ].filter( ( e: any ) => e.type === 'working_memory.item')
    expect( wm ).toHaveLength( 1 )

    // 2. The consolidator, reading that state on a later tick, consolidates it.
    sm.updateClock( 2 as any, 2000 as any )
    await consolidator.react( 0 as any, 2 as any, sm.snapshot() as any, {} as any )
    await consolidator.flushIndexing()

    const episodes = consolidator.getAllEpisodes()
    expect( episodes ).toHaveLength( 1 )
    expect( episodes[0]!.sourceType ).toBe('conversation.exchange')

    // 3. And it is recallable — the thing the live mind could not do.
    const recalled = await consolidator.semanticQuery('connect later', { minSimilarity: -1, limit: 5 } )
    expect( recalled.length ).toBeGreaterThanOrEqual( 1 )
    expect( ( recalled[0]!.content as any ).summary ).toContain('connect later')
  } )

  it('a foreign WM write is consolidated on the same snapshot that reaps it', async () => {
    // Two writers own `working_memory.item`: WorkingMemory mirrors its internal
    // `_items` (always `wm-item-*`), while audition's sink (`wm-exchange-*`) and the
    // PlanningEngine (`wm-plan-*`) write straight to state. WorkingMemory reaps any
    // entity of that type it does not hold, which LOOKS like it would eat a foreign
    // write before anything could read it.
    //
    // It cannot, and this test pins why: the orchestrator hands every engine ONE
    // frozen snapshot per tick and applies all commands only after the last engine
    // returns. So the consolidator and the reaper see the same item on the same tick —
    // consolidation wins, the delete lands afterwards. That ordering is exactly the GC
    // the PlanningEngine documents itself as relying on ("The WorkingMemory faculty GCs
    // the item after consolidation, so it doesn't accrete"). Narrowing the sweep to
    // `wm-item-*` would break that and make plan descriptors accrete forever.
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )

    const adapter      = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive('Sure — whenever works for you.') as any )
    engine.attachMemorySink( e => sm.setEntity( e ) )

    await engine.ingest( {
      kind: 'text', entityId: 'alice', threadId: 't1',
      content: 'Not ready to talk now. Can we connect later?',
    } as TextMessage )

    const exchangeId = [ ...sm.snapshot().entities.values() ]
      .find( ( e: any ) => e.type === 'working_memory.item')!.id as string

    // One tick, one snapshot, both engines reading it — as the orchestrator does.
    sm.updateClock( 2 as any, 2000 as any )
    const shared = sm.snapshot() as any

    await consolidator.react( 0 as any, 2 as any, shared, {} as any )
    const res = await new WorkingMemory().react( 0 as any, 2 as any, shared, {} as any )

    // The reaper does queue the delete — and the episode already exists.
    expect( res.commands?.delete ?? [] ).toContain( exchangeId )
    expect( consolidator.getAllEpisodes() ).toHaveLength( 1 )
    expect( consolidator.getAllEpisodes()[0]!.sourceType ).toBe('conversation.exchange')
  } )
} )

describe('conversation → episodic + embedded (§7.2)', () => {
  it('consolidates a conversation.exchange WM item into an embedded, recallable episode', async () => {
    const adapter = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    // 1. AuditionEngine produces the exchange WM item …
    const entity = await captureExchangeEntity('hello there', 'Mock reply')

    // 2. … which the consolidator scans on its tick (state carries the WM item).
    const entities = new Map<string, any>( [ [ entity.id, entity ] ] )
    await consolidator.react( 0 as any, 1 as any, makeState( entities ), {} as any )
    await consolidator.flushIndexing()   // indexing is background now (#tick-stall fix)

    // 3. Episode landed in the store, tagged as a confirmed conversation exchange.
    const episodes = consolidator.getAllEpisodes()
    expect( episodes ).toHaveLength( 1 )
    expect( episodes[0]!.sourceType ).toBe('conversation.exchange')
    expect( episodes[0]!.outcomeStatus ).toBe('confirmed')

    // 4. Episode was embedded into the vector index (the "embedded" leg).
    expect( adapter.size ).toBe( 1 )

    // 5. Recallable via the vector path. minSimilarity:-1 isolates the test from
    //    the MockEmbedder's similarity geometry — we assert reachability + payload,
    //    not the hash embedder's semantic quality.
    const recalled = await consolidator.semanticQuery('hello there', { minSimilarity: -1, limit: 5 } )
    expect( recalled.length ).toBeGreaterThanOrEqual( 1 )

    const summary = ( recalled[0]!.content as any ).summary as string
    expect( summary ).toContain('hello there')   // inbound preserved through the pipeline
    expect( summary ).toContain('Mock reply')    // reply preserved through the pipeline
  } )

  it('does not consolidate a duplicate of an already-stored exchange (dedup)', async () => {
    const adapter = makeAdapter()
    const consolidator = new EpisodicConsolidator( { vectorMemory: adapter, embedder: new MockEmbedder( 42 ) } )

    const entity = await captureExchangeEntity('hello there', 'Mock reply')
    const entities = new Map<string, any>( [ [ entity.id, entity ] ] )

    // Same entity present across two ticks — the consolidator's content-hash dedup
    // must not double-store it.
    await consolidator.react( 0 as any, 1 as any, makeState( entities ), {} as any )
    await consolidator.flushIndexing()   // indexing is background now (#tick-stall fix)
    await consolidator.react( 0 as any, 2 as any, makeState( entities ), {} as any )

    expect( consolidator.getAllEpisodes() ).toHaveLength( 1 )
    expect( adapter.size ).toBe( 1 )
  } )
} )

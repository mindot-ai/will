// ─────────────────────────────────────────────────────────────
// tests/unit/audition.digest-hydration.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §5.4 — hydrate the thread digest from episodic recall on cold facet spawn.
 *
 * On the FIRST turn for an entity (no facet yet, empty thread digest) the engine
 * seeds the digest from recall so the very first reply already carries recent-
 * conversation context. Subsequent turns (facet now live) never re-query recall,
 * and recall failure is non-fatal.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine, ThreadDigestManager } from '#senses/audition.engine/engine'
import { createTestBus }  from '#cognition/bus'
import type { TextMessage } from '#senses/index'

function syncExecutive( onFocus?: ( f: any ) => void ){
  return {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      const handle = {
        facetId: 'f1',
        report(){
          sub?.({
            decision: { reply: 'ok', replyBubbles: [ 'ok' ], targetEntityId: 'alice', requiresMasterAttention: false },
            reasoning: '', confidence: 0.9,
          })
        },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus( f: any ){ onFocus?.( f ) },
        setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }
}

const text = ( content: string, threadId = 't1' ): TextMessage =>
  ( { kind: 'text', entityId: 'alice', threadId, content } )

// The engine seeds a cold-spawn digest via EpisodicConsolidator.semanticQuery,
// mapping each resolved episode's `content.summary` into a digest line. This adapter
// wraps a simple (query, limit) → summaries recall fn in that consolidator shape, so
// these tests stay focused on §5.4 hydration behaviour rather than the vector-store
// plumbing. A throwing recall surfaces as a rejected semanticQuery — exercised below.
const recallConsolidator = (
  recall: ( query: string, limit: number ) => Promise<string[]>,
) => ( {
  async semanticQuery( query: string, filters?: { limit?: number } ){
    const summaries = await recall( query, filters?.limit ?? ThreadDigestManager.MAX_TURNS )
    return summaries.map( summary => ( { content: { summary } } ) )
  },
} )

describe( 'AuditionEngine — cold-spawn digest hydration (§5.4)', () => {
  it( 'seeds an empty thread digest from recall, surfaced in the first focus', async () => {
    const calls: Array<{ query: string; limit: number }> = []
    const focuses: any[] = []

    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive( f => focuses.push( f ) ) as any )
    engine.attachEpisodicConsolidator( recallConsolidator( async ( query, limit ) => {
      calls.push( { query, limit } )
      return [ 'alice: "where were we?" → "we were planning the trip"' ]
    } ) as any )

    await engine.ingest( text( 'remind me what we discussed' ) )

    // Recall was queried with the live message and the digest cap.
    expect( calls ).toEqual( [ { query: 'remind me what we discussed', limit: ThreadDigestManager.MAX_TURNS } ] )
    // The recalled prior exchange reached the facet focus via the seeded digest.
    expect( focuses ).toHaveLength( 1 )
    expect( focuses[0].content ).toContain( 'planning the trip' )
  } )

  it( 'does NOT re-query recall once the facet is live (only cold spawn)', async () => {
    let recallCount = 0
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    engine.attachEpisodicConsolidator( recallConsolidator( async () => { recallCount++; return [ 'alice: "x" → "y"' ] } ) as any )

    await engine.ingest( text( 'first' ) )
    await engine.ingest( text( 'second' ) )

    expect( recallCount ).toBe( 1 )   // cold spawn only
  } )

  it( 'recall failure is non-fatal — the turn still completes', async () => {
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    engine.attachEpisodicConsolidator( recallConsolidator( async () => { throw new Error( 'vector down' ) } ) as any )

    await expect( engine.ingest( text( 'hi' ) ) ).resolves.toBeUndefined()
  } )

  it( 'no recall attached → cold spawn proceeds with an empty digest', async () => {
    const focuses: any[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive( f => focuses.push( f ) ) as any )

    await engine.ingest( text( 'hello' ) )

    expect( focuses ).toHaveLength( 1 )
    // No prior turns and nothing recalled → no thread-digest block in the focus.
    expect( focuses[0].content ).not.toContain( '[Thread' )
  } )
} )

describe( 'ThreadDigestManager.hydrate — never clobbers a live digest', () => {
  it( 'seeds an empty thread but leaves a populated one untouched', () => {
    const d = new ThreadDigestManager()

    d.hydrate( 'empty', [ 'recalled line A', 'recalled line B' ] )
    expect( d.getDigest( 'empty' ) ).toContain( 'recalled line A' )

    d.append( 'live', 'user', 'real turn' )
    d.hydrate( 'live', [ 'should not appear' ] )
    expect( d.getDigest( 'live' ) ).toContain( 'real turn' )
    expect( d.getDigest( 'live' ) ).not.toContain( 'should not appear' )
  } )

  it( 'caps the seed to MAX_TURNS (keeps the most recent)', () => {
    const d = new ThreadDigestManager()
    const many = Array.from( { length: ThreadDigestManager.MAX_TURNS + 3 }, ( _v, i ) => `line-${i}` )
    d.hydrate( 'cap', many )
    const digest = d.getDigest( 'cap' )
    expect( digest ).toContain( `line-${ThreadDigestManager.MAX_TURNS + 2}` )   // last kept
    expect( digest ).not.toContain( 'line-0' )                                  // oldest dropped
  } )
} )

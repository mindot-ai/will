// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p5e.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P5e — what she read is recallable by meaning, a page at a time.
 *
 * An observation episode was embedded by its label — `list_pull_requests: [{…`,
 * at most a hundred characters — so semantic recall could find that she had read
 * a listing, never the part of it that answered. Its data was whole in the store
 * and unreachable by meaning.
 *
 * Now every page of what an observation held is embedded too (`<episode>#<page>`,
 * split into pieces where a page is longer than the embedder takes — never cut),
 * a search maps a page's hit back to its episode and says which page it was, and
 * the memory she is shown names that page as the way in. Forgetting the episode
 * forgets its pages, including ones still being embedded (P3a's in-flight cancel).
 */

import { describe, it, expect } from 'vitest'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder, OpenAICompatibleEmbedder, type EmbeddingProvider } from '#memory/vector.embedder'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { paginate, itemText, callView, PAGE_TOKENS } from '#faculties/executive.engine/view'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { buildExecutiveContext } from '#faculties/executive.engine/context'
import type { StorageAdapter } from '#core/abstracts'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

class MemStorage implements StorageAdapter {
  private _files = new Map<string, string | Uint8Array>()
  async write( path: string, content: string | Uint8Array ): Promise<void> { this._files.set( path, content ) }
  async read( path: string ): Promise<string> { const v = this._files.get( path ); if( v == null ) throw new Error('nf'); return typeof v === 'string' ? v : new TextDecoder().decode( v ) }
  async readBytes( path: string ): Promise<Uint8Array> { const v = this._files.get( path ); if( v == null ) throw new Error('nf'); return typeof v === 'string' ? new TextEncoder().encode( v ) : v }
  async exists( path: string ): Promise<boolean> { return this._files.has( path ) }
}

/** A listing three pages long, as an MCP tool hands it back. */
const LISTING = Array.from( { length: 90 }, ( _, i ) => ( { number: 400 + i, title: `PR ${ 400 + i }`,
  body: `Moves ledger writer ${ i } behind the schema review. `.repeat( 22 ) } ) )
const PAGES = paginate( itemText( LISTING ), PAGE_TOKENS )

/** An observation remembered — as working memory hands it to the consolidator. */
function observation( id: string ): EpisodicMemory {
  return { id, timestamp: 3, createdAt: 3, emotionalTags: {}, affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength: 0.8, retrievalCount: 0, lastRetrievedAt: null, tags: [ 'percept' ], sourceType: 'percept',
    content: { wmType: 'percept', content: { summary: 'list_pull_requests: [{"number":400…', entityId: 'percept-77', data: LISTING } } } as EpisodicMemory
}

/** Jina's limit. */
const jina = (): EmbeddingProvider => Object.assign( new MockEmbedder( 7 ), { maxInputTokens: 8_192 } )
/** The pieces a page is embedded in, under an input limit — three-quarters of it, by the estimate. */
const piecesOf = ( limit: number ) => PAGES.map( p => paginate( p, Math.floor( limit * 0.75 ) ) )
const vectorsFor = ( limit: number ) => 1 + piecesOf( limit ).flat().length
const adapter = ( e: EmbeddingProvider = jina(), storage: StorageAdapter = new MemStorage() ) =>
  new DefaultVectorMemoryAdapter( e, { dimensions: 128, persistPath: 'idx' }, storage )

describe('every page of what she read is embedded', () => {
  it('the label and each page — and a page search names the episode and the page', async () => {
    expect( PAGES.length ).toBeGreaterThan( 2 )
    const a = adapter()
    await a.index( observation('episodic-3-0'), observation('episodic-3-0').content )
    expect( a.size ).toBe( vectorsFor( 8_192 ) )
    const hits = await a.search( piecesOf( 8_192 )[1]![0]! )
    expect( hits[0] ).toMatchObject( { episodeId: 'episodic-3-0', page: 2 } )
    expect( hits.filter( h => h.episodeId === 'episodic-3-0') ).toHaveLength( 1 )
  } )

  it('a page longer than the embedder takes is split into pieces — every one embedded, none cut', async () => {
    const a = adapter( new MockEmbedder( 7 ) )                     // no stated limit: 2,048
    await a.index( observation('episodic-3-0'), observation('episodic-3-0').content )
    const pieces = piecesOf( 2_048 )
    expect( pieces[2]!.length ).toBeGreaterThan( 1 )
    expect( a.size ).toBe( vectorsFor( 2_048 ) )
    expect( pieces.flat().join('') ).toBe( itemText( LISTING ) )   // the pieces are the whole, nothing cut
    expect( ( await a.search( pieces[2]![1]! ) )[0] ).toMatchObject( { episodeId: 'episodic-3-0', page: 3 } )
  } )

  it('anything that held no data is embedded as before — its label alone', async () => {
    const a = adapter()
    const talk = { ...observation('episodic-4-0'), content: { wmType: 'conversation.exchange', summary: 'Ada: "hi" → "hello"' } }
    await a.index( talk as EpisodicMemory, talk.content )
    expect( a.size ).toBe( 1 )
  } )

  it('the embedder knows its limit — by model, or as the host says', () => {
    const e = ( modelName: string, maxInputTokens?: number ) =>
      new OpenAICompatibleEmbedder( { modelName, dimensions: 8, apiUrl: 'http://x', ...( maxInputTokens ? { maxInputTokens } : {} ) } ).maxInputTokens
    expect( e('jina-embeddings-v3') ).toBe( 8_192 )
    expect( e('text-embedding-3-small') ).toBe( 8_191 )
    expect( e('gemini-embedding-001') ).toBe( 2_048 )
    expect( e('my-model') ).toBeUndefined()
    expect( e('my-model', 512 ) ).toBe( 512 )
  } )
} )

describe('forgetting an episode forgets its pages', () => {
  it('delete takes every page vector with it', async () => {
    const a = adapter()
    await a.index( observation('episodic-3-0'), observation('episodic-3-0').content )
    await a.delete('episodic-3-0')
    expect( a.size ).toBe( 0 )
  } )

  it('forgotten while its pages were being embedded: none of them lands', async () => {
    let release!: () => void
    const gate = new Promise<void>( r => { release = r } )
    const slow = Object.assign( new MockEmbedder( 7 ), { maxInputTokens: 8_192 } )
    const batch = slow.embedBatch.bind( slow )
    slow.embedBatch = async ( c: unknown[] ) => { await gate; return batch( c ) }
    const a = adapter( slow )
    const indexing = a.index( observation('episodic-3-0'), observation('episodic-3-0').content )
    await a.delete('episodic-3-0')
    release()
    await indexing
    expect( a.size ).toBe( 0 )
  } )

  it('after a restart too — the pages are known by their episode on load', async () => {
    const storage = new MemStorage()
    const a1 = adapter( jina(), storage )
    await a1.index( observation('episodic-3-0'), observation('episodic-3-0').content )
    await a1.persist()
    const a2 = adapter( jina(), storage )
    await a2.load()
    expect( a2.size ).toBe( vectorsFor( 8_192 ) )
    await a2.delete('episodic-3-0')
    expect( a2.size ).toBe( 0 )
  } )
} )

describe('recall finds the page that answers — and says so', () => {
  it('the consolidator hands back the episode, marked with the page; no page vector is taken for a dead one', async () => {
    const vectors = adapter()
    const memory = new EpisodicConsolidator( { vectorMemory: vectors } )
    const ep = observation('episodic-3-0')
    memory.restoreEpisodes( [ ep ] )
    await vectors.index( ep, ep.content )
    const found = await memory.semanticQuery( piecesOf( 8_192 )[2]![0]!, { limit: 3 } )
    expect( found[0] ).toMatchObject( { id: 'episodic-3-0', matchedPage: 3 } )
    expect( vectors.size ).toBe( vectorsFor( 8_192 ) )              // nothing let go as "dead"
  } )

  it('the memory she is shown names that page as the way in', async () => {
    const ep = { ...observation('episodic-3-0'), matchedPage: 3 }
    const store = { semanticQuery: async () => [ ep ], query: () => [], getAllEpisodes: () => [ ep ], markRetrieved(){} }
    const state = { tick: 9, entities: new Map(), metrics: new Map() } as never
    const context = await buildExecutiveContext( state, { workingMemory: null, goalManager: null, episodicConsolidator: store as never, semanticIntegrator: null } )
    expect( context.memories[0] ).toMatchObject( { handle: 'percept-77', matchedPage: 3 } )
    const prompt = buildUserMessage( { context: context as ExecutiveContext, state, qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null }, focus: { title: 'T', content: 'c' }, mode: 'master', view: callView( 203_000, 8_096, 's') } as never )
    expect( prompt ).toContain('pages · doc:percept-77 — whole in memory, not shown here; page 3 is the part that brought it to mind: {"recall": [{"doc": "percept-77", "page": 3}]}]')
  } )
} )

describe('a conversation digest says how much of the thread it shows', () => {
  it('the last five, how many came before, and where they are', async () => {
    const { ThreadDigestManager } = await import('#senses/audition.engine/engine')
    const d = new ThreadDigestManager()
    for( let i = 0; i < 8; i++ ) d.append( 't1', i % 2 ? 'will' : 'user', `turn ${ i }` )
    expect( d.getDigest('t1') ).toMatch( /^\[Thread — last 5 turns; 3 earlier turns are in my memories — \{"recall": \[\{"section": "memories", "query": "…"}\]\}\]\nwill: turn 3/ )
    d.append( 't2', 'user', 'only' )
    expect( d.getDigest('t2') ).toBe('[Thread — last 1 turn]\nuser: only')
  } )
} )

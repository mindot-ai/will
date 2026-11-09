// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p5d.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P5d — a file someone hands over is its own item, whole.
 *
 * A shared document was inlined into the message text — up to 24,000 characters,
 * four files a message, 256 KB fetched — and from there it rode everywhere the
 * words go: the conversation focus, the thread digest, every "they answered" line,
 * conversation memory. Lifting the caps alone would have put a 2 MB document in
 * all of them.
 *
 * Now the channel reads each file whole (or names it, and says why not), and the
 * mind lays each one down as its own percept, its text the percept's data. The
 * words carry a reference — `[Ada shared spec.md (…) — doc:…]` — and P5a's view
 * pages the file: a header and a page in a call, any page by `[RECALL]`, the
 * pages rejoining to the file byte for byte.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import { createTestBus } from '#cognition/bus'
import { buildExecutiveContext, resolveBroughtBack } from '#faculties/executive.engine/context'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { callView, paginate, itemText, renderBroughtBack, PAGE_TOKENS } from '#faculties/executive.engine/view'
import { Will } from '#surface/sdk/will'
import { setLogger, resetLogger } from '#core/logger'
import type { SharedFile, TextMessage } from '#senses/index'

afterEach( () => resetLogger() )

/** A ~100k-token spec, the kind Discord makes of a long paste. */
const SPEC = '# Payments migration\n' + Array.from( { length: 3_000 }, ( _, i ) =>
  `- Step ${ i }: move ledger writer ${ i } behind the schema review, then dry-run it.` ).join('\n')

/** An executive whose facet decides at once, and shows us the focus it was given. */
function executive( focus: string[] ){
  return {
    spawnFacet(){
      let sub: (( d: unknown ) => void) | null = null
      return { attention: 'available' as const, handle: {
        facetId: 'f1',
        report(){ sub?.( { decision: { reply: 'Got it.', replyBubbles: [ 'Got it.' ], targetEntityId: 'ke:ada', requiresMasterAttention: false }, reasoning: '', confidence: 0.9 } ) },
        subscribe( fn: ( d: unknown ) => void ){ sub = fn; return () => { sub = null } },
        setFocus( f: { content: string } ){ focus.push( f.content ) },
        setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      } }
    },
  }
}

function hearing(){
  const state = new Map<string, { id: string; type: string; metadata: Record<string, unknown> }>()
  const focus: string[] = []
  const memory: Array<{ type: string; metadata: Record<string, unknown> }> = []
  const ear = new AuditionEngine()
  ear.attachBus( createTestBus() )
  ear.attachExecutiveEngine( executive( focus ) as never )
  ear.attachMemorySink( e => memory.push( e as never ) )
  ear.attachPerceptTrace( e => state.set( e.id, e as never ), () => 9 )
  const say = ( content: string, attachments: SharedFile[] ) =>
    ear.sense( { kind: 'text', entityId: 'ke:ada', threadId: 't1', content, speakerName: 'Ada', provenance: 'exafferent', attachments } as TextMessage )
  return { say, state, focus, memory }
}

describe('a shared file is its own percept, whole', () => {
  it('laid down with the file as its data — exafferent, from who shared it', async () => {
    const h = hearing()
    await h.say('here is the spec', [ { name: 'spec.md', contentType: 'text/markdown', size: SPEC.length, text: SPEC } ] )
    const files = [ ...h.state.values() ].filter( e => e.type === 'percept')
    expect( files ).toHaveLength( 1 )
    expect( files[0]!.metadata ).toMatchObject( { data: SPEC, provenance: 'exafferent', entityId: 'ke:ada', tick: 9,
      summary: `Ada shared spec.md (text/markdown, ${ ( SPEC.length / 1024 ).toFixed( 1 ) } KB)` } )
  } )

  it('the words carry a reference, not the file — in the focus, and in what she remembers of the conversation', async () => {
    const h = hearing()
    await h.say('here is the spec', [ { name: 'spec.md', contentType: 'text/markdown', size: SPEC.length, text: SPEC } ] )
    const id = [ ...h.state.keys() ][0]!
    const ref = `[Ada shared spec.md (text/markdown, ${ ( SPEC.length / 1024 ).toFixed( 1 ) } KB) — doc:${ id }; a document I was handed, not something said to me]`
    expect( h.focus.join('\n') ).toContain(`here is the spec\n${ ref }`)
    expect( h.focus.join('\n') ).not.toContain('Step 2999')
    const exchange = h.memory.find( e => e.metadata['wmType'] === 'conversation.exchange')!
    expect( exchange.metadata['userMessage'] ).toBe(`here is the spec\n${ ref }`)
  } )

  it('a file she was not given to read is named, with why — and lays nothing down', async () => {
    const h = hearing()
    await h.say('', [ { name: 'huge.log', contentType: 'text/plain', size: 30 * 1024 * 1024, unread: 'it is larger than the 20 MB I read' } ] )
    expect( [ ...h.state.values() ] ).toHaveLength( 0 )
    expect( h.focus.join('\n') ).toContain('[Ada shared a file I have not read: huge.log (text/plain, 30.0 MB) — it is larger than the 20 MB I read]')
  } )

  it('every file of a message — and two files are two percepts', async () => {
    const h = hearing()
    await h.say('two', [ { name: 'a.md', text: 'alpha' }, { name: 'b.md', text: 'beta' } ] )
    expect( [ ...h.state.values() ].map( e => e.metadata['data'] ).sort() ).toEqual( [ 'alpha', 'beta' ] )
  } )
} )

describe('a call shows it as a document; every page is reachable', () => {
  it('a header and its first page in view; page 2 brought back; the pages rejoin to the file', async () => {
    const h = hearing()
    await h.say('here is the spec', [ { name: 'spec.md', contentType: 'text/markdown', size: SPEC.length, text: SPEC } ] )
    const state = { tick: 10, metrics: new Map(), entities: h.state } as never
    const deps = { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null }
    const context = await buildExecutiveContext( state, deps )
    const id = [ ...h.state.keys() ][0]!
    const pages = paginate( itemText( SPEC ), PAGE_TOKENS )
    expect( pages.length ).toBeGreaterThan( 2 )

    const prompt = buildUserMessage( { context, state, qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master', view: callView( 203_000, 8_096, 'system') } as never )
    expect( prompt ).toContain(`pages · doc:${ id } — page 1 of ${ pages.length } below`)
    expect( prompt.split( pages[1]! ) ).toHaveLength( 1 )

    const read = ( page: number ) => renderBroughtBack( resolveBroughtBack( [ { doc: id, page } ], state, deps ), 1e9 )
    expect( read( 2 ) ).toContain(`page 2 of ${ pages.length }:\n${ pages[1] }`)
    expect( pages.join('') ).toBe( SPEC )
  } )
} )

describe('the SDK hands the files to the mind', () => {
  it('`sense` carries them through, untouched', async () => {
    setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never )
    const will = await Will.create( { llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 3, name: 'Files', identity: { prompt: 'I read what I am handed.' } } )
    try {
      const got: unknown[] = []
      ;( will.stem as unknown as Record<string, unknown> )['senseText'] = async ( _id: string, input: unknown ) => { got.push( input ) }
      const files: SharedFile[] = [ { name: 'spec.md', text: SPEC } ]
      await will.sense( { text: 'here', from: 'discord:U1', speaker: 'Ada', provenance: 'exafferent', attachments: files } )
      expect( got[0] ).toMatchObject( { kind: 'text', content: 'here', attachments: files } )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

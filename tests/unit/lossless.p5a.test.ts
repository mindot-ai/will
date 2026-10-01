// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p5a.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P5a — every call fits its window, and nothing leaves a call silently.
 *
 * P2 made what an act brings back whole, and it reached every prompt whole: an
 * MCP tool's output becomes a percept's data and a working-memory item's, and the
 * prompt rendered it — twice while the percept lived. One 30-PR listing is ~135k
 * tokens; GLM-5.2's default window is ~203k. Lora's second self holds six GitHub
 * read tools.
 *
 * Now an item larger than a page is a document: a header, a page and a handle,
 * the rest reachable whole through `[RECALL]` — never cut. Every call is built
 * against the window of the model it will be routed to, and tightens rather than
 * failing when it would not fit.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { ExecutiveFacet } from '#faculties/executive.engine/facet'
import { createTestBus } from '#cognition/bus'
import { LLMDirector } from '#llm/index'
import { parseResponse } from '#faculties/executive.engine/parser'
import { perceptLine, buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { resolveBroughtBack, buildExecutiveContext } from '#faculties/executive.engine/context'
import {
  estimateTokens, paginate, itemText, callView, fitToBudget, renderBroughtBack,
  DEFAULT_CONTEXT_WINDOW, PAGE_TOKENS,
} from '#faculties/executive.engine/view'
import { WorkingMemory } from '#faculties/working.memory'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import { setLogger, resetLogger } from '#core/logger'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutiveContext } from '#faculties/executive.engine/types'
import type { ReadonlySimulationState } from '#core/types'

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch; resetLogger() } )
const quiet = () => setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never )
const ctx = createContext('sim', 'run', 42 )

/** A 30-PR listing as GitHub's MCP server hands it back: ~135k tokens. */
const LISTING = Array.from( { length: 30 }, ( _, i ) => ( {
  number: 400 + i, title: `PR ${ 400 + i }: payments migration step ${ i }`, state: 'open', user: { login: 'fkem' },
  body: `Moves the ledger writer behind the schema review (part ${ i }). `.repeat( 220 ),
} ) )

describe('the item is whole, and paged', () => {
  it('the listing really is the size that breaks a call', () => {
    expect( estimateTokens( JSON.stringify( LISTING ) ) ).toBeGreaterThan( 120_000 )
  } )

  it('pages rejoin to the whole, byte for byte — strings, arrays, one long line, multibyte', () => {
    const long = 'é,'.repeat( 40_000 ) + 'ünïcödé'
    for( const data of [ LISTING, JSON.stringify( LISTING ), long, { a: long, b: [ 1, 2 ] } ] ){
      const text  = itemText( data )
      const pages = paginate( text, PAGE_TOKENS )
      expect( pages.join('') ).toBe( text )
      expect( pages.length ).toBeGreaterThan( 1 )
      for( const p of pages ) expect( estimateTokens( p ) ).toBeLessThanOrEqual( PAGE_TOKENS + 1 )
    }
  } )

  it('an array pages between its elements', () => {
    const pages = paginate( itemText( LISTING ), PAGE_TOKENS )
    for( const p of pages.slice( 0, -1 ) ) expect( p.endsWith(',\n') ).toBe( true )
  } )

  it('a small item renders exactly as before — compact, on its line', () => {
    const view = callView( 203_000, 8_096, 'system')
    expect( perceptLine( { category: 'observation', summary: 's', salience: 0.5, data: { n: 1, summary: 'x' }, handle: 'p1' }, view ) )
      .toBe('- [observation] s (salience: 0.50)\n    {"n":1}')
  } )

  it('a large one is a header, its first page, and the way to the rest', () => {
    const view = callView( 203_000, 8_096, 'system')
    const line = perceptLine( { category: 'observation', summary: 'list_pull_requests', salience: 0.8, data: LISTING, handle: 'percept-77' }, view )
    const pages = paginate( itemText( LISTING ), PAGE_TOKENS )
    expect( line ).toContain(`${ pages.length } pages · doc:percept-77`)
    expect( line ).toContain(`page 1 of ${ pages.length } below`)
    expect( line ).toContain('{"recall": [{"doc": "percept-77", "page": 2}]}')
    expect( line.endsWith( pages[0]! ) ).toBe( true )
    expect( estimateTokens( line ) ).toBeLessThan( PAGE_TOKENS + 200 )
  } )
} )

describe('one item, one render', () => {
  it('a percept held in mind shows its data under Ruminations only — not twice', () => {
    const view = callView( 203_000, 8_096, 's')
    const prompt = render( {
      percepts:      [ { category: 'observation', summary: 'list_pull_requests', salience: 0.8, data: LISTING, handle: 'percept-77' } ],
      workingMemory: [ { type: 'percept', summary: 'list_pull_requests', activation: 0.7, data: LISTING, handle: 'percept-77' } ],
    }, view )
    expect( prompt.split('PR 400: payments migration step 0') ).toHaveLength( 2 )
    expect( prompt ).toContain('list_pull_requests (salience: 0.80) (held in mind — its data is under Active Ruminations)')
  } )
} )

// ── the window ───────────────────────────────────────────────

const director = ( extra: Record<string, unknown> = {} ) =>
  new LLMDirector( { willId: 'w', model: 'glm-5.2', maxOutputTokens: 8_096, apiKey: 'k', provider: 'glm', sessionLogger: null, ...extra } as never )

describe('every call knows its window', () => {
  it('the user message gets the window less the output ceiling, the system prompt and a 5% reserve', () => {
    expect( callView( 203_000, 8_096, 'x'.repeat( 30_000 ) ).budget ).toBe( 203_000 - 8_096 - 10_000 - 10_150 )
  } )

  it('declared per model, matched like prices; undeclared is a conservative 128k', () => {
    expect( director().callLimits().contextWindow ).toBe( DEFAULT_CONTEXT_WINDOW )
    expect( director( { contextWindow: 203_000 } ).callLimits().contextWindow ).toBe( 203_000 )
    expect( director( { contextWindows: { 'GLM-5.2': 203_000 } } ).callLimits().contextWindow ).toBe( 203_000 )
  } )

  it('is the window of the model the call is ROUTED to', () => {
    const router = { name: 'r', route: ( m: { process: string } ) => m.process === 'ideation' ? { model: 'glm-5.2[1m]' } : null }
    const d = director( { router, contextWindows: { 'glm-5.2': 203_000, 'glm-5.2[1m]': 1_000_000 } } )
    expect( d.callLimits( { category: 'executive', attribute: 'master', process: 'decision', function: '-' } as never ).contextWindow ).toBe( 203_000 )
    expect( d.callLimits( { category: 'executive', attribute: 'master', process: 'ideation', function: '-' } as never ).contextWindow ).toBe( 1_000_000 )
  } )
} )

// ── a real call ──────────────────────────────────────────────

const sse = ( text: string ) => ( { ok: true, status: 200, statusText: 'OK',
  body: new ReadableStream<Uint8Array>( { start( c ){ c.enqueue( new TextEncoder().encode(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( text ) }}}\n` +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}\n' +
    'data: [DONE]\n' ) ); c.close() } } ) } as unknown as Response )

const userOf = ( body: { messages: Array<{ content: unknown }> } ): string => {
  const c = body.messages[0]!.content
  return typeof c === 'string' ? c : ( c as Array<{ text?: string }> ).map( b => b.text ?? '').join('')
}

describe('a facet\'s call with a 135k-token read in mind', () => {
  async function facetCalls( answers: string[] ){
    quiet()
    const sent: Array<{ system: unknown; user: string }> = []
    let i = 0
    globalThis.fetch = ( async ( _u: string, init: { body: string } ) => {
      const body = JSON.parse( init.body )
      sent.push( { system: body.system, user: userOf( body ) } )
      return sse( answers[ Math.min( i++, answers.length - 1 ) ]! )
    } ) as unknown as typeof fetch

    const state = { tick: 9, time: 9000, metrics: new Map(), entities: new Map<string, unknown>( [ [ 'percept-77', {
      id: 'percept-77', type: 'percept', createdAt: 0, updatedAt: 0, updatedAtTick: 8,
      metadata: { summary: 'list_pull_requests', category: 'observation', salience: 0.8, data: LISTING,
        provenance: 'reafferent', sourceIntentId: 'intent-3', tick: 8 } } ] ] ) } as unknown as ReadonlySimulationState

    const facet = new ExecutiveFacet('facet-1', createTestBus(), director( { contextWindow: 203_000 } ),
      { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null } as never,
      { summarizer: null } as never, 'w')
    facet.setStateRef( state )
    for( let n = 1; n <= answers.length; n++ ){
      await facet.report( { type: 'question', payload: {}, focus: { title: 'T', content: 'What is in flight?' } } as never )
      for( let k = 0; k < 200 && sent.length < n; k++ ) await new Promise( r => setTimeout( r, 5 ) )
      await new Promise( r => setTimeout( r, 10 ) )
    }
    facet.destroy?.()
    return sent
  }

  const answer = ( recall?: unknown ) => JSON.stringify( { actions: [ { type: 'reflect', reasoning: 'r', expectedOutcome: '' } ],
    reasoning: 'Reading the listing.' + ( recall ? `\n[RECALL]\n${ JSON.stringify( { recall } ) }\n[/RECALL]` : '' ), confidence: 0.7 } )

  it('fits the window, shows the read once — a header and its first page', async () => {
    const [ call ] = await facetCalls( [ answer() ] )
    const pages = paginate( itemText( LISTING ), PAGE_TOKENS )
    const budget = callView( 203_000, 8_096, JSON.stringify( call!.system ) ).budget
    expect( estimateTokens( call!.user ) ).toBeLessThan( budget )
    expect( call!.user ).toContain(`page 1 of ${ pages.length } below`)
    expect( call!.user.split( pages[1]! ) ).toHaveLength( 1 )                       // page 2 is not in view
    expect( call!.user.split('PR 400: payments migration step 0') ).toHaveLength( 2 )  // once, not twice
  } )

  it('brings back the page she asks for, on her next call, from memory, with its provenance', async () => {
    const [ , second ] = await facetCalls( [ answer( [ { doc: 'percept-77', page: 2 } ] ), answer() ] )
    const pages = paginate( itemText( LISTING ), PAGE_TOKENS )
    expect( second!.user ).toContain('## Brought Back (I asked for these)')
    expect( second!.user ).toContain(`doc:percept-77 (what I found by acting · list_pull_requests · tick 8) — page 2 of ${ pages.length }:\n${ pages[1] }`)
    expect( second!.user ).toContain('{"recall": [{"doc": "percept-77", "page": 3}]}')
  } )
} )

// ── every page, from every place she holds it ────────────────

describe('every page is reachable, wherever she holds it', () => {
  it('through [RECALL], page after page, the pages rejoin to what arrived', () => {
    const state = { tick: 9, entities: new Map( [ [ 'percept-77', { id: 'percept-77', type: 'percept',
      metadata: { summary: 'list_pull_requests', data: LISTING } } ] ] ) } as unknown as ReadonlySimulationState
    const n = paginate( itemText( LISTING ), PAGE_TOKENS ).length
    const read: string[] = []
    for( let page = 1; page <= n; page++ ){
      const asked = parseResponse( JSON.stringify( { actions: [], confidence: 0.5,
        reasoning: `r\n[RECALL]\n{"recall": [{"doc": "percept-77", "page": ${ page }}]}\n[/RECALL]` } ), state, [] ).recall! as Array<{ doc: string; page: number }>
      const shown = renderBroughtBack( resolveBroughtBack( asked, state, { workingMemory: null, episodicConsolidator: null } ), 1e9 )
      read.push( shown.split(`page ${ page } of ${ n }:\n`)[1]!.split('\n→ ')[0]! )
    }
    expect( read.join('') ).toBe( itemText( LISTING ) )
  } )

  it('after the percept is swept and working memory has let go — from the episode, strengthened by the reading', async () => {
    const sm = new DefaultStateManager()
    const at = ( t: number ) => sm.updateClock( t as never, t * 1000 as never )
    at( 1 )
    sm.applyCommands( { set: [ { id: 'percept-77', type: 'percept', metadata: { summary: 'list_pull_requests', category: 'observation',
      salience: 0.8, data: LISTING, provenance: 'reafferent', sourceIntentId: 'intent-3' } } ] } )
    const wm = new WorkingMemory(), ep = new EpisodicConsolidator( { autoIndex: false } )
    for( const e of [ wm, ep ] ){ const r = await e.react( 1000, 1 as never, sm.snapshot(), ctx ); if( r.commands ) sm.applyCommands( r.commands ) }
    at( 2 ); for( const e of [ wm, ep ] ){ const r = await e.react( 1000, 2 as never, sm.snapshot(), ctx ); if( r.commands ) sm.applyCommands( r.commands ) }
    sm.applyCommands( { delete: [ 'percept-77' ] } )

    const [ back ] = resolveBroughtBack( [ { doc: 'percept-77', page: 3 } ], sm.snapshot() as never,
      { workingMemory: new WorkingMemory(), episodicConsolidator: ep } )
    expect( back!.data ).toEqual( LISTING )
    expect( back!.provenance ).toBe('reafferent')
    expect( ep.getAllEpisodes()[0]!.retrievalCount ).toBe( 1 )
  } )

  it('a handle she holds no record of is said so', () => {
    const shown = renderBroughtBack( resolveBroughtBack( [ { doc: 'percept-gone', page: 1 } ],
      { tick: 1, entities: new Map() } as never, { workingMemory: null, episodicConsolidator: null } ), 1e9 )
    expect( shown ).toContain('doc:percept-gone — I hold no record of it now')
  } )

  it('a remembered observation shows its data, or its handle when it is large — not only its label', async () => {
    const small = { content: 'read list_pull_requests', relevance: 0.6, emotionalContext: 'neutral', tick: 3, data: { open: 2 }, handle: 'p-s' }
    const large = { content: 'read list_pull_requests', relevance: 0.6, emotionalContext: 'neutral', tick: 3, data: LISTING, handle: 'p-l' }
    const prompt = render( { memories: [ small, large ] }, callView( 203_000, 8_096, 's') )
    expect( prompt ).toContain('ticks ago)\n    {"open":2}')
    expect( prompt ).toContain('pages · doc:p-l — whole in memory, not shown here; {"recall": [{"doc": "p-l", "page": 1}]} to read it]')
  } )

  it('the context the executive is built from carries a remembered observation\'s data and handle', async () => {
    const episode = { id: 'episodic-3-0', timestamp: 3, activationStrength: 0.6, sourceType: 'percept', emotionalTags: {},
      content: { content: { summary: 'read list_pull_requests', entityId: 'percept-77', data: { open: 2 } } } }
    const consolidator = { semanticQuery: async () => [ episode ], query: () => [], getAllEpisodes: () => [ episode ], markRetrieved(){} }
    const c = await buildExecutiveContext( { tick: 9, entities: new Map(), metrics: new Map() } as never,
      { workingMemory: null, goalManager: null, episodicConsolidator: consolidator as never, semanticIntegrator: null } )
    expect( c.memories[0] ).toMatchObject( { data: { open: 2 }, handle: 'percept-77' } )
  } )
} )

// ── the safety net ───────────────────────────────────────────

describe('a call that would not fit tightens — it does not fail, and it cuts nothing', () => {
  it('oversize items go to their headers first, then less is shown inline', () => {
    const small = callView( 40_000, 8_096, 'system')
    const steps: string[] = []
    const fitted = fitToBudget( small, v => {
      steps.push(`${ v.mode }/${ v.inlineTokens }`)
      return render( { percepts: [ { category: 'observation', summary: 'big', salience: 0.9, data: LISTING, handle: 'p1' },
        ...Array.from( { length: 9 }, ( _, i ) => ( { category: 'o', summary: `mid ${ i }`, salience: 0.5, data: 'z'.repeat( 12_000 ), handle: `m${ i }` } ) ) ] }, v )
    } )
    expect( steps.slice( 0, 2 ) ).toEqual( [ 'page/8000', 'reference/8000' ] )
    expect( fitted.tightened ).toBeGreaterThan( 1 )
    expect( fitted.overBudget ).toBe( false )
    expect( estimateTokens( fitted.message ) ).toBeLessThanOrEqual( fitted.view.budget )
    for( const i of [ 0, 8 ] ) expect( fitted.message ).toContain(`doc:m${ i }`)    // still reachable, by handle
  } )

  it('what she asked to have brought back takes at most half a call, and the rest is said so', () => {
    const items = [ 1, 2, 3, 4 ].map( page => ( { handle: 'p1', page, data: LISTING } ) )
    const [ p1, p2 ] = paginate( itemText( LISTING ), PAGE_TOKENS )
    const shown = renderBroughtBack( items, estimateTokens( p1! ) + estimateTokens( p2! ) )
    expect( shown ).toContain('page 2 of')
    expect( shown ).not.toContain('page 3 of')
    expect( shown ).toContain('2 more of what I asked for did not fit this call — I can ask for them again.')
  } )
} )

describe('the master builds every call the same way', () => {
  it('both of its user messages are fitted to the routed window, with what it asked for', () => {
    // No harness runs a full master cycle; read the two build sites, as
    // lossless.p4 reads the master's writes.
    const src = readFileSync( join( process.cwd(), 'src/cognition/faculties/executive.engine/engine.ts'), 'utf8')
    const builds = src.split('PromptFactory.buildUserMessage(').slice( 1 )
    expect( builds ).toHaveLength( 2 )
    for( const b of builds ) expect( b.slice( 0, b.indexOf('} )') ) ).toMatch( /view,\s*broughtBack,/ )
    expect( src.match( /fitToBudget\( this\._callView\( (ideationMeta|masterMeta), systemPrompt \)/g ) ).toHaveLength( 2 )
    expect( src ).toMatch( /this\._pendingRecall = executiveOutput\.recall \?\? \[\]/ )
  } )
} )

// ── helpers ──────────────────────────────────────────────────

function render( parts: Partial<ExecutiveContext>, view?: ReturnType<typeof callView> ): string {
  const context = { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [], ...parts } as unknown as ExecutiveContext
  return buildUserMessage( { context, state: { tick: 9, metrics: new Map(), entities: new Map() } as never,
    qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null }, focus: { title: 'T', content: 'c' },
    mode: 'master', ...( view ? { view } : {} ) } as never )
}

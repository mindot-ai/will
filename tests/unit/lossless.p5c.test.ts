// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p5c.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P5c — every count is honest, and she can reach past it.
 *
 * A call shows a few of each thing she holds — six people, ten percepts, thirty
 * beliefs, eight memories — and that is attention, not a cut (LOSSLESS_P5 D5).
 * What made it a cut was silence: the people past the sixth, the percepts past the
 * tenth, the things she said before the last six were simply not there, and
 * nothing said so. Beliefs said "[+N omitted]" and offered no way to them.
 *
 * Now each section that shows N of more says exactly how many more, and names the
 * way to them: `[RECALL]` a section's next page, or a search of it, honoured on her
 * next call under `## Brought Back` — ranked as the view ranks, in the view's own
 * lines. Remembering, not perceiving and not acting: it reads what she holds.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { ExecutiveFacet } from '#faculties/executive.engine/facet'
import { createTestBus } from '#cognition/bus'
import { LLMDirector } from '#llm/index'
import { parseResponse } from '#faculties/executive.engine/parser'
import { buildUserMessage, PromptFactory } from '#faculties/executive.engine/prompt.factory'
import { buildExecutiveContext, resolveRecall } from '#faculties/executive.engine/context'
import { setLogger, resetLogger } from '#core/logger'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutiveContext } from '#faculties/executive.engine/types'
import type { ReadonlySimulationState } from '#core/types'

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch; resetLogger() } )

const PEOPLE   = [ 'Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy' ]   // 9 — six in view
const TOPICS   = [ 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel' ]
const CATS     = [ 'world_fact', 'social_belief', 'self_belief', 'causal_rule', 'pattern' ]
const PAYMENTS = [ 'The payments migration is blocked on the schema review',
                   'Ada owns the payments migration cut-over',
                   'Migrations of the ledger need a dry run first' ]

/** A mind holding more of everything than a call shows. */
function world( n = { people: 9, percepts: 14, said: 8, observations: 9 } ){
  const entities = new Map<string, Record<string, unknown>>()
  const put = ( e: Record<string, unknown> ) => entities.set( e['id'] as string, { createdAt: 0, updatedAt: 0, ...e } )
  PEOPLE.slice( 0, n.people ).forEach( ( name, i ) =>
    put( { id: `ke-${ i }`, type: 'known-entity', metadata: { keid: `ke:${ name.toLowerCase() }`, name, kind: 'sentient', lastSeenTick: 100 - i } } ) )
  for( let i = 0; i < n.percepts; i++ )
    put( { id: `percept-${ i }`, type: 'percept', metadata: { summary: `Something happened in #room-${ i }`, category: 'general', salience: ( 20 - i ) / 20 } } )
  for( let i = 0; i < n.said; i++ )
    put( { id: `sent-${ i }`, type: 'conversation.sent', metadata: { targetEntityId: 'ke:ada', targetEntityName: 'Ada', text: `Update number ${ i } on the review`, tick: 50 + i } } )
  for( let i = 0; i < n.observations; i++ )
    put( { id: `self-obs-${ 60 + i }-0`, type: 'self_observation', metadata: { observation: `Observation ${ i }: I hedge when unsure`, tick: 60 + i } } )
  return { tick: 120, time: 120_000, metrics: new Map(), entities } as unknown as ReadonlySimulationState
}

/** Forty distinct beliefs over five categories (thirty shown), plus a near-duplicate, plus three about payments. */
function beliefs(){
  const out = Array.from( { length: 40 }, ( _, i ) => ( { statement: `Belief ${ i } concerns topic ${ TOPICS[ i % TOPICS.length ] } number ${ i }`,
    category: CATS[ i % CATS.length ]!, confidence: 0.9 - i * 0.01, lastUpdatedAt: 100, tags: [] } ) )
  out.push( { statement: 'Belief 0 concerns topic alpha number 0 again', category: CATS[0]!, confidence: 0.2, lastUpdatedAt: 100, tags: [] } )
  // The weakest match ranks above the second-best, so only matching orders them.
  PAYMENTS.forEach( ( statement, i ) => out.push( { statement, category: 'world_fact', confidence: [ 0.99, 0.05, 0.06 ][ i ]!, lastUpdatedAt: 100, tags: [] } ) )
  return out
}

const integrator = { getBeliefs: () => beliefs() }
const NONE = { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null }

describe('every section that shows N of more says exactly how many — and how to reach them', () => {
  it('people, percepts, beliefs, what I said, what I noticed about myself, memories', async () => {
    const episodes = Array.from( { length: 20 }, ( _, i ) => episode( i, `I reviewed the ledger, pass ${ i }` ) )
    const store = consolidator( episodes, async () => episodes.slice( 0, 8 ) )
    const context = await buildExecutiveContext( world(), { ...NONE, semanticIntegrator: integrator as never, episodicConsolidator: store as never } )
    const prompt = render( context, world() )
    expect( prompt ).toContain('3 more people I know are not in view — {"recall": [{"section": "people", "page": 2}]} brings the next page; {"section": "people", "query": "…"} the ones about something.')
    expect( prompt ).toContain('4 more things I notice are not in view — {"recall": [{"section": "percepts", "page": 2}]}')
    expect( prompt ).toContain('14 more beliefs I hold are not in view — {"recall": [{"section": "beliefs", "page": 2}]}')
    expect( prompt ).toContain('2 more things I said earlier are not in view — {"recall": [{"section": "said", "page": 2}]}')
    expect( prompt ).toContain('3 more earlier observations are not in view — {"recall": [{"section": "self-observations", "page": 2}]}')
    expect( prompt ).toContain('12 more memories I hold are not in view — {"recall": [{"section": "memories", "page": 2}]}')
  } )

  it('a section with nothing out of view says nothing more', async () => {
    const small = world( { people: 2, percepts: 3, said: 2, observations: 2 } )
    const prompt = render( await buildExecutiveContext( small, NONE ), small )
    expect( prompt ).not.toContain('not in view')
  } )

  it('traits: the most distinctive six, and a count of the rest', () => {
    const traits = Object.fromEntries( [ 'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism',
      'decisiveness', 'persistence', 'creativity' ].map( ( k, i ) => [ k, i % 2 ? 0.1 : 0.9 ] ) )
    const system = PromptFactory.buildSystemPrompt( { context: context( { identity: { name: 'Lora', prompt: 'I am.', values: [], traits, style: 'plain' } } as never ),
      focus: { title: 'T', content: 'c' }, deps: {} as never, mode: 'master' } )
    expect( system ).toContain('2 more distinctive traits of mine are not in view — {"recall": [{"section": "traits", "page": 2}]}')
  } )
} )

describe('she can reach past any count — a page, or a search', () => {
  it('the next page of people, and of what she said, on her next call', async () => {
    const state = world()
    const ctx = await buildExecutiveContext( state, NONE )
    const asked = parseResponse( answer( [ { section: 'people', page: 2 }, { section: 'said' } ] ), state, [] ).recall!
    const prompt = render( ctx, state, await resolveRecall( asked, state, NONE, ctx ) )
    expect( entry( prompt, '- People I know, page 2 of 2:') ).toBe('- Gus\n- Hal\n- Ivy')
    expect( prompt ).toContain('- What I said, page 2 of 2:\n- **Ada** · 69 ticks ago — "Update number 1 on the review" — no answer yet\n- **Ada** · 70 ticks ago — "Update number 0 on the review" — no answer yet')
  } )

  it('a search of beliefs finds the ones about it — in view or not, best match first', async () => {
    const state = world()
    const ctx = await buildExecutiveContext( state, { ...NONE, semanticIntegrator: integrator as never } )
    expect( ctx.beliefs.map( b => b.statement ) ).toContain( PAYMENTS[0] )
    expect( ctx.outOfView!.beliefs.map( b => b.statement ) ).toEqual( expect.arrayContaining( PAYMENTS.slice( 1 ) ) )
    const prompt = render( ctx, state, await resolveRecall( [ { section: 'beliefs', page: 1, query: 'payments migration' } ], state, NONE, ctx ) )
    expect( prompt ).toContain(`- Beliefs I hold about "payments migration" — 3 found:\n- [world_fact] ${ PAYMENTS[0] } (confidence: 99%)\n- [world_fact] ${ PAYMENTS[1] } (confidence: 5%)\n- [world_fact] ${ PAYMENTS[2] } (confidence: 6%)`)
  } )

  it('a near-duplicate she holds is reachable too — last, after every belief the caps passed over', async () => {
    const ctx = await buildExecutiveContext( world(), { ...NONE, semanticIntegrator: integrator as never } )
    expect( ctx.outOfView!.beliefs.at( -1 )!.statement ).toBe('Belief 0 concerns topic alpha number 0 again')
    expect( ctx.beliefsOmitted ).toBe( ctx.outOfView!.beliefs.length )
    expect( ctx.beliefs.length + ctx.beliefsOmitted ).toBe( beliefs().length )
  } )

  it('a search that finds nothing says so; a page past the end says how many there are', async () => {
    const state = world()
    const ctx = await buildExecutiveContext( state, NONE )
    const prompt = render( ctx, state, await resolveRecall( [ { section: 'people', page: 1, query: 'zebra' }, { section: 'percepts', page: 9 } ], state, NONE, ctx ) )
    expect( prompt ).toContain('- People I know about "zebra" — none.')
    expect( prompt ).toContain('- Things I notice now — 2 pages; there is no page 9.')
  } )

  it('memories by meaning when the index answers — the next ones, not those in view — and reading one is a retrieval', async () => {
    const episodes = Array.from( { length: 20 }, ( _, i ) => episode( i, `I reviewed the ledger, pass ${ i }` ) )
    const retrieved: string[] = []
    const store = consolidator( episodes, async ( _q, f ) => episodes.slice( 0, f.limit ), retrieved )
    const state = world()
    const ctx = await buildExecutiveContext( state, { ...NONE, episodicConsolidator: store as never } )
    retrieved.length = 0
    const prompt = render( ctx, state, await resolveRecall( [ { section: 'memories', page: 2 } ], state, { ...NONE, episodicConsolidator: store as never }, ctx ) )
    expect( prompt ).toContain('- Memories, page 2 of 3:\n- I reviewed the ledger, pass 8 (relevance')
    expect( prompt ).toContain('- I reviewed the ledger, pass 15 (relevance')
    expect( prompt ).not.toMatch( /Memories, page 2 of 3:[^#]*pass 7 \(/ )
    expect( retrieved ).toEqual( episodes.slice( 8, 16 ).map( e => e.id ) )
  } )

  it('memories by the words they share when there is no index', async () => {
    const episodes = [ episode( 0, 'Ada asked about the payments migration' ), episode( 1, 'Lunch was late' ), episode( 2, 'The migration dry run passed' ) ]
    const store = consolidator( episodes, async () => [] )
    const state = world()
    const ctx = await buildExecutiveContext( state, NONE )
    const prompt = render( ctx, state, await resolveRecall( [ { section: 'memories', page: 1, query: 'migration' } ], state, { ...NONE, episodicConsolidator: store as never }, ctx ) )
    expect( prompt ).toContain('- Memories about "migration" — 2 found:\n- Ada asked about the payments migration')
    expect( prompt ).toContain('- The migration dry run passed')
    expect( prompt ).not.toContain('Lunch was late')
  } )

  it('a facet sees only what its focus is aware of — asked for anyway, it is told', async () => {
    const state = world()
    const ctx = await buildExecutiveContext( state, { ...NONE, semanticIntegrator: integrator as never } )
    const prompt = buildUserMessage( { context: ctx, state, qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null },
      focus: { title: 'T', content: 'c', awareness: [ 'percepts' ] }, mode: 'facet',
      broughtBack: await resolveRecall( [ { section: 'beliefs', page: 2 } ], state, NONE, ctx ) } as never )
    expect( prompt ).toContain("- Beliefs I hold — not in this focus's view.")
    expect( prompt ).not.toContain('Belief 39')
  } )
} )

describe('she asks for it in her own output', () => {
  it('a section with a page, with a query, with neither (the next page) — and a document as before', () => {
    const asked = parseResponse( answer( [ { section: 'people', page: 3 }, { section: 'beliefs', query: ' payments ' },
      { section: 'said' }, { section: 'nonsense' }, { doc: 'percept-1', page: 2 } ] ), world(), [] ).recall
    expect( asked ).toEqual( [ { section: 'people', page: 3 }, { section: 'beliefs', page: 1, query: 'payments' },
      { section: 'said', page: 2 }, { doc: 'percept-1', page: 2 } ] )
  } )
} )

describe('both seats bring back what they asked for', () => {
  it('a facet\'s next call carries the page of people it asked for', async () => {
    setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never )
    const sent: string[] = []
    const answers = [ answer( [ { section: 'people', page: 2 } ] ), answer() ]
    let i = 0
    globalThis.fetch = ( async ( _u: string, init: { body: string } ) => {
      const body = JSON.parse( init.body )
      const c = body.messages[0].content
      sent.push( typeof c === 'string' ? c : c.map( ( b: { text?: string } ) => b.text ?? '').join('') )
      return sse( answers[ Math.min( i++, answers.length - 1 ) ]! )
    } ) as unknown as typeof fetch
    const facet = new ExecutiveFacet('facet-1', createTestBus(),
      new LLMDirector( { willId: 'w', model: 'glm-5.2', maxOutputTokens: 8_096, apiKey: 'k', provider: 'glm', sessionLogger: null } as never ),
      NONE as never, { summarizer: null } as never, 'w')
    facet.setStateRef( world() )
    for( let n = 1; n <= 2; n++ ){
      await facet.report( { type: 'question', payload: {}, focus: { title: 'T', content: 'Who is around?' } } as never )
      for( let k = 0; k < 200 && sent.length < n; k++ ) await new Promise( r => setTimeout( r, 5 ) )
      await new Promise( r => setTimeout( r, 10 ) )
    }
    facet.destroy?.()
    expect( sent[0] ).not.toContain('People I know, page 2')
    expect( sent[1] ).toContain('- People I know, page 2 of 2:\n- Gus')
  } )

  it('the master resolves what it asked for against the context it is about to show', () => {
    const src = readFileSync( join( __dirname, '../../src/cognition/faculties/executive.engine/engine.ts'), 'utf8')
    expect( src ).toMatch( /const broughtBack = await resolveRecall\( this\._pendingRecall, state,\s*\{[^}]*\}, execContext \)/ )
  } )
} )

// ── helpers ──────────────────────────────────────────────────

function episode( i: number, text: string ){
  return { id: `episodic-${ i }-0`, timestamp: 100 - i, createdAt: 100 - i, activationStrength: 0.9 - i * 0.01,
    sourceType: 'percept', emotionalTags: {}, content: { summary: text } }
}

function consolidator( episodes: ReturnType<typeof episode>[], semantic: ( q: unknown, f: { limit: number } ) => Promise<unknown[]>, retrieved: string[] = [] ){
  return { semanticQuery: ( q: unknown, f: { limit: number } ) => semantic( q, f ), query: () => [],
    getAllEpisodes: () => episodes, markRetrieved: ( id: string ) => { retrieved.push( id ) } }
}

function answer( recall?: unknown[] ){
  return JSON.stringify( { actions: [ { type: 'reflect', reasoning: 'r', expectedOutcome: '' } ],
    reasoning: 'Looking.' + ( recall ? `\n[RECALL]\n${ JSON.stringify( { recall } ) }\n[/RECALL]` : '' ), confidence: 0.7 } )
}

/** One entry of `## Brought Back` — entries are separated by a blank line. */
function entry( prompt: string, heading: string ): string {
  const at = prompt.indexOf( heading + '\n')
  return at < 0 ? '' : prompt.slice( at + heading.length + 1 ).split('\n\n')[0]!
}

const sse = ( text: string ) => ( { ok: true, status: 200, statusText: 'OK',
  body: new ReadableStream<Uint8Array>( { start( c ){ c.enqueue( new TextEncoder().encode(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( text ) }}}\n` +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}\n' +
    'data: [DONE]\n' ) ); c.close() } } ) } as unknown as Response )

function context( parts: Partial<ExecutiveContext> = {} ): ExecutiveContext {
  return { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [], ...parts } as unknown as ExecutiveContext
}

function render( ctx: ExecutiveContext, state: ReadonlySimulationState, broughtBack?: unknown[] ): string {
  return buildUserMessage( { context: ctx, state, qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null },
    focus: { title: 'T', content: 'c' }, mode: 'master', ...( broughtBack ? { broughtBack } : {} ) } as never )
}

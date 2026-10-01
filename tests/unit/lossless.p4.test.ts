// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p4.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P4 — the operator's record is whole.
 *
 * The trace an operator judges the mind by is built from the session log, and the
 * session log cut what it recorded: a facet's response to 600 characters (and a
 * facet writes no response file, so that was all of it), its reasoning to 500, the
 * master's to 1,000, every error to 200 or 300, a provider's error body to 300. Our
 * analysis of her rested on the same cuts she once did.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ExecutiveFacet } from '#faculties/executive.engine/facet'
import { createTestBus } from '#cognition/bus'
import { LLMDirector } from '#llm/index'
import { SpacedRepetition } from '#faculties/spaced.repetition'
import { SemanticIntegrator } from '#faculties/semantic.engine/integrator'
import { DefaultMetricCollector } from '#core/metrics'
import { setLogger, resetLogger } from '#core/logger'
import type { ReadonlySimulationState } from '#core/types'

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch; resetLogger() } )

// Long enough to pass every old cut, its point at the end.
const REASONING = 'The release depends on the payments migration and the schema review. '.repeat( 20 )
  + 'So: hold the release, tell FKEM by noon.'
const BODY = '<html><body>' + 'upstream gateway detail '.repeat( 40 ) + 'request-id: 7f3a-final</body></html>'

const sse = ( text: string ) => ( { ok: true, status: 200, statusText: 'OK',
  body: new ReadableStream<Uint8Array>( { start( c ){ c.enqueue( new TextEncoder().encode(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( text ) }}}\n` +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":400}}\n' +
    'data: [DONE]\n' ) ); c.close() } } ) } as unknown as Response )
const refused = () => ( { ok: false, status: 400, statusText: 'Bad Request', text: async () => BODY,
  json: async () => ( {} ) } as unknown as Response )

const director = ( provider = 'glm') =>
  new LLMDirector( { willId: 'w', model: 'm', maxOutputTokens: 4096, apiKey: 'k', provider, sessionLogger: null } as never )

const quiet = () => { const seen: string[] = []
  setLogger( { debug(){}, info: ( m: string ) => { seen.push( m ) }, warn: ( m: string ) => { seen.push( m ) }, error: ( m: string ) => { seen.push( m ) } } )
  return seen }

/** A bare facet, as the legacy path runs one: reasoning launches on report. */
async function facetRecord( respond: () => Response ){
  globalThis.fetch = ( async () => respond() ) as unknown as typeof fetch
  quiet()
  const written: Array<Record<string, unknown>> = []
  const facet = new ExecutiveFacet('f-1', createTestBus(), director(),
    { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null } as never,
    { summarizer: null } as never, 'w')
  facet.attachSessionLogger( { write: ( e: Record<string, unknown> ) => { written.push( e ) } } as never )
  facet.setStateRef( { tick: 5, time: 5000, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )
  await facet.report( { type: 'question', payload: {}, focus: { title: 'T', content: 'What now?' } } as never )
  for( let i = 0; i < 200 && !written.some( e => e['type'] === 'executive.facet.output'); i++ )
    await new Promise( r => setTimeout( r, 5 ) )
  facet.destroy?.()
  return written
}

describe('a facet\'s record is whole', () => {
  it('keeps the whole response and the whole reasoning — it writes no response file', async () => {
    const response = JSON.stringify( { actions: [ { type: 'reflect', reasoning: 'r', expectedOutcome: '' } ], reasoning: REASONING, confidence: 0.8 } )
    const written = await facetRecord( () => sse( response ) )
    const res = written.find( e => e['type'] === 'executive.facet.response')!
    const out = written.find( e => e['type'] === 'executive.facet.output')!
    expect( res['response'] ).toBe( response )
    expect( out['reasoning'] ).toBe( REASONING )
  } )

  it('keeps the whole error, the provider\'s body included', async () => {
    const written = await facetRecord( refused )
    const failed = written.find( e => e['type'] === 'executive.facet.response' && e['error'] )!
    expect( String( failed['error'] ) ).toContain('request-id: 7f3a-final')
  } )
} )

describe('a provider\'s refusal is kept whole', () => {
  for( const provider of [ 'glm', 'openai', 'google' ] )
    it(`on the ${ provider } wire`, async () => {
      globalThis.fetch = ( async () => refused() ) as unknown as typeof fetch
      quiet()
      const err = await director( provider ).call('s', 'u', 0 as never ).catch( e => e as Error )
      expect( ( err as Error ).message ).toContain('request-id: 7f3a-final')
    } )
} )

describe('the rest of the record', () => {
  it('logs a belief\'s whole statement when a review lands', () => {
    const written: Array<Record<string, unknown>> = []
    const integ = new SemanticIntegrator()
    const statement = 'FKEM owns the payments migration, and the schema review blocks it until the index lands on Thursday.'
      .repeat( 2 )
    integ.restoreBeliefs( [ { id: 'b-1', statement, category: 'world_fact', confidence: 0.6, supportingEpisodes: 3,
      lastUpdatedAt: 0, tags: [], history: [] } ] )
    const sr = new SpacedRepetition()
    sr.attachSemanticIntegrator( integ as never )
    sr.attachSessionLogger( { write: ( e: Record<string, unknown> ) => { written.push( e ) } } as never )
    quiet()
    sr.onCognitiveEvent( { type: 'spaced_repetition.review.completed', payload: { beliefId: 'b-1', success: true, tick: 9 } } as never )
    expect( written.find( e => e['type'] === 'belief.spaced_repetition')?.['statement'] ).toBe( statement )
  } )

  it('logs every metric point it drops, not ten of them', async () => {
    const seen = quiet()
    const m = new DefaultMetricCollector( 0 )
    for( let i = 0; i < 25; i++ ) m.gauge( `g${ i }`, i )
    await m.flush()
    m.destroy()
    expect( seen.filter( l => /^ {2}gauge: g\d+=/.test( l ) ) ).toHaveLength( 25 )
  } )

  it('has no log line, anywhere, that quotes through a fixed-length cut', () => {
    // The sites fixed here quoted what she said or decided at 40–120 characters
    // (outbox, proactive, audition, planning). A guard over every source file, so
    // the next one is caught where it is written.
    const offenders: string[] = []
    const walk = ( dir: string ): void => {
      for( const f of readdirSync( dir ) ){
        const p = join( dir, f )
        if( statSync( p ).isDirectory() ) walk( p )
        else if( p.endsWith('.ts') )
          readFileSync( p, 'utf8').split('\n').forEach( ( line, i ) => {
            if( /logger\.(info|warn|error|debug)\(/.test( line ) && /\.slice\(\s*0,\s*\d+\s*\)/.test( line ) )
              offenders.push( `${ p }:${ i + 1 }` )
          } )
      }
    }
    walk( join( process.cwd(), 'src') )
    expect( offenders ).toEqual( [] )
  } )

  it('the master\'s record: reasoning and errors whole, the response whole on disk', () => {
    // No harness runs a full master cycle; read the four writes the way
    // lossless.p1 reads the facet's history pushes.
    const src = readFileSync( join( process.cwd(), 'src/cognition/faculties/executive.engine/engine.ts'), 'utf8')
    const write = ( type: string ) => { const at = src.indexOf( `type: '${ type }',` ); return src.slice( at, src.indexOf('} )', at ) ) }
    expect( write('executive.output') ).toMatch( /reasoning: executiveOutput\.reasoning,/ )
    expect( src ).toMatch( /error: msg\n/ )
    expect( src ).toMatch( /writeDebugResponse\(/ )
    expect( src ).not.toMatch( /LLM call failed: \$\{msg\.slice/ )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p1.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P1 — what the mind thinks is whole, in transit and in record.
 *
 * Its reasoning crossed between its own parts clipped (400 to the facets, 600 on
 * the master sync, 400 again on the escalation body, 600 into the summariser);
 * every new goal after the second and every self-observation after the fifth
 * was dropped unread, and the observations that survived were written into a
 * ring of twenty slots that overwrote itself. And a response cut at the output
 * ceiling was parsed as though it were whole, because nothing read why the
 * provider stopped. Each test here drives the real path and asserts past the old
 * cut, so restoring any one of them fails it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStateCommands, publishCognitiveEvents, type CommandDependencies } from '#faculties/executive.engine/commands'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import { ExecutiveSummarizer } from '#llm/summarizer'
import { GenerativeModel } from '#cognition/generative.model'
import { GoalManager } from '#faculties/goal.manager'
import { ExecutiveEngine } from '#faculties/executive.engine'
import { createTestBus } from '#cognition/bus'
import { LLMDirector } from '#llm/index'
import { TokenTracker } from '#cognition/utilities/token.tracker'
import { setLogger, resetLogger } from '#core/logger'
import type { ReadonlySimulationState, ReasoningFootprint } from '#core/types'

// Long enough to pass every old cut (200 / 400 / 600), with its point at the end.
const LONG = 'I weighed the release against the migration. '.repeat( 16 ) + 'The decision: hold the release until Thursday.'

const state = (): ReadonlySimulationState =>
  ( { tick: 7, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState )
const footprint = ( tick: number ): ReasoningFootprint =>
  ( { tickObserved: tick, entitiesRead: new Set(), metricsRead: new Set(), entitiesModified: new Set(),
      intendedCommands: {}, source: 'executive-engine' } as unknown as ReasoningFootprint )

function run( output: Partial<ExecutiveOutputFull>, tick = 7 ){
  const goals: string[] = []
  const published: Array<{ type: string; payload: Record<string, unknown> }> = []
  const deps: CommandDependencies = {
    summarizer: null,
    goalManager: { addGoal: ( d: string ) => { goals.push( d ); return 'g' },
                   abandonGoal(){}, updateGoalPriority(){} } as unknown as CommandDependencies['goalManager'],
    semanticIntegrator: null,
    bus: { publish: ( e: { type: string; payload: Record<string, unknown> } ) => { published.push( e ) } } as never,
    salience: new GenerativeModel(),
  }
  const full = { actions: [], reasoning: LONG, confidence: 0.8, ...output } as unknown as ExecutiveOutputFull
  const { commands, effects } = buildStateCommands( full, footprint( tick ), state(), deps, [] )
  for( const fx of effects ) fx()
  return { goals, published, set: commands.set ?? [] }
}

describe('the mind\'s own output is not discarded', () => {
  it('keeps every goal it formed, not the first two', () => {
    const newGoals = [ 'ship the review', 'unblock payments', 'brief FKEM', 'draft the digest' ]
      .map( description => ( { description, priority: 0.6, tags: [] } ) )
    expect( run( { newGoals } as never ).goals ).toEqual( newGoals.map( g => g.description ) )
  } )

  it('keeps every self-observation, each under its own id', () => {
    const obs = [ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ].map( x => `I noticed ${ x }` )
    const first  = run( { selfObservations: obs } as never, 7 ).set.filter( e => e.type === 'self_observation')
    const second = run( { selfObservations: obs } as never, 8 ).set.filter( e => e.type === 'self_observation')
    expect( first ).toHaveLength( 7 )
    // The old ring put tick 8's first observation in tick 7's second slot.
    const ids = new Set( [ ...first, ...second ].map( e => e.id ) )
    expect( ids.size ).toBe( 14 )
  } )

  it('publishes its reasoning whole — the interpretation and each rationale', () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    const bus = { publish: ( e: { type: string; payload: Record<string, unknown> } ) => { published.push( e ) } } as never
    const out = { actions: [ { type: 'reflect', reasoning: LONG, expectedOutcome: '' } ], reasoning: LONG, confidence: 0.8 } as unknown as ExecutiveOutputFull
    publishCognitiveEvents( out, footprint( 7 ), bus, 1, new GenerativeModel() )
    const interp = published.find( e => e.type === 'executive.interpretation.formed')!
    const why    = published.find( e => e.type === 'executive.decision.rationale')!
    expect( interp.payload['reasoning'] ).toBe( LONG )
    expect( why.payload['reasoning'] ).toBe( LONG )
  } )
} )

describe('reasoning in record is whole', () => {
  it('summarises what it actually thought, not 600 characters of it', () => {
    const s = new ExecutiveSummarizer({ summaryInterval: 1000 })
    s.record( LONG )
    expect( s.snapshot().buffer[0] ).toBe( LONG )
    expect( s.projectedSnapshot( LONG ).buffer.at( -1 ) ).toBe( LONG )
  } )

  it('keeps the whole reason a goal was let go', () => {
    const gm = new GoalManager()
    const id = gm.addGoal('ship the review', 0.5 )
    gm.abandonGoal( id, LONG )
    expect( gm.getGoal( id )!.abandonedReason ).toBe( LONG )
  } )

  it('hands a facet\'s reasoning to the master whole', () => {
    const bus = createTestBus()
    const engine = new ExecutiveEngine()
    engine.attachBus( bus )
    bus.subscribe( engine.name, engine.subscribes(), ev => { engine.onCognitiveEvent( ev ) } )
    bus.publish( { type: 'executive.facet.handoff', version: 1, sourceEngine: 'audition-engine', salience: 0.9,
      payload: { subjectEntityId: 'discord:1', threadId: 't', confidence: 0.8, body: { kind: 'escalation', reasoning: LONG } },
    } as never )
    bus.flush()
    const { percepts } = ( engine as unknown as { _escalations: { drainToPercepts(): { percepts: { metadata: Record<string, unknown> }[] } } } )
      ._escalations.drainToPercepts()
    expect( JSON.stringify( percepts[0]!.metadata ) ).toContain('The decision: hold the release until Thursday.')
  } )

  it('carries the master\'s thinking and its own into a facet\'s history whole', () => {
    // No harness builds an ExecutiveFacet directly; read the two push sites the
    // way facet.identity.test.ts reads the same block.
    const src = readFileSync( join( process.cwd(), 'src/cognition/faculties/executive.engine/facet.ts'), 'utf8')
    const pushes = src.match( /_(masterSync|facetReasoning)History\.push\(`[^`]*`\)/g ) ?? []
    expect( pushes ).toHaveLength( 2 )
    for( const p of pushes ) expect( p ).not.toMatch( /\.slice\(/ )
  } )
} )

// ── a response cut at the output ceiling is never silent ─────

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch; resetLogger() } )

function sse( stop: string ){
  const body =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"actions\\": [{\\"type\\": \\"refl"}}\n' +
    `data: {"type":"message_delta","delta":{"stop_reason":"${ stop }"},"usage":{"output_tokens":64}}\n` +
    'data: [DONE]\n'
  return { ok: true, status: 200, statusText: 'OK',
    body: new ReadableStream<Uint8Array>( { start( c ){ c.enqueue( new TextEncoder().encode( body ) ); c.close() } } ) } as unknown as Response
}
const json = ( data: unknown ) => ( { ok: true, status: 200, statusText: 'OK', json: async () => data } as unknown as Response )
const director = ( provider: string ) =>
  new LLMDirector( { willId: 'w', model: 'm', maxOutputTokens: 64, apiKey: 'k', provider, sessionLogger: null } as never )
function warnings(){
  const seen: string[] = []
  setLogger( { debug(){}, info(){}, error(){}, warn: ( m: string ) => { seen.push( m ) } } )
  return seen
}

describe('the output ceiling', () => {
  it('marks a streamed response that hit it, and says so out loud', async () => {
    globalThis.fetch = ( async () => sse('max_tokens') ) as unknown as typeof fetch
    const seen = warnings()
    const r = await director('glm').callStream('s', 'u', 0 as never, () => {} )
    expect( r.truncated ).toBe( true )
    expect( r.stopReason ).toBe('max_tokens')
    expect( seen.some( m => m.includes('OUTPUT CUT') ) ).toBe( true )
  } )

  it('writes the cut into the ledger, where analysis reads it', async () => {
    globalThis.fetch = ( async () => sse('max_tokens') ) as unknown as typeof fetch
    warnings()
    const tracker = new TokenTracker()
    const rows: Array<Record<string, unknown>> = []
    tracker.onRecord( r => { rows.push( r as Record<string, unknown> ) } )
    const d = new LLMDirector( { willId: 'w', model: 'm', maxOutputTokens: 64, apiKey: 'k', provider: 'glm',
      sessionLogger: null, tokenTracker: tracker } as never )
    await d.call('s', 'u', 0 as never )
    expect( rows.at( -1 )?.['truncated'] ).toBe( true )
  } )

  it('does not cry wolf on a response that finished', async () => {
    globalThis.fetch = ( async () => sse('end_turn') ) as unknown as typeof fetch
    const seen = warnings()
    const r = await director('glm').call('s', 'u', 0 as never )
    expect( r.truncated ).toBeUndefined()
    expect( r.stopReason ).toBe('end_turn')
    expect( seen.some( m => m.includes('OUTPUT CUT') ) ).toBe( false )
  } )

  it('reads the OpenAI wire\'s `length`', async () => {
    globalThis.fetch = ( async () => json( { choices: [ { message: { content: '{' }, finish_reason: 'length' } ],
      usage: { prompt_tokens: 1, completion_tokens: 64 } } ) ) as unknown as typeof fetch
    expect( ( await director('openai').call('s', 'u', 0 as never ) ).truncated ).toBe( true )
  } )

  it('reads the Google wire\'s `MAX_TOKENS`', async () => {
    globalThis.fetch = ( async () => json( { candidates: [ { content: { parts: [ { text: '{' } ] }, finishReason: 'MAX_TOKENS' } ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 64 } } ) ) as unknown as typeof fetch
    expect( ( await director('google').call('s', 'u', 0 as never ) ).truncated ).toBe( true )
  } )
} )

vi.spyOn( console, 'info').mockImplementation( () => {} )

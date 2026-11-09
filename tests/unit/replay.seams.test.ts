// ─────────────────────────────────────────────────────────────
// tests/unit/replay.seams.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4b, seam by seam: each input reaches the record chain
// where it reached the mind, and a replay can hand it back there.

import { describe, it, expect, afterEach } from 'vitest'
import { DefaultSimulationClock } from '#core/clock'
import { setRecordTap, clearRecordTap } from '#core/record.tap'
import { setCompletionSource, clearCompletionSource, type LLMCompletionRecord } from '#core/completion.recorder'
import { setRecallSource, clearRecallSource, type RecallRecord } from '#core/recall.source'
import { LLMDirector } from '#llm/index'
import { EpisodicConsolidator } from '#cognition/faculties/episodic.consolidator'
import { RecordChain, RECORD_CHAIN, type ChainEntry } from '#core/record.chain'
import { replayChain } from '#stem/replay.chain'

const W = 'seam-will'
const sleep = ( ms: number ) => new Promise<void>( r => setTimeout( r, ms ) )
afterEach( () => { clearRecordTap( W ); clearCompletionSource( W ); clearRecallSource( W ) } )

function tapped(){
  const got: Array<{ stream: string; record: Record<string, unknown> }> = []
  setRecordTap( W, ( stream, record ) => { got.push( { stream, record: record as Record<string, unknown> } ) } )
  return got
}

describe('the clock', () => {
  it('in wall mode, holds still between ticks and moves only when it steps', async () => {
    const clock = new DefaultSimulationClock( { startTime: 1_000 } )
    const before = clock.now
    await sleep( 15 )
    expect( clock.now ).toBe( before )
    clock.tick()
    const stepped = clock.now
    expect( stepped ).toBeGreaterThan( before )
    await sleep( 15 )
    expect( clock.now ).toBe( stepped )
  })

  it('announces every step it takes, and takes them from a source when given one', () => {
    const clock = new DefaultSimulationClock( { fixedDeltaMs: 50, startTime: 0 } )
    const heard: Array<[ number, number, number ]> = []
    clock.onStep( ( step, tick ) => heard.push( [ step.now, step.delta, tick ] ) )
    clock.tick()
    const feed = [ { now: 7_000, delta: 6_950 }, { now: 7_013, delta: 13 } ]
    clock.setStepSource( () => feed.shift()! )
    clock.tick(); clock.tick()
    expect( clock.now ).toBe( 7_013 )
    clock.setStepSource( null )
    clock.tick()
    clock.onStep( null )
    clock.tick()
    expect( heard ).toEqual( [ [ 50, 50, 1 ], [ 7_000, 6_950, 2 ], [ 7_013, 13, 3 ], [ 7_063, 50, 4 ] ] )
    expect( clock.currentTick ).toBe( 5 )
  })
})

describe('a model call', () => {
  const director = () => new LLMDirector( {
    willId: W, model: 'm', maxOutputTokens: 50, apiKey: 'k', provider: 'openai', sessionLogger: null,
    baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 2_000,
  } as never )

  it('that fails is chained like an answer, with why, and still fails for its caller', async () => {
    const got = tapped()
    await expect( director().call('sys', 'user', 4 ) ).rejects.toThrow()
    expect( got ).toHaveLength( 1 )
    expect( got[ 0 ] ).toMatchObject( { stream: 'completions', record: { tick: 4, systemPrompt: 'sys', userMessage: 'user', text: '', mock: false } } )
    expect( typeof got[ 0 ]!.record.error ).toBe('string')
  })

  it('in a replay, is answered from the tape — chained again as recorded, its failure thrown again', async () => {
    const got = tapped()
    const answer = { tick: 4, willId: W, provider: 'openai', model: 'm', maxOutputTokens: 50, systemPrompt: 's', userMessage: 'u',
      text: 'recorded', inputTok: 3, outputTok: 5, truncated: true, stopReason: 'length', mock: false, latencyMs: 9, timestamp: 1 } satisfies LLMCompletionRecord
    const failed = { ...answer, text: '', error: 'the network was down' }
    const tape = [ answer, failed ]
    setCompletionSource( W, { nextCompletion: () => tape.shift()! } )
    const d = director()
    expect( await d.call('s', 'u', 4 ) ).toEqual( { text: 'recorded', inputTok: 3, outputTok: 5, truncated: true, stopReason: 'length' } )
    await expect( d.callStream('s', 'u', 4, () => {} ) ).rejects.toThrow('the network was down')
    expect( got.map( g => g.record ) ).toEqual( [ answer, failed ] )
  })

  it('handed over at once, resumes its caller as a live mock call does — before what follows it', async () => {
    const order: string[] = []
    const record = { tick: 1, willId: W, provider: 'mock', model: 'mock', maxOutputTokens: 1, systemPrompt: 's', userMessage: 'u',
      text: 't', inputTok: 0, outputTok: 0, mock: true, latencyMs: 0, timestamp: 0 }
    setCompletionSource( W, { nextCompletion: () => record } )
    setRecordTap( W, () => { order.push('chained') } )
    const d = director()
    const caller = ( async () => { await d.call('s', 'u', 1 ); order.push('caller resumed') } )()
    order.push('after the call')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    order.push('three microtasks on')
    await caller
    expect( order ).toEqual( [ 'chained', 'after the call', 'caller resumed', 'three microtasks on' ] )
  })
})

describe('recall', () => {
  const memory = ( search: () => Promise<unknown[]> ) => new EpisodicConsolidator( {
    willId: W, vectorMemory: { search, delete: async () => {} } as never,
  } )

  it('chains what came back, and a timeout as a timeout', async () => {
    const got = tapped()
    await memory( async () => [ { episodeId: 'e1', similarity: 0.9, extra: 'dropped' } ] ).semanticQuery('the door', { limit: 2, minSimilarity: 0.3 } )
    process.env.WILL_RECALL_TIMEOUT_MS = '20'
    try { await memory( () => new Promise( () => {} ) ).semanticQuery('the window') }
    finally { delete process.env.WILL_RECALL_TIMEOUT_MS }
    expect( got ).toEqual( [
      { stream: 'recall', record: { query: 'the door', limit: 2, minSimilarity: 0.3, hits: [ { episodeId: 'e1', similarity: 0.9 } ] } },
      { stream: 'recall', record: { query: 'the window', limit: 10, hits: [], timedOut: true } },
    ] )
  })

  it('in a replay, is handed back from the tape and never searches', async () => {
    const got = tapped()
    const tape: RecallRecord[] = [ { query: 'q', limit: 10, hits: [ { episodeId: 'gone', similarity: 0.8 } ] } ]
    setRecallSource( W, { nextRecall: async () => tape[ 0 ]! } )
    let searched = 0
    const found = await memory( async () => { searched++; return [] } ).semanticQuery('q')
    expect( searched ).toBe( 0 )
    expect( found ).toEqual( [] )   // the episode is not in this store
    expect( got.map( g => g.record ) ).toEqual( tape )
  })
})

describe('a replay refuses what it cannot replay', () => {
  const chainOf = ( genesis: Record<string, unknown>, ...more: Array<[ ChainEntry['stream'], unknown ]> ) => {
    const c = new RecordChain()
    return [ c.append('chain', 0, genesis ), ...more.map( ( [ s, r ], i ) => c.append( s, i + 1, r ) ) ]
  }
  const genesis = { chain: RECORD_CHAIN, willId: 'r', seed: 1, startTick: 0, config: { id: 'r' }, env: {}, recall: false, restored: null }

  it('no records, a broken chain, a chain not begun at a genesis, a genesis without a config, a stored snapshot', async () => {
    expect( ( await replayChain( [] ) ).refused ).toBe('there are no records')

    const broken = chainOf( genesis, [ 'session', { a: 1 } ] )
    broken[ 1 ] = { ...broken[ 1 ]!, record: { a: 2 } }
    expect( ( await replayChain( broken ) ).refused ).toMatch( /^the chain breaks at entry 2/ )

    expect( ( await replayChain( chainOf( genesis, [ 'session', {} ] ).slice( 1 ) ) ).refused ).toMatch( /does not begin a will-record\/1 chain/ )
    expect( ( await replayChain( chainOf( { chain: RECORD_CHAIN, willId: 'r', seed: 1, startTick: 0 } ) ) ).refused ).toMatch( /does not carry the starting config/ )
    expect( ( await replayChain( chainOf( { ...genesis, restored: { tick: 42, entities: 3, hash: 'h' } } ) ) ).refused )
      .toMatch( /began from a stored snapshot at tick 42/ )
  })
})

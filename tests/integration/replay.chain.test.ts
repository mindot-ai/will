// ─────────────────────────────────────────────────────────────
// tests/integration/replay.chain.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4b: a mind re-executed from its record chain produces
// the same chain, entry for entry.
//
// The run that matters is the one a deployment has: a model answering over a
// network, each answer landing at whatever tick its latency carries it to, with
// people speaking, an ability acked by the host, a policy that answers late and
// escalates, a host answering the escalation, a pause and a resume. Nothing in
// it is fixed but what the chain records.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Will } from '#surface/sdk/will'
import { LLMDirector } from '#llm/index'
import { replayChain } from '#stem/replay.chain'
import { canonical, entryHash, recordHash, type ChainEntry } from '#core/record.chain'
import { setLogger, resetLogger } from '#core/logger'
import type { PolicyArbiter, Verdict } from '#stem/policy/arbiter'
import { fileAnchoring, ed25519Signer, ed25519Verifier, readJsonLines, RECORDS_FILE, DIGESTS_FILE } from '#stem/tracts/anchor.files'
import { verifyRecords, type AnchoredDigest } from '#core/record.verify'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV: Record<string, string | undefined> = {
  WILL_SEMANTIC_RECALL: undefined, WILL_EMBEDDING_MODEL: undefined, WILL_VECTOR_MEMORY: 'mock',
  WILL_SUMMARY_INTERVAL: '100000', WILL_EMBEDDING_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  WILL_LLM_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined,
}
const saved: Record<string, string | undefined> = {}
const sleep = ( ms: number ) => new Promise<void>( r => setTimeout( r, ms ) )

/** A model that answers over HTTP, after a delay no tick predicts. */
let server: Server
let baseUrl = ''
let answered = 0
beforeAll( async () => {
  for( const [ k, v ] of Object.entries( ENV ) ){ saved[ k ] = process.env[ k ]; if( v === undefined ) delete process.env[ k ]; else process.env[ k ] = v }
  setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
  const mock = new LLMDirector( { willId: 'fake-model', model: 'mock', maxOutputTokens: 500, apiKey: '', provider: 'anthropic', sessionLogger: null, mock: true } ) as never as {
    _mockResponse( tick: number, user: string ): { text: string }
  }
  server = createServer( ( req, res ) => {
    let body = ''
    req.on('data', c => { body += c } )
    req.on('end', () => {
      const { messages } = JSON.parse( body ) as { messages: Array<{ role: string; content: string }> }
      const user = messages.at( -1 )!.content
      const tick = Number( /Tick: (\d+)/.exec( user )?.[ 1 ] ?? 0 )
      const text = mock._mockResponse( tick, user ).text
      setTimeout( () => {
        answered++
        res.setHeader('content-type', 'application/json')
        res.end( JSON.stringify( { choices: [ { message: { content: text }, finish_reason: 'stop' } ], usage: { prompt_tokens: 10, completion_tokens: 20 } } ) )
      }, 5 + Math.floor( Math.random() * 90 ) )
    } )
  } )
  await new Promise<void>( r => server.listen( 0, '127.0.0.1', () => r() ) )
  baseUrl = `http://127.0.0.1:${( server.address() as AddressInfo ).port}/v1`
})
afterAll( async () => {
  resetLogger()
  for( const [ k, v ] of Object.entries( saved ) ){ if( v === undefined ) delete process.env[ k ]; else process.env[ k ] = v }
  await new Promise<void>( r => server.close( () => r() ) )
})

/** Answers late, and asks a person about the first `inspect`. */
function lateArbiter( onEscalate: ( intentId: string ) => void ): PolicyArbiter {
  let asked = false
  return {
    name: 'late',
    evaluate: invocation => new Promise<Verdict>( resolve => setTimeout( () => {
      if( invocation.schema === 'inspect' && !asked ){
        asked = true
        resolve( { decision: 'escalate', reasonCode: 'ask-first', holdTicks: 200 } )
        onEscalate( invocation.intentId )
      }
      else resolve( { decision: 'allow' } )
    }, 5 + Math.floor( Math.random() * 60 ) ) ),
  }
}

async function liveRun(): Promise<ChainEntry[]> {
  const entries: ChainEntry[] = []
  const will = await Will.create( {
    name: 'Ada', identity: { prompt: 'I am Ada, and I look into things.', values: [ 'care' ] },
    llm: 'openai', llmConfig: { apiKey: 'sk-test-not-chained', baseUrl, model: 'fake' },
    tickMs: 20,
    anchoring: { every: 7, record: e => { entries.push( e ) }, anchor: () => {} },
  } )
  will.effector('inspect', {
    description: 'Look into something someone mentioned',
    handler: async () => { await sleep( Math.floor( Math.random() * 40 ) ); return { success: true, description: 'looked', observation: { found: 'two orders' } } },
  } )
  will.setArbiter( lateArbiter( intentId => { setTimeout( () => will.resolveEscalation( intentId, true ), 30 ) } ) )

  const said = ( text: string ) => will.sense( { text, from: 'discord:U1', speaker: 'Bo', thread: 'discord:c1', direct: false, threadName: '#general', provenance: 'exafferent' } )
  await said('Has anyone looked at the order that came in?')
  await sleep( 300 )
  will.stem.injectEvent( will.id, { type: 'world.door', payload: { opened: true } } )
  await said('There is a second one, too.')
  await sleep( 200 )
  will.pause()
  await sleep( 120 )
  will.resume()
  await said('Can you check both?')
  await sleep( 400 )
  await will.stop()
  return entries
}


/** On a failure under DEBUG_REPLAY, the divergence and the original around it. */
function explain( report: Awaited<ReturnType<typeof replayChain>>, entries: ChainEntry[] ): void {
  if( report.divergence && process.env.DEBUG_REPLAY ){
    const d = report.divergence
    process.stderr.write(`DIVERGE ${d.seq} ${d.reason}\nEXP ${JSON.stringify( d.expected )?.slice( 0, 700 )}\nGOT ${JSON.stringify( d.produced )?.slice( 0, 700 )}\n`)
    for( const e of entries.filter( x => x.seq >= d.seq - 10 && x.seq <= d.seq + 3 ) ){
      const r = e.record as any
      process.stderr.write(`  ${e.seq} t${e.tick} ${e.stream} ${r?.type ?? r?.lifecycle ?? r?.envelope?.channel ?? ''} ${r?.facetId ?? ''} ${e.stream === 'completions' ? `issue=${r.tick} ${String( r.userMessage ).slice( 0, 30 )}` : ''}\n`)
    }
  }
}

const count = ( entries: ChainEntry[], stream: string ) => entries.filter( e => e.stream === stream ).length

describe('replay from the record chain', () => {
  it('a mind whose model answers over a network replays entry for entry, every answer where it landed', async () => {
    const entries = await liveRun()

    // What this run must have exercised, or it proves less than it says.
    expect( answered ).toBeGreaterThan( 0 )
    for( const stream of [ 'clock', 'completions', 'inbound', 'recall', 'verdicts', 'session' ] )
      expect( count( entries, stream ), stream ).toBeGreaterThan( 0 )
    const completions = entries.filter( e => e.stream === 'completions' )
    /** Answers that landed ticks after they were asked for — the case a replay has to place. */
    expect( completions.some( e => e.tick > ( e.record as { tick: number } ).tick ) ).toBe( true )
    const channels = entries.filter( e => e.stream === 'inbound' ).map( e => ( e.record as { envelope: { channel: string; ackKind?: string } } ).envelope )
    expect( channels.map( c => c.channel ) ).toEqual( expect.arrayContaining( [ 'sense', 'event', 'escalation', 'ack' ] ) )
    expect( channels.some( c => c.channel === 'ack' && c.ackKind === 'result') ).toBe( true )
    expect( entries.filter( e => e.stream === 'chain' ).map( e => ( e.record as { lifecycle?: string } ).lifecycle ) )
      .toEqual( [ undefined, 'pause', 'resume', 'archive' ] )
    /** The key never reaches the chain. */
    expect( JSON.stringify( entries[ 0 ]!.record ) ).not.toContain('sk-test')

    const report = await replayChain( entries, { stallMs: 10_000 } )
    explain( report, entries )
    expect( report.divergence ).toBeUndefined()
    expect( report.reproduced ).toBe( true )
    expect( report.through ).toBe( entries.at( -1 )!.seq )
  }, 120_000 )

  it('a forged record is found where it was forged, even with the chain re-hashed around it', async () => {
    const entries = await liveRun()
    // The operator rewrites what the mind said, and rebuilds every hash after it.
    const at = entries.findIndex( e => e.stream === 'session' && ( e.record as { type?: string } ).type === 'conversation.out')
    expect( at ).toBeGreaterThan( 0 )
    const forged = entries.map( e => ( { ...e } ) ) as Array<ChainEntry & { record?: unknown }>
    forged[ at ] = { ...forged[ at ]!, record: { ...( forged[ at ]!.record as object ), messages: [ 'I never looked.' ] } }
    for( let i = at; i < forged.length; i++ ){
      const e = forged[ i ]!
      const prev = forged[ i - 1 ]!.hash
      const rh = e.record === undefined ? e.recordHash : recordHash( e.record )
      forged[ i ] = { ...e, prev, recordHash: rh, hash: entryHash( prev, { ...e, recordHash: rh } ) }
    }
    const report = await replayChain( forged, { stallMs: 10_000 } )
    if( report.divergence?.seq !== forged[ at ]!.seq ) explain( report, forged )
    expect( report.reproduced ).toBe( false )
    expect( report.divergence?.seq ).toBe( forged[ at ]!.seq )
    expect( report.divergence?.reason ).toMatch( /different session record/ )
    expect( canonical( ( report.divergence?.produced as { messages: unknown } ).messages ) ).not.toContain('I never looked.')
  }, 120_000 )

  it('a mind hibernated and woken onto the same files keeps one chain, verifiable and replayable across both lives', async () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-records-') )
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const sign = ed25519Signer( privateKey.export( { type: 'pkcs8', format: 'pem' } ).toString() )
    const anchoring = () => fileAnchoring( dir, { every: 5, sign } )
    try {
      const first = await Will.create( { name: 'Ada', identity: { prompt: 'I am Ada.' }, llm: 'mock', seed: 9, tickMs: 15, anchoring: anchoring() } )
      await first.sense( { text: 'Remember the blue door.', from: 'bo', provenance: 'exafferent' } )
      await sleep( 150 )
      const pma = await first.hibernate()

      const woken = await Will.wake( pma, { name: 'Ada', llm: 'mock', seed: 9, tickMs: 15, anchoring: anchoring() } )
      await woken.sense( { text: 'What door was it?', from: 'bo', provenance: 'exafferent' } )
      await sleep( 150 )
      await woken.stop()

      const entries = readJsonLines<ChainEntry>( join( dir, RECORDS_FILE ) )
      const digests = readJsonLines<AnchoredDigest>( join( dir, DIGESTS_FILE ) )
      const geneses = entries.filter( e => e.stream === 'chain' && ( e.record as { chain?: string } ).chain )
      expect( geneses ).toHaveLength( 2 )
      expect( ( geneses[ 1 ]!.record as { resumed?: boolean } ).resumed ).toBe( true )
      /** The woken life begins from the artifact, chained whole. */
      const loaded = entries.find( e => ( e.record as { loaded?: string } ).loaded === 'pma')
      const firstStep = entries.find( e => e.stream === 'clock' && e.seq > geneses[ 1 ]!.seq )!
      expect( loaded!.seq ).toBeGreaterThan( geneses[ 1 ]!.seq )
      expect( loaded!.seq ).toBeLessThan( firstStep.seq )

      const verified = verifyRecords( entries, { digests, verify: ed25519Verifier( publicKey.export( { type: 'spki', format: 'pem' } ).toString() ) } )
      expect( verified.ok ).toBe( true )
      if( process.env.DEBUG_REPLAY ) for( const e of entries.slice( -4 ) ) process.stderr.write(`TAIL ${e.seq} ${e.stream} ${JSON.stringify( e.record ).slice( 0, 160 )}\n`)
      expect( verified.anchoredThrough ).toBe( entries.at( -1 )!.seq )
      expect( verified.unanchored ).toBe( 0 )

      const report = await replayChain( entries, { stallMs: 10_000 } )
      explain( report, entries )
      expect( report.reproduced ).toBe( true )
      expect( report.through ).toBe( entries.at( -1 )!.seq )
    }
    finally { rmSync( dir, { recursive: true, force: true } ) }
  }, 120_000 )
})

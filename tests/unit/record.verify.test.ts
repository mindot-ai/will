// ─────────────────────────────────────────────────────────────
// tests/unit/record.verify.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4a: what `will verify` checks without replay, the
// files `fileAnchoring` keeps, the signatures, and what the genesis leaves out.

import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical, RecordChain, RECORD_CHAIN, type ChainEntry } from '#core/record.chain'
import { verifyRecords, type AnchoredDigest } from '#core/record.verify'
import { fileAnchoring, ed25519Signer, ed25519Verifier, readJsonLines, RECORDS_FILE, DIGESTS_FILE } from '#stem/tracts/anchor.files'
import { startingConfig, startingEnv, withoutSecrets } from '#stem/tracts/anchor.controller'

const WILL = 'will-v'

/** A chain of `n` entries, and a digest of each head, as a host would have kept them. */
function kept( n: number ){
  const chain = new RecordChain()
  const entries: ChainEntry[] = [ chain.append('chain', 0, { chain: RECORD_CHAIN, willId: WILL }) ]
  for( let i = 1; i < n; i++ ) entries.push( chain.append('session', i, { type: 'tick', i } ) )
  const digestOf = ( e: ChainEntry, tick = e.tick ): AnchoredDigest['digest'] =>
    ( { willId: WILL, tick, streamHeads: { records: e.hash }, meta: { chain: RECORD_CHAIN, seq: e.seq } } )
  return { entries, digestOf }
}

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    sign:   ed25519Signer( privateKey.export( { type: 'pkcs8', format: 'pem' } ).toString() ),
    verify: ed25519Verifier( publicKey.export( { type: 'spki', format: 'pem' } ).toString() ),
  }
}

describe('verifyRecords', () => {
  it('a whole chain with a digest of its head is ok, and nothing is left unanchored', () => {
    const { entries, digestOf } = kept( 6 )
    const r = verifyRecords( entries, { digests: [ { digest: digestOf( entries[ 2 ]! ) }, { digest: digestOf( entries[ 5 ]! ) } ] } )
    expect( r.ok ).toBe( true )
    expect( r.digests.every( d => d.ok ) ).toBe( true )
    expect( r.anchoredThrough ).toBe( 6 )
    expect( r.unanchored ).toBe( 0 )
  })

  it('what follows the last digest is reported unanchored; with no digests, everything is', () => {
    const { entries, digestOf } = kept( 6 )
    expect( verifyRecords( entries, { digests: [ { digest: digestOf( entries[ 2 ]! ) } ] } ) ).toMatchObject( { ok: true, anchoredThrough: 3, unanchored: 3 } )
    expect( verifyRecords( entries ) ).toMatchObject( { ok: true, anchoredThrough: null, unanchored: 6 } )
  })

  it('a broken chain is not ok, and a digest past the break vouches for nothing', () => {
    const { entries, digestOf } = kept( 6 )
    const head = digestOf( entries[ 5 ]! )
    const edited = entries.map( e => e.seq === 4 ? { ...e, record: { type: 'tick', i: 99 } } : e )
    const r = verifyRecords( edited, { digests: [ { digest: digestOf( entries[ 1 ]! ) }, { digest: head } ] } )
    expect( r.ok ).toBe( false )
    expect( r.chain ).toMatchObject( { valid: false, breakpoint: 4 } )
    expect( r.digests[ 0 ]!.ok ).toBe( true )
    expect( r.digests[ 1 ] ).toMatchObject( { ok: false, reason: expect.stringMatching( /past where the chain breaks/ ) } )
    expect( r.anchoredThrough ).toBe( 2 )
  })

  it('refuses a digest that is not for this chain, this Will, this entry or this tick', () => {
    const { entries, digestOf } = kept( 4 )
    const d = digestOf( entries[ 2 ]! )
    const checks = verifyRecords( entries, { digests: [
      { digest: { ...d, meta: { ...d.meta, chain: 'other/1' } } },
      { digest: { ...d, willId: 'someone-else' } },
      { digest: { ...d, meta: { ...d.meta, seq: 40 } } },
      { digest: { ...d, streamHeads: { records: entries[ 1 ]!.hash } } },
      { digest: { ...d, tick: 1 } },
    ] } ).digests
    expect( checks.map( c => c.ok ) ).toEqual( [ false, false, false, false, false ] )
    expect( checks.map( c => c.reason ) ).toEqual( [
      `not a ${RECORD_CHAIN} digest`,
      `for Will someone-else, not ${WILL}`,
      'names entry 40, which is not in the records',
      "its head is not entry 3's hash",
      'covers tick 1, but entry 3 was chained at tick 2',
    ] )
  })

  it('with a key, every digest must be signed by it over canonical(digest)', () => {
    const { entries, digestOf } = kept( 4 )
    const ours = keys(), theirs = keys()
    const d = digestOf( entries[ 3 ]! )
    const checks = verifyRecords( entries, { verify: ours.verify, digests: [
      { digest: d, signature: ours.sign( canonical( d ) ) },
      { digest: d },
      { digest: d, signature: theirs.sign( canonical( d ) ) },
      { digest: d, signature: ours.sign( canonical( { ...d, tick: 9 } ) ) },
      { digest: d, signature: 'not base64 at all!' },
    ] } ).digests
    expect( checks.map( c => c.ok ) ).toEqual( [ true, false, false, false, false ] )
    expect( checks[ 1 ]!.reason ).toBe('unsigned')
    expect( checks[ 2 ]!.reason ).toBe('the signature does not verify')
  })

  it('a chain kept from part way verifies from the head before it', () => {
    const { entries, digestOf } = kept( 6 )
    const tail = entries.slice( 3 )
    expect( verifyRecords( tail ).chain.valid ).toBe( false )
    const from = { seq: entries[ 2 ]!.seq, hash: entries[ 2 ]!.hash }
    const r = verifyRecords( tail, { from, digests: [ { digest: digestOf( entries[ 4 ]! ) } ] } )
    expect( r ).toMatchObject( { ok: true, anchoredThrough: 5, unanchored: 1 } )
    expect( verifyRecords( tail, { from } ) ).toMatchObject( { anchoredThrough: null, unanchored: 3 } )
  })
})

describe('fileAnchoring', () => {
  it('writes the lines verify reads, and a second life on the same directory continues the chain', async () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-files-') )
    try {
      const { sign, verify } = keys()
      const a = fileAnchoring( dir, { every: 3, sign } )
      expect( a.resume ).toBeUndefined()
      const one = new RecordChain()
      for( const r of [ { chain: RECORD_CHAIN, willId: WILL }, { n: 1 } ] ) a.record( one.append('chain', 0, r ) )
      const head = { willId: WILL, tick: 0, streamHeads: { records: one.head.hash }, meta: { chain: RECORD_CHAIN, seq: one.head.seq } } as const
      let published = 0
      await fileAnchoring( dir, { every: 3, publish: () => { published++ } } ).anchor( head, sign( canonical( head ) ) )
      expect( published ).toBe( 1 )

      const b = fileAnchoring( dir, { every: 3 } )
      expect( b.resume ).toEqual( one.head )
      const two = new RecordChain( b.resume )
      b.record( two.append('chain', 5, { chain: RECORD_CHAIN, willId: WILL, resumed: true } ) )

      const entries = readJsonLines<ChainEntry>( join( dir, RECORDS_FILE ) )
      const digests = readJsonLines<AnchoredDigest>( join( dir, DIGESTS_FILE ) )
      expect( entries.map( e => e.seq ) ).toEqual( [ 1, 2, 3 ] )
      expect( verifyRecords( entries, { digests, verify } ) ).toMatchObject( { ok: true, anchoredThrough: 2, unanchored: 1 } )
      expect( readFileSync( join( dir, DIGESTS_FILE ), 'utf8').trim().split('\n') ).toHaveLength( 1 )
    }
    finally { rmSync( dir, { recursive: true, force: true } ) }
  })

  it('names the line that is not JSON', () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-files-') )
    try {
      const path = join( dir, RECORDS_FILE )
      writeFileSync( path, '{"seq":1}\n\n{oops\n')
      expect( () => readJsonLines( path ) ).toThrow(`${path}:2 is not JSON`)
      expect( readJsonLines( join( dir, 'absent.jsonl') ) ).toEqual( [] )
    }
    finally { rmSync( dir, { recursive: true, force: true } ) }
  })
})

describe('the genesis keeps no secret', () => {
  it('drops every field whose name says it is one, at any depth', () => {
    expect( withoutSecrets( {
      apiKey: 'k', api_key: 'k', nested: { authToken: 't', password: 'p', clientSecret: 's', Authorization: 'a', credentials: 'c', keep: 1 },
      list: [ { token: 'x', name: 'n' } ], model: 'm',
    } ) ).toEqual( { nested: { keep: 1 }, list: [ { name: 'n' } ], model: 'm' } )
  })

  it('keeps the settings of the config and drops its hooks, adapters and key', () => {
    const fn = () => {}
    const config = {
      id: 'w', name: 'W', randomSeed: 4,
      llm: { provider: 'openai', apiKey: 'sk-live', model: 'm', providers: { openai: { apiKey: 'sk-2', baseUrl: 'u' } } },
      anchoring: { every: 1, record: fn, anchor: fn }, transport: { emit: fn }, snapshotStorage: { a: 1 }, vectorMemoryAdapter: { b: 2 },
    }
    const out = startingConfig( config as never )
    expect( out ).toEqual( { id: 'w', name: 'W', randomSeed: 4, llm: { provider: 'openai', model: 'm', providers: { openai: { baseUrl: 'u' } } } } )
    expect( JSON.stringify( out ) ).not.toMatch( /sk-/ )
  })

  it('keeps the WILL_ settings, sorted, and none of their keys', () => {
    expect( startingEnv( { WILL_TICK_MS: '5', WILL_LLM_API_KEY: 'k', WILL_EMBEDDING_API_KEY: 'k', PATH: '/bin', WILL_A: 'a' } ) )
      .toEqual( { WILL_A: 'a', WILL_TICK_MS: '5' } )
    expect( Object.keys( startingEnv( { WILL_Z: '1', WILL_A: '2' } ) ) ).toEqual( [ 'WILL_A', 'WILL_Z' ] )
  })
})

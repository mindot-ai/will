// ─────────────────────────────────────────────────────────────
// tests/unit/record.chain.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING — the record chain as a pure function: the contract it shares
// with VLX, and every way an edit after the fact shows.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  canonical,
  entryHash,
  GENESIS_HASH,
  jsonForm,
  RecordChain,
  recordHash,
  verifyChain,
  type ChainEntry,
} from '#core/record.chain'

/**
 * VLX hash contract v2, asserted on both sides: the same literal is in VLX's
 * hash tests. If this fails, the two implementations of one contract have
 * drifted, and a verifier of one no longer checks the other.
 */
const SHARED_VECTOR = {
  value: {
    stream: 'session', seq: 7, tick: 42, recordHash: 'ab'.repeat( 32 ),
    nested: { 'é': [ 1.5, null, true ], A: '"q"' },
    big: { $bigint: '9007199254740993' },
  },
  canonical: '{"big":"$bigint:9007199254740993","nested":{"A":"\\"q\\"","é":[1.5,null,true]},'
    + '"recordHash":"abababababababababababababababababababababababababababababababab","seq":7,"stream":"session","tick":42}',
  hashFromGenesis: '2c1c4f8949c4d04ea1331767b163496ff01744485090efaeef551a936a0242de',
}

function chainOf( n: number, history = 'ours' ): ChainEntry[] {
  const chain = new RecordChain()
  const out: ChainEntry[] = [ chain.append('chain', 0, { chain: 'will-record/1', willId: 'w', seed: 3, startTick: 0 }) ]
  for( let i = 1; i < n; i++ )
    out.push( chain.append( i % 2 ? 'session' : 'completions', i, { i, text: `${history} entry ${i}` } ) )
  return out
}

describe('record chain — the contract', () => {
  it('canonical JSON is VLX hash contract v2: the shared vector', () => {
    expect( canonical( SHARED_VECTOR.value ) ).toBe( SHARED_VECTOR.canonical )
    const { stream, seq, tick, recordHash: rh } = SHARED_VECTOR.value
    // The material rule: `${prev}:${canonical(body)}`, as VLX's contract writes it.
    expect( GENESIS_HASH ).toBe('0'.repeat( 64 ) )
    const body = { stream: stream as 'session', seq, tick, recordHash: rh }
    expect( entryHash( GENESIS_HASH, body ) )
      .toBe( createHash('sha256').update(`${GENESIS_HASH}:${canonical( body )}`, 'utf8').digest('hex') )
  })

  it('canonical: undefined and null are one fact; a bigint and its wire form are one token', () => {
    expect( canonical( { a: undefined } ) ).toBe( canonical( { a: null } ) )
    expect( canonical( 5n ) ).toBe( canonical( { $bigint: '5' } ) )
    expect( canonical( { $bigint: '5', x: 1 } ) ).toBe('{"$bigint":"5","x":1}')
    expect( canonical( { b: 1, a: [ 2, { d: 1, c: 2 } ] } ) ).toBe('{"a":[2,{"c":2,"d":1}],"b":1}')
  })

  it('an entry hashes prev, stream, seq, tick and the record\'s hash, and nothing else', () => {
    const e = new RecordChain().append('session', 9, { x: 1 })
    expect( e.prev ).toBe( GENESIS_HASH )
    expect( e.seq ).toBe( 1 )
    expect( e.recordHash ).toBe( recordHash( { x: 1 } ) )
    expect( e.hash ).toBe( entryHash( GENESIS_HASH, { stream: 'session', seq: 1, tick: 9, recordHash: recordHash( { x: 1 } ) } ) )
    for( const other of [
      { stream: 'inbound' as const, seq: 1, tick: 9 },
      { stream: 'session' as const, seq: 2, tick: 9 },
      { stream: 'session' as const, seq: 1, tick: 10 },
    ] ) expect( entryHash( GENESIS_HASH, { ...other, recordHash: e.recordHash } ) ).not.toBe( e.hash )
    expect( entryHash('1'.repeat( 64 ), e ) ).not.toBe( e.hash )
  })

  it('a record is chained and handed on in its JSON form, so a stored copy hashes the same', () => {
    const e = new RecordChain().append('session', 1, { a: undefined, m: new Map([[ 'k', 1 ]]), n: Number.NaN, d: new Date( 0 ) })
    expect( e.record ).toEqual( { m: {}, n: null, d: '1970-01-01T00:00:00.000Z' } )
    const stored = JSON.parse( JSON.stringify( e ) ) as ChainEntry
    expect( verifyChain( [ stored ] ).valid ).toBe( true )
  })

  it('a record JSON cannot carry is chained as a statement that it could not be', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect( jsonForm( cyclic ) ).toEqual( { unserializable: expect.any( String ) } )
    expect( jsonForm( { big: 1n } ) ).toEqual( { unserializable: expect.any( String ) } )
    expect( jsonForm( undefined ) ).toBeNull()
    expect( verifyChain( [ new RecordChain().append('session', 1, cyclic ) ] ).valid ).toBe( true )
  })
})

describe('record chain — verification', () => {
  it('an untouched chain verifies, and its head is the last entry\'s', () => {
    const entries = chainOf( 6 )
    expect( verifyChain( entries ) ).toEqual( { valid: true, head: { seq: 6, hash: entries[ 5 ]!.hash } } )
  })

  it('any edit to any field breaks the chain at that entry', () => {
    const edits: Array<( e: ChainEntry ) => ChainEntry> = [
      e => ( { ...e, record: { ...( e.record as object ), text: 'rewritten' } } ),
      e => ( { ...e, recordHash: 'f'.repeat( 64 ) } ),
      e => ( { ...e, tick: e.tick + 1 } ),
      e => ( { ...e, stream: 'inbound' } ),
      e => ( { ...e, hash: 'f'.repeat( 64 ) } ),
      e => ( { ...e, prev: 'f'.repeat( 64 ) } ),
    ]
    for( const edit of edits ){
      const entries = chainOf( 6 )
      entries[ 3 ] = edit( entries[ 3 ]! )
      expect( verifyChain( entries ) ).toMatchObject( { valid: false, breakpoint: 4 } )
    }
  })

  it('renumbering, reordering, dropping or inserting an entry breaks the chain', () => {
    const renumbered = chainOf( 5 )
    renumbered[ 2 ] = { ...renumbered[ 2 ]!, seq: 9 }
    expect( verifyChain( renumbered ) ).toMatchObject( { valid: false, breakpoint: 9 } )

    const reordered = chainOf( 5 )
    ;[ reordered[ 1 ], reordered[ 2 ] ] = [ reordered[ 2 ]!, reordered[ 1 ]! ]
    expect( verifyChain( reordered ).valid ).toBe( false )

    const dropped = chainOf( 5 )
    dropped.splice( 2, 1 )
    expect( verifyChain( dropped ) ).toMatchObject( { valid: false, breakpoint: 4 } )

    const inserted = chainOf( 5 )
    inserted.splice( 2, 0, new RecordChain( { seq: 1, hash: inserted[ 0 ]!.hash } ).append('session', 1, { forged: true }) )
    expect( verifyChain( inserted ).valid ).toBe( false )
  })

  it('a tail spliced from another history breaks at the splice, though each of its entries is whole', () => {
    const ours   = chainOf( 5 )
    const theirs = chainOf( 5, 'theirs' )
    expect( verifyChain( theirs ).valid ).toBe( true )
    expect( verifyChain( [ ...ours.slice( 0, 3 ), ...theirs.slice( 3 ) ] ) ).toMatchObject( { valid: false, breakpoint: 4 } )
  })

  it('a chain continued from the right hash at the wrong position breaks there: seq is position', () => {
    // The hash covers whatever seq an entry claims, so only the count catches
    // an engine that resumed at the wrong place; a digest's `meta.seq` finds
    // its entry by position.
    const first     = chainOf( 3 )
    const misplaced = new RecordChain( { seq: 7, hash: first[ 2 ]!.hash } ).append('session', 4, { x: 1 })
    expect( verifyChain( [ ...first, misplaced ] ) ).toMatchObject( { valid: false, breakpoint: 8 } )
  })

  it('a shredded record still verifies on its hash; a present one must match it', () => {
    const entries = chainOf( 4 ).map( ( e, i ) => {
      if( i !== 2 ) return e
      const { record: _shredded, ...rest } = e
      return rest
    } )
    expect( verifyChain( entries ).valid ).toBe( true )
  })

  it('a chain continued from a head verifies from that head, not from genesis', () => {
    const first = chainOf( 3 )
    const head  = { seq: 3, hash: first[ 2 ]!.hash }
    const next  = new RecordChain( head )
    const rest  = [ next.append('chain', 50, { resumed: true }), next.append('session', 51, { x: 1 }) ]
    expect( rest[ 0 ]!.seq ).toBe( 4 )
    expect( verifyChain( rest, head ).valid ).toBe( true )
    expect( verifyChain( rest ).valid ).toBe( false )
    expect( verifyChain( [ ...first, ...rest ] ).valid ).toBe( true )
  })

  it('the shared vector\'s material hashes as VLX hashes it', () => {
    const material = `${GENESIS_HASH}:${SHARED_VECTOR.canonical}`
    expect( createHash('sha256').update( material, 'utf8').digest('hex') ).toBe( SHARED_VECTOR.hashFromGenesis )
  })
})

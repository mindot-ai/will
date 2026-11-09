// ─────────────────────────────────────────────────────────────
// src/core/record.chain.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING — the record chain: every record a Will produces, hash-chained
// in the order it was produced, so a retroactive edit breaks the chain from that
// point on, and a digest of the head can be anchored where the operator cannot
// rewrite it.
//
// One chain per Will. Each entry names its stream (`session`, `completions`,
// `inbound`, `verdicts`, and the `chain` entry that starts it), so the order
// ACROSS streams is proven, not inferred from ticks.
//
// THE CONTRACT is VLX's hash contract, version 2 — written out here from its
// specification, not imported, so one verifier checks both chains:
//
//   material = `${prev}:${canonical(body)}`
//   hash     = hex(SHA-256(utf8(material)))
//
// with `body = { stream, seq, tick, recordHash }` and
// `recordHash = hex(SHA-256(utf8(canonical(record))))`.
//
// The chain commits to the record's HASH, never its contents. A record's
// contents can be shredded (cognition is draft tier) and the chain still
// verifies; one record can be shown with the hashes after it, never every later
// prompt.
//
// Pure: no clock, no randomness. The caller supplies the tick.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'

/** The contract a chain is built under, named in its first entry and in every digest. */
export const RECORD_CHAIN = 'will-record/1'

/** The predecessor of a chain's first entry — VLX's genesis convention: never null, never a word. */
export const GENESIS_HASH = '0'.repeat( 64 )

export type RecordStream = 'chain' | 'session' | 'completions' | 'inbound' | 'verdicts'

export interface ChainEntry {
  readonly stream:     RecordStream
  /** 1 for a chain's first entry; one more for each entry after it. */
  readonly seq:        number
  /** The simulation tick at which the entry was chained. */
  readonly tick:       number
  readonly prev:       string
  readonly hash:       string
  readonly recordHash: string
  /** The record in its JSON form — exactly what was hashed. Absent once shredded. */
  readonly record?:    unknown
}

/** Where a chain stands: the last entry's position and hash. */
export interface ChainHead {
  readonly seq:  number
  readonly hash: string
}

/**
 * Canonical JSON — VLX hash contract v2. Keys sorted, no whitespace, total on
 * the JSON value domain. `undefined` and `null` both emit `null`. A `bigint`,
 * and its wire form `{ "$bigint": "123" }`, emit the string `"$bigint:123"`.
 * Any change here is a change to the contract and must change it in VLX too;
 * the shared vector in tests/unit/record.chain.test.ts is the check.
 */
export function canonical( value: unknown ): string {
  if( value === undefined || value === null ) return 'null'
  if( typeof value === 'bigint' ) return `"$bigint:${value.toString()}"`
  if( typeof value !== 'object' ) return JSON.stringify( value )
  if( Array.isArray( value ) ) return `[${value.map( canonical ).join(',')}]`

  const obj  = value as Record<string, unknown>
  const wire = obj.$bigint
  if( typeof wire === 'string' && Object.keys( obj ).length === 1 ) return `"$bigint:${wire}"`

  const keys = Object.keys( obj ).sort()
  return `{${keys.map( k => `${JSON.stringify( k )}:${canonical( obj[ k ] )}`).join(',')}}`
}

const sha256 = ( s: string ): string => createHash('sha256').update( s, 'utf8').digest('hex')

/**
 * A record in its JSON form: what a host stores and reads back. Hashing this,
 * and handing on this, is what makes a stored record hash the same after a
 * round trip — an `undefined` field, a `Map`, a `NaN` all mean what JSON makes
 * of them. A record JSON cannot carry (a cycle, a bigint) is chained as a
 * statement that it could not be, so the sequence stays honest.
 */
export function jsonForm( record: unknown ): unknown {
  try {
    const text = JSON.stringify( record )
    return text === undefined ? null : JSON.parse( text )
  }
  catch( err ){
    return { unserializable: ( err as Error )?.message ?? String( err ) }
  }
}

export const recordHash = ( record: unknown ): string => sha256( canonical( record ) )

export function entryHash( prev: string, body: Pick<ChainEntry, 'stream' | 'seq' | 'tick' | 'recordHash'> ): string {
  return sha256(`${prev}:${canonical({ stream: body.stream, seq: body.seq, tick: body.tick, recordHash: body.recordHash })}`)
}

/** Append-only. One per Will; the caller serializes appends (they are synchronous). */
export class RecordChain {
  private _head: ChainHead

  constructor( from: ChainHead = { seq: 0, hash: GENESIS_HASH } ){
    this._head = from
  }

  get head(): ChainHead { return this._head }

  append( stream: RecordStream, tick: number, record: unknown ): ChainEntry {
    const json = jsonForm( record )
    const body = { stream, seq: this._head.seq + 1, tick, recordHash: recordHash( json ) }
    const hash = entryHash( this._head.hash, body )
    const entry: ChainEntry = { ...body, prev: this._head.hash, hash, record: json }
    this._head = { seq: body.seq, hash }
    return entry
  }
}

export type ChainVerification =
  | { readonly valid: true;  readonly head: ChainHead }
  | { readonly valid: false; readonly breakpoint: number; readonly reason: string }

/**
 * Walk entries from `from` (genesis by default), recomputing every hash. A
 * record that is present must hash to its `recordHash`; a shredded one is
 * taken on its hash. Valid only if every entry follows the one before it.
 * Compare the returned head with an anchored digest's to know the records are
 * the ones that were anchored.
 */
export function verifyChain(
  entries: readonly ChainEntry[],
  from:    ChainHead = { seq: 0, hash: GENESIS_HASH },
): ChainVerification {
  let head = from
  for( const e of entries ){
    const broken = ( reason: string ): ChainVerification => ( { valid: false, breakpoint: e.seq, reason } )
    if( e.seq !== head.seq + 1 ) return broken(`expected seq ${head.seq + 1}, found ${e.seq}`)
    if( e.prev !== head.hash ) return broken('prev is not the hash of the entry before it')
    if( e.record !== undefined && recordHash( e.record ) !== e.recordHash ) return broken('the record does not match its recordHash')
    if( entryHash( e.prev, e ) !== e.hash ) return broken('the entry does not match its hash')
    head = { seq: e.seq, hash: e.hash }
  }
  return { valid: true, head }
}

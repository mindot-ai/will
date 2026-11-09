// ─────────────────────────────────────────────────────────────
// tests/integration/verify.cli.test.ts
// ─────────────────────────────────────────────────────────────
//
// `will verify`, on the files a host kept with `fileAnchoring`: the chain, the
// signed digests and, with --replay, the mind re-executed. Exit 0 when every
// check passes, 1 when one fails, 2 on misuse.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Will } from '#surface/sdk/will'
import { fileAnchoring, ed25519Signer, RECORDS_FILE, DIGESTS_FILE } from '#stem/tracts/anchor.files'
import { runVerify } from '#surface/verify'
import { setLogger, resetLogger } from '#core/logger'
import { entryHash, recordHash } from '#core/record.chain'

let dir = '', keyPath = '', otherKey = ''
beforeAll( async () => {
  process.env.WILL_SEMANTIC_RECALL = 'false'
  setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
  dir = mkdtempSync( join( tmpdir(), 'will-verify-') )
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  keyPath = join( dir, 'public.pem')
  writeFileSync( keyPath, publicKey.export( { type: 'spki', format: 'pem' } ) )
  otherKey = join( dir, 'other.pem')
  writeFileSync( otherKey, generateKeyPairSync('ed25519').publicKey.export( { type: 'spki', format: 'pem' } ) )

  const records = join( dir, 'kept')
  const will = await Will.create( { name: 'Ada', identity: { prompt: 'I am Ada.' }, llm: 'mock', seed: 2, tickMs: 15,
    anchoring: fileAnchoring( records, { every: 4, sign: ed25519Signer( privateKey.export( { type: 'pkcs8', format: 'pem' } ).toString() ) } ) } )
  await will.sense( { text: 'Hello there.', from: 'bo', provenance: 'exafferent' } )
  await new Promise( r => setTimeout( r, 150 ) )
  await will.stop()
})
afterAll( () => { resetLogger(); delete process.env.WILL_SEMANTIC_RECALL; rmSync( dir, { recursive: true, force: true } ) } )

async function verify( ...args: string[] ){
  const lines: string[] = []
  const code = await runVerify( args, l => { lines.push( l ) } )
  return { code, out: lines.join('\n') }
}

describe('will verify', () => {
  it('passes a directory whose chain, signatures and replay all check', async () => {
    const { code, out } = await verify( join( dir, 'kept'), '--key', keyPath, '--replay')
    expect( out ).toMatch( /^chain    ok — \d+ entries, 1–\d+$/m )
    expect( out ).toMatch( /^digests  (\d+)\/\1 ok, signatures checked$/m )
    expect( out ).toMatch( /^anchored through entry \d+; 0 after it unanchored$/m )
    expect( out ).toMatch( /^replay   reproduced, entry for entry, through \d+$/m )
    expect( code ).toBe( 0 )
  }, 60_000 )

  it('fails on the wrong key, naming each digest it could not check', async () => {
    const { code, out } = await verify( join( dir, 'kept'), '--key', otherKey )
    expect( code ).toBe( 1 )
    expect( out ).toMatch( /^digests  0\/\d+ ok, signatures checked$/m )
    expect( out ).toMatch( /^ {9}tick \d+, entry \d+: the signature does not verify$/m )
  })

  it('fails on an edited record, where it was edited, and will not replay a broken chain', async () => {
    const lines = readFileSync( join( dir, 'kept', RECORDS_FILE ), 'utf8').trim().split('\n')
    const e = JSON.parse( lines[ 4 ]! )
    lines[ 4 ] = JSON.stringify( { ...e, record: { ...e.record, edited: true } } )
    writeFileSync( join( dir, 'edited.jsonl'), lines.join('\n') + '\n')
    const { code, out } = await verify( join( dir, 'edited.jsonl'), '--digests', join( dir, 'kept', DIGESTS_FILE ), '--replay')
    expect( code ).toBe( 1 )
    expect( out ).toMatch( new RegExp(`^chain    BROKEN at entry ${e.seq}: the record does not match its recordHash$`, 'm') )
    expect( out ).toMatch( /^replay   not run — the chain is broken$/m )
  })

  it('fails when the mind, replayed, does not produce what was recorded — even where the chain was re-hashed to hide it', async () => {
    const lines = readFileSync( join( dir, 'kept', RECORDS_FILE ), 'utf8').trim().split('\n').map( l => JSON.parse( l ) )
    lines[ 0 ].record = { ...lines[ 0 ].record, seed: 99 }
    for( let i = 0; i < lines.length; i++ ){
      const e = lines[ i ]
      if( i > 0 ) e.prev = lines[ i - 1 ].hash
      e.recordHash = recordHash( e.record )
      e.hash = entryHash( e.prev, e )
    }
    writeFileSync( join( dir, 'reforged.jsonl'), lines.map( l => JSON.stringify( l ) ).join('\n') + '\n')
    const { code, out } = await verify( join( dir, 'reforged.jsonl'), '--replay')
    expect( out ).toMatch( /^chain    ok/m )
    expect( out ).toMatch( /^replay   DIVERGED at entry 1: the replay began a different chain$/m )
    expect( code ).toBe( 1 )
  }, 60_000 )

  it('a lone records file has no digests: everything in it is unanchored, and that is said', async () => {
    const { code, out } = await verify( join( dir, 'kept', RECORDS_FILE ) )
    expect( code ).toBe( 0 )
    expect( out ).toMatch( /^digests  none — nothing here is anchored$/m )
    expect( out ).toMatch( /^anchored none of \d+ entries$/m )
  })

  it('misuse exits 2 with the reason', async () => {
    expect( ( await verify() ).code ).toBe( 2 )
    expect( await verify( join( dir, 'nowhere') ) ).toEqual( { code: 2, out: `no records at ${join( dir, 'nowhere')}` } )
    expect( await verify( join( dir, 'kept'), '--from', '3' ) ).toEqual( { code: 2, out: '--from is <seq>:<64 hex hash>' } )
    expect( ( await verify( join( dir, 'kept'), '--key' ) ) ).toMatchObject( { code: 2, out: expect.stringMatching( /^--key needs a value/ ) } )
    expect( ( await verify( join( dir, 'kept'), '--fast' ) ) ).toMatchObject( { code: 2, out: expect.stringMatching( /^unknown option: --fast/ ) } )
  })
})

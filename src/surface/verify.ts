// ─────────────────────────────────────────────────────────────
// src/surface/verify.ts — `will verify`: check a Will's records
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4. Reads the files `fileAnchoring` writes (or any host
// that keeps the same lines) and answers three questions, in order:
//   1. is the chain unbroken?
//   2. does every digest name an entry in it — signed by the host's key, when
//      one is given?
//   3. with --replay: does the mind, re-executed from the chain, produce it?
// Exit 0 when every check asked for passes, 1 when one fails, 2 on misuse.
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChainEntry } from '#core/record.chain'
import { verifyRecords, type AnchoredDigest } from '#core/record.verify'
import { readJsonLines, ed25519Verifier, RECORDS_FILE, DIGESTS_FILE } from '#stem/tracts/anchor.files'
import { replayChain } from '#stem/replay.chain'

export const VERIFY_USAGE = `usage: will verify <dir | records.jsonl> [--digests <file>] [--key <public.pem>] [--from <seq>:<hash>] [--replay]

  <dir>        a directory fileAnchoring wrote: ${RECORDS_FILE} and ${DIGESTS_FILE}
  --digests    the digests, one { digest, signature? } per line (default: beside the records)
  --key        an Ed25519 public key (PEM): every digest must carry a signature it verifies
  --from       the head before the first record kept, for a chain kept from part way
  --replay     re-execute the mind from the chain and check it reproduces, entry for entry`

/** Run the command; returns the exit code. `out` receives the report. */
export async function runVerify( args: readonly string[], out: ( line: string ) => void = console.log ): Promise<number> {
  const flags = new Map<string, string | true>()
  const paths: string[] = []
  for( let i = 0; i < args.length; i++ ){
    const a = args[ i ]!
    if( a === '--replay') flags.set('replay', true )
    else if( a === '--digests' || a === '--key' || a === '--from'){
      const v = args[ ++i ]
      if( v === undefined ){ out(`${a} needs a value\n\n${VERIFY_USAGE}`); return 2 }
      flags.set( a.slice( 2 ), v )
    }
    else if( a.startsWith('--') ){ out(`unknown option: ${a}\n\n${VERIFY_USAGE}`); return 2 }
    else paths.push( a )
  }
  if( paths.length !== 1 ){ out( VERIFY_USAGE ); return 2 }

  const target  = paths[ 0 ]!
  const isDir   = existsSync( join( target, RECORDS_FILE ) )
  const records = isDir ? join( target, RECORDS_FILE ) : target
  if( !existsSync( records ) ){ out(`no records at ${target}`); return 2 }
  const digestsPath = flags.get('digests') as string | undefined ?? ( isDir ? join( target, DIGESTS_FILE ) : undefined )

  let from: { seq: number; hash: string } | undefined
  const fromFlag = flags.get('from') as string | undefined
  if( fromFlag ){
    const m = /^(\d+):([0-9a-f]{64})$/.exec( fromFlag )
    if( !m ){ out('--from is <seq>:<64 hex hash>'); return 2 }
    from = { seq: Number( m[ 1 ] ), hash: m[ 2 ]! }
  }

  let entries: ChainEntry[], digests: AnchoredDigest[], verify: ( ( m: string, s: string ) => boolean ) | undefined
  try {
    entries = readJsonLines<ChainEntry>( records )
    digests = digestsPath ? readJsonLines<AnchoredDigest>( digestsPath ) : []
    const key = flags.get('key') as string | undefined
    verify = key ? ed25519Verifier( readFileSync( key, 'utf8') ) : undefined
  }
  catch( err ){ out(`cannot read: ${err instanceof Error ? err.message : String( err )}`); return 2 }

  const report = verifyRecords( entries, { digests, ...( from ? { from } : {} ), ...( verify ? { verify } : {} ) } )
  const first = entries[ 0 ]?.seq ?? 0, last = entries.at( -1 )?.seq ?? 0
  out( report.chain.valid
    ? `chain    ok — ${report.entries} entries, ${first}–${last}`
    : `chain    BROKEN at entry ${report.chain.breakpoint}: ${report.chain.reason}` )

  const bad = report.digests.filter( d => !d.ok )
  out( report.digests.length === 0
    ? 'digests  none — nothing here is anchored'
    : `digests  ${report.digests.length - bad.length}/${report.digests.length} ok${verify ? ', signatures checked' : ''}` )
  for( const d of bad ) out(`         tick ${d.tick}, entry ${d.seq}: ${d.reason}`)
  out( report.anchoredThrough === null
    ? `anchored none of ${report.entries} entries`
    : `anchored through entry ${report.anchoredThrough}; ${report.unanchored} after it unanchored` )

  let ok = report.ok
  if( flags.has('replay') ){
    if( !report.chain.valid ){ out('replay   not run — the chain is broken'); return 1 }
    const replay = await replayChain( entries )
    if( replay.refused ){ out(`replay   refused: ${replay.refused}`); ok = false }
    else if( replay.reproduced ) out(`replay   reproduced, entry for entry, through ${replay.through}${replay.shredded ? ` (${replay.shredded} shredded, compared by place only)` : ''}`)
    else {
      ok = false
      const d = replay.divergence!
      out(`replay   DIVERGED at entry ${d.seq}: ${d.reason}`)
      if( d.expected !== undefined ) out(`         recorded: ${JSON.stringify( d.expected )}`)
      if( d.produced !== undefined ) out(`         replayed: ${JSON.stringify( d.produced )}`)
    }
  }
  return ok ? 0 : 1
}

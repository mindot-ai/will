// ─────────────────────────────────────────────────────────────
// src/stem/tracts/anchor.files.ts  —  the host side of anchoring, on disk
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4a. `fileAnchoring(dir)` keeps a Will's records and
// digests in exactly the files `will verify` reads, so the format belongs to
// the engine rather than to every host: one entry per line in `records.jsonl`,
// one `{ digest, signature? }` per line in `digests.jsonl`.
//
// Files on the operator's own disk are not a trust root — a digest proves
// nothing until it is published where the operator cannot rewrite it. Pass
// `publish` to send each digest there too (VLX, a public repository).
//
// A Will woken onto the same directory continues the chain from the last entry
// kept, rather than starting a second one in the same file.
// ─────────────────────────────────────────────────────────────

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { ChainEntry, ChainHead } from '#core/record.chain'
import type { AnchoredDigest } from '#core/record.verify'
import type { AnchoringOptions, RecordDigest } from './anchor.controller'

export const RECORDS_FILE = 'records.jsonl'
export const DIGESTS_FILE = 'digests.jsonl'

/** One JSON value per non-empty line. */
export function readJsonLines<T>( path: string ): T[] {
  if( !existsSync( path ) ) return []
  return readFileSync( path, 'utf8').split('\n').filter( l => l.trim() ).map( ( l, i ) => {
    try { return JSON.parse( l ) as T }
    catch { throw new Error(`${path}:${i + 1} is not JSON`) }
  } )
}

export interface FileAnchoringOptions {
  readonly every:    number
  readonly sign?:    ( material: string ) => string
  /** Also publish each digest somewhere the operator cannot rewrite. Not awaited. */
  readonly publish?: ( digest: RecordDigest, signature?: string ) => void | Promise<void>
}

export function fileAnchoring( dir: string, opts: FileAnchoringOptions ): AnchoringOptions {
  mkdirSync( dir, { recursive: true } )
  const records = join( dir, RECORDS_FILE )
  const digests = join( dir, DIGESTS_FILE )
  const last    = readJsonLines<ChainEntry>( records ).at( -1 )
  const resume: ChainHead | undefined = last ? { seq: last.seq, hash: last.hash } : undefined

  return {
    every:  opts.every,
    ...( opts.sign ? { sign: opts.sign } : {} ),
    ...( resume ? { resume } : {} ),
    record: entry => { appendFileSync( records, JSON.stringify( entry ) + '\n') },
    anchor: ( digest, signature ) => {
      const line: AnchoredDigest = signature === undefined ? { digest } : { digest, signature }
      appendFileSync( digests, JSON.stringify( line ) + '\n')
      return opts.publish?.( digest, signature )
    },
  }
}

/** Sign `canonical(digest)` with an Ed25519 private key (PEM). Base64 out. */
export function ed25519Signer( privateKeyPem: string ): ( material: string ) => string {
  const key = createPrivateKey( privateKeyPem )
  return material => sign( null, Buffer.from( material, 'utf8'), key ).toString('base64')
}

/** Check a base64 signature with an Ed25519 public key (PEM). */
export function ed25519Verifier( publicKeyPem: string ): ( material: string, signature: string ) => boolean {
  const key = createPublicKey( publicKeyPem )
  return ( material, signature ) => verify( null, Buffer.from( material, 'utf8'), key, Buffer.from( signature, 'base64') )
}

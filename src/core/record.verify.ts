// ─────────────────────────────────────────────────────────────
// src/core/record.verify.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4a — what `will verify` checks, without replay: that
// the records a host kept form an unbroken chain, that every digest it was
// handed names an entry in that chain, and, given the host's public key, that
// the host signed each one.
//
// Pure: it reads no clock and no file. Verifying a signature is the caller's
// to supply, so this stays free of any key format.
// ─────────────────────────────────────────────────────────────

import {
  canonical, GENESIS_HASH, RECORD_CHAIN, verifyChain,
  type ChainEntry, type ChainHead, type ChainVerification,
} from '#core/record.chain'

/** A digest as `anchor()` was handed it, with the signature if one was made. */
export interface AnchoredDigest {
  readonly digest: {
    readonly willId:      string
    readonly tick:        number
    readonly streamHeads: { readonly records: string }
    readonly meta:        { readonly chain: string; readonly seq: number }
  }
  readonly signature?: string
}

export interface DigestCheck {
  readonly tick:    number
  readonly seq:     number
  readonly ok:      boolean
  readonly reason?: string
}

export interface RecordsReport {
  /** The chain verified and every digest checked. */
  readonly ok:              boolean
  readonly entries:         number
  readonly chain:           ChainVerification
  readonly digests:         readonly DigestCheck[]
  /** The last entry a good digest covers; `null` when none does. */
  readonly anchoredThrough: number | null
  /** Entries after it: what could still be rewritten without detection. */
  readonly unanchored:      number
}

export interface VerifyOptions {
  /** Where a continued chain's records begin: the head before the first one kept. */
  readonly from?:   ChainHead
  readonly digests?: readonly AnchoredDigest[]
  /**
   * Checks a signature over `canonical(digest)`. When given, every digest must
   * carry one that it accepts.
   */
  readonly verify?: ( material: string, signature: string ) => boolean
}

export function verifyRecords( entries: readonly ChainEntry[], opts: VerifyOptions = {} ): RecordsReport {
  const chain = verifyChain( entries, opts.from ?? { seq: 0, hash: GENESIS_HASH } )
  // Only entries before a break are vouched for.
  const goodThrough = chain.valid ? chain.head.seq : chain.breakpoint - 1
  const bySeq  = new Map( entries.map( e => [ e.seq, e ] ) )
  const willId = willIdOf( entries )

  const digests = ( opts.digests ?? [] ).map( ( { digest, signature } ): DigestCheck => {
    const tick = digest?.tick, seq = digest?.meta?.seq
    const bad  = ( reason: string ): DigestCheck => ( { tick, seq, ok: false, reason } )

    if( digest?.meta?.chain !== RECORD_CHAIN ) return bad(`not a ${RECORD_CHAIN} digest`)
    if( willId !== null && digest.willId !== willId ) return bad(`for Will ${digest.willId}, not ${willId}`)
    const entry = bySeq.get( seq )
    if( !entry ) return bad(`names entry ${seq}, which is not in the records`)
    if( seq > goodThrough ) return bad(`names entry ${seq}, past where the chain breaks`)
    if( entry.hash !== digest.streamHeads?.records ) return bad(`its head is not entry ${seq}'s hash`)
    if( entry.tick > tick ) return bad(`covers tick ${tick}, but entry ${seq} was chained at tick ${entry.tick}`)
    if( opts.verify ){
      if( !signature ) return bad('unsigned')
      let valid = false
      try { valid = opts.verify( canonical( digest ), signature ) }
      catch { valid = false }
      if( !valid ) return bad('the signature does not verify')
    }
    return { tick, seq, ok: true }
  } )

  const anchoredThrough = digests.reduce<number | null>( ( max, d ) => d.ok && ( max === null || d.seq > max ) ? d.seq : max, null )
  const last = entries.at( -1 )?.seq ?? opts.from?.seq ?? 0
  return {
    ok:         chain.valid && digests.every( d => d.ok ),
    entries:    entries.length,
    chain,
    digests,
    anchoredThrough,
    unanchored: last - ( anchoredThrough ?? opts.from?.seq ?? 0 ),
  }
}

/** The Will a chain belongs to, as its first `chain` entry names it. */
function willIdOf( entries: readonly ChainEntry[] ): string | null {
  for( const e of entries ){
    const id = e.stream === 'chain' ? ( e.record as { willId?: unknown } | undefined )?.willId : undefined
    if( typeof id === 'string') return id
  }
  return null
}

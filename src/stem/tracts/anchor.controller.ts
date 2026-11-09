// ─────────────────────────────────────────────────────────────
// src/stem/tracts/anchor.controller.ts  —  per-Will record chain + digests
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING steps 1–3. A Will configured with `anchoring` chains every
// record it produces — session log, LLM completions, inbound envelopes, policy
// verdicts — into one record chain, hands each entry to the host to persist,
// and every `every` ticks hands the host a digest of the chain's head to anchor
// somewhere the operator cannot rewrite.
//
// Off the mind's path by construction:
//   • nothing here writes simulation state, and the chain reads no clock but
//     the simulation's tick, so a replay is byte-identical with anchoring on;
//   • `anchor` is called without being awaited — the tick loop never waits on
//     a network — and its failure is the host's to hear, never the mind's.
//
// Ticks are the SIMULATION clock's, the axis an act's `PolicyInvocation.tick`
// is on. The harness `tickCount` restarts at 0 in every process; the simulation
// clock resumes from the snapshot, and a digest compared with an act must be on
// the act's axis.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { canonical, RECORD_CHAIN, RecordChain, type ChainEntry, type ChainHead } from '#core/record.chain'
import { clearRecordTap, setRecordTap } from '#core/record.tap'
import type { WillInstance } from '#stem/index'

/** What is anchored: the shape VLX takes a Will digest in, with the one chain's head. */
export interface RecordDigest {
  readonly willId:      string
  /** The simulation tick: everything chained up to the end of this tick's step is covered. */
  readonly tick:        number
  readonly streamHeads: { readonly records: string }
  readonly meta:        { readonly chain: typeof RECORD_CHAIN; readonly seq: number }
}

export interface AnchoringOptions {
  /** A digest every this many ticks, besides the first tick, a pause and the end. */
  readonly every: number
  /**
   * Every chained entry, synchronously and in order. Persist it: a digest
   * proves the records only to someone who has them.
   */
  readonly record: ( entry: ChainEntry ) => void
  /** Publish a digest where the operator cannot rewrite it. Not awaited. */
  readonly anchor: ( digest: RecordDigest, signature?: string ) => void | Promise<void>
  /** Sign `canonical(digest)` with a key the host holds. The engine never sees one. */
  readonly sign?:  ( material: string ) => string
  /** The head this Will's chain last reached, to continue it rather than begin anew. */
  readonly resume?: ChainHead
}

const isHash = ( v: unknown ) => typeof v === 'string' && /^[0-9a-f]{64}$/.test( v )

/** Refuse options that would anchor nothing, or anchor something unverifiable. */
export function checkAnchoring( o: AnchoringOptions ): AnchoringOptions {
  if( !Number.isInteger( o.every ) || o.every < 1 ) throw new Error('anchoring.every is a positive whole number of ticks')
  if( typeof o.record !== 'function') throw new Error('anchoring.record persists every entry; a digest proves nothing without them')
  if( typeof o.anchor !== 'function') throw new Error('anchoring.anchor publishes the digests')
  if( o.sign !== undefined && typeof o.sign !== 'function') throw new Error('anchoring.sign is a function of the material')
  if( o.resume !== undefined && !( Number.isInteger( o.resume.seq ) && o.resume.seq >= 0 && isHash( o.resume.hash ) ) )
    throw new Error('anchoring.resume is the head a chain reached: { seq, hash }')
  return o
}

interface Anchored {
  readonly chain:   RecordChain
  readonly opts:    AnchoringOptions
  lastDigestTick:   number | null
}

export class AnchorController {
  private readonly _anchored = new Map<string, Anchored>()

  /**
   * Begin (or continue) this Will's chain, before anything is logged. A no-op
   * for a Will without `anchoring`.
   */
  attach( instance: WillInstance ): void {
    const o = instance.config.anchoring
    if( !o ) return
    const id      = instance.config.id
    const chain   = new RecordChain( o.resume )
    const a: Anchored = { chain, opts: o, lastDigestTick: null }
    this._anchored.set( id, a )

    this._append( instance, a, 'chain', {
      chain:     RECORD_CHAIN,
      willId:    id,
      seed:      instance.config.randomSeed ?? null,
      startTick: this._tick( instance ),
      ...( o.resume ? { resumed: true } : {} ),
    } )
    setRecordTap( id, ( stream, record ) => this._append( instance, a, stream, record ) )
  }

  /**
   * After a tick: a digest on the first one, so the mind is anchored before
   * its first act, then every `every` ticks.
   */
  afterTick( instance: WillInstance ): void {
    const a = this._anchored.get( instance.config.id )
    if( !a ) return
    const tick = this._tick( instance )
    if( a.lastDigestTick === null || tick - a.lastDigestTick >= a.opts.every ) this._digest( instance, a, tick )
  }

  /** A digest now: at a pause, and at the end, after the session's last entry. */
  seal( instance: WillInstance ): void {
    const a = this._anchored.get( instance.config.id )
    if( a ) this._digest( instance, a, this._tick( instance ) )
  }

  /** Stop chaining: the Will is gone. */
  detach( instance: WillInstance ): void {
    clearRecordTap( instance.config.id )
    this._anchored.delete( instance.config.id )
  }

  private _tick( instance: WillInstance ): number {
    return instance.simulation.clock.currentTick
  }

  private _append( instance: WillInstance, a: Anchored, stream: ChainEntry['stream'], record: unknown ): void {
    const entry = a.chain.append( stream, this._tick( instance ), record )
    // A host that fails to persist an entry has a chain it cannot verify from
    // here on — detectable, and the host's to hear. It must not stop the mind.
    try { a.opts.record( entry ) }
    catch( err ){ logger.error(`[anchor] record() threw for ${instance.config.id} at seq ${entry.seq}:`, err ) }
  }

  private _digest( instance: WillInstance, a: Anchored, tick: number ): void {
    a.lastDigestTick = tick
    const head = a.chain.head
    const digest: RecordDigest = {
      willId:      instance.config.id,
      tick,
      streamHeads: { records: head.hash },
      meta:        { chain: RECORD_CHAIN, seq: head.seq },
    }
    let signature: string | undefined
    try { signature = a.opts.sign?.( canonical( digest ) ) }
    catch( err ){
      // An unsigned digest is still a digest; a missing signature is visible to
      // whoever checks for one.
      logger.error(`[anchor] sign() threw for ${instance.config.id} at tick ${tick}:`, err )
    }
    void Promise.resolve()
      .then( () => a.opts.anchor( digest, signature ) )
      .catch( err => logger.error(`[anchor] anchor() failed for ${instance.config.id} at tick ${tick}:`, err ) )
  }
}

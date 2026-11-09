// ─────────────────────────────────────────────────────────────
// src/stem/replay.chain.ts  —  re-execute a mind from its record chain
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4b. The chain holds everything that reached a mind —
// its starting state, every host input, every oracle answer, every step of
// its clock — in the order it reached it, beside everything the mind produced.
// A replay raises the same mind from the genesis, hands each input back at its
// place, and checks that the mind produces the same outputs, entry by entry.
//
// WHEN AN ANSWER IS HANDED BACK. A live mind's oracles answer at wall-clock
// moments, and when an answer reaches the mind decides what it does with it.
// The chain records that moment as the answer's place. So an answer is handed
// back only once everything before it has been reproduced, and:
//   • at once, if it arrived inside a step (between a `clock` entry and the
//     step's `tick` entry) or was a mock answer, which a live call returns
//     before anything after it runs;
//   • otherwise between ticks, where it arrived, letting its work settle
//     before the next answer or tick.
//
// Nothing here calls a model, an embedder or an arbiter: a request with no
// recorded answer is a divergence.
// ─────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical, jsonForm, RECORD_CHAIN, verifyChain, type ChainEntry } from '#core/record.chain'
import { setCompletionSource, clearCompletionSource, type LLMCompletionRecord } from '#core/completion.recorder'
import { setInboundSource, clearInboundSource, type InboundRecord } from '#core/inbound.recorder'
import { setRecallSource, clearRecallSource, type RecallRecord } from '#core/recall.source'
import { setVerdictSource, clearVerdictSource, type PolicyVerdictRecord } from '#stem/policy/verdict.recorder'
import type { ClockStep } from '#core/clock'
import { setLogger, resetLogger, type Logger } from '#core/logger'
import { WillStem } from '#stem/index'
import type { WillConfig } from '#stem/mind'
import type { PMASnapshot } from '#pma/index'

/** Fields of a session record that read the wall clock: not compared. */
export const WALL_FIELDS: readonly string[] = [ 'wallTime', 'startedAt', 'resumedAt', 'durationMs', 'latencyMs' ]

/** Streams whose records reached the mind; every other one, it produced. */
const INPUTS = new Set<ChainEntry['stream']>( [ 'chain', 'completions', 'inbound', 'verdicts', 'recall', 'clock' ] )

export interface ReplayDivergence {
  readonly seq:       number
  readonly reason:    string
  readonly expected?: unknown
  readonly produced?: unknown
}

export interface ReplayReport {
  /** Every entry of the original was reproduced. */
  readonly reproduced: boolean
  /** The last entry reproduced. */
  readonly through:    number
  /** The original's last entry. */
  readonly last:       number
  readonly divergence?: ReplayDivergence
  /** Outputs whose record was shredded: compared by stream and tick only. */
  readonly shredded:   number
  /** Why the chain could not be replayed at all. */
  readonly refused?:   string
}

export interface ReplayOptions {
  /** Longest a tick may run before the replay is called stalled. Default 30 s. */
  readonly stallMs?: number
  /** Keep the engine's own logging. Off by default: a replay is a check, not a run. */
  readonly verbose?: boolean
}

type Rec = Record<string, unknown>
const rec = ( e: ChainEntry | undefined ): Rec => ( e?.record ?? {} ) as Rec

/** A session record without the fields that read the wall. */
function steady( record: unknown ): string {
  if( !record || typeof record !== 'object' || Array.isArray( record ) ) return canonical( record )
  const out: Rec = {}
  for( const [ k, v ] of Object.entries( record as Rec ) ) if( !WALL_FIELDS.includes( k ) ) out[ k ] = v
  return canonical( out )
}

/**
 * Whether each entry reached the mind between ticks — after a step's `tick`
 * session entry and before the next `clock` entry — and so is handed back at
 * the boundary rather than at once. A mock answer never is: a live mock call
 * returned it before anything after it ran.
 */
export function arrivedBetweenTicks( entries: readonly ChainEntry[] ): Map<number, boolean> {
  const between = new Map<number, boolean>()
  let inStep = false
  for( const e of entries ){
    if( e.stream === 'clock') inStep = true
    else if( e.stream === 'session' && rec( e ).type === 'tick') inStep = false
    else if( e.stream === 'chain') inStep = false
    between.set( e.seq, !inStep && rec( e ).mock !== true )
  }
  return between
}

/**
 * Hands each input back at its place. `through` is the last original entry
 * the replay has reproduced; an input is due once everything before it is.
 */
export class Schedule {
  through: number
  private readonly _held: Array<{ seq: number; between: boolean; release: () => void }> = []

  constructor( start: number ){ this.through = start }

  due( seq: number ): boolean { return this.through >= seq - 1 }

  /** Now if it may be, else a promise settled when its place comes. */
  hold<T>( entry: ChainEntry, between: boolean, value: T ): T | Promise<T> {
    if( this.due( entry.seq ) && !between ) return value
    return new Promise<T>( resolve => this._held.push( { seq: entry.seq, between, release: () => resolve( value ) } ) )
  }

  /** The replay reproduced one more entry: hand over what that makes due inside a step. */
  advance( seq: number ): void {
    this.through = seq
    for( const h of [ ...this._held ] )
      if( !h.between && this.due( h.seq ) ){ this._held.splice( this._held.indexOf( h ), 1 ); h.release() }
  }

  /**
   * Between ticks: hand over the answer that arrived here next, if it is due.
   * Only the next entry can be due, so there is at most one.
   */
  releaseBetween(): boolean {
    const h = this._held.find( x => x.between && this.due( x.seq ) )
    if( !h ) return false
    this._held.splice( this._held.indexOf( h ), 1 )
    h.release()
    return true
  }
}

/**
 * Re-execute the mind whose chain `entries` is, and report the first place it
 * does not reproduce. `entries` begins at a genesis: a chain's first entry, or
 * the entry a woken Will continued it with. A chain a mind continued across
 * processes holds one genesis per process; each is replayed from its own, in
 * order, since each was a mind raised afresh from its starting state.
 */
export async function replayChain( entries: readonly ChainEntry[], opts: ReplayOptions = {} ): Promise<ReplayReport> {
  const starts = entries.flatMap( ( e, i ) => e.stream === 'chain' && rec( e ).chain === RECORD_CHAIN ? [ i ] : [] )
  if( starts[ 0 ] !== 0 ) return replaySegment( entries, opts )
  let shredded = 0
  let report: ReplayReport | undefined
  for( const [ n, at ] of starts.entries() ){
    report = await replaySegment( entries.slice( at, starts[ n + 1 ] ), opts )
    shredded += report.shredded
    if( !report.reproduced ) break
  }
  return { ...report!, last: entries.at( -1 )!.seq, shredded }
}

async function replaySegment( entries: readonly ChainEntry[], opts: ReplayOptions ): Promise<ReplayReport> {
  const first = entries[ 0 ]
  const last  = entries.at( -1 )?.seq ?? 0
  const refuse = ( refused: string ): ReplayReport => ( { reproduced: false, through: ( first?.seq ?? 1 ) - 1, last, shredded: 0, refused } )

  if( !first ) return refuse('there are no records')
  const verified = verifyChain( entries, { seq: first.seq - 1, hash: first.prev } )
  if( !verified.valid ) return refuse(`the chain breaks at entry ${verified.breakpoint}: ${verified.reason}`)
  const genesis = rec( first )
  if( first.stream !== 'chain' || genesis.chain !== RECORD_CHAIN ) return refuse(`entry ${first.seq} does not begin a ${RECORD_CHAIN} chain`)
  if( !genesis.config || typeof genesis.config !== 'object') return refuse('the genesis does not carry the starting config; it was chained before replay could read one')
  const restored = genesis.restored as { tick: number } | null | undefined
  if( restored ) return refuse(`the mind began from a stored snapshot at tick ${restored.tick}; the chain holds its hash, not the snapshot`)

  // ── Where each input reached the mind ─────────────────────
  const bySeq   = new Map( entries.map( e => [ e.seq, e ] ) )
  const between = arrivedBetweenTicks( entries )
  const unused = ( stream: ChainEntry['stream'] ) => entries.filter( e => e.stream === stream )

  const schedule = new Schedule( first.seq - 1 )
  let divergence: ReplayDivergence | undefined
  let shredded = 0, activity = 0
  const diverge = ( d: ReplayDivergence ) => { divergence ??= d }

  // ── The replay's own chain, compared as it grows ──────────
  const onEntry = ( e: ChainEntry ) => {
    activity++
    if( divergence || schedule.through >= last ) return
    const want = bySeq.get( e.seq )
    if( !want ) return diverge( { seq: e.seq, reason: 'the replay produced an entry the original does not have' } )
    if( e.stream !== want.stream ) return diverge( { seq: e.seq, reason: `the original has a ${want.stream} entry here; the replay produced ${e.stream}`, expected: want.record, produced: e.record } )
    if( e.tick !== want.tick ) return diverge( { seq: e.seq, reason: `chained at tick ${e.tick}, not ${want.tick}`, expected: want.record, produced: e.record } )

    if( e.seq === first.seq ){
      // The genesis: the same mind, from the same place. Its config is the one
      // the replay was raised from, adjusted to run offline.
      const g = rec( e )
      if( g.willId !== genesis.willId || g.seed !== genesis.seed || g.startTick !== genesis.startTick || !!g.resumed !== !!genesis.resumed )
        return diverge( { seq: e.seq, reason: 'the replay began a different chain', expected: want.record, produced: e.record } )
    }
    else if( INPUTS.has( e.stream ) ){
      if( e.recordHash !== want.recordHash ) return diverge( { seq: e.seq, reason: `the ${e.stream} input differs`, expected: want.record, produced: e.record } )
    }
    else if( want.record === undefined ) shredded++
    else if( steady( e.record ) !== steady( want.record ) )
      return diverge( { seq: e.seq, reason: `the mind produced a different ${e.stream} record`, expected: want.record, produced: e.record } )

    schedule.advance( e.seq )
  }

  // ── The inputs, handed back ───────────────────────────────
  const willId = String( genesis.willId )
  const taken  = new Set<number>()
  const take   = <T>( stream: ChainEntry['stream'], match: ( r: Rec ) => boolean ): ChainEntry | undefined => {
    const e = unused( stream ).find( x => !taken.has( x.seq ) && match( rec( x ) ) )
    if( e ) taken.add( e.seq )
    return e
  }
  const noAnswer = ( what: string ) => {
    diverge( { seq: schedule.through + 1, reason: `the replay asked for ${what}, which the original never answered` } )
    return Promise.reject( new Error('replay diverged') )
  }

  setCompletionSource( willId, {
    nextCompletion: ( tick, systemPrompt, userMessage ) => {
      activity++
      const e = take('completions', r => r.tick === tick && r.systemPrompt === systemPrompt && r.userMessage === userMessage )
      if( !e ) return noAnswer(`a model completion at tick ${tick}`)
      return schedule.hold( e, between.get( e.seq )!, e.record as LLMCompletionRecord )
    },
  } )
  setRecallSource( willId, {
    nextRecall: query => {
      activity++
      const asked = canonical( jsonForm( query ) )
      const e = take('recall', r => canonical( r.query ) === asked )
      if( !e ) return noAnswer('a recall')
      return Promise.resolve( schedule.hold( e, between.get( e.seq )!, e.record as RecallRecord ) )
    },
  } )
  setVerdictSource( willId, {
    verdictFor: ( tick, intentId ) => {
      activity++
      const e = take('verdicts', r => r.tick === tick && r.intentId === intentId )
      return e ? schedule.hold( e, between.get( e.seq )!, e.record as PolicyVerdictRecord ) : undefined
    },
  } )
  setInboundSource( willId, {
    recordsAt: tick => unused('inbound').filter( e => !taken.has( e.seq ) && ( rec( e ) as unknown as InboundRecord ).tick === tick )
      .map( e => { taken.add( e.seq ); return e.record as InboundRecord } ),
  } )
  const steps = () => {
    const e = take('clock', () => true )
    if( !e ){ diverge( { seq: schedule.through + 1, reason: 'the replay took a step the original did not' } ); return { now: 0, delta: 0 } }
    return e.record as ClockStep
  }

  // ── The mind, raised offline from its starting state ──────
  const savedEnv = { ...process.env }
  const dataDir  = mkdtempSync( join( tmpdir(), 'will-replay-') )
  for( const k of Object.keys( process.env ) ) if( k.startsWith('WILL_') ) delete process.env[ k ]
  Object.assign( process.env, genesis.env ?? {}, {
    WILL_DATA_DIR:  dataDir,
    WILL_FILE_LOGS: 'false',
    ...( genesis.recall
      ? { WILL_VECTOR_MEMORY: 'mock' }   // the index is never searched: recall is handed back
      : { WILL_SEMANTIC_RECALL: 'false', WILL_EMBEDDING_MODEL: 'none', WILL_VECTOR_MEMORY: '' } ),
  } )
  if( !opts.verbose ) setLogger( quiet )

  const config = {
    ...( genesis.config as WillConfig ),
    persistentMemory: false,
    snapshotStorage:  undefined,
    stopTimeoutMs:    2_000,
    anchoring: {
      every:  Number.MAX_SAFE_INTEGER,
      record: onEntry,
      anchor: () => {},
      ...( first.seq > 1 ? { resume: { seq: first.seq - 1, hash: first.prev } } : {} ),
    },
  } as WillConfig

  // A mind woken from an artifact starts paused and is resumed after it loads.
  const firstTick = entries.findIndex( e => e.stream === 'clock')
  const startsPaused = entries.slice( 1, firstTick < 0 ? undefined : firstTick ).some( e => rec( e ).lifecycle === 'resume')

  const stem = new WillStem()
  let archived = false
  const settle = async () => {
    let seen = -1, still = 0
    for( let i = 0; i < 200 && still < 3; i++ ){
      await new Promise<void>( r => setImmediate( r ) )
      still = activity === seen ? still + 1 : 0
      seen  = activity
    }
  }
  const within = async ( work: Promise<void>, what: string ) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<'stalled'>( r => { timer = setTimeout( () => r('stalled'), opts.stallMs ?? 30_000 ) } )
    try {
      if( await Promise.race( [ work.then( () => 'done' as const ), stalled ] ) === 'stalled')
        diverge( { seq: schedule.through + 1, reason: `${what} never finished: the replay is waiting on an input the original does not hand it here` } )
    }
    finally { clearTimeout( timer ) }
  }

  try {
    await stem.createWill( config, startsPaused, { manual: true, steps } )

    while( !divergence && schedule.through < last ){
      if( schedule.releaseBetween() ){ await settle(); continue }

      const next = bySeq.get( schedule.through + 1 )!
      const r    = rec( next )
      if( next.stream === 'chain' && r.loaded === 'pma'){ stem.loadPMA( willId, r.pma as PMASnapshot ); await settle(); continue }
      if( next.stream === 'chain' && r.lifecycle === 'pause'){ stem.pauseWill( willId ); await settle(); continue }
      if( next.stream === 'chain' && r.lifecycle === 'resume'){ stem.resumeWill( willId ); await settle(); continue }
      if( next.stream === 'chain' && r.lifecycle === 'archive'){
        // Answers that arrive while an archive settles are handed over as it waits.
        const done = stem.archiveWill( willId ).then( () => { archived = true } )
        while( !archived && !divergence ){
          if( !schedule.releaseBetween() ) await new Promise<void>( r => setImmediate( r ) )
          else await settle()
        }
        await within( done, 'the archive')
        continue
      }
      if( next.stream === 'clock' || next.stream === 'inbound'){
        await within( stem.runTick( willId ), `the tick at ${next.tick}`)
        await settle()
        continue
      }
      const before = schedule.through
      await settle()
      if( schedule.through === before && !schedule.releaseBetween() )
        diverge( { seq: next.seq, reason: `the original has a ${next.stream} entry here; the replay produced nothing`, expected: next.record } )
    }
  }
  catch( err ){
    diverge( { seq: schedule.through + 1, reason: `the replay failed: ${err instanceof Error ? err.message : String( err )}` } )
  }
  finally {
    if( !archived ) await stem.archiveWill( willId ).catch( () => {} )
    for( const clear of [ clearCompletionSource, clearRecallSource, clearVerdictSource, clearInboundSource ] ) clear( willId )
    if( !opts.verbose ) resetLogger()
    for( const k of Object.keys( process.env ) ) if( !( k in savedEnv ) ) delete process.env[ k ]
    Object.assign( process.env, savedEnv )
    rmSync( dataDir, { recursive: true, force: true } )
  }

  return {
    reproduced: !divergence && schedule.through >= last,
    through:    schedule.through,
    last,
    ...( divergence ? { divergence } : {} ),
    shredded,
  }
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

// ─────────────────────────────────────────────────────────────
// src/stem/tracts/replay.controller.ts  —  per-Will record/replay subsystem
// ─────────────────────────────────────────────────────────────
//
// ReplayController owns the record/replay machinery extracted from
// WillStem (R5-a): the ReplayManager, the set of active recorders, the
// completed-replay metadata cache, and the on-disk replay paths — all
// keyed by Will id. WillStem delegates its start/stop/getMeta/list/compare
// replay methods here, so the god-object no longer owns this concern.
//
// Behaviour is preserved verbatim from the original WillStem methods;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ReplayManager,
  type DefaultReplayRecorder,
  type ReplayMetadata,
  type ReplayComparison,
} from '#core/replay'
import { setCompletionRecorder, clearCompletionRecorder } from '#core/completion.recorder'
import { setInboundRecorder, clearInboundRecorder } from '#core/inbound.recorder'
import type { WillInstance } from '#stem/index'

export class ReplayController {
  private readonly _replayManager    = new ReplayManager()
  private readonly _activeRecorders  = new Map<string, { runId: string; unsub: () => void; recorder: DefaultReplayRecorder }>()
  private readonly _completedReplays = new Map<string, ReplayMetadata>()
  private readonly _replayPaths      = new Map<string, string>()

  /**
   * Begin recording the given Will's ticks (and LLM completions) into a new
   * replay run. Returns the run id. The caller is responsible for resolving
   * `instance` (and thereby validating the Will exists) before calling.
   */
  start( id: string, instance: WillInstance ): string {
    if( this._activeRecorders.has( id ) )
      throw new Error(`Replay already active for Will: ${id}`)

    const runId    = `replay-${Date.now()}-${Math.random().toString(36).slice( 2, 8 )}`

    // Pre-create the replay dir so flush() can persist segments incrementally
    // (stop() saves the consolidated file into the same dir).
    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const dir     = join( dataDir, 'wills', id, 'replays')
    mkdirSync( dir, { recursive: true } )

    const recorder = this._replayManager.createRecorder( id, runId, undefined, {
      flushBasePath: join( dir, runId ),
    })

    const unsub = ( instance.simulation.orchestrator as any ).onAfterTick(
      ( tick: number ) => recorder.recordTick( tick, [] )
    )

    // Route this Will's LLM completions + external inbound into the recorder
    // while recording is active (both are non-deterministic inputs for replay).
    setCompletionRecorder( id, recorder )
    setInboundRecorder( id, recorder )

    this._activeRecorders.set( id, { runId, unsub, recorder } )
    return runId
  }

  async stop( id: string ): Promise<ReplayMetadata> {
    const active = this._activeRecorders.get( id )
    if( !active ) throw new Error(`No active replay for Will: ${id}`)

    active.unsub()
    clearCompletionRecorder( id )
    clearInboundRecorder( id )
    this._activeRecorders.delete( id )

    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const dir     = join( dataDir, 'wills', id, 'replays')
    mkdirSync( dir, { recursive: true } )

    const path = join( dir, `${active.runId}.json`)
    await active.recorder.save( path )

    const meta = active.recorder.getMetadata()
    const key  = `${id}:${active.runId}`
    this._completedReplays.set( key, meta )
    this._replayPaths.set( key, path )

    return meta
  }

  getMeta( id: string, runId: string ): ReplayMetadata | null {
    const active = this._activeRecorders.get( id )
    if( active?.runId === runId ) return active.recorder.getMetadata()

    const key    = `${id}:${runId}`
    const cached = this._completedReplays.get( key )
    if( cached ) return cached

    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const path    = join( dataDir, 'wills', id, 'replays', `${runId}.json`)
    if( !existsSync( path ) ) return null

    try {
      const meta = ( JSON.parse( readFileSync( path, 'utf8') ) as { metadata: ReplayMetadata } ).metadata
      this._completedReplays.set( key, meta )
      this._replayPaths.set( key, path )
      return meta
    } catch {
      return null
    }
  }

  list( id: string ): ReplayMetadata[] {
    const results: ReplayMetadata[] = []
    const prefix  = `${id}:`

    const active = this._activeRecorders.get( id )
    if( active ) results.push( active.recorder.getMetadata() )

    for( const [ key, meta ] of this._completedReplays )
      if( key.startsWith( prefix ) ) results.push( meta )

    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const dir     = join( dataDir, 'wills', id, 'replays')

    if( existsSync( dir ) ){
      const inMem = new Set(
        [ ...this._completedReplays.keys() ]
          .filter( k => k.startsWith( prefix ) )
          .map( k => k.slice( prefix.length ) )
      )
      if( active ) inMem.add( active.runId )

      for( const file of readdirSync( dir ) ){
        if( !file.endsWith('.json') ) continue
        const runId = file.slice( 0, -5 )
        if( inMem.has( runId ) ) continue
        try {
          const path   = join( dir, file )
          const meta   = ( JSON.parse( readFileSync( path, 'utf8') ) as { metadata: ReplayMetadata } ).metadata
          const key    = `${id}:${runId}`
          this._completedReplays.set( key, meta )
          this._replayPaths.set( key, path )
          results.push( meta )
        } catch { /* skip malformed */ }
      }
    }

    return results.sort( ( a, b ) => b.startTime - a.startTime )
  }

  async compare( id: string, runId1: string, runId2: string ): Promise<ReplayComparison> {
    const path1 = this._resolvePath( id, runId1 )
    const path2 = this._resolvePath( id, runId2 )
    if( !path1 ) throw Object.assign( new Error(`Replay not found: ${runId1}`), { code: 404 } )
    if( !path2 ) throw Object.assign( new Error(`Replay not found: ${runId2}`), { code: 404 } )
    return this._replayManager.compare( path1, path2 )
  }

  /**
   * Resolve a replay file path: prefer the in-memory cache, else fall back to the
   * conventional on-disk location. Without the fallback, compare() would 404 for
   * replays that exist on disk but weren't loaded via list()/getMeta() this
   * process (e.g. after a server restart).
   */
  private _resolvePath( id: string, runId: string ): string | undefined {
    const cached = this._replayPaths.get(`${id}:${runId}`)
    if( cached ) return cached

    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const path    = join( dataDir, 'wills', id, 'replays', `${runId}.json`)
    if( !existsSync( path ) ) return undefined

    this._replayPaths.set(`${id}:${runId}`, path )
    return path
  }
}

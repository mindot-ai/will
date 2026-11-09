// ─────────────────────────────────────────────────────────────
// tests/integration/stop.settles.test.ts
// ─────────────────────────────────────────────────────────────
//
// Stopped means stopped. Archiving a Will waits for the tick in progress and
// for every call its engines already started, so nothing the mind began
// answers after the mind is gone — billed, written to disk, or chained after
// `session.end`. It used to sleep one tick interval and hope.
//
// And a mind writes debug dumps only where every other file it writes goes, and
// only when those are written: never in test mode.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WillStem } from '#stem/index'
import { assembleMind, type WillConfig } from '#stem/mind'
import { LLMDirector } from '#llm/index'
import { setLogger, resetLogger } from '#core/logger'
import { getRecordTap } from '#core/record.tap'
import type { ChainEntry } from '#core/record.chain'
import type { SimulationEngine } from '#core/orchestrator'

const ENV: Record<string, string | undefined> = {
  WILL_SEMANTIC_RECALL:   'false',
  WILL_EMBEDDING_MODEL:   'none',
  WILL_VECTOR_MEMORY:     '',
  WILL_SUMMARY_INTERVAL:  '100000',
  WILL_EMBEDDING_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  WILL_LLM_API_KEY:       undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const warnings: string[] = []

/** Set env for one block, and put it back. */
function withEnv( vars: Record<string, string | undefined> ): () => void {
  const before: Record<string, string | undefined> = {}
  for( const [ k, v ] of Object.entries( vars ) ){
    before[ k ] = process.env[ k ]
    if( v === undefined ) delete process.env[ k ]
    else process.env[ k ] = v
  }
  return () => { for( const [ k, v ] of Object.entries( before ) ){ if( v === undefined ) delete process.env[ k ]; else process.env[ k ] = v } }
}

let restoreEnv: () => void
beforeAll( () => {
  setLogger( { debug: () => {}, info: () => {}, warn: ( ...a: unknown[] ) => { warnings.push( String( a[ 0 ] ) ) }, error: () => {} } )
  restoreEnv = withEnv( ENV )
})
afterAll( () => { resetLogger(); restoreEnv() } )

const sleep = ( ms: number ) => new Promise<void>( r => setTimeout( r, ms ) )
async function until( cond: () => boolean, ms = 20_000 ): Promise<void> {
  const end = Date.now() + ms
  while( !cond() ){
    if( Date.now() > end ) throw new Error('timed out waiting')
    await sleep( 5 )
  }
}

function stemConfig( id: string, extra: Partial<WillConfig> = {} ): WillConfig {
  return {
    id, name: 'Settling', profile: null,
    identity: { prompt: 'I am a mind that finishes what it started.', values: [ 'care' ], traits: {}, style: 'quiet' },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 20,
    randomSeed: 5, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
    ...extra,
  }
}

type Instance = { simulation: { addEngine( e: SimulationEngine ): void } }
const instanceOf = ( stem: WillStem, id: string ) =>
  ( stem as never as { _wills: Map<string, Instance> } )._wills.get( id )!

describe('archiving a Will settles everything it started', () => {
  it('waits for the tick in progress, however long it runs', async () => {
    const stem = new WillStem()
    const id = 'long-tick'
    await stem.createWill( stemConfig( id ) )
    // One tick held far past the old guess (one interval + 200ms).
    let hold = false, held = false, finished = false
    instanceOf( stem, id ).simulation.addEngine( {
      name: 'slow-step',
      react: async () => {
        if( hold ){ hold = false; held = true; await sleep( 700 ); finished = true }
        return {}
      },
    } )
    let ticksAfter = 0, stopped = false
    stem.addTickListener( id, () => { if( stopped ) ticksAfter++ } )

    hold = true
    await until( () => held )
    await stem.archiveWill( id )
    stopped = true
    expect( finished, 'archive returned while the tick was still running' ).toBe( true )
    await sleep( 300 )
    expect( ticksAfter ).toBe( 0 )
  }, 30_000 )

  it('wakes the loop from its sleep rather than waiting out the interval', async () => {
    const stem = new WillStem()
    const id = 'sleeper'
    await stem.createWill( stemConfig( id, { tickIntervalMs: 5_000 } ) )
    await sleep( 100 )   // past the first tick, into the five-second sleep
    const started = Date.now()
    await stem.archiveWill( id )
    expect( Date.now() - started ).toBeLessThan( 1_500 )
  }, 30_000 )

  it('waits for work in flight, which lands before the session ends', async () => {
    const entries: ChainEntry[] = []
    const stem = new WillStem()
    const id = 'in-flight'
    await stem.createWill( stemConfig( id, { anchoring: { every: 1_000, record: e => { entries.push( e ) }, anchor: () => {} } } ) )
    // An engine that starts work outside the tick, as the executive's LLM call
    // does, and whose answer is a record — as a completion is.
    let work: Promise<void> | null = null
    let answered = false
    instanceOf( stem, id ).simulation.addEngine( {
      name: 'thinker',
      react: async () => {
        work ??= sleep( 500 ).then( () => { getRecordTap( id )?.('completions', { late: true } ); answered = true } )
        return {}
      },
      awaitPending: async () => { await work },
    } )
    await until( () => work !== null )
    await stem.archiveWill( id )

    expect( answered, 'archive returned with a call still in flight' ).toBe( true )
    const last = entries.at( -1 )!
    expect( last.record ).toMatchObject( { type: 'session.end' } )
    const late = entries.find( e => e.stream === 'completions' && ( e.record as { late?: boolean } ).late )
    expect( late, 'the answer was not chained' ).toBeDefined()
    expect( late!.seq ).toBeLessThan( last.seq )
  }, 30_000 )

  it('does not wait on a turn that waits on the mind: that decision will not now come', async () => {
    const stem = new WillStem()
    const id = 'mid-turn'
    await stem.createWill( stemConfig( id ) )
    // Someone spoke; the turn routed to the facet and waits for its decision,
    // which only a tick would pump. This is what held an SDK hibernate.
    const audition = ( stem as never as { _wills: Map<string, { cognition: { auditionEngine: Record<string, any> } }> } )   // eslint-disable-line @typescript-eslint/no-explicit-any
      ._wills.get( id )!.cognition.auditionEngine
    audition._enqueue('ada', () => audition._beginTurn('ada') )
    await sleep( 40 )
    const before = warnings.length
    const started = Date.now()
    await stem.archiveWill( id )
    expect( Date.now() - started ).toBeLessThan( 2_000 )
    expect( warnings.slice( before ).filter( w => w.includes('given up') ) ).toEqual( [] )
  }, 30_000 )

  it('gives up work that outlasts stopTimeoutMs, and says so', async () => {
    const stem = new WillStem()
    const id = 'stuck'
    await stem.createWill( stemConfig( id, { stopTimeoutMs: 300 } ) )
    instanceOf( stem, id ).simulation.addEngine( {
      name: 'stuck-call',
      react: async () => ( {} ),
      awaitPending: () => new Promise<void>( () => {} ),
    } )
    await sleep( 60 )
    const started = Date.now()
    await stem.archiveWill( id )
    expect( Date.now() - started ).toBeLessThan( 3_000 )
    expect( warnings.some( w => w.includes(`archived ${id} with stuck-call's work in flight still running`) ) ).toBe( true )
  }, 30_000 )
})

describe('debug dumps go where a Will\'s files go, and only when those are written', () => {
  it('the director writes a dump only into the directory it was given', () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-debug-' ) )
    try {
      const base = { willId: 'w', model: 'mock', maxOutputTokens: 100, apiKey: '', provider: 'anthropic' as const, sessionLogger: null, mock: true }
      const none = new LLMDirector( base )
      const before = warnings.length
      expect( none.writeDebugPrompt( 3 as never, 'sys', 'user' ) ).toBe('')
      expect( none.writeDebugResponse( 3 as never, 'text', 1, 1, 1 ) ).toBe('')
      /** Not attempted and failed: not attempted. */
      expect( warnings.slice( before ) ).toEqual( [] )

      const some = new LLMDirector( { ...base, debugDir: join( dir, 'debug' ) } )
      const prompt   = some.writeDebugPrompt( 3 as never, 'sys', 'user' )
      const response = some.writeDebugResponse( 3 as never, 'the answer', 1, 1, 1 )
      expect( prompt ).toBe( join( dir, 'debug', 'prompt-tick-000003.txt' ) )
      expect( response ).toBe( join( dir, 'debug', 'response-tick-000003.txt' ) )
      expect( readFileSync( response, 'utf8' ) ).toContain('the answer')
    }
    finally { rmSync( dir, { recursive: true, force: true } ) }
  })

  it('a mind in test mode is given no debug directory; one logging files gets WILL_DATA_DIR\'s', () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-data-' ) )
    const restore = withEnv( { WILL_FILE_LOGS: 'true', WILL_DATA_DIR: dir } )
    try {
      const debugDirOf = ( id: string, testMode: boolean ) => {
        const { cognition } = assembleMind( id, stemConfig( id, { testMode, llm: { provider: 'anthropic' } as never } ) )
        const tracker = cognition.tokenTracker
        tracker.recordUsage( { model: 'm', promptTokens: 1, completionTokens: 1, totalTokens: 2,
          category: 'executive', attribute: 'master', process: 'decision', function: '-', tick: 1, latencyMs: 1 } as never )
        const exec = cognition.executiveEngine as never as { _debugDir: string | null; _buildDirector( m: string ): { _debugDir: string | null } }
        // The directory reaches the director that writes the dumps, not just the engine.
        expect( exec._buildDirector('mock')._debugDir ).toBe( exec._debugDir )
        return exec._debugDir
      }
      expect( debugDirOf('quiet', true ) ).toBeNull()
      expect( existsSync( join( dir, 'wills', 'quiet' ) ) ).toBe( false )

      expect( debugDirOf('loud', false ) ).toBe(`${dir}/wills/loud/debug`)
      expect( existsSync( join( dir, 'wills', 'loud', 'debug', 'token-report.jsonl' ) ) ).toBe( true )
    }
    finally { restore(); rmSync( dir, { recursive: true, force: true } ) }
  })
})

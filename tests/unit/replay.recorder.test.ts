// ─────────────────────────────────────────────────────────────
// tests/unit/replay.recorder.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for DefaultReplayRecorder persistence (FN2).
 *
 * Regression target: flush() used to log a count and clear the buffer without
 * writing anything. flush() fires automatically at bufferSize and on a timer,
 * so any run exceeding bufferSize silently lost all replay history before
 * save() ran. The fix persists buffered records to segment files on flush and
 * consolidates them in save().
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { DefaultReplayRecorder } from '#core/replay'
import type { StorageAdapter } from '#core/abstracts'
import type { SimulationEvent } from '#core/types'

class MemoryStorage implements StorageAdapter {
  files = new Map<string, string>()
  async write( path: string, content: string | Uint8Array ): Promise<void> {
    this.files.set( path, typeof content === 'string' ? content : new TextDecoder().decode( content ) )
  }
  async read( path: string ): Promise<string> {
    const v = this.files.get( path )
    if( v === undefined ) throw new Error(`File not found: ${path}`)
    return v
  }
  async readBytes( path: string ): Promise<Uint8Array> {
    return new TextEncoder().encode( await this.read( path ) )
  }
  async exists( path: string ): Promise<boolean> { return this.files.has( path ) }
  async delete( path: string ): Promise<void> { this.files.delete( path ) }
}

function makeEvent( tick: number ): SimulationEvent {
  return { type: 'test.event', tick, timestamp: 1000 + tick, payload: { tick } } as SimulationEvent
}

function makeCompletion( tick: number ) {
  return {
    tick, willId: 'w', provider: 'anthropic', model: 'm', maxOutputTokens: 10,
    systemPrompt: 's', userMessage: 'u', text: `t${tick}`,
    inputTok: 1, outputTok: 2, mock: true, latencyMs: 5, timestamp: 1000 + tick,
  }
}

function makeInbound( tick: number ) {
  return {
    tick, willId: 'w', timestamp: 1000 + tick,
    envelope: { channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: `msg${tick}`, correlationId: `c${tick}`, willId: 'w', seq: tick, wallTime: 0 },
  }
}

describe('DefaultReplayRecorder — persistence (FN2)', () => {
  let storage: MemoryStorage

  beforeEach( () => { storage = new MemoryStorage() })

  it('retains all records across a buffer rollover when a flush path is set', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42,
      { bufferSize: 5, flushBasePath: '/replays/run' },
      storage
    )

    // 23 ticks with bufferSize 5 → multiple automatic flushes mid-run.
    for( let t = 0; t < 23; t++ )
      recorder.recordTick( t, [ makeEvent( t ) ] )

    // Let any in-flight flush().catch() microtasks settle.
    await recorder.flush()
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.records ).toHaveLength( 23 )
    expect( saved.records.map( ( r: { tick: number } ) => r.tick ) )
      .toEqual( Array.from({ length: 23 }, ( _, i ) => i ) )
    expect( saved.metadata.totalEvents ).toBe( 23 )
  })

  it('cleans up segment files after consolidation', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42,
      { bufferSize: 2, flushBasePath: '/replays/run' },
      storage
    )

    for( let t = 0; t < 6; t++ )
      recorder.recordTick( t, [] )
    await recorder.save('/replays/run.json')

    const segments = [ ...storage.files.keys() ].filter( k => k.includes('.part') )
    expect( segments ).toHaveLength( 0 )
    expect( storage.files.has('/replays/run.json') ).toBe( true )
  })

  it('never discards records when no flush path is configured', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42,
      { bufferSize: 3 },  // no flushBasePath
      storage
    )

    for( let t = 0; t < 10; t++ )
      recorder.recordTick( t, [] )
    await recorder.flush()  // no-op retention path
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.records ).toHaveLength( 10 )
  })
})

describe('DefaultReplayRecorder — LLM completions (FN3)', () => {
  let storage: MemoryStorage

  beforeEach( () => { storage = new MemoryStorage() })

  it('persists recorded completions and counts them in metadata', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42, { flushBasePath: '/replays/run' }, storage
    )
    recorder.recordCompletion( makeCompletion( 1 ) )
    recorder.recordCompletion( makeCompletion( 2 ) )
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.completions ).toHaveLength( 2 )
    expect( saved.completions.map( ( c: { text: string } ) => c.text ) ).toEqual( [ 't1', 't2' ] )
    expect( saved.metadata.totalCompletions ).toBe( 2 )
  })

  it('retains completions across a buffer rollover alongside records', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42, { bufferSize: 2, flushBasePath: '/replays/run' }, storage
    )
    for( let t = 0; t < 5; t++ ){
      recorder.recordTick( t, [] )
      recorder.recordCompletion( makeCompletion( t ) )
    }
    await recorder.flush()
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.records ).toHaveLength( 5 )
    expect( saved.completions ).toHaveLength( 5 )
    expect( saved.metadata.totalCompletions ).toBe( 5 )
  })
})

describe('DefaultReplayRecorder — external inbound (1.3)', () => {
  let storage: MemoryStorage
  beforeEach( () => { storage = new MemoryStorage() })

  it('persists recorded inbound envelopes and counts them in metadata', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42, { flushBasePath: '/replays/run' }, storage
    )
    recorder.recordInbound( makeInbound( 1 ) )
    recorder.recordInbound( makeInbound( 2 ) )
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.inbound ).toHaveLength( 2 )
    expect( saved.inbound.map( ( i: { tick: number } ) => i.tick ) ).toEqual( [ 1, 2 ] )
    expect( saved.inbound[0].envelope.content ).toBe('msg1')
    expect( saved.metadata.totalInbound ).toBe( 2 )
  })

  it('retains inbound across a buffer rollover alongside records + completions', async () => {
    const recorder = new DefaultReplayRecorder(
      'sim', 'run', 42, { bufferSize: 2, flushBasePath: '/replays/run' }, storage
    )
    for( let t = 0; t < 5; t++ ){
      recorder.recordTick( t, [] )
      recorder.recordInbound( makeInbound( t ) )
    }
    await recorder.flush()
    await recorder.save('/replays/run.json')

    const saved = JSON.parse( await storage.read('/replays/run.json') )
    expect( saved.inbound ).toHaveLength( 5 )
    expect( saved.metadata.totalInbound ).toBe( 5 )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/stream.transport.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * StreamTransport is an in-process ExternalTransport, selected like
 * LoopbackTransport / SocketIoTransport via `config.transport`. Telemetry
 * (session logs + the token/cost ledger) flows out as `session_log` /
 * `token_report` envelopes; the consumer subscribes and owns persistence.
 *
 * These cover: the transport surface (emit→subscribe, channel filter, inbound,
 * close); the TransportController bridge that turns producer records into
 * envelopes; the producers' neutral sinks (no transport import, no files); and
 * the dev-mode file gate.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { StreamTransport, fileLoggingEnabled } from '#stem/tracts/transport/stream.transport'
import type { InboundEnvelope, OutboundEnvelope } from '#stem/tracts/transport/types'
import { TransportController } from '#stem/tracts/transport.controller'
import { SessionLogger } from '#stem/tracts/session.logger'
import { TokenTracker } from '#cognition/utilities/token.tracker'

describe( 'StreamTransport — ExternalTransport surface', () => {
  it( 'delivers an emitted outbound envelope to a subscriber, acked via event', async () => {
    const t = new StreamTransport( 'w' )
    const seen: OutboundEnvelope[] = []
    t.subscribe( e => seen.push( e ) )

    const ack = await t.emit({ channel: 'token_report', willId: 'w', correlationId: 'c1', seq: 1, wallTime: 0, report: { costUsd: 0.02 } })

    expect( ack ).toEqual({ acked: true, via: 'event' })
    expect( seen ).toHaveLength( 1 )
    expect( seen[0]!.channel ).toBe( 'token_report' )
  } )

  it( 'filters by channel and supports the * wildcard', async () => {
    const t = new StreamTransport( 'w' )
    const tok: OutboundEnvelope[] = []
    const all: OutboundEnvelope[] = []
    t.on( 'token_report', e => tok.push( e ) )
    t.on( '*',            e => all.push( e ) )

    await t.emit({ channel: 'session_log',  willId: 'w', correlationId: 'a', seq: 1, wallTime: 0, entry:  { type: 'tick' } })
    await t.emit({ channel: 'token_report', willId: 'w', correlationId: 'b', seq: 2, wallTime: 0, report: { costUsd: 1 } })

    expect( tok.map( e => e.channel ) ).toEqual( [ 'token_report' ] )
    expect( all ).toHaveLength( 2 )
  } )

  it( 'routes injected inbound envelopes to onInbound handlers', () => {
    const t = new StreamTransport( 'w' )
    const got: InboundEnvelope[] = []
    t.onInbound( e => got.push( e ) )

    t.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'u', threadId: 'th', content: 'hi', willId: 'w', correlationId: 'm1', seq: 1, wallTime: 0 })

    expect( got ).toHaveLength( 1 )
    expect( (got[0] as any).content ).toBe( 'hi' )
  } )

  it( 'isolates a throwing subscriber and clears on close', async () => {
    const t = new StreamTransport( 'w' )
    const good: OutboundEnvelope[] = []
    t.subscribe( () => { throw new Error( 'boom' ) } )
    t.subscribe( e => good.push( e ) )

    await expect( t.emit({ channel: 'session_log', willId: 'w', correlationId: 'x', seq: 1, wallTime: 0, entry: {} }) ).resolves.toBeTruthy()
    expect( good ).toHaveLength( 1 )

    t.close()
    expect( t.connected ).toBe( false )
    expect( t.listenerCount ).toBe( 0 )
  } )
} )

describe( 'TransportController — telemetry bridge → envelopes', () => {
  function ctx() {
    const transport = new StreamTransport( 'w' )
    const controller = new TransportController()
    const instance = { transport, config: { id: 'w' } } as any
    return { transport, controller, instance }
  }

  it( 'emitTokenReport builds a token_report envelope with monotonic seq', () => {
    const { transport, controller, instance } = ctx()
    const seen: OutboundEnvelope[] = []
    transport.on( 'token_report', e => seen.push( e ) )

    controller.emitTokenReport( instance, { costUsd: 0.02, category: 'executive' } )
    controller.emitTokenReport( instance, { costUsd: 0.03, category: 'embedding' } )

    expect( seen ).toHaveLength( 2 )
    expect( seen[0]!.channel ).toBe( 'token_report' )
    expect( (seen[0] as any).report.category ).toBe( 'executive' )
    expect( seen[0]!.willId ).toBe( 'w' )
    expect( seen[1]!.seq ).toBeGreaterThan( seen[0]!.seq )   // monotonic
  } )

  it( 'emitSessionLog builds a session_log envelope; no-op without a transport', () => {
    const { transport, controller, instance } = ctx()
    const seen: OutboundEnvelope[] = []
    transport.on( 'session_log', e => seen.push( e ) )
    controller.emitSessionLog( instance, { type: 'tick', tick: 1 } )
    expect( seen ).toHaveLength( 1 )
    expect( (seen[0] as any).entry.type ).toBe( 'tick' )

    // No transport → silently does nothing (dev file mirror handles it instead).
    expect( () => controller.emitSessionLog( { transport: null, config: { id: 'w' } } as any, {} ) ).not.toThrow()
  } )
} )

describe( 'Producers — neutral sinks (no transport import, no files)', () => {
  const willId = `__test-stream-${Math.random().toString( 36 ).slice( 2 )}`
  afterEach( () => rmSync( `./data/wills/${willId}`, { recursive: true, force: true } ) )

  it( 'TokenTracker.onRecord receives the attributed record and writes no file', () => {
    const t = new TokenTracker({ willId, writeLedger: false })
    const recs: Record<string, unknown>[] = []
    t.onRecord( r => recs.push( r ) )

    t.recordUsage({
      model: 'claude-sonnet-4-5', promptTokens: 100, completionTokens: 200, totalTokens: 300,
      category: 'executive', attribute: 'master', function: 'decision', tick: 1, latencyMs: 5,
    })

    expect( recs ).toHaveLength( 1 )
    expect( recs[0] ).toMatchObject({ category: 'executive', function: 'decision', inputTok: 100, outputTok: 200 })
    expect( existsSync( `./data/wills/${willId}/debug/token-report.jsonl` ) ).toBe( false )
  } )

  it( 'SessionLogger forwards entries via attachEmit and opens no file', () => {
    const got: Record<string, unknown>[] = []
    const log = new SessionLogger( 'will-sl', './data', { fileLogging: false } )
    log.attachEmit( r => got.push( r ) )
    expect( log.filePath ).toBe( '' )

    log.write({ type: 'tick', tick: 1 })
    log.write({ type: 'event', evtType: 'goal.formed' })

    expect( got.map( r => (r as any).type ) ).toEqual( [ 'tick', 'event' ] )
    expect( log.entryCount ).toBe( 2 )
  } )
} )

describe( 'fileLoggingEnabled — dev-mode gate', () => {
  const saved = { node: process.env['NODE_ENV'], flag: process.env['WILL_FILE_LOGS'] }
  afterEach( () => {
    if( saved.node === undefined ) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = saved.node
    if( saved.flag === undefined ) delete process.env['WILL_FILE_LOGS']; else process.env['WILL_FILE_LOGS'] = saved.flag
  } )

  it( 'off in production and test, on in development; override wins', () => {
    delete process.env['WILL_FILE_LOGS']
    process.env['NODE_ENV'] = 'production';  expect( fileLoggingEnabled() ).toBe( false )
    process.env['NODE_ENV'] = 'test';        expect( fileLoggingEnabled() ).toBe( false )
    process.env['NODE_ENV'] = 'development'; expect( fileLoggingEnabled() ).toBe( true )
    process.env['WILL_FILE_LOGS'] = 'false'; expect( fileLoggingEnabled() ).toBe( false )
    process.env['NODE_ENV'] = 'production'; process.env['WILL_FILE_LOGS'] = 'true'
    expect( fileLoggingEnabled() ).toBe( true )
  } )
} )

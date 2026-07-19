// ─────────────────────────────────────────────────────────────
// tests/unit/transport.socketio.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SocketIoTransport (0.3) — driven by an injected fake socket (no real network).
 *
 *   - emit() resolves via the socket.io ack callback
 *   - emit() times out when the peer never acks
 *   - emit() returns timeout when disconnected (caller keeps it buffered)
 *   - inbound 'envelope' events reach onInbound handlers
 *   - discrete 'message.delivered' / 'effector.invoked.ack' synthesize ack envelopes
 *   - status events propagate; close() disconnects
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SocketIoTransport, type SocketLike } from '#stem/tracts/transport/socketio.transport'
import type { OutboundEnvelope, InboundEnvelope } from '#stem/tracts/transport/types'

const flush = () => new Promise( r => setTimeout( r, 0 ) )

class FakeSocket implements SocketLike {
  connected = true
  handlers  = new Map<string, ( ...a: any[] ) => void>()
  emitted: Array<{ event: string; payload: unknown; ack?: ( r: unknown ) => void }> = []
  /** When set, emit() auto-invokes the ack callback with this value. */
  autoAck: unknown | undefined = undefined

  on( event: string, fn: ( ...a: any[] ) => void ){ this.handlers.set( event, fn ) }
  emit( event: string, payload: unknown, ack?: ( r: unknown ) => void ){
    this.emitted.push({ event, payload, ack })
    if( ack && this.autoAck !== undefined ) ack( this.autoAck )
  }
  disconnect(){ this.connected = false }
  trigger( event: string, ...args: any[] ){ this.handlers.get( event )?.( ...args ) }
}

function reply(): OutboundEnvelope {
  return { channel: 'reply', willId: 'will-1', correlationId: 'r1', seq: 0, wallTime: 0, entityId: 'a', threadId: 't', bubbles: ['hi'] }
}

async function makeTransport( fake: FakeSocket, ackTimeoutMs = 50 ){
  const t = new SocketIoTransport({ url: 'ws://x', willId: 'will-1', ackTimeoutMs, socketFactory: () => fake })
  await flush()   // let the eager connect wire the fake
  return t
}

describe('SocketIoTransport', () => {
  let fake: FakeSocket
  beforeEach( () => { fake = new FakeSocket() } )

  it('emit() resolves via the ack callback', async () => {
    fake.autoAck = { received: true }
    const t = await makeTransport( fake )

    const res = await t.emit( reply() )
    expect( res ).toEqual({ acked: true, via: 'callback', payload: { received: true } })
    expect( fake.emitted[0]!.event ).toBe('envelope')
  } )

  it('emit() times out when the peer never acks', async () => {
    const t = await makeTransport( fake, 20 )   // no autoAck → never acked
    const res = await t.emit( reply() )
    expect( res ).toEqual({ acked: false, via: 'timeout' })
  } )

  it('emit() returns timeout when disconnected (caller keeps buffered)', async () => {
    fake.connected = false
    const t = await makeTransport( fake )
    const res = await t.emit( reply() )
    expect( res ).toEqual({ acked: false, via: 'timeout' })
    expect( fake.emitted ).toHaveLength( 0 )   // nothing sent on a dead socket
  } )

  it('routes inbound envelope events to onInbound handlers', async () => {
    const t = await makeTransport( fake )
    const seen: InboundEnvelope[] = []
    t.onInbound( e => seen.push( e ) )

    fake.trigger('envelope', { channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'yo', willId: 'will-1', correlationId: 'm1', seq: 1, wallTime: 0 } )

    expect( seen ).toHaveLength( 1 )
    expect( seen[0]!.channel ).toBe('inbound_message')
  } )

  it('synthesizes a result ack from a discrete effector.invoked.ack event', async () => {
    const t = await makeTransport( fake )
    const seen: InboundEnvelope[] = []
    t.onInbound( e => seen.push( e ) )

    fake.trigger('effector.invoked.ack', { correlationId: 'inv-1', result: { success: true, description: 'done' } } )

    expect( seen ).toHaveLength( 1 )
    const e = seen[0] as any
    expect( e.channel ).toBe('ack')
    expect( e.ackKind ).toBe('result')
    expect( e.correlationId ).toBe('inv-1')
    expect( e.result ).toEqual({ success: true, description: 'done' })
  } )

  it('synthesizes a delivery ack from a discrete message.delivered event', async () => {
    const t = await makeTransport( fake )
    const seen: InboundEnvelope[] = []
    t.onInbound( e => seen.push( e ) )

    fake.trigger('message.delivered', { correlationId: 'out-7' } )

    const e = seen[0] as any
    expect( e.channel ).toBe('ack')
    expect( e.ackKind ).toBe('delivery')
    expect( e.delivered ).toBe( true )
    expect( e.correlationId ).toBe('out-7')
  } )

  it('propagates status events and reflects connected', async () => {
    const t = await makeTransport( fake )
    const statuses: string[] = []
    t.onStatus( s => statuses.push( s ) )

    fake.trigger('disconnect')
    fake.trigger('connect')
    expect( statuses ).toEqual( ['disconnected', 'connected'] )
    expect( t.connected ).toBe( true )
  } )

  it('close() disconnects the socket', async () => {
    const t = await makeTransport( fake )
    t.close()
    expect( fake.connected ).toBe( false )
    expect( t.connected ).toBe( false )
  } )
} )

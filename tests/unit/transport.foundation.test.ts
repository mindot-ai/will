// ─────────────────────────────────────────────────────────────
// tests/unit/transport.foundation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the ExternalTransport foundation:
 *   - LoopbackTransport: emit records, ack policy, inbound injection, status
 *   - InboundQueue: FIFO buffering, tick-stamped drain, drain-once semantics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LoopbackTransport } from '#stem/tracts/transport/loopback.transport'
import { InboundQueue }      from '#stem/tracts/inbound.queue'
import type {
  OutboundEnvelope,
  InboundEnvelope,
  ReplyEnvelope,
} from '#stem/tracts/transport/types'

// ── Helpers ──────────────────────────────────────────────────

function reply( id: string, entityId = 'alice'): ReplyEnvelope {
  return {
    channel:       'reply',
    willId:        'will-1',
    correlationId: id,
    seq:           1,
    wallTime:      0,
    entityId,
    threadId:      't1',
    bubbles:       ['hi'],
  }
}

function inboundMessage( id: string, content = 'hello'): InboundEnvelope {
  return {
    channel:       'inbound_message',
    willId:        'will-1',
    correlationId: id,
    seq:           1,
    wallTime:      0,
    kind:          'text',
    entityId:      'alice',
    threadId:      't1',
    content,
  }
}

// ── LoopbackTransport ─────────────────────────────────────────

describe('LoopbackTransport', () => {
  let t: LoopbackTransport
  beforeEach( () => { t = new LoopbackTransport() } )

  it('records every emitted envelope in order', async () => {
    await t.emit( reply('a') )
    await t.emit( reply('b') )
    expect( t.sent.map( e => e.correlationId ) ).toEqual( ['a', 'b'] )
  } )

  it('acks via callback by default', async () => {
    const res = await t.emit( reply('a') )
    expect( res ).toEqual( { acked: true, via: 'callback' } )
  } )

  it('honours a custom ack policy (e.g. timeout)', async () => {
    t.setAckPolicy( () => ({ acked: false, via: 'timeout' }) )
    const res = await t.emit( reply('a') )
    expect( res.acked ).toBe( false )
    expect( res.via ).toBe('timeout')
  } )

  it('delivers injected inbound envelopes to all handlers', () => {
    const seen: InboundEnvelope[] = []
    const unsub = t.onInbound( e => seen.push( e ) )
    t.injectInbound( inboundMessage('m1') )
    expect( seen ).toHaveLength( 1 )
    expect( seen[0]!.correlationId ).toBe('m1')
    unsub()
    t.injectInbound( inboundMessage('m2') )
    expect( seen ).toHaveLength( 1 )  // unsubscribed — no further delivery
  } )

  it('notifies status handlers on connection changes', () => {
    const statuses: string[] = []
    t.onStatus( s => statuses.push( s ) )
    t.setConnected( false )
    t.setConnected( true )
    expect( statuses ).toEqual( ['disconnected', 'connected'] )
    expect( t.connected ).toBe( true )
  } )

  it('sentOn() filters by channel', async () => {
    await t.emit( reply('a') )
    await t.emit({
      channel: 'chunk', willId: 'will-1', correlationId: 'c', seq: 2, wallTime: 0,
      entityId: 'alice', threadId: 't1', content: 'tok',
    })
    expect( t.sentOn('reply') ).toHaveLength( 1 )
    expect( t.sentOn('chunk') ).toHaveLength( 1 )
  } )
} )

// ── InboundQueue ──────────────────────────────────────────────

describe('InboundQueue', () => {
  let q: InboundQueue
  beforeEach( () => { q = new InboundQueue() } )

  it('buffers envelopes and reports size', () => {
    expect( q.size ).toBe( 0 )
    q.enqueue( inboundMessage('m1') )
    q.enqueue( inboundMessage('m2') )
    expect( q.size ).toBe( 2 )
  } )

  it('drains in FIFO order, stamped with the given tick', () => {
    q.enqueue( inboundMessage('m1') )
    q.enqueue( inboundMessage('m2') )
    const batch = q.drain( 42 )
    expect( batch.map( b => b.envelope.correlationId ) ).toEqual( ['m1', 'm2'] )
    expect( batch.every( b => b.appliedTick === 42 ) ).toBe( true )
  } )

  it('drains once — a second drain is empty', () => {
    q.enqueue( inboundMessage('m1') )
    expect( q.drain( 1 ) ).toHaveLength( 1 )
    expect( q.drain( 2 ) ).toHaveLength( 0 )
    expect( q.size ).toBe( 0 )
  } )

  it('drain on an empty queue returns an empty batch', () => {
    expect( q.drain( 1 ) ).toEqual( [] )
  } )

  it('clear() discards pending without applying', () => {
    q.enqueue( inboundMessage('m1') )
    q.clear()
    expect( q.size ).toBe( 0 )
    expect( q.drain( 1 ) ).toEqual( [] )
  } )
} )

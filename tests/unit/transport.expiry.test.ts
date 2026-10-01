// ─────────────────────────────────────────────────────────────
// tests/unit/transport.expiry.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the mind no longer awaits is not sent again — and the record is appended,
 * not rewritten.
 *
 *   - A message the transport carried left the outbox the tick it was written,
 *     so the outbox's TTL never saw it: un-acked, it was held for as long as the
 *     Will lived and delivered on the next reconnect, however late, while the
 *     mind was never told it had not landed (the outbox's own "undelivered"
 *     event has no subscriber).
 *   - An invocation was re-emitted after the executor had timed it out, or a
 *     change in its target had confirmed it: the host performed an act the mind
 *     had already settled.
 *   - The event log read the whole file and wrote it back each flush, and a
 *     flush() during a write left what arrived meanwhile unwritten.
 */

import { describe, it, expect, vi } from 'vitest'
import { TransportController } from '#stem/tracts/transport.controller'
import { OutboxController, OUTBOX_TTL_TICKS } from '#stem/tracts/outbox.controller'
import { LoopbackTransport } from '#stem/tracts/transport/loopback.transport'
import { InboundQueue } from '#stem/tracts/inbound.queue'
import { DefaultEventLog } from '#cognition/event.log'
import { BunStorageAdapter } from '#core/abstracts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const msg = ( id: string, createdAtTick: number ) => ( {
  id, targetEntityId: 'ada', content: 'the release is held until Thursday', effectorName: 'talk',
  deliveryStatus: 'pending', createdAtTick, createdAt: 0,
} )
const inv = ( id: string ) => ( { id, intentId: id, effectorName: 'post_update',
  parameters: {}, targetEntityId: undefined, reasoning: '', tick: 0, timestamp: 0 } )

function fixture(){
  const transport = new LoopbackTransport()
  transport.setAckPolicy( () => ( { acked: false, via: 'timeout' } ) )      // nothing is acked
  const entities = new Map<string, { type: string }>()
  const instance: any = {
    config: { id: 'will-1' }, transport, inbound: new InboundQueue(), _transportUnsub: null, tickCount: 1,
    simulation: { stateManager: { getEntity: ( id: string ) => entities.get( id ) } },
    cognition: {
      auditionEngine: { sense: vi.fn(), attachReplyCallback: () => {}, addChunkCallback: () => () => {} },
      planningEngine: { addActivityListener: () => () => {} },
    },
  }
  const outbox = { expire: vi.fn() }
  const ctrl = new TransportController()
  ctrl.attach( instance )
  const reconnect = () => { transport.setConnected( false ); transport.setConnected( true ) }
  return { transport, instance, entities, outbox, ctrl, reconnect }
}

describe('a reconnect re-emits only what the mind still awaits', () => {
  it('a message past the outbox TTL is let go, and reported, not delivered late', () => {
    const f = fixture()
    f.ctrl.emitOutbox( f.instance, [ msg('m-1', 1 ) ] as never )
    f.instance.tickCount = 1 + OUTBOX_TTL_TICKS + 1
    f.ctrl.expireStale( f.instance, f.outbox as never )
    f.reconnect()
    expect( f.transport.sentOn('message') ).toHaveLength( 1 )               // the first send only
    expect( f.outbox.expire ).toHaveBeenCalledWith( f.instance, expect.objectContaining( { id: 'm-1' } ) )
  } )

  it('a message still within the TTL is re-emitted', () => {
    const f = fixture()
    f.ctrl.emitOutbox( f.instance, [ msg('m-1', 1 ) ] as never )
    f.instance.tickCount = 1 + OUTBOX_TTL_TICKS
    f.ctrl.expireStale( f.instance, f.outbox as never )
    f.reconnect()
    expect( f.transport.sentOn('message') ).toHaveLength( 2 )
    expect( f.outbox.expire ).not.toHaveBeenCalled()
  } )

  it('an act the mind has settled is not performed again; one it awaits is re-sent', () => {
    const f = fixture()
    f.entities.set('intent-awaited', { type: 'agency.intent' })
    f.ctrl.emitInvocations( f.instance, [ inv('intent-awaited'), inv('intent-timed-out') ] as never )
    f.ctrl.expireStale( f.instance, f.outbox as never )                      // the timed-out intent is gone from state
    f.reconnect()
    expect( f.transport.sentOn('effector_invocation').map( e => e.correlationId ) )
      .toEqual( [ 'intent-awaited', 'intent-timed-out', 'intent-awaited' ] )
  } )
} )

describe('the tick loop lets go of what the mind no longer awaits', () => {
  it('expires the transport\'s held envelopes each tick, beside the outbox', () => {
    // No harness runs WillStem's loop with a transport attached; read the call
    // where the outbox's own expiry is, as lossless.p4 reads the master's writes.
    const src = readFileSync( join( process.cwd(), 'src/stem/index.ts'), 'utf8')
    expect( src ).toMatch( /this\._outbox\.expireStale\( instance \)\n\s*this\._transport\.expireStale\( instance, this\._outbox \)/ )
  } )
} )

describe('an expired message reaches the mind as a failed delivery', () => {
  it('the sent record says undelivered, and the mind perceives it', () => {
    const sense = vi.fn().mockResolvedValue( undefined )
    const setEntity = vi.fn()
    const instance: any = {
      tickCount: 200, sessionLogger: null,
      simulation: { eventBus: { publish: () => {} }, context: {},
        stateManager: { setEntity, getEntitiesByType: () => [ { id: 'sent-1', type: 'conversation.sent', createdAt: 0,
          metadata: { outboxMessageIds: [ 'm-1' ] } } ] } },
      cognition: { somatosensationEngine: { sense } },
    }
    new OutboxController().expire( instance, msg('m-1', 50 ) as never )
    expect( setEntity ).toHaveBeenCalledWith( expect.objectContaining( { id: 'sent-1',
      metadata: expect.objectContaining( { delivered: false } ) } ) )
    expect( sense ).toHaveBeenCalledWith( expect.objectContaining( { signal: 'message_delivery',
      data: expect.objectContaining( { messageId: 'm-1', delivered: false } ) } ) )
  } )
} )

// ── the event log ────────────────────────────────────────────

const event = ( i: number ) => ( { type: 'e', version: 1, sourceEngine: 's', salience: 0, payload: { i }, logicalTime: i } ) as never

function store( opts: { append?: boolean; failFirst?: boolean; slow?: boolean } = {} ){
  let text = '', failed = false, release: ( () => void ) | null = null
  const reads = vi.fn( async () => text )
  const s: Record<string, unknown> = {
    write:  async ( _p: string, c: string ) => { text = c },
    read:   reads,
    readBytes: async () => new Uint8Array(),
    exists: async () => text.length > 0,
  }
  if( opts.append )
    s['append'] = async ( _p: string, c: string ) => {
      if( opts.slow && !release ) await new Promise<void>( r => { release = r } )
      if( opts.failFirst && !failed ){ failed = true; throw new Error('disk full') }
      text += c
    }
  return { s, reads, lines: () => text.split('\n').filter( Boolean ).length, release: () => release?.() }
}

describe('the event log appends, and flush() writes everything', () => {
  it('appends where the store can — it never reads the log back', async () => {
    const st = store( { append: true } )
    const log = new DefaultEventLog('/x/events.jsonl', st.s as never )
    for( let i = 0; i < 250; i++ ) log.append( event( i ) )
    await log.flush()
    expect( st.lines() ).toBe( 250 )
    expect( st.reads ).not.toHaveBeenCalled()
  } )

  it('flush() during a write also writes what arrived meanwhile', async () => {
    const st = store( { append: true, slow: true } )
    const log = new DefaultEventLog('/x/events.jsonl', st.s as never )
    for( let i = 0; i < 100; i++ ) log.append( event( i ) )                 // auto-flush starts, and waits
    for( let i = 100; i < 105; i++ ) log.append( event( i ) )
    const done = log.flush()
    await new Promise( r => setTimeout( r, 0 ) )
    st.release()
    await done
    expect( st.lines() ).toBe( 105 )
  } )

  it('a failed write loses nothing', async () => {
    const st = store( { append: true, failFirst: true } )
    const log = new DefaultEventLog('/x/events.jsonl', st.s as never )
    for( let i = 0; i < 10; i++ ) log.append( event( i ) )
    await expect( log.flush() ).rejects.toThrow('disk full')
    await log.flush()
    expect( st.lines() ).toBe( 10 )
  } )

  it('the file store appends to a real file, making its directory', async () => {
    const dir = mkdtempSync( join( tmpdir(), 'will-log-') )
    try {
      const log = new DefaultEventLog( join( dir, 'nested', 'events.jsonl'), new BunStorageAdapter() )
      for( let i = 0; i < 230; i++ ) log.append( event( i ) )
      await log.flush()
      const lines = readFileSync( join( dir, 'nested', 'events.jsonl'), 'utf8').split('\n').filter( Boolean )
      expect( lines.map( l => JSON.parse( l ).payload.i ) ).toEqual( Array.from( { length: 230 }, ( _, i ) => i ) )
    }
    finally { rmSync( dir, { recursive: true, force: true } ) }
  } )

  it('a store without append still gets every line', async () => {
    const st = store()
    const log = new DefaultEventLog('/x/events.jsonl', st.s as never )
    for( let i = 0; i < 150; i++ ) log.append( event( i ) )
    await log.flush()
    expect( st.lines() ).toBe( 150 )
  } )
} )

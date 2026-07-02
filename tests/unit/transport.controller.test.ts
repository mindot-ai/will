// ─────────────────────────────────────────────────────────────
// tests/unit/transport.controller.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * TransportController — the ExternalTransport ↔ tick-loop boundary (0.4 + 1.2).
 *
 *   - attach()       inbound stream → tick-stamped InboundQueue (no inline apply)
 *   - applyInbound() drains + dispatches each channel to the right collaborator
 *   - detach()       unsubscribes + clears the queue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransportController } from '#stem/tracts/transport.controller'
import { LoopbackTransport }   from '#stem/tracts/transport/loopback.transport'
import { InboundQueue }        from '#stem/tracts/inbound.queue'
import { setInboundRecorder, clearInboundRecorder } from '#core/inbound.recorder'
import type { InboundEnvelope } from '#stem/tracts/transport/types'

const flush = () => new Promise( r => setTimeout( r, 0 ) )

function base( correlationId: string ){
  return { willId: 'will-1', correlationId, seq: 1, wallTime: 0 }
}

function makeFixture(){
  const transport = new LoopbackTransport()
  const ingest    = vi.fn().mockResolvedValue( undefined )
  const captured: {
    replyCb:        (( e: string, t: string, b: string[] ) => void) | null
    chunkCb:        (( e: string, t: string, c: string ) => void) | null
    activityCb:     (( ev: any ) => void) | null
    activityEntity: string | null
  } = { replyCb: null, chunkCb: null, activityCb: null, activityEntity: null }

  const instance: any = {
    config:    { id: 'will-1' },
    transport,
    inbound:   new InboundQueue(),
    _transportUnsub: null,
    cognition: {
      auditionEngine: {
        ingest,
        attachReplyCallback: ( cb: any ) => { captured.replyCb = cb },
        addChunkCallback:    ( cb: any ) => { captured.chunkCb = cb; return () => { captured.chunkCb = null } },
      },
      planningEngine: {
        addActivityListener: ( entity: string, fn: any ) => { captured.activityEntity = entity; captured.activityCb = fn; return () => { captured.activityCb = null } },
      },
    },
  }

  const deps = {
    effector: { confirmExecution: vi.fn() },
    outbox:  { confirmDelivery:  vi.fn() },
    sensory: { injectEvent:      vi.fn() },
  }

  return { ctrl: new TransportController(), transport, instance, deps, ingest, captured }
}

describe( 'TransportController', () => {
  let f: ReturnType<typeof makeFixture>
  beforeEach( () => { f = makeFixture() } )

  it( 'attach() routes inbound envelopes into the queue (does not apply inline)', () => {
    f.ctrl.attach( f.instance )

    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'hi', ...base('m1') })

    expect( f.instance.inbound.size ).toBe( 1 )   // buffered, not applied
    expect( f.ingest ).not.toHaveBeenCalled()
  } )

  it( 'applyInbound() dispatches inbound_message → auditionEngine.ingest', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'alice', threadId: 't1', content: 'hello', speakerName: 'Alice', ...base('m1') })

    f.ctrl.applyInbound( f.instance, 7, f.deps as any )

    expect( f.ingest ).toHaveBeenCalledTimes( 1 )
    expect( f.ingest ).toHaveBeenCalledWith({ kind: 'text', entityId: 'alice', threadId: 't1', content: 'hello', speakerName: 'Alice' })
    expect( f.instance.inbound.size ).toBe( 0 )   // drained
  } )

  it( 'maps a voice message to a VoiceChunk (transcription)', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'voice', entityId: 'a', threadId: 't', content: 'spoken words', ...base('m1') })

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )

    expect( f.ingest ).toHaveBeenCalledWith({ kind: 'voice', entityId: 'a', threadId: 't', transcription: 'spoken words' })
  } )

  it( 'dispatches a result-ack → effector.confirmExecution (reafference)', () => {
    f.ctrl.attach( f.instance )
    const result = { success: true, description: 'sent' }
    f.transport.injectInbound({ channel: 'ack', ackKind: 'result', result, ...base('invocation-9') })

    f.ctrl.applyInbound( f.instance, 3, f.deps as any )

    expect( f.deps.effector.confirmExecution ).toHaveBeenCalledWith( f.instance, 'invocation-9', result )
    expect( f.deps.outbox.confirmDelivery ).not.toHaveBeenCalled()
  } )

  it( 'dispatches a delivery-ack → outbox.confirmDelivery', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'ack', ackKind: 'delivery', delivered: true, ...base('outbox-3') })

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )

    expect( f.deps.outbox.confirmDelivery ).toHaveBeenCalledWith( f.instance, 'outbox-3', true )
    expect( f.deps.effector.confirmExecution ).not.toHaveBeenCalled()
  } )

  it( 'dispatches an inbound_percept → sensory.injectEvent', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_percept', domain: 'somatosensation', payload: { signal: 'webhook' }, ...base('p1') })

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )

    expect( f.deps.sensory.injectEvent ).toHaveBeenCalledWith( f.instance, { type: 'senses.somatosensation', payload: { signal: 'webhook' } } )
  } )

  it( 'applies the whole batch in FIFO order, then drains empty', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'one', ...base('m1') })
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'two', ...base('m2') })

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )
    expect( f.ingest.mock.calls.map( c => c[0].content ) ).toEqual( ['one', 'two'] )

    f.ctrl.applyInbound( f.instance, 2, f.deps as any )   // nothing left
    expect( f.ingest ).toHaveBeenCalledTimes( 2 )
  } )

  it( 'a dispatch error does not abort the rest of the batch', () => {
    f.ctrl.attach( f.instance )
    f.ingest.mockImplementationOnce( () => { throw new Error( 'boom' ) } )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'bad',  ...base('m1') })
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'good', ...base('m2') })

    expect( () => f.ctrl.applyInbound( f.instance, 1, f.deps as any ) ).not.toThrow()
    expect( f.ingest ).toHaveBeenCalledTimes( 2 )   // second still ran
  } )

  it( 'detach() unsubscribes and clears the queue', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'x', ...base('m1') })
    expect( f.instance.inbound.size ).toBe( 1 )

    f.ctrl.detach( f.instance )
    expect( f.instance.inbound.size ).toBe( 0 )

    // After detach, further inbound is not routed.
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'y', ...base('m2') })
    expect( f.instance.inbound.size ).toBe( 0 )
  } )

  it( 'attach() on an instance with no transport is a safe no-op', () => {
    const noTransport: any = { config: { id: 'w' }, transport: null, inbound: new InboundQueue(), _transportUnsub: null }
    expect( () => f.ctrl.attach( noTransport ) ).not.toThrow()
    expect( noTransport._transportUnsub ).toBeNull()
  } )

  // ── Outbound: reply fast-path (2.1) ─────────────────────────

  it( 'attach() wires the reply fast-path → emits a reply envelope', () => {
    f.ctrl.attach( f.instance )
    expect( f.captured.replyCb ).toBeTypeOf( 'function' )

    f.captured.replyCb!( 'alice', 't1', ['hello', 'world'] )

    const replies = f.transport.sentOn( 'reply' )
    expect( replies ).toHaveLength( 1 )
    expect( replies[0]!.entityId ).toBe( 'alice' )
    expect( replies[0]!.threadId ).toBe( 't1' )
    expect( replies[0]!.bubbles ).toEqual( ['hello', 'world'] )
    expect( replies[0]!.willId ).toBe( 'will-1' )
    expect( replies[0]!.correlationId ).toContain( 'reply-alice' )
    expect( replies[0]!.seq ).toBe( 1 )
  } )

  // ── Outbound: chunk fast-path (2.2) ─────────────────────────

  it( 'attach() wires the chunk fast-path → emits chunk envelopes', () => {
    f.ctrl.attach( f.instance )
    expect( f.captured.chunkCb ).toBeTypeOf( 'function' )

    f.captured.chunkCb!( 'alice', 't1', 'hel' )
    f.captured.chunkCb!( 'alice', 't1', 'lo' )

    const chunks = f.transport.sentOn( 'chunk' )
    expect( chunks ).toHaveLength( 2 )
    expect( chunks.map( c => c.content ) ).toEqual( ['hel', 'lo'] )
    expect( chunks[0]!.entityId ).toBe( 'alice' )
    expect( chunks[0]!.threadId ).toBe( 't1' )
  } )

  // ── Outbound: effector-invocation bridge (2.4) ───────────────

  const inv = ( id: string, effector: string ) => ({
    id, decisionRecordId: id, effectorName: effector,
    parameters: {}, targetEntityId: undefined, reasoning: '', tick: 0, timestamp: 0,
  })

  it( 'emitInvocations() emits one effector_invocation per invocation, correlation = decisionRecordId', () => {
    f.ctrl.attach( f.instance )
    f.ctrl.emitInvocations( f.instance, [ inv( 'dr1', 'send_email' ), inv( 'dr2', 'post' ) ] as any )

    const sent = f.transport.sentOn( 'effector_invocation' )
    expect( sent ).toHaveLength( 2 )
    expect( sent.map( s => s.correlationId ) ).toEqual( ['dr1', 'dr2'] )
    expect( sent[0]!.invocation.effectorName ).toBe( 'send_email' )
    expect( sent.map( s => s.seq ) ).toEqual( [1, 2] )   // monotonic per Will
  } )

  it( 'emitInvocations() is a no-op for an empty list or no transport', () => {
    f.ctrl.attach( f.instance )
    f.ctrl.emitInvocations( f.instance, [] )
    expect( f.transport.sentOn( 'effector_invocation' ) ).toHaveLength( 0 )

    const noTransport: any = { config: { id: 'w' }, transport: null, inbound: new InboundQueue(), _transportUnsub: null }
    expect( () => f.ctrl.emitInvocations( noTransport, [ inv( 'dr1', 'x' ) ] as any ) ).not.toThrow()
  } )

  it( 'reply and invocation share one monotonic outbound seq per Will', () => {
    f.ctrl.attach( f.instance )
    f.captured.replyCb!( 'a', 't', ['hi'] )                       // seq 1
    f.ctrl.emitInvocations( f.instance, [ inv( 'dr1', 'x' ) ] as any )   // seq 2

    expect( f.transport.sentOn( 'reply' )[0]!.seq ).toBe( 1 )
    expect( f.transport.sentOn( 'effector_invocation' )[0]!.seq ).toBe( 2 )
  } )

  // ── Outbound: generic outbox bridge (2.3) ───────────────────

  const msg = ( id: string, content: string ) => ({
    id, targetEntityId: 'a', content, effectorName: 'talk',
    deliveryStatus: 'pending', createdAtTick: 0, createdAt: 0,
  })

  it( 'emitOutbox() emits one message envelope per outbox message (correlation = id)', () => {
    f.ctrl.attach( f.instance )
    f.ctrl.emitOutbox( f.instance, [ msg( 'm-1', 'hi' ), msg( 'm-2', 'yo' ) ] as any )

    const sent = f.transport.sentOn( 'message' )
    expect( sent ).toHaveLength( 2 )
    expect( sent.map( s => s.correlationId ) ).toEqual( ['m-1', 'm-2'] )
    expect( sent[0]!.message.content ).toBe( 'hi' )
  } )

  // ── Ack reconciliation (Section 3) ──────────────────────────

  it( 'reconciles dual-path acks idempotently — confirmExecution runs once', () => {
    f.ctrl.attach( f.instance )
    const result = { success: true, description: 'ok' }
    // Same correlationId arriving twice (emit-callback path + discrete event).
    f.transport.injectInbound({ channel: 'ack', ackKind: 'result', result, ...base( 'inv-1' ) })
    f.transport.injectInbound({ channel: 'ack', ackKind: 'result', result, ...base( 'inv-1' ) })

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )

    expect( f.deps.effector.confirmExecution ).toHaveBeenCalledTimes( 1 )
  } )

  it( 'marshals an effector_invocation result-ack from the emit callback onto inbound', async () => {
    f.ctrl.attach( f.instance )
    f.transport.setAckPolicy( () => ({ acked: true, via: 'callback', payload: { success: true, description: 'done' } }) )

    f.ctrl.emitInvocations( f.instance, [ inv( 'dr9', 'send_email' ) ] as any )
    await flush()   // let emit().then() enqueue the ack

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )
    expect( f.deps.effector.confirmExecution ).toHaveBeenCalledWith( f.instance, 'dr9', { success: true, description: 'done' } )
  } )

  it( 'marshals a delivery-ack from a message emit callback (no result payload)', async () => {
    f.ctrl.attach( f.instance )
    // default ack policy: { acked: true, via: 'callback' } — no payload → delivery
    f.ctrl.emitOutbox( f.instance, [ msg( 'm-7', 'hi' ) ] as any )
    await flush()

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )
    expect( f.deps.outbox.confirmDelivery ).toHaveBeenCalledWith( f.instance, 'm-7', true )
  } )

  it( 'does not marshal an ack when the emit is not acked (timeout)', async () => {
    f.ctrl.attach( f.instance )
    f.transport.setAckPolicy( () => ({ acked: false, via: 'timeout' }) )
    f.ctrl.emitOutbox( f.instance, [ msg( 'm-8', 'hi' ) ] as any )
    await flush()

    f.ctrl.applyInbound( f.instance, 1, f.deps as any )
    expect( f.deps.outbox.confirmDelivery ).not.toHaveBeenCalled()
  } )

  // ── Activity projection (2.5) ───────────────────────────────

  it( 'subscribes to ALL plan activity (wildcard) and emits activity envelopes', () => {
    f.ctrl.attach( f.instance )
    expect( f.captured.activityEntity ).toBe( '*' )

    f.captured.activityCb!({ type: 'plan_started', planId: 'p1', requestingEntityId: 'alice' })

    const acts = f.transport.sentOn( 'activity' )
    expect( acts ).toHaveLength( 1 )
    expect( acts[0]!.eventType ).toBe( 'plan_started' )
    expect( acts[0]!.entityId ).toBe( 'alice' )
    expect( ( acts[0]!.payload as any ).planId ).toBe( 'p1' )
  } )

  // ── Reconnect re-emit ───────────────────────────────────────

  it( 're-emits un-acked messages when the transport reconnects', () => {
    f.transport.setAckPolicy( () => ({ acked: false, via: 'timeout' }) )   // never acked → stays pending
    f.ctrl.attach( f.instance )
    f.ctrl.emitOutbox( f.instance, [ msg( 'm-1', 'hi' ) ] as any )
    expect( f.transport.sentOn( 'message' ) ).toHaveLength( 1 )

    f.transport.setConnected( false )
    f.transport.setConnected( true )   // → onStatus('connected') → re-emit pending

    const sent = f.transport.sentOn( 'message' )
    expect( sent ).toHaveLength( 2 )
    expect( sent.every( m => m.correlationId === 'm-1' ) ).toBe( true )
  } )

  it( 'does NOT re-emit a message once its delivery-ack has reconciled', async () => {
    f.ctrl.attach( f.instance )                                // default ack policy: acked via callback
    f.ctrl.emitOutbox( f.instance, [ msg( 'm-2', 'hi' ) ] as any )
    await flush()                                              // ack enqueued onto inbound
    f.ctrl.applyInbound( f.instance, 1, f.deps as any )        // reconciles → clears pending

    const before = f.transport.sentOn( 'message' ).length
    f.transport.setConnected( true )                           // reconnect
    expect( f.transport.sentOn( 'message' ) ).toHaveLength( before )   // nothing to re-emit
  } )

  it( 'does not buffer reply/chunk for reconnect (ephemeral)', () => {
    f.ctrl.attach( f.instance )
    f.captured.replyCb!( 'a', 't', ['hi'] )
    f.captured.chunkCb!( 'a', 't', 'tok' )
    const replies = f.transport.sentOn( 'reply' ).length
    const chunks  = f.transport.sentOn( 'chunk' ).length

    f.transport.setConnected( true )   // reconnect
    expect( f.transport.sentOn( 'reply' ) ).toHaveLength( replies )   // not re-emitted
    expect( f.transport.sentOn( 'chunk' ) ).toHaveLength( chunks )
  } )

  // ── Replay recording of inbound (1.3) ───────────────────────

  it( 'records the drained inbound batch when a recorder is registered', () => {
    const recorded: any[] = []
    setInboundRecorder( 'will-1', { recordInbound: r => recorded.push( r ) } )
    try {
      f.ctrl.attach( f.instance )
      f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'hi', ...base( 'm1' ) })

      f.ctrl.applyInbound( f.instance, 7, f.deps as any )

      expect( recorded ).toHaveLength( 1 )
      expect( recorded[0].tick ).toBe( 7 )
      expect( recorded[0].willId ).toBe( 'will-1' )
      expect( ( recorded[0].envelope as any ).correlationId ).toBe( 'm1' )
    }
    finally { clearInboundRecorder( 'will-1' ) }
  } )

  it( 'does not record inbound when no recorder is registered', () => {
    f.ctrl.attach( f.instance )
    f.transport.injectInbound({ channel: 'inbound_message', kind: 'text', entityId: 'a', threadId: 't', content: 'hi', ...base( 'm1' ) })
    // No recorder registered → applyInbound dispatches but records nothing (no throw).
    expect( () => f.ctrl.applyInbound( f.instance, 1, f.deps as any ) ).not.toThrow()
    expect( f.ingest ).toHaveBeenCalledTimes( 1 )
  } )
} )

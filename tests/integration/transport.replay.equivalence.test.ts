// ─────────────────────────────────────────────────────────────
// tests/integration/transport.replay.equivalence.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Transport replay-equivalence — the analog of replay.equivalence (R2-d) for the
 * external transport, which is the simulation's *other* non-deterministic input.
 *
 *   Run A (record) — a live transport delivers inbound (messages + a result-ack)
 *     across several ticks. A recorder captures every applied envelope at its tick.
 *   Run B (re-feed) — a fresh controller with the recorded envelopes registered as
 *     an InboundSource and NO live socket injection. applyInbound() re-feeds the
 *     recorded batch each tick.
 *
 * Assertion: Run B dispatches the exact same sequence of inbound effects as Run A
 * (same ingests, same confirmExecution, in the same order) — proving the recorded
 * transport stream re-injects deterministically.
 */

import { describe, it, expect } from 'vitest'
import { TransportController } from '#stem/tracts/transport.controller'
import { LoopbackTransport }   from '#stem/tracts/transport/loopback.transport'
import { InboundQueue }        from '#stem/tracts/inbound.queue'
import {
  setInboundRecorder, clearInboundRecorder,
  setInboundSource,   clearInboundSource,
  RecordedInboundSource,
  type InboundRecord,
} from '#core/inbound.recorder'
import type { InboundEnvelope } from '#stem/tracts/transport/types'

const WILL = 'will-replay'

/** A controller fixture that records a trace of every dispatched inbound effect. */
function makeFixture(){
  const transport = new LoopbackTransport()
  const trace: string[] = []

  const instance: any = {
    config:    { id: WILL },
    transport,
    inbound:   new InboundQueue(),
    _transportUnsub: null,
    cognition: {
      auditionEngine: {
        ingest: ( i: any ) => { trace.push(`msg:${i.entityId}:${i.content ?? i.transcription}`); return Promise.resolve() },
        attachReplyCallback: () => {},
        addChunkCallback:    () => () => {},
      },
      planningEngine: { addActivityListener: () => () => {} },
    },
  }

  const deps = {
    effector: { confirmExecution: ( _i: any, id: string ) => { trace.push(`result:${id}`) } },
    outbox:  { confirmDelivery:  ( _i: any, id: string ) => { trace.push(`delivery:${id}`) } },
    sensory: { injectEvent:      ( _i: any, e: any ) => { trace.push(`percept:${e.type}`) } },
  }

  return { ctrl: new TransportController(), transport, instance, deps, trace }
}

const base = ( correlationId: string ) => ({ willId: WILL, correlationId, seq: 1, wallTime: 0 })
const msg  = ( id: string, entityId: string, content: string ): InboundEnvelope =>
  ({ channel: 'inbound_message', kind: 'text', entityId, threadId: 't', content, ...base( id ) })

describe('Transport replay-equivalence (R2-d analog)', () => {
  it('re-feeds the recorded inbound stream with identical dispatch', () => {
    // ── Run A: record ──────────────────────────────────────────
    const recorded: InboundRecord[] = []
    setInboundRecorder( WILL, { recordInbound: r => recorded.push( r ) } )

    const A = makeFixture()
    let traceA: string[]
    try {
      A.ctrl.attach( A.instance )

      A.transport.injectInbound( msg('m1', 'alice', 'hi') )
      A.ctrl.applyInbound( A.instance, 1, A.deps as any )

      A.ctrl.applyInbound( A.instance, 2, A.deps as any )   // quiet tick

      A.transport.injectInbound({ channel: 'ack', ackKind: 'result', result: { success: true, description: 'ok' }, ...base('inv1') })
      A.transport.injectInbound( msg('m2', 'bob', 'yo') )
      A.ctrl.applyInbound( A.instance, 3, A.deps as any )

      traceA = [ ...A.trace ]
    }
    finally { clearInboundRecorder( WILL ) }

    // The recorder captured one envelope per applied inbound (3 total).
    expect( recorded ).toHaveLength( 3 )
    expect( recorded.map( r => r.tick ) ).toEqual( [ 1, 3, 3 ] )
    expect( traceA ).toEqual( [ 'msg:alice:hi', 'result:inv1', 'msg:bob:yo' ] )

    // ── Run B: re-feed (no live socket) ────────────────────────
    setInboundSource( WILL, new RecordedInboundSource( recorded ) )
    const B = makeFixture()
    try {
      B.ctrl.attach( B.instance )
      // NOTE: no injectInbound — every envelope comes from the recorded source.
      B.ctrl.applyInbound( B.instance, 1, B.deps as any )
      B.ctrl.applyInbound( B.instance, 2, B.deps as any )
      B.ctrl.applyInbound( B.instance, 3, B.deps as any )
    }
    finally { clearInboundSource( WILL ) }

    // ── Equivalence ────────────────────────────────────────────
    expect( B.trace ).toEqual( traceA )
  } )

  it('a source run does not re-record (replay is not a new recording)', () => {
    const recorded: InboundRecord[] = [
      { tick: 1, willId: WILL, timestamp: 0, envelope: msg('m1', 'alice', 'hi') },
    ]
    // Both a source AND a recorder registered — the source wins, recorder stays idle.
    const reRecorded: InboundRecord[] = []
    setInboundSource( WILL, new RecordedInboundSource( recorded ) )
    setInboundRecorder( WILL, { recordInbound: r => reRecorded.push( r ) } )

    const B = makeFixture()
    try {
      B.ctrl.attach( B.instance )
      B.ctrl.applyInbound( B.instance, 1, B.deps as any )
    }
    finally { clearInboundSource( WILL ); clearInboundRecorder( WILL ) }

    expect( B.trace ).toEqual( [ 'msg:alice:hi' ] )   // re-fed + dispatched
    expect( reRecorded ).toHaveLength( 0 )            // but NOT re-recorded
  } )
} )

describe('RecordedInboundSource', () => {
  const rec = ( tick: number, id: string ): InboundRecord =>
    ({ tick, willId: WILL, timestamp: 0, envelope: msg( id, 'a', id ) })

  it('groups by tick in record order and returns [] for a quiet tick', () => {
    const src = new RecordedInboundSource( [ rec( 1, 'a'), rec( 3, 'b'), rec( 3, 'c') ] )
    expect( ( src.envelopesAt( 1 ) as any[] ).map( e => e.correlationId ) ).toEqual( [ 'a' ] )
    expect( src.envelopesAt( 2 ) ).toEqual( [] )                       // quiet tick
    expect( ( src.envelopesAt( 3 ) as any[] ).map( e => e.correlationId ) ).toEqual( [ 'b', 'c' ] )
  } )

  it('consumes a tick once — a second read is empty', () => {
    const src = new RecordedInboundSource( [ rec( 1, 'a') ] )
    expect( src.envelopesAt( 1 ) ).toHaveLength( 1 )
    expect( src.envelopesAt( 1 ) ).toEqual( [] )
  } )
} )

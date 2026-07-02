// ─────────────────────────────────────────────────────────────
// tests/integration/transport.reply.out.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §7.2 — message in → reply envelope out, over LoopbackTransport (off-tick).
 *
 * The whole inbound→reply path, end to end on the real seam:
 *   peer injects an inbound_message → InboundQueue → applyInbound() dispatches it
 *   to AuditionEngine.ingest() → the facet decides → the reply fast-path (2.1)
 *   fires the instant the decision lands → TransportController bridges it to
 *   transport.emit({ channel:'reply' }).
 *
 * "Off-tick, no tick required": the reply is emitted by the fast-path the moment
 * the facet decides — it does NOT ride the outbox tick-drain. So a `reply`
 * envelope appears with no `emitOutbox()` call and no `message` envelope.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine }       from '#senses/audition.engine/engine'
import { createTestBus }        from '#cognition/bus'
import { TransportController }   from '#stem/tracts/transport.controller'
import { LoopbackTransport }     from '#stem/tracts/transport/loopback.transport'
import { InboundQueue }          from '#stem/tracts/inbound.queue'
import type { InboundApplyDeps } from '#stem/tracts/transport.controller'

const WILL = 'will-reply-out'

/** Executive whose facet fires a canned decision synchronously on report(). */
function syncExecutive( reply: string ){
  return {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      const handle = {
        facetId: 'f1',
        report(){
          sub?.({
            decision: { reply, replyBubbles: reply.split( /\n{2,}/ ), targetEntityId: 'alice', requiresMasterAttention: false },
            reasoning: '',
            confidence: 0.9,
          })
        },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus(){}, setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }
}

/** Let the per-entity turn chain (microtasks) run to completion. */
const flush = () => new Promise( r => setTimeout( r, 0 ) )

function makeInstance( reply: string ){
  const transport = new LoopbackTransport()

  const auditionEngine = new AuditionEngine()
  auditionEngine.attachBus( createTestBus() )
  auditionEngine.attachExecutiveEngine( syncExecutive( reply ) as any )
  auditionEngine.attachGrants( { isAllowed: () => true } as any )   // listen + talk

  const instance: any = {
    config:    { id: WILL },
    transport,
    inbound:   new InboundQueue(),
    _transportUnsub: null,
    cognition: {
      auditionEngine,
      planningEngine: { addActivityListener: () => () => {} },
    },
  }

  // applyInbound only touches these for ack/percept channels — unused for an
  // inbound_message, but the signature requires them.
  const deps: InboundApplyDeps = {
    effector: { confirmExecution: () => {} } as any,
    outbox:  { confirmDelivery:  () => {} } as any,
    sensory: { injectEvent:      () => {} } as any,
  }

  return { transport, instance, deps }
}

describe( 'transport — message in → reply envelope out (§7.2)', () => {
  it( 'emits a reply envelope off-tick after an inbound message is applied', async () => {
    const { transport, instance, deps } = makeInstance( 'Hi there' )
    const ctrl = new TransportController()
    ctrl.attach( instance )

    // Peer sends an inbound message → lands on the tick-stamped queue.
    transport.injectInbound( {
      channel: 'inbound_message', kind: 'text',
      entityId: 'alice', threadId: 't1', content: 'hello',
      willId: WILL, correlationId: 'in-1', seq: 1, wallTime: 0,
    } )

    // Nothing is emitted before the inbound is applied.
    expect( transport.sentOn( 'reply' ) ).toHaveLength( 0 )

    // Apply the inbound at tick 1 — dispatches to AuditionEngine.ingest (async).
    ctrl.applyInbound( instance, 1, deps )
    await flush()

    // The reply fast-path emitted a single reply envelope — off-tick.
    const replies = transport.sentOn( 'reply' )
    expect( replies ).toHaveLength( 1 )
    const reply = replies[0]!
    expect( reply.entityId ).toBe( 'alice' )
    expect( reply.threadId ).toBe( 't1' )
    expect( reply.bubbles ).toEqual( [ 'Hi there' ] )
    expect( reply.willId ).toBe( WILL )

    // No tick drain happened: the reply did NOT ride the outbox (no message env).
    expect( transport.sentOn( 'message' ) ).toHaveLength( 0 )

    ctrl.detach( instance )
  } )

  it( 'splits a multi-paragraph reply into separate bubbles', async () => {
    const { transport, instance, deps } = makeInstance( 'First line.\n\nSecond line.' )
    const ctrl = new TransportController()
    ctrl.attach( instance )

    transport.injectInbound( {
      channel: 'inbound_message', kind: 'text',
      entityId: 'alice', threadId: 't1', content: 'tell me two things',
      willId: WILL, correlationId: 'in-1', seq: 1, wallTime: 0,
    } )
    ctrl.applyInbound( instance, 1, deps )
    await flush()

    const replies = transport.sentOn( 'reply' )
    expect( replies ).toHaveLength( 1 )
    expect( replies[0]!.bubbles ).toEqual( [ 'First line.', 'Second line.' ] )

    ctrl.detach( instance )
  } )
} )

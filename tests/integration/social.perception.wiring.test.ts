// ─────────────────────────────────────────────────────────────
// tests/integration/social.perception.wiring.test.ts
// ─────────────────────────────────────────────────────────────
// #113 — SocialPerception matched no entity type the mind emits.
//
// Its defaults named a vocabulary that never existed here ('agent', 'user',
// 'contact', 'persona' / 'message', 'action', 'expression', 'social_signal',
// 'communication'); measured against a live session the overlap with the emitted
// types was EMPTY. Since it is the sole publisher of `interaction.occurred`, every
// consumer — ReputationTracker, AffectiveBlender, TheoryOfMind, FrustrationEvaluator,
// AttachmentEvaluator — received nothing, ever. A Will held 27 exchanges with
// someone and still carried familiarity 0, valence 0 for them.
//
// Two halves had to land together: an inbound message created no state entity at
// all, so renaming alone would have fed the engine only `conversation.sent` and let
// the Will build impressions of people out of its own monologue.

import { describe, it, expect } from 'vitest'
import { AuditionEngine }        from '#senses/audition.engine/engine'
import { SocialPerception }      from '#faculties/social.perception'
import { ReputationTracker }     from '#faculties/reputation.tracker'
import { createTestBus }         from '#cognition/bus'
import { DefaultStateManager }   from '#core/state.manager'
import type { TextMessage }      from '#senses/index'

function syncExecutive( reply: string ){
  return {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      return { attention: 'available' as const, handle: {
        facetId: 'f1',
        report(){ sub?.({ decision: { reply, replyBubbles: [ reply ], targetEntityId: 'alice',
          requiresMasterAttention: false }, reasoning: '', confidence: 0.9 } ) },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus(){}, setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      } }
    },
  }
}

/** Capture every event an engine publishes on the bus. */
function capturingBus(){
  const events: Array<{ type: string; payload: any }> = []
  const base = createTestBus() as any
  return {
    events,
    bus: {
      ...base,
      publish: ( e: any ) => { events.push( e ); return base.publish?.( e ) },
      subscribe: base.subscribe?.bind( base ) ?? ( () => () => {} ),
    },
  }
}

async function inboundReaches( sm: DefaultStateManager, content: string ){
  const engine = new AuditionEngine()
  engine.attachBus( createTestBus() )
  engine.attachExecutiveEngine( syncExecutive('noted') as any )
  engine.attachMemorySink( e => sm.setEntity( e ) )
  await engine.sense( { kind: 'text', entityId: 'alice', threadId: 't1', content } as TextMessage )
}

describe('#113 — an inbound message reaches social cognition', () => {
  it('audition writes the inbound to state as a perceptible social signal', async () => {
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )

    await inboundReaches( sm, 'Not ready to talk now. Can we connect later?')

    const received = [ ...sm.snapshot().entities.values() ]
      .filter( ( e: any ) => e.type === 'conversation.received')
    expect( received ).toHaveLength( 1 )

    const m = received[0]!.metadata as any
    expect( m.sourceKeid ).toBe('alice')       // SocialPerception reads this as "who acted"
    expect( m.directedAtSelf ).toBe( true )    // an inbound turn is addressed to us
    expect( m.preview ).toContain('connect later')
    // Valence is deliberately unset — the words have not been appraised, and
    // inventing a number here would feed reputation a sentiment nobody measured.
    expect( m.valence ).toBeUndefined()
  } )

  it('SocialPerception turns it into interaction.occurred', async () => {
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )
    await inboundReaches( sm, 'Morning — what is in flight?')

    const cap = capturingBus()
    const social = new SocialPerception()
    social.attachBus( cap.bus as never )

    sm.updateClock( 2 as any, 2000 as any )
    await social.react( 0 as any, 2 as any, sm.snapshot() as any, {} as any )

    const interactions = cap.events.filter( e => e.type === 'interaction.occurred')
    expect( interactions ).toHaveLength( 1 )
    expect( interactions[0]!.payload.keid ).toBe('alice')
    expect( interactions[0]!.payload.directedAtSelf ).toBe( true )
  } )

  it('ReputationTracker actually subscribes to what is now published', () => {
    // The link that was dead: the publisher matched nothing, so this subscription
    // was live and starved rather than missing.
    expect( new ReputationTracker().subscribes() ).toContain('interaction.occurred')
    expect( new SocialPerception().publishes().map( p => p.type ) ).toContain('interaction.occurred')
  } )

  it('consumes the signal once — it does not re-fire every tick', async () => {
    // conversation.received is written OFF-tick and carries no `tick` to age on, so
    // the TTL sweep could never collect it. Left in state it would republish the same
    // interaction forever, teaching reputation from one message endlessly.
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )
    await inboundReaches( sm, 'hello')

    const social = new SocialPerception()
    social.attachBus( createTestBus() as never )

    sm.updateClock( 2 as any, 2000 as any )
    const res = await social.react( 0 as any, 2 as any, sm.snapshot() as any, {} as any )

    const receivedId = [ ...sm.snapshot().entities.values() ]
      .find( ( e: any ) => e.type === 'conversation.received')!.id as string
    expect( res.commands?.delete ?? [] ).toContain( receivedId )
  } )

  it('does not scan our own outbound as someone acting toward us', async () => {
    // Feeding conversation.sent here would let the Will form impressions of people
    // from its own monologue — worse than learning nothing.
    const sm = new DefaultStateManager()
    sm.updateClock( 1 as any, 1000 as any )
    sm.setEntity( {
      id: 'conv-sent-alice-1', type: 'conversation.sent',
      metadata: { targetEntityId: 'alice', preview: 'me talking', tick: 1 },
    } )

    const cap = capturingBus()
    const social = new SocialPerception()
    social.attachBus( cap.bus as never )

    sm.updateClock( 2 as any, 2000 as any )
    await social.react( 0 as any, 2 as any, sm.snapshot() as any, {} as any )

    expect( cap.events.filter( e => e.type === 'interaction.occurred') ).toHaveLength( 0 )
  } )
} )

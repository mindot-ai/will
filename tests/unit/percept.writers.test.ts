// ─────────────────────────────────────────────────────────────
// tests/unit/percept.writers.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P0 step 2 — the four writers that were not exteroception.
 *
 * Two forgot `tick` and were therefore IMMORTAL: `exteroception` is the only
 * sweeper of `type: 'percept'` and collects only entities whose `metadata.tick`
 * is a number. Three forgot `provenance` and were therefore UNRUPTURABLE:
 * `action.selector`'s gate counts only `'exafferent'` percepts.
 *
 * These pin what changed, because the whole suite passed before and after the
 * retrofit — which meant nothing covered either fault. A green suite over a
 * behaviour change is a statement about the tests, not the change.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity } from '#core/types'
import { Exteroception } from '#faculties/exteroception'
import { PERCEPT_STALE_AFTER_TICKS } from '#cognition/percept.entity'
import type { SensoryInput } from '#senses/index'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const frozen = ( s: MutState ) => s as unknown as ReadonlySimulationState

function stateWith( entities: SimulationEntity[] ): MutState {
  const m = new Map<string, SimulationEntity>()
  for( const e of entities ) m.set( e.id, e )
  return { tick: 0, time: 0, entities: m, metrics: new Map() }
}

/** Run one Exteroception tick and return the ids it asked to delete. */
async function swept( entities: SimulationEntity[], tick: number ): Promise<string[]> {
  const eng = new Exteroception()
  const r = await eng.react( 0, tick, frozen( stateWith( entities ) ), CTX )
  return r.commands?.delete ?? []
}

const percept = ( id: string, metadata: Record<string, unknown> ): SimulationEntity =>
  ( { id, type: 'percept', createdAt: 0, updatedAt: 0, metadata } as SimulationEntity )

describe('the sweeper only ever saw percepts that carried a tick', () => {
  it('a ticked percept is collected once it is stale', async () => {
    const stale = percept('p-ticked', { tick: 0, salience: 0.3, category: 'c', summary: 's', provenance: 'exafferent' } )
    expect( await swept( [ stale ], PERCEPT_STALE_AFTER_TICKS + 1 ) ).toContain('p-ticked')
  } )

  it('a TICKLESS percept is never collected, at any age — the shape of the old leak', async () => {
    // This is what `msg-delivered-<id>` and `percept-wake-event` used to be.
    // Not a slow leak: an entity that can never be collected, one per message
    // the mind ever successfully sent.
    const immortal = percept('p-tickless', { salience: 0.6, category: 'message-delivery', summary: 's', provenance: 'reafferent' } )
    expect( await swept( [ immortal ], 10_000 ) ).not.toContain('p-tickless')
  } )
} )

describe('the retrofitted writers produce sweepable, tagged percepts', () => {
  // Shape assertions against the real writers, reached through their public
  // entry points, so a future hand-rolled literal that skips perceptEntity()
  // fails here rather than silently rejoining the leak.

  it('a delivery ack goes in through the sense door, not around it — P4', async () => {
    // The tract used to build the percept entity itself and `setEntity` it. It
    // is reafference by construction — the words went out and the world said
    // whether they landed — so it now goes through the door that carries
    // exactly that, and the percept is stamped, traced and swept by the same
    // machinery as every other one.
    const { OutboxController } = await import('#stem/tracts/outbox.controller')
    const written: SimulationEntity[] = []
    const sensed: SensoryInput[] = []
    const instance = {
      tickCount: 12,
      config: { id: 'w' },
      cognition: { somatosensationEngine: { sense: async ( i: SensoryInput ) => { sensed.push( i ) } } },
      simulation: { stateManager: {
        setEntity: ( e: SimulationEntity ) => written.push( e ),
        getEntitiesByType: () => [],
      } },
      outbox: { messages: [] },
    } as never

    new OutboxController().confirmDelivery( instance, 'm-1', true )

    // Nothing written by hand any more — the success condition of P4 for this
    // writer, asserted rather than described.
    expect( written.find( e => e.type === 'percept') ).toBeUndefined()

    expect( sensed ).toHaveLength( 1 )
    const signal = sensed[0] as SensoryInput & { signal: string; data: Record<string, unknown> }
    expect( signal.kind ).toBe('system')
    expect( signal.provenance ).toBe('reafferent')
    // The FACTS, not a sentence about them: which message, and whether it landed.
    expect( signal.data['messageId'] ).toBe('m-1')
    expect( signal.data['delivered'] ).toBe( true )
  } )

  it('an escalation percept is built, not hand-rolled — and its steer survives whole', async () => {
    // These two were the last `type: 'percept'` literals written by hand, which
    // is exactly how `tick` went missing on the wake and delivery percepts and
    // made them immortal. They go through `perceptEntity()` now.
    //
    // They deliberately do NOT go through a sense door: a facet handing off to
    // the master crosses no boundary — it never left the mind — and routing it
    // through a sense would dress one part of a mind up as news from outside.
    const { EscalationBuffer } = await import('#faculties/executive.engine/escalation.buffer')
    const buf = new EscalationBuffer()
    buf.push( { facetId: 'f-1', subjectEntityId: 'ke:ada', subjectName: 'Ada', threadId: 't-1',
                tick: 41, body: { kind: 'undertaking', target: 'ke:fkem',
                                  gist: 'the pricing question', reasoning: 'promised it' } } )
    buf.push( { facetId: 'f-2', tick: 42,
                body: { kind: 'escalation', reasoning: 'the roadmap needs re-planning' } } )

    const { percepts } = buf.drainToPercepts()
    expect( percepts ).toHaveLength( 2 )

    for( const p of percepts ){
      expect( p.type ).toBe('percept')
      // The core the builder owns and a writer cannot lose.
      expect( typeof p.metadata!['tick'] ).toBe('number')      // the sweeper reads this and nothing else
      expect( p.metadata!['provenance'] ).toBe('reafferent')   // its own part's doing, not the world's
      expect( p.metadata!['salience'] ).toBe( 0.85 )
      // The writer's own fields survive beside it.
      expect( p.metadata!['source'] ).toBe('executive-facet')
    }

    const undertaking = percepts.find( p => p.metadata!['category'] === 'undertaking' )!
    expect( undertaking.metadata!['tick'] ).toBe( 41 )
    expect( undertaking.metadata!['undertakingTarget'] ).toBe('ke:fkem')
    expect( undertaking.metadata!['entityId'] ).toBe('ke:ada')

    // NOT capped. `perceptEntity` bounds nothing, and it must not here: the
    // whole actionable steer lives in `summary` because that is the only field
    // `extractPercepts` renders. A cap would silently eat the clause that tells
    // the mind the words have not actually gone out.
    const summary = String( undertaking.metadata!['summary'] )
    expect( summary.length ).toBeGreaterThan( 200 )
    expect( summary ).toContain('Nothing has gone to them yet')
  } )

  it('and the percept that comes out of that door is tick-stamped, so it expires', async () => {
    // The guarantee the old hand-written test protected, kept — now proven
    // through the real door rather than at the writer's own literal.
    const { SomatosensationEngine } = await import('#senses/somatosensation.engine')
    const traced: Array<{ metadata: Record<string, unknown> }> = []
    const e = new SomatosensationEngine()
    e.attachBus( { publish: () => {}, subscribe: () => {} } as never )
    e.attachPerceptTrace( x => traced.push( x as never ), () => 12 )

    await e.sense( { kind: 'system', signal: 'message_delivery', provenance: 'reafferent',
                     data: { messageId: 'm-1', delivered: false, salience: 0.6,
                             summary: 'My message failed to reach the recipient.' } } )

    expect( traced ).toHaveLength( 1 )
    expect( typeof traced[0]!.metadata['tick'] ).toBe('number')   // the sweeper reads this and nothing else
    expect( traced[0]!.metadata['tick'] ).toBe( 12 )
    expect( traced[0]!.metadata['provenance'] ).toBe('reafferent')
    expect( traced[0]!.metadata['salience'] ).toBe( 0.6 )         // a failure outranks a success
    // The evidence survives the label: a mind can still say WHICH message.
    expect( ( traced[0]!.metadata['data'] as Record<string, unknown> )['messageId'] ).toBe('m-1')
  } )

  it('a delivery percept written at tick N is swept by tick N+3', async () => {
    // End to end: the leak is closed, not merely annotated.
    const delivered = percept('msg-delivered-m-1', {
      tick: 12, salience: 0.35, category: 'message-delivery',
      summary: 'My message was delivered successfully.', provenance: 'reafferent', messageId: 'm-1',
    } )
    expect( await swept( [ delivered ], 12 + PERCEPT_STALE_AFTER_TICKS + 1 ) ).toContain('msg-delivered-m-1')
  } )
} )

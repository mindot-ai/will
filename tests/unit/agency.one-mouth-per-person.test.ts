// ─────────────────────────────────────────────────────────────
// tests/unit/agency.one-mouth-per-person.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * One mind, one voice per person at a time.
 *
 * A reply and a self-initiated message are two different paths to the same
 * human. The audition facet answers what they said and delivers through the
 * outbox; the agency delivers what it decided to say through the communicator.
 * Neither can see the other, and `outreach.duplication.test.ts` only closes the
 * case where both are AUTHORING — the guard there is on composing, not sending.
 *
 * Observed live at 11:59:42.xxx: a conversation facet's reply and a proactive
 * message reached the same person in the same millisecond. To them it read as
 * one person saying two unrelated things at once; to her it read as having
 * reached out twice.
 *
 * So the agency asks before it speaks. Holding costs a tick and the words keep —
 * and if what they just said changes what she meant to say, `situationMoved`
 * catches that on the way back round, which is the outcome we want anyway.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'
import type { OutreachAuthor } from '#agency/engines/motor.schema.executor'

const CTX = {} as unknown as SimulationContext

interface Mut { tick: number; time: number; entities: Map<string, unknown>; metrics: Map<string, number> }

const freshState = (): Mut =>
  ({ tick: 0, time: 0, entities: new Map(), metrics: new Map([ [ 'energy.level', 80 ] ]) })

const frozen = ( s: Mut ) => s as unknown as ReadonlySimulationState

function apply( s: Mut, set?: EntityInput[], del?: string[] ): void {
  for( const e of set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } )
  for( const id of del ?? [] ) s.entities.delete( id )
}

function reachOut( s: Mut, id: string ): void {
  s.entities.set( id, {
    id, type: 'agency.intent', createdAt: 0, updatedAt: 0,
    metadata: {
      schema: 'reach-out', status: 'selected',
      targetEntityId: 'ke:ada', parameters: { targetEntityName: 'Ada' },
      expectedReward: 0.6, expectedValence: 0.2,
    },
  } )
}

/** An author with words ready, and a turn flag the test drives. */
function author( speaking: { now: boolean } ): OutreachAuthor {
  return {
    authorOutreach: async () => ( { bubbles: [ 'Ada — any movement on the RFC?' ], answered: true } ),
    isSpeakingTo:   () => speaking.now,
  }
}

/** A delivery layer that counts what actually left. */
function comms(){
  const sent: string[][] = []
  return {
    sent,
    layer: {
      executeAction: async ( req: { parameters: { messages: string[] } } ) => {
        sent.push( req.parameters.messages )
        return { success: true, description: 'sent', commands: { set: [] },
          feedback: { outcomeQuality: 0.85, surprise: 0, lessons: [] } }
      },
    } as never,
  }
}

const allowAll = () => ( { isAllowed: () => true } as never )

async function step( s: Mut, exec: MotorSchemaExecutor, t: number ){
  s.tick = t
  const r = await exec.react( 0, t, frozen( s ), CTX )
  apply( s, r.commands?.set, r.commands?.delete )
  await new Promise( r => setImmediate( r ) )
  return r
}

describe('speaking to someone who is already being answered', () => {
  it('holds the self-initiated message while a turn with them is in flight', async () => {
    const s = freshState()
    const speaking = { now: false }
    const c = comms()
    const exec = new MotorSchemaExecutor()
    exec.attachProactiveCommunicator( c.layer )
    exec.attachGrants( allowAll() )
    exec.attachOutreachAuthor( author( speaking ) )
    reachOut( s, 'intent-1')

    await step( s, exec, 1 )              // asks for words
    speaking.now = true                   // they say something; a reply is being formed
    await step( s, exec, 2 )
    await step( s, exec, 3 )

    expect( c.sent, 'a proactive message left while she was mid-reply').toEqual( [] )
    expect( s.entities.has('intent-1'), 'the intent must be held, not resolved').toBe( true )
  } )

  it('delivers it once the turn has landed — the words keep', async () => {
    const s = freshState()
    const speaking = { now: false }
    const c = comms()
    const exec = new MotorSchemaExecutor()
    exec.attachProactiveCommunicator( c.layer )
    exec.attachGrants( allowAll() )
    exec.attachOutreachAuthor( author( speaking ) )
    reachOut( s, 'intent-1')

    await step( s, exec, 1 )
    speaking.now = true
    await step( s, exec, 2 )
    speaking.now = false                  // the reply landed; the floor is free
    await step( s, exec, 3 )

    expect( c.sent, 'the held words were lost instead of sent').toEqual(
      [ [ 'Ada — any movement on the RFC?' ] ] )
    expect( s.entities.has('intent-1') ).toBe( false )
  } )

  it('says so in the metrics, so a held message is not an invisible one', async () => {
    const s = freshState()
    const speaking = { now: false }
    const c = comms()
    const exec = new MotorSchemaExecutor()
    exec.attachProactiveCommunicator( c.layer )
    exec.attachGrants( allowAll() )
    exec.attachOutreachAuthor( author( speaking ) )
    reachOut( s, 'intent-1')

    await step( s, exec, 1 )
    speaking.now = true
    const r = await step( s, exec, 2 )

    expect( ( r.commands?.metrics ?? [] ).some( ( [ k ] ) => k === 'agency.communicate.mid_turn') ).toBe( true )
  } )

  it('an author that cannot say is not blocking', async () => {
    // `isSpeakingTo` is optional — a host-supplied author, or any of the doubles
    // written before it existed, must still be able to deliver.
    const s = freshState()
    const c = comms()
    const exec = new MotorSchemaExecutor()
    exec.attachProactiveCommunicator( c.layer )
    exec.attachGrants( allowAll() )
    exec.attachOutreachAuthor({ authorOutreach: async () => ( { bubbles: [ 'hello' ], answered: true } ) })
    reachOut( s, 'intent-1')

    await step( s, exec, 1 )
    await step( s, exec, 2 )

    expect( c.sent ).toEqual( [ [ 'hello' ] ] )
  } )
} )

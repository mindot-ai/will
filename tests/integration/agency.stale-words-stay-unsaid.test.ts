// ─────────────────────────────────────────────────────────────
// tests/integration/agency.stale-words-stay-unsaid.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The door, not the decision.
 *
 * `agency.the-moment-passed.test.ts` pins `situationMoved` as a function. This
 * runs the real executor, because the defect being fixed is not "the predicate
 * is wrong" — it is that nothing consulted a predicate at all. Words a facet
 * composed off-tick went straight out whenever they happened to arrive.
 *
 * What must hold end to end:
 *   • stale words are NOT delivered,
 *   • and resolve as WITHHELD — the mind chose not to say them, it did not fail
 *     to say them, so `reach-out` takes no competence hit (the #123 mistake),
 *   • fresh words still go out, or the fix is just a mute button.
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
      targetEntityId: 'ke:fabrice', parameters: { targetEntityName: 'Fabrice' },
      expectedReward: 0.6, expectedValence: 0.2,
    },
  } )
}

/** The mind having spoken to someone — the durable record every speaking path writes. */
function spokeTo( s: Mut, target: string, tick: number, id = `conversation-sent-${ tick }` ): void {
  s.entities.set( id, {
    id, type: 'conversation.sent', createdAt: 0, updatedAt: 0,
    metadata: { targetEntityId: target, tick },
  } )
}

const author = ( bubbles: string[] ): OutreachAuthor => ({ authorOutreach: async () => bubbles })

function executor( sentTexts: string[][] ): MotorSchemaExecutor {
  const exec = new MotorSchemaExecutor()
  exec.attachProactiveCommunicator({
    executeAction: async ( req: { parameters: { messages: string[] } } ) => {
      sentTexts.push( req.parameters.messages )
      return { success: true, description: 'sent', commands: { set: [] },
        feedback: { outcomeQuality: 0.85, surprise: 0, lessons: [] } }
    },
  } as never )
  exec.attachGrants({ isAllowed: () => true } as never )
  exec.attachOutreachAuthor( author([
    'Fabrice — here is where I am on the operational picture…',
    'To turn it into something useful I need a brain-dump from you',
  ]) )
  return exec
}

async function run( s: Mut, exec: MotorSchemaExecutor, ticks: number, onTick?: ( t: number ) => void ) {
  const outcomes: Array<Record<string, unknown>> = []
  for( let t = 1; t <= ticks; t++ ){
    s.tick = t
    onTick?.( t )
    const r = await exec.react( 0, t, frozen( s ), CTX )
    for( const e of r.commands?.set ?? [] )
      if( e.type === 'agency.outcome') outcomes.push( e.metadata as Record<string, unknown> )
    apply( s, r.commands?.set, r.commands?.delete )
    await new Promise( res => setImmediate( res ) )   // let the authoring promise settle
  }
  return outcomes
}

// ─────────────────────────────────────────────────────────────

describe('words the situation has moved past', () => {
  it('are not delivered — the live Fabrice sequence', async () => {
    // t1: outreach committed, authoring requested.
    // t2: the mind answers him ("Understood. I'm here when you're ready.").
    // t3: the composition, formed at t1, tries to land on top of that answer.
    const sent: string[][] = []
    const s = freshState()
    const exec = executor( sent )
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, 6, t => {
      if( t === 2 ) spokeTo( s, 'ke:fabrice', 2 )
    })

    expect( sent, 'the stale composition went out on top of the mind\'s own answer').toEqual( [] )

    const held = outcomes.find( o => o['withheld'] === true )
    expect( held, 'it must resolve, not rot — a stranded intent blocks the serial mind').toBeDefined()
    expect( held!['description'] ).toMatch( /already spoken to them since composing/ )
  })

  it('take no competence hit — the mind did not fail to speak', async () => {
    // The #123 mistake, which this must not reintroduce: an intent that resolves
    // as a FAILURE teaches reafference that `reach-out` is unreliable. Choosing
    // not to say something is a judgement, not an inability.
    const sent: string[][] = []
    const s = freshState()
    const exec = executor( sent )
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, 6, t => {
      if( t === 2 ) spokeTo( s, 'ke:fabrice', 2 )
    })

    const held = outcomes.filter( o => o['withheld'] === true )
    expect( held, 'nothing was withheld, so this asserts nothing').toHaveLength( 1 )
    expect( held[0]!['success'], 'a withheld turn must not read as a failed act').toBeUndefined()
    expect( outcomes.some( o => o['success'] === false ),
      'no outcome may report a failed act — that is what taught the competence hit').toBe( false )
  })

  it('still go out when nothing has changed', async () => {
    // Without this the fix is a mute button. Same setup, no intervening turn.
    const sent: string[][] = []
    const s = freshState()
    const exec = executor( sent )
    reachOut( s, 'intent-1')

    await run( s, exec, 6 )

    expect( sent.length, 'a mind with something to say and no reason to hold it must speak').toBe( 1 )
    expect( sent[0] ).toHaveLength( 2 )
  })

  it('still go out when the only turn predates the composition', async () => {
    // Having spoken to them BEFORE composing is the ordinary case — it is
    // usually what prompted the outreach in the first place.
    const sent: string[][] = []
    const s = freshState()
    spokeTo( s, 'ke:fabrice', 0 )
    const exec = executor( sent )
    reachOut( s, 'intent-1')

    await run( s, exec, 6 )
    expect( sent.length ).toBe( 1 )
  })

  it('are unaffected by a conversation with somebody else', async () => {
    const sent: string[][] = []
    const s = freshState()
    const exec = executor( sent )
    reachOut( s, 'intent-1')

    await run( s, exec, 6, t => { if( t === 2 ) spokeTo( s, 'ke:fkem', 2 ) })
    expect( sent.length, 'talking to one person must not mute the mind toward another').toBe( 1 )
  })
})

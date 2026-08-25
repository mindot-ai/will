// ─────────────────────────────────────────────────────────────
// tests/unit/agency.an-empty-answer-is-still-an-answer.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A facet that reasoned and came back with nothing has ANSWERED. Waiting out the
 * clock on it does not turn that into words — it turns it into a failure.
 *
 * `agency.chosen-silence.test.ts` establishes the ambiguity: empty bubbles are
 * also what a timed-out facet, a full facet budget, and a pass deferring to one
 * already in flight return, so empty alone cannot resolve an intent. What it
 * left open is the case in the middle — a pass that DID run and held neither
 * words nor a declared silence. That was indistinguishable from a dead author,
 * so it sat 'awaiting' until AWAIT_TIMEOUT abandoned it as a FAILED ACT.
 *
 * Live, that cost a person a message. A COO committed to contacting someone and
 * willed it nineteen times across three master cycles — right target, right
 * addresses, words in hand — and not one authoring pass produced reply text,
 * because she believed she had already sent it. Nineteen intents, zero messages,
 * and `communicate.withheld` stood at 1 for the entire run: nothing anywhere
 * recorded a decision not to speak, because she never made one. What the mind
 * learned instead was nineteen failures at reaching out.
 *
 * So `OutreachResult.answered` carries the one fact the caller cannot infer —
 * whether a pass ran at all. An empty ANSWER resolves now, and teaches nothing.
 * An empty NON-answer keeps holding and the clock still abandons it, exactly as
 * before.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { MotorSchemaExecutor, AWAIT_TIMEOUT } from '#agency/engines/motor.schema.executor'
import type { OutreachAuthor, OutreachResult } from '#agency/engines/motor.schema.executor'

const CTX = {} as unknown as SimulationContext

interface Mut { tick: number; time: number; entities: Map<string, unknown>; metrics: Map<string, number> }

const freshState = (): Mut =>
  ({ tick: 0, time: 0, entities: new Map(), metrics: new Map([ [ 'energy.level', 80 ] ]) })

const frozen = ( s: Mut ) => s as unknown as ReadonlySimulationState

function apply( s: Mut, set?: EntityInput[], del?: string[] ): void {
  for( const e of set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } )
  for( const id of del ?? [] ) s.entities.delete( id )
}

/** A committed outreach the selector has just won — 'selected', so authoring is requested. */
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

/** An author that counts how many times it was asked. */
function countingAuthor( result: OutreachResult ): OutreachAuthor & { asked: number } {
  const a = {
    asked: 0,
    authorOutreach: async () => { a.asked++; return result },
  }
  return a
}

const comms = () => ({
  executeAction: async () => ({
    success: true, description: 'sent', commands: { set: [] },
    feedback: { outcomeQuality: 0.85, surprise: 0, lessons: [] },
  }),
} as never )
const allowAll = () => ( { isAllowed: () => true } as never )

function executor( author: OutreachAuthor ): MotorSchemaExecutor {
  const exec = new MotorSchemaExecutor()
  exec.attachProactiveCommunicator( comms() )
  exec.attachGrants( allowAll() )
  exec.attachOutreachAuthor( author )
  return exec
}

async function run( s: Mut, exec: MotorSchemaExecutor, ticks: number ) {
  const outcomes: Array<Record<string, unknown>> = []
  for( let t = 1; t <= ticks; t++ ){
    s.tick = t
    const r = await exec.react( 0, t, frozen( s ), CTX )
    for( const e of r.commands?.set ?? [] )
      if( e.type === 'agency.outcome') outcomes.push( e.metadata as Record<string, unknown> )
    apply( s, r.commands?.set, r.commands?.delete )
    await new Promise( r => setImmediate( r ) )   // let the authoring promise settle
  }
  return outcomes
}

describe('a pass that came back with nothing', () => {
  it('resolves the intent instead of leaving it to rot', async () => {
    const s = freshState()
    reachOut( s, 'intent-1')

    const outcomes = await run( s, executor( countingAuthor({ bubbles: [], answered: true }) ), 5 )
    const held = outcomes.find( o => o['withheld'] === true )

    expect( AWAIT_TIMEOUT ).toBeGreaterThan( 5 )      // resolved on its own, not by the clock
    expect( held, 'an answered-but-empty pass produced no outcome').toBeDefined()
    expect( held!['schema'] ).toBe('reach-out')
    expect( s.entities.has('intent-1'), 'the intent must be freed').toBe( false )
  })

  it('teaches nothing about being bad at speaking', async () => {
    // The #123 regression: nothing was said, so nothing may be scored as a failed
    // act. `withheld` is read only by the executive's record of what it did.
    const s = freshState()
    reachOut( s, 'intent-1')

    const outcomes = await run( s, executor( countingAuthor({ bubbles: [], answered: true }) ), 5 )
    const held = outcomes.find( o => o['withheld'] === true )

    expect( held!['success'] ).toBeUndefined()
    expect( outcomes.some( o => o['success'] === false ) ).toBe( false )
  })

  it('says what actually happened, not that she chose silence', async () => {
    const s = freshState()
    reachOut( s, 'intent-1')

    const outcomes = await run( s, executor( countingAuthor({ bubbles: [], answered: true }) ), 5 )
    const why = String( outcomes.find( o => o['withheld'] === true )!['description'] )

    // She did not decide against speaking — no words came. Recording it as a
    // declared silence would put a decision in her history she never made.
    expect( why ).not.toMatch( /chose not to/i )
    expect( why ).toMatch( /no words/i )
  })
})

describe('a pass that never ran', () => {
  it('is still abandoned by the clock, as a failure', async () => {
    // No `answered`: a dead author, a full budget, a pass deferring to one in
    // flight. Unchanged behaviour, and the contrast that makes `answered`
    // load-bearing rather than decorative — same empty bubbles, opposite fate.
    const s = freshState()
    reachOut( s, 'intent-1')

    const outcomes = await run( s, executor( countingAuthor({ bubbles: [] }) ), AWAIT_TIMEOUT + 3 )

    expect( outcomes.some( o => o['withheld'] === true ),
      'no pass ran, so nothing was withheld').toBe( false )
    expect( outcomes.some( o => o['success'] === false ),
      'a genuinely dead author is still abandoned by the clock').toBe( true )
  })

  it('and takes the whole clock to get there, where an answer takes one tick', async () => {
    // The cost the fix removes: an intent the mind has already answered about
    // occupies the awaiting slot for AWAIT_TIMEOUT ticks before anything happens.
    const answered = freshState(); reachOut( answered, 'intent-1')
    const silent   = freshState(); reachOut( silent,   'intent-1')

    const early = await run( answered, executor( countingAuthor({ bubbles: [], answered: true }) ), 3 )
    const late  = await run( silent,   executor( countingAuthor({ bubbles: [] }) ),                 3 )

    expect( early.length, 'an answered pass must resolve inside three ticks').toBeGreaterThan( 0 )
    expect( late.length,  'an unanswered one must still be waiting').toBe( 0 )
  })

  it('a declared silence still beats an empty answer', async () => {
    const s = freshState()
    reachOut( s, 'intent-1')

    const outcomes = await run( s, executor( countingAuthor({ bubbles: [], withheld: true, answered: true }) ), 5 )
    const why = String( outcomes.find( o => o['withheld'] === true )!['description'] )

    expect( why ).toMatch( /chose not to/i )
  })
})

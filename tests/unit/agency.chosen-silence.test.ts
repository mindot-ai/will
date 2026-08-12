// ─────────────────────────────────────────────────────────────
// tests/unit/agency.chosen-silence.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Deciding not to speak is a decision, not an inability to speak.
 *
 * A declined outreach used to resolve by ROTTING. The facet was asked for words,
 * chose silence, returned none — and the intent sat 'awaiting' until
 * AWAIT_TIMEOUT abandoned it as a FAILURE, which reafference then folded into
 * `reach-out`'s competence. The mind was learning it is bad at speaking from the
 * times it decided not to speak. Live, a COO declining correctly ("nothing new
 * to add — a sixth message would repeat") took a competence hit for the
 * judgement, three times in one run.
 *
 * The fix is NOT "empty words mean silence". Empty is ambiguous: it is also what
 * a timed-out facet, a full facet budget, and a pass deferring to one already in
 * flight all return — and that last one explicitly wants to come back round. The
 * mind's own DECLARATION is the signal, carried from the `noMessage` block
 * through `ConversationDecision.withheld` to `OutreachResult.withheld`.
 *
 * So: a declared silence resolves the intent and teaches nothing. Anything else
 * empty keeps holding, and the clock still abandons a genuinely dead author —
 * which is what `agency.execution.test.ts` pins, and what caught this when the
 * first cut of the fix collapsed the two.
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

/**
 * A committed outreach the selector has just won.
 *
 * Deliberately 'selected', not 'awaiting': authoring is requested from the
 * delivery path, and an intent parachuted straight into 'awaiting' is one nobody
 * ever asked a facet about. (Which is how the first cut of this test failed —
 * worth keeping in the helper so the next reader does not repeat it.)
 */
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

const author = ( result: OutreachResult | string[] ): OutreachAuthor => ({
  authorOutreach: async () => result,
})

/**
 * A delivery layer that accepts whatever it is handed.
 *
 * Required, not decoration: `_deliver` returns false immediately without a
 * ProactiveCommunicator, so authoring is never requested and the facet is never
 * asked anything at all. (The first cut of this test omitted it and read as the
 * fix not working.)
 */
const comms = () => ({
  executeAction: async () => ({
    success: true, description: 'sent', commands: { set: [] },
    feedback: { outcomeQuality: 0.85, surprise: 0, lessons: [] },
  }),
} as never )
const allowAll = () => ( { isAllowed: () => true } as never )

/** An executor wired for outreach, with the given authoring outcome. */
function executor( result: OutreachResult | string[] ): MotorSchemaExecutor {
  const exec = new MotorSchemaExecutor()
  exec.attachProactiveCommunicator( comms() )
  exec.attachGrants( allowAll() )
  exec.attachOutreachAuthor( author( result ) )
  return exec
}

/** Run the executor forward, applying its commands, and collect every outcome. */
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

describe('deciding not to speak', () => {
  it('resolves as withheld — not as a failure to speak', async () => {
    const s = freshState()
    const exec = executor({ bubbles: [], withheld: true })
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, 5 )
    const held = outcomes.find( o => o['withheld'] === true )

    expect( held, 'a declared silence produced no outcome at all').toBeDefined()
    expect( held!['schema'] ).toBe('reach-out')
    // It must NOT read as a failed act — that is what taught the competence hit.
    expect( held!['success'] ).toBeUndefined()
    expect( s.entities.has('intent-1'), 'the intent must be freed, not left to rot').toBe( false )
  })

  it('does not wait out the clock — the answer came, it was just "no"', async () => {
    const s = freshState()
    const exec = executor({ bubbles: [], withheld: true })
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, 4 )          // well inside AWAIT_TIMEOUT
    expect( AWAIT_TIMEOUT ).toBeGreaterThan( 4 )
    expect( outcomes.some( o => o['withheld'] === true ) ).toBe( true )
  })

  it('but a silent author with NO declaration still times out', async () => {
    // The ambiguity that matters: empty words are also what a dead facet, a full
    // budget, and a deferring second pass return. Only a declaration is an answer.
    const s = freshState()
    const exec = executor({ bubbles: [] })
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, AWAIT_TIMEOUT + 3 )
    expect( outcomes.some( o => o['withheld'] === true ),
      'an undeclared empty must not be read as a decision').toBe( false )
    expect( outcomes.some( o => o['success'] === false ),
      'a dead author must still be abandoned by the clock').toBe( true )
  })

  it('a bare array return keeps the old contract — no words, no reason given', async () => {
    const s = freshState()
    const exec = executor( [] )                        // legacy shape
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, AWAIT_TIMEOUT + 3 )
    expect( outcomes.some( o => o['withheld'] === true ) ).toBe( false )
    expect( outcomes.some( o => o['success'] === false ) ).toBe( true )
  })

  it('words still win — a facet that speaks is not withholding', async () => {
    const s = freshState()
    const exec = executor({ bubbles: [ 'Ada — any movement on the RFC?' ] })
    reachOut( s, 'intent-1')

    const outcomes = await run( s, exec, 5 )
    expect( outcomes.some( o => o['withheld'] === true ) ).toBe( false )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/integration/executive.outcomes-reach-the-prompt.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The guard the green suite did not have.
 *
 * The outcomes section had a builder, a type, and a place in
 * `FULL_AWARENESS`. Everything was tested except whether anything ever put data
 * in it — and nothing did: `context.ts` scanned `decision.record` for an
 * `actionStatus` that no engine writes. Zero rows in every prompt a live mind
 * ever received.
 *
 * A unit test of `_buildRecentOutcomesSection` passes happily on hand-built
 * input and says nothing about that. So this asserts on the rendered prompt,
 * built from STATE, which is the only place the question can be answered.
 *
 * The same shape as `agency.field-crossing`: the units were tested, the seam was
 * not, and the mechanism was dark for months.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState } from '#core/types'
import { buildExecutiveContext } from '#faculties/executive.engine/context'
import { actionRecordEntity } from '#faculties/executive.engine/action.record'

/** The minimum dependency surface `buildExecutiveContext` reaches into. */
const DEPS = {
  workingMemory:      { getItems: () => [] },
  goalManager:        { getActiveGoals: () => [] },
  semanticIntegrator: { getBeliefs: () => [] },
} as never

/** `buildUserMessage` renders a focus block; master mode supplies an empty one. */
const FOCUS = { title: '', content: '' } as never

function stateWith( records: Array<Parameters<typeof actionRecordEntity>[0]> ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  for( const r of records ){
    const e = actionRecordEntity( r )
    entities.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  }
  return {
    tick: 120, time: 0, entities,
    metrics: new Map([ [ 'energy.level', 70 ] ]),
  } as unknown as ReadonlySimulationState
}

describe('what the mind is told about its own doing', () => {
  it('reaches the context from state at all', async () => {
    const ctx = await buildExecutiveContext( stateWith([
      { type: 'reach-out', status: 'completed', tick: 100, targetEntityId: 'ke:fkem', outcome: 'delivered' },
    ]), DEPS )

    expect( ctx.recentActions, 'the section has never once had a row in it')
      .toHaveLength( 1 )
    expect( ctx.recentActions[0]!.type ).toBe('reach-out')
    expect( ctx.recentActions[0]!.status ).toBe('completed')
  })

  it('carries a withheld act through as withheld, not as a failure', async () => {
    const ctx = await buildExecutiveContext( stateWith([
      { type: 'reach-out', status: 'withheld', tick: 100, targetEntityId: 'ke:fkem',
        outcome: 'I had already spoken to them since composing this.' },
    ]), DEPS )

    expect( ctx.recentActions[0]!.status ).toBe('withheld')
    expect( ctx.recentActions[0]!.outcome ).toMatch( /already spoken/ )
  })

  it('renders into the prompt, with the fact that makes it load-bearing', async () => {
    const { PromptFactory } = await import('#faculties/executive.engine/prompt.factory')
    const state = stateWith([
      { type: 'reach-out', status: 'completed', tick: 118, targetEntityId: 'ke:fkem', outcome: 'delivered' },
      { type: 'express',   status: 'failed',    tick: 110, outcome: 'no words were produced' },
    ])
    const context = await buildExecutiveContext( state, DEPS )

    const prompt = PromptFactory.buildUserMessage({ state, context, deps: DEPS, focus: FOCUS } as never )

    expect( prompt, 'the section was absent from every prompt a live mind received')
      .toContain('## What Became Of What I Did')
    expect( prompt ).toContain('reach-out')
    expect( prompt ).toContain('express')
    // The line that answers the confabulation directly. Without it the mind reads
    // a list of things it did and has no reason to connect it to the thing it is
    // being asked about.
    expect( prompt, 'a history the mind cannot tell apart from its intentions is not a history')
      .toMatch( /If something I intended is not on this list, it did not happen/ )
  })

  it('a history and a list of intentions do not wear the same name — P3', async () => {
    // The collision this rename closes, asserted where the mind actually meets
    // it: two adjacent prompt sections, one of them a record of what HAPPENED
    // and the other a list of action types the mind CHOSE. They were
    // `## Recent Action Outcomes` and `## Recent Actions` — near-identical
    // labels on opposite claims, next to each other on the page.
    //
    // Live consequence, and the reason this is asserted rather than trusted:
    // asked "have you completed that?", a COO answered "Yes — it's done. I
    // drafted the full v0.1 spec… Posted it to FKEM." She had posted nothing and
    // had no effectors at all. Her deliberation history said "I produce the
    // scoping doc now" across twenty cycles, and nothing distinguished that from
    // having done it.
    const { PromptFactory } = await import('#faculties/executive.engine/prompt.factory')
    const state   = stateWith([
      { type: 'reach-out', status: 'completed', tick: 118, targetEntityId: 'ke:fkem', outcome: 'delivered' },
    ])
    const context = await buildExecutiveContext( state, DEPS )

    // `recentActionTypes` is the executive's OWN running list of what it chose —
    // it rides in on the build options, not the context, which is itself part of
    // why the two sections were easy to confuse: they arrive from different
    // places and only meet on the page.
    const prompt = PromptFactory.buildUserMessage({
      state, context, deps: DEPS, focus: FOCUS,
      recentActionTypes: [ 'reflect', 'reflect', 'reach-out' ],
    } as never )

    expect( prompt ).toContain('## What Became Of What I Did')      // what happened
    expect( prompt ).toContain('## What I Have Been Choosing')      // what was chosen
    // Neither of the old names survives anywhere on the page. `Recent Actions`
    // is a substring of nothing now — if either title comes back, this fails.
    expect( prompt ).not.toContain('## Recent Action')
  })

  it('says nothing at all when the mind has done nothing', async () => {
    // A newborn must not be handed an empty ceremonial heading.
    const { PromptFactory } = await import('#faculties/executive.engine/prompt.factory')
    const state   = stateWith([])
    const context = await buildExecutiveContext( state, DEPS )

    expect( PromptFactory.buildUserMessage({ state, context, deps: DEPS, focus: FOCUS } as never ) )
      .not.toContain('## What Became Of What I Did')
  })
})

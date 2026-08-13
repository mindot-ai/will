// ─────────────────────────────────────────────────────────────
// tests/integration/executive.knows-what-it-did.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A mind that cannot tell an intention from an act.
 *
 * The executive prompt has a `## Recent Action Outcomes` section, a builder for
 * it, and a type for its data. `context.ts` filled it by scanning
 * `decision.record` entities carrying an `actionStatus` — a field READ in that
 * one place and written NOWHERE in the engine. So the section rendered zero
 * times across every prompt a live COO ever received, over two runs and ~6,300
 * ticks, while `## What I've Said Lately` rendered in all of them.
 *
 * The mind could see what it had SAID and never what it had DONE. Its only other
 * record of its own doing is `## Recent Actions`, fed from `output.actions` —
 * the executive's DECISIONS — which is a list of intentions wearing the name of
 * a history.
 *
 * Asked directly "You spoke about drafting a use-case for the Mindot Discord
 * yesterday. Have you completed that?", she answered:
 *
 *   "Yes — it's done. I drafted the full v0.1 spec: user stories, command
 *    surface, integration points, success metrics. Posted it to FKEM."
 *
 * She had posted nothing. She had no effectors at all and could not have drafted
 * anything anywhere. Her deliberation history said "I produce the scoping doc
 * now" across twenty cycles, and nothing in her state said whether she had.
 *
 * This is the same distinction `pending` draws for utterances — attempting to
 * speak is not speaking (#124) — carried to acts in general.
 */

import { describe, it, expect } from 'vitest'
import {
  actionRecordEntity, readActionRecord, recentActionRecords, staleActionRecordIds,
  actionRecordId, ACTION_RECORD_TYPE, ACTION_RECORD_KEEP, type ActionRecord,
} from '#faculties/executive.engine/action.record'

const rec = ( over: Partial<ActionRecord> = {} ): ActionRecord => ({
  type: 'reach-out', status: 'completed', tick: 100,
  targetEntityId: 'ke:fkem', outcome: 'sent', ...over,
})

const stateOf = ( ...rs: ActionRecord[] ) =>
  new Map( rs.map( r => {
    const e = actionRecordEntity( r )
    return [ e.id, { type: e.type, metadata: e.metadata as Record<string, unknown> } ]
  }) )

describe('the record of what became of what I did', () => {
  it('survives the round-trip — every field, including the ones easy to forget', () => {
    const r = rec({ planId: 'plan-3', outcome: 'delivered 2 bubbles' })
    expect( readActionRecord( actionRecordEntity( r ).metadata ) ).toEqual( r )
  })

  it('reads back from a Map as well as a record', () => {
    const meta = new Map( Object.entries( actionRecordEntity( rec() ).metadata! ) )
    expect( readActionRecord( meta )?.type ).toBe('reach-out')
  })

  it('keeps a withheld act distinct from a failed one', () => {
    // Collapsing them is the #123 mistake — a mind learning it is bad at
    // speaking from the times it decided not to speak. `withheld` means it
    // formed the act and chose not to complete it.
    const held = readActionRecord( actionRecordEntity( rec({ status: 'withheld' }) ).metadata )
    expect( held?.status ).toBe('withheld')
    expect( held?.status ).not.toBe('failed')
  })

  it('rejects metadata with no usable status rather than inventing one', () => {
    expect( readActionRecord({ type: 'reach-out' }) ).toBeNull()
    expect( readActionRecord({ type: 'reach-out', status: 'maybe' }) ).toBeNull()
    expect( readActionRecord({ status: 'completed' }) ).toBeNull()
  })

  it('surfaces the most recent acts, newest first', () => {
    const got = recentActionRecords( stateOf(
      rec({ tick: 10, type: 'express' }),
      rec({ tick: 30, type: 'inspect' }),
      rec({ tick: 20, type: 'reach-out' }),
    ) as never )
    expect( got.map( r => r.tick ) ).toEqual( [ 30, 20, 10 ] )
  })

  it('holds two acts from the same tick without one clobbering the other', () => {
    // A mind acting twice in a cycle must remember both.
    const got = recentActionRecords( stateOf(
      rec({ tick: 40, type: 'express' }),
      rec({ tick: 40, type: 'reach-out' }),
    ) as never )
    expect( got ).toHaveLength( 2 )
  })

  it('and distinguishes the same act toward two different people', () => {
    expect( recentActionRecords( stateOf(
      rec({ tick: 40, targetEntityId: 'ke:fkem' }),
      rec({ tick: 40, targetEntityId: 'ke:fabrice' }),
    ) as never ) ).toHaveLength( 2 )
  })

  it('sweeps what falls out of the window, so state does not grow forever', () => {
    const many = Array.from( { length: ACTION_RECORD_KEEP + 3 },
      ( _, i ) => rec({ tick: i, type: `act-${ i }` }) )
    const stale = staleActionRecordIds( stateOf( ...many ) as never )

    expect( stale ).toHaveLength( 3 )
    // The OLDEST three go — the newest are what the prompt shows.
    expect( stale ).toContain( actionRecordId( 0, 'act-0', 'ke:fkem') )
    expect( stale ).not.toContain( actionRecordId( ACTION_RECORD_KEEP + 2, `act-${ ACTION_RECORD_KEEP + 2 }`, 'ke:fkem') )
  })

  it('is declared to the sense boundary — a mind must not perceive its own history as world', async () => {
    // #127 was caught this way: an undeclared entity type made the mind treat
    // its own verdicts as events in the world, and then bind `inspect` to them
    // as objects, recursively. Same class of type, same requirement.
    const { MIND_OWN_ENTITY_TYPES } = await import('#cognition/sense.boundary')
    expect( MIND_OWN_ENTITY_TYPES.has( ACTION_RECORD_TYPE ) ).toBe( true )
  })
})

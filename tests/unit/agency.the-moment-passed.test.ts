// ─────────────────────────────────────────────────────────────
// tests/unit/agency.the-moment-passed.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Is this still what I want to say?
 *
 * Satiation gates SELECTION — whether to commit to speaking. It cannot touch
 * words already selected and out for authoring. Authoring is off-tick and takes
 * 10–30s of real time, and in that window the situation the words were composed
 * for can move. Nothing looked at the door.
 *
 * Live, twice:
 *
 *   Fabrice: "I need my full attention on that right now. Will brief you later."
 *   Lora:    "Understood. I'm here when you're ready."          ← correct
 *   [41s]    "…here's where I am on the operational picture…"   ← composed before
 *            "To turn it into something useful I need a brain-dump from you"
 *            "Dump it rough. I'll structure it."
 *
 *   FKEM:    "I'm planning to go get some sleep now. You should too"
 *   Lora:    "Night. Talk soon."                                ← correct
 *   [1s]     "FKEM — late here too. 3 AM and I'm in that quiet window…"
 *
 * In both, the mind answered the new situation correctly and then delivered an
 * older composition on top of its own answer. An act decided in one situation
 * and performed in another is not the act that was decided on.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState } from '#core/types'
import { situationMoved } from '#agency/engines/motor.schema.executor'

function state( sent: Array<{ target: string; tick: number; answeredAt?: number }> ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  sent.forEach( ( s, i ) => entities.set( `conversation-sent-${ i }`, {
    id: `conversation-sent-${ i }`, type: 'conversation.sent',
    createdAt: 0, updatedAt: 0,
    metadata: {
      targetEntityId: s.target, tick: s.tick,
      ...( s.answeredAt !== undefined ? { answeredAt: s.answeredAt } : {} ),
    },
  }) )
  return { tick: 100, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
}

describe('words composed for a moment that has passed', () => {
  it('are withheld when the mind has spoken to them since composing', () => {
    // The exact live sequence: words requested at 50, a reply delivered at 60,
    // the composition landing after.
    const moved = situationMoved( state([ { target: 'ke:fabrice', tick: 60 } ]), 'ke:fabrice', 50 )
    expect( moved, 'the stale composition went out on top of the mind\'s own answer').not.toBeNull()
    expect( moved ).toMatch( /already spoken to them since composing/ )
  })

  it('go out when nothing has happened since', () => {
    expect( situationMoved( state([]), 'ke:fabrice', 50 ) ).toBeNull()
  })

  it('go out when the only thing said to them predates the composition', () => {
    // Speaking BEFORE composing is the ordinary case — it is what prompted the
    // outreach. Only a turn after the words were formed makes them stale.
    expect( situationMoved( state([ { target: 'ke:fabrice', tick: 40 } ]), 'ke:fabrice', 50 ) ).toBeNull()
  })

  it('are not held hostage by a conversation with someone else', () => {
    expect( situationMoved( state([ { target: 'ke:fkem', tick: 90 } ]), 'ke:fabrice', 50 ) ).toBeNull()
  })

  it('go out when nothing is known about when they were formed', () => {
    // No `composedAt` ⇒ they never came through `_requestAuthoring`. Withholding
    // on absent evidence would mute a mind for a reason it could not name, so
    // the default is to speak.
    expect( situationMoved( state([ { target: 'ke:fabrice', tick: 90 } ]), 'ke:fabrice', undefined ) ).toBeNull()
  })

  it('go out when there is nobody in particular to be stale toward', () => {
    expect( situationMoved( state([ { target: 'ke:fabrice', tick: 90 } ]), undefined, 50 ) ).toBeNull()
  })

  it('are withheld when THEY spoke since composing — even if the mind has not', () => {
    // The gap the first cut missed, and it was the common case rather than an
    // edge. Live: a COO delivered a pre-composed agenda message two seconds after
    // the person changed the subject, having said nothing in between —
    //
    //   21:40:27  Fabrice: "I need some meeting with FKEM first"
    //   21:40:29  Lora:    "Fabrice — I need a list of what's actively in flight…"
    //   21:40:38  Lora:    "Sure. I'll be around."
    //
    // so the stale words arrived BEFORE her real reply and the spoken-since arm
    // had not fired yet. Whoever moved the situation, it moved.
    const moved = situationMoved(
      state([ { target: 'ke:fabrice', tick: 20, answeredAt: 60 } ]), 'ke:fabrice', 50 )

    expect( moved, 'they changed the subject and the pre-composed words went out anyway')
      .not.toBeNull()
    expect( moved ).toMatch( /said something after I composed this/ )
  })

  it('go out when their last word predates the composition', () => {
    // Them having spoken BEFORE is the ordinary case — usually it is what
    // prompted the outreach.
    expect( situationMoved(
      state([ { target: 'ke:fabrice', tick: 20, answeredAt: 40 } ]), 'ke:fabrice', 50 ) ).toBeNull()
  })

  it('is not confused by someone else answering', () => {
    expect( situationMoved(
      state([ { target: 'ke:fkem', tick: 20, answeredAt: 90 } ]), 'ke:fabrice', 50 ) ).toBeNull()
  })

  it('reports THEIR turn when both arms are live — it is the more recent truth', () => {
    // Both fired: she spoke at 55, they spoke at 60. The account the mind records
    // should be the one that actually left the words stranded.
    expect( situationMoved(
      state([ { target: 'ke:fabrice', tick: 55, answeredAt: 60 } ]), 'ke:fabrice', 50 ) )
      .toMatch( /said something after I composed this/ )
  })

  it('names what changed, in the mind\'s own voice', () => {
    // The withheld outcome records this verbatim, so the mind's history says why
    // it did not speak rather than merely that it didn't.
    const moved = situationMoved( state([ { target: 'ke:fabrice', tick: 60 } ]), 'ke:fabrice', 50 )!
    expect( moved ).toMatch( /^I / )
    expect( moved.endsWith('.') ).toBe( true )
  })
})

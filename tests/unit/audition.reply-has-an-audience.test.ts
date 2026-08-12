// ─────────────────────────────────────────────────────────────
// tests/unit/audition.reply-has-an-audience.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * `[REPLY_TEXT]` is delivered TO the person the facet is bound to.
 *
 * The routing was always right — `partitionOutwardIntents` lifts any communicate
 * action naming someone other than the bound speaker into `outwardIntents`, which
 * the master owns. What was missing was the mind ever being TOLD.
 *
 * The instructions described the reply block as "the only part the speaker sees",
 * which is about visibility, not routing, and said nothing at all about how to
 * reach a third party. So the mechanism existed and the mind had no
 * representation with which to use it.
 *
 * Live, mid-conversation with Fabrice, she composed a message for FKEM —
 * "Fabrice said he's free tomorrow morning around 10. Wanted to pass that along
 * so you've got it" — and wrote it into the reply block. It went to Fabrice, who
 * had to point out he was reading a message addressed to someone else. Her
 * identity model was never confused: Fabrice and FKEM had separate anchors,
 * separate dossiers, separate aliases. She simply had no way to know the reply
 * block has an audience.
 *
 * (She then corrected herself when told, and delivered it to FKEM's channel.)
 */

import { describe, it, expect } from 'vitest'
import { partitionOutwardIntents } from '#senses/audition.engine/engine'
import { CONVERSATION_OUTPUT_FORMAT } from '#senses/audition.engine/engine'

describe('a message for someone who is not in this conversation', () => {
  it('is lifted out of the facet when the action names them', () => {
    const out = partitionOutwardIntents(
      [ { type: 'reach-out', target: 'FKEM', reasoning: 'passing on the time',
          args: { content: 'Fabrice is free at 10.' } } ] as never,
      'ke:1sqlkux', 'Fabrice',
    )
    expect( out ).toHaveLength( 1 )
    expect( out[0]!.target ).toBe('FKEM')
    expect( out[0]!.gist ).toBe('Fabrice is free at 10.')
  })

  it('stays with the facet when it names the person it is already talking to', () => {
    // Answering the speaker is what [REPLY_TEXT] is for — this must not become a
    // second, parallel channel to the same person.
    expect( partitionOutwardIntents(
      [ { type: 'reach-out', target: 'Fabrice', args: { content: 'ok' } } ] as never,
      'ke:1sqlkux', 'Fabrice' ) ).toEqual( [] )

    expect( partitionOutwardIntents(
      [ { type: 'reach-out', target: 'ke:1sqlkux', args: { content: 'ok' } } ] as never,
      'ke:1sqlkux', 'Fabrice' ) ).toEqual( [] )
  })

  it('and when no addressee is named at all — silence means the person in front of it', () => {
    expect( partitionOutwardIntents(
      [ { type: 'reach-out', args: { content: 'ok' } } ] as never,
      'ke:1sqlkux', 'Fabrice' ) ).toEqual( [] )
  })

  it('the facet is TOLD the reply has an audience, and how to reach anyone else', () => {
    // The mechanism above is worth nothing if the mind cannot see it. This is the
    // representation, and it is load-bearing: without it she wrote a third party's
    // message into the reply block and it went to the wrong person.
    const t = CONVERSATION_OUTPUT_FORMAT

    expect( t, 'the reply block must be described as having an ADDRESSEE, not just a reader')
      .toMatch( /delivered TO THE PERSON I AM TALKING TO/ )
    expect( t, 'it must name the failure — words about someone are not words to them')
      .toMatch( /never hears it|addressed to someone else/ )
    expect( t, 'and it must give the actual way out')
      .toMatch( /"type": "reach-out"/ )
    expect( t, 'whose target key matches what partitionOutwardIntents reads')
      .toMatch( /"target":/ )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/wire.no-markers-in-the-message.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The wire is not the words.
 *
 * `extractTextBlock` slices from the first `[REPLY_TEXT]` to the first
 * `[/REPLY_TEXT]` after it. Anything between is content BY CONSTRUCTION — so a
 * stray second opener inside the body is carried out as content, and the bubble
 * splitter, seeing it alone on a line, delivers it as a message.
 *
 * Live, a COO's reply to a technical document went out as four substantive
 * bubbles and a fifth:
 *
 *   [outbox-writer] reply → discord:1019… bubble[3] "The simulation sandbox (§5.1)…"
 *   [outbox-writer] reply → discord:1019… bubble[4] "[REPLY_TEXT]"
 *   22:06:41  💬 → discord:1019…: [REPLY_TEXT]
 *
 * The person received a message whose entire content was the name of the slot it
 * should have filled.
 */

import { describe, it, expect } from 'vitest'
import {
  stripProtocolMarkers, wrapReplyText, PROTOCOL_TAGS,
  REPLY_TEXT_OPEN, REPLY_TEXT_CLOSE,
} from '#llm/wire.contracts'
import { extractTextBlock } from '#faculties/executive.engine/parser'
import { REPLY_TEXT_TAG } from '#llm/wire.contracts'

/** What the parser does with a facet response: pull the reply block out of it. */
const reply = ( body: string ): string | null =>
  extractTextBlock( wrapReplyText( body ), REPLY_TEXT_TAG )

describe('protocol markers never reach the room', () => {
  it('strips a stray opener left inside the body — the live failure', () => {
    const out = reply( [ 'The architecture diagram answers it.', '',
      'The §9 sequence is the signal.', '', REPLY_TEXT_OPEN ].join('\n') )

    expect( out ).not.toContain('[REPLY_TEXT]')
    expect( out, 'the words themselves must survive intact')
      .toContain('The architecture diagram answers it.')
    expect( out ).toContain('The §9 sequence is the signal.')
  })

  it('leaves no empty trailing bubble where the marker was', () => {
    // Removing the token is only half the job: a blank line alone still splits
    // into a bubble, so the person gets an empty message instead of a literal one.
    const out = reply(`Real words.\n\n${ REPLY_TEXT_OPEN }`)!
    expect( out.split('\n\n').filter( b => b.trim() === '') ).toEqual( [] )
    expect( out.endsWith('Real words.') ).toBe( true )
  })

  it('strips a stray CLOSER too — the same slip in the other direction', () => {
    expect( reply(`Words.\n${ REPLY_TEXT_CLOSE }\nMore words.`) ).not.toContain('[/REPLY_TEXT]')
  })

  it('strips every protocol tag, not just the reply block', () => {
    // A mind that emits a tagged block inside its reply leaks the tag the same way.
    for( const tag of PROTOCOL_TAGS ){
      expect( stripProtocolMarkers( `before [${ tag }] after` ) ).toBe('before  after')
      expect( stripProtocolMarkers( `before [/${ tag }] after` ) ).toBe('before  after')
    }
  })

  it('does NOT eat bracketed text a mind may legitimately write', () => {
    // The reason this names its tags instead of matching `[ANYTHING]`. She cites
    // spec sections constantly — "[see §4.4]" is a thing she actually says.
    const kept = 'One thing I notice: the Deadline Watcher [see §4.4] catches [1] the absence [REDACTED].'
    expect( stripProtocolMarkers( kept ) ).toBe( kept )
  })

  it('an ordinary reply is returned byte-identical', () => {
    const body = 'Clear — VLX-Ledger ships without Ripplix. That unblocks the independent path.'
    expect( reply( body ) ).toBe( body )
  })

  it('a body that was ONLY a marker yields no reply at all, rather than an empty one', () => {
    // What should have happened live: nothing to say is silence, not a blank
    // message and not the token.
    expect( reply( REPLY_TEXT_OPEN ) ).toBeNull()
  })
})

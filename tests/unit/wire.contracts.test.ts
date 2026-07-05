// ─────────────────────────────────────────────────────────────
// tests/unit/wire.contracts.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The wire-contract roundtrips. A format one component RENDERS and another
 * MATCHES must survive render→match through the SAME module — this is the
 * guard against the drift class that silently broke test-mode conversations
 * (renderer evolved, detector kept matching the old format).
 *
 * If a renderer here legitimately changes, this file forces the change to be
 * conscious: the matcher, the mock, and the replay byte-contract all move
 * together or the suite goes red.
 */

import { describe, it, expect } from 'vitest'
import {
  REPLY_TEXT_TAG, REPLY_TEXT_OPEN, REPLY_TEXT_CLOSE, wrapReplyText,
  renderSpeakerLine, renderCurrentMessageLine, matchConversationFocus,
} from '#llm/wire.contracts'

describe( 'wire contracts — render ↔ match roundtrips', () => {
  it( 'conversation focus: rendered lines are detected, content extracted intact', () => {
    const focus = [
      renderSpeakerLine( 'Dr. Chen', 'dr-chen' ),
      'some digest text\n',
      renderCurrentMessageLine( 'What is it like to be you, right now?' ),
    ].join( '\n' )

    const turn = matchConversationFocus( `preamble…\n${focus}\n…rest of prompt` )

    expect( turn ).not.toBeNull()
    expect( turn!.content ).toBe( 'What is it like to be you, right now?' )
  } )

  it( 'conversation focus: multi-line message content survives extraction', () => {
    const message = 'line one\nline two'
    const focus = [
      renderSpeakerLine( 'Ada', 'ada' ),
      renderCurrentMessageLine( message ),
    ].join( '\n' )

    expect( matchConversationFocus( focus )!.content ).toBe( message )
  } )

  it( 'a prompt without the conversation focus does not match (background reasoning)', () => {
    expect( matchConversationFocus( '## Relevant Memories\n- visitor: "hi" → ""' ) ).toBeNull()
    expect( matchConversationFocus( renderCurrentMessageLine( 'orphan line only' ) ) ).toBeNull()
  } )

  it( 'REPLY_TEXT: wrap produces the exact historical markers', () => {
    // Byte-frozen: prompt/output bytes are replay-load-bearing. If this needs
    // to change, the replay capstone + every marker consumer move together.
    expect( REPLY_TEXT_OPEN ).toBe( '[REPLY_TEXT]' )
    expect( REPLY_TEXT_CLOSE ).toBe( '[/REPLY_TEXT]' )
    expect( REPLY_TEXT_TAG ).toBe( 'REPLY_TEXT' )
    expect( wrapReplyText( 'Hello there.' ) ).toBe( '[REPLY_TEXT]\nHello there.\n[/REPLY_TEXT]' )
  } )

  it( 'speaker/message renderers produce the exact historical bytes', () => {
    // Frozen bytes — the audition focus format the mock detects and the replay
    // record pairs on. Conscious changes only.
    expect( renderSpeakerLine( 'Ada', 'ada' ) ).toBe( 'Speaker: Ada (id: ada)' )
    expect( renderCurrentMessageLine( 'hi' ) ).toBe( 'Current message: "hi"' )
  } )
} )

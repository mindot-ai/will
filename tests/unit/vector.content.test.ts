// ─────────────────────────────────────────────────────────────
// tests/unit/vector.content.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * episodeContentToText (#3) — projects raw WM-metadata episode content into a
 * clean text string for embedding, so the vector carries semantic signal rather
 * than JSON structural noise (wmType, numeric activation, tags, …).
 */

import { describe, it, expect } from 'vitest'
import { episodeContentToText } from '#memory/vector.content'

describe('episodeContentToText (#3)', () => {
  it('passes plain strings through unchanged (query path)', () => {
    expect( episodeContentToText('how was your day?') ).toBe('how was your day?')
  } )

  it('prefers the actual dialogue for conversation exchanges', () => {
    const content = {
      wmType: 'conversation.exchange', activation: 0.85, attendedCount: 3,
      tags: [ 'conversation', 'exchange' ],
      summary: 'Alex: "..." → "..."',
      userMessage: 'what do you remember about the lake?',
      willReply: 'the still water and the cold morning air',
    }
    expect( episodeContentToText( content ) )
      .toBe('what do you remember about the lake? → the still water and the cold morning air')
  } )

  it('uses willReply alone for proactive outreach (no inbound message)', () => {
    expect( episodeContentToText( { userMessage: '', willReply: 'I was thinking of you' } ) )
      .toBe('I was thinking of you')
  } )

  it('falls back to the top-level summary when there is no dialogue', () => {
    expect( episodeContentToText( { wmType: 'thought', activation: 0.4, summary: 'a quiet realization about time' } ) )
      .toBe('a quiet realization about time')
  } )

  it('reads a nested descriptor summary (e.g. plan items)', () => {
    const content = { wmType: 'plan', content: { summary: 'reach the summit by dawn', planId: 'plan-7' } }
    expect( episodeContentToText( content ) ).toBe('reach the summit by dawn')
  } )

  it('never throws on unknown shapes — stable JSON fallback', () => {
    expect( episodeContentToText( { foo: 1, bar: [ 2, 3 ] } ) ).toBe('{"foo":1,"bar":[2,3]}')
    expect( episodeContentToText( null ) ).toBe('null')
    expect( episodeContentToText( undefined ) ).toBe('')
  } )

  it('strips noise — output excludes structural metadata keys', () => {
    const text = episodeContentToText( {
      wmType: 'conversation.exchange', activation: 0.91, attendedCount: 7,
      userMessage: 'hi', willReply: 'hello',
    } )
    expect( text ).not.toContain('wmType')
    expect( text ).not.toContain('activation')
    expect( text ).not.toContain('0.91')
  } )
} )

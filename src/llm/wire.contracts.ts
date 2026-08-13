// ─────────────────────────────────────────────────────────────
// src/llm/wire.contracts.ts — shared prompt/output wire formats
// ─────────────────────────────────────────────────────────────
//
// The single source of truth for string formats that cross component
// boundaries between the prompt side (renderers) and the response side
// (parsers/detectors). Before this module, each side hardcoded its own copy
// and they rotted independently — the canonical failure: the AuditionEngine's
// conversation-focus format evolved while the mock LLM kept detecting the OLD
// pending-message format, silently breaking every test-mode conversation
// (including the production Playground) until the examples work exposed it.
//
// The rule: a format that one component RENDERS and another component MATCHES
// must live here as a render/match PAIR, tested as a roundtrip
// (tests/unit/wire.contracts.test.ts). A drift then fails loudly at the
// contract, not silently at the consumer.
//
// Byte discipline: renderers must reproduce the historical bytes EXACTLY —
// prompt bytes are replay-load-bearing (the equivalence capstone re-feeds
// completions keyed by byte-identical prompts).
//
// Lives in the llm layer so both sides can import it without cycles:
// cognition already depends on llm (facets use LLMDirector); llm/index uses
// these locally for the mock.
// ─────────────────────────────────────────────────────────────

// ── [REPLY_TEXT] — the conversation reply block ───────────────
// Emitted by conversation facets (CONVERSATION_OUTPUT_FORMAT), streamed live to
// clients by the audition chunk pipe, extracted by the parser, produced by the
// mock. The ONLY part of a facet response the speaker ever sees.

/** Bare tag name — parser's extractTextBlock() builds the markers from it. */
export const REPLY_TEXT_TAG = 'REPLY_TEXT'
export const REPLY_TEXT_OPEN  = `[${REPLY_TEXT_TAG}]`
export const REPLY_TEXT_CLOSE = `[/${REPLY_TEXT_TAG}]`

/**
 * The block a facet uses to say it has decided NOT to speak, and why.
 *
 * "Omit [REPLY_TEXT] to stay silent" was stated in the prompt and nowhere else —
 * a rule with no mechanism behind it. Live, an outreach facet read that it had
 * three unanswered messages outstanding, correctly concluded there was nothing new
 * to say, and — having no other block to put that sentence in — wrote it into
 * REPLY_TEXT. "— nothing new to say to FKEM. Three messages unanswered is enough."
 * was delivered to FKEM, in the third person, about him.
 *
 * The prompt already warned against exactly that. Warning was not enough, because
 * the pressure is structural: a mind that decides not to speak still has something
 * to say about the decision, and REPLY_TEXT was the only place to say it. This is
 * the place. Content here is recorded and never sent.
 */
export const NO_MESSAGE_TAG   = 'NO_MESSAGE'
export const NO_MESSAGE_OPEN  = `[${NO_MESSAGE_TAG}]`
export const NO_MESSAGE_CLOSE = `[/${NO_MESSAGE_TAG}]`

/** Wrap a reply body in the block markers (the mock's emission shape). */
export function wrapReplyText( body: string ): string {
  return [ REPLY_TEXT_OPEN, body, REPLY_TEXT_CLOSE ].join('\n')
}

/**
 * Every marker that is PROTOCOL rather than content.
 *
 * Named explicitly rather than matched as `[ANYTHING]`, because bracketed text is
 * ordinary in real messages — "[1]", "[see §4.4]", "[REDACTED]" are things a mind
 * may legitimately say, and a greedy strip would eat them.
 */
export const PROTOCOL_TAGS: readonly string[] = [
  REPLY_TEXT_TAG, NO_MESSAGE_TAG, 'INTROSPECTION', 'NARRATIVE', 'SELF_OBS',
]

/**
 * Remove any protocol marker that survived inside extracted content.
 *
 * `extractTextBlock` slices from the first `[TAG]` to the first `[/TAG]` after
 * it, so a STRAY second opener inside the body is carried out as content — and
 * the bubble splitter, seeing a line of its own, delivers it as a message.
 *
 * Live: a COO's reply to a technical document went out as four substantive
 * bubbles followed by a fifth reading exactly `[REPLY_TEXT]`. The person got a
 * message whose entire content was the name of the slot it should have filled.
 *
 * These tokens can never be legitimate content — they are the wire, not the
 * words — so stripping them is not censorship of anything the mind meant. A line
 * left empty by the removal is dropped so it cannot become an empty bubble.
 */
export function stripProtocolMarkers( text: string ): string {
  let out = text
  for( const tag of PROTOCOL_TAGS )
    out = out.split(`[${ tag }]`).join('').split(`[/${ tag }]`).join('')

  return out
    .split('\n')
    .filter( ( line, i, all ) => line.trim() !== '' || ( i > 0 && i < all.length - 1 && all[ i - 1 ]?.trim() !== '') )
    .join('\n')
    .trim()
}

// ── Conversation-facet focus — render ↔ match pair ────────────
// The AuditionEngine RENDERS these lines into the facet focus; the mock LLM
// MATCHES them to detect "this call is a conversation turn" and synthesize a
// reply. One encoding, two consumers — the pair that rotted apart before.

/** `Speaker: <name> (id: <entityId>)` — first line of the conversation focus. */
export function renderSpeakerLine( speakerName: string, speakerEntityId: string ): string {
  return `Speaker: ${speakerName} (id: ${speakerEntityId})`
}

/** `Current message: "<content>"` — the live turn being answered. */
export function renderCurrentMessageLine( content: string ): string {
  return `Current message: "${content}"`
}

/**
 * Detect a conversation-facet turn in a prompt and extract the live message.
 * Returns null when the prompt is not a conversation turn (background reasoning,
 * deliberation facets, master cycles). The mock LLM keys its reply path on this.
 */
export function matchConversationFocus( userMessage: string ): { content: string } | null {
  const speakerMatch = userMessage.match( /Speaker: .+? \(id: .+?\)/ )
  const messageMatch = userMessage.match( /Current message: "([\s\S]+?)"/ )
  if( !speakerMatch || !messageMatch ) return null
  return { content: messageMatch[ 1 ]! }
}

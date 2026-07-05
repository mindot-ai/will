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

/** Wrap a reply body in the block markers (the mock's emission shape). */
export function wrapReplyText( body: string ): string {
  return [ REPLY_TEXT_OPEN, body, REPLY_TEXT_CLOSE ].join( '\n' )
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

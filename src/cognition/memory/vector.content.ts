// ─────────────────────────────────────────────────────────────
// src/cognition/memory/vector.content.ts
// ─────────────────────────────────────────────────────────────

/**
 * Projects an episode's stored content into a clean text string for embedding.
 *
 * Episodes are consolidated from working-memory items, so `content` is usually
 * the raw WM `entity.metadata` object — a mix of the actual semantic text
 * (summary / userMessage / willReply) and structural noise (wmType, numeric
 * activation, attendedCount, tags). Embedding the whole JSON blob dilutes the
 * vector with that noise and weakens recall. This extracts the human-meaningful
 * text, falling back to JSON only for shapes we don't recognise so it never
 * throws and never silently drops data.
 *
 * Applied at every write path (index / indexBatch, hence rebuildFromStore) so
 * indexed vectors are consistent regardless of how they were built. Query
 * strings are already clean text and pass through unchanged.
 */
export function episodeContentToText( content: unknown ): string {
  if( typeof content === 'string' ) return content

  if( content && typeof content === 'object' ){
    const m = content as Record<string, unknown>

    // Conversation exchanges carry the actual dialogue — by far the strongest
    // semantic signal — so prefer it over the pre-baked summary string.
    const user  = typeof m['userMessage'] === 'string' ? m['userMessage'] as string : ''
    const reply = typeof m['willReply']   === 'string' ? m['willReply']   as string : ''
    if( user || reply )
      return [ user, reply ].filter( Boolean ).join( ' → ' )

    // Most WM items carry a top-level human summary.
    if( typeof m['summary'] === 'string' && m['summary'] ) return m['summary'] as string

    // Descriptor items nest their payload (e.g. plan: { content: { summary } }).
    const nested = m['content']
    if( typeof nested === 'string' && nested ) return nested
    if( nested && typeof nested === 'object' ){
      const nm = nested as Record<string, unknown>
      if( typeof nm['summary'] === 'string' && nm['summary'] ) return nm['summary'] as string
    }
  }

  // Unknown shape — stable JSON so we still embed something deterministic.
  try { return JSON.stringify( content ) ?? '' } catch { return String( content ) }
}

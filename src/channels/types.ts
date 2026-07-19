// ─────────────────────────────────────────────────────────────
// src/channels/types.ts — the channel-bridge contract
// ─────────────────────────────────────────────────────────────
//
// A channel bridge puts a Will *in a place where people already are* (Discord,
// Telegram, Slack, …). It is a host surface, not a cognition surface: it turns
// platform messages into `perceive` stimuli and delivers the Will's projected
// utterances back — nothing more. The paradigm survives the crossing:
//
//   • every platform user is an entity the Will comes to know (`from`),
//     with a *learned* name (`speaker`) — never a placeholder;
//   • every platform channel/DM is a conversation thread (`thread`);
//   • the Will decides when to speak. Silence is a valid outcome, so a
//     bridge never fabricates a reply and never times a message out into
//     an error.
//
// Bridges live at the same altitude as the MCP/HTTP hosts (src/mcp, src/serve):
// they wrap the SDK facade, not the stem.
// ─────────────────────────────────────────────────────────────

/** A running connection between one Will and one platform. */
export interface ChannelBridge {
  /** Platform kind, e.g. 'discord'. */
  readonly kind: string
  /** Connect and start relaying. Resolves once the bridge is live. */
  start(): Promise<void>
  /** Disconnect and release resources. Idempotent. */
  close(): Promise<void>
}

/** Split a message into platform-sized chunks on natural boundaries. */
export function chunkText( text: string, max: number ): string[] {
  if( text.length <= max ) return [ text ]
  const chunks: string[] = []
  let rest = text
  while( rest.length > max ){
    // Prefer a paragraph break, then a line break, then a space — else hard-cut.
    const window = rest.slice( 0, max )
    const cut = Math.max( window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ') )
    const at = cut > max * 0.5 ? cut : max
    chunks.push( rest.slice( 0, at ).trimEnd() )
    rest = rest.slice( at ).trimStart()
  }
  if( rest ) chunks.push( rest )
  return chunks
}

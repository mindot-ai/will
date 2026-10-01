// ─────────────────────────────────────────────────────────────
// src/surface/channels/types.ts — the channel-bridge contract
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

import type { SharedFile } from '#senses/index'

/** A running connection between one Will and one platform. */
export interface ChannelBridge {
  /** Platform kind, e.g. 'discord'. */
  readonly kind: string
  /** Connect and start relaying. Resolves once the bridge is live. */
  start(): Promise<void>
  /** Disconnect and release resources. Idempotent. */
  close(): Promise<void>
}

// ── Attachments ──────────────────────────────────────────────────────────────
//
// People hand over documents as well as speech, and some platforms *manufacture*
// them: Discord silently turns a long pasted markdown block into a `.md` upload.
// A bridge that reads only the text body sees such a message as empty and — worse
// — as nothing at all, so the person appears to have gone silent.
//
// A bridge reads each file WHOLE, or names it and says why not, and hands it over
// as a `SharedFile` beside the words (LOSSLESS P5d). The mind lays each read file
// down as its own percept and the words carry a reference to it — a 2 MB document
// is paged in a call, not cut, and does not ride everywhere the words go. It was
// inlined into the text at up to 24,000 characters, four files a message, 256 KB
// fetched.

/** One file riding along with a platform message. */
export interface ChannelAttachment {
  name:         string
  contentType?: string
  size?:        number
  url?:         string
}

/**
 * Above this a file is named, not read, and the mind is told why (LOSSLESS_P5 D4).
 * Not a cut: the file is not read at all, rather than read in part.
 */
export const ATTACHMENT_READ_CEILING = 20 * 1024 * 1024

const TEXTUAL_EXT = /\.(md|markdown|txt|text|json|jsonl|csv|tsv|ya?ml|log|ini|toml)$/i

/** Is this something we can meaningfully read as text? */
export function isTextual( a: ChannelAttachment ): boolean {
  const ct = a.contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  if( ct.startsWith('text/') ) return true
  if( ct === 'application/json' || ct === 'application/x-yaml' ) return true
  // Discord's own markdown uploads arrive as text/plain, but trust the extension
  // too — content types from platforms are advisory at best.
  return TEXTUAL_EXT.test( a.name )
}

/** What reading one file came to: its whole text, or why it was not read. */
export type AttachmentRead = { text: string } | { unread: string }

/**
 * The files of one message, as the mind is handed them.
 *
 * `read` is supplied by the bridge, not by this module — which hosts are safe to
 * fetch from is platform knowledge, and a helper that fetched arbitrary URLs found
 * in inbound messages would be an open redirect into the Will's perception. Omit
 * it and every file is named, never read.
 */
export async function readAttachments(
  attachments: ChannelAttachment[],
  read?:       ( a: ChannelAttachment ) => Promise<AttachmentRead>,
): Promise<SharedFile[]> {
  const out: SharedFile[] = []
  for( const a of attachments ){
    const base: SharedFile = { name: a.name, ...( a.contentType ? { contentType: a.contentType } : {} ), ...( a.size != null ? { size: a.size } : {} ) }
    if( !read ){ out.push( { ...base, unread: 'reading shared files is turned off here' } ); continue }
    const got = await read( a ).catch( ( e: unknown ) => ( { unread: `I could not fetch it (${ e instanceof Error ? e.message : String( e ) })` } ) )
    out.push( { ...base, ...got } )
  }
  return out
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

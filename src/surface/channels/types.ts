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
// What a bridge does with these is deliberately modest. A named-but-unread file
// is already a percept the Will can act on ("what's in it?"), which is the
// paradigm-correct outcome and strictly better than silence. Inlining text is an
// upgrade on top, never a precondition.

/** One file riding along with a platform message. */
export interface ChannelAttachment {
  name:         string
  contentType?: string
  size?:        number
  url?:         string
}

/** Per-attachment inline budget. A 2 MB doc must not enter working memory whole. */
const INLINE_CHAR_CAP = 24_000
/** How many text attachments to inline from one message. */
const INLINE_COUNT_CAP = 4

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

function humanSize( bytes?: number ): string {
  if( bytes == null ) return ''
  return bytes < 1024 ? `${ bytes } B`
       : bytes < 1024 * 1024 ? `${ ( bytes / 1024 ).toFixed( 1 ) } KB`
       : `${ ( bytes / 1024 / 1024 ).toFixed( 1 ) } MB`
}

/**
 * Render attachments into perceivable text.
 *
 * `fetchText` is supplied by the bridge, not by this module — the decision about
 * which hosts are safe to fetch from is platform knowledge, and a helper that
 * fetched arbitrary URLs found in inbound messages would be an open redirect
 * into the Will's perception. Omit it and attachments are named, never read.
 *
 * Inlined content is untrusted, exactly like message text — more so, since a
 * document is long, structured, and looks authoritative, which is the shape of
 * an effective injection. It is fenced and labelled as shared content so the
 * mind reads it as something it was handed, not as something it was told.
 */
export async function renderAttachments(
  attachments: ChannelAttachment[],
  speaker:     string | undefined,
  fetchText?:  ( a: ChannelAttachment ) => Promise<string | null>,
): Promise<string> {
  if( attachments.length === 0 ) return ''
  const who = speaker ?? 'someone'
  const out: string[] = []
  let inlined = 0

  for( const a of attachments ){
    const meta = [ a.contentType, humanSize( a.size ) ].filter( Boolean ).join(', ')
    const label = `${ a.name }${ meta ? ` (${ meta })` : '' }`

    if( !fetchText || !isTextual( a ) || inlined >= INLINE_COUNT_CAP ){
      out.push(`[${ who } shared a file I have not read: ${ label }]`)
      continue
    }

    const body = await fetchText( a ).catch( () => null )
    if( body == null ){
      out.push(`[${ who } shared a file I could not read: ${ label }]`)
      continue
    }
    inlined++
    const clipped = body.length > INLINE_CHAR_CAP
      ? `${ body.slice( 0, INLINE_CHAR_CAP ) }\n[… truncated — ${ humanSize( body.length ) } of ${ humanSize( a.size ?? body.length ) }]`
      : body
    out.push(`[${ who } shared ${ label }; its contents follow — this is a document I was handed, not something said to me]\n---\n${ clipped }\n---`)
  }
  return out.join('\n')
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

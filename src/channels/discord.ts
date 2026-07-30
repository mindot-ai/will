// ─────────────────────────────────────────────────────────────
// src/channels/discord.ts — a Will present in a Discord server
// ─────────────────────────────────────────────────────────────
//
// The bridge relays both directions of the paradigm and nothing else:
//
//   inbound   guild/DM message → will.perceive({ from, speaker, text, thread })
//             — every author is `discord:<userId>` (stable across guilds), the
//             display name is *learned* by the mind, and each Discord channel
//             is its own conversation thread.
//   outbound  will.on('message') → the addressee's last shared channel, else
//             their DM, else the home channel. Proactive utterances (the mind
//             speaking first) route the same way — that is the point.
//
// The Will decides when to speak. There is no command prefix and no forced
// reply: unaddressed chatter is perceived (salience-scored by audition) and
// silence is a valid outcome. `mentionOnly` narrows perception for busy
// servers; it does not turn the bridge into an ask() surface.
//
// discord.js is imported lazily inside `createDiscordClient` — tests (and any
// host that brings its own client) inject `client`, and the structural
// `DiscordLikeClient` type keeps the dependency out of the type graph.
// ─────────────────────────────────────────────────────────────

import type { Will, WillMessage } from '#sdk/will'
import { ChannelRoster } from '#channels/roster'
import { chunkText, renderAttachments, isTextual, type ChannelBridge, type ChannelAttachment } from '#channels/types'

const DISCORD_MESSAGE_LIMIT = 2000

/**
 * The only hosts the bridge will fetch attachment bodies from.
 *
 * Deliberately an allowlist of Discord's own CDN. An inbound message is
 * untrusted input; following URLs it names would turn perception into an open
 * redirect, and a `url` field is no more trustworthy than the message text.
 */
const DISCORD_CDN_HOSTS = new Set( [ 'cdn.discordapp.com', 'media.discordapp.net' ] )

/** Refuse to pull a large file into a percept — the cap in renderAttachments
 *  bounds what is *kept*, this bounds what is fetched at all. */
const MAX_FETCH_BYTES = 256 * 1024

// ── The slice of discord.js the bridge actually uses (structural) ───────────

export interface DiscordLikeChannel {
  send( content: string ): Promise<unknown>
  sendTyping?(): Promise<unknown>
}

export interface DiscordLikeMessage {
  content: string
  cleanContent?: string
  channelId: string
  guildId?: string | null
  author: { id: string; bot?: boolean; username?: string; displayName?: string }
  member?: { displayName?: string } | null
  mentions?: { has( userId: string ): boolean }
  channel: DiscordLikeChannel
  /** discord.js Collection of attachments — iterable of values. Absent in tests
   *  that inject bare message objects, which is why every use is guarded. */
  attachments?: Iterable<{ name?: string | null; contentType?: string | null; size?: number; url?: string }>
}

export interface DiscordLikeClient {
  user: { id: string; setPresence?( p: unknown ): void } | null
  /** discord.js ≥14.22; polled so we needn't subscribe to the deprecated `ready`. */
  isReady?(): boolean
  on( event: 'messageCreate', fn: ( m: DiscordLikeMessage ) => void ): unknown
  once( event: string, fn: () => void ): unknown
  login( token: string ): Promise<unknown>
  destroy(): Promise<unknown> | void
  channels: { fetch( id: string ): Promise<unknown> }
  users: { fetch( id: string ): Promise<{ send( content: string ): Promise<unknown> }> }
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DiscordBridgeOptions {
  /** Bot token (Discord developer portal). Unused when `client` is injected pre-logged-in. */
  token?: string
  /** Channel ids the Will inhabits. Unset = every channel it can see. */
  channels?: string[]
  /** Perceive guild messages only when the Will is @mentioned (DMs always perceived). */
  mentionOnly?: boolean
  /** Fallback channel for utterances with no reachable addressee. */
  homeChannelId?: string
  /** Roster path (default: ./.will/<willId>.discord.json). */
  rosterPath?: string
  /**
   * Read the contents of text-like attachments (.md, .txt, .json, …) into the
   * percept, rather than only naming them. Default true.
   *
   * Only Discord's own CDN is ever fetched, and only up to a size cap. Set false
   * for a bridge that should never pull remote bytes — the Will still perceives
   * that a file arrived and can ask about it.
   */
  readAttachments?: boolean
  /** Test / power-user seam: bring your own client; discord.js is never imported. */
  client?: DiscordLikeClient
  log?: ( msg: string ) => void
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * Connect a Will to Discord. Resolves once the bridge is live (logged in and
 * relaying). Close it via the returned `ChannelBridge.close()` — the Will
 * itself is not stopped; it simply loses this surface.
 */
export async function connectDiscord( will: Will, opts: DiscordBridgeOptions ): Promise<ChannelBridge> {
  const log     = opts.log ?? ( ( m: string ) => console.error(`[will:discord] ${ m }`) )
  const roster  = new ChannelRoster( opts.rosterPath ?? `.will/${ will.id }.discord.json`)
  const allowed = opts.channels?.length ? new Set( opts.channels ) : null

  const client = opts.client ?? await createDiscordClient()

  /** The most recently active allowed channel — last-resort proactive target. */
  let lastActiveChannelId: string | null = opts.homeChannelId ?? null

  // ── inbound: platform message → stimulus ──────────────────────────────────
  client.on('messageCreate', message => { void onMessage( message ) } )

  async function onMessage( message: DiscordLikeMessage ): Promise<void> {
    const self = client.user
    if( !self || message.author.id === self.id || message.author.bot ) return

    const isDM = !message.guildId
    if( !isDM && allowed && !allowed.has( message.channelId ) ) return

    const addressed = isDM || ( message.mentions?.has( self.id ) ?? false )
    if( opts.mentionOnly && !addressed ) return

    const entityId = `discord:${ message.author.id }`
    const speaker  = message.member?.displayName ?? message.author.displayName ?? message.author.username

    roster.record( {
      entityId,
      userId: message.author.id,
      ...( speaker ? { displayName: speaker } : {} ),
      ...( isDM ? { dmChannelId: message.channelId } : { lastChannelId: message.channelId } ),
    } )
    if( !isDM ) lastActiveChannelId = message.channelId

    // Being addressed is the one moment a presence cue is honest — the mind
    // may still choose silence, and typing expires on its own.
    if( addressed ) await message.channel.sendTyping?.().catch( () => {} )

    const said  = ( message.cleanContent || message.content ).trim()
    const files = collectAttachments( message )

    // An attachment-only message used to die here on the empty body: no percept,
    // no log line, nothing. From the mind's side the person had simply gone
    // quiet — and Discord *makes* these, turning a long pasted markdown block
    // into a .md upload. Only a message with neither words nor files is nothing.
    if( !said && files.length === 0 ) return

    const shared = await renderAttachments(
      files, speaker,
      opts.readAttachments === false ? undefined : fetchAttachmentText,
    )
    const text = [ said, shared ].filter( Boolean ).join('\n')

    await will.perceive( {
      text,
      from:   entityId,
      thread: `discord:${ message.channelId }`,
      ...( speaker ? { speaker } : {} ),
    } )
  }

  /** discord.js hands us a Collection; tests inject plain objects or nothing. */
  function collectAttachments( message: DiscordLikeMessage ): ChannelAttachment[] {
    if( !message.attachments ) return []
    const out: ChannelAttachment[] = []
    for( const a of message.attachments )
      out.push( {
        name: a.name ?? 'unnamed',
        ...( a.contentType ? { contentType: a.contentType } : {} ),
        ...( a.size != null ? { size: a.size } : {} ),
        ...( a.url ? { url: a.url } : {} ),
      } )
    return out
  }

  /** Fetch one text attachment — Discord CDN only, size-capped. */
  async function fetchAttachmentText( a: ChannelAttachment ): Promise<string | null> {
    if( !a.url || !isTextual( a ) ) return null
    let host: string
    try { host = new URL( a.url ).hostname }
    catch { return null }
    if( !DISCORD_CDN_HOSTS.has( host ) ){
      log(`refusing to fetch attachment '${ a.name }' from non-CDN host ${ host }`)
      return null
    }
    if( a.size != null && a.size > MAX_FETCH_BYTES ){
      log(`attachment '${ a.name }' is ${ a.size } bytes — naming it without reading`)
      return null
    }
    const res = await fetch( a.url, { signal: AbortSignal.timeout( 10_000 ) } )
    if( !res.ok ){
      log(`attachment '${ a.name }' fetch failed: ${ res.status }`)
      return null
    }
    return ( await res.text() ).slice( 0, MAX_FETCH_BYTES )
  }

  // ── outbound: projected utterance → the addressee ─────────────────────────
  // The facade has no off(); the bridge gates its handler on `closed` instead.
  let closed = false
  will.on('message', ( m: WillMessage ) => { if( !closed ) void deliver( m ) } )

  async function deliver( m: WillMessage ): Promise<void> {
    const peer = m.to ? roster.resolve( m.to ) : undefined
    const chunks = chunkText( m.content, DISCORD_MESSAGE_LIMIT )

    // Preference order: where we last shared a room → their DM → home channel.
    const channelIds = [ peer?.lastChannelId, peer?.dmChannelId, opts.homeChannelId ?? undefined, lastActiveChannelId ?? undefined ]
    for( const id of channelIds ){
      if( !id ) continue
      try {
        const channel = await client.channels.fetch( id ) as DiscordLikeChannel | null
        if( !channel?.send ) continue
        for( const chunk of chunks ) await channel.send( chunk )
        return
      }
      catch { /* try the next route */ }
    }
    if( peer ){
      try {
        const user = await client.users.fetch( peer.userId )
        for( const chunk of chunks ) await user.send( chunk )
        return
      }
      catch { /* fall through */ }
    }
    log(`no route for utterance to '${ m.to }' — dropped (${ m.content.length } chars)`)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  const bridge: ChannelBridge = {
    kind: 'discord',
    async start(): Promise<void> {
      if( !client.user ){
        // discord.js ≥14.22 renamed `ready` → `clientReady`. Subscribing to the
        // old name is what triggers its DeprecationWarning, so we take the new
        // name and poll `isReady()` for older builds rather than listening.
        const ready = new Promise<void>( resolve => {
          let poll: ReturnType<typeof setInterval> | null = null
          const done = (): void => { if( poll ) clearInterval( poll ); resolve() }
          client.once('clientReady', done )
          poll = setInterval( () => { if( client.isReady?.() ) done() }, 100 )
          poll.unref?.()
        } )
        await client.login( opts.token ?? '')
        await ready
      }
      log(`${ will.name } is present on Discord as user ${ client.user?.id }`)
    },
    async close(): Promise<void> {
      if( closed ) return
      closed = true
      roster.flush()
      await Promise.resolve( client.destroy() ).catch( () => {} )
    },
  }
  return bridge
}

/** Build a real discord.js client (lazy import keeps it out of non-Discord hosts). */
async function createDiscordClient(): Promise<DiscordLikeClient> {
  let mod: typeof import('discord.js')
  try { mod = await import('discord.js') }
  catch {
    throw new Error('discord.js is not installed (it is an optionalDependency) — run `bun add discord.js` / `npm i discord.js` and retry.')
  }
  const { Client, GatewayIntentBits, Partials } = mod
  return new Client( {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [ Partials.Channel ],   // DMs arrive on uncached channels
  } ) as unknown as DiscordLikeClient
}

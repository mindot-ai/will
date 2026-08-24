// ─────────────────────────────────────────────────────────────
// src/surface/channels/discord.ts — a Will present in a Discord server
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

import type { Will, WillMessage } from '#surface/sdk/will'
import { ChannelRoster } from '#surface/channels/roster'
import { chunkText, renderAttachments, isTextual, type ChannelBridge, type ChannelAttachment } from '#surface/channels/types'

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

/**
 * How much of her own message to quote back when someone reacts to it.
 *
 * Enough to identify WHICH thing was agreed with — a bare "someone reacted 👍"
 * closes the answered loop but tells the mind nothing about what was affirmed,
 * and 0.9.0 established that an answer without its content is worse than none:
 * it invites acting on an answer never seen.
 */
const REACTION_QUOTE_CHARS = 140

/**
 * What to call the room this was said in — `#general`, `#general › release-cut`,
 * or `#general in Mindot` when the server is known.
 *
 * A LABEL, not an address. `discord:1531…` is how a message gets to the room;
 * this is what a person calls it, and 0.9.0 established those are different
 * facts. Without it a room had a dossier and no name, so it reached the mind as
 * "something" — which is what the prompt says for a `thing` it cannot name — and
 * a mind choosing where to speak was picking between two opaque numbers.
 *
 * Returns undefined for a DM: a private thread is not a place, it is the person,
 * and the tracker deliberately gives it no dossier to name.
 */
function roomLabel( message: DiscordLikeMessage ): string | undefined {
  if( !message.guildId ) return undefined
  const own = message.channel?.name
  if( !own ) return undefined
  const parent = message.channel?.parent?.name
  const room   = parent ? `#${ parent } › ${ own }` : `#${ own }`
  const guild  = message.guild?.name
  return guild ? `${ room } in ${ guild }` : room
}

// ── The slice of discord.js the bridge actually uses (structural) ───────────

export interface DiscordLikeChannel {
  send( content: string ): Promise<unknown>
  sendTyping?(): Promise<unknown>
  /** `general` for a text channel; absent on a DM, which has no name and is a person. */
  name?: string | null
  /** The thread's parent channel, so a thread reads as "#general › release-cut". */
  parent?: { name?: string | null } | null
  /** What the room is FOR, in the server's own words. Only read when asked. */
  topic?: string | null
  /** How many are in it — a count, never a roster. */
  memberCount?: number
}

export interface DiscordLikeAttachment {
  name?:        string | null
  contentType?: string | null
  size?:        number
  url?:         string
}

export interface DiscordLikeMessage {
  content: string
  cleanContent?: string
  channelId: string
  guildId?: string | null
  /** The server this was said in. Its NAME is what a person calls the place. */
  guild?: { name?: string | null } | null
  author: { id: string; bot?: boolean; username?: string; displayName?: string }
  member?: { displayName?: string } | null
  mentions?: { has( userId: string ): boolean }
  channel: DiscordLikeChannel
  /**
   * Files riding with the message.
   *
   * discord.js hands us a `Collection`, which extends `Map` — so iterating it
   * directly yields `[id, attachment]` PAIRS, not attachments. Typing this as a
   * bare `Iterable` was wrong and silently produced `name: undefined` against
   * the real client while passing every test, because the test fake injects an
   * array. Both shapes are accepted now and normalised in `collectAttachments`.
   */
  attachments?: ReadonlyMap<string, DiscordLikeAttachment> | Iterable<DiscordLikeAttachment>
}

/**
 * A reaction, and the message it lands on.
 *
 * Both halves may be PARTIAL: Discord delivers a reaction on an uncached message
 * with almost every field empty, which is the normal case for a message the bot
 * sent before its current process started. `fetch()` fills it in, and the handler
 * must call it rather than reading through the hole.
 */
export interface DiscordLikeReaction {
  emoji:   { name?: string | null; id?: string | null }
  message: DiscordLikeMessage & {
    partial?: boolean
    author?:  { id: string; bot?: boolean; username?: string; displayName?: string }
    fetch?(): Promise<DiscordLikeReaction['message']>
  }
  partial?: boolean
  fetch?(): Promise<DiscordLikeReaction>
}

export interface DiscordLikeReactor {
  id:           string
  bot?:         boolean
  username?:    string
  displayName?: string
}

export interface DiscordLikeClient {
  user: { id: string; setPresence?( p: unknown ): void } | null
  /** discord.js ≥14.22; polled so we needn't subscribe to the deprecated `ready`. */
  isReady?(): boolean
  on( event: 'messageCreate', fn: ( m: DiscordLikeMessage ) => void ): unknown
  on( event: 'messageReactionAdd', fn: ( r: DiscordLikeReaction, u: DiscordLikeReactor ) => void ): unknown
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
  /**
   * Channel ids the Will inhabits. Unset — or the single wildcard `'*'` — means
   * every channel it can see, so adding it to a new channel in Discord is enough.
   * A list restrains it to exactly those, and a message anywhere else is dropped
   * at the bridge: the Will never perceives it and its silence there is not a choice.
   */
  channels?: readonly string[]
  /**
   * Where the Will only perceives guild messages that @mention it. DMs are always
   * perceived either way.
   *
   *   `true`            — everywhere
   *   `[ 'id', … ]`     — only in those channels; it listens openly elsewhere
   *   omitted / `false` — nowhere
   *
   * The list form is what makes a wide-open roster usable: present in every channel,
   * but a quiet participant in the busy ones.
   */
  mentionOnly?: boolean | readonly string[]
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
  // `null` = everywhere. An explicit '*' reads the same as omitting the list, so a
  // host can say "all channels" out loud instead of by leaving a variable blank.
  const allowed = opts.channels?.length && !opts.channels.includes('*')
    ? new Set( opts.channels )
    : null

  // Mention-gating is either global (true) or scoped to named channels.
  const mentionEverywhere = opts.mentionOnly === true
  const mentionIn         = Array.isArray( opts.mentionOnly ) && opts.mentionOnly.length
    ? new Set( opts.mentionOnly )
    : null

  const client = opts.client ?? await createDiscordClient()

  /** The most recently active allowed channel — last-resort proactive target. */
  let lastActiveChannelId: string | null = opts.homeChannelId ?? null

  // ── inbound: platform message → stimulus ──────────────────────────────────
  client.on('messageCreate', message => { void onMessage( message ) } )
  client.on('messageReactionAdd', ( reaction, user ) => { void onReaction( reaction, user ) } )

  /**
   * Someone reacted to something the Will said.
   *
   * A reaction IS an answer, and until this existed the mind read it as silence.
   * `conversation.received` is written only from a text percept, so a 👍 — the
   * commonest acknowledgement on Discord — produced no record at all: the turn it
   * answered stayed open, the reply window elapsed, and the mind concluded it had
   * been ignored. That conclusion is not inert. It reaches reputation as
   * reliability (−0.06 per unanswered turn) and goals as absence of progress, so
   * answering her with an emoji actively taught her that person does not respond.
   *
   * Only reactions on the Will's OWN messages are perceived. A reaction between
   * two other people in a busy channel is real social information, but it is not
   * an answer to anything the mind said, and routing it here would swamp the
   * conversation record it is meant to correct.
   */
  async function onReaction( reaction: DiscordLikeReaction, user: DiscordLikeReactor ): Promise<void> {
    const self = client.user
    if( !self || user.id === self.id || user.bot ) return

    // Both may arrive partial — a reaction on a message this process never cached
    // is the NORMAL case for anything said before the last restart, which is
    // exactly the long-lived conversation this is here to keep honest.
    const full = reaction.partial && reaction.fetch ? await reaction.fetch().catch( () => null ) : reaction
    if( !full ) return
    const msg = full.message.partial && full.message.fetch
      ? await full.message.fetch().catch( () => null )
      : full.message
    if( !msg?.author ) return

    if( msg.author.id !== self.id ) return                       // not ours — not an answer to us
    const isDM = !msg.guildId
    if( !isDM && allowed && !allowed.has( msg.channelId ) ) return

    const emoji = full.emoji?.name ?? ( full.emoji?.id ? ':custom:' : '' )
    if( !emoji ) return

    const who  = user.displayName ?? user.username
    const said = ( msg.cleanContent || msg.content || '').trim().slice( 0, REACTION_QUOTE_CHARS )

    // Described, bracketed, first person — the same shape `renderAttachments` uses
    // for a file, and for the same reason: this reached the mind through the
    // conversation but nobody SAID it, and a percept that reads like speech invites
    // the mind to answer words that were never spoken.
    const text = said
      ? `[${ who ?? 'someone' } reacted ${ emoji } to what I said: "${ said }"]`
      : `[${ who ?? 'someone' } reacted ${ emoji } to something I said]`

    await will.perceive( {
      text,
      from:   `discord:${ user.id }`,
      thread: `discord:${ msg.channelId }`,
      direct: isDM,
      // Exafferent, and the near-miss is worth naming: this is ABOUT something
      // she did, but it is not her doing it. Somebody else reacted. Reafference
      // is the mind sensing its OWN act's consequence, not the world's response
      // to that act — a reply would fail the same test for the same reason.
      provenance: 'exafferent',
      ...( roomLabel( msg ) ? { threadName: roomLabel( msg ) } : {} ),
      ...( who ? { speaker: who } : {} ),
    } )
  }

  async function onMessage( message: DiscordLikeMessage ): Promise<void> {
    const self = client.user
    if( !self || message.author.id === self.id || message.author.bot ) return

    const isDM = !message.guildId
    if( !isDM && allowed && !allowed.has( message.channelId ) ) return

    const addressed = isDM || ( message.mentions?.has( self.id ) ?? false )
    // DMs are addressed by definition, so this never gates them.
    if( !addressed && ( mentionEverywhere || mentionIn?.has( message.channelId ) ) ) return

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
      // `isDM` has been computed on every inbound since this bridge shipped and
      // used only to pick a roster field. It is the one fact that makes a room
      // the right or wrong place to say something, and the mind never saw it —
      // which is how a follow-up promised in a DM went out to #general.
      direct: isDM,
      // Somebody spoke. The bridge already drops her own messages (`onMessage`
      // returns early on `author.id === self.id`), so nothing reafferent can
      // reach this line today — but that filter is a bridge-level deletion of
      // a signal she is entitled to sense, not a reason for the field to lie.
      provenance: 'exafferent',
      ...( roomLabel( message ) ? { threadName: roomLabel( message ) } : {} ),
      ...( speaker ? { speaker } : {} ),
    } )
  }

  /**
   * Normalise whatever the client gave us into attachments.
   *
   * `.values()` first: a discord.js Collection is a Map, so `for..of` over it
   * yields `[id, attachment]` pairs and every field reads `undefined`. Arrays
   * expose `.values()` too and yield their elements, so one branch covers the
   * real client, a plain array, and a Map alike.
   */
  function collectAttachments( message: DiscordLikeMessage ): ChannelAttachment[] {
    if( !message.attachments ) return []
    const source = message.attachments as { values?: () => Iterable<DiscordLikeAttachment> }
    const items: Iterable<DiscordLikeAttachment> = typeof source.values === 'function'
      ? source.values()
      : message.attachments as Iterable<DiscordLikeAttachment>

    const out: ChannelAttachment[] = []
    for( const a of items )
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

  // ── the Will looks at something here, and Discord answers ─────────────────
  //
  // `inspect` is innate: every mind can look. What it finds depends on there
  // being a world that can be asked, and this is Discord's answer.
  //
  // The answer is RETURNED AS AN OBSERVATION, and the engine turns it into a
  // percept (SIGNAL_BOUNDARY P2). `description` says how the looking went;
  // `observation` says what was found, and arrives at the mind as a reafferent
  // percept tied to this act by `sourceIntentId` — so it can weigh the facts,
  // disbelieve them, or decide they do not matter. An earlier cut wrote the
  // answer straight into her dossier and beliefs, which is a mind being told
  // what it knows rather than a mind finding out.
  //
  // This used to take TWO calls: return the ack, then separately `perceive()`
  // the answer wrapped in a bracketed sentence — because an ack could not carry
  // facts, and the sense door only accepted things somebody had said. The prose
  // bracket was load-bearing: it was the only place the reafference lived where
  // anything could read it. Both are gone.
  will.effector('inspect', async ( _args, ctx ) => {
    // The mind names a referent (`ke:1sqlkux`); we hold channel ids. The Will
    // resolves the anchor to the addresses it was met at, and we take ours.
    const address = ( ctx.targetAddresses ?? [] ).find( a => a.startsWith('discord:') )
    if( !address ) return { success: false, description: 'Not something I can see on Discord.' }

    const id = address.slice('discord:'.length )
    const channel = await client.channels.fetch( id ).catch( () => null ) as DiscordLikeChannel | null
    // A user id lands here too — a person is not a place, and Discord has nothing
    // to say about them that watching them talk does not say better.
    if( !channel?.name ) return { success: false, description: 'There is nothing here I can look up.' }

    const facts: string[] = []
    if( channel.topic )       facts.push(`it is for: ${ channel.topic }`)
    if( channel.parent?.name ) facts.push(`it sits under #${ channel.parent.name }`)
    if( typeof channel.memberCount === 'number')
      // A COUNT, not a roster. Walking into a room you see that it is crowded long
      // before you learn who anyone is; people become known by being met.
      facts.push(`${ channel.memberCount } people are in it`)

    if( facts.length === 0 )
      return { success: false, description: `#${ channel.name } has nothing recorded about it.` }

    const label = roomLabel( { channelId: id, guildId: 'g', channel } as DiscordLikeMessage ) ?? `#${ channel.name }`

    return {
      success:     true,
      description: `Looked into ${ label }.`,
      // The room as Discord has it, in the shape Discord has it. Not flattened
      // into a sentence for the mind's benefit — a host that reshapes its own
      // data is deciding what the mind may notice about it, and `observation`
      // takes whatever shape the answer already had.
      //
      // `summary` is the one concession: it is what the executive prompt renders,
      // so the host says it in words rather than leaving the mind to read JSON.
      // Everything beside it stays available.
      observation: {
        summary:  `I looked into ${ label }: ${ facts.join('; ') }.`,
        room:     label,
        address,
        ...( channel.topic          ? { topic: channel.topic } : {} ),
        ...( channel.parent?.name   ? { parent: `#${ channel.parent.name }` } : {} ),
        ...( typeof channel.memberCount === 'number' ? { memberCount: channel.memberCount } : {} ),
      },
    }
  } )

  // ── outbound: projected utterance → the addressee ─────────────────────────
  // The facade has no off(); the bridge gates its handler on `closed` instead.
  let closed = false
  will.on('message', ( m: WillMessage ) => { if( !closed ) void deliver( m ) } )

  async function deliver( m: WillMessage ): Promise<void> {
    const peer = m.to ? roster.resolve( m.to ) : undefined
    const chunks = chunkText( m.content, DISCORD_MESSAGE_LIMIT )

    // A reply goes back to the room it was said in. `m.thread` is the thread from
    // the `perceive()` that prompted this — `discord:<channelId>` — so it is not a
    // guess about where this person usually is, it is where they just spoke.
    //
    // Everything below it IS a guess, and the guesses were wrong in the way that
    // matters most: a DM arrived, she answered it in seconds, and the answer went
    // to the shared server channel because `lastChannelId` still held the last
    // room they had been in together. She looked like she was ignoring him.
    //
    // Unprompted utterances carry no thread — nothing was said to them — so those
    // still fall through to the roster, which is the right behaviour there.
    const replyTo = m.thread?.startsWith('discord:') ? m.thread.slice('discord:'.length ) : undefined

    // Preference order: the room they spoke in → where we last shared a room →
    // their DM → home channel.
    const channelIds = [ replyTo, peer?.lastChannelId, peer?.dmChannelId, opts.homeChannelId ?? undefined, lastActiveChannelId ?? undefined ]
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
      // Neither is privileged, so this costs nothing to ask for — and without
      // them an emoji answer never arrives and reads as being ignored.
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [
      Partials.Channel,     // DMs arrive on uncached channels
      // A reaction on a message this process did not cache — i.e. anything said
      // before the last restart — is delivered partial, and without these the
      // event is dropped before the handler sees it. That is precisely the
      // long-running conversation the answered loop exists for.
      Partials.Message,
      Partials.Reaction,
    ],
  } ) as unknown as DiscordLikeClient
}

/**
 * Parse `WILL_DISCORD_MENTION_ONLY` into the `mentionOnly` option.
 *
 * Accepts a boolean OR a channel list, because "only speak when spoken to" is
 * rarely a whole-server property — it is how you stay present in a busy channel
 * without narrating in it.
 *
 *   `1` / `true` / `yes`   → true (everywhere)
 *   `0` / `false` / unset  → false (nowhere)
 *   `123,456`              → only those channels
 *
 * Exported so every host parses it identically; the CLI and any SDK host share
 * this rather than each re-deriving the syntax.
 */
export function parseMentionOnly( raw?: string ): boolean | string[] {
  const v = raw?.trim()
  if( !v ) return false
  if( /^(1|true|yes)$/i.test( v ) ) return true
  if( /^(0|false|no)$/i.test( v ) ) return false

  const ids = v.split(',').map( s => s.trim() ).filter( Boolean )
  return ids.length ? ids : false
}

/**
 * Parse `WILL_DISCORD_CHANNELS`. `*` (or unset/empty) means every channel the Will
 * can see — being added to a channel in Discord is then all it takes. Anything else
 * restrains it to exactly the ids listed.
 */
export function parseChannels( raw?: string ): string[] | undefined {
  const ids = raw?.split(',').map( s => s.trim() ).filter( Boolean )
  return ids?.length ? ids : undefined
}

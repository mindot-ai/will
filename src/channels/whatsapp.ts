// ─────────────────────────────────────────────────────────────
// src/channels/whatsapp.ts — a Will present on WhatsApp
// ─────────────────────────────────────────────────────────────
//
// Same paradigm as the Discord bridge, different room:
//
//   inbound   DM / group message → will.perceive({ from, speaker, text, thread })
//             — every author is `whatsapp:<number>` (stable across chats), the
//             push name is *learned* by the mind, and each chat (DM or group)
//             is its own conversation thread.
//   outbound  will.on('message') → the addressee's last shared group, else
//             their DM (a WhatsApp DM jid is derivable from the number — no
//             roster miss is fatal), else the home chat.
//
// TRANSPORT — read before deploying. This bridge speaks the *linked-device*
// protocol via Baileys: the Will pairs to a WhatsApp account by QR scan, like
// WhatsApp Web. That is not a sanctioned bot API — WhatsApp's terms don't
// allow automation on personal accounts, and accounts doing it can be banned.
// Meta's sanctioned path (the Business Cloud API) needs a business account,
// webhook hosting, and app review — no 2-minute pairing. Operator's choice;
// docs/channels/whatsapp.md is explicit about the trade. Use a spare number.
//
// Baileys is imported lazily inside `createWhatsAppSocket` — tests (and hosts
// that bring their own transport) inject `socket`, and the structural
// `WaLikeSocket` type keeps the dependency out of the type graph.
// ─────────────────────────────────────────────────────────────

import type { Will, WillMessage } from '#sdk/will'
import { ChannelRoster } from '#channels/roster'
import { chunkText, type ChannelBridge } from '#channels/types'

/** WhatsApp's hard per-message cap. */
const WHATSAPP_MESSAGE_LIMIT = 65_536

// ── The slice of a Baileys socket the bridge actually uses (structural) ──────

export interface WaLikeMessage {
  key: {
    remoteJid?: string | null
    fromMe?: boolean | null
    /** Sender jid inside a group (absent in DMs). */
    participant?: string | null
  }
  /** Sender's display ("push") name. */
  pushName?: string | null
  messageStubType?: number | null
  message?: {
    conversation?: string | null
    extendedTextMessage?: { text?: string | null; contextInfo?: { mentionedJid?: string[] | null } | null } | null
    imageMessage?: { caption?: string | null } | null
    videoMessage?: { caption?: string | null } | null
  } | null
}

export interface WaLikeSocket {
  /** The paired account, once connected. id like '4915…:12@s.whatsapp.net'. */
  user?: { id: string; name?: string } | null
  ev: { on( event: 'messages.upsert', fn: ( u: { messages: WaLikeMessage[]; type?: string } ) => void ): unknown }
  sendMessage( jid: string, content: { text: string } ): Promise<unknown>
  sendPresenceUpdate?( state: 'composing' | 'paused', jid?: string ): Promise<unknown>
  /** Tear the connection down (does not unlink the device). */
  end?( err?: Error ): void
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface WhatsAppBridgeOptions {
  /** Chat jids the Will inhabits (groups `…@g.us`, DMs `…@s.whatsapp.net`). Unset = every chat. */
  chats?: string[]
  /** Perceive group messages only when the Will is @mentioned (DMs always perceived). */
  mentionOnly?: boolean
  /** Fallback chat jid for utterances with no reachable addressee. */
  homeChatId?: string
  /** Linked-device credentials dir (default: ./.will/<willId>.wa-auth). QR pairs on first run. */
  authPath?: string
  /** Roster path (default: ./.will/<willId>.whatsapp.json). */
  rosterPath?: string
  /** Test / power-user seam: bring your own socket; Baileys is never imported. */
  socket?: WaLikeSocket
  log?: ( msg: string ) => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const isGroupJid = ( jid: string ): boolean => jid.endsWith('@g.us')

/** '4915123:7@s.whatsapp.net' → '4915123' (device + server stripped). */
const bareId = ( jid: string ): string => jid.split('@')[0]!.split(':')[0]!

/** A DM jid is derivable from the bare number — WhatsApp's gift to proactivity. */
const dmJidFor = ( userId: string ): string => `${ userId }@s.whatsapp.net`

function textOf( m: WaLikeMessage ): string {
  const msg = m.message
  return msg?.conversation
      ?? msg?.extendedTextMessage?.text
      ?? msg?.imageMessage?.caption
      ?? msg?.videoMessage?.caption
      ?? ''
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * Connect a Will to WhatsApp over the linked-device protocol. First run prints
 * a QR to pair (Settings → Linked devices → Link a device); credentials persist
 * in `authPath` so later runs reconnect silently. Close via the returned
 * `ChannelBridge.close()` — the Will keeps ticking; it only loses this surface.
 */
export async function connectWhatsApp( will: Will, opts: WhatsAppBridgeOptions = {} ): Promise<ChannelBridge> {
  const log     = opts.log ?? ( ( m: string ) => console.error(`[will:whatsapp] ${ m }`) )
  const roster  = new ChannelRoster( opts.rosterPath ?? `.will/${ will.id }.whatsapp.json`)
  const allowed = opts.chats?.length ? new Set( opts.chats ) : null

  let closed = false
  const socket = opts.socket ?? await createWhatsAppSocket( {
    authPath: opts.authPath ?? `.will/${ will.id }.wa-auth`,
    log,
    stillOpen: () => !closed,
  } )

  /** The most recently active allowed chat — last-resort proactive target. */
  let lastActiveChatId: string | null = opts.homeChatId ?? null

  // ── inbound: platform message → stimulus ──────────────────────────────────
  socket.ev.on('messages.upsert', ( { messages, type } ) => {
    if( type && type !== 'notify') return   // history sync/corrections are not new percepts
    for( const m of messages ) void onMessage( m )
  } )

  async function onMessage( m: WaLikeMessage ): Promise<void> {
    const jid = m.key.remoteJid
    if( !jid || m.key.fromMe || !m.message || m.messageStubType ) return
    if( jid.endsWith('@broadcast') || jid.endsWith('@newsletter') ) return   // stories/broadcasts aren't a room the Will is in
    if( allowed && !allowed.has( jid ) ) return

    const isGroup   = isGroupJid( jid )
    const senderJid = isGroup ? m.key.participant : jid
    if( !senderJid ) return

    const selfId    = socket.user ? bareId( socket.user.id ) : null
    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid ?? []
    const addressed = !isGroup || ( selfId != null && mentioned.some( j => bareId( j ) === selfId ) )
    if( opts.mentionOnly && !addressed ) return

    const userId   = bareId( senderJid )
    const entityId = `whatsapp:${ userId }`
    const speaker  = m.pushName ?? undefined

    roster.record( {
      entityId,
      userId,
      ...( speaker ? { displayName: speaker } : {} ),
      ...( isGroup ? { lastChannelId: jid } : { dmChannelId: jid } ),
    } )
    if( isGroup ) lastActiveChatId = jid

    // Same rule as Discord: a presence cue only when addressed — the mind may
    // still choose silence, and 'composing' expires on its own.
    if( addressed ) await socket.sendPresenceUpdate?.('composing', jid ).catch( () => {} )

    const text = textOf( m )
    if( !text.trim() ) return

    await will.perceive( {
      text,
      from:   entityId,
      thread: `whatsapp:${ jid }`,
      ...( speaker ? { speaker } : {} ),
    } )
  }

  // ── outbound: projected utterance → the addressee ─────────────────────────
  will.on('message', ( m: WillMessage ) => { if( !closed ) void deliver( m ) } )

  async function deliver( m: WillMessage ): Promise<void> {
    const peer   = m.to ? roster.resolve( m.to ) : undefined
    const chunks = chunkText( m.content, WHATSAPP_MESSAGE_LIMIT )

    // The chat they actually spoke in → last shared group → known DM → DM derived
    // from the entity id itself → home chat → last active chat. Unlike Discord, an
    // unmet-but-addressed entity is still reachable: `whatsapp:<number>` implies
    // its DM jid.
    //
    // `m.thread` leads because everything after it is a guess about where this
    // person usually is, and a reply belongs in the room the question was asked
    // in. The Discord bridge had the identical ordering and answered a DM in a
    // shared server channel — from the operator's side, silence.
    const replyTo   = m.thread?.startsWith('whatsapp:') ? m.thread.slice('whatsapp:'.length ) : undefined
    const derivedDm = m.to?.startsWith('whatsapp:') ? dmJidFor( m.to.slice('whatsapp:'.length ) ) : undefined
    const targets = [ replyTo, peer?.lastChannelId, peer?.dmChannelId, derivedDm, opts.homeChatId ?? undefined, lastActiveChatId ?? undefined ]
    for( const jid of targets ){
      if( !jid ) continue
      try {
        for( const chunk of chunks ) await socket.sendMessage( jid, { text: chunk } )
        return
      }
      catch { /* try the next route */ }
    }
    log(`no route for utterance to '${ m.to }' — dropped (${ m.content.length } chars)`)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  return {
    kind: 'whatsapp',
    async start(): Promise<void> {
      // createWhatsAppSocket resolves already-open; an injected socket is the
      // caller's to have readied.
      log(`${ will.name } is present on WhatsApp${ socket.user ? ` as ${ bareId( socket.user.id ) }` : '' }`)
    },
    async close(): Promise<void> {
      if( closed ) return
      closed = true
      roster.flush()
      try { socket.end?.() } catch { /* already down */ }
    },
  }
}

// ── The real transport (Baileys, lazily imported) ────────────────────────────

interface SocketFactoryOpts {
  authPath:  string
  log:       ( msg: string ) => void
  /** Reconnect only while the bridge is open. */
  stillOpen: () => boolean
}

/**
 * A reconnect-stable facade over Baileys. Baileys' own pattern replaces the
 * socket object on every reconnect; the facade keeps one stable identity the
 * bridge can hold, re-attaching its subscribers to each inner incarnation.
 * Resolves once the first connection is open (after QR pairing on first run).
 */
async function createWhatsAppSocket( o: SocketFactoryOpts ): Promise<WaLikeSocket> {
  let baileys: typeof import('baileys')
  try { baileys = await import('baileys') }
  catch {
    throw new Error('baileys is not installed (it is an optionalDependency) — run `bun add baileys` / `npm i baileys` and retry.')
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys

  // Baileys logs through pino at info by default — JSON noise all over the
  // host's stderr. A minimal pino-shaped silent logger (child() returns
  // itself, every level a no-op) is what it actually needs; hand-rolling it
  // beats importing a transitive dep that may not resolve from dist/.
  const noop = (): void => {}
  const logger = {
    level: 'silent',
    child(){ return logger },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }

  type Handler = ( u: { messages: WaLikeMessage[]; type?: string } ) => void
  const subscribers: Handler[] = []
  let inner: ReturnType<typeof makeWASocket> | null = null

  const facade: WaLikeSocket = {
    get user(){ return inner?.user ? { id: inner.user.id, name: inner.user.name ?? undefined } : null },
    ev: { on: ( _e, fn ) => { subscribers.push( fn ) } },
    sendMessage: ( jid, content ) => {
      if( !inner ) return Promise.reject( new Error('whatsapp socket not connected') )
      return inner.sendMessage( jid, content )
    },
    sendPresenceUpdate: ( state, jid ) => inner?.sendPresenceUpdate( state, jid ) ?? Promise.resolve(),
    end: () => inner?.end( undefined ),
  }

  const { state, saveCreds } = await useMultiFileAuthState( o.authPath )

  await new Promise<void>( ( resolveOpen, rejectOpen ) => {
    let opened = false

    function connect(): void {
      const sock = makeWASocket( { auth: state, logger: logger as never } )
      inner = sock

      sock.ev.on('creds.update', saveCreds )
      sock.ev.on('messages.upsert', u => { for( const fn of subscribers ) fn( u as never ) } )

      sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect, qr } = update as {
          connection?: string; lastDisconnect?: { error?: unknown }; qr?: string
        }

        if( qr ) void printQr( qr, o.log )

        if( connection === 'open' && !opened ){
          opened = true
          resolveOpen()
        }
        if( connection === 'close'){
          const code = ( lastDisconnect?.error as { output?: { statusCode?: number } } | undefined )?.output?.statusCode
          if( code === DisconnectReason.loggedOut ){
            const err = new Error('WhatsApp unlinked this device (logged out) — delete the auth dir and pair again.')
            o.log( err.message )
            if( !opened ) rejectOpen( err )
            return
          }
          if( o.stillOpen() ){
            o.log(`connection closed (status ${ code ?? '?' }) — reconnecting…`)
            setTimeout( connect, 3_000 )
          }
        }
      } )
    }

    connect()
  } )

  return facade
}

/** QR to the terminal; falls back to the raw pairing string if the tiny renderer is absent. */
async function printQr( qr: string, log: ( m: string ) => void ): Promise<void> {
  log('pair this device: WhatsApp → Settings → Linked devices → Link a device')
  try {
    type QrModule = { generate( s: string, o: { small: boolean } ): void }
    const qrt = ( await import('qrcode-terminal' as string ) ) as QrModule & { default?: QrModule }
    ;( qrt.default ?? qrt ).generate( qr, { small: true } )
  }
  catch {
    log(`qrcode-terminal not installed — raw pairing code:\n${ qr }`)
  }
}

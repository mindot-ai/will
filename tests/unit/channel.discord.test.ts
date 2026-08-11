// ─────────────────────────────────────────────────────────────
// tests/unit/channel.discord.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Discord bridge — both directions of the paradigm over a fake client:
 * inbound messages become perceive() stimuli (entity id, learned speaker,
 * per-channel thread), outbound utterances route via the roster, and the
 * gates (bots, allowlist, mentionOnly) narrow perception without ever
 * fabricating a reply.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Will, Stimulus, WillMessage } from '#surface/sdk/will'
import { connectDiscord, parseChannels, parseMentionOnly, type DiscordLikeClient, type DiscordLikeMessage } from '#surface/channels/discord'

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeChannel {
  sent: string[] = []
  typed = 0
  async send( content: string ){ this.sent.push( content ) }
  async sendTyping(){ this.typed++ }
}

class FakeClient implements DiscordLikeClient {
  user = { id: 'BOT' }
  channelsById = new Map<string, FakeChannel>()
  dmByUser = new Map<string, FakeChannel>()
  destroyed = false
  private handlers: Array<( m: DiscordLikeMessage ) => void> = []
  private reactionHandlers: Array<( r: never, u: never ) => void> = []

  on( e: 'messageCreate' | 'messageReactionAdd', fn: ( a: never, b: never ) => void ){
    if( e === 'messageReactionAdd' ) this.reactionHandlers.push( fn )
    else this.handlers.push( fn as unknown as ( m: DiscordLikeMessage ) => void )
  }

  /** Deliver a reaction. `partial` shapes exercise the fetch path Discord really uses. */
  react( reaction: Record<string, unknown>, user: Record<string, unknown> ): void {
    for( const fn of this.reactionHandlers ) fn( reaction as never, user as never )
  }
  once( _e: string, _fn: () => void ){ /* pre-logged-in fake — never fires */ }
  async login(){ return 'token' }
  destroy(){ this.destroyed = true }

  channels = { fetch: async ( id: string ) => {
    const c = this.channelsById.get( id )
    if( !c ) throw new Error('unknown channel')
    return c
  } }
  users = { fetch: async ( id: string ) => {
    const dm = this.dmByUser.get( id )
    if( !dm ) throw new Error('unknown user')
    return dm
  } }

  emit( m: Partial<DiscordLikeMessage> & { content: string; channelId: string } ): void {
    const channel = this.channelsById.get( m.channelId ) ?? new FakeChannel()
    this.channelsById.set( m.channelId, channel )
    const full: DiscordLikeMessage = {
      guildId: 'G', author: { id: 'U1', username: 'ada' },
      mentions: { has: () => false }, channel,
      ...m,
    }
    for( const fn of this.handlers ) fn( full )
  }
}

/** The slice of the Will facade the bridge touches, recorded. */
class FakeWill {
  id = 'aria'
  name = 'Aria'
  perceived: Stimulus[] = []
  private messageHandlers: Array<( m: WillMessage ) => void> = []
  async perceive( s: Stimulus ){ this.perceived.push( s ) }
  on( _e: 'message', fn: ( m: WillMessage ) => void ){ this.messageHandlers.push( fn ); return this }
  utter( m: WillMessage ){ for( const fn of this.messageHandlers ) fn( m ) }
}

const flush = () => new Promise( r => setTimeout( r, 0 ) )

let dir: string
beforeEach( () => { dir = mkdtempSync( join( tmpdir(), 'will-discord-') ) } )
afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

async function bridgeUp( opts: Partial<Parameters<typeof connectDiscord>[1]> = {} ){
  const client = new FakeClient()
  const will = new FakeWill()
  const bridge = await connectDiscord( will as unknown as Will, {
    client, rosterPath: join( dir, 'roster.json'), log: () => {}, ...opts,
  } )
  await bridge.start()
  return { client, will, bridge }
}

// ── inbound ──────────────────────────────────────────────────────────────────

describe('discord bridge — inbound', () => {
  it('maps a guild message onto perceive: stable entity id, learned speaker, per-channel thread', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'hello there', channelId: 'c1', author: { id: 'U1', username: 'ada' }, member: { displayName: 'Ada L.' } } )
    await flush()

    expect( will.perceived ).toHaveLength( 1 )
    expect( will.perceived[0] ).toMatchObject( {
      text: 'hello there', from: 'discord:U1', speaker: 'Ada L.', thread: 'discord:c1',
    } )
  } )

  it('never perceives bots or itself, and skips empty content', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'beep', channelId: 'c1', author: { id: 'B2', bot: true } } )
    client.emit( { content: 'echo', channelId: 'c1', author: { id: 'BOT' } } )
    client.emit( { content: '   ',  channelId: 'c1', author: { id: 'U1' } } )
    await flush()
    expect( will.perceived ).toHaveLength( 0 )
  } )

  it('honours the channel allowlist', async () => {
    const { client, will } = await bridgeUp( { channels: [ 'allowed' ] } )
    client.emit( { content: 'in-room', channelId: 'allowed' } )
    client.emit( { content: 'elsewhere', channelId: 'other' } )
    await flush()
    expect( will.perceived.map( s => s.text ) ).toEqual( [ 'in-room' ] )
  } )

  it('mentionOnly gates guild chatter but never DMs', async () => {
    const { client, will } = await bridgeUp( { mentionOnly: true } )
    client.emit( { content: 'ambient chatter', channelId: 'c1' } )
    client.emit( { content: 'hey @Aria', channelId: 'c1', mentions: { has: id => id === 'BOT' } } )
    client.emit( { content: 'psst', channelId: 'dm1', guildId: null } )
    await flush()
    expect( will.perceived.map( s => s.text ) ).toEqual( [ 'hey @Aria', 'psst' ] )
  } )

  it('sends a typing cue only when addressed — and typing is not a reply', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'ambient', channelId: 'c1' } )
    client.emit( { content: 'hey you', channelId: 'c1', mentions: { has: () => true } } )
    await flush()

    const channel = client.channelsById.get('c1')!
    expect( channel.typed ).toBe( 1 )
    expect( channel.sent ).toHaveLength( 0 )      // perceiving ≠ answering
    expect( will.perceived ).toHaveLength( 2 )    // ambient chatter is still perceived
  } )
} )

// ── outbound ─────────────────────────────────────────────────────────────────

describe('discord bridge — outbound', () => {
  it('routes an utterance to the addressee via their last shared channel', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'hi', channelId: 'c1', author: { id: 'U1', username: 'ada' } } )
    await flush()

    will.utter( { id: 'm1', content: 'hello Ada', to: 'discord:U1' } )
    await flush()
    expect( client.channelsById.get('c1')!.sent ).toEqual( [ 'hello Ada' ] )
  } )

  it('falls back to the DM when no shared channel is known (proactive reach)', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'psst', channelId: 'dm1', guildId: null, author: { id: 'U2', username: 'sam' } } )
    await flush()

    will.utter( { id: 'm2', content: 'thinking of you', to: 'discord:U2' } )
    await flush()
    expect( client.channelsById.get('dm1')!.sent ).toEqual( [ 'thinking of you' ] )
  } )

  it('uses the home channel for unknown addressees, else drops silently', async () => {
    const { client, will } = await bridgeUp( { homeChannelId: 'home' } )
    const home = new FakeChannel()
    client.channelsById.set('home', home )

    will.utter( { id: 'm3', content: 'is anyone there?', to: 'discord:GHOST' } )
    await flush()
    expect( home.sent ).toEqual( [ 'is anyone there?' ] )
  } )

  it('chunks long utterances under the 2000-char platform limit', async () => {
    const { client, will } = await bridgeUp()
    client.emit( { content: 'hi', channelId: 'c1', author: { id: 'U1' } } )
    await flush()

    will.utter( { id: 'm4', content: 'para one\n\n' + 'x'.repeat( 2500 ), to: 'discord:U1' } )
    await flush()
    const sent = client.channelsById.get('c1')!.sent
    expect( sent.length ).toBeGreaterThan( 1 )
    for( const chunk of sent ) expect( chunk.length ).toBeLessThanOrEqual( 2000 )
  } )

  it('waits for readiness without subscribing to the deprecated `ready` event', async () => {
    // A client that is not yet logged in: `user` is null until login resolves.
    const events: string[] = []
    let ready = false
    const client = {
      user: null as { id: string } | null,
      isReady: () => ready,
      on(){},
      once( e: string ){ events.push( e ) },
      async login(){ setTimeout( () => { ready = true; client.user = { id: 'BOT' } }, 10 ); return 'ok' },
      destroy(){},
      channels: { fetch: async () => { throw new Error('none') } },
      users:    { fetch: async () => { throw new Error('none') } },
    }
    const bridge = await connectDiscord( new FakeWill() as unknown as Will, {
      client: client as unknown as DiscordLikeClient, rosterPath: join( dir, 'r.json'), log: () => {},
    } )
    await bridge.start()                          // resolves via the isReady poll

    expect( events ).not.toContain('ready')     // the deprecated name is never subscribed
    expect( events ).toContain('clientReady')
  } )

  it('close() stops delivery and disconnects the client', async () => {
    const { client, will, bridge } = await bridgeUp()
    client.emit( { content: 'hi', channelId: 'c1', author: { id: 'U1' } } )
    await flush()

    await bridge.close()
    await bridge.close()                          // idempotent
    will.utter( { id: 'm5', content: 'too late', to: 'discord:U1' } )
    await flush()
    expect( client.channelsById.get('c1')!.sent ).toHaveLength( 0 )
    expect( client.destroyed ).toBe( true )
  } )
} )

// ── attachments ──────────────────────────────────────────────────────────────
//
// Discord manufactures these: a long pasted markdown block becomes a .md upload
// with an EMPTY content body. Such a message used to be dropped before
// perceive() — so the person appeared to have gone silent, which is far worse
// than a file the Will cannot read.

describe('discord bridge — attachments', () => {
  const cdn = ( name: string ) => `https://cdn.discordapp.com/attachments/1/2/${ name }`

  it('perceives an attachment-only message instead of dropping it', async () => {
    const { client, will } = await bridgeUp( { readAttachments: false } )
    client.emit( {
      content: '', channelId: 'c1', author: { id: 'U1' }, member: { displayName: 'Ada' },
      attachments: [ { name: 'ROADMAP.md', contentType: 'text/markdown', size: 8402, url: cdn('ROADMAP.md') } ],
    } )
    await flush()

    expect( will.perceived ).toHaveLength( 1 )
    expect( will.perceived[0]!.text ).toContain('ROADMAP.md')
    expect( will.perceived[0]!.text ).toContain('have not read')
    expect( will.perceived[0] ).toMatchObject( { from: 'discord:U1', speaker: 'Ada', thread: 'discord:c1' } )
  } )

  it('reads a text attachment from the CDN into the percept, alongside what was said', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ( async () => new Response('# Roadmap\nShip the thing.') ) as unknown as typeof fetch
    try {
      const { client, will } = await bridgeUp()
      client.emit( {
        content: 'here it is', channelId: 'c1', author: { id: 'U1' },
        attachments: [ { name: 'ROADMAP.md', contentType: 'text/markdown', size: 25, url: cdn('ROADMAP.md') } ],
      } )
      await flush()

      const text = will.perceived[0]!.text
      expect( text ).toContain('here it is')          // speech survives
      expect( text ).toContain('Ship the thing.')     // document is readable
      expect( text ).toContain('not something said to me')   // …and marked as handed over
    }
    finally { globalThis.fetch = original }
  } )

  it('refuses to fetch from any host but Discord\'s CDN — an inbound url is untrusted input', async () => {
    let called = 0
    const original = globalThis.fetch
    globalThis.fetch = ( async () => { called++; return new Response('pwned') } ) as unknown as typeof fetch
    try {
      const { client, will } = await bridgeUp()
      client.emit( {
        content: '', channelId: 'c1', author: { id: 'U1' },
        attachments: [ { name: 'notes.md', contentType: 'text/markdown', size: 5, url: 'https://evil.example/notes.md' } ],
      } )
      await flush()

      expect( called ).toBe( 0 )
      expect( will.perceived[0]!.text ).not.toContain('pwned')
      expect( will.perceived[0]!.text ).toContain('notes.md')
    }
    finally { globalThis.fetch = original }
  } )

  it('names a non-textual attachment without fetching it', async () => {
    let called = 0
    const original = globalThis.fetch
    globalThis.fetch = ( async () => { called++; return new Response('binary') } ) as unknown as typeof fetch
    try {
      const { client, will } = await bridgeUp()
      client.emit( {
        content: '', channelId: 'c1', author: { id: 'U1' },
        attachments: [ { name: 'diagram.png', contentType: 'image/png', size: 40_000, url: cdn('diagram.png') } ],
      } )
      await flush()

      expect( called ).toBe( 0 )
      expect( will.perceived[0]!.text ).toContain('diagram.png')
    }
    finally { globalThis.fetch = original }
  } )
} )

// A regression guard with teeth. The first cut of attachment support typed
// `attachments` as a bare Iterable and did `for..of` over it — correct for the
// array this fake used, WRONG for the discord.js Collection, which extends Map
// and therefore yields [id, attachment] pairs. Every field read `undefined`
// against the real client while all four tests above stayed green. So the shape
// that ships must be the shape under test.
describe('discord bridge — attachments arrive as a Map (the discord.js Collection shape)', () => {
  const asCollection = ( ...items: Array<Record<string, unknown>> ) =>
    new Map( items.map( ( a, i ) => [ `att-${ i }`, a ] ) )

  it('reads a Map-shaped attachment set, not its [key, value] pairs', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ( async () => new Response('# Integration\nDone: bridge. Stalled: rollout.') ) as unknown as typeof fetch
    try {
      const { client, will } = await bridgeUp()
      client.emit( {
        content: 'Here it is', channelId: 'c1', author: { id: 'U1' }, member: { displayName: 'Fabrice' },
        attachments: asCollection( {
          name: 'message.txt', contentType: 'text/plain; charset=utf-8', size: 6518,
          url: 'https://cdn.discordapp.com/attachments/1/2/message.txt',
        } ) as never,
      } )
      await flush()

      const text = will.perceived[0]!.text
      expect( text ).toContain('Here it is')
      expect( text ).toContain('message.txt')            // the NAME resolved, not undefined
      expect( text ).not.toContain('unnamed')
      expect( text ).toContain('Stalled: rollout.')      // and the body was actually fetched
    }
    finally { globalThis.fetch = original }
  } )

  it('still handles a plain array of attachments', async () => {
    const { client, will } = await bridgeUp( { readAttachments: false } )
    client.emit( {
      content: '', channelId: 'c1', author: { id: 'U1' },
      attachments: [ { name: 'notes.md', contentType: 'text/markdown', size: 12 } ],
    } )
    await flush()
    expect( will.perceived[0]!.text ).toContain('notes.md')
    expect( will.perceived[0]!.text ).not.toContain('unnamed')
  } )
} )

// ── channel scope + per-channel mention gating ──────────────────────────────

describe('discord bridge — where the Will is present', () => {
  const from = ( channelId: string ) => ( {
    content: 'anyone around?', channelId, author: { id: 'U1', username: 'ada' },
  } )

  it('an allowlist restrains it — a message elsewhere never becomes a percept', async () => {
    // This is not the Will choosing silence: the message is dropped at the bridge
    // and it never perceives anything. A private channel created in Discord and
    // granted to the bot still went unheard until its id was added here.
    const { client, will } = await bridgeUp({ channels: [ 'c1' ] })
    client.emit( from('c1') )
    client.emit( from('c2') )
    await flush()
    expect( will.perceived.map( p => p.thread ) ).toEqual( [ 'discord:c1' ] )
  } )

  it('"*" means everywhere — being added to a channel in Discord is enough', async () => {
    const { client, will } = await bridgeUp({ channels: [ '*' ] })
    client.emit( from('c1') )
    client.emit( from('c9') )
    await flush()
    expect( will.perceived ).toHaveLength( 2 )
  } )

  it('an unset list behaves like "*" — unchanged from before', async () => {
    const { client, will } = await bridgeUp({})
    client.emit( from('c7') )
    await flush()
    expect( will.perceived ).toHaveLength( 1 )
  } )

  it('mentionOnly:true gates every channel', async () => {
    const { client, will } = await bridgeUp({ mentionOnly: true })
    client.emit( from('c1') )
    client.emit( { ...from('c1'), mentions: { has: () => true } } )
    await flush()
    expect( will.perceived ).toHaveLength( 1 )
  } )

  it('mentionOnly as a LIST gates only those channels', async () => {
    // The combination that makes a wide-open roster liveable: present everywhere,
    // a quiet participant in the busy rooms.
    const { client, will } = await bridgeUp({ channels: [ '*' ], mentionOnly: [ 'busy' ] })

    client.emit( from('busy') )                                       // unaddressed → ignored
    client.emit( { ...from('busy'), mentions: { has: () => true } } )  // @mentioned → heard
    client.emit( from('quiet') )                                      // open channel → heard
    await flush()

    // Order is not the contract — arrival interleaves. What matters is WHICH.
    expect( will.perceived.map( p => p.thread ).sort() ).toEqual( [ 'discord:busy', 'discord:quiet' ] )
  } )

  it('a DM is always perceived, whatever the gating says', async () => {
    const { client, will } = await bridgeUp({ channels: [ 'c1' ], mentionOnly: true })
    client.emit( { ...from('dm1'), guildId: null } )
    await flush()
    expect( will.perceived ).toHaveLength( 1 )
  } )
} )

describe('discord env parsing', () => {
  it('reads "*" and blank as everywhere, a list as a restraint', () => {
    expect( parseChannels('*') ).toEqual( [ '*' ] )
    expect( parseChannels('') ).toBeUndefined()
    expect( parseChannels( undefined ) ).toBeUndefined()
    expect( parseChannels(' a , b ') ).toEqual( [ 'a', 'b' ] )
  } )

  it('reads mention-only as a boolean OR a channel list', () => {
    expect( parseMentionOnly('true') ).toBe( true )
    expect( parseMentionOnly('1') ).toBe( true )
    expect( parseMentionOnly('false') ).toBe( false )
    expect( parseMentionOnly('') ).toBe( false )
    expect( parseMentionOnly( undefined ) ).toBe( false )
    expect( parseMentionOnly('c1, c2') ).toEqual( [ 'c1', 'c2' ] )
  } )
} )

// ── reactions are answers ────────────────────────────────────────────────────

/**
 * A 👍 is the commonest acknowledgement on Discord and the mind read it as silence.
 *
 * `conversation.received` is written only from a text percept, so a reaction
 * produced no record: the turn it answered stayed open, the reply window elapsed,
 * and 0.9.0's machinery concluded — correctly, from what it could see — that the
 * message had been ignored. That verdict reaches reputation as reliability and
 * goals as absence of progress, so answering her with an emoji taught her that
 * person does not respond.
 */
describe('discord bridge — a reaction is an answer', () => {
  /** A reaction on one of the bot's own messages, with the shapes discord.js sends. */
  const onOwnMessage = ( over: Record<string, unknown> = {} ) => ( {
    emoji:   { name: '👍' },
    message: {
      channelId: 'c1', guildId: 'G', content: 'the meeting moved to 2pm',
      author: { id: 'BOT' },
      ...over,
    },
  } )

  it('perceives a reaction to something the Will said', async () => {
    const { client, will } = await bridgeUp()
    client.react( onOwnMessage(), { id: 'U1', username: 'ada', displayName: 'Ada L.' } )
    await flush()

    expect( will.perceived ).toHaveLength( 1 )
    const p = will.perceived[0]!
    // Same id space and thread as a spoken turn — this is what lets the answered
    // loop match it against the message it answers.
    expect( p.from ).toBe('discord:U1')
    expect( p.thread ).toBe('discord:c1')
    expect( p.speaker ).toBe('Ada L.')
  } )

  it('arrives described, not spoken — and quotes what was reacted to', async () => {
    const { client, will } = await bridgeUp()
    client.react( onOwnMessage(), { id: 'U1', displayName: 'Ada L.' } )
    await flush()

    const text = will.perceived[0]!.text!
    // Bracketed and first-person, the shape renderAttachments uses for a file:
    // it reached the mind through the conversation, but nobody SAID it, and a
    // percept that reads like speech invites answering words never spoken.
    expect( text.startsWith('[') ).toBe( true )
    expect( text ).toContain('reacted 👍')
    // Which thing was agreed with — an answer without its content is worse than none.
    expect( text ).toContain('the meeting moved to 2pm')
  } )

  it('ignores a reaction on somebody else\'s message — it answers nothing we said', async () => {
    const { client, will } = await bridgeUp()
    client.react( onOwnMessage( { author: { id: 'U2' } } ), { id: 'U1', username: 'ada' } )
    await flush()
    expect( will.perceived ).toHaveLength( 0 )
  } )

  it('ignores its own reaction, and other bots', async () => {
    const { client, will } = await bridgeUp()
    client.react( onOwnMessage(), { id: 'BOT', username: 'aria' } )
    client.react( onOwnMessage(), { id: 'U9', username: 'webhook', bot: true } )
    await flush()
    expect( will.perceived ).toHaveLength( 0 )
  } )

  it('fetches a partial reaction and a partial message before reading them', async () => {
    const { client, will } = await bridgeUp()
    let fetchedReaction = false, fetchedMessage = false

    // The NORMAL case for anything said before the last restart: Discord delivers
    // the event with almost every field empty. Reading through the hole yields an
    // author of `undefined`, which silently never matches the bot's own id — so
    // every reaction to a long-running conversation would be dropped.
    client.react( {
      partial: true,
      fetch: async () => {
        fetchedReaction = true
        return {
          emoji: { name: '✅' },
          message: {
            partial: true,
            fetch: async () => {
              fetchedMessage = true
              return { channelId: 'c1', guildId: 'G', content: 'shipped it', author: { id: 'BOT' } }
            },
          },
        }
      },
    }, { id: 'U1', displayName: 'Ada L.' } )
    await flush()

    expect( fetchedReaction, 'a partial reaction must be fetched').toBe( true )
    expect( fetchedMessage,  'a partial message must be fetched').toBe( true )
    expect( will.perceived ).toHaveLength( 1 )
    expect( will.perceived[0]!.text ).toContain('shipped it')
  } )

  it('carries `direct` so a DM reaction is not treated as public', async () => {
    const { client, will } = await bridgeUp()
    client.react( onOwnMessage( { guildId: null } ), { id: 'U1', displayName: 'Ada L.' } )
    await flush()
    expect( will.perceived[0]!.direct ).toBe( true )
  } )

  it('respects the channel allowlist', async () => {
    const { client, will } = await bridgeUp( { channels: [ 'c9' ] } )
    client.react( onOwnMessage(), { id: 'U1', username: 'ada' } )
    await flush()
    expect( will.perceived ).toHaveLength( 0 )
  } )
} )

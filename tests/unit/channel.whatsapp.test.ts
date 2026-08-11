// ─────────────────────────────────────────────────────────────
// tests/unit/channel.whatsapp.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * WhatsApp bridge — both directions of the paradigm over a fake socket:
 * inbound DM/group messages become perceive() stimuli (entity id from the
 * bare number, learned push name, per-chat thread), outbound utterances
 * route via the roster — with the WhatsApp-specific twist that a DM jid is
 * derivable from the entity id, so an unmet addressee is still reachable.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Will, Stimulus, WillMessage } from '#surface/sdk/will'
import { connectWhatsApp, type WaLikeSocket, type WaLikeMessage } from '#surface/channels/whatsapp'

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeSocket implements WaLikeSocket {
  user = { id: '490000:7@s.whatsapp.net', name: 'Aria' }
  sent = new Map<string, string[]>()
  composing: string[] = []
  ended = false
  failFor = new Set<string>()
  private handlers: Array<( u: { messages: WaLikeMessage[]; type?: string } ) => void> = []

  ev = { on: ( _e: 'messages.upsert', fn: ( u: { messages: WaLikeMessage[]; type?: string } ) => void ) => { this.handlers.push( fn ) } }

  async sendMessage( jid: string, content: { text: string } ){
    if( this.failFor.has( jid ) ) throw new Error('unroutable')
    const box = this.sent.get( jid ) ?? []
    box.push( content.text )
    this.sent.set( jid, box )
  }
  async sendPresenceUpdate( state: 'composing' | 'paused', jid?: string ){ if( state === 'composing' && jid ) this.composing.push( jid ) }
  end(){ this.ended = true }

  emit( m: WaLikeMessage, type = 'notify'): void {
    for( const fn of this.handlers ) fn( { messages: [ m ], type } )
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

const dm = ( from: string, text: string, name?: string ): WaLikeMessage => ( {
  key: { remoteJid: `${ from }@s.whatsapp.net`, fromMe: false },
  ...( name ? { pushName: name } : {} ),
  message: { conversation: text },
} )

const groupMsg = ( group: string, from: string, text: string, opts: { name?: string; mentions?: string[] } = {} ): WaLikeMessage => ( {
  key: { remoteJid: `${ group }@g.us`, fromMe: false, participant: `${ from }@s.whatsapp.net` },
  ...( opts.name ? { pushName: opts.name } : {} ),
  message: opts.mentions
    ? { extendedTextMessage: { text, contextInfo: { mentionedJid: opts.mentions } } }
    : { conversation: text },
} )

let dir: string
beforeEach( () => { dir = mkdtempSync( join( tmpdir(), 'will-wa-') ) } )
afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

async function bridgeUp( opts: Partial<Parameters<typeof connectWhatsApp>[1]> = {} ){
  const socket = new FakeSocket()
  const will = new FakeWill()
  const bridge = await connectWhatsApp( will as unknown as Will, {
    socket, rosterPath: join( dir, 'roster.json'), log: () => {}, ...opts,
  } )
  await bridge.start()
  return { socket, will, bridge }
}

// ── inbound ──────────────────────────────────────────────────────────────────

describe('whatsapp bridge — inbound', () => {
  it('maps a DM onto perceive: entity from the bare number, learned push name, per-chat thread', async () => {
    const { socket, will } = await bridgeUp()
    socket.emit( dm('4915551234', 'hallo', 'Ada L.') )
    await flush()

    expect( will.perceived ).toHaveLength( 1 )
    expect( will.perceived[0] ).toMatchObject( {
      text: 'hallo', from: 'whatsapp:4915551234', speaker: 'Ada L.', thread: 'whatsapp:4915551234@s.whatsapp.net',
    } )
  } )

  it('maps a group message to the sender (participant), not the group', async () => {
    const { socket, will } = await bridgeUp()
    socket.emit( groupMsg('12036302-1633', '4915551234', 'moin', { name: 'Ada' } ) )
    await flush()

    expect( will.perceived[0] ).toMatchObject( {
      from: 'whatsapp:4915551234', thread: 'whatsapp:12036302-1633@g.us',
    } )
  } )

  it('skips own, history-sync, stub, story, and empty messages', async () => {
    const { socket, will } = await bridgeUp()
    socket.emit( { key: { remoteJid: '1@s.whatsapp.net', fromMe: true }, message: { conversation: 'me' } } )
    socket.emit( dm('2', 'old'), 'append')
    socket.emit( { key: { remoteJid: '3@s.whatsapp.net', fromMe: false }, messageStubType: 1, message: { conversation: 'x' } } )
    socket.emit( { key: { remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'story' } } )
    socket.emit( dm('4', '   ') )
    await flush()
    expect( will.perceived ).toHaveLength( 0 )
  } )

  it('honours the chats allowlist', async () => {
    const { socket, will } = await bridgeUp( { chats: [ 'g1@g.us' ] } )
    socket.emit( groupMsg('g1', '111', 'in-room') )
    socket.emit( groupMsg('g2', '111', 'elsewhere') )
    await flush()
    expect( will.perceived.map( s => s.text ) ).toEqual( [ 'in-room' ] )
  } )

  it('mentionOnly gates group chatter (device suffix ignored) but never DMs', async () => {
    const { socket, will } = await bridgeUp( { mentionOnly: true } )
    socket.emit( groupMsg('g1', '111', 'ambient') )
    socket.emit( groupMsg('g1', '111', 'hey @aria', { mentions: [ '490000@s.whatsapp.net' ] } ) )
    socket.emit( dm('222', 'psst') )
    await flush()
    expect( will.perceived.map( s => s.text ) ).toEqual( [ 'hey @aria', 'psst' ] )
  } )

  it('sends a composing cue only when addressed — and composing is not a reply', async () => {
    const { socket, will } = await bridgeUp()
    socket.emit( groupMsg('g1', '111', 'ambient') )
    socket.emit( dm('222', 'direct') )
    await flush()

    expect( socket.composing ).toEqual( [ '222@s.whatsapp.net' ] )
    expect( socket.sent.size ).toBe( 0 )          // perceiving ≠ answering
    expect( will.perceived ).toHaveLength( 2 )    // ambient chatter is still perceived
  } )
} )

// ── outbound ─────────────────────────────────────────────────────────────────

describe('whatsapp bridge — outbound', () => {
  it('routes an utterance to the addressee via their last shared group', async () => {
    const { socket, will } = await bridgeUp()
    socket.emit( groupMsg('g1', '4915551234', 'hi', { name: 'Ada' } ) )
    await flush()

    will.utter( { id: 'm1', content: 'hello Ada', to: 'whatsapp:4915551234' } )
    await flush()
    expect( socket.sent.get('g1@g.us') ).toEqual( [ 'hello Ada' ] )
  } )

  it('derives the DM jid from the entity id — an unmet addressee is still reachable', async () => {
    const { socket, will } = await bridgeUp()

    will.utter( { id: 'm2', content: 'you do not know me yet', to: 'whatsapp:4915559999' } )
    await flush()
    expect( socket.sent.get('4915559999@s.whatsapp.net') ).toEqual( [ 'you do not know me yet' ] )
  } )

  it('falls through failed routes to the home chat', async () => {
    const { socket, will } = await bridgeUp( { homeChatId: 'home@g.us' } )
    socket.emit( groupMsg('g1', '111', 'hi') )
    await flush()

    socket.failFor.add('g1@g.us')
    socket.failFor.add('111@s.whatsapp.net')
    will.utter( { id: 'm3', content: 'anyone?', to: 'whatsapp:111' } )
    await flush()
    expect( socket.sent.get('home@g.us') ).toEqual( [ 'anyone?' ] )
  } )

  it('close() stops delivery and ends the socket, idempotently', async () => {
    const { socket, will, bridge } = await bridgeUp()
    socket.emit( dm('111', 'hi') )
    await flush()

    await bridge.close()
    await bridge.close()
    will.utter( { id: 'm4', content: 'too late', to: 'whatsapp:111' } )
    await flush()
    expect( socket.sent.size ).toBe( 0 )
    expect( socket.ended ).toBe( true )
  } )
} )

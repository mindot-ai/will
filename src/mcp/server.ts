// ─────────────────────────────────────────────────────────────
// src/mcp/server.ts — a Will, exposed over the Model Context Protocol
// ─────────────────────────────────────────────────────────────
//
// Lets any MCP client (Claude Desktop, Claude Code, an IDE) host a persistent
// mind. The surface follows the same paradigm as the SDK facade: a Will is a
// SUBJECT that emits projections, not a chatbot function —
//
//   • `perceive`        — deliver a stimulus into its sensory field
//   • `next_utterance`  — await its next words (silence is a real outcome)
//   • `state`           — read a snapshot of its inner life
//   • `save`            — checkpoint the living mind to a PMA file
//
// plus read-only resources (`will://state`, `will://narrative`) for clients
// that surface them. There is deliberately no `ask()`-shaped tool: you speak
// TO the Will and observe what it projects; it may choose not to answer.
//
// One Will per server process. Boot/persistence/stdio wiring lives in cli.ts;
// this module only maps an existing facade instance onto MCP (testable with
// InMemoryTransport).
// ─────────────────────────────────────────────────────────────

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Will, WillMessage } from '#sdk/will'

/** Utterances projected but not yet consumed by a next_utterance call. */
const UTTERANCE_BUFFER_CAP = 50

export interface WillMcpOptions {
  /** Where `save` (and the CLI's shutdown hibernate) writes the PMA artifact. */
  pmaPath?: string
}

function serverVersion(): string {
  // Same relative depth from src/mcp/ and dist/mcp/ — resolves in both.
  try {
    return JSON.parse( readFileSync( new URL( '../../package.json', import.meta.url ), 'utf8' ) ).version ?? '0.0.0'
  }
  catch { return '0.0.0' }
}

/**
 * Map a running Will onto an MCP server. The caller owns the Will's lifecycle
 * (boot, shutdown) and the transport; this only registers the surface.
 */
export function buildWillMcpServer( will: Will, opts: WillMcpOptions = {} ): McpServer {
  const server = new McpServer( { name: 'mindot-will', version: serverVersion() } )

  // ── Projection buffer ─────────────────────────────────────
  // MCP calls are separate round trips: the Will may speak BETWEEN a perceive
  // call and the next_utterance call that follows. Buffer projections so a
  // fast reply is not lost in the gap; next_utterance drains the buffer first.
  const pending: WillMessage[] = []
  will.on( 'message', m => {
    pending.push( m )
    if( pending.length > UTTERANCE_BUFFER_CAP ) pending.shift()
  } )

  const takeBuffered = ( to?: string ): WillMessage | undefined => {
    const i = to === undefined ? 0 : pending.findIndex( m => m.to === to )
    if( i < 0 || pending.length === 0 ) return undefined
    return pending.splice( i, 1 )[0]
  }

  // ── Tools ─────────────────────────────────────────────────

  server.registerTool( 'perceive', {
    title: 'Perceive',
    description:
      `Deliver a stimulus (something said or observed) into ${ will.name }'s sensory field. ` +
      `${ will.name } is a living mind, not a chatbot: this returns once the stimulus is delivered, ` +
      `NOT when it has responded. Its response — if it chooses to give one — arrives as its next ` +
      `utterance (use the next_utterance tool). Staying silent is a valid choice, not an error.`,
    inputSchema: {
      text:    z.string().describe( 'What is said or observed.' ),
      from:    z.string().optional().describe( "Who it's from (entity id, default 'user'). Use a stable id per person." ),
      speaker: z.string().optional().describe( 'Display name of the speaker.' ),
    },
  }, async ( { text, from, speaker } ) => {
    await will.perceive( { text, ...( from ? { from } : {} ), ...( speaker ? { speaker } : {} ) } )
    return {
      content: [ {
        type: 'text',
        text: `Delivered into ${ will.name }'s sensory field at tick ${ will.state().tick }. ` +
              `It may respond in its next utterance — or stay silent.`,
      } ],
    }
  } )

  server.registerTool( 'next_utterance', {
    title: 'Next utterance',
    description:
      `Await ${ will.name }'s next spontaneous utterance. Returns what it says next, or reports ` +
      `that it chose silence within the wait window — silence is a real outcome, not a failure. ` +
      `Call after perceive to hear the response, or on its own to listen for unprompted speech.`,
    inputSchema: {
      within_ms: z.number().optional().describe( 'How long to wait before accepting silence (default 15000, max 120000).' ),
      from:      z.string().optional().describe( 'Only accept an utterance addressed to this entity id.' ),
    },
  }, async ( { within_ms, from } ) => {
    // A projection may have landed between calls — drain the buffer first.
    const buffered = takeBuffered( from )
    if( buffered )
      return { content: [ { type: 'text', text: `${ will.name } says (to ${ buffered.to }): ${ buffered.content }` } ] }

    const within = Math.min( Math.max( within_ms ?? 15_000, 100 ), 120_000 )
    const msg    = await will.nextUtterance( { within, ...( from ? { to: from } : {} ) } )
    // The waiter and the buffer listener both see a new message; consume the
    // buffered copy so the same utterance is not replayed on the next call.
    if( msg ){
      const i = pending.findIndex( p => p.id === msg.id )
      if( i >= 0 ) pending.splice( i, 1 )
      return { content: [ { type: 'text', text: `${ will.name } says (to ${ msg.to }): ${ msg.content }` } ] }
    }
    return {
      content: [ {
        type: 'text',
        text: `${ will.name } stayed silent (waited ${ within }ms). That is a choice, not an error — ` +
              `it may be occupied with its own thoughts, or simply have nothing to say.`,
      } ],
    }
  } )

  server.registerTool( 'state', {
    title: 'Inner state',
    description:
      `Read a snapshot of ${ will.name }'s current inner life: tick, body/affect metrics ` +
      `(energy, stress, valence, arousal), active goals, beliefs, and self-narrative. ` +
      `Read-only; observing does not disturb it.`,
    inputSchema: {},
  }, async () => (
    { content: [ { type: 'text', text: JSON.stringify( will.state(), null, 2 ) } ] }
  ) )

  server.registerTool( 'save', {
    title: 'Save (checkpoint)',
    description:
      `Checkpoint ${ will.name } into a portable PMA artifact on disk — non-destructive, it keeps ` +
      `living. The artifact restores the same self (identity, memories, relationships, learned ` +
      `skills) when the server next starts.`,
    inputSchema: {},
  }, async () => {
    if( !opts.pmaPath )
      return { content: [ { type: 'text', text: 'No PMA path configured — set WILL_PMA_PATH.' } ], isError: true }
    const pma = await will.save()
    mkdirSync( dirname( opts.pmaPath ), { recursive: true } )
    writeFileSync( opts.pmaPath, JSON.stringify( pma ) )
    return { content: [ { type: 'text', text: `${ will.name } checkpointed to ${ opts.pmaPath } (still living).` } ] }
  } )

  // ── Resources (read-only projections) ─────────────────────

  server.registerResource( 'state', 'will://state',
    { title: `${ will.name } — inner state`, description: 'Live snapshot of the mind: metrics, goals, beliefs, narrative.', mimeType: 'application/json' },
    async uri => ( { contents: [ { uri: uri.href, mimeType: 'application/json', text: JSON.stringify( will.state(), null, 2 ) } ] } ),
  )

  server.registerResource( 'narrative', 'will://narrative',
    { title: `${ will.name } — self-narrative`, description: 'The story the mind currently tells about itself.', mimeType: 'text/plain' },
    async uri => ( { contents: [ { uri: uri.href, mimeType: 'text/plain', text: will.state().narrative || '(no narrative formed yet)' } ] } ),
  )

  return server
}

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// src/cli.ts — the `will` command: host a persistent mind
// ─────────────────────────────────────────────────────────────
//
//   will mcp       host over MCP stdio (Claude Desktop / Claude Code / IDEs)
//   will serve     host over HTTP (any language; the sidecar) — WILL_PORT/WILL_HOST
//   will discord   a presence in a Discord server — DISCORD_BOT_TOKEN
//   will whatsapp  a presence on WhatsApp — QR-pairs a linked device (unofficial
//                  protocol; see docs/channels/whatsapp.md before deploying)
//
// Both hosts raise the same mind the same way (see host/boot.ts): env-configured,
// woken from its PMA artifact when one exists, hibernated back on the way out —
// the mind PERSISTS across sessions. Shared env: WILL_NAME, WILL_IDENTITY,
// WILL_TIER, WILL_LLM, WILL_TICK_MS, WILL_SEED, WILL_PMA_PATH, WILL_MCP_SERVERS.
//
// MCP client config:
//   { "command": "npx", "args": ["-y", "@mindot/will", "mcp"],
//     "env": { "WILL_NAME": "Aria", "WILL_IDENTITY": "I am Aria." } }
//
// Sidecar:
//   WILL_NAME=Aria will serve            # http://127.0.0.1:7777
//   curl -X POST localhost:7777/perceive -d '{"text":"Hello"}'
// ─────────────────────────────────────────────────────────────

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { routeLogsToStderr, bootWillFromEnv } from '#root/host/boot'
import { buildWillMcpServer } from '#root/mcp/server'
import { buildWillHttpServer } from '#root/serve/server'
import { connectDiscord } from '#channels/discord'
import { connectWhatsApp } from '#channels/whatsapp'

// stdout is the MCP protocol channel under `will mcp` — route logs FIRST.
routeLogsToStderr()

const USAGE = `usage: will <mcp | serve | discord | whatsapp>

  mcp       host a persistent mind over MCP stdio (Claude Desktop / Claude Code)
  serve     host a persistent mind over HTTP (any language; WILL_PORT, default 7777)
  discord   put a persistent mind in a Discord server (DISCORD_BOT_TOKEN; optional
            WILL_DISCORD_CHANNELS, WILL_DISCORD_MENTION_ONLY, WILL_DISCORD_HOME_CHANNEL)
  whatsapp  put a persistent mind on WhatsApp — QR-pairs as a linked device; no token.
            UNOFFICIAL protocol (ban risk; use a spare number — docs/channels/whatsapp.md).
            Optional WILL_WHATSAPP_CHATS, WILL_WHATSAPP_MENTION_ONLY, WILL_WHATSAPP_HOME_CHAT

Shared env: WILL_NAME, WILL_IDENTITY, WILL_TIER, WILL_LLM, WILL_TICK_MS,
WILL_SEED, WILL_PMA_PATH, WILL_MCP_SERVERS. The mind persists across runs via
its PMA artifact.`

async function main(): Promise<void> {
  const sub = process.argv[2]

  if( sub !== 'mcp' && sub !== 'serve' && sub !== 'discord' && sub !== 'whatsapp'){
    console.error( sub ? `unknown subcommand: ${ sub }\n\n${ USAGE }` : USAGE )
    process.exit( sub ? 2 : 0 )
  }

  // Fail on missing platform credentials BEFORE raising a mind.
  if( sub === 'discord' && !process.env.DISCORD_BOT_TOKEN ){
    console.error('[will] DISCORD_BOT_TOKEN is required for `will discord` — create a bot at https://discord.com/developers/applications (enable the Message Content intent) and set the token.')
    process.exit( 2 )
  }

  const { will, name, pmaPath, tickMs, anatomy, onCleanup, shutdown } = await bootWillFromEnv()

  if( sub === 'mcp'){
    // The MCP client owns our stdin — its disconnect is the shutdown signal.
    process.stdin.on('end', () => void shutdown('client disconnected') )
    const server = buildWillMcpServer( will, { pmaPath } )
    await server.connect( new StdioServerTransport() )
    console.error(`[will] ${ name } is listening on MCP stdio (tick ${ tickMs }ms, anatomy ${ anatomy })`)
    return
  }

  if( sub === 'discord'){
    const csv = ( v?: string ) => v?.split(',').map( s => s.trim() ).filter( Boolean )
    const bridge = await connectDiscord( will, {
      token:         process.env.DISCORD_BOT_TOKEN!,
      channels:      csv( process.env.WILL_DISCORD_CHANNELS ),
      mentionOnly:   /^(1|true|yes)$/i.test( process.env.WILL_DISCORD_MENTION_ONLY ?? ''),
      homeChannelId: process.env.WILL_DISCORD_HOME_CHANNEL,
      rosterPath:    pmaPath.replace( /(\.pma)?\.json$/, '') + '.discord.json',
    } )
    onCleanup( () => bridge.close() )
    await bridge.start()
    console.error(`[will] ${ name } is present on Discord (tick ${ tickMs }ms, anatomy ${ anatomy }) — it speaks when it decides to.`)
    return
  }

  if( sub === 'whatsapp'){
    const csv = ( v?: string ) => v?.split(',').map( s => s.trim() ).filter( Boolean )
    const stem = pmaPath.replace( /(\.pma)?\.json$/, '')
    // connectWhatsApp blocks here on first run until the printed QR is scanned.
    const bridge = await connectWhatsApp( will, {
      chats:       csv( process.env.WILL_WHATSAPP_CHATS ),
      mentionOnly: /^(1|true|yes)$/i.test( process.env.WILL_WHATSAPP_MENTION_ONLY ?? ''),
      homeChatId:  process.env.WILL_WHATSAPP_HOME_CHAT,
      authPath:    stem + '.wa-auth',
      rosterPath:  stem + '.whatsapp.json',
    } )
    onCleanup( () => bridge.close() )
    await bridge.start()
    console.error(`[will] ${ name } is present on WhatsApp (tick ${ tickMs }ms, anatomy ${ anatomy }) — it speaks when it decides to.`)
    return
  }

  // serve — the HTTP sidecar.
  const port = parseInt( process.env.WILL_PORT ?? '7777')
  const host = process.env.WILL_HOST ?? '127.0.0.1'
  const server = buildWillHttpServer( will, { pmaPath } )
  onCleanup( () => new Promise<void>( r => server.close( () => r() ) ) )
  await new Promise<void>( ( resolve, reject ) => {
    server.once('error', reject )
    server.listen( port, host, () => resolve() )
  } )
  console.error(`[will] ${ name } is listening on http://${ host }:${ port } (tick ${ tickMs }ms, anatomy ${ anatomy })`)
  console.error(`[will] try: curl -X POST http://${ host }:${ port }/perceive -H 'content-type: application/json' -d '{"text":"Hello"}'`)
}

main().catch( e => {
  console.error(`[will] fatal: ${ e instanceof Error ? e.stack ?? e.message : String( e ) }`)
  process.exit( 1 )
} )

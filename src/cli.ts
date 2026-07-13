#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// src/cli.ts — the `will` command: host a persistent mind
// ─────────────────────────────────────────────────────────────
//
//   will mcp     host over MCP stdio (Claude Desktop / Claude Code / IDEs)
//   will serve   host over HTTP (any language; the sidecar) — WILL_PORT/WILL_HOST
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

// stdout is the MCP protocol channel under `will mcp` — route logs FIRST.
routeLogsToStderr()

const USAGE = `usage: will <mcp | serve>

  mcp     host a persistent mind over MCP stdio (Claude Desktop / Claude Code)
  serve   host a persistent mind over HTTP (any language; WILL_PORT, default 7777)

Shared env: WILL_NAME, WILL_IDENTITY, WILL_TIER, WILL_LLM, WILL_TICK_MS,
WILL_SEED, WILL_PMA_PATH, WILL_MCP_SERVERS. The mind persists across runs via
its PMA artifact.`

async function main(): Promise<void> {
  const sub = process.argv[2]

  if( sub !== 'mcp' && sub !== 'serve' ){
    console.error( sub ? `unknown subcommand: ${ sub }\n\n${ USAGE }` : USAGE )
    process.exit( sub ? 2 : 0 )
  }

  const { will, name, pmaPath, tickMs, anatomy, onCleanup, shutdown } = await bootWillFromEnv()

  if( sub === 'mcp' ){
    // The MCP client owns our stdin — its disconnect is the shutdown signal.
    process.stdin.on( 'end', () => void shutdown( 'client disconnected' ) )
    const server = buildWillMcpServer( will, { pmaPath } )
    await server.connect( new StdioServerTransport() )
    console.error( `[will] ${ name } is listening on MCP stdio (tick ${ tickMs }ms, anatomy ${ anatomy })` )
    return
  }

  // serve — the HTTP sidecar.
  const port = parseInt( process.env.WILL_PORT ?? '7777' )
  const host = process.env.WILL_HOST ?? '127.0.0.1'
  const server = buildWillHttpServer( will, { pmaPath } )
  onCleanup( () => new Promise<void>( r => server.close( () => r() ) ) )
  await new Promise<void>( ( resolve, reject ) => {
    server.once( 'error', reject )
    server.listen( port, host, () => resolve() )
  } )
  console.error( `[will] ${ name } is listening on http://${ host }:${ port } (tick ${ tickMs }ms, anatomy ${ anatomy })` )
  console.error( `[will] try: curl -X POST http://${ host }:${ port }/perceive -H 'content-type: application/json' -d '{"text":"Hello"}'` )
}

main().catch( e => {
  console.error( `[will] fatal: ${ e instanceof Error ? e.stack ?? e.message : String( e ) }` )
  process.exit( 1 )
} )

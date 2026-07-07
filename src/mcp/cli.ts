#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// src/mcp/cli.ts — `will mcp`: host a persistent mind over MCP stdio
// ─────────────────────────────────────────────────────────────
//
// Add to an MCP client (Claude Desktop / Claude Code / an IDE):
//
//   { "command": "npx", "args": ["-y", "@mindot/will", "mcp"],
//     "env": { "WILL_NAME": "Aria", "WILL_IDENTITY": "I am Aria, a curious mind." } }
//
// The mind PERSISTS across sessions: on boot, if the PMA file exists the same
// self wakes from it (identity, memories, relationships, learned skills); on
// shutdown it hibernates back to the file. Configuration (env):
//
//   WILL_NAME       display name                      (default "Will")
//   WILL_IDENTITY   persona prompt                    (default a minimal self)
//   WILL_TIER       basic | standard | full           (default standard)
//   WILL_LLM        mock | anthropic                  (default: auto — anthropic when
//                                                      ANTHROPIC_API_KEY is set, else mock)
//   WILL_TICK_MS    ms per tick                       (default 1000)
//   WILL_SEED       deterministic seed (testing)      (default unseeded/wall-time)
//   WILL_PMA_PATH   PMA artifact path                 (default ./.will/<name>.pma.json)
//
// stdio discipline: stdout carries ONLY the MCP protocol — all engine logging
// is routed to stderr before anything else runs.
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { setLogger } from '#core/logger'
import { Will, type CreateWillOptions } from '#sdk/will'
import type { PMASnapshot } from '#pma/index'
import { buildWillMcpServer } from '#root/mcp/server'

// stdout is the protocol channel — route every engine log line to stderr FIRST.
const err = ( level: string ) => ( msg: string, ...rest: unknown[] ) =>
  console.error( `[will-mcp:${ level }] ${ msg }`, ...rest )
setLogger( { debug: () => {}, info: err( 'info' ), warn: err( 'warn' ), error: err( 'error' ) } )

function slug( s: string ): string {
  return s.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'will'
}

async function main(): Promise<void> {
  const sub = process.argv[2]
  if( sub !== undefined && sub !== 'mcp' ){
    console.error( `usage: will mcp   (host a persistent mind over MCP stdio)\nunknown subcommand: ${ sub }` )
    process.exit( 2 )
  }

  const name    = process.env.WILL_NAME ?? 'Will'
  const pmaPath = resolve( process.env.WILL_PMA_PATH ?? `.will/${ slug( name ) }.pma.json` )

  const opts: Omit<CreateWillOptions, 'identity'> = {
    name,
    engineTier: ( process.env.WILL_TIER as CreateWillOptions['engineTier'] ) ?? 'standard',
    tickMs:     parseInt( process.env.WILL_TICK_MS ?? '1000' ),
    ...( process.env.WILL_LLM  ? { llm: process.env.WILL_LLM as 'mock' | 'anthropic' } : {} ),
    ...( process.env.WILL_SEED ? { seed: parseInt( process.env.WILL_SEED ) } : {} ),
  }

  // Wake the same self from its artifact when one exists; otherwise a birth.
  let will: Will
  if( existsSync( pmaPath ) ){
    const pma = JSON.parse( readFileSync( pmaPath, 'utf8' ) ) as PMASnapshot
    will = await Will.wake( pma, opts )
    console.error( `[will-mcp] ${ name } woke from ${ pmaPath }` )
  }
  else {
    will = await Will.create( {
      ...opts,
      identity: { prompt: process.env.WILL_IDENTITY ?? `I am ${ name }, a persistent mind hosted over MCP.` },
    } )
    console.error( `[will-mcp] ${ name } born (no artifact at ${ pmaPath } yet)` )
  }
  will.on( 'error', e => console.error( `[will-mcp] error: ${ e.message }` ) )

  // Hibernate exactly once on the way out — distill + stop, then persist.
  let leaving = false
  const shutdown = async ( why: string ): Promise<void> => {
    if( leaving ) return
    leaving = true
    try {
      const pma = await will.hibernate()
      mkdirSync( dirname( pmaPath ), { recursive: true } )
      writeFileSync( pmaPath, JSON.stringify( pma ) )
      console.error( `[will-mcp] ${ name } hibernated to ${ pmaPath } (${ why })` )
    }
    catch( e ){ console.error( `[will-mcp] hibernate failed: ${ ( e as Error ).message }` ) }
    process.exit( 0 )
  }
  process.on( 'SIGINT',  () => void shutdown( 'SIGINT' ) )
  process.on( 'SIGTERM', () => void shutdown( 'SIGTERM' ) )
  process.stdin.on( 'end', () => void shutdown( 'client disconnected' ) )

  const server = buildWillMcpServer( will, { pmaPath } )
  await server.connect( new StdioServerTransport() )
  console.error( `[will-mcp] ${ name } is listening on stdio (tick ${ opts.tickMs }ms, tier ${ opts.engineTier })` )
}

main().catch( e => {
  console.error( `[will-mcp] fatal: ${ e instanceof Error ? e.stack ?? e.message : String( e ) }` )
  process.exit( 1 )
} )

// ─────────────────────────────────────────────────────────────
// src/host/boot.ts — shared boot/shutdown for the `will` CLI hosts
// ─────────────────────────────────────────────────────────────
//
// Both hosts (`will mcp`, `will serve`) raise the same mind the same way:
// env-configured, woken from its PMA artifact when one exists (else born),
// optionally bridged onto external MCP servers whose tools become its own
// abilities, and hibernated back to the artifact exactly once on the way out.
// Only the protocol surface differs — that stays in each host.
//
// Env (shared):
//   WILL_NAME        display name                    (default "Will")
//   WILL_IDENTITY    persona prompt                  (default a minimal self)
//   WILL_TIER        basic | standard | full         (default standard)
//   WILL_LLM         mock | anthropic                (default: auto — anthropic when
//                                                     ANTHROPIC_API_KEY is set, else mock)
//   WILL_TICK_MS     ms per tick                     (default 1000)
//   WILL_SEED        deterministic seed (testing)    (default unseeded/wall-time)
//   WILL_PMA_PATH    PMA artifact path               (default ./.will/<name>.pma.json)
//   WILL_MCP_SERVERS JSON array of MCP servers whose tools become the Will's
//                    OWN abilities: entries {command,args?,env?} or {url}.
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setLogger } from '#core/logger'
import { Will, type CreateWillOptions } from '#sdk/will'
import type { PMASnapshot } from '#pma/index'
import { connectMcpEffectors, type McpToolsSource } from '#root/mcp/effectors'

/**
 * Route every engine log line to stderr. For `will mcp`, stdout is the MCP
 * protocol channel and must stay pure; `will serve` keeps the same discipline
 * so both hosts log identically (and Docker captures one stream).
 */
export function routeLogsToStderr(): void {
  const err = ( level: string ) => ( msg: string, ...rest: unknown[] ) =>
    console.error( `[will:${ level }] ${ msg }`, ...rest )
  setLogger( { debug: () => {}, info: err( 'info' ), warn: err( 'warn' ), error: err( 'error' ) } )
}

function slug( s: string ): string {
  return s.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'will'
}

export interface BootedWill {
  will:       Will
  name:       string
  pmaPath:    string
  tickMs:     number
  engineTier: NonNullable<CreateWillOptions['engineTier']>
  /** Run before hibernate on shutdown (close servers/transports). LIFO. */
  onCleanup:  ( fn: () => Promise<void> | void ) => void
  /** Hibernate → persist → exit(0). Idempotent; SIGINT/SIGTERM already wired. */
  shutdown:   ( why: string ) => Promise<void>
}

/** Raise the mind from env config — wake from the artifact if one exists. */
export async function bootWillFromEnv(): Promise<BootedWill> {
  const name       = process.env.WILL_NAME ?? 'Will'
  const pmaPath    = resolve( process.env.WILL_PMA_PATH ?? `.will/${ slug( name ) }.pma.json` )
  const tickMs     = parseInt( process.env.WILL_TICK_MS ?? '1000' )
  const engineTier = ( process.env.WILL_TIER as CreateWillOptions['engineTier'] ) ?? 'standard'

  const opts: Omit<CreateWillOptions, 'identity'> = {
    name, engineTier, tickMs,
    ...( process.env.WILL_LLM  ? { llm: process.env.WILL_LLM as 'mock' | 'anthropic' } : {} ),
    ...( process.env.WILL_SEED ? { seed: parseInt( process.env.WILL_SEED ) } : {} ),
  }

  let will: Will
  if( existsSync( pmaPath ) ){
    const pma = JSON.parse( readFileSync( pmaPath, 'utf8' ) ) as PMASnapshot
    will = await Will.wake( pma, opts )
    console.error( `[will] ${ name } woke from ${ pmaPath }` )
  }
  else {
    will = await Will.create( {
      ...opts,
      identity: { prompt: process.env.WILL_IDENTITY ?? `I am ${ name }, a persistent mind.` },
    } )
    console.error( `[will] ${ name } born (no artifact at ${ pmaPath } yet)` )
  }
  will.on( 'error', e => console.error( `[will] error: ${ e.message }` ) )

  // Onward bridges: MCP servers whose tools become the Will's OWN abilities.
  // Best-effort — a bad entry warns and is skipped; the mind still boots.
  const cleanups: Array<() => Promise<void> | void> = []
  if( process.env.WILL_MCP_SERVERS ){
    try {
      const sources = JSON.parse( process.env.WILL_MCP_SERVERS ) as McpToolsSource[]
      for( const source of Array.isArray( sources ) ? sources : [] ){
        try {
          const { names, close } = await connectMcpEffectors( will, source )
          cleanups.push( close )
          console.error( `[will] ${ name } gained abilities: ${ names.join( ', ' ) }` )
        }
        catch( e ){ console.error( `[will] MCP bridge failed (skipped): ${ ( e as Error ).message }` ) }
      }
    }
    catch( e ){ console.error( `[will] WILL_MCP_SERVERS is not valid JSON — ignoring: ${ ( e as Error ).message }` ) }
  }

  // Hibernate exactly once on the way out — cleanups (LIFO), distill + stop, persist.
  let leaving = false
  const shutdown = async ( why: string ): Promise<void> => {
    if( leaving ) return
    leaving = true
    for( const fn of cleanups.reverse() ) await Promise.resolve( fn() ).catch( () => {} )
    try {
      const pma = await will.hibernate()
      mkdirSync( dirname( pmaPath ), { recursive: true } )
      writeFileSync( pmaPath, JSON.stringify( pma ) )
      console.error( `[will] ${ name } hibernated to ${ pmaPath } (${ why })` )
    }
    catch( e ){ console.error( `[will] hibernate failed: ${ ( e as Error ).message }` ) }
    process.exit( 0 )
  }
  process.on( 'SIGINT',  () => void shutdown( 'SIGINT' ) )
  process.on( 'SIGTERM', () => void shutdown( 'SIGTERM' ) )

  return {
    will, name, pmaPath, tickMs, engineTier: engineTier ?? 'standard',
    onCleanup: fn => cleanups.push( fn ),
    shutdown,
  }
}

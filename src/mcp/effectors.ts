// ─────────────────────────────────────────────────────────────
// src/mcp/effectors.ts — a Will EMPLOYING MCP tools (Seam 1)
// ─────────────────────────────────────────────────────────────
//
// The other direction from server.ts: connect a Will to an external MCP server
// and register that server's tools as the Will's own ABILITIES. Each tool
// becomes a learnable affordance — its description (plus a compact hint of the
// arguments it takes) is the ability's meaning, surfaced to the executive and
// the deliberator; the WILL decides when to enact one (nothing here dispatches);
// the tool's result feeds back through reafference, so the Will gets *skilled*
// at the tools it uses.
//
// Arguments come from conscious intent: the executive supplies them via an
// action's `args`, which ride the ideomotor leg into the invocation (see
// executive commands.ts). A tool with required arguments enacted habitually
// (without args) fails informatively — reafference then teaches the Will that
// this ability wants deliberate articulation.
//
//   const { names, close } = await connectMcpEffectors( will, {
//     command: 'npx', args: [ '-y', '@modelcontextprotocol/server-filesystem', '/tmp' ],
//   } )
//
// Import from '@mindot/will/mcp' — kept off the main entry so non-MCP
// consumers never load the MCP SDK.
// ─────────────────────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Will, EffectorHandler, EffectorResult } from '#sdk/will'

/** Where the tools live: spawn a local server, reach a remote one, or bring a connected client. */
export type McpToolsSource =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string }
  | { client: Client }

export interface McpEffectorsOptions {
  /** Intrinsic effort prior 0..1 seeded on every bridged ability (default 0.2). */
  cost?: number
  /** Prefix for the ability names (e.g. 'fs_') — avoids collisions across servers. */
  prefix?: string
}

/** Minimal structural view of an MCP tool (the SDK's zod-inferred type, loosened). */
export interface McpToolInfo {
  name:         string
  description?: string
  inputSchema?: {
    type?:       string
    properties?: Record<string, { type?: string; description?: string }>
    required?:   string[]
  }
}

/** Keep tool outcomes bounded — the description feeds reafference + episodic memory. */
const RESULT_DESCRIPTION_CAP = 700
/** Keep ability meanings bounded — they render into the executive prompt. */
const MEANING_CAP = 300

/**
 * The ability's *meaning*: the tool's description plus a compact hint of the
 * arguments it takes — so the executive knows what to supply in an action's
 * `args` when it enacts this ability.
 */
export function describeMcpTool( tool: McpToolInfo ): string {
  const props    = tool.inputSchema?.properties ?? {}
  const required = new Set( tool.inputSchema?.required ?? [] )
  const argHints = Object.entries( props ).map( ( [ key, p ] ) =>
    `${ key }${ required.has( key ) ? '' : '?' }${ p.description ? `: ${ p.description }` : '' }` )

  const base = ( tool.description ?? `The ${ tool.name } tool.` ).trim().replace( /\s+/g, ' ' )
  const hint = argHints.length > 0 ? ` (args — ${ argHints.join( '; ' ) })` : ''
  const full = `${ base }${ hint }`
  return full.length > MEANING_CAP ? `${ full.slice( 0, MEANING_CAP - 1 ) }…` : full
}

/**
 * The effector handler for one bridged tool: checks required args (an ability
 * enacted without its needed articulation fails informatively — reafference
 * learns from it), calls the tool, and maps the result onto EffectorResult.
 */
export function buildMcpHandler( client: Client, tool: McpToolInfo ): EffectorHandler {
  return async ( args ): Promise<EffectorResult> => {
    const props = tool.inputSchema?.properties
    // Only pass keys the tool declares — invocation params can carry situation
    // extras (targetEntityName, learned priors) the tool never asked for.
    const filtered: Record<string, unknown> = {}
    for( const [ k, v ] of Object.entries( args ?? {} ) )
      if( !props || k in props ) filtered[ k ] = v

    const missing = ( tool.inputSchema?.required ?? [] ).filter(
      k => filtered[ k ] === undefined || filtered[ k ] === '' )
    if( missing.length > 0 )
      return {
        success: false,
        description: `${ tool.name } needs ${ missing.join( ', ' ) } — enact it deliberately, supplying them in the action's args.`,
      }

    try {
      const res  = await client.callTool( { name: tool.name, arguments: filtered } ) as
        { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      const text = ( res.content ?? [] )
        .filter( c => c.type === 'text' && typeof c.text === 'string' )
        .map( c => c.text as string )
        .join( '\n' )
        .trim() || ( res.isError ? 'The tool reported an error.' : 'Done (no output).' )
      const bounded = text.length > RESULT_DESCRIPTION_CAP ? `${ text.slice( 0, RESULT_DESCRIPTION_CAP - 1 ) }…` : text
      return { success: !res.isError, description: bounded }
    }
    catch( err ){
      return { success: false, description: `${ tool.name } failed: ${ err instanceof Error ? err.message : String( err ) }` }
    }
  }
}

async function connect( source: McpToolsSource ): Promise<{ client: Client; owned: boolean }> {
  if( 'client' in source ) return { client: source.client, owned: false }

  const client = new Client( { name: 'mindot-will', version: '0' } )
  if( 'url' in source )
    await client.connect( new StreamableHTTPClientTransport( new URL( source.url ) ) )
  else
    await client.connect( new StdioClientTransport( {
      command: source.command,
      ...( source.args ? { args: source.args } : {} ),
      // Merge over the SDK's safe default env so PATH etc. survive a custom env.
      env: { ...getDefaultEnvironment(), ...( source.env ?? {} ) },
    } ) )
  return { client, owned: true }
}

/**
 * Register an MCP server's tools as the Will's abilities. Returns the ability
 * names registered and a `close()` for the connection (call it when the Will
 * stops; a client passed in via `source.client` is left open).
 */
export async function connectMcpEffectors(
  will:   Will,
  source: McpToolsSource,
  opts:   McpEffectorsOptions = {},
): Promise<{ names: string[]; close: () => Promise<void> }> {
  const { client, owned } = await connect( source )
  const { tools } = await client.listTools() as unknown as { tools: McpToolInfo[] }

  const names: string[] = []
  for( const tool of tools ){
    const name = `${ opts.prefix ?? '' }${ tool.name }`
    will.effector( name, {
      description: describeMcpTool( tool ),
      cost:        opts.cost ?? 0.2,
      tags:        [ 'mcp' ],
      handler:     buildMcpHandler( client, tool ),
    } )
    names.push( name )
  }

  return { names, close: async () => { if( owned ) await client.close() } }
}

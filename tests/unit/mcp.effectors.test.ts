// ─────────────────────────────────────────────────────────────
// tests/unit/mcp.effectors.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Seam 1 — a Will EMPLOYING MCP tools. An external server's tools register as
 * the Will's own abilities: description (+ compact args hint) becomes the
 * ability's meaning in the repertoire; the handler calls the tool and maps the
 * outcome onto EffectorResult (feeding reafference); required args missing at
 * enaction fail informatively so the Will learns the ability wants deliberate
 * articulation. Exercised against a real MCP server over InMemoryTransport.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { Will } from '#sdk/will'
import { connectMcpEffectors, describeMcpTool, buildMcpHandler, type McpToolInfo } from '#root/mcp/effectors'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )

let client: Client
const calls: Array<Record<string, unknown>> = []

beforeAll( async () => {
  // A real MCP tool server: one tool with a required arg, one objectless.
  const server = new McpServer( { name: 'fixture', version: '0' } )
  server.registerTool( 'search_docs', {
    description: 'Search the project documentation',
    inputSchema: { query: z.string().describe( 'the search text' ), limit: z.number().optional() },
  }, async ( { query } ) => {
    calls.push( { tool: 'search_docs', query } )
    return { content: [ { type: 'text', text: `3 results for "${ query }"` } ] }
  } )
  server.registerTool( 'ping', { description: 'Check the service is alive' },
    async () => ( { content: [ { type: 'text', text: 'pong' } ] } ) )
  server.registerTool( 'always_fails', { description: 'Always errors' },
    async () => ( { content: [ { type: 'text', text: 'boom' } ], isError: true } ) )

  client = new Client( { name: 'test', version: '0' } )
  const [ ct, st ] = InMemoryTransport.createLinkedPair()
  await Promise.all( [ server.connect( st ), client.connect( ct ) ] )
} )

afterAll( async () => { await client.close(); resetLogger() } )

describe( 'describeMcpTool — the ability\'s meaning', () => {
  it( 'composes description + args hint (required vs optional marked)', () => {
    const tool: McpToolInfo = {
      name: 'search_docs', description: 'Search the project documentation',
      inputSchema: { type: 'object',
        properties: { query: { type: 'string', description: 'the search text' }, limit: { type: 'number' } },
        required: [ 'query' ] },
    }
    const meaning = describeMcpTool( tool )
    expect( meaning ).toContain( 'Search the project documentation' )
    expect( meaning ).toContain( 'query: the search text' )
    expect( meaning ).toContain( 'limit?' )
  } )

  it( 'stays bounded for prompt rendering', () => {
    const meaning = describeMcpTool( { name: 'x', description: 'y'.repeat( 1000 ) } )
    expect( meaning.length ).toBeLessThanOrEqual( 300 )
  } )
} )

describe( 'buildMcpHandler — enaction → tool → reafference', () => {
  const searchTool: McpToolInfo = {
    name: 'search_docs',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: [ 'query' ] },
  }

  it( 'calls the tool with schema-filtered args and returns its outcome', async () => {
    const handler = buildMcpHandler( client, searchTool )
    // Invocation params carry situation extras the tool never declared — filtered out.
    const res = await handler( { query: 'tick loop', targetEntityName: 'Ada' }, { reasoning: '' } )
    expect( res ).toMatchObject( { success: true, description: '3 results for "tick loop"' } )
    expect( calls.at( -1 ) ).toEqual( { tool: 'search_docs', query: 'tick loop' } )
  } )

  it( 'fails informatively when required args are missing (habitual enaction)', async () => {
    const handler = buildMcpHandler( client, searchTool )
    const res = await handler( {}, { reasoning: '' } ) as { success: boolean; description: string }
    expect( res.success ).toBe( false )
    expect( res.description ).toContain( 'needs query' )
    expect( res.description ).toContain( 'args' )        // teaches deliberate articulation
  } )

  it( 'maps a tool error onto a failed outcome (not a throw)', async () => {
    const handler = buildMcpHandler( client, { name: 'always_fails' } )
    const res = await handler( {}, { reasoning: '' } ) as { success: boolean; description: string }
    expect( res.success ).toBe( false )
    expect( res.description ).toContain( 'boom' )
  } )
} )

describe( 'connectMcpEffectors — tools become the Will\'s abilities', () => {
  it( 'registers each tool as a learnable affordance with its meaning', async () => {
    const will = await Will.create( { name: 'Toolsmith', identity: { prompt: 'I use tools.' },
      llm: 'mock', engineTier: 'standard', tickMs: 10, seed: 5 } )
    try {
      const { names, close } = await connectMcpEffectors( will, { client }, { cost: 0.3 } )
      expect( names ).toEqual( expect.arrayContaining( [ 'search_docs', 'ping', 'always_fails' ] ) )

      const repertoire = ( will.stem.getWillCognition( will.id ) as unknown as
        { schemaRepertoire: { getSchema( id: string ): { description?: string; cost: number; tags?: string[] } | undefined } } ).schemaRepertoire
      const search = repertoire.getSchema( 'search_docs' )
      expect( search?.description ).toContain( 'Search the project documentation' )
      expect( search?.description ).toContain( 'query' )   // the executive sees what to supply
      expect( search?.cost ).toBe( 0.3 )
      expect( search?.tags ).toContain( 'mcp' )

      await close()                                        // client from source is left open
      expect( ( await client.listTools() ).tools.length ).toBeGreaterThan( 0 )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

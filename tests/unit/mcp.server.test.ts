// ─────────────────────────────────────────────────────────────
// tests/unit/mcp.server.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The MCP surface — a Will exposed to MCP clients, holding the subject
 * paradigm: perceive (stimulus intake), next_utterance (await | explicit
 * silence), state (snapshot), save (checkpoint), plus read-only resources.
 * Exercised end-to-end through a real MCP client over InMemoryTransport.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Will } from '#sdk/will'
import { buildWillMcpServer } from '#root/mcp/server'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )

const PMA_PATH = join( tmpdir(), `will-mcp-test-${ process.pid }.pma.json` )

let will:   Will
let client: Client

beforeAll( async () => {
  will = await Will.create( {
    name: 'Echo', identity: { prompt: 'I am Echo.' },
    llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 7,
  } )
  const server = buildWillMcpServer( will, { pmaPath: PMA_PATH } )
  client = new Client( { name: 'test-client', version: '0.0.0' } )
  const [ ct, st ] = InMemoryTransport.createLinkedPair()
  await Promise.all( [ server.connect( st ), client.connect( ct ) ] )
}, 30_000 )

afterAll( async () => {
  await client.close()
  await will.stop()
  rmSync( PMA_PATH, { force: true } )
  resetLogger()
} )

const text = ( res: unknown ): string =>
  ( ( res as { content?: Array<{ type: string; text: string }> } ).content?.[0]?.text ) ?? ''

describe( 'Will over MCP', () => {
  it( 'exposes the subject surface: perceive / next_utterance / state / save — and no ask()', async () => {
    const tools = ( await client.listTools() ).tools.map( t => t.name )
    expect( tools ).toEqual( expect.arrayContaining( [ 'perceive', 'next_utterance', 'state', 'save' ] ) )
    expect( tools ).not.toContain( 'ask' )   // the paradigm line: no request/response flattening
  } )

  it( 'state returns a well-formed inner-state snapshot', async () => {
    const res = await client.callTool( { name: 'state', arguments: {} } )
    const s   = JSON.parse( text( res ) )
    expect( s.tick ).toBeGreaterThan( 0 )
    expect( s.metrics.energy ).toBeGreaterThan( 0 )
    expect( Array.isArray( s.goals ) ).toBe( true )
    expect( typeof s.narrative ).toBe( 'string' )
  } )

  // Runs BEFORE any perceive: conversation processing changes tick pacing (a
  // pre-existing engine behavior), and this asserts save's non-destructiveness
  // against the clean baseline cadence.
  it( 'save checkpoints the living mind to the PMA path — non-destructively', async () => {
    const res = await client.callTool( { name: 'save', arguments: {} } )
    expect( text( res ) ).toContain( PMA_PATH )
    expect( existsSync( PMA_PATH ) ).toBe( true )
    const pma = JSON.parse( readFileSync( PMA_PATH, 'utf8' ) )
    expect( pma.willName ).toBe( 'Echo' )
    // Non-destructive: still ticking after the checkpoint.
    const before = JSON.parse( text( await client.callTool( { name: 'state', arguments: {} } ) ) ).tick
    await new Promise( r => setTimeout( r, 150 ) )
    const after  = JSON.parse( text( await client.callTool( { name: 'state', arguments: {} } ) ) ).tick
    expect( after ).toBeGreaterThan( before )
  } )

  it( 'perceive delivers a stimulus and reports delivery, not a response', async () => {
    const res = await client.callTool( { name: 'perceive', arguments: { text: 'Hello there.', from: 'ada', speaker: 'Ada' } } )
    expect( text( res ) ).toContain( 'Delivered' )
    expect( text( res ) ).toContain( 'silent' )   // the contract is stated to the client
  } )

  it( 'next_utterance reports silence as a valid outcome (never an error)', async () => {
    // Nobody ever addressed "ghost" — the Will has no reason to speak to it.
    const res = await client.callTool( { name: 'next_utterance', arguments: { within_ms: 200, from: 'ghost' } } )
    expect( ( res as { isError?: boolean } ).isError ?? false ).toBe( false )
    expect( text( res ) ).toContain( 'silent' )
    expect( text( res ) ).toContain( 'not an error' )
  } )

  it( 'serves read-only projection resources (will://state, will://narrative)', async () => {
    const uris = ( await client.listResources() ).resources.map( r => r.uri )
    expect( uris ).toEqual( expect.arrayContaining( [ 'will://state', 'will://narrative' ] ) )

    const res = await client.readResource( { uri: 'will://state' } )
    const c   = res.contents[0] as { mimeType?: string; text?: string }
    expect( c.mimeType ).toBe( 'application/json' )
    expect( JSON.parse( c.text ?? '' ).tick ).toBeGreaterThan( 0 )
  } )
} )

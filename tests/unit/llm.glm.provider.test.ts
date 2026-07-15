// ─────────────────────────────────────────────────────────────
// tests/unit/llm.glm.provider.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * GLM (Z.ai) as a first-class provider.
 *
 * GLM rides the Anthropic Messages wire — Z.ai ships a compat endpoint, the one
 * Claude Code targets — rather than the non-streaming OpenAI scaffold. These
 * lock the decisions that make that safe: the exact endpoint (including the
 * `/v1` segment, whose absence the live host answers with 404_NOT_FOUND), the
 * auth headers, a GLM default model (never a Claude id sent to Z.ai), streaming
 * parity, and correct pricing for the plain and 1M-context ids.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  LLMDirector, speaksAnthropicWire, defaultBaseFor, defaultModelFor, anthropicWireHeaders,
} from '#llm/index'
import { resolvePricing } from '#cognition/utilities/token.tracker'

const realFetch = globalThis.fetch
afterEach( () => { globalThis.fetch = realFetch } )

/** An Anthropic-shaped SSE body — the wire GLM is expected to speak. */
function streamOk( text: string ){
  const sse =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${ JSON.stringify( text ) }}}\n` +
    'data: {"type":"message_delta","usage":{"output_tokens":5}}\n' +
    'data: [DONE]\n'
  return { ok: true, status: 200, statusText: 'OK',
    body: new ReadableStream<Uint8Array>( {
      start( c ){ c.enqueue( new TextEncoder().encode( sse ) ); c.close() }
    } ) } as unknown as Response
}

/** Capture what the director hands to fetch, returning a canned body. */
function capture( body: () => Response ){
  const seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {}
  globalThis.fetch = ( async ( url: string, init: RequestInit ) => {
    seen.url = url
    seen.headers = init?.headers as Record<string, string>
    seen.body = init?.body ? JSON.parse( init.body as string ) : undefined
    return body()
  } ) as unknown as typeof fetch
  return seen
}

function glmDirector( extra: Partial<{ baseUrl: string }> = {} ){
  return new LLMDirector( {
    willId: 'w1', model: 'glm-5.2', maxOutputTokens: 64, apiKey: 'zai-key',
    provider: 'glm', sessionLogger: null, ...extra,
  } )
}

describe( 'GLM — wire selection', () => {
  it( 'speaks the Anthropic wire (so it streams, not the OpenAI scaffold)', () => {
    expect( speaksAnthropicWire( 'glm' ) ).toBe( true )
    expect( speaksAnthropicWire( 'anthropic' ) ).toBe( true )
    expect( speaksAnthropicWire( 'openai' ) ).toBe( false )
    expect( speaksAnthropicWire( 'deepseek' ) ).toBe( false )
    expect( speaksAnthropicWire( 'google' ) ).toBe( false )
  } )

  it( "defaults to Z.ai's Anthropic-compatible endpoint, version segment included", () => {
    // Z.ai's docs quote the base as `…/api/anthropic` because the Anthropic SDK
    // appends `/v1/messages`. This client appends only `/messages`, so `/v1`
    // belongs in the base — without it the live endpoint answers 404_NOT_FOUND.
    expect( defaultBaseFor( 'glm' ) ).toBe( 'https://api.z.ai/api/anthropic/v1' )
    expect( defaultBaseFor( 'anthropic' ) ).toBe( 'https://api.anthropic.com/v1' )
  } )

  it( 'defaults to a GLM model — never a Claude id pointed at Z.ai', () => {
    expect( defaultModelFor( 'glm' ) ).toBe( 'glm-5.2' )
    expect( defaultModelFor( 'anthropic' ) ).toMatch( /^claude-/ )
  } )
} )

describe( 'GLM — auth headers', () => {
  // Probed live: Z.ai accepts either header (each returns "token expired or
  // incorrect" for a bogus key — i.e. read and validated — where a missing one
  // returns "Authentication parameter not received"). Sending both is the hedge.
  it( 'carries the Bearer token Z.ai documents, plus x-api-key for either gateway', () => {
    const h = anthropicWireHeaders( 'glm', 'zai-key' )
    expect( h.Authorization ).toBe( 'Bearer zai-key' )
    expect( h[ 'x-api-key' ] ).toBe( 'zai-key' )
    expect( h[ 'anthropic-version' ] ).toBe( '2023-06-01' )
  } )

  it( 'never sends a Bearer token to Anthropic itself', () => {
    const h = anthropicWireHeaders( 'anthropic', 'sk-ant' )
    expect( h.Authorization ).toBeUndefined()
    expect( h[ 'x-api-key' ] ).toBe( 'sk-ant' )
  } )
} )

describe( 'GLM — pricing', () => {
  it( 'prices glm-5.2 at Z.ai rates — bare, 1M-context, and provider-prefixed', () => {
    expect( resolvePricing( 'glm-5.2' ) ).toEqual( { input: 1.40, output: 4.40 } )
    expect( resolvePricing( 'glm-5.2[1m]' ) ).toEqual( { input: 1.40, output: 4.40 } )
    expect( resolvePricing( 'glm/glm-5.2' ) ).toEqual( { input: 1.40, output: 4.40 } )
  } )

  it( 'does not silently fall through to the $3/$15 default', () => {
    expect( resolvePricing( 'glm-5.2' ) ).not.toEqual( resolvePricing( 'some-unknown-model' ) )
  } )
} )

describe( 'GLM — the call actually reaches Z.ai', () => {
  it( 'streams from the Z.ai host with Bearer auth and the GLM model', async () => {
    const seen = capture( () => streamOk( 'hello from GLM' ) )
    const chunks: string[] = []
    const result = await glmDirector().callStream( 'system', 'user', 0 as never, c => chunks.push( c ) )

    expect( seen.url ).toBe( 'https://api.z.ai/api/anthropic/v1/messages' )
    expect( seen.headers?.Authorization ).toBe( 'Bearer zai-key' )
    expect( seen.body?.model ).toBe( 'glm-5.2' )
    expect( seen.body?.stream ).toBe( true )

    // The prompt-cache breakpoint rides along: Z.ai's compat endpoint is what
    // Claude Code targets, and Claude Code sends cache_control.
    const system = seen.body?.system as Array<{ cache_control?: unknown }>
    expect( system[0]?.cache_control ).toEqual( { type: 'ephemeral' } )

    expect( result.text ).toBe( 'hello from GLM' )
    expect( chunks.join( '' ) ).toBe( 'hello from GLM' )
  } )

  it( 'routes call() through the streaming path too — the TTFT deadline, like Anthropic', async () => {
    const seen = capture( () => streamOk( 'reasoned' ) )
    const result = await glmDirector().call( 'system', 'user', 0 as never )

    expect( seen.url ).toBe( 'https://api.z.ai/api/anthropic/v1/messages' )
    expect( seen.body?.stream ).toBe( true )
    expect( result.text ).toBe( 'reasoned' )
  } )

  it( 'honours an explicit baseUrl (an Anthropic-compatible gateway)', async () => {
    const seen = capture( () => streamOk( 'local' ) )
    await glmDirector( { baseUrl: 'http://localhost:8000/v1' } )
      .callStream( 'system', 'user', 0 as never, () => {} )

    expect( seen.url ).toBe( 'http://localhost:8000/v1/messages' )
  } )
} )

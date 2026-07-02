// ─────────────────────────────────────────────────────────────
// tests/unit/llm.director.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for LLMDirector base-URL routing + per-request timeouts (R1/PR-b).
 *
 * Regression target: every provider call hardcoded its endpoint, so the
 * `deepseek` provider (routed through the OpenAI-compatible path) actually hit
 * `https://api.openai.com` and could never reach DeepSeek. There was also no
 * base-URL override (no Ollama / Azure / self-hosted) and no request timeout —
 * a hung connection blocked forever.
 *
 * The fix adds a resolvable base URL (explicit override → provider default) and
 * an AbortSignal.timeout that surfaces a clear error, mirroring the embedder.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { LLMDirector, type LLMProvider } from '#llm/index'

const realFetch = globalThis.fetch

function director( provider: LLMProvider, extra: Partial<{ baseUrl: string; timeoutMs: number }> = {} ){
  return new LLMDirector({
    willId: 'w1', model: 'm', maxOutputTokens: 16, apiKey: 'k',
    provider, sessionLogger: null, ...extra,
  })
}

function openAiOk(){
  return { ok: true, status: 200, statusText: 'OK',
    json: async () => ({ choices: [ { message: { content: 'hi' } } ], usage: { prompt_tokens: 1, completion_tokens: 2 } }) } as unknown as Response
}
function anthropicOk(){
  // call() routes Anthropic through the streaming path (first-byte timeout), so
  // the mock must expose a readable SSE body — not just .json().
  const sse =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":2}}\n' +
    'data: [DONE]\n'
  return { ok: true, status: 200, statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start( c ){ c.enqueue( new TextEncoder().encode( sse ) ); c.close() }
    }) } as unknown as Response
}

/** Capture the URL + signal the director hands to fetch, returning a canned body. */
function capture( body: () => Response ){
  const seen: { url?: string; signal?: unknown } = {}
  globalThis.fetch = ( async ( url: string, init: RequestInit ) => {
    seen.url = url
    seen.signal = init?.signal
    return body()
  } ) as unknown as typeof fetch
  return seen
}

afterEach( () => { globalThis.fetch = realFetch } )

describe( 'LLMDirector — base-URL routing (R1/PR-b)', () => {
  it( 'routes the deepseek provider to DeepSeek, not OpenAI (the mis-routing fix)', async () => {
    const seen = capture( openAiOk )
    await director( 'deepseek' ).call( 'sys', 'user', 0 )
    expect( seen.url ).toBe( 'https://api.deepseek.com/v1/chat/completions' )
  })

  it( 'uses the official OpenAI endpoint by default', async () => {
    const seen = capture( openAiOk )
    await director( 'openai' ).call( 'sys', 'user', 0 )
    expect( seen.url ).toBe( 'https://api.openai.com/v1/chat/completions' )
  })

  it( 'honors an explicit baseUrl override (e.g. a local Ollama server)', async () => {
    const seen = capture( openAiOk )
    await director( 'openai', { baseUrl: 'http://localhost:11434/v1' } ).call( 'sys', 'user', 0 )
    expect( seen.url ).toBe( 'http://localhost:11434/v1/chat/completions' )
  })

  it( 'uses the official Anthropic endpoint and /messages route', async () => {
    const seen = capture( anthropicOk )
    await director( 'anthropic' ).call( 'sys', 'user', 0 )
    expect( seen.url ).toBe( 'https://api.anthropic.com/v1/messages' )
  })
})

describe( 'LLMDirector — per-request timeout (R1/PR-b)', () => {
  it( 'passes an AbortSignal to fetch so a hung request can be cancelled', async () => {
    const seen = capture( openAiOk )
    await director( 'openai' ).call( 'sys', 'user', 0 )
    expect( seen.signal ).toBeInstanceOf( AbortSignal )
  })

  it( 'translates a timeout into a clear, provider-named error', async () => {
    globalThis.fetch = ( async () => {
      throw Object.assign( new Error( 'The operation timed out.' ), { name: 'TimeoutError' } )
    } ) as unknown as typeof fetch

    await expect( director( 'openai', { timeoutMs: 1234 } ).call( 'sys', 'user', 0 ) )
      .rejects.toThrow( /timed out after 1234ms/ )
  })
})

describe( 'LLMDirector — Google/Gemini provider (R1/PR-c)', () => {
  function geminiOk( text = 'hi', prompt = 3, candidates = 5 ){
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({
      candidates: [ { content: { parts: [ { text } ], role: 'model' } } ],
      usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: candidates },
    }) } as unknown as Response
  }

  /** Capture url + headers + parsed body the director hands to fetch. */
  function captureFull( body: () => Response ){
    const seen: { url?: string; headers?: Record<string, string>; body?: any } = {}
    globalThis.fetch = ( async ( url: string, init: RequestInit ) => {
      seen.url = url
      seen.headers = init?.headers as Record<string, string>
      seen.body = init?.body ? JSON.parse( init.body as string ) : undefined
      return body()
    } ) as unknown as typeof fetch
    return seen
  }

  it( 'routes to the Gemini generateContent endpoint for the model', async () => {
    const seen = captureFull( () => geminiOk() )
    await director( 'google' ).call( 'sys', 'user', 0 )
    expect( seen.url ).toBe( 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent' )
  })

  it( 'sends the API key via the x-goog-api-key header', async () => {
    const seen = captureFull( () => geminiOk() )
    await director( 'google' ).call( 'sys', 'user', 0 )
    expect( seen.headers?.[ 'x-goog-api-key' ] ).toBe( 'k' )
  })

  it( 'maps the system prompt into systemInstruction and the user message into contents', async () => {
    const seen = captureFull( () => geminiOk() )
    await director( 'google' ).call( 'be helpful', 'hello there', 0 )
    expect( seen.body.systemInstruction.parts[ 0 ].text ).toBe( 'be helpful' )
    expect( seen.body.contents[ 0 ].parts[ 0 ].text ).toBe( 'hello there' )
  })

  it( 'parses candidates text and usageMetadata token counts', async () => {
    globalThis.fetch = ( async () => geminiOk( 'the answer', 11, 22 ) ) as unknown as typeof fetch
    const result = await director( 'google' ).call( 'sys', 'user', 0 )
    expect( result ).toEqual( { text: 'the answer', inputTok: 11, outputTok: 22 } )
  })

  it( 'surfaces a non-ok Google status as a clear error', async () => {
    globalThis.fetch = ( async () => ( { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'bad key' } ) ) as unknown as typeof fetch
    await expect( director( 'google' ).call( 'sys', 'user', 0 ) ).rejects.toThrow( /Google API 400/ )
  })
})

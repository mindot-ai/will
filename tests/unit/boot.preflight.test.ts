// ─────────────────────────────────────────────────────────────
// tests/unit/boot.preflight.test.ts
//
// The boot preflight exists to catch the one failure that strands an operator:
// a Will that boots, joins, perceives, and never speaks. It pings the provider
// before raising the mind, and a bad key / model / endpoint becomes a sentence
// instead of an afternoon.
//
// That ping was hardcoded to the Anthropic wire — correct while boot knew only
// anthropic and glm. Once the provider set widened it became a FALSE NEGATIVE:
// an OpenAI-wire provider answers 404 to `/messages`, preflight read that as
// "the LLM refused a test call", and `process.exit(1)` denied boot to a
// perfectly working Will. A safety net that fails closed on healthy input is
// worse than no net.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest'
import { pingRequest, resolveLlmMode } from '#root/host/boot'
import { knownWireFor, PROVIDER_KEY_ENV } from '#llm/index'

describe('preflight ping — spoken in the provider\'s own dialect', () => {

  it('pings the Anthropic wire at /messages with x-api-key', () => {
    const p = pingRequest('anthropic', 'https://api.anthropic.com/v1', 'claude-x', 'k', 'anthropic')!
    expect( p.url ).toBe('https://api.anthropic.com/v1/messages')
    expect( p.headers['x-api-key'] ).toBe('k')
    expect( p.headers['anthropic-version'] ).toBeTruthy()
    // Anthropic itself gets no bearer — same secret, but only the header it reads.
    expect( p.headers['Authorization'] ).toBeUndefined()
  } )

  it('pings the OpenAI wire at /chat/completions with a bearer', () => {
    const p = pingRequest('openai', 'https://api.moonshot.ai/v1', 'kimi-k2.5', 'k', 'moonshot')!
    expect( p.url ).toBe('https://api.moonshot.ai/v1/chat/completions')
    expect( p.headers['Authorization'] ).toBe('Bearer k')
    // The regression, stated directly: an OpenAI-wire provider must never be
    // asked at /messages, because its 404 reads as a refusal and blocks boot.
    expect( p.url ).not.toContain('/messages')
  } )

  it('gives every OpenAI-wire provider the OpenAI-wire ping', () => {
    for( const provider of [ 'moonshot', 'qwen', 'xai', 'minimax', 'mistral', 'deepseek', 'openai', 'ollama', 'vllm' ] ){
      const wire = knownWireFor( provider )!
      const p = pingRequest( wire, 'https://x/v1', 'm', 'k', provider )!
      expect( p.url, `${provider} was pinged at the wrong path` ).toBe('https://x/v1/chat/completions')
    }
  } )

  it('declines to ping a wire it cannot honestly speak', () => {
    // Gemini authenticates in the query string and nests its payload
    // differently. A hand-rolled ping would drift from the client that makes
    // the real calls, and a wrong ping fails a healthy provider — so boot goes
    // unchecked instead, and says so.
    expect( pingRequest('google', 'https://x/v1beta', 'gemini-x', 'k', 'google') ).toBeNull()
  } )
} )

describe('resolveLlmMode — boot detects what the SDK detects', () => {

  // Every provider env, not just the ones these cases set. `bun test` auto-loads
  // `.env` (vitest does not), so a developer's own key silently decides the
  // answer and the suite passes or fails by whose machine it runs on.
  const TOUCHED = [ 'WILL_LLM', 'WILL_LLM_API_KEY', 'WILL_LLM_PROVIDER', 'GEMINI_API_KEY', ...Object.values( PROVIDER_KEY_ENV ) ]
  const saved: Record<string, string | undefined> = {}
  for( const k of TOUCHED ) saved[ k ] = process.env[ k ]
  afterEach( () => {
    for( const k of TOUCHED ){
      if( saved[ k ] === undefined ) delete process.env[ k ]
      else process.env[ k ] = saved[ k ]!
    }
  } )
  const only = ( name?: string, value?: string ) => {
    for( const k of TOUCHED ) delete process.env[ k ]
    if( name ) process.env[ name ] = value!
  }

  it('detects a provider boot never used to know about', () => {
    // Boot carried its own two-provider detector, so a Will running live on
    // Kimi had its preflight silently skipped — the check simply did not fire.
    only('MOONSHOT_API_KEY', 'k')
    expect( resolveLlmMode() ).toBe('moonshot')
  } )

  it('an explicit WILL_LLM wins over any key present', () => {
    only('ANTHROPIC_API_KEY', 'k')
    process.env['WILL_LLM'] = 'glm'
    expect( resolveLlmMode() ).toBe('glm')
  } )

  it('falls back to the keyless mock', () => {
    only()
    expect( resolveLlmMode() ).toBe('mock')
  } )
} )

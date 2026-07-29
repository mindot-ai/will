// ─────────────────────────────────────────────────────────────
// tests/unit/provider.key.env.test.ts — MODEL_ROUTING W9/W10
//
// W9 removed a real bug: the key chain used to end at ANTHROPIC_API_KEY no
// matter which provider was configured, so a Will pointed at another vendor
// quietly handed that vendor an Anthropic secret.
//
// Removing it outright went one step too far. `ANTHROPIC_API_KEY=… npx
// @mindot/will discord` is the documented quickstart, and the host's preflight
// check still validated that key — then the director was built with an empty
// one and the first real call 401'd. Preflight said yes; the mind never spoke.
//
// The fix keeps both properties, which these tests pin as a pair:
//   1. a provider's own env key reaches it, and
//   2. it can only ever reach THAT provider.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest'
import { providerKeyFromEnv, PROVIDER_KEY_ENV, KNOWN_PROVIDERS, MOCK_PROVIDER } from '#llm/index'

// Every provider env, not just the ones a case sets: `bun test` auto-loads
// `.env` (vitest does not), so a developer's own keys are otherwise live inside
// the assertions and the suite passes or fails by whose machine it runs on.
const TOUCHED = [ ...Object.values( PROVIDER_KEY_ENV ), 'GEMINI_API_KEY' ]
const saved: Record<string, string | undefined> = {}
for( const k of TOUCHED ) saved[ k ] = process.env[ k ]

afterEach( () => {
  for( const k of TOUCHED ){
    if( saved[ k ] === undefined ) delete process.env[ k ]
    else process.env[ k ] = saved[ k ]!
  }
} )

const only = ( name: string, value: string ) => {
  for( const k of TOUCHED ) delete process.env[ k ]
  process.env[ name ] = value
}

describe('provider key resolution — scoped to the provider, never borrowed', () => {

  it("reads the configured provider's own env var", () => {
    only('MOONSHOT_API_KEY', 'kimi-key')
    expect( providerKeyFromEnv('moonshot') ).toBe('kimi-key')
  } )

  it('never hands one provider another provider\'s key', () => {
    // The exact shape of the bug W9 removed: ANTHROPIC_API_KEY present, a
    // different provider configured. It must come back empty, not borrowed.
    only('ANTHROPIC_API_KEY', 'sk-ant-secret')
    for( const p of [ 'moonshot', 'qwen', 'xai', 'minimax', 'mistral', 'glm', 'deepseek', 'openai', 'google' ] )
      expect( providerKeyFromEnv( p ), `${p} borrowed the Anthropic key` ).toBeUndefined()
    expect( providerKeyFromEnv('anthropic') ).toBe('sk-ant-secret')
  } )

  it('gives an unknown provider nothing rather than a stranger\'s secret', () => {
    only('ANTHROPIC_API_KEY', 'sk-ant-secret')
    expect( providerKeyFromEnv('acme-inference') ).toBeUndefined()
  } )

  it('treats a present-but-empty key as absent', () => {
    // `.env.example` lists every provider so they are discoverable, which means
    // a real `.env` carries `KEY=` for the nine you do not use. An empty string
    // is not a credential, and reading it as one turns a clear "no key
    // configured" into an opaque 401 on the first call.
    only('MISTRAL_API_KEY', '')
    expect( providerKeyFromEnv('mistral') ).toBeUndefined()
    process.env[ 'MISTRAL_API_KEY' ] = '   '
    expect( providerKeyFromEnv('mistral') ).toBeUndefined()
  } )

  it('accepts either name Gemini ships under', () => {
    only('GEMINI_API_KEY', 'g-key')
    expect( providerKeyFromEnv('google') ).toBe('g-key')
    only('GOOGLE_API_KEY', 'g-key-2')
    expect( providerKeyFromEnv('google') ).toBe('g-key-2')
  } )

  it('has a key env for every known provider that needs one', () => {
    // Local runtimes authenticate nothing, and the mock never dials — everyone
    // else is reachable by key alone, which is what the quickstart promises.
    const keyless = new Set( [ MOCK_PROVIDER, 'ollama', 'vllm' ] )
    for( const provider of Object.keys( KNOWN_PROVIDERS ) ){
      if( keyless.has( provider ) ) continue
      expect( PROVIDER_KEY_ENV[ provider ], `${provider} has no key env` ).toBeTruthy()
    }
  } )
} )

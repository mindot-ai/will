// ─────────────────────────────────────────────────────────────
// tests/unit/vector.testmode-guard.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * testMode must never construct the env-driven NETWORK embedder. A dev .env
 * (auto-loaded by bun) carrying WILL_SEMANTIC_RECALL=true + an embedding model
 * + a live key silently turned "mock" runs into real network embeds inside
 * buildExecutiveContext — wall-clock latency that jittered reply timing and
 * content under a fixed seed (the audition-reply determinism flake, and the
 * same hole that masked replay layer 3). Explicit adapters and the
 * deterministic mock embedder stay honored.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { _resolveVectorMemory } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
afterAll( () => resetLogger() )

const ENV_KEYS = [ 'WILL_VECTOR_MEMORY', 'WILL_EMBEDDING_MODEL', 'WILL_EMBEDDING_API_KEY', 'WILL_SEMANTIC_RECALL', 'GOOGLE_GENERATIVE_AI_API_KEY' ]
const saved: Record<string, string | undefined> = {}
for( const k of ENV_KEYS ) saved[ k ] = process.env[ k ]
afterAll( () => {
  for( const k of ENV_KEYS ){
    if( saved[ k ] === undefined ) delete process.env[ k ]
    else process.env[ k ] = saved[ k ]
  }
} )

/** The dev-.env bleed shape: recall on, network embedder model, live-looking key. */
function armNetworkEmbedderEnv(): void {
  process.env.WILL_SEMANTIC_RECALL = 'true'
  process.env.WILL_EMBEDDING_MODEL = 'google/gemini-embedding-001'
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'fake-key-for-guard-test'
  delete process.env.WILL_VECTOR_MEMORY
  delete process.env.WILL_EMBEDDING_API_KEY
}

describe( '_resolveVectorMemory — testMode network-embedder guard', () => {
  beforeEach( armNetworkEmbedderEnv )

  it( 'testMode refuses the env-driven network embedder (returns no vector memory)', () => {
    const r = _resolveVectorMemory( 'w1', 1, undefined, undefined, null, true )
    expect( r.embedder ).toBeNull()
    expect( r.vectorMemory ).toBeNull()
  } )

  it( 'live mode (testMode off) still builds the env-driven embedder', () => {
    const r = _resolveVectorMemory( 'w2', 1, undefined, undefined, null, false )
    expect( r.embedder ).not.toBeNull()
    expect( r.vectorMemory ).not.toBeNull()
  } )

  it( 'testMode + WILL_VECTOR_MEMORY=mock keeps the deterministic mock embedder', () => {
    process.env.WILL_VECTOR_MEMORY = 'mock'
    const r = _resolveVectorMemory( 'w3', 1, undefined, undefined, null, true )
    expect( r.embedder ).not.toBeNull()
    expect( r.vectorMemory ).not.toBeNull()
  } )

  it( 'testMode + an explicit adapter is honored (caller owns determinism)', () => {
    const adapter = { store: async () => {}, query: async () => [] } as never
    const r = _resolveVectorMemory( 'w4', 1, adapter, undefined, null, true )
    expect( r.vectorMemory ).toBe( adapter )
  } )
} )

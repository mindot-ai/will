// ─────────────────────────────────────────────────────────────
// tests/integration/token.tracker.isolation.test.ts
// ─────────────────────────────────────────────────────────────

/**
 * Per-Will token-tracker isolation (REORIENT R4-a).
 *
 * Before R4, `TokenTracker` was a process-global singleton (`getTokenTracker` /
 * `setTokenTracker`): every Will's LLM usage and cost aggregated into one
 * object, so on a multi-Will platform billing/usage conflated across tenants
 * and tests could not run in parallel without clobbering each other's tracker.
 *
 * R4-a makes the tracker a per-Will instance — created in `assembleMind`,
 * registered as an engine, and injected into the executive's `LLMDirector` via
 * `attachTokenTracker()`. These tests prove the two properties that matter:
 *
 *   1. Two assembled minds own *distinct* tracker instances (no shared global).
 *   2. Recording usage on one mind's tracker leaves the other's untouched —
 *      per-tenant accounting, not a shared aggregate.
 *
 * `recordUsage` is exercised directly (it is otherwise only reached on a live
 * network call); the point under test is the ownership/isolation boundary, not
 * the pricing arithmetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind, type WillConfig } from '#stem/mind'

function makeConfig( id: string ): WillConfig {
  return {
    id,
    name:             id,
    profile:          null,
    identity: {
      prompt: 'Per-Will token tracker isolation test mind.',
      values: [ 'honesty' ],
      traits: { openness: 0.5 },
      style:  'concise',
    },
    engineTier:       'standard',          // standard tier wires the ExecutiveEngine + tracker
    modelTier:        'haiku',
    persistentMemory: false,
    snapshotInterval: 999_999,
    tickIntervalMs:   0,
    randomSeed:       12_345,
    testMode:         true,                // no live LLM
  }
}

// Keep assembly offline/deterministic: no embedder network calls, no live key.
const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_VECTOR_MEMORY:     '',
  WILL_EMBEDDING_API_KEY: undefined,
  WILL_LLM_API_KEY:       undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const _savedEnv: Record<string, string | undefined> = {}

describe( 'Per-Will token tracker isolation (R4-a)', () => {
  beforeAll( () => {
    for( const key of Object.keys( ENV_OVERRIDES ) ){
      _savedEnv[ key ] = process.env[ key ]
      const value = ENV_OVERRIDES[ key ]
      if( value === undefined ) delete process.env[ key ]
      else process.env[ key ] = value
    }
  })

  afterAll( () => {
    for( const key of Object.keys( ENV_OVERRIDES ) ){
      const value = _savedEnv[ key ]
      if( value === undefined ) delete process.env[ key ]
      else process.env[ key ] = value
    }
  })

  it( 'gives each assembled mind its own tracker instance', () => {
    const a = assembleMind( 'will-iso-a', makeConfig( 'will-iso-a' ) )
    const b = assembleMind( 'will-iso-b', makeConfig( 'will-iso-b' ) )

    expect( a.cognition.tokenTracker ).toBeDefined()
    expect( b.cognition.tokenTracker ).toBeDefined()
    // Distinct objects → no process-global singleton shared between Wills.
    expect( a.cognition.tokenTracker ).not.toBe( b.cognition.tokenTracker )
  })

  it( 'does not conflate usage/cost across Wills', () => {
    const a = assembleMind( 'will-iso-c', makeConfig( 'will-iso-c' ) )
    const b = assembleMind( 'will-iso-d', makeConfig( 'will-iso-d' ) )

    // Both start empty.
    expect( a.cognition.tokenTracker.totalCostUsd ).toBe( 0 )
    expect( b.cognition.tokenTracker.totalCostUsd ).toBe( 0 )

    // Record a call against A only.
    a.cognition.tokenTracker.recordUsage({
      model:            'anthropic/claude-haiku-4-5',
      promptTokens:     1_000_000,
      completionTokens: 1_000_000,
      totalTokens:      2_000_000,
      category:         'executive',
      attribute:        'master',
      function:         'decision',
      tick:             1,
      latencyMs:        10,
    })

    // A accrued cost; B is untouched — per-tenant accounting holds.
    expect( a.cognition.tokenTracker.totalCostUsd ).toBeGreaterThan( 0 )
    expect( a.cognition.tokenTracker.totalTokens ).toEqual({ prompt: 1_000_000, completion: 1_000_000 })
    expect( b.cognition.tokenTracker.totalCostUsd ).toBe( 0 )
    expect( b.cognition.tokenTracker.totalTokens ).toEqual({ prompt: 0, completion: 0 })
  })
})

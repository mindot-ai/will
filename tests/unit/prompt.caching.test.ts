// ─────────────────────────────────────────────────────────────
// tests/unit/prompt.caching.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Prompt-cache invariant (§4): the system prompt must be byte-identical across
 * calls that differ only in volatile content (the per-turn `## Current Focus`).
 * That stability is what lets one Anthropic prompt-cache breakpoint cover the
 * whole system prompt — reused across master ticks and shared across a Will's
 * conversation facets.
 */

import { describe, it, expect } from 'vitest'
import { PromptFactory } from '#faculties/executive.engine/prompt.factory'

// Minimal context — buildSystemPrompt only reads identity + behavioralDisposition + selfTuning.
const ctx = {
  identity: {
    name:   'Aria',
    values: ['curiosity', 'honesty'],
    traits: { openness: 0.82, caution: 0.30 },
    style:  'warm and direct',
    prompt: '## Who You Are\nYou are Aria, a synthetic mind.',
  },
  behavioralDisposition: { riskTolerance: 0.5, explorationRate: 0.6, impulsivity: 0.3 },
  selfTuning: [],
} as any

const focus = ( content: string ) => ({
  title:   'Active Conversation',
  content,
  instructions: 'Respond as yourself.',
}) as any

const buildSys = ( f: any, mode: 'master' | 'facet' = 'facet' ) =>
  PromptFactory.buildSystemPrompt({ context: ctx, focus: f, deps: {} as any, mode })

describe( 'Prompt caching — system-prompt stability (§4)', () => {
  it( 'is byte-identical when only the per-turn focus content differs', () => {
    const a = buildSys( focus( 'Speaker: alice (id: alice)\nCurrent message: "hello"' ) )
    const b = buildSys( focus( 'Speaker: alice (id: alice)\nCurrent message: "totally different message, longer"' ) )
    expect( a ).toBe( b )   // → one cache entry covers every turn
  } )

  it( 'does not leak the volatile focus content into the system prompt', () => {
    const sys = buildSys( focus( 'Speaker: bob (id: bob)\nCurrent message: "secret per-turn text"' ) )
    expect( sys ).not.toContain( 'secret per-turn text' )
    expect( sys ).not.toContain( '## Current Focus' )
  } )

  it( 'two conversation facets (same focus.title) share an identical system prompt', () => {
    // Different entities/threads, same focus.title → same cached system prompt.
    const aliceSys = buildSys( focus( 'Speaker: alice\nCurrent message: "hi from alice"' ) )
    const bobSys   = buildSys( focus( 'Speaker: bob\nCurrent message: "hi from bob"' ) )
    expect( aliceSys ).toBe( bobSys )
  } )

  it( 'master and facet system prompts differ (separate cache entries, by design)', () => {
    const master = buildSys( focus( 'x' ), 'master' )
    const facet  = buildSys( focus( 'x' ), 'facet' )
    expect( master ).not.toBe( facet )   // role + consciousness-architecture lines differ
  } )

  it( 'still contains the stable, cacheable substance (persona + schema)', () => {
    const sys = buildSys( focus( 'x' ) )
    expect( sys ).toContain( 'You are Aria' )            // persona
    expect( sys ).toContain( 'Required Output' )         // output schema
    expect( sys ).toContain( '[PLANS]' )                 // tagged-block schema
  } )
} )

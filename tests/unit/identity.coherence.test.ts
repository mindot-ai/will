// ─────────────────────────────────────────────────────────────
// tests/unit/identity.coherence.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The LLM coherence check is the optional semantic second line of the identity
 * guardrail. These tests cover the deterministic parts — prompt construction and
 * robust parsing of the model's JSON — with a fake reviewer (no real LLM). The
 * live behaviour is validated separately (src/runners/coherence.runner.ts).
 */

import { describe, it, expect } from 'vitest'
import { checkIdentityCoherence, buildCoherenceUserMessage, type IdentityReviewer } from '#stem/guards/identity.coherence'
import type { WillIdentity } from '#stem/mind'

const identity = ( over: Partial<WillIdentity> = {} ): WillIdentity => ( {
  prompt: 'I am Aria, steward of the Nexus station.',
  values: [ 'duty' ], traits: {}, style: 'measured',
  ...over,
} )

const textReviewer  = ( text: string ): IdentityReviewer => ( { call: async () => ( { text } ) } )
const throwReviewer = (): IdentityReviewer => ( { call: async () => { throw new Error('timeout') } } )

describe('identity coherence (LLM review)', () => {
  it('passes a clean persona (empty issues → ok)', async () => {
    const r = await checkIdentityCoherence( { identity: identity() }, textReviewer('{"issues":[]}') )
    expect( r.ran ).toBe( true )
    expect( r.ok ).toBe( true )
    expect( r.issues ).toEqual( [] )
  } )

  it('flags error-severity issues and marks not-ok', async () => {
    const json = '{"issues":[{"severity":"error","kind":"contradiction","detail":"claims to be a stateless assistant"},{"severity":"warning","kind":"false-capability","detail":"says it can see"}]}'
    const r = await checkIdentityCoherence( { identity: identity() }, textReviewer( json ) )
    expect( r.ok ).toBe( false )           // an error-severity issue blocks
    expect( r.issues.length ).toBe( 2 )
    expect( r.issues[0]!.kind ).toBe('contradiction')
  } )

  it('extracts JSON even when the model wraps it in prose', async () => {
    const r = await checkIdentityCoherence( { identity: identity() }, textReviewer('Sure! Here is the review:\n{"issues":[]}\nHope that helps.') )
    expect( r.ran ).toBe( true )
    expect( r.issues ).toEqual( [] )
  } )

  it('is robust to malformed output (no crash, no false issues)', async () => {
    const r = await checkIdentityCoherence( { identity: identity() }, textReviewer('not json at all') )
    expect( r.ran ).toBe( true )
    expect( r.ok ).toBe( true )
    expect( r.issues ).toEqual( [] )
  } )

  it('fails open when the reviewer throws (ran=false, never blocks creation)', async () => {
    const r = await checkIdentityCoherence( { identity: identity() }, throwReviewer() )
    expect( r.ran ).toBe( false )
    expect( r.ok ).toBe( true )
  } )

  it('includes the persona prompt + profile context in the review message', () => {
    const msg = buildCoherenceUserMessage( {
      identity: identity( { prompt: 'I am Aria.' } ),
      profileContext: 'You are in a game world.',
    } )
    expect( msg ).toMatch( /I am Aria\./ )
    expect( msg ).toMatch( /game world/ )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/executive.deliberate-reasoning.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The shared System 2 propose pass (`proposeCandidates`) — used by BOTH master and facets
 * ("facets are master over their focus"). It runs one ideation call and parses the
 * candidate set, degrading gracefully to `undefined` (→ caller proceeds as System 1) on
 * an empty parse or a thrown call, so a flaky propose pass never breaks a tick.
 */

import { describe, it, expect } from 'vitest'
import type { LLMDirector } from '#llm/index'
import { proposeCandidates } from '#faculties/executive.engine/deliberate.reasoning'

// A fake director whose .call returns the given text (or throws the given error).
const fakeDirector = ( resp: string | Error ): LLMDirector => ( {
  call: async () => {
    if( resp instanceof Error ) throw resp
    return { text: resp, inputTok: 1, outputTok: 1 }
  },
} as unknown as LLMDirector )

const run = ( resp: string | Error ) =>
  proposeCandidates( {
    director: fakeDirector( resp ),
    systemPrompt: 'sys',
    ideationUserMessage: 'propose options',
    tick: 1,
    proposeTemperature: 0.9,
  } )

describe( 'proposeCandidates — shared System 2 propose pass', () => {
  it( 'parses the candidate set from a well-formed ideation response', async () => {
    const out = await run( '```json\n{"candidates":[{"approach":"ask","description":"d","upside":"u","risk":"r"}]}\n```' )
    expect( out ).toHaveLength( 1 )
    expect( out![0]!.approach ).toBe( 'ask' )
  } )

  it( 'degrades to undefined when the response has no candidates (→ System 1)', async () => {
    expect( await run( '{"actions":[]}' ) ).toBeUndefined()
  } )

  it( 'degrades to undefined when the propose call throws (never breaks the tick)', async () => {
    expect( await run( new Error( 'provider 500' ) ) ).toBeUndefined()
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/llm.stream-usage.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the ledger learns about a call it just paid for.
 *
 * The Anthropic wire says usage arrives on `message_start` (the input side) and
 * `message_delta` (`output_tokens`). The parser was written to that letter, and
 * every Anthropic-wire host that orders it differently silently recorded zero.
 *
 * Z.ai — which `glm` routes through — is one of those hosts. It sends
 * `message_start` with every field zeroed as a placeholder and reports the true
 * input, output AND cache figures together on the final `message_delta`. The
 * numbers were on the wire the whole time; nothing read them.
 *
 * Measured on the COO's ledger: 491 GLM calls, 441,896 output tokens,
 * `inputTok: 0` on every single record, and `cacheReadTok: 0` on every single
 * record — against a mind whose system prompt is ~3,400 tokens and IS being
 * cached (probed live: a repeat call read 5,248 tokens from cache). So the log
 * understated her input by roughly 3M tokens per run and showed a cache that
 * looked stone dead while it was working.
 *
 * The same defect shape as the rest of this week's: the value is produced, it
 * crosses a boundary, and the far side is not looking where it landed.
 */

import { describe, it, expect } from 'vitest'
import { foldStreamUsage, type StreamTokens } from '#llm/index'

const zero = (): StreamTokens => ({
  inputTok: 0, outputTok: 0, cacheReadTok: 0, cacheWriteTok: 0 })

describe('folding stream usage', () => {
  it('reads a Z.ai stream, where everything real lands on message_delta', () => {
    // Captured verbatim from api.z.ai/api/anthropic/v1, model glm-5.2.
    const acc = zero()
    foldStreamUsage( acc, { input_tokens: 0, output_tokens: 0 } )          // message_start
    foldStreamUsage( acc, {                                                 // message_delta
      input_tokens: 35, output_tokens: 2, cache_read_input_tokens: 5248 } )

    expect( acc.inputTok,     'input was recorded as 0 for every GLM call').toBe( 35 )
    expect( acc.outputTok ).toBe( 2 )
    expect( acc.cacheReadTok, 'the cache was working and invisible').toBe( 5248 )
  })

  it('still reads a real Anthropic stream, where the input side comes first', () => {
    const acc = zero()
    foldStreamUsage( acc, {                                                 // message_start
      input_tokens: 412, cache_read_input_tokens: 5248,
      cache_creation_input_tokens: 90 } )
    foldStreamUsage( acc, { output_tokens: 733 } )                          // message_delta

    expect( acc ).toEqual({
      inputTok: 412, outputTok: 733, cacheReadTok: 5248, cacheWriteTok: 90 })
  })

  it('never lets a placeholder zero overwrite a figure already in hand', () => {
    // This is what makes the fold correct under EITHER ordering rather than
    // just the two seen above — a host may repeat the block with fields it has
    // not filled in yet, and a later zero must not erase a real reading.
    const acc = zero()
    foldStreamUsage( acc, { input_tokens: 412, output_tokens: 733 } )
    foldStreamUsage( acc, { input_tokens: 0,   output_tokens: 0   } )

    expect( acc.inputTok ).toBe( 412 )
    expect( acc.outputTok ).toBe( 733 )
  })

  it('takes the last real reading when output grows across events', () => {
    // `message_delta` reports a running total, not an increment.
    const acc = zero()
    foldStreamUsage( acc, { output_tokens: 120 } )
    foldStreamUsage( acc, { output_tokens: 733 } )
    expect( acc.outputTok ).toBe( 733 )
  })

  it('survives a usage block with nothing in it', () => {
    expect( foldStreamUsage( zero(), {} ) ).toEqual( zero() )
  })
})

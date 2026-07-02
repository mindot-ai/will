// ─────────────────────────────────────────────────────────────
// tests/unit/llm.completion.recording.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for LLM completion capture into the replay stream (FN3, scoped).
 *
 * FN3: LLM completions were never recorded anywhere in the replay path, so even
 * if deterministic re-execution existed the executive's behaviour-defining
 * outputs couldn't be reproduced. This captures each completion (input + output
 * + model/params) via a per-Will recorder seam. Re-execution/re-feed is deferred
 * to REORIENT R2 — this is the capture half only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LLMDirector } from '#llm/index'
import {
  setCompletionRecorder,
  clearCompletionRecorder,
  type LLMCompletionRecord,
} from '#core/completion.recorder'

describe( 'LLMDirector — completion recording (FN3)', () => {
  const willId = 'will-fn3-test'
  let captured: LLMCompletionRecord[]

  beforeEach( () => {
    captured = []
    setCompletionRecorder( willId, { recordCompletion: r => captured.push( r ) } )
  })
  afterEach( () => clearCompletionRecorder( willId ) )

  function makeDirector(){
    return new LLMDirector({
      willId,
      model:           'test-model',
      maxOutputTokens: 100,
      apiKey:          '',
      provider:        'anthropic',
      sessionLogger:   null,
      mock:            true,
    })
  }

  it( 'records a completion on call() with full input/output/params', async () => {
    const result = await makeDirector().call( 'SYSTEM', 'hello there', 7 )

    expect( captured ).toHaveLength( 1 )
    const rec = captured[0]!
    expect( rec.willId ).toBe( willId )
    expect( rec.tick ).toBe( 7 )
    expect( rec.provider ).toBe( 'anthropic' )
    expect( rec.model ).toBe( 'test-model' )
    expect( rec.maxOutputTokens ).toBe( 100 )
    expect( rec.systemPrompt ).toBe( 'SYSTEM' )
    expect( rec.userMessage ).toBe( 'hello there' )
    expect( rec.mock ).toBe( true )
    expect( rec.text ).toBe( result.text )
    expect( typeof rec.latencyMs ).toBe( 'number' )
  })

  it( 'records a completion on callStream()', async () => {
    await makeDirector().callStream( 'SYSTEM', 'hi', 3, () => {} )
    expect( captured ).toHaveLength( 1 )
    expect( captured[0]!.tick ).toBe( 3 )
  })

  it( 'does not record when no recorder is registered for the Will', async () => {
    clearCompletionRecorder( willId )
    await makeDirector().call( 'SYSTEM', 'hello', 1 )
    expect( captured ).toHaveLength( 0 )
  })

  it( 'routes completions only to the matching willId', async () => {
    const other: LLMCompletionRecord[] = []
    setCompletionRecorder( 'someone-else', { recordCompletion: r => other.push( r ) } )

    await makeDirector().call( 'SYSTEM', 'hello', 2 )

    expect( captured ).toHaveLength( 1 )
    expect( other ).toHaveLength( 0 )
    clearCompletionRecorder( 'someone-else' )
  })
})

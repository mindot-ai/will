// ─────────────────────────────────────────────────────────────
// tests/unit/llm.completion.replay.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the LLM-as-oracle re-feed (REORIENT R2-c).
 *
 * The recording half (llm.completion.recording.test.ts) captures every
 * completion. This is the replay half: with a completion source registered,
 * LLMDirector returns the recorded output instead of calling the model. The
 * source matches by tick and verifies the prompt, throwing on a miss or a
 * divergence so a replay can never silently re-call the non-deterministic LLM.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { LLMDirector } from '#llm/index'
import {
  RecordedCompletionSource,
  setCompletionSource,
  clearCompletionSource,
  type LLMCompletionRecord,
} from '#core/completion.recorder'

const willId = 'will-r2c-test'

function rec( over: Partial<LLMCompletionRecord> = {} ): LLMCompletionRecord {
  return {
    tick:            5,
    willId,
    provider:        'anthropic',
    model:           'test-model',
    maxOutputTokens: 100,
    systemPrompt:    'SYSTEM',
    userMessage:     'hello there',
    text:            'recorded-output',
    inputTok:        11,
    outputTok:       22,
    mock:            false,
    latencyMs:       3,
    timestamp:       0,
    ...over,
  }
}

function makeDirector(){
  return new LLMDirector({
    willId,
    model:           'test-model',
    maxOutputTokens: 100,
    apiKey:          '',
    provider:        'anthropic',
    sessionLogger:   null,
    mock:            true,   // re-feed must take precedence over the mock path
  })
}

describe('LLMDirector — replay re-feed (R2-c)', () => {
  afterEach( () => clearCompletionSource( willId ) )

  it('returns the recorded completion from call() instead of the mock', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([ rec() ]) )

    const result = await makeDirector().call('SYSTEM', 'hello there', 5 )

    expect( result.text ).toBe('recorded-output')
    expect( result.inputTok ).toBe( 11 )
    expect( result.outputTok ).toBe( 22 )
  })

  it('returns the recorded completion from callStream() and streams non-mock text', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([ rec() ]) )

    const chunks: string[] = []
    const result = await makeDirector().callStream('SYSTEM', 'hello there', 5, c => chunks.push( c ) )

    expect( result.text ).toBe('recorded-output')
    expect( chunks ).toEqual([ 'recorded-output' ])   // non-mock record → streamed
  })

  it('does not stream when the recorded completion was a mock', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([ rec({ mock: true }) ]) )

    const chunks: string[] = []
    await makeDirector().callStream('SYSTEM', 'hello there', 5, c => chunks.push( c ) )

    expect( chunks ).toEqual([] )   // mock record → not streamed, mirrors the live mock path
  })

  it('replays multiple same-tick completions in record order (FIFO)', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([
      rec({ text: 'first',  userMessage: 'q1' }),
      rec({ text: 'second', userMessage: 'q2' }),
    ]) )
    const d = makeDirector()

    expect( ( await d.call('SYSTEM', 'q1', 5 ) ).text ).toBe('first')
    expect( ( await d.call('SYSTEM', 'q2', 5 ) ).text ).toBe('second')
  })

  it('throws when the prompt diverges from the recording', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([ rec() ]) )

    await expect(
      makeDirector().call('SYSTEM', 'a different message', 5 )
    ).rejects.toThrow( /prompt diverged/ )
  })

  it('throws when no completion was recorded for the tick', async () => {
    setCompletionSource( willId, new RecordedCompletionSource([ rec({ tick: 5 }) ]) )

    await expect(
      makeDirector().call('SYSTEM', 'hello there', 9 )
    ).rejects.toThrow( /no recorded LLM completion for tick 9/ )
  })

  it('falls through to the live/mock path when no source is registered', async () => {
    const result = await makeDirector().call('SYSTEM', 'hello there', 5 )
    // The mock path returns structured JSON, never the recorded sentinel.
    expect( result.text ).not.toBe('recorded-output')
  })
})

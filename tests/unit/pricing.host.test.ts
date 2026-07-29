// ─────────────────────────────────────────────────────────────
// tests/unit/pricing.host.test.ts — MODEL_ROUTING W8
//
// The three properties this pass is for:
//   1. dollars are NOT in simulation state (tokens still are)
//   2. host prices win, and reach models the engine has never heard of
//   3. an unpriced model is VISIBLE (cost 0 + priced:false), never silently
//      billed at some default rate
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'

import { TokenTracker, resolvePricing, type RecordUsageInput } from '#cognition/utilities/token.tracker'
import { mergeProviderPrices, providerCredentials } from '#stem/mind'

const usage = ( over: Partial<RecordUsageInput> = {} ): RecordUsageInput => ( {
  model:            'claude-haiku-4-5',
  promptTokens:     1_000_000,
  completionTokens: 0,
  totalTokens:      1_000_000,
  category:         'executive',
  attribute:        'master',
  function:         'decision',
  tick:             1,
  latencyMs:        0,
  ...over,
} )

/** Metric keys a tracker writes into simulation state on a tick. */
async function metricKeys( t: TokenTracker ): Promise<string[]> {
  t.recordUsage( usage() )
  const result = await t.react( 1 as never, 1 as never, {} as never, {} as never )
  return ( result.commands?.metrics ?? [] ).map( ( [ k ] ) => k as string )
}

describe('dollars are not simulation state (W8c)', () => {

  it('writes token metrics but no cost metrics', async () => {
    const keys = await metricKeys( new TokenTracker() )

    expect( keys ).toContain('llm.prompt_tokens_total')
    expect( keys ).toContain('llm.completion_tokens_total')
    expect( keys ).toContain('llm.total_calls')

    const costKeys = keys.filter( k => k.includes('cost') )
    expect(
      costKeys,
      `cost leaked into state: ${costKeys.join(', ')} — a host editing its price ` +
      `table would then change state bytes and break replay over a number ` +
      `nothing reads`
    ).toEqual( [] )
  })

  it('still exposes cost in-process, for the host that wants it', () => {
    const t = new TokenTracker()
    t.recordUsage( usage() )
    expect( t.totalCostUsd ).toBeGreaterThan( 0 )
  })

  it('per-category breakdown keeps tokens in state, not dollars', async () => {
    const keys = await metricKeys( new TokenTracker() )
    expect( keys.some( k => k.startsWith('llm.prompt_tokens.') ) ).toBe( true )
    expect( keys.some( k => k.startsWith('llm.cost.') ) ).toBe( false )
  })
})

describe('host prices (W8a/W8b)', () => {

  it('host prices override the built-in table', () => {
    const t = new TokenTracker({ prices: { 'claude-haiku-4-5': { input: 10, output: 0 } } })
    t.recordUsage( usage() )          // 1M prompt tokens
    expect( t.totalCostUsd ).toBeCloseTo( 10, 6 )   // not the built-in $1.00
  })

  it('prices a model the engine has never heard of', () => {
    const t = new TokenTracker({ prices: { 'kimi-k2.5': { input: 0.6, output: 3 } } })
    t.recordUsage( usage({ model: 'kimi-k2.5' }) )
    expect( t.totalCostUsd ).toBeCloseTo( 0.6, 6 )
  })

  it('matches host prices through id normalization (dates, provider prefixes)', () => {
    const host = { 'kimi-k2.5': { input: 1, output: 1 } }
    expect( resolvePricing('moonshot/kimi-k2.5', host ) ).toEqual( { input: 1, output: 1 } )
  })
})

describe('unpriced is visible, never a silent default (W8b)', () => {

  it('reports cost 0 and priced:false rather than guessing', () => {
    const t = new TokenTracker()
    let record: { costUsd: number; priced: boolean } | null = null
    t.onRecord( r => { record = r as never } )

    t.recordUsage( usage({ model: 'some-model-nobody-priced' }) )

    expect( record ).not.toBeNull()
    expect( record!.priced ).toBe( false )
    expect( record!.costUsd ).toBe( 0 )
    expect( t.totalCostUsd ).toBe( 0 )
  })

  it('marks priced:true when a price was actually found', () => {
    const t = new TokenTracker()
    let record: { priced: boolean } | null = null
    t.onRecord( r => { record = r as never } )
    t.recordUsage( usage() )
    expect( record!.priced ).toBe( true )
  })

  it('resolves unknown models to null — the old $3/$15 default is gone', () => {
    // Regression guard: the removed default silently applied Sonnet's rate to
    // anything unrecognised, overstating a budget model's output by ~54×.
    expect( resolvePricing('totally-unknown-model') ).toBeNull()
  })
})

describe('the provider map splits cleanly (W8a)', () => {

  const providers = {
    anthropic: { apiKey: 'a-key', prices: { 'claude-sonnet-5': { input: 3, output: 15 } } },
    deepseek:  { apiKey: 'd-key', baseUrl: 'https://x', prices: { 'deepseek-v4-flash': { input: 0.14, output: 0.28 } } },
    google:    { prices: { 'gemini-3.1-pro': { input: 2, output: 12 } } },   // no key
  } as const

  it('merges every provider\'s prices into one table', () => {
    const merged = mergeProviderPrices( providers )
    expect( Object.keys( merged! ).sort() ).toEqual(
      [ 'claude-sonnet-5', 'deepseek-v4-flash', 'gemini-3.1-pro' ]
    )
  })

  it('carries credentials without prices — pricing never enters the call path', () => {
    const creds = providerCredentials( providers )
    expect( creds.anthropic ).toEqual( { apiKey: 'a-key' } )
    expect( creds.deepseek ).toEqual( { apiKey: 'd-key', baseUrl: 'https://x' } )
    expect( JSON.stringify( creds ) ).not.toContain('input')
  })

  it('drops a provider with prices but no key — unusable for routing, still priced', () => {
    // A host may want cost telemetry for a provider it reaches some other way.
    expect( providerCredentials( providers ).google ).toBeUndefined()
    expect( mergeProviderPrices( providers )![ 'gemini-3.1-pro' ] ).toEqual( { input: 2, output: 12 } )
  })

  it('returns undefined for no providers, so the tracker keeps its fallback', () => {
    expect( mergeProviderPrices( undefined ) ).toBeUndefined()
    expect( mergeProviderPrices( {} ) ).toBeUndefined()
  })
})

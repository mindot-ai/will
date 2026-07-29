// ─────────────────────────────────────────────────────────────
// tests/unit/token.tracker.pricing.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for TokenTracker cost correctness + 5-axis attribution.
 *
 * Regression targets:
 *  1. Model-id normalization — a raw provider model string like
 *     "claude-haiku-4-5-20250101" used to miss the `provider/model` pricing keys
 *     and silently fall through to __default__ ($3/$15), pricing Haiku ~3× and
 *     DeepSeek ~11× too high. resolvePricing() must match by bare, dateless name.
 *  2. Prompt-cache pricing — cache reads cost 0.1× input, cache writes 1.25×.
 *  3. Attribution repartition — category × function breakdowns + auto-composed
 *     labels (category | attribute | function | scope? | label).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { TokenTracker, resolvePricing } from '#cognition/utilities/token.tracker'

function usage( over: Partial<Parameters<TokenTracker['recordUsage']>[0]> = {} ) {
  return {
    model:            'claude-sonnet-4-5',
    promptTokens:     0,
    completionTokens: 0,
    totalTokens:      0,
    category:         'executive',
    attribute:        'master',
    function:         'decision',
    tick:             1,
    latencyMs:        0,
    ...over,
  }
}

describe('TokenTracker — model-id normalization (resolvePricing)', () => {
  it('resolves a dated Anthropic Haiku id to Haiku pricing', () => {
    const p = resolvePricing('claude-haiku-4-5-20250101')
    expect( p?.input ).toBe( 1.00 )
    expect( p?.output ).toBe( 5.00 )
  } )

  it('resolves a provider-prefixed id and a bare id to the same row', () => {
    expect( resolvePricing('anthropic/claude-sonnet-4-5') ).toEqual( resolvePricing('claude-sonnet-4-5-20250929') )
  } )

  it('resolves DeepSeek to its real (cheap) pricing, not the default', () => {
    expect( resolvePricing('deepseek-v3')?.input ).toBe( 0.27 )
  } )

  // BEHAVIOUR CHANGE (W8b): an unknown model used to resolve to a $3/$15
  // default — Sonnet's rate silently applied to anything unrecognised, which
  // overstated a budget model's output cost by ~54× while looking
  // authoritative. Unknown now resolves to null: unknown, not "probably Sonnet".
  it('returns null for a genuinely unknown model — unknown, never a guess', () => {
    expect( resolvePricing('mistral:7b') ).toBeNull()
  } )

  it('lets host-supplied prices win over the built-in table', () => {
    const host = { 'claude-haiku-4-5': { input: 0.5, output: 2 } }
    expect( resolvePricing('claude-haiku-4-5-20250101', host ) ).toEqual( { input: 0.5, output: 2 } )
  } )

  it('prices a model the built-in table has never heard of, from host config', () => {
    const host = { 'kimi-k2.5': { input: 0.6, output: 3 } }
    expect( resolvePricing('moonshot/kimi-k2.5', host )?.output ).toBe( 3 )
  } )
} )

describe('TokenTracker — cost accounting', () => {
  it('prices a dated Haiku call at Haiku rates (1M in → $1.00)', () => {
    const t = new TokenTracker()
    t.recordUsage( usage( { model: 'claude-haiku-4-5-20250101', promptTokens: 1_000_000 } ) )
    expect( t.totalCostUsd ).toBeCloseTo( 1.00, 6 )
  } )

  it('prices cache reads at 0.1× input and cache writes at 1.25× input', () => {
    const t = new TokenTracker()
    // Sonnet input $3/MTok: read 1M → $0.30, write 1M → $3.75
    t.recordUsage( usage( { model: 'claude-sonnet-4-5', cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 } ) )
    expect( t.totalCostUsd ).toBeCloseTo( 0.30 + 3.75, 6 )
  } )

  it('prices embeddings as input-only at the embedding rate', () => {
    const t = new TokenTracker()
    // text-embedding-3-small $0.02/MTok input, no output cost
    t.recordUsage( usage( { category: 'embedding', attribute: 'memory', function: 'recall', model: 'text-embedding-3-small', promptTokens: 1_000_000 } ) )
    expect( t.totalCostUsd ).toBeCloseTo( 0.02, 6 )
  } )
} )

describe('TokenTracker — 5-axis repartition', () => {
  it('splits tokens by category (executive vs summarizer vs embedding)', () => {
    const t = new TokenTracker()
    t.recordUsage( usage( { category: 'executive', promptTokens: 200, completionTokens: 80 } ) )
    t.recordUsage( usage( { category: 'summarizer', attribute: 'memory', function: 'consolidation', promptTokens: 100, completionTokens: 30 } ) )
    t.recordUsage( usage( { category: 'embedding', attribute: 'memory', function: 'index', model: 'text-embedding-3-small', promptTokens: 500 } ) )

    const byCat = t.categoryTokenBreakdown
    expect( byCat.get('executive') ).toEqual( { prompt: 200, completion: 80 } )
    expect( byCat.get('summarizer') ).toEqual( { prompt: 100, completion: 30 } )
    expect( byCat.get('embedding')?.prompt ).toBe( 500 )
  } )

  it('splits cost by function (decision vs ideation vs conversation)', () => {
    const t = new TokenTracker()
    t.recordUsage( usage( { function: 'decision',     model: 'claude-sonnet-4-5', completionTokens: 1_000_000 } ) ) // $15
    t.recordUsage( usage( { function: 'ideation',     model: 'claude-sonnet-4-5', completionTokens: 1_000_000 } ) ) // $15
    t.recordUsage( usage( { attribute: 'facet', function: 'conversation', model: 'claude-sonnet-4-5', completionTokens: 2_000_000 } ) ) // $30

    const byFn = t.functionBreakdown
    expect( byFn.get('decision') ).toBeCloseTo( 15, 4 )
    expect( byFn.get('ideation') ).toBeCloseTo( 15, 4 )
    expect( byFn.get('conversation') ).toBeCloseTo( 30, 4 )
  } )

  it('auto-composes a label from the axes when the caller omits it', () => {
    const t = new TokenTracker()
    t.recordUsage( usage( { category: 'executive', attribute: 'facet', function: 'conversation', scope: 'facet-7', promptTokens: 10 } ) )
    const last = t.getUsageLog().at( -1 )!
    expect( last.label ).toBe('executive/facet/conversation#facet-7')
  } )

  it('keeps a caller-supplied label verbatim', () => {
    const t = new TokenTracker()
    t.recordUsage( usage( { label: 'custom-label', promptTokens: 10 } ) )
    expect( t.getUsageLog().at( -1 )!.label ).toBe('custom-label')
  } )
} )

describe('TokenTracker — attributed on-disk ledger (token-report.jsonl)', () => {
  const willId = `__test-ledger-${Math.random().toString( 36 ).slice( 2 )}`
  const path   = `./data/wills/${willId}/debug/token-report.jsonl`

  afterEach( () => rmSync(`./data/wills/${willId}`, { recursive: true, force: true } ) )

  it('appends a fully-attributed, costed line per call when enabled', () => {
    const t = new TokenTracker({ willId, writeLedger: true })
    t.recordUsage( usage( { category: 'executive', attribute: 'facet', function: 'conversation', scope: 'facet-7', model: 'claude-sonnet-4-5', promptTokens: 100, completionTokens: 200 } ) )
    t.recordUsage( usage( { category: 'embedding', attribute: 'memory', function: 'index', model: 'text-embedding-3-small', promptTokens: 500 } ) )

    const lines = readFileSync( path, 'utf8').trim().split('\n').map( l => JSON.parse( l ) )
    expect( lines ).toHaveLength( 2 )
    expect( lines[0] ).toMatchObject({
      category: 'executive', attribute: 'facet', function: 'conversation', scope: 'facet-7',
      label: 'executive/facet/conversation#facet-7', inputTok: 100, outputTok: 200,
    })
    expect( lines[0].costUsd ).toBeCloseTo( 100 * 3 / 1e6 + 200 * 15 / 1e6, 8 )
    expect( lines[1] ).toMatchObject({ category: 'embedding', function: 'index' })
  } )

  it('writes nothing when the ledger is disabled (default)', () => {
    const t = new TokenTracker({ willId })   // writeLedger omitted → off
    t.recordUsage( usage( { promptTokens: 10 } ) )
    expect( existsSync( path ) ).toBe( false )
  } )
} )

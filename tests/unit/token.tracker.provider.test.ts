// ─────────────────────────────────────────────────────────────
// tests/unit/token.tracker.provider.test.ts
//
// Per-provider cost attribution.
//
// The completion tape has always recorded which provider served a call — that
// is what replay depends on. The COST ledger never did: it carried `model` and
// nothing else, so a host billing across a multi-vendor routing table could
// attribute spend to a model but never to the vendor it actually paid.
//
// Model is not a proxy for provider, and routing is precisely what breaks the
// correspondence: one model id is reachable direct, through a gateway, or
// self-hosted, at prices that differ by orders of magnitude.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { TokenTracker, type RecordUsageInput } from '#cognition/utilities/token.tracker'

const PRICES = {
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'glm-5.2':           { input: 1.40, output:  4.40 },
} as const

const tracker = () => new TokenTracker( { prices: { ...PRICES } } as never )

function usage( over: Partial<RecordUsageInput> = {} ): RecordUsageInput {
  return {
    model: 'claude-sonnet-4-5', promptTokens: 0, completionTokens: 0, totalTokens: 0,
    category: 'executive', attribute: 'master', process: 'decision', function: '-',
    tick: 1, latencyMs: 0, ...over,
  }
}

describe('TokenTracker — per-provider attribution', () => {

  it('splits spend by the provider that served each call', () => {
    const t = tracker()
    t.recordUsage( usage( { provider: 'anthropic', model: 'claude-sonnet-4-5', completionTokens: 1_000_000 } ) ) // $15
    t.recordUsage( usage( { provider: 'glm', model: 'glm-5.2', completionTokens: 1_000_000 } ) )                 // $4.40

    const byProvider = t.providerBreakdown
    expect( byProvider.get('anthropic') ).toBeCloseTo( 15.0, 4 )
    expect( byProvider.get('glm') ).toBeCloseTo( 4.4, 4 )
  } )

  it('separates the same model reached through two providers', () => {
    // The case that makes model-alone insufficient: routing can serve one model
    // id from a vendor, a gateway, or a self-host, and the bills differ.
    const t = tracker()
    t.recordUsage( usage( { provider: 'glm',  model: 'glm-5.2', promptTokens: 1_000_000 } ) )
    t.recordUsage( usage( { provider: 'vllm', model: 'glm-5.2', promptTokens: 1_000_000 } ) )

    expect( t.providerBreakdown.get('glm') ).toBeCloseTo( 1.4, 4 )
    expect( t.providerBreakdown.get('vllm') ).toBeCloseTo( 1.4, 4 )
    expect( t.providerTokenBreakdown.get('vllm')?.prompt ).toBe( 1_000_000 )
  } )

  it('buckets usage recorded without a provider as unattributed, never as the default', () => {
    // A caller outside the LLM director may not know the provider. Folding that
    // into whichever vendor looked likely would put invented spend on a real
    // invoice line.
    const t = tracker()
    t.recordUsage( usage( { completionTokens: 1_000_000 } ) )   // no provider
    expect( t.providerBreakdown.get('unattributed') ).toBeCloseTo( 15.0, 4 )
    expect( t.providerBreakdown.get('anthropic') ).toBeUndefined()
  } )

  it('carries the provider onto the ledger record a host persists', () => {
    const t = tracker()
    const seen: Record<string, unknown>[] = []
    t.onRecord( r => { seen.push( r ) } )
    t.recordUsage( usage( { provider: 'moonshot', model: 'kimi-k2.5', promptTokens: 10 } ) )

    expect( seen[0]!.provider ).toBe('moonshot')
    // Unpriced here (no kimi row): cost 0 with priced:false, so a host summing
    // the ledger can tell "nothing priced it" from "it was free".
    expect( seen[0]!.priced ).toBe( false )
    expect( seen[0]!.costUsd ).toBe( 0 )
  } )

  it('records the demand the router saw, so routing can be answered not argued', () => {
    const t = tracker()
    const seen: Record<string, unknown>[] = []
    t.onRecord( r => { seen.push( r ) } )
    t.recordUsage( usage( { provider: 'anthropic', demand: 0.82, promptTokens: 10 } ) )
    expect( seen[0]!.demand ).toBe( 0.82 )
  } )

  it('leaves unmeasured demand undefined — never 0', () => {
    // A call that reported no demand and a call that reported 0.0 are different
    // facts. Collapsing them puts a floor of invented confidence under exactly
    // the analysis this field exists to enable.
    const t = tracker()
    const seen: Record<string, unknown>[] = []
    t.onRecord( r => { seen.push( r ) } )
    t.recordUsage( usage( { provider: 'anthropic', promptTokens: 10 } ) )          // no demand
    t.recordUsage( usage( { provider: 'anthropic', demand: 0, promptTokens: 10 } ) ) // measured zero

    expect( seen[0]!.demand ).toBeUndefined()
    expect( seen[1]!.demand ).toBe( 0 )
  } )

  it('clears provider buckets on reset', () => {
    const t = tracker()
    t.recordUsage( usage( { provider: 'anthropic', completionTokens: 1000 } ) )
    t.reset()
    expect( t.providerBreakdown.size ).toBe( 0 )
  } )
} )

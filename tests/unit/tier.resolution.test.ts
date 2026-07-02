// ─────────────────────────────────────────────────────────────
// tests/unit/tier.resolution.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Pricing tiers must resolve to a real per-Will model + cadence:
 *  - modelTier → model id (env WILL_LLM_MODEL overrides; tier map applies when unset)
 *  - engineTier → executive cadence (default), overridable via executiveInterval,
 *    clamped by minExecutiveInterval.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolveModelId, resolveExecutiveInterval, EXECUTIVE_CADENCE } from '#stem/mind'
import type { WillConfig } from '#stem/mind'

const cfg = ( over: Partial<WillConfig> = {} ): WillConfig => ( {
  id: 'w', name: 'w', profile: null,
  identity: { prompt: '', values: [], traits: {}, style: '' },
  engineTier: 'full', modelTier: 'sonnet',
  persistentMemory: false, snapshotInterval: 999, randomSeed: 1,
  ...over,
} as WillConfig )

describe( 'resolveModelId — modelTier → model (per-Will)', () => {
  const saved = process.env['WILL_LLM_MODEL']
  afterEach( () => {
    if( saved === undefined ) delete process.env['WILL_LLM_MODEL']
    else process.env['WILL_LLM_MODEL'] = saved
  } )

  it( 'maps each anthropic tier to a distinct model when env is unset', () => {
    delete process.env['WILL_LLM_MODEL']
    expect( resolveModelId( 'anthropic', 'haiku' ) ).toBe( 'claude-haiku-4-5-20251001' )
    expect( resolveModelId( 'anthropic', 'sonnet' ) ).toBe( 'claude-sonnet-4-5-20250929' )
    expect( resolveModelId( 'anthropic', 'opus' ) ).toBe( 'claude-opus-4-7' )
  } )

  it( 'lets an explicit WILL_LLM_MODEL env win (operator pin / self-hosting)', () => {
    process.env['WILL_LLM_MODEL'] = 'mistral:7b'
    expect( resolveModelId( 'anthropic', 'haiku' ) ).toBe( 'mistral:7b' )
    expect( resolveModelId( 'openai', 'sonnet' ) ).toBe( 'mistral:7b' )
  } )

  it( 'returns undefined for an unmapped provider with no env (director default applies)', () => {
    delete process.env['WILL_LLM_MODEL']
    expect( resolveModelId( 'openai', 'sonnet' ) ).toBeUndefined()
  } )
} )

describe( 'resolveExecutiveInterval — engineTier → cadence', () => {
  it( 'uses the tier default: Starter (standard)=economy/90, Pro (full)=balanced/60', () => {
    expect( resolveExecutiveInterval( 'standard', cfg({ engineTier: 'standard' }) ) ).toBe( EXECUTIVE_CADENCE.economy )
    expect( resolveExecutiveInterval( 'full', cfg({ engineTier: 'full' }) ) ).toBe( EXECUTIVE_CADENCE.balanced )
    expect( EXECUTIVE_CADENCE ).toMatchObject({ responsive: 30, balanced: 60, economy: 90 })
  } )

  it( 'honours an executiveInterval override (e.g. responsive 30 for premium)', () => {
    expect( resolveExecutiveInterval( 'full', cfg({ executiveInterval: 30 }) ) ).toBe( 30 )
  } )

  it( 'clamps the override up to minExecutiveInterval (plan floor)', () => {
    expect( resolveExecutiveInterval( 'full', cfg({ executiveInterval: 20, minExecutiveInterval: 60 }) ) ).toBe( 60 )
  } )
} )

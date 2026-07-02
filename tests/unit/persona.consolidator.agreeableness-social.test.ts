// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.agreeableness-social.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Further agreeableness facets develop across the social system (constants → Channel-A
 * lift): empathic resonance (empathy.resonanceStrength↑, tender-mindedness) and bonding
 * (attachment.attachmentGrowthRate↑, altruism). Distinct from warmth (reward.socialWeight)
 * and yielding (frustration.angerReactivity). Bounded + decaying; absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, agreeableness: number ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { agreeableness } },
  } )
  entities.set( 'engine-config-empathy', {
    id: 'engine-config-empathy', type: 'engine-config', metadata: { params: { resonanceStrength: 0.6 } },
  } )
  entities.set( 'engine-config-attachment', {
    id: 'engine-config-attachment', type: 'engine-config', metadata: { params: { attachmentGrowthRate: 0.05 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, id: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata?.priors?.[ id ]

describe( 'PersonaConsolidator — empathy + attachment develop from agreeableness', () => {
  it( 'demonstrated agreeableness raises empathic resonance + attachment growth', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r, 'engine-config-empathy' )?.resonanceStrength ).toBeGreaterThan( 0 )
    expect( priorFor( r, 'engine-config-attachment' )?.attachmentGrowthRate ).toBeGreaterThan( 0 )
    expect( priorFor( r, 'engine-config-empathy' )?.resonanceStrength ).toBeLessThanOrEqual( 0.5 * 0.6 ) // cumulative cap
  } )

  it( 'neutral agreeableness leaves both unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-empathy' )?.resonanceStrength ?? 0 ).toBe( 0 )
    expect( priorFor( r, 'engine-config-attachment' )?.attachmentGrowthRate ?? 0 ).toBe( 0 )
  } )
} )

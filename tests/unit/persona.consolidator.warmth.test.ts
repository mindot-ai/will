// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.warmth.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Warmth intensity/persistence develops from agreeableness (closes the 🟢 Strong tier of
 * the constants catalogue). An agreeable Will is warmed MORE by each positive interaction
 * (reward.socialWarmthBoost↑) and the warmth LINGERS (reward.socialDecayRate↓). Distinct
 * from socialWeight (#6, how much social reward counts in the total). Bounded + decaying.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, agreeableness: number ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { agreeableness } },
  } )
  entities.set( 'engine-config-reward', {
    id: 'engine-config-reward', type: 'engine-config',
    metadata: { params: { socialWarmthBoost: 0.4, socialDecayRate: 0.02 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata?.priors?.[ 'engine-config-reward' ]

describe( 'PersonaConsolidator — warmth intensity/persistence develops from agreeableness', () => {
  it( 'raises warmth boost and lowers warmth decay (warmed more, lingers longer)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r )?.socialWarmthBoost ).toBeGreaterThan( 0 )
    expect( priorFor( r )?.socialDecayRate ).toBeLessThan( 0 )
    expect( priorFor( r )?.socialWarmthBoost ).toBeLessThanOrEqual( 0.5 * 0.4 ) // cumulative cap
  } )

  it( 'neutral agreeableness leaves both unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.socialWarmthBoost ?? 0 ).toBe( 0 )
    expect( priorFor( r )?.socialDecayRate ?? 0 ).toBe( 0 )
  } )
} )

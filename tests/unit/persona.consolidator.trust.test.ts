// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.trust.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The trust facet of agreeableness develops (constants → Channel-A lift). An agreeable Will
 * credits cooperation more readily — a larger reputation trust step (trustGrowthStep↑), so
 * it extends benefit-of-the-doubt faster. Distinct from warmth/yielding/empathy/attachment.
 * Bounded + decaying; absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, agreeableness: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { agreeableness } },
  } )
  entities.set('engine-config-reputation', {
    id: 'engine-config-reputation', type: 'engine-config', metadata: { params: { trustGrowthStep: 0.05 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata?.priors?.[ 'engine-config-reputation' ]

describe('PersonaConsolidator — trust facet develops from agreeableness', () => {
  it('demonstrated agreeableness raises the reputation trust step (extends trust faster)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r )?.trustGrowthStep ).toBeGreaterThan( 0 )
    expect( priorFor( r )?.trustGrowthStep ).toBeLessThanOrEqual( 0.5 * 0.05 ) // cumulative cap
  } )

  it('neutral agreeableness leaves the trust step unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.trustGrowthStep ?? 0 ).toBe( 0 )
  } )
} )

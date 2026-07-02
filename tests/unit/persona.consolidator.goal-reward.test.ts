// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.goal-reward.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Achievement-striving develops from conscientiousness (constants → Channel-A lift): goal
 * completion becomes more rewarding (reward.goalWeight↑), so a conscientious Will is more
 * motivated toward finishing what it starts. Distinct from planning follow-through (rule
 * 11) and impulse control (rule 15c). Bounded + decaying; absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, conscientiousness: number ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { conscientiousness } },
  } )
  entities.set( 'engine-config-reward', {
    id: 'engine-config-reward', type: 'engine-config', metadata: { params: { goalWeight: 0.4 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata?.priors?.[ 'engine-config-reward' ]

describe( 'PersonaConsolidator — achievement-striving develops from conscientiousness', () => {
  it( 'demonstrated conscientiousness makes goal completion more rewarding (goalWeight↑)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r )?.goalWeight ).toBeGreaterThan( 0 )
    expect( priorFor( r )?.goalWeight ).toBeLessThanOrEqual( 0.5 * 0.4 ) // cumulative cap
  } )

  it( 'neutral conscientiousness leaves goal weighting unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.goalWeight ?? 0 ).toBe( 0 )
  } )
} )

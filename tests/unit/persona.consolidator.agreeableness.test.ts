// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.agreeableness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Social stance develops via metacognition (TODO edge #6). The PersonaConsolidator reads
 * the self-model's `agreeableness` trait (formed from the Will's own social/helping
 * behaviour) and writes a persona-prior delta onto the reward engine's `socialWeight`: an
 * agreeable Will finds connection more rewarding, so positive interaction counts for more
 * in its reward signal — a real Channel-A lever beneath deliberation, not just in-character
 * phrasing. Bounded + decaying; absent signal → no push (decays back to baseline).
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
    metadata: { params: { socialWeight: 0.25 } },
  } )
  entities.set( 'engine-config-frustration', {
    id: 'engine-config-frustration', type: 'engine-config',
    metadata: { params: { angerReactivity: 0.7 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, engineConfigId: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata
    ?.priors?.[ engineConfigId ]

describe( 'PersonaConsolidator — social stance develops from agreeableness', () => {
  it( 'warmth facet: demonstrated agreeableness raises how much social warmth is valued (socialWeight↑)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const rw = priorFor( r, 'engine-config-reward' )
    expect( rw?.socialWeight ).toBeGreaterThan( 0 )              // values connection more
    expect( rw?.socialWeight ).toBeLessThanOrEqual( 0.5 * 0.25 ) // bounded by the cumulative cap (½·base)
  } )

  it( 'yielding facet: demonstrated agreeableness lowers anger reactivity (accommodate, not retaliate)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const fr = priorFor( r, 'engine-config-frustration' )
    expect( fr?.angerReactivity ).toBeLessThan( 0 )                    // bristles less when wronged
    expect( fr?.angerReactivity ).toBeGreaterThanOrEqual( -0.5 * 0.7 ) // bounded by the cumulative cap (½·base)
  } )

  it( 'neutral agreeableness leaves both facets unpushed (decays back to baseline)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-reward' )?.socialWeight ?? 0 ).toBe( 0 )
    expect( priorFor( r, 'engine-config-frustration' )?.angerReactivity ?? 0 ).toBe( 0 )
  } )
} )

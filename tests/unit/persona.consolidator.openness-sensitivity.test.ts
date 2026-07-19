// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.openness-sensitivity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Perceptual/aesthetic sensitivity develops from openness (constants → Channel-A lift).
 * An open Will registers novelty more readily (novelty.significanceThreshold↓) and is
 * moved to awe by beauty more easily (aesthetic.aweThreshold↓). Bounded + decaying;
 * absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, openness: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { openness } },
  } )
  entities.set('engine-config-novelty', {
    id: 'engine-config-novelty', type: 'engine-config', metadata: { params: { significanceThreshold: 0.4 } },
  } )
  entities.set('engine-config-aesthetic', {
    id: 'engine-config-aesthetic', type: 'engine-config', metadata: { params: { aweThreshold: 0.8 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, id: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata?.priors?.[ id ]

describe('PersonaConsolidator — perceptual/aesthetic sensitivity develops from openness', () => {
  it('demonstrated openness lowers novelty + awe thresholds (more sensitive)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r, 'engine-config-novelty')?.significanceThreshold ).toBeLessThan( 0 )
    expect( priorFor( r, 'engine-config-aesthetic')?.aweThreshold ).toBeLessThan( 0 )
    expect( priorFor( r, 'engine-config-aesthetic')?.aweThreshold ).toBeGreaterThanOrEqual( -0.5 * 0.8 ) // cumulative cap
  } )

  it('neutral openness leaves both unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-novelty')?.significanceThreshold ?? 0 ).toBe( 0 )
    expect( priorFor( r, 'engine-config-aesthetic')?.aweThreshold ?? 0 ).toBe( 0 )
  } )
} )

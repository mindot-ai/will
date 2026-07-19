// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.stability-affect.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The threat/stress response develops from emotional-stability (constants → Channel-A
 * lift). A steadier Will is harder to alarm (threat.fearEventThreshold↑) and sheds stress
 * faster (stress.baseDecayRate↑) — distinct affect faculties from #5's frustration build
 * rate. Bounded + decaying; absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, emotionalStability: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { 'emotional-stability': emotionalStability } },
  } )
  entities.set('engine-config-threat', {
    id: 'engine-config-threat', type: 'engine-config', metadata: { params: { fearEventThreshold: 0.6 } },
  } )
  entities.set('engine-config-stress', {
    id: 'engine-config-stress', type: 'engine-config', metadata: { params: { baseDecayRate: 0.05 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, id: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata?.priors?.[ id ]

describe('PersonaConsolidator — threat/stress response develops from emotional stability', () => {
  it('demonstrated stability raises fear threshold + stress decay (harder to alarm, settles faster)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r, 'engine-config-threat')?.fearEventThreshold ).toBeGreaterThan( 0 )
    expect( priorFor( r, 'engine-config-stress')?.baseDecayRate ).toBeGreaterThan( 0 )
    expect( priorFor( r, 'engine-config-threat')?.fearEventThreshold ).toBeLessThanOrEqual( 0.5 * 0.6 ) // cumulative cap
  } )

  it('neutral stability leaves both unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-threat')?.fearEventThreshold ?? 0 ).toBe( 0 )
    expect( priorFor( r, 'engine-config-stress')?.baseDecayRate ?? 0 ).toBe( 0 )
  } )
} )

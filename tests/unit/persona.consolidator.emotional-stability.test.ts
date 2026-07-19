// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.emotional-stability.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Affect reactivity develops via metacognition. The PersonaConsolidator reads the
 * self-model's `emotional-stability` trait (formed from the Will's own observed affect
 * dynamics, not a task success rate) and writes a persona-prior delta onto the
 * frustration engine's Channel A build-rate — so a steadier Will lets low-grade
 * frustration snowball into chronic irritability more slowly (`irritabilityRate↓`).
 *
 * This is a distinct axis from resilience: resilience tunes how much frustration is
 * *tolerated* (frustrationTolerance), emotional-stability how fast it *builds*. Bounded
 * + decaying by consolidatePrior; absent signal → no push (decays back to baseline).
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, emotionalStability: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { 'emotional-stability': emotionalStability } },
  } )
  entities.set('engine-config-frustration', {
    id: 'engine-config-frustration', type: 'engine-config',
    metadata: { params: { irritabilityRate: 0.02 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata
    ?.priors?.[ 'engine-config-frustration' ]

describe('PersonaConsolidator — affect build-rate develops from emotional stability', () => {
  it('demonstrated stability slows the frustration build-rate (irritabilityRate↓)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const fr = priorFor( r )
    expect( fr?.irritabilityRate ).toBeLessThan( 0 )                    // steadier ⇒ frustration snowballs slower
    expect( fr?.irritabilityRate ).toBeGreaterThanOrEqual( -0.02 * 0.5 ) // bounded by the cumulative cap (½·base)
  } )

  it('neutral stability leaves the build-rate unpushed (decays back to baseline)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.irritabilityRate ?? 0 ).toBe( 0 )
  } )
} )

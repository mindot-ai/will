// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.resilience-recovery.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The recovery facet of resilience develops (medium-tier constants → Channel-A): a
 * resilient Will shakes off a bad patch faster — a higher frustration decay rate
 * (frustration.decayRate↑). Distinct from resilience's frustrationTolerance (how much is
 * endured, #10) and emotional-stability's build rate (#5). Bounded + decaying.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, resilience: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { resilience } },
  } )
  entities.set('engine-config-frustration', {
    id: 'engine-config-frustration', type: 'engine-config', metadata: { params: { decayRate: 0.08 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata?.priors?.[ 'engine-config-frustration' ]

describe('PersonaConsolidator — recovery facet develops from resilience', () => {
  it('demonstrated resilience raises frustration decay (recovers faster)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r )?.decayRate ).toBeGreaterThan( 0 )
    expect( priorFor( r )?.decayRate ).toBeLessThanOrEqual( 0.5 * 0.08 ) // cumulative cap
  } )

  it('neutral resilience leaves the decay rate unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.decayRate ?? 0 ).toBe( 0 )
  } )
} )

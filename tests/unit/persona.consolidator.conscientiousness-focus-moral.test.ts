// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.conscientiousness-focus-moral.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Two more conscientiousness facets develop (medium-tier constants → Channel-A):
 * self-discipline of attention (task-switcher.baseSwitchCost↑ — less distractible) and
 * dutifulness (moral.eventThreshold↓ — more morally self-evaluative). Distinct from
 * planning follow-through / impulse control / goal reward. Bounded + decaying.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, conscientiousness: number ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { conscientiousness } },
  } )
  entities.set( 'engine-config-task-switcher', {
    id: 'engine-config-task-switcher', type: 'engine-config', metadata: { params: { baseSwitchCost: 0.3 } },
  } )
  entities.set( 'engine-config-moral', {
    id: 'engine-config-moral', type: 'engine-config', metadata: { params: { eventThreshold: 0.3 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, id: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata?.priors?.[ id ]

describe( 'PersonaConsolidator — focus + moral facets develop from conscientiousness', () => {
  it( 'demonstrated conscientiousness raises switch cost (less distractible) + lowers moral threshold (more dutiful)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r, 'engine-config-task-switcher' )?.baseSwitchCost ).toBeGreaterThan( 0 )
    expect( priorFor( r, 'engine-config-moral' )?.eventThreshold ).toBeLessThan( 0 )
  } )

  it( 'neutral conscientiousness leaves both unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-task-switcher' )?.baseSwitchCost ?? 0 ).toBe( 0 )
    expect( priorFor( r, 'engine-config-moral' )?.eventThreshold ?? 0 ).toBe( 0 )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.known-entity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Channel A for the known-entity tracker (rules 33–35). How the Will comes to know
 * someone/something *develops* from personality: demonstrated openness grows familiarity
 * faster (familiarityGrowthRate↑) and sharpens the pull-to-know the half-known
 * (curiosityGain↑); demonstrated analytical revises reliability judgments faster
 * (reliabilityRate↑). Bounded + decaying like every other prior.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, openness: number, analytical: number ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', {
    id: 'identity-self', type: 'will.identity', metadata: { traits: { openness, analytical } },
  } )
  entities.set( 'engine-config-known-entity', {
    id: 'engine-config-known-entity', type: 'engine-config',
    metadata: { params: { familiarityGrowthRate: 0.15, curiosityGain: 1.0, reliabilityRate: 0.2 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata?.priors?.[ 'engine-config-known-entity' ]

describe( 'PersonaConsolidator — known-entity dispositions develop from openness + analytical', () => {
  it( 'demonstrated openness raises familiarity growth and the curiosity pull', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9, 0.5 ), {} as any )
    expect( priorFor( r )?.familiarityGrowthRate ).toBeGreaterThan( 0 )
    expect( priorFor( r )?.curiosityGain ).toBeGreaterThan( 0 )
  } )

  it( 'demonstrated analytical raises the reliability-update rate', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5, 0.9 ), {} as any )
    expect( priorFor( r )?.reliabilityRate ).toBeGreaterThan( 0 )
  } )

  it( 'neutral traits leave the dispositions unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5, 0.5 ), {} as any )
    expect( priorFor( r )?.familiarityGrowthRate ?? 0 ).toBe( 0 )
    expect( priorFor( r )?.curiosityGain ?? 0 ).toBe( 0 )
    expect( priorFor( r )?.reliabilityRate ?? 0 ).toBe( 0 )
  } )
} )

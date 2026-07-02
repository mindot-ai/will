// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.action-selector-weights.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Strong-tier agency competition weights develop from disposition (Channel A): a steadier
 * Will weighs the downside of an action LESS (riskWeight↓ — bolder), an open Will weighs
 * novelty MORE (noveltyWeight↑ — curiosity in action). The selector reads both back via
 * readEffectiveParams. Behavioural counterparts of the perceptual threat/novelty facets
 * (rules 22 / 20). Bounded + decaying; absent signal → no push.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, traits: Record<string, number> ) => {
  const entities = new Map<string, any>()
  entities.set( 'identity-self', { id: 'identity-self', type: 'identity', metadata: { traits } } )
  entities.set( 'engine-config-action-selector', {
    id: 'engine-config-action-selector', type: 'engine-config',
    metadata: { params: { riskWeight: 0.20, noveltyWeight: 0.10 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior' )?.metadata
    ?.priors?.[ 'engine-config-action-selector' ]

describe( 'PersonaConsolidator — agency competition weights develop (Channel A)', () => {
  it( 'demonstrated emotional stability lowers the risk weight (bolder action)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, { 'emotional-stability': 0.9 } ), {} as any )
    expect( priorFor( r )?.riskWeight ).toBeLessThan( 0 )
  } )

  it( 'demonstrated openness raises the novelty weight (curiosity in action)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, { openness: 0.9 } ), {} as any )
    expect( priorFor( r )?.noveltyWeight ).toBeGreaterThan( 0 )
  } )

  it( 'neutral traits leave both weights unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, { 'emotional-stability': 0.5, openness: 0.5 } ), {} as any )
    expect( priorFor( r )?.riskWeight ?? 0 ).toBe( 0 )
    expect( priorFor( r )?.noveltyWeight ?? 0 ).toBe( 0 )
  } )

  it( 'surfaces both as telemetry deltas', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, { 'emotional-stability': 0.9, openness: 0.9 } ), {} as any )
    const m  = new Map( ( r.commands?.metrics ?? [] ) as [ string, number ][] )
    expect( m.get( 'persona.action_selector.risk_weight_delta' ) ).toBeLessThan( 0 )
    expect( m.get( 'persona.action_selector.novelty_weight_delta' ) ).toBeGreaterThan( 0 )
  } )
} )

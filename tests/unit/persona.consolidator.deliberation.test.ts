// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.deliberation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Effort allocation develops via metacognition — the capstone that ties the master's
 * dual-process control into the persona system. The PersonaConsolidator reads the
 * self-model's `analytical` trait and writes a persona-prior delta onto the executive's
 * effort-gate threshold: a more analytical Will lowers `deliberateThreshold` and so
 * engages System 2 (deliberate propose→evaluate) more readily. Bounded + decaying;
 * absent signal → no push (decays back to the seeded baseline).
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, analytical: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { analytical } },
  } )
  entities.set('engine-config-executive', {
    id: 'engine-config-executive', type: 'engine-config',
    metadata: { params: { deliberateThreshold: 0.5 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata
    ?.priors?.[ 'engine-config-executive' ]

describe('PersonaConsolidator — effort allocation develops from analytical disposition', () => {
  it('demonstrated analytical thinking lowers the deliberation threshold (deliberate sooner)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const ex = priorFor( r )
    expect( ex?.deliberateThreshold ).toBeLessThan( 0 )                       // engages System 2 more readily
    expect( ex?.deliberateThreshold ).toBeGreaterThanOrEqual( -0.5 * 0.5 )    // bounded by the cumulative cap (½·base)
  } )

  it('neutral analytical leaves the threshold unpushed (decays back to baseline)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.deliberateThreshold ?? 0 ).toBe( 0 )
  } )
} )

// Decisiveness is the opposing pull on the SAME threshold (rule 17b): a decisive Will
// commits on thinner evidence — engages System 2 LESS readily — and, since R1 made the
// agency selector a second consumer of this threshold, it acts on thinner margins too.
const stateWithTraits = ( tick: number, traits: Record<string, number> ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', { id: 'identity-self', type: 'identity', metadata: { traits } } )
  entities.set('engine-config-executive', {
    id: 'engine-config-executive', type: 'engine-config',
    metadata: { params: { deliberateThreshold: 0.5 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

describe('PersonaConsolidator — decisiveness develops the opposing deliberativeness pull', () => {
  it('demonstrated decisiveness raises the deliberation threshold (commit on thinner evidence)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWithTraits( 100, { decisiveness: 0.9 } ), {} as any )
    expect( priorFor( r )?.deliberateThreshold ).toBeGreaterThan( 0 )   // engages System 2 LESS readily
  } )

  it('analytical and decisiveness compose into ONE net delta on the shared threshold', async () => {
    const pc = new PersonaConsolidator()
    // Opposing pulls on the SAME param partially cancel: the combined delta is smaller in
    // magnitude than the analytical driver alone — proving they share one bounded, auditable
    // delta rather than living on separate params.
    const analyticalOnly = priorFor( await pc.react( 0 as any, 100 as any,
      stateWithTraits( 100, { analytical: 0.9 } ), {} as any ) )?.deliberateThreshold ?? 0
    const both = priorFor( await pc.react( 0 as any, 100 as any,
      stateWithTraits( 100, { analytical: 0.9, decisiveness: 0.9 } ), {} as any ) )?.deliberateThreshold ?? 0
    expect( Math.abs( both ) ).toBeLessThan( Math.abs( analyticalOnly ) )
  } )
} )

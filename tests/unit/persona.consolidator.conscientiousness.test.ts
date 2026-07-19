// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.conscientiousness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Planning follow-through develops via metacognition. The PersonaConsolidator reads
 * the self-model's demonstrated `conscientiousness` trait (formed from the Will's own
 * planning/execution behaviour) and writes persona-prior deltas onto the planning
 * engine's Channel A dispositions — so a diligent Will retries stuck steps more
 * (`maxStepRetries↑`) and supervises more vigilantly (`surpriseOutcomeQuality↑`).
 * Bounded + decaying by consolidatePrior; absent signal → no push (decays to baseline).
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, conscientiousness: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { conscientiousness } },
  } )
  entities.set('engine-config-planning', {
    id: 'engine-config-planning', type: 'engine-config',
    metadata: { params: { maxStepRetries: 3, surpriseOutcomeQuality: 0.25, planBiasGain: 1 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata
    ?.priors?.[ 'engine-config-planning' ]

describe('PersonaConsolidator — planning follow-through develops from conscientiousness', () => {
  it('demonstrated conscientiousness deepens follow-through (maxStepRetries↑, vigilance↑)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const pl = priorFor( r )
    expect( pl?.maxStepRetries ).toBeGreaterThan( 0 )         // retry stuck steps more before giving up
    expect( pl?.surpriseOutcomeQuality ).toBeGreaterThan( 0 ) // escalate to deliberate supervision sooner
    expect( pl?.planBiasGain ).toBeGreaterThan( 0 )           // pushes its plan harder in the action competition (Channel A)
  } )

  it('neutral conscientiousness leaves planning unpushed (decays back to baseline)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r )?.maxStepRetries ?? 0 ).toBe( 0 )
    expect( priorFor( r )?.planBiasGain ?? 0 ).toBe( 0 )
  } )
} )

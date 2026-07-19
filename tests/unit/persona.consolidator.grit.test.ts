// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.grit.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Grit develops via metacognition. The PersonaConsolidator reads the self-model's
 * demonstrated `persistence` / `resilience` traits (formed from the Will's own
 * behaviour) and writes persona-prior deltas onto the goal-manager's grit
 * dispositions — so grit is FORMED over time, not seeded once. Bounded + decaying
 * by consolidatePrior; absent signal → no push (decays back to baseline).
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, persistence: number, resilience = 0.5 ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { persistence, resilience } },
  } )
  entities.set('engine-config-goal-manager', {
    id: 'engine-config-goal-manager', type: 'engine-config',
    metadata: { params: { gritPriority: 0.8, gritPatienceScale: 2, frustrationTolerance: 0.5 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata
    ?.priors?.[ 'engine-config-goal-manager' ]

describe('PersonaConsolidator — grit develops from self-model traits', () => {
  it('demonstrated persistence makes the Will grittier (gritPriority↓, patience↑)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const gm = priorFor( r )
    expect( gm?.gritPriority ).toBeLessThan( 0 )         // lower threshold → exempt more of what matters
    expect( gm?.gritPatienceScale ).toBeGreaterThan( 0 ) // persist longer
  } )

  it('demonstrated resilience raises frustration tolerance', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5, 0.9 ), {} as any )
    expect( priorFor( r )?.frustrationTolerance ).toBeGreaterThan( 0 )
  } )

  it('neutral traits leave grit unpushed (decays back to the seeded baseline)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5, 0.5 ), {} as any )
    expect( priorFor( r )?.gritPriority ?? 0 ).toBe( 0 )
  } )
} )

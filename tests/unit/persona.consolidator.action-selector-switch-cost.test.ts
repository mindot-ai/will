// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.action-selector-switch-cost.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * R2 — the agency selector is the second owner of the switch-resistance disposition.
 * Demonstrated conscientiousness raises engine-config-action-selector.switchCost (the
 * selector's preemption hysteresis) the same way it raises the task-switcher's attention
 * switch cost — one disposition, two owners at their native scales. Bounded + decaying.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'

const stateWith = ( tick: number, conscientiousness: number ) => {
  const entities = new Map<string, any>()
  entities.set('identity-self', {
    id: 'identity-self', type: 'identity', metadata: { traits: { conscientiousness } },
  } )
  entities.set('engine-config-action-selector', {
    id: 'engine-config-action-selector', type: 'engine-config', metadata: { params: { switchCost: 0.15 } },
  } )
  return { tick, entities, metrics: new Map<string, number>() } as any
}

const priorFor = ( r: any, id: string ): Record<string, number> | undefined =>
  ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'persona-prior')?.metadata?.priors?.[ id ]

describe('PersonaConsolidator — agency switch cost develops from conscientiousness (R2)', () => {
  it('demonstrated conscientiousness raises the selector switch cost (resists action-interruption)', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    expect( priorFor( r, 'engine-config-action-selector')?.switchCost ).toBeGreaterThan( 0 )
  } )

  it('neutral conscientiousness leaves the selector switch cost unpushed', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.5 ), {} as any )
    expect( priorFor( r, 'engine-config-action-selector')?.switchCost ?? 0 ).toBe( 0 )
  } )

  it('surfaces the developed prior as a telemetry delta', async () => {
    const pc = new PersonaConsolidator()
    const r  = await pc.react( 0 as any, 100 as any, stateWith( 100, 0.9 ), {} as any )
    const m  = new Map( ( r.commands?.metrics ?? [] ) as [ string, number ][] )
    expect( m.get('persona.action_selector.switch_cost_delta') ).toBeGreaterThan( 0 )
  } )
} )

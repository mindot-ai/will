// ─────────────────────────────────────────────────────────────
// tests/unit/sensory.controller.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SensoryController.injectEvent — pins the deterministic id minting (replay
 * fidelity). Injected-event entities are compared in ReplayComparison, so their
 * ids must reproduce on re-execution (was Date.now()+random).
 */

import { describe, it, expect } from 'vitest'
import { DefaultStateManager } from '#core/state.manager'
import { SensoryController } from '#stem/tracts/sensory.controller'
import type { WillInstance } from '#stem/index'

function makeInstance( tick: number ): WillInstance {
  const sm = new DefaultStateManager()
  sm.updateClock( tick, 1000 )   // fixed sim time → deterministic createdAt stamp
  return { tickCount: tick, simulation: { stateManager: sm } } as unknown as WillInstance
}

describe('SensoryController.injectEvent — deterministic ids', () => {
  it('mints tick + monotonic ids and reproduces them across equal runs', () => {
    const run = () => {
      const ctrl = new SensoryController()
      const inst = makeInstance( 42 )
      ctrl.injectEvent( inst, { type: 'percept.social', payload: { summary: 'a' } } )
      ctrl.injectEvent( inst, { type: 'percept.social', payload: { summary: 'b' } } )
      return [ ...inst.simulation.stateManager.getAllEntities() ].map( e => e.id ).sort()
    }
    expect( run() ).toEqual( ['external-event-42-1', 'external-event-42-2'] )
    expect( run() ).toEqual( run() )   // no wall-clock / Math.random drift
  } )

  it('stamps createdAt from the sim clock, not wall time', () => {
    const ctrl = new SensoryController()
    const inst = makeInstance( 7 )
    ctrl.injectEvent( inst, { type: 'percept.social', payload: {} } )
    const entity = inst.simulation.stateManager.getEntity('external-event-7-1')
    expect( entity?.createdAt ).toBe( 1000 )   // the sim time set via updateClock
  } )
} )

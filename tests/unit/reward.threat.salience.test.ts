// ─────────────────────────────────────────────────────────────
// tests/unit/reward.threat.salience.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Reward/threat Option-B: emotion-event salience is surprise × precision (routed
 * through SalienceComputer.observe), not raw magnitude. So a *change* in
 * threat/reward grabs the Global Workspace while a *sustained* level habituates —
 * the reward-prediction-error / threat-habituation analogue.
 *
 * Guardrail: the tonic threat LEVEL stays in the executive's standing context
 * (worldState.threatLevel) regardless, so habituation of the events never blinds
 * the deliberate self to a persistent threat (representation ≠ attention).
 */

import { describe, it, expect } from 'vitest'
import { ThreatEvaluator } from '#faculties/threat.evaluator'
import { buildExecutiveContext } from '#faculties/executive.engine/context'
import { createContext } from '#core/utils'
import type { CognitiveBus } from '#cognition/bus'
import type { ReadonlySimulationState, SimulationEntity, Duration, Tick } from '#core/types'

const ctx = createContext( 'sim', 'run', 1 )

function capturing(): { bus: CognitiveBus; events: Array<{ type: string; salience: number }> } {
  const events: Array<{ type: string; salience: number }> = []
  const bus = { publish: ( e: { type: string; salience: number } ) => events.push( e ), flush() {} } as unknown as CognitiveBus
  return { bus, events }
}

/** A state with one active hostile threat of the given intensity. */
function threatState( intensity: number, tick: number ): ReadonlySimulationState {
  const e = {
    id: 'threat-1', type: 'threat', createdAt: 0, updatedAt: 0,
    metadata: { hostile: true, active: true, intensity },
  } as unknown as SimulationEntity
  return { tick, time: 0, entities: new Map([ [ e.id, e ] ]), metrics: new Map<string, number>() } as unknown as ReadonlySimulationState
}

describe( 'threat salience is surprise-based (Option B)', () => {
  it( 'a threat SPIKE is far more salient than the SAME threat once sustained (habituation)', async () => {
    const { bus, events } = capturing()
    const te = new ThreatEvaluator(); te.attachBus( bus )

    const fearSalienceAt = async ( intensity: number, tick: number ): Promise<number | undefined> => {
      events.length = 0
      await te.react( 0 as Duration, tick as Tick, threatState( intensity, tick ), ctx )
      return events.find( e => e.type === 'emotion.fear.elevated' )?.salience
    }

    await fearSalienceAt( 0.15, 1 )                  // low baseline — seeds the stream (no event)
    const spike = await fearSalienceAt( 0.9, 2 )     // sudden jump → surprising → loud

    // Hold the threat steady — the prediction converges and surprise decays away.
    let sustained: number | undefined
    for( let t = 3; t <= 22; t++ ) sustained = await fearSalienceAt( 0.9, t )

    expect( spike ).toBeGreaterThan( 0 )
    expect( sustained! ).toBeLessThan( spike! )      // attention habituates to the steady threat
  })
})

describe( 'guardrail — tonic threat level survives event habituation', () => {
  it( 'buildExecutiveContext carries threat.level into worldState (representation ≠ attention)', async () => {
    const state = {
      tick: 1, time: 0,
      entities: new Map(),
      metrics: new Map<string, number>([ [ 'threat.level', 0.7 ] ]),
    } as unknown as ReadonlySimulationState

    const context = await buildExecutiveContext( state, {
      workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null,
    } )

    // Even with no threat EVENTS in the workspace, the deliberate self still sees
    // the standing threat level.
    expect( context.worldState.threatLevel ).toBeCloseTo( 0.7, 5 )
  })
} )

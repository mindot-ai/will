// ─────────────────────────────────────────────────────────────
// tests/unit/bias.detector.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Executive-corroboration (Phase 1a tie-off): when the executive independently
 * names a bias (via executive.self.reflection) that the detector also finds this
 * scan, the detected bias's confidence is boosted — two sources agreeing is
 * stronger evidence. Previously the named-bias set was recorded but unused.
 */

import { describe, it, expect } from 'vitest'
import { BiasDetector } from '#faculties/bias.detector'
import { createContext } from '#core/utils'
import type {
  ReadonlySimulationState, SimulationEntity, Duration, Tick, StateCommands,
} from '#core/types'
import type { EngineResult } from '#cognition/types'

const ctx = createContext('sim', 'run', 1 )

/** A state with 3 high-confidence / low-evidence self-beliefs → triggers
 *  confirmation_bias (and overgeneralization) detection. */
function selfBeliefState(): ReadonlySimulationState {
  const beliefs = [ 0, 1, 2 ].map( i => ({
    id: `b${i}`, type: 'belief', createdAt: 0, updatedAt: 0,
    metadata: { category: 'self_belief', confidence: 0.8, supportingEpisodes: 2, statement: `belief ${i}` },
  }) as unknown as SimulationEntity )
  return { tick: 1, time: 0, entities: new Map( beliefs.map( e => [ e.id, e ] ) ), metrics: new Map() } as unknown as ReadonlySimulationState
}

function confidenceOf( res: EngineResult, biasType: string ): number | undefined {
  const set = ( res.commands as StateCommands ).set ?? []
  const ent = set.find( e => e.metadata?.biasType === biasType )
  return ent?.metadata?.confidence as number | undefined
}

const reflection = ( ...biases: string[] ) =>
  ( { type: 'executive.self.reflection', salience: 0.5, payload: { identifiedBiases: biases } } as never )

describe('BiasDetector — executive corroboration', () => {
  it('boosts a detected bias the executive independently named (fuzzy match)', async () => {
    const base = confidenceOf(
      await new BiasDetector({ scanIntervalTicks: 0 } ).react( 0 as Duration, 1 as Tick, selfBeliefState(), ctx ),
      'confirmation_bias',
    )

    const b = new BiasDetector({ scanIntervalTicks: 0 } )
    b.onCognitiveEvent( reflection('confirmation bias') )   // free-text vs code 'confirmation_bias'
    const boosted = confidenceOf( await b.react( 0 as Duration, 1 as Tick, selfBeliefState(), ctx ), 'confirmation_bias')

    expect( base ).toBeGreaterThan( 0 )
    expect( boosted! ).toBeCloseTo( base! + 0.15, 5 )
  })

  it('does not boost when the executive named an unrelated bias', async () => {
    const base = confidenceOf(
      await new BiasDetector({ scanIntervalTicks: 0 } ).react( 0 as Duration, 1 as Tick, selfBeliefState(), ctx ),
      'confirmation_bias',
    )

    const b = new BiasDetector({ scanIntervalTicks: 0 } )
    b.onCognitiveEvent( reflection('anchoring') )
    const same = confidenceOf( await b.react( 0 as Duration, 1 as Tick, selfBeliefState(), ctx ), 'confirmation_bias')

    expect( same ).toBeCloseTo( base!, 5 )
  })
})

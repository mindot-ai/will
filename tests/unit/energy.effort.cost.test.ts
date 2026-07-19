// ─────────────────────────────────────────────────────────────
// tests/unit/energy.effort.cost.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Cognitive metabolic cost — sustained voluntary effort (and cognitive load)
 * drain energy. This is the continuous counterpart to the `focus` effector's
 * one-shot energyCost, closing the attention→energy half of the homeostatic
 * loop: energy already caps the AttentionAllocator's capacity ceiling; here,
 * engaging that capacity drains energy, so focus self-limits and cannot run for
 * free. effort's homeostatic baseline (0.7) is cost-neutral — focusing above it
 * burns faster, standing down (rest) slower.
 */

import { describe, it, expect } from 'vitest'
import { EnergyRegulator } from '#faculties/energy.regulator'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState, StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )

// An awake state: no resting/sleeping/forced-rest flags → the awake-decay branch
// runs (the only branch that spends, rather than replenishes, energy).
function awakeState( metrics: Record<string, number> ): ReadonlySimulationState {
  return {
    tick: 1,
    time: 0,
    entities: new Map(),
    metrics: new Map( Object.entries( metrics ) ),
  } as unknown as ReadonlySimulationState
}

// energy.level produced by a single 10 s awake react() at the given effort/load,
// starting from 80 (comfortably above the low/critical thresholds, so decay is
// the only mover).
async function decayedEnergy( opts: { effort?: number; load?: number } = {} ): Promise<number> {
  const reg = new EnergyRegulator()
  const commands = ( await reg.react( 10_000, 1, awakeState({
    'energy.level':      80,
    'attention.effort':  opts.effort ?? 0.7,
    'attention.usage':   opts.load   ?? 0,
  }), ctx ) ).commands as StateCommands
  return commands.metrics!.find( ([ k ]) => k === 'energy.level')![ 1 ] as number
}

describe('EnergyRegulator — effort/load metabolic cost', () => {
  it('focusing (high effort) drains energy faster than the homeostatic baseline', async () => {
    const focus = await decayedEnergy({ effort: 1.0 })
    const base  = await decayedEnergy({ effort: 0.7 })
    expect( focus ).toBeLessThan( base )   // more drain → lower remaining energy
  })

  it('standing down (low effort / rest) drains slower than the baseline', async () => {
    const rest = await decayedEnergy({ effort: 0.4 })
    const base = await decayedEnergy({ effort: 0.7 })
    expect( rest ).toBeGreaterThan( base )
  })

  it('cognitive load raises the cost on top of effort', async () => {
    const loaded = await decayedEnergy({ effort: 0.7, load: 0.8 })
    const idle   = await decayedEnergy({ effort: 0.7, load: 0 })
    expect( loaded ).toBeLessThan( idle )
  })

  it('the homeostatic baseline (effort 0.7, no load) is cost-neutral', async () => {
    // multiplier is exactly 1.0 there, so decay = baseDecayRate(0.02)·10 s = 0.2,
    // preserving the original awake decay — the coupling adds nothing at rest-point.
    const base = await decayedEnergy({ effort: 0.7, load: 0 })
    expect( base ).toBeCloseTo( 80 - 0.2, 5 )
  })

  it('absent attention metrics, decay falls back to the cost-neutral baseline', async () => {
    const reg = new EnergyRegulator()
    const commands = ( await reg.react( 10_000, 1, awakeState({ 'energy.level': 80 }), ctx ) ).commands as StateCommands
    const energy = commands.metrics!.find( ([ k ]) => k === 'energy.level')![ 1 ] as number
    expect( energy ).toBeCloseTo( 80 - 0.2, 5 )
  })
})

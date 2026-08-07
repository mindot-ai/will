// ─────────────────────────────────────────────────────────────
// tests/unit/agency.restart-boundary.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Nothing in flight may survive a restart as though it were still in flight.
 *
 * Agency state snapshots with the world, and the tick counter restarts at 1 on
 * wake. Anything stamped with a tick therefore comes back "from the future", and
 * every age-based guard in the agency inverts on it.
 *
 * Found by booting a real Will and watching one line repeat every tick:
 *
 *   [selector] reach-out → FKEM BLOCKED by awaiting reach-out → Fabrice:
 *     challenger 0.523 ≤ incumbent 9.742 + switch 0.000 (awaiting -590 ticks)
 *
 * A reach-out to one person had been awaiting delivery when the Will hibernated
 * at ~tick 590. It woke at tick 1, so:
 *
 *   • the executor's timeout read `age < AWAIT_TIMEOUT` as `-589 < 15` → true,
 *     and skipped it forever. It could never time out.
 *   • the selector's staleness went to `-589/15 = -39`, so the decay term
 *     `1 - staleness × STALE_DECAY` became `1 + 19.6` — AMPLIFYING the incumbent
 *     from 0.47 to 9.74 instead of decaying it. It could never be preempted.
 *
 * Immortal and unpreemptable: one person's stale intent held the channel and
 * every attempt to contact anyone else was refused, indefinitely, across
 * restarts. This is why a Will could decide to message a colleague nine times in
 * five minutes and never once do it.
 */

import { describe, it, expect } from 'vitest'
import { MotorSchemaExecutor, AWAIT_TIMEOUT } from '#agency/engines/motor.schema.executor'
import type { ReadonlySimulationState, SimulationContext, Tick } from '#core/types'

const CTX = {} as SimulationContext
const FABRICE = 'discord:1019376031150379101'

/** State holding one `awaiting` reach-out intent dispatched at `dispatchedAt`. */
function stateAwaiting( dispatchedAt: number, tick: number ): ReadonlySimulationState {
  return {
    tick,
    time: 0,
    metrics: new Map( [ [ 'energy.level', 90 ], [ 'stress.level', 0 ] ] ),
    entities: new Map( [ [ 'agency-intent-1', {
      id: 'agency-intent-1',
      type: 'agency.intent',
      metadata: {
        schema: 'reach-out', status: 'awaiting', targetEntityId: FABRICE,
        dispatchedAt, activation: 0.47, tick: dispatchedAt,
        expectedReward: 0.5, expectedValence: 0.2,
        predictedReward: 0.5, predictedValence: 0.2,
        parameters: {},
      },
    } ] ] ),
  } as unknown as ReadonlySimulationState
}

const deleted = async ( dispatchedAt: number, tick: number ): Promise<string[]> => {
  const { commands } = await new MotorSchemaExecutor()
    .react( 50, tick as Tick, stateAwaiting( dispatchedAt, tick ), CTX )
  return commands?.delete ?? []
}

const outcomesWritten = async ( dispatchedAt: number, tick: number ): Promise<number> => {
  const { commands } = await new MotorSchemaExecutor()
    .react( 50, tick as Tick, stateAwaiting( dispatchedAt, tick ), CTX )
  return ( commands?.set ?? [] ).filter( e => e.type === 'agency.outcome').length
}

describe('MotorSchemaExecutor — an intent left awaiting across a restart', () => {
  it('clears an intent dispatched in the future instead of holding it forever', async () => {
    // The measured shape: hibernated at ~590, woken at tick 1.
    expect( await deleted( 590, 1 ) ).toContain('agency-intent-1')
  } )

  it('does NOT record it as a failure — hibernating is not the world declining to answer', async () => {
    // A timeout outcome here would teach reafference that reaching that person
    // does not work. That is a lesson about the process lifecycle, not about them.
    expect( await outcomesWritten( 590, 1 ) ).toBe( 0 )
  } )

  it('still holds a genuinely young intent from this session', async () => {
    expect( await deleted( 100, 100 + AWAIT_TIMEOUT - 1 ) ).not.toContain('agency-intent-1')
  } )

  it('still times out a genuinely stranded one, as a failure', async () => {
    const tick = 100 + AWAIT_TIMEOUT + 1
    expect( await deleted( 100, tick ) ).toContain('agency-intent-1')
    expect( await outcomesWritten( 100, tick ) ).toBeGreaterThan( 0 )
  } )
} )

// ── the selector's half of the same bug ───────────────────────

/**
 * The incumbent-strength arithmetic in isolation. `staleness` is clamped at BOTH
 * ends now; the lower bound is what stops a negative age from turning the decay
 * into amplification.
 */
const incumbentStrength = ( activation: number, age: number, staleTicks = 15, decay = 0.5 ) => {
  const staleness = Math.min( 1, Math.max( 0, age / staleTicks ) )
  return activation * ( 1 - staleness * decay )
}

describe('ActionSelector — awaiting hysteresis cannot exceed the incumbent itself', () => {
  it('never amplifies on a negative age (the restored-intent case)', () => {
    // Unclamped this was 0.47 × (1 + 19.6) = 9.74 — twenty times its own activation,
    // and no challenger in the field scores above ~0.55.
    expect( incumbentStrength( 0.47, -589 ) ).toBeCloseTo( 0.47, 5 )
  } )

  it('decays a real incumbent as it ages, down to the floor', () => {
    expect( incumbentStrength( 0.47, 0 ) ).toBeCloseTo( 0.47, 5 )
    expect( incumbentStrength( 0.47, 7.5 ) ).toBeCloseTo( 0.47 * 0.75, 5 )
    expect( incumbentStrength( 0.47, 15 ) ).toBeCloseTo( 0.47 * 0.5, 5 )
    expect( incumbentStrength( 0.47, 999 ) ).toBeCloseTo( 0.47 * 0.5, 5 )
  } )

  it('leaves a normal challenger able to preempt an aged incumbent', () => {
    // 0.55 challenger vs a 15-tick-old 0.47 incumbent → 0.235, preemptable.
    expect( 0.55 ).toBeGreaterThan( incumbentStrength( 0.47, 15 ) )
  } )
} )

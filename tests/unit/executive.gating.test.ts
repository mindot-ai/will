// ─────────────────────────────────────────────────────────────
// tests/unit/executive.gating.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Executive GWT gate — salience competition vs. prediction-gating.
 *
 * `evaluateGating` is the master's ignition decision. Two interacting levers
 * meet at the scheduled-interval boundary:
 *
 *   • Prediction-gating: if every monitored signal is well-predicted (gated)
 *     and we are not overdue, suppress the cycle ('prediction_gated').
 *   • Salience competition: the workspace buffer accumulates salient coalitions;
 *     once their summed salience reaches BUFFER_SALIENCE_TRIGGER it is "charged".
 *
 * Regression: a charged workspace must ignite even when prediction-gating would
 * otherwise suppress — accumulated salient coalitions are exactly what GWT
 * ignition exists to catch. Previously the interval block returned
 * 'prediction_gated' before the salience sum was ever consulted, so a fully
 * charged buffer could be silently suppressed at the boundary.
 */

import { describe, it, expect } from 'vitest'
import { evaluateGating } from '#faculties/executive.engine/gating'
import type {
  GatingState,
  GatingDependencies,
  SalienceBufferEntry,
} from '#faculties/executive.engine/gating'
import type { GenerativeModel } from '#cognition/generative.model'
import type { CognitiveEvent } from '#cognition/bus'
import type { ReadonlySimulationState, Tick } from '#core/types'

// A calm state: no physiological/cognitive crisis fires, so gating reaches the
// interval / salience-competition logic under test. energy healthy, everything
// else absent (→ 0 via the reader's `?? 0`).
function calmState( tick: number ): ReadonlySimulationState {
  return {
    tick,
    metrics:  new Map<string, number>( [ [ 'energy.level', 100 ] ] ),
    entities: new Map(),
  } as unknown as ReadonlySimulationState
}

// One buffer entry carrying the requested total salience at the given tick.
function buffer( totalSalience: number, tick: number ): SalienceBufferEntry[] {
  return [ { event: { salience: totalSalience } as unknown as CognitiveEvent, tick } ]
}

const allGatedModel = { observe: () => ( { gated: true } ) } as unknown as GenerativeModel
const surpriseModel = { observe: () => ( { gated: false } ) } as unknown as GenerativeModel

function deps( generativeModel: GenerativeModel ): GatingDependencies {
  return { generativeModel, pendingMessages: [], hasPendingWork: false }
}

function gatingState( over: Partial<GatingState> ): GatingState {
  return {
    executiveInterval:   15,
    cooldownTicks:       5,
    lastExecutiveTick:   0,
    salienceBuffer:      [],
    goallessTickCount:   0,
    lowValenceTickCount: 0,
    ...over,
  }
}

describe('evaluateGating — salience competition vs. prediction-gating', () => {
  it('ignites a charged workspace at the interval boundary even when every signal is prediction-gated', () => {
    // tick 16 ≥ interval 15 (boundary), not overdue (< 22.5); buffer summed salience 3.0 ≥ 2.5.
    const gs = gatingState( { salienceBuffer: buffer( 3.0, 16 ) } )
    const r  = evaluateGating( calmState( 16 ), 16 as Tick, deps( allGatedModel ), gs )

    expect( r.shouldActivate ).toBe( true )
    expect( r.reason ).toBe('salience_charged')
  } )

  it('still suppresses an uncharged workspace at the boundary when all signals are predicted', () => {
    const gs = gatingState( { salienceBuffer: buffer( 1.0, 16 ) } )
    const r  = evaluateGating( calmState( 16 ), 16 as Tick, deps( allGatedModel ), gs )

    expect( r.shouldActivate ).toBe( false )
    expect( r.reason ).toBe('prediction_gated')
  } )

  it('fires the scheduled cycle at the boundary when a signal is surprising (not charged)', () => {
    const gs = gatingState( { salienceBuffer: buffer( 1.0, 16 ) } )
    const r  = evaluateGating( calmState( 16 ), 16 as Tick, deps( surpriseModel ), gs )

    expect( r.shouldActivate ).toBe( true )
    expect( r.reason ).toBe('interval_elapsed')
  } )

  it('triggers early — before the interval elapses — once the workspace is charged', () => {
    // tick 10 < interval 15, but past cooldown (10 ≥ 5): the pre-interval early trigger path.
    const gs = gatingState( { salienceBuffer: buffer( 3.0, 10 ) } )
    const r  = evaluateGating( calmState( 10 ), 10 as Tick, deps( allGatedModel ), gs )

    expect( r.shouldActivate ).toBe( true )
    expect( r.reason ).toBe('salience_charged')
  } )
} )

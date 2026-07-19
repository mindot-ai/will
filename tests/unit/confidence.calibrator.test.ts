// ─────────────────────────────────────────────────────────────
// tests/unit/confidence.calibrator.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for ConfidenceCalibrator.
 *
 * Regression target (the "wiring repair"): the calibrator used to be a no-op —
 * recordOutcome() was never called, so _records stayed empty and react()
 * computed a bias of 0 for every domain forever. It now subscribes to
 * 'action.outcome' and pairs each decision's predicted confidence against the
 * realised outcome quality, so per-domain over/under-confidence is learned.
 *
 * These tests cover both the public recordOutcome() path and the new
 * onCognitiveEvent('action.outcome') wiring, then assert getCalibratedConfidence()
 * actually shifts.
 */

import { describe, it, expect } from 'vitest'
import { ConfidenceCalibrator } from '#faculties/confidence.calibrator'
import type { CognitiveEvent } from '#cognition/bus'
import type {
  Tick, Duration, ReadonlySimulationState, SimulationContext,
  StateCommands, SimulationEntity,
} from '#core/types'

// react() reads only state.entities (for restore) and its own records; these
// stubs satisfy the signature without standing up a full simulation.
const STATE   = { tick: 0, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState
const CONTEXT = {} as unknown as SimulationContext

/** A state carrying a persisted calibration-state entity (simulates a restart). */
function stateWithCalibration( domainBias: Record<string, number> ): ReadonlySimulationState {
  const entity = {
    id: 'calibration-state',
    type: 'calibration.state',
    createdAt: 0, updatedAt: 0,
    metadata: { domainBias, updatedAtTick: 0 },
  } as unknown as SimulationEntity
  return {
    tick: 1, time: 0,
    entities: new Map([ [ entity.id, entity ] ]),
    metrics: new Map<string, number>(),
  } as unknown as ReadonlySimulationState
}

function actionOutcome(
  domain: string, confidence: number, outcomeQuality: number, tick: number
): CognitiveEvent {
  return {
    id:             `evt-${tick}`,
    type:           'action.outcome',
    version:        1,
    sourceEngine:   'action-executor',
    sequenceNumber: tick,
    logicalTime:    tick,
    wallTime:       0,
    salience:       0.5,
    payload:        { domain, confidence, outcomeQuality, tick },
  }
}

describe('ConfidenceCalibrator — recordOutcome path', () => {
  it('learns a positive bias when consistently overconfident and tempers future confidence', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 5, calibrationRate: 1, maxAdjustment: 1 })

    // High stated confidence, poor actual outcome → overconfident.
    for( let i = 0; i < 10; i++ ) c.recordOutcome('planning', 0.9, 0.3, i as Tick )

    await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )

    // bias = mean(0.9 − 0.3) = 0.6; rate 1 → newBias 0.6.
    // calibrated = 0.9 − 0.6·0.9 = 0.36.
    const adjusted = c.getCalibratedConfidence('planning', 0.9 )
    expect( adjusted ).toBeLessThan( 0.9 )
    expect( adjusted ).toBeCloseTo( 0.36, 5 )
  })

  it('learns a negative bias when underconfident and lifts future confidence', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 5, calibrationRate: 1, maxAdjustment: 1 })

    // Low stated confidence, strong actual outcome → underconfident.
    for( let i = 0; i < 10; i++ ) c.recordOutcome('deciding', 0.3, 0.9, i as Tick )

    await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )

    // bias = mean(0.3 − 0.9) = −0.6; calibrated = 0.3 − (−0.6)·0.3 = 0.48.
    const adjusted = c.getCalibratedConfidence('deciding', 0.3 )
    expect( adjusted ).toBeGreaterThan( 0.3 )
    expect( adjusted ).toBeCloseTo( 0.48, 5 )
  })

  it('leaves confidence unchanged for a domain below the sample floor', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 5 })
    for( let i = 0; i < 3; i++ ) c.recordOutcome('rare', 0.9, 0.1, i as Tick )

    await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )

    expect( c.getCalibratedConfidence('rare', 0.7 ) ).toBe( 0.7 )
  })
})

describe('ConfidenceCalibrator — action.outcome wiring', () => {
  it('populates records from cognitive events so calibration is no longer a no-op', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 3, calibrationRate: 1, maxAdjustment: 1 })

    for( let i = 0; i < 5; i++ )
      c.onCognitiveEvent( actionOutcome('social', 0.8, 0.2, i ) )

    await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )

    // Overconfident social decisions → calibrated confidence drops.
    expect( c.getCalibratedConfidence('social', 0.8 ) ).toBeLessThan( 0.8 )
  })

  it('ignores malformed action.outcome payloads (missing fields)', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 1, calibrationRate: 1, maxAdjustment: 1 })

    // confidence/outcomeQuality absent — must be skipped, not recorded as NaN.
    c.onCognitiveEvent({
      ...actionOutcome('social', 0.8, 0.2, 0 ),
      payload: { domain: 'social' },
    } as CognitiveEvent )

    await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )

    expect( c.getCalibratedConfidence('social', 0.8 ) ).toBe( 0.8 )   // untouched
  })
})

describe('ConfidenceCalibrator — durable bias via entity (Phase 2 / Option B)', () => {
  it('writes a calibration-state entity carrying the learned per-domain bias', async () => {
    const c = new ConfidenceCalibrator({ minSamplesPerDomain: 5, calibrationRate: 1, maxAdjustment: 1 })
    for( let i = 0; i < 8; i++ ) c.recordOutcome('planning', 0.9, 0.3, i as Tick )

    const res = await c.react( 0 as Duration, 100 as Tick, STATE, CONTEXT )
    const set = ( res.commands as StateCommands ).set ?? []
    const ent = set.find( e => e.id === 'calibration-state')

    expect( ent ).toBeDefined()
    expect( ( ent!.metadata!.domainBias as Record<string, number> ).planning ).toBeGreaterThan( 0 )
  })

  it('rehydrates the calibration curve from the entity on first react (restart continuity)', async () => {
    const restarted = new ConfidenceCalibrator({ minSamplesPerDomain: 5 })

    // Fresh process: no records yet, calibration is neutral …
    expect( restarted.getCalibratedConfidence('planning', 0.9 ) ).toBe( 0.9 )

    // … but a persisted entity carries a learned planning over-confidence bias.
    await restarted.react( 0 as Duration, 1 as Tick, stateWithCalibration({ planning: 0.4 }), CONTEXT )

    // After the first react it has absorbed the persisted bias — immediately,
    // without waiting to re-accumulate minSamplesPerDomain outcomes.
    expect( restarted.getCalibratedConfidence('planning', 0.9 ) ).toBeCloseTo( 0.9 - 0.4 * 0.9, 5 )
  })

  it('preserves restored bias when no new samples have accumulated', async () => {
    const restarted = new ConfidenceCalibrator({ minSamplesPerDomain: 5 })
    const state = stateWithCalibration({ social: 0.3 })

    await restarted.react( 0 as Duration, 1 as Tick, state, CONTEXT )
    await restarted.react( 0 as Duration, 2 as Tick, state, CONTEXT )   // still no records

    expect( restarted.getCalibratedConfidence('social', 0.8 ) ).toBeCloseTo( 0.8 - 0.3 * 0.8, 5 )
  })
})

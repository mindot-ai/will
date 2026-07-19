// ─────────────────────────────────────────────────────────────
// tests/unit/engine.snapshot.restore.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for engine-internal mutable state snapshot/restore (FN9).
 *
 * Regression target: engines carry private accumulating state — activity
 * multipliers, SalienceComputer baselines/precision, GenerativeModel prediction
 * baselines — that the event-sourced SimulationState never captures. snapshot()
 * returned `{}` (forgetting.curve.ts) or a single field (energy.regulator.ts),
 * and there was no restore() seam at all. So after a snapshot restore or a
 * replay, every engine resumed with freshly-zeroed internals and diverged
 * immediately.
 *
 * The fix gives the two cross-cutting state holders (SalienceComputer,
 * GenerativeModel) full snapshot()/restore(), adds an optional restore() seam to
 * the engine interface, and has representative engines (EnergyRegulator,
 * ForgettingCurve) capture *all* their mutable state. These tests prove the
 * round-trip is lossless and that a restored engine reproduces behaviour a
 * freshly-constructed one cannot.
 */

import { describe, it, expect } from 'vitest'
import { GenerativeModel } from '#cognition/generative.model'
import { EnergyRegulator } from '#faculties/energy.regulator'
import { ForgettingCurve } from '#faculties/forgetting.curve'
import { ConfidenceCalibrator } from '#faculties/confidence.calibrator'
import { SelfModelUpdater } from '#faculties/self.model.updater'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState } from '#core/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'

const ctx = createContext('sim', 'run', 42 )

// A no-op bus: lets the energy/forgetting engines exercise their salience +
// generative-model branches (which are gated behind `if(_bus)`) without pulling
// in real transport internals.
const stubBus = { publish() {}, flush() {} } as unknown as CognitiveBus

function stateWith( metrics: Record<string, number> ): ReadonlySimulationState {
  return {
    tick: 1,
    time: 0,
    entities: new Map(),
    metrics: new Map( Object.entries( metrics ) ),
  } as unknown as ReadonlySimulationState
}

function event( type: string, salience: number, payload: Record<string, unknown> ): CognitiveEvent {
  return { type, salience, payload } as unknown as CognitiveEvent
}

describe('GenerativeModel — snapshot/restore (FN9)', () => {
  it('round-trips full state losslessly and resumes prediction identically', () => {
    const a = new GenerativeModel()
    a.configureStream('energy.level', { alpha: 0.3, range: 50 } )
    for( const v of [ 40, 45, 30, 60, 55 ] ) a.observe('energy.level', v )

    const snap = a.snapshot()
    const b = new GenerativeModel()
    b.restore( snap )

    expect( b.snapshot() ).toEqual( snap )
    expect( b.predict('energy.level') ).toBe( a.predict('energy.level') )
    // Next observation produces an identical prediction error.
    expect( b.observe('energy.level', 33 ) ).toEqual( a.observe('energy.level', 33 ) )
  })

  it('captures fields snapshotAll() drops (alpha/range/gateThreshold)', () => {
    const a = new GenerativeModel()
    a.configureStream('sig', { alpha: 0.42, range: 7, gateThreshold: 0.9 } )
    a.observe('sig', 3 )

    const b = new GenerativeModel(); b.restore( a.snapshot() )
    // gateThreshold 0.9 makes nearly everything gated — only a faithfully
    // restored stream config reproduces that.
    expect( b.observe('sig', 4 ).gated ).toBe( a.observe('sig', 4 ).gated )
  })
})

describe('EnergyRegulator — snapshot/restore reproduces behaviour (FN9)', () => {
  // Cognitive load + voluntary effort are now read straight from SimulationState
  // metrics (attention.usage / attention.effort), which the event-sourced state
  // already captures — so they need no engine-side snapshot. The remaining
  // durable internal state is the GenerativeModel prediction baseline; that still
  // must round-trip, or a restored mind re-learns its energy expectations.
  async function drive( reg: EnergyRegulator ): Promise<void> {
    // Vary energy across a few awake ticks (load/effort engaged) so the model
    // accumulates a non-trivial prediction baseline.
    let tick = 1
    for( const level of [ 80, 60, 55, 40, 70 ] )
      await reg.react( 1000, tick++, stateWith({ 'energy.level': level, 'attention.usage': 0.6, 'attention.effort': 0.9 }), ctx )
  }

  it('captures the generative-model baseline as its durable internal state', async () => {
    const reg = new EnergyRegulator(); reg.attachBus( stubBus )
    await drive( reg )

    const snap = reg.snapshot()
    expect( Object.keys( snap ).sort() ).toEqual( [ 'model' ] )
    expect( snap.model ).toBeDefined()
  })

  it('restored regulator matches the original; a fresh one does not', async () => {
    const original = new EnergyRegulator(); original.attachBus( stubBus )
    await drive( original )

    const snap = original.snapshot()

    const restored = new EnergyRegulator(); restored.attachBus( stubBus )
    restored.restore( snap )
    expect( restored.snapshot() ).toEqual( snap )

    // A freshly-constructed regulator has no learned energy baseline, so its
    // durable state diverges — proving the restore actually carries it.
    const fresh = new EnergyRegulator(); fresh.attachBus( stubBus )
    expect( fresh.snapshot() ).not.toEqual( snap )
  })
})

describe('ForgettingCurve — snapshot/restore (FN9)', () => {
  it('no longer returns an empty snapshot and round-trips its model state', async () => {
    const curve = new ForgettingCurve()
    curve.attachBus( stubBus )
    curve.onCognitiveEvent( event('executive.prediction.formed', 0.7, { predictedDomains: [ 'memory' ], confidence: 0.8 } ) )
    curve.onCognitiveEvent( event('some.other.event', 0.3, {} ) )

    const snap = curve.snapshot()
    expect( snap.model ).toBeDefined()   // salience state merged into the single `model` sub-state

    const restored = new ForgettingCurve()
    restored.restore( snap )
    expect( restored.snapshot() ).toEqual( snap )
  })
})

describe('ConfidenceCalibrator — snapshot/restore (FN9)', () => {
  // The durable-persona artifact: the learned per-domain calibration curve.
  // Before this seam it reset to "no bias" on every restore, so the Will
  // re-learned what it doesn't know from scratch each restart.
  async function drive( c: ConfidenceCalibrator ): Promise<void> {
    for( let i = 0; i < 8; i++ )
      c.onCognitiveEvent( event('action.outcome', 0.5, { domain: 'planning', confidence: 0.9, outcomeQuality: 0.3, tick: i } ) )
    for( let i = 0; i < 8; i++ )
      c.onCognitiveEvent( event('action.outcome', 0.5, { domain: 'social', confidence: 0.3, outcomeQuality: 0.9, tick: i } ) )
    await c.react( 0, 100, stateWith({}), ctx )
  }

  it('captures the learned calibration curve + records, not just the bias count', async () => {
    const c = new ConfidenceCalibrator({ bus: stubBus, minSamplesPerDomain: 5, calibrationRate: 1 })
    await drive( c )

    const snap = c.snapshot()
    // salience state now lives inside the single `model` sub-state (substrate unify).
    expect( Object.keys( snap ).sort() )
      .toEqual( [ 'domainBias', 'executiveFlaggedBiasCount', 'model', 'records' ] )
    expect( ( snap.domainBias as unknown[] ).length ).toBeGreaterThan( 0 )
  })

  it('restored calibrator reproduces calibration; a fresh one does not', async () => {
    const original = new ConfidenceCalibrator({ bus: stubBus, minSamplesPerDomain: 5, calibrationRate: 1 })
    await drive( original )
    const snap = original.snapshot()

    const restored = new ConfidenceCalibrator({ bus: stubBus })
    restored.restore( snap )
    expect( restored.snapshot() ).toEqual( snap )
    expect( restored.getCalibratedConfidence('planning', 0.9 ) )
      .toBe( original.getCalibratedConfidence('planning', 0.9 ) )

    // A fresh calibrator has no learned bias → returns raw confidence, diverging.
    const fresh = new ConfidenceCalibrator({ bus: stubBus })
    expect( fresh.getCalibratedConfidence('planning', 0.9 ) )
      .not.toBe( original.getCalibratedConfidence('planning', 0.9 ) )
  })
})

describe('SelfModelUpdater — snapshot/restore (FN9)', () => {
  // The durable-persona artifact: per-domain performance history ("I am good at
  // X / bad at Y") + the evaluation-gating ticks that keep re-evaluation timing
  // deterministic across a restore (R2).
  function drive( u: SelfModelUpdater ): void {
    for( let i = 0; i < 6; i++ )
      u.onCognitiveEvent( event('action.outcome', 0.5, {
        actionType: 'plan', domain: 'planning', success: i % 2 === 0, outcomeQuality: 0.6, tick: i,
      } ) )
  }

  it('captures per-domain performance history + sub-model state', () => {
    const u = new SelfModelUpdater(); u.attachBus( stubBus )
    drive( u )

    const snap = u.snapshot()
    expect( snap.model ).toBeDefined()   // salience state merged into the single `model` sub-state
    expect( ( snap.domainPerformance as unknown[] ).length ).toBeGreaterThan( 0 )
  })

  it('restored updater round-trips losslessly; a fresh one has no history', () => {
    const original = new SelfModelUpdater(); original.attachBus( stubBus )
    drive( original )
    const snap = original.snapshot()

    const restored = new SelfModelUpdater(); restored.attachBus( stubBus )
    restored.restore( snap )
    expect( restored.snapshot() ).toEqual( snap )

    const fresh = new SelfModelUpdater(); fresh.attachBus( stubBus )
    expect( ( fresh.snapshot().domainPerformance as unknown[] ).length ).toBe( 0 )
  })
})

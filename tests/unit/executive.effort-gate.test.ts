// ─────────────────────────────────────────────────────────────
// tests/unit/executive.effort-gate.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Dual-process control — the a-priori effort gate (`selectProcess`). System 1 (`fast`)
 * is the default; System 2 (`deliberate`) engages only when the weighted effort demand
 * (uncertainty, a shaky prior decision, novelty, a human awaiting reply, load) crosses
 * the threshold. Pure + deterministic (R2): identical signals ⇒ identical choice.
 */

import { describe, it, expect } from 'vitest'
import {
  selectProcess,
  ideationTemperature,
  DELIBERATE_THRESHOLD,
  IDEATION_TEMP_MIN,
  IDEATION_TEMP_MAX,
  type EffortSignals,
} from '#faculties/executive.engine/effort.gate'

const calm: EffortSignals = {
  epistemicUncertainty: 0.1,
  priorConfidence:      0.9,
  novelty:              0.0,
  stressLoad:           0,
  hasPendingMessage:    false,
}

describe('selectProcess — a-priori dual-process effort gate', () => {
  it('a calm, confident, routine tick stays in System 1 (fast)', () => {
    const s = selectProcess( calm )
    expect( s.process ).toBe('fast')
    expect( s.effortScore ).toBeLessThan( DELIBERATE_THRESHOLD )
  } )

  it('an uncertain, low-confidence message awaiting reply engages System 2 (deliberate)', () => {
    const s = selectProcess( { ...calm, epistemicUncertainty: 0.9, priorConfidence: 0.2, hasPendingMessage: true } )
    expect( s.process ).toBe('deliberate')
    expect( s.reason ).toContain('deliberate:')
  } )

  it('is a "lazy" System 2 — two strong signals alone stay sub-threshold (engages reluctantly)', () => {
    // uncertainty 0.9 (→0.27) + low confidence 0.8 (→0.20) = 0.47 < 0.5: needs a third nudge.
    const s = selectProcess( { ...calm, epistemicUncertainty: 0.9, priorConfidence: 0.2 } )
    expect( s.process ).toBe('fast')
  } )

  it('effortScore is bounded to [0,1] even when every signal is maxed', () => {
    const s = selectProcess( {
      epistemicUncertainty: 1, priorConfidence: 0, novelty: 1, stressLoad: 100, hasPendingMessage: true,
    } )
    expect( s.effortScore ).toBeLessThanOrEqual( 1 )
    expect( s.effortScore ).toBeGreaterThan( DELIBERATE_THRESHOLD )
    expect( s.process ).toBe('deliberate')
  } )

  it('reports the dominant contributor for auditability', () => {
    const s = selectProcess( { ...calm, novelty: 1 } ) // novelty alone (0.20) stays sub-threshold…
    expect( s.process ).toBe('fast')
    const s2 = selectProcess( { ...calm, epistemicUncertainty: 1, novelty: 1, priorConfidence: 0.3 } )
    expect( s2.reason ).toBe('deliberate:uncertainty') // 0.30 is the heaviest weight
  } )

  it('is deterministic — identical signals ⇒ identical selection (R2)', () => {
    const a = selectProcess( { ...calm, epistemicUncertainty: 0.7, priorConfidence: 0.4 } )
    const b = selectProcess( { ...calm, epistemicUncertainty: 0.7, priorConfidence: 0.4 } )
    expect( a ).toEqual( b )
  } )

  it('a developed (lower) threshold deliberates on signals that stayed fast at baseline', () => {
    const signals = { ...calm, epistemicUncertainty: 0.9, priorConfidence: 0.2 } // = 0.47, sub-baseline
    expect( selectProcess( signals ).process ).toBe('fast')                      // base threshold 0.5
    expect( selectProcess( signals, 0.4 ).process ).toBe('deliberate')           // analytical Will, lowered
  } )
} )

describe('ideationTemperature — creativity drives propose-pass divergence (#4)', () => {
  it('maps the creativity trait across the safe band', () => {
    expect( ideationTemperature( 0 ) ).toBeCloseTo( IDEATION_TEMP_MIN )
    expect( ideationTemperature( 1 ) ).toBeCloseTo( IDEATION_TEMP_MAX )
    expect( ideationTemperature( 0.5 ) ).toBeCloseTo( ( IDEATION_TEMP_MIN + IDEATION_TEMP_MAX ) / 2 )
  } )

  it('is monotonic and stays within the band even for out-of-range traits', () => {
    expect( ideationTemperature( 0.8 ) ).toBeGreaterThan( ideationTemperature( 0.3 ) )
    expect( ideationTemperature( -5 ) ).toBe( IDEATION_TEMP_MIN )
    expect( ideationTemperature( 5 ) ).toBe( IDEATION_TEMP_MAX )
  } )
} )

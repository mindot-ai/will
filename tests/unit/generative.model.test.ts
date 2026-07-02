// ─────────────────────────────────────────────────────────────
// tests/unit/generative.model.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the repaired GenerativeModel prediction substrate.
 *
 * Regression targets (the "repair"):
 *   - Cold start must not report a spurious large error against the
 *     zero-initialised prior (it used to normalise the first observation
 *     against range=100 and emit a giant surprise).
 *   - Normalisation is now ADAPTIVE per-stream: surprise is scaled against
 *     the signal's own typical deviation (madEma × SURPRISE_SCALE), so the
 *     same absolute error is "surprising" in a calm stream and "noise" in a
 *     noisy one. This is what makes the gate meaningful across magnitudes.
 *   - An explicitly configured range (>0) still pins a fixed scale.
 *   - snapshot()/restore() round-trips every field (incl. the new madEma) so
 *     prediction + gating continue identically after a restore (FN9).
 */

import { describe, it, expect } from 'vitest'
import { GenerativeModel, GATE_THRESHOLD } from '#cognition/generative.model'

/** Warm a stream with `n` symmetric ±amp oscillations around `base`. */
function warm( m: GenerativeModel, signal: string, base: number, amp: number, n: number ): void {
  m.observe( signal, base )   // cold-start adopts the baseline
  for( let i = 0; i < n; i++ )
    m.observe( signal, base + ( i % 2 === 0 ? amp : -amp ) )
}

describe('GenerativeModel — cold start', () => {
  it('reports no surprise on the first observation and adopts it as the prediction', () => {
    const m = new GenerativeModel()
    const r = m.observe( 'x', 42 )

    expect( r.error ).toBe( 0 )
    expect( r.normalized ).toBe( 0 )
    expect( r.gated ).toBe( true )
    expect( m.predict( 'x' ) ).toBe( 42 )
  })

  it('does not emit a giant surprise for a large-magnitude first value', () => {
    const m = new GenerativeModel()
    const r = m.observe( 'big', 10_000 )
    expect( r.normalized ).toBe( 0 )   // would have been ~1 under the old range=100 bug
  })
})

describe('GenerativeModel — adaptive self-scaling', () => {
  it('scales surprise to each stream\'s own variance (same error, different gating)', () => {
    const m = new GenerativeModel()

    // A noisy stream (typical deviation ≈ 10) and a calm one (≈ 0.1).
    warm( m, 'noisy', 0, 10,  60 )
    warm( m, 'calm',  0, 0.1, 60 )

    const predNoisy = m.predict( 'noisy' )
    const predCalm  = m.predict( 'calm' )

    // The SAME absolute deviation of 5 …
    const inNoisy = m.observe( 'noisy', predNoisy + 5 )
    const inCalm  = m.observe( 'calm',  predCalm  + 5 )

    // … is unremarkable in the noisy stream …
    expect( inNoisy.gated ).toBe( true )
    expect( inNoisy.normalized ).toBeLessThan( GATE_THRESHOLD )

    // … but a major surprise in the calm one.
    expect( inCalm.gated ).toBe( false )
    expect( inCalm.normalized ).toBeGreaterThan( 0.5 )
  })

  it('gates a sub-typical deviation but flags a large spike on the same stream', () => {
    const m = new GenerativeModel()
    warm( m, 'sig', 100, 2, 60 )   // typical deviation ≈ 2

    // A deviation far smaller than typical is gated …
    const pred  = m.predict( 'sig' )
    const small = m.observe( 'sig', pred + 0.001 )
    expect( small.gated ).toBe( true )

    // … a spike an order of magnitude beyond typical is not.
    const spike = m.observe( 'sig', m.predict( 'sig' ) + 40 )
    expect( spike.gated ).toBe( false )
    expect( spike.normalized ).toBeGreaterThan( 0.5 )
  })
})

describe('GenerativeModel — fixed range', () => {
  it('pins a fixed scale when range > 0 (bounded-signal jump is proportional)', () => {
    const m = new GenerativeModel()
    m.configureStream( 'bounded', { range: 100 } )

    m.observe( 'bounded', 0 )                 // cold start → prediction 0
    const r = m.observe( 'bounded', 50 )      // raw error 50 / range 100

    expect( r.normalized ).toBeCloseTo( 0.5, 5 )
    expect( r.gated ).toBe( false )
  })
})

describe('GenerativeModel — snapshot/restore (FN9)', () => {
  it('round-trips full state so prediction and gating continue identically', () => {
    const m = new GenerativeModel()
    m.observe( 'a', 5 ); m.observe( 'a', 7 ); m.observe( 'a', 6 ); m.observe( 'a', 8 )
    m.observe( 'b', 100 )

    const snap = m.snapshot()
    const m2 = new GenerativeModel()
    m2.restore( snap )

    expect( m2.predict( 'a' ) ).toBe( m.predict( 'a' ) )
    expect( m2.meanError( 'a' ) ).toBe( m.meanError( 'a' ) )

    // Next observation must produce an identical PredictionError — which only
    // holds if the adaptive scale (madEma) survived the round-trip.
    const r1 = m.observe( 'a', 9 )
    const r2 = m2.observe( 'a', 9 )
    expect( r2 ).toEqual( r1 )
  })

  it('tolerates a legacy snapshot missing madEma', () => {
    const m = new GenerativeModel()
    // Hand-rolled legacy payload (pre-madEma) — restore must not throw and
    // must default madEma to 0.
    m.restore({
      defaultAlpha: 0.15,
      defaultRange: 0,
      streams: [ [ 'legacy', {
        prediction: 3, errorEma: 0.1, alpha: 0.15, range: 0,
        gateThreshold: GATE_THRESHOLD, n: 4, anticipationWeight: 0,
      } as never ] ],
    })
    expect( m.predict( 'legacy' ) ).toBe( 3 )
    // First post-restore deviation seeds its own basis (madEma was 0).
    const r = m.observe( 'legacy', 4 )
    expect( Number.isFinite( r.normalized ) ).toBe( true )
  })
})

describe('GenerativeModel — merged salience', () => {
  it('cold-start salience is 0 (no baseline yet)', () => {
    expect( new GenerativeModel().observe( 'x', 42 ).salience ).toBe( 0 )
  })

  it('precision (>1) amplifies salience and then mean-reverts', () => {
    const plain = new GenerativeModel(); const amp = new GenerativeModel()
    for( let i = 0; i < 25; i++ ){ const v = 100 + ( i % 2 === 0 ? 1 : -1 ); plain.observe( 's', v ); amp.observe( 's', v ) }
    amp.setPrecision( 's', 2.5 )
    // small deviation so the base salience isn't already saturated at 1
    expect( amp.observe( 's', 100.3 ).salience ).toBeGreaterThan( plain.observe( 's', 100.3 ).salience )
    expect( amp.getPrecision( 's' ) ).toBeLessThan( 2.5 )   // mean-reverted toward 1.0 on observe
  })

  it('salience habituates to a sustained signal and spikes on a change', () => {
    const gm = new GenerativeModel()
    gm.observe( 'x', 0 )
    const spike = gm.observe( 'x', 10 ).salience      // jump → surprising
    let sustained = spike
    for( let i = 0; i < 20; i++ ) sustained = gm.observe( 'x', 10 ).salience  // hold → habituate
    expect( spike ).toBeGreaterThan( 0 )
    expect( sustained ).toBeLessThan( spike )
  })

  it('precision round-trips through snapshot()/restore()', () => {
    const a = new GenerativeModel()
    a.observe( 's', 1 ); a.observe( 's', 5 ); a.setPrecision( 's', 1.8 )
    const b = new GenerativeModel(); b.restore( a.snapshot() )
    expect( b.getPrecision( 's' ) ).toBe( 1.8 )
    expect( b.observe( 's', 3 ).salience ).toBe( a.observe( 's', 3 ).salience )
  })
})

describe('GenerativeModel — scale-alpha decoupling (1e)', () => {
  // A mix of magnitudes so the prediction and the deviation-scale move at clearly
  // different paces depending on their learning rates.
  const seq = [ 10, 12, 8, 15, 9, 11, 20, 7, 13, 6 ]

  it('omitting scaleAlpha is identical to setting it equal to alpha (behaviour-preserving)', () => {
    const omit  = new GenerativeModel(); omit.configureStream( 'sig', { alpha: 0.4 } )
    const equal = new GenerativeModel(); equal.configureStream( 'sig', { alpha: 0.4, scaleAlpha: 0.4 } )

    let ro, re
    for( const v of seq ){ ro = omit.observe( 'sig', v ); re = equal.observe( 'sig', v ) }
    expect( re ).toEqual( ro )
  })

  it('decouples the learned scale from the prediction (same prediction, different gating + salience)', () => {
    const fast = new GenerativeModel(); fast.configureStream( 'sig', { alpha: 0.4, scaleAlpha: 0.9 } )
    const slow = new GenerativeModel(); slow.configureStream( 'sig', { alpha: 0.4, scaleAlpha: 0.1 } )

    for( const v of seq ){ fast.observe( 'sig', v ); slow.observe( 'sig', v ) }

    // The prediction learning rate (alpha) is identical → identical prediction …
    const pred = fast.predict( 'sig' )
    expect( slow.predict( 'sig' ) ).toBe( pred )

    // … but the deviation scale (madEma + variance) tracked at its own rate. Probe
    // both with the SAME small, sub-typical deviation (so salience isn't saturated):
    // the gating basis and the salience basis both diverge.
    const rf = fast.observe( 'sig', pred + 0.3 )
    const rs = slow.observe( 'sig', pred + 0.3 )
    expect( rf.normalized ).not.toBe( rs.normalized )
    expect( rf.salience ).not.toBe( rs.salience )
    expect( rf.salience ).toBeLessThan( 1 )
    expect( rs.salience ).toBeLessThan( 1 )
  })

  it('a legacy snapshot (no scaleAlpha) restores with scaleAlpha defaulted to alpha', () => {
    const legacy = {
      prediction: 5, errorEma: 0.1, madEma: 0.5, m2: 0.4, alpha: 0.3, range: 0,
      gateThreshold: GATE_THRESHOLD, n: 10, anticipationWeight: 0,
    }
    const m = new GenerativeModel()
    m.restore({ defaultAlpha: 0.15, defaultRange: 0, streams: [ [ 'legacy', legacy as never ] ] })

    // Reference that names scaleAlpha = alpha explicitly — must behave identically.
    const ref = new GenerativeModel()
    ref.restore({ defaultAlpha: 0.15, defaultRange: 0, streams: [ [ 'legacy', { ...legacy, scaleAlpha: 0.3 } as never ] ] })

    expect( m.observe( 'legacy', 8 ) ).toEqual( ref.observe( 'legacy', 8 ) )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/trait-salience.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Graded trait salience (Channel B surfacing). Traits reach the deliberate self by
 * DEGREE — "markedly conscientious" vs "somewhat impulsive" — replacing the old binary
 * in/out gate. Bands are coarse on purpose: the system prompt is the single prompt-cache
 * breakpoint, so the rendered line must change ONLY when a trait crosses a band boundary,
 * never on micro-fluctuation. Mid-band traits are omitted (present but not yet self-known;
 * Channel-A mechanisms still read their raw value every tick).
 */

import { describe, it, expect } from 'vitest'
import { PromptFactory, traitEmphasis, normEmphasis, TRAIT_SURFACE_CAP } from '#faculties/executive.engine/prompt.factory'
import { SelfModelUpdater, type TraitStat } from '#faculties/self.model.updater'

describe( 'traitEmphasis — banded intensity (pure)', () => {
  it( 'maps deviation from 0.5 to a coarse adverb + direction', () => {
    expect( traitEmphasis( 0.95 ) ).toEqual( { adverb: 'markedly', direction: 'high', rank: 0 } )
    expect( traitEmphasis( 0.05 ) ).toEqual( { adverb: 'markedly', direction: 'low',  rank: 0 } )
    expect( traitEmphasis( 0.80 ) ).toEqual( { adverb: 'strongly', direction: 'high', rank: 1 } )
    expect( traitEmphasis( 0.20 ) ).toEqual( { adverb: 'strongly', direction: 'low',  rank: 1 } )
    expect( traitEmphasis( 0.62 ) ).toEqual( { adverb: 'somewhat', direction: 'high', rank: 2 } )
    expect( traitEmphasis( 0.40 ) ).toEqual( { adverb: 'somewhat', direction: 'low',  rank: 2 } )
  } )

  it( 'omits the unremarkable mid-band (|dev| < 0.10 → null)', () => {
    expect( traitEmphasis( 0.50 ) ).toBeNull()
    expect( traitEmphasis( 0.55 ) ).toBeNull()
    expect( traitEmphasis( 0.41 ) ).toBeNull()   // dev 0.09 — just inside mid-band
    expect( traitEmphasis( 0.59 ) ).toBeNull()
  } )

  it( 'is monotone at the band boundaries (inclusive lower edge)', () => {
    expect( traitEmphasis( 0.60 )?.adverb ).toBe( 'somewhat' )  // dev exactly 0.10
    expect( traitEmphasis( 0.75 )?.adverb ).toBe( 'strongly' )  // dev exactly 0.25
    expect( traitEmphasis( 0.90 )?.adverb ).toBe( 'markedly' )  // dev exactly 0.40
  } )
} )

// ── End-to-end through the system prompt (cache invariant) ──────

const ctx = ( traits: Record<string, number>, traitStats?: Record<string, TraitStat> ) => ( {
  identity: {
    name:   'Aria',
    values: [ 'curiosity' ],
    traits,
    traitStats,
    style:  'warm and direct',
    prompt: '## Who You Are\nYou are Aria, a synthetic mind.',
  },
  behavioralDisposition: { riskTolerance: 0.5, explorationRate: 0.6, impulsivity: 0.3 },
  selfTuning: [],
} as any )

const focus = { title: 'Active Conversation', content: 'x', instructions: 'Respond as yourself.' } as any
const buildSys = ( traits: Record<string, number>, traitStats?: Record<string, TraitStat> ) =>
  PromptFactory.buildSystemPrompt( { context: ctx( traits, traitStats ), focus, deps: {} as any, mode: 'facet' } )

const traitsLineOf = ( sys: string ) => sys.split( '\n' ).find( l => l.startsWith( '**Traits:**' ) ) ?? ''

describe( 'Graded trait salience — system prompt surfacing', () => {
  it( 'renders degree + direction, omitting mid-band, most-distinctive first', () => {
    const line = traitsLineOf( buildSys( { conscientiousness: 0.95, persistence: 0.80, impulsivity: 0.38, calm: 0.52 } ) )
    expect( line ).toBe( '**Traits:** conscientiousness (markedly high), persistence (strongly high), impulsivity (somewhat low)' )
    expect( line ).not.toContain( 'calm' )    // mid-band omitted
    expect( line ).not.toMatch( /\d/ )        // no raw number leaks into the cached prompt
  } )

  it( 'system prompt is byte-identical when a trait drifts WITHIN its band (cache-safe)', () => {
    // openness 0.82 → 0.80: both dev∈[0.25,0.40) → "strongly". Nothing else changes.
    expect( buildSys( { openness: 0.82 } ) ).toBe( buildSys( { openness: 0.80 } ) )
  } )

  it( 'system prompt CHANGES when a trait crosses a band boundary', () => {
    // openness 0.82 (strongly) → 0.92 (markedly) — a real shift in self-knowledge.
    expect( buildSys( { openness: 0.82 } ) ).not.toBe( buildSys( { openness: 0.92 } ) )
  } )

  it( 'retains the top-K cap so a many-trait Will cannot bloat the prompt', () => {
    const eightDistinct = {
      conscientiousness: 0.95, persistence: 0.94, openness: 0.93, creativity: 0.92,
      decisiveness: 0.91, agreeableness: 0.90, resilience: 0.89, analytical: 0.88,
    }
    const line = traitsLineOf( buildSys( eightDistinct ) )
    expect( line.split( '),' ).length ).toBe( TRAIT_SURFACE_CAP )   // exactly K surfaced
  } )
} )

// ── Option B — baseline-relative ("above/below my own norm") ────

describe( 'normEmphasis — value vs personal baseline (pure)', () => {
  it( 'bands the deviation from the personal mean', () => {
    expect( normEmphasis( 0.82, 0.55 ) ).toBe( 'above' )   // d 0.27
    expect( normEmphasis( 0.50, 0.65 ) ).toBe( 'below' )   // d −0.15
    expect( normEmphasis( 0.62, 0.50 ) ).toBe( 'above' )   // d 0.12 — inclusive edge
  } )
  it( 'returns null inside the band (close to my norm)', () => {
    expect( normEmphasis( 0.60, 0.55 ) ).toBeNull()        // d 0.05
    expect( normEmphasis( 0.55, 0.60 ) ).toBeNull()
  } )
} )

// ── Options B + C layered onto the system prompt ────────────────

const stat = ( mean: number, shiftDir: number ): TraitStat => ( { mean, shiftDir, shiftTick: 0 } )

describe( 'Graded salience B/C — qualifiers layered onto the absolute band', () => {
  it( 'adds "above/below my norm" (B) and "rising/easing lately" (C)', () => {
    const line = traitsLineOf( buildSys(
      { openness: 0.82, persistence: 0.80, resilience: 0.78 },
      { openness: stat( 0.55, +1 ), persistence: stat( 0.97, 0 ), resilience: stat( 0.78, -1 ) },
    ) )
    expect( line ).toContain( 'openness (strongly high, above my norm, rising lately)' )
    expect( line ).toContain( 'persistence (strongly high, below my norm)' )   // high overall, below its unusually-high norm
    expect( line ).toContain( 'resilience (strongly high, easing lately)' )    // no B (near norm), only C
  } )

  it( 'falls back to the bare A band when no traitStats are present (back-compat)', () => {
    expect( traitsLineOf( buildSys( { openness: 0.82 } ) ) ).toBe( '**Traits:** openness (strongly high)' )
  } )

  it( 'B is cache-stable when the value drifts WITHIN the norm band (frozen mean)', () => {
    // d 0.27 → 0.25, both ≥ 0.12 → "above" either way; A stays "strongly". Byte-identical.
    const s = { openness: stat( 0.55, 0 ) }
    expect( buildSys( { openness: 0.82 }, s ) ).toBe( buildSys( { openness: 0.80 }, s ) )
  } )
} )

// ── Self-model: the EMA / shift / recency-decay that produces the stats ──

const computeStats = (
  oldT: Record<string, number>, newT: Record<string, number>,
  prev: Record<string, TraitStat>, tick: number,
) => ( new SelfModelUpdater() as any )._computeTraitStats( oldT, newT, prev, tick ) as Record<string, TraitStat>

describe( 'SelfModelUpdater._computeTraitStats — baseline + recency (R2-pure)', () => {
  it( 'EMA seeds from 0.5 and tracks toward the value (slowly)', () => {
    const s = computeStats( { openness: 0.5 }, { openness: 0.8 }, {}, 100 )
    expect( s.openness!.mean ).toBeCloseTo( 0.56, 5 )   // 0.5 + 0.2·(0.8−0.5)
  } )

  it( 'a significant move stamps a recency direction at the eval tick', () => {
    const up   = computeStats( { x: 0.50 }, { x: 0.80 }, {}, 100 )   // Δ +0.30
    const down = computeStats( { x: 0.80 }, { x: 0.50 }, {}, 100 )   // Δ −0.30
    expect( up.x!.shiftDir ).toBe( 1 )
    expect( up.x!.shiftTick ).toBe( 100 )
    expect( down.x!.shiftDir ).toBe( -1 )
  } )

  it( 'an insignificant move carries the prior stamp until it ages out of the window', () => {
    const prev = { x: stat( 0.6, +1 ) }       // stamped earlier at tick 0
    const carried = computeStats( { x: 0.60 }, { x: 0.61 }, prev, 300 )   // Δ 0.01, within 600
    const decayed = computeStats( { x: 0.60 }, { x: 0.61 }, prev, 800 )   // Δ 0.01, past 600
    expect( carried.x!.shiftDir ).toBe( 1 )    // still "lately"
    expect( decayed.x!.shiftDir ).toBe( 0 )    // aged out — cleared at this eval
  } )

  it( 'is deterministic — identical inputs give identical stats (R2)', () => {
    const a = computeStats( { x: 0.4 }, { x: 0.7 }, { x: stat( 0.5, 0 ) }, 250 )
    const b = computeStats( { x: 0.4 }, { x: 0.7 }, { x: stat( 0.5, 0 ) }, 250 )
    expect( a ).toEqual( b )
  } )
} )

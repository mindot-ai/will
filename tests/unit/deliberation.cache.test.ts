// ─────────────────────────────────────────────────────────────
// tests/unit/deliberation.cache.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the DeliberationCache fast-path (Phase 1 — ACTIONS block).
 *
 * Coverage:
 *   - fingerprint: fixed length, determinism, real metric/entity contracts,
 *     valence [-1,1] → [0,1] mapping.
 *   - cosine similarity: identity = 1, orthogonal = 0.
 *   - cache: miss on empty, hit on identical fingerprint, competence gates the
 *     confidence, verify schedule is deterministic, eviction is deterministic,
 *     snapshot/restore round-trips exactly.
 *   - composition: produces a VALID ExecutiveOutputFull (required fields present),
 *     verbatim action copy (no text interpolation), weighted goal-priority blend.
 */

import { describe, it, expect } from 'vitest'
import { DeliberationCache } from '#cognition/cache/deliberation.cache'
import {
  extractFingerprint,
  fingerprintSimilarity,
  FINGERPRINT_DIM,
} from '#cognition/cache/fingerprint'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { ReadonlySimulationState, SimulationEntity } from '#core/types'

// ── Fixtures ───────────────────────────────────────────────

function mockState( opts: {
  metrics?: Record<string, number>
  entities?: Array<Partial<SimulationEntity> & { type: string; id: string }>
} = {} ): ReadonlySimulationState {
  const metrics = new Map<string, number>( Object.entries( opts.metrics ?? {} ) )
  const entities = new Map<string, SimulationEntity>()
  for( const e of opts.entities ?? [] ){
    entities.set( e.id, {
      id: e.id,
      type: e.type,
      createdAt: 0,
      updatedAt: 0,
      metadata: e.metadata ?? {},
    } as SimulationEntity )
  }
  return { tick: 0, time: 0, entities, metrics } as unknown as ReadonlySimulationState
}

/** A minimal valid executive output whose primary action is `type`. */
function mockOutput( type: string, reasoning = `do ${type}` ): ExecutiveOutputFull {
  return {
    actions: [ { type, reasoning, expectedOutcome: `${type} happens` } ],
    reasoning,
    confidence: 0.8,
  }
}

function fpWith( index: number, value: number ): Float32Array {
  const fp = new Float32Array( FINGERPRINT_DIM )
  fp[ index ] = value
  return fp
}

// ── fingerprint ────────────────────────────────────────────

describe('extractFingerprint', () => {
  it('produces a fixed-length vector', () => {
    expect( extractFingerprint( mockState() ).length ).toBe( FINGERPRINT_DIM )
  })

  it('is deterministic for the same state', () => {
    const s = mockState( {
      metrics: { 'energy.level': 70, 'affect.valence': -0.4 },
      entities: [
        { id: 'g1', type: 'goal', metadata: { priority: 0.9 } },
        { id: 'g2', type: 'goal', metadata: { priority: 0.3 } },
      ],
    } )
    const a = extractFingerprint( s )
    const b = extractFingerprint( s )
    for( let i = 0; i < FINGERPRINT_DIM; i++ ) expect( a[ i ] ).toBe( b[ i ] )
  })

  it('maps valence from [-1,1] into [0,1] (neutral = 0.5)', () => {
    // slot 3 is affect.valence
    expect( extractFingerprint( mockState( { metrics: { 'affect.valence': 0 } } ) )[ 3 ] ).toBeCloseTo( 0.5, 5 )
    expect( extractFingerprint( mockState( { metrics: { 'affect.valence': -1 } } ) )[ 3 ] ).toBeCloseTo( 0, 5 )
    expect( extractFingerprint( mockState( { metrics: { 'affect.valence': 1 } } ) )[ 3 ] ).toBeCloseTo( 1, 5 )
  })

  it('normalises physiology metrics from 0-100 into 0-1', () => {
    // slot 0 is energy.level
    expect( extractFingerprint( mockState( { metrics: { 'energy.level': 100 } } ) )[ 0 ] ).toBeCloseTo( 1, 5 )
    expect( extractFingerprint( mockState( { metrics: { 'energy.level': 0 } } ) )[ 0 ] ).toBeCloseTo( 0, 5 )
  })

  it('sorts goal priorities into the top-10 band (slots 6+) regardless of Map order', () => {
    const lowFirst = extractFingerprint( mockState( { entities: [
      { id: 'a', type: 'goal', metadata: { priority: 0.2 } },
      { id: 'b', type: 'goal', metadata: { priority: 0.9 } },
    ] } ) )
    const highFirst = extractFingerprint( mockState( { entities: [
      { id: 'b', type: 'goal', metadata: { priority: 0.9 } },
      { id: 'a', type: 'goal', metadata: { priority: 0.2 } },
    ] } ) )
    // Insertion order must not matter — descending sort makes slot 6 the max.
    expect( lowFirst[ 6 ] ).toBeCloseTo( 0.9, 5 )
    expect( highFirst[ 6 ] ).toBeCloseTo( 0.9, 5 )
    expect( lowFirst[ 7 ] ).toBeCloseTo( 0.2, 5 )
  })
})

describe('fingerprintSimilarity', () => {
  it('identical vectors → 1', () => {
    const a = fpWith( 0, 0.5 ); a[ 1 ] = 0.3
    expect( fingerprintSimilarity( a, a ) ).toBeCloseTo( 1, 5 )
  })
  it('orthogonal vectors → 0', () => {
    expect( fingerprintSimilarity( fpWith( 0, 1 ), fpWith( 1, 1 ) ) ).toBeCloseTo( 0, 5 )
  })
})

// ── cache behaviour ────────────────────────────────────────

describe('DeliberationCache', () => {
  it('returns a miss on an empty cache', () => {
    const cache = new DeliberationCache( { theta: 0.5 } )
    const r = cache.retrieve( fpWith( 0, 0.5 ), 1 )
    expect( r.hit ).toBe( false )
    expect( r.confidence ).toBe( 0 )
    expect( r.output ).toBeNull()
  })

  it('learns then hits on an identical fingerprint and composes a valid output', () => {
    const cache = new DeliberationCache( { theta: 0.4, k: 3 } )
    const fp = fpWith( 0, 0.5 )
    cache.learn( fp, mockOutput('speak'), 1 )

    const r = cache.retrieve( fp, 2 )
    expect( r.hit ).toBe( true )
    // required fields present + valid
    expect( r.output ).not.toBeNull()
    expect( r.output!.actions[ 0 ]!.type ).toBe( 'speak' )
    expect( typeof r.output!.reasoning ).toBe( 'string' )
    expect( typeof r.output!.confidence ).toBe( 'number' )
  })

  it('confidence = competence × similarity (competence gates a hit)', () => {
    // Fresh competence is 0.5. At similarity 1, ρ = 0.5, so θ=0.6 must miss, θ=0.4 must hit.
    const fp = fpWith( 0, 0.5 )
    const miss = new DeliberationCache( { theta: 0.6 } )
    miss.learn( fp, mockOutput('a'), 1 )
    expect( miss.retrieve( fp, 2 ).hit ).toBe( false )

    const hit = new DeliberationCache( { theta: 0.4 } )
    hit.learn( fp, mockOutput('a'), 1 )
    const r = hit.retrieve( fp, 2 )
    expect( r.hit ).toBe( true )
    expect( r.confidence ).toBeCloseTo( 0.5, 5 )
  })

  it('positive reafference raises competence and thus confidence', () => {
    const cache = new DeliberationCache( { theta: 0.4, eta: 0.5 } )
    const fp = fpWith( 0, 0.5 )
    cache.learn( fp, mockOutput('jump'), 1 )
    const before = cache.retrieve( fp, 2 ).confidence
    cache.updateCompetence( fp, 1.0, 3 )
    const after = cache.retrieve( fp, 4 ).confidence
    expect( after ).toBeGreaterThan( before )
  })

  it('does NOT interpolate action text — copies the winning neighbor verbatim', () => {
    const cache = new DeliberationCache( { theta: 0.0, k: 5, tau: 0.5 } )
    // Two neighbors with different action types; the identical-fingerprint one wins.
    cache.learn( fpWith( 0, 0.5 ), mockOutput('speak', 'coherent reasoning A'), 1 )
    cache.learn( fpWith( 0, 0.49 ), mockOutput('move', 'coherent reasoning B'), 2 )
    const r = cache.retrieve( fpWith( 0, 0.5 ), 3 )
    expect( r.hit ).toBe( true )
    // Verbatim: reasoning is one of the stored strings, never a blended hybrid.
    expect( [ 'coherent reasoning A', 'coherent reasoning B' ] ).toContain( r.output!.actions[ 0 ]!.reasoning )
  })

  it('verify schedule is deterministic (1-in-N)', () => {
    const cache = new DeliberationCache( { verifyEveryNHits: 3 } )
    expect( cache.shouldVerify() ).toBe( false )
    expect( cache.shouldVerify() ).toBe( false )
    expect( cache.shouldVerify() ).toBe( true )
    expect( cache.shouldVerify() ).toBe( false )
  })

  it('evicts deterministically when full', () => {
    const cache = new DeliberationCache( { maxPatterns: 2, theta: 0.4 } )
    cache.learn( fpWith( 0, 0.1 ), mockOutput('a'), 1 )
    cache.learn( fpWith( 0, 0.2 ), mockOutput('b'), 2 )
    cache.learn( fpWith( 0, 0.3 ), mockOutput('c'), 3 )  // triggers eviction of the weakest × oldest
    expect( cache.size ).toBe( 2 )
    // The newest pattern must still be retrievable.
    expect( cache.retrieve( fpWith( 0, 0.3 ), 4 ).hit ).toBe( true )
  })

  it('eviction keeps the high-competence old pattern over a low-competence new one', () => {
    // The inversion bug: competence×recency evicted good-but-old first. With
    // competence-primary eviction, the reinforced old pattern must survive.
    const cache = new DeliberationCache( { maxPatterns: 2, theta: 0.0, eta: 1 } )
    const good = fpWith( 0, 0.1 )
    cache.learn( good, mockOutput('keep'), 1 )
    cache.updateCompetence( good, 1.0, 1 )        // old but competent (0.5→1.0)
    cache.learn( fpWith( 0, 0.2 ), mockOutput('weak'), 2 )  // newer, competence 0.5
    cache.learn( fpWith( 0, 0.3 ), mockOutput('new'), 3 )   // triggers eviction

    // The competent old pattern must still be present; the weakest was evicted.
    expect( cache.size ).toBe( 2 )
    expect( cache.retrieve( good, 4 ).output!.actions[ 0 ]!.type ).toBe( 'keep' )
  })

  it('snapshot / restore round-trips retrieval exactly', () => {
    const cache = new DeliberationCache( { theta: 0.4 } )
    const fp = fpWith( 0, 0.5 )
    cache.learn( fp, mockOutput('move'), 1 )
    cache.updateCompetence( fp, 1.0, 2 )

    const restored = new DeliberationCache( { theta: 0.4 } )
    restored.restore( cache.snapshot() )

    const a = cache.retrieve( fp, 3 )
    const b = restored.retrieve( fp, 3 )
    expect( b.hit ).toBe( a.hit )
    expect( b.confidence ).toBeCloseTo( a.confidence, 6 )
    expect( b.output!.actions[ 0 ]!.type ).toBe( a.output!.actions[ 0 ]!.type )
  })
})

// ── composition: weighted goal-priority blend ──────────────

describe('composition (goals scope)', () => {
  it('blends goal priority by softmax weight and merges by description', () => {
    const cache = new DeliberationCache( { theta: 0.0, k: 5, tau: 0.5, scopes: [ 'actions', 'goals' ] } )
    const withGoal = ( p: number ): ExecutiveOutputFull => ( {
      ...mockOutput('wait'),
      newGoals: [ { description: 'rest up', priority: p, tags: [], completionType: 'binary' } ],
    } )
    cache.learn( fpWith( 0, 0.5 ), withGoal( 0.8 ), 1 )
    cache.learn( fpWith( 0, 0.5 ), withGoal( 0.6 ), 2 )
    const r = cache.retrieve( fpWith( 0, 0.5 ), 3 )
    expect( r.hit ).toBe( true )
    expect( r.output!.newGoals ).toHaveLength( 1 )
    const pr = r.output!.newGoals![ 0 ]!.priority
    // equal fingerprints → equal weights → mean of 0.8 and 0.6 = 0.7
    expect( pr ).toBeGreaterThan( 0.6 )
    expect( pr ).toBeLessThan( 0.8 )
  })
})

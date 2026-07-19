// ─────────────────────────────────────────────────────────────
// tests/unit/persona.prior.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the persona-prior derivation — the accommodation layer of the
 * metacognition cycle (Phase 2, Option B).
 *
 * Guarantees:
 *   - effective = base ⊕ prior (additive, numeric-only)
 *   - absent prior entity OR absent per-engine entry ⇒ pure base (graceful)
 *   - the base entity is never mutated; a fresh object is returned
 *   - non-numeric base params / deltas pass through untouched
 *   - because the prior is an *entity*, it rides the wired entity-restore path —
 *     a state reconstructed from a snapshot (same entity map) derives identically
 */

import { describe, it, expect } from 'vitest'
import {
  readEffectiveParams, readPersonaPrior, consolidatePrior, summarizePersonaPrior,
  PERSONA_PRIOR_ID, PERSONA_PRIOR_TYPE,
  type PersonaPriorMeta,
} from '#cognition/persona.prior'
import type { ReadonlySimulationState, SimulationEntity } from '#core/types'

function stateWith( entities: SimulationEntity[] ): ReadonlySimulationState {
  return {
    tick: 1,
    time: 0,
    entities: new Map( entities.map( e => [ e.id, e ] ) ),
    metrics: new Map<string, number>(),
  } as unknown as ReadonlySimulationState
}

function baseConfig( params: Record<string, unknown> ): SimulationEntity {
  return {
    id: 'engine-config-self-model',
    type: 'engine.config',
    createdAt: 0, updatedAt: 0,
    metadata: { engine: 'self-model', params },
  } as unknown as SimulationEntity
}

function priorEntity( priors: Record<string, Record<string, number>> ): SimulationEntity {
  return {
    id: PERSONA_PRIOR_ID,
    type: PERSONA_PRIOR_TYPE,
    createdAt: 0, updatedAt: 0,
    metadata: { priors, version: 1, updatedAtTick: 1 },
  } as unknown as SimulationEntity
}

describe('persona.prior — readEffectiveParams', () => {
  it('returns base unchanged when no persona-prior entity exists', () => {
    const state = stateWith([ baseConfig({ minIntervalTicks: 200, minNewExperiences: 20 }) ])
    expect( readEffectiveParams( state, 'engine-config-self-model') )
      .toEqual({ minIntervalTicks: 200, minNewExperiences: 20 })
  })

  it('returns base when the prior exists but has no entry for this engine', () => {
    const state = stateWith([
      baseConfig({ minIntervalTicks: 200 }),
      priorEntity({ 'engine-config-energy': { baseDecayRate: 0.01 } }),
    ])
    expect( readEffectiveParams( state, 'engine-config-self-model') )
      .toEqual({ minIntervalTicks: 200 })
  })

  it('applies additive deltas to matching numeric params, leaving others alone', () => {
    const state = stateWith([
      baseConfig({ minIntervalTicks: 200, minNewExperiences: 20 }),
      priorEntity({ 'engine-config-self-model': { minIntervalTicks: -40 } }),
    ])
    expect( readEffectiveParams( state, 'engine-config-self-model') )
      .toEqual({ minIntervalTicks: 160, minNewExperiences: 20 })
  })

  it('ignores a delta for a param absent from the base', () => {
    const state = stateWith([
      baseConfig({ minIntervalTicks: 200 }),
      priorEntity({ 'engine-config-self-model': { nonexistent: 5 } }),
    ])
    expect( readEffectiveParams( state, 'engine-config-self-model') )
      .toEqual({ minIntervalTicks: 200 })
  })

  it('never mutates the base entity params', () => {
    const base = baseConfig({ minIntervalTicks: 200 })
    const state = stateWith([
      base,
      priorEntity({ 'engine-config-self-model': { minIntervalTicks: -40 } }),
    ])
    readEffectiveParams( state, 'engine-config-self-model')
    expect( ( base.metadata as { params: Record<string, number> } ).params.minIntervalTicks ).toBe( 200 )
  })

  it('derives identically from a reconstructed (restored) entity map — persistence comes free', () => {
    const entities = [
      baseConfig({ minIntervalTicks: 200, minNewExperiences: 20 }),
      priorEntity({ 'engine-config-self-model': { minIntervalTicks: -40, minNewExperiences: 5 } }),
    ]
    const live     = stateWith( entities )
    // Simulate a restore: a brand-new state built from the same persisted entities.
    const restored = stateWith( entities.map( e => ({ ...e }) ) )

    expect( readEffectiveParams( restored, 'engine-config-self-model') )
      .toEqual( readEffectiveParams( live, 'engine-config-self-model') )
    expect( readEffectiveParams( restored, 'engine-config-self-model') )
      .toEqual({ minIntervalTicks: 160, minNewExperiences: 25 })
  })
})

describe('persona.prior — readPersonaPrior', () => {
  it('returns the per-engine delta map, or empty when absent', () => {
    const state = stateWith([ priorEntity({ 'engine-config-self-model': { minIntervalTicks: -40 } }) ])
    expect( readPersonaPrior( state, 'engine-config-self-model') ).toEqual({ minIntervalTicks: -40 })
    expect( readPersonaPrior( state, 'engine-config-energy') ).toEqual({})
  })
})

describe('persona.prior — consolidatePrior (bounded write)', () => {
  const ID = 'engine-config-self-model'
  // One adjustment on minIntervalTicks (base 200 → stepCap 30, totalCap 100).
  const adj = ( proposedDelta: number ) =>
    [ { engineConfigId: ID, param: 'minIntervalTicks', base: 200, proposedDelta } ]

  it('clamps a single step to maxRelStep × |base|', () => {
    // Proposed -90, but per-step cap is 0.15 × 200 = 30.
    const next = consolidatePrior( undefined, adj( -90 ), 1 )
    expect( next.priors[ ID ]!.minIntervalTicks ).toBeCloseTo( -30, 5 )
  })

  it('saturates at the cumulative cap (maxRelMagnitude × |base|) — never diverges', () => {
    let meta: PersonaPriorMeta | undefined
    for( let t = 1; t <= 50; t++ )
      meta = consolidatePrior( meta, adj( -90 ), t )   // hammer downward
    // Cumulative cap = 0.5 × 200 = 100. With decay it settles just under the cap.
    const delta = meta!.priors[ ID ]!.minIntervalTicks
    expect( delta ).toBeGreaterThanOrEqual( -100 )
    expect( delta ).toBeLessThan( -50 )   // clearly accumulated, but bounded
  })

  it('decays an unreinforced prior back toward base (empty adjustments)', () => {
    let meta = consolidatePrior( undefined, adj( -30 ), 1 )
    const start = Math.abs( meta.priors[ ID ]!.minIntervalTicks ?? 0 )
    for( let t = 2; t <= 10; t++ ) meta = consolidatePrior( meta, [], t )
    expect( Math.abs( meta.priors[ ID ]?.minIntervalTicks ?? 0 ) ).toBeLessThan( start )
  })

  it('drops a delta (returns to pure base) once it decays below epsilon', () => {
    // Seed exactly at epsilon (kept), then a single decay pass pushes it under.
    let meta = consolidatePrior( undefined, adj( -1e-6 ), 1 )
    expect( meta.priors[ ID ]!.minIntervalTicks ).toBeCloseTo( -1e-6, 12 )
    meta = consolidatePrior( meta, [], 2 )
    expect( meta.priors[ ID ] ).toBeUndefined()   // engine entry fully cleaned up
  })

  it('ignores a non-numeric / zero base param (cannot bound relative to it)', () => {
    const next = consolidatePrior( undefined, [ { engineConfigId: ID, param: 'minIntervalTicks', base: 0, proposedDelta: -90 } ], 1 )
    expect( next.priors[ ID ] ).toBeUndefined()
  })

  it('applies several adjustments in one pass (multi-edge), decaying once', () => {
    const next = consolidatePrior( undefined, [
      { engineConfigId: 'engine-config-self-model',    param: 'minIntervalTicks', base: 200, proposedDelta: -30 },
      { engineConfigId: 'engine-config-introspection', param: 'cooldownTicks',    base: 50,  proposedDelta: -8  },
    ], 1 )
    expect( next.priors[ 'engine-config-self-model' ]!.minIntervalTicks ).toBeCloseTo( -30, 5 )
    expect( next.priors[ 'engine-config-introspection' ]!.cooldownTicks ).toBeCloseTo( -7.5, 5 )  // 0.15×50 step cap
    expect( next.version ).toBe( 1 )
  })

  it('is deterministic — identical input sequence ⇒ identical prior (R2)', () => {
    const run = (): PersonaPriorMeta | undefined => {
      let m: PersonaPriorMeta | undefined
      for( const d of [ -50, -10, 0, -30, 0, 0 ] ) m = consolidatePrior( m, adj( d ), 1 )
      return m
    }
    expect( run() ).toEqual( run() )
  })

  it('the written delta re-reads through readEffectiveParams as base ⊕ prior', () => {
    const next = consolidatePrior( undefined, adj( -30 ), 1 )
    const state = stateWith([
      baseConfig({ minIntervalTicks: 200 }),
      priorEntity( next.priors ),
    ])
    expect( readEffectiveParams( state, ID ).minIntervalTicks ).toBeCloseTo( 170, 5 )
  })
})

describe('persona.prior — summarizePersonaPrior', () => {
  it('renders active priors as first-person self-observations', () => {
    const state = stateWith([ priorEntity({
      'engine-config-self-model': { minIntervalTicks: -30 },
      'engine-config-semantic':   { beliefStalenessThreshold: -45 },
    }) ])
    const descs = summarizePersonaPrior( state ).map( s => s.description )
    expect( descs ).toContain('re-examining who I am more often')
    expect( descs ).toContain('re-examining my beliefs sooner')
  })

  it('flips the phrase for a positive delta', () => {
    const state = stateWith([ priorEntity({ 'engine-config-introspection': { cooldownTicks: 12 } }) ])
    expect( summarizePersonaPrior( state )[0]!.description ).toBe('introspecting less often')
  })

  it('renders the regulatory edges (inhibition ↑, attention/evidence-gate ↓)', () => {
    const state = stateWith([ priorEntity({
      'engine-config-inhibition': { baseInhibitionStrength: 0.08 },   // edge 6 raises control
      'engine-config-attention':  { shiftInertia: -0.1 },            // edge 8 lowers inertia
      'engine-config-self-model': { minNewExperiences: -3 },         // edge 7 lowers the evidence gate
    }) ])
    const descs = summarizePersonaPrior( state ).map( s => s.description )
    expect( descs ).toContain('holding myself in check more firmly before acting')
    expect( descs ).toContain('shifting my attention more readily')
    expect( descs ).toContain('re-evaluating who I am on less new experience')
  })

  it('is empty with no prior, and omits zero deltas', () => {
    expect( summarizePersonaPrior( stateWith([]) ) ).toEqual( [] )
    const zero = stateWith([ priorEntity({ 'engine-config-self-model': { minIntervalTicks: 0 } }) ])
    expect( summarizePersonaPrior( zero ) ).toEqual( [] )
  })
})

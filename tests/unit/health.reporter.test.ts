// ─────────────────────────────────────────────────────────────
// tests/unit/health.reporter.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * HealthReporter composite scoring — pins the affect/belief/goal blend and the
 * (newly added) sustained-low-valence contribution + the indexed goal lookup.
 */

import { describe, it, expect } from 'vitest'
import { DefaultStateManager } from '#core/state.manager'
import { HealthReporter } from '#stem/tracts/health.reporter'
import type { WillInstance } from '#stem/index'

interface FakeBelief { confidence: number; supportingEpisodes: number }

/** Minimal WillInstance shape the reporter actually touches. */
function makeInstance( opts: {
  metrics?:  Record<string, number>
  goals?:    Array<{ status: string }>
  beliefs?:  FakeBelief[]
} = {} ): WillInstance {
  const sm = new DefaultStateManager()
  sm.updateClock( 100, Date.now() )

  for( const [ k, v ] of Object.entries( opts.metrics ?? {} ) ) sm.setMetric( k, v )
  ;( opts.goals ?? [] ).forEach( ( g, i ) =>
    sm.setEntity({ id: `goal-${i}`, type: 'goal', metadata: { status: g.status } }) )

  return {
    tickCount:  100,
    simulation: { stateManager: sm },
    cognition:  { semanticIntegrator: { getBeliefs: () => opts.beliefs ?? [] } },
  } as unknown as WillInstance
}

const HEALTHY_METRICS = { 'affect.valence': 0.2, 'emotion.frustration': 0.1, 'emotion.irritability': 0.1, 'stress.load': 0.2 }

describe('HealthReporter', () => {
  const reporter = new HealthReporter()

  it('reports healthy for a calm, goal-active, well-calibrated Will', () => {
    const h = reporter.report( makeInstance({
      metrics: HEALTHY_METRICS,
      goals:   [ { status: 'active' }, { status: 'in_progress' } ],
      beliefs: [ { confidence: 0.6, supportingEpisodes: 5 }, { confidence: 0.65, supportingEpisodes: 4 } ],
    }) )
    expect( h.status ).toBe('healthy')
    expect( h.goals ).toEqual({ total: 2, active: 2 })
  })

  it('counts goals via the type index (ignores non-goal entities)', () => {
    const inst = makeInstance({ metrics: HEALTHY_METRICS, goals: [ { status: 'active' }, { status: 'completed' } ] })
    ;( inst.simulation.stateManager as DefaultStateManager ).setEntity({ id: 'belief-x', type: 'belief', metadata: {} })
    const h = reporter.report( inst )
    expect( h.goals ).toEqual({ total: 2, active: 1 })
  })

  it('sustained low valence drags health down even with low frustration/stress', () => {
    const base = reporter.report( makeInstance({ metrics: HEALTHY_METRICS, goals: [ { status: 'active' } ] }) )
    const sad  = reporter.report( makeInstance({
      metrics: { ...HEALTHY_METRICS, 'affect.valence': -0.8 },   // only valence changed
      goals:   [ { status: 'active' } ],
    }) )
    expect( sad.overallScore ).toBeLessThan( base.overallScore )
    expect( sad.affect.valence ).toBe( -0.8 )
  })

  it('flags over-confident, thinly-evidenced beliefs as high risk', () => {
    const h = reporter.report( makeInstance({
      metrics: HEALTHY_METRICS,
      beliefs: [ { confidence: 0.95, supportingEpisodes: 1 }, { confidence: 0.9, supportingEpisodes: 2 } ],
    }) )
    expect( h.beliefs.highRisk ).toBe( 2 )
  })
})

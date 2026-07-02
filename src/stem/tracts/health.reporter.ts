// ─────────────────────────────────────────────────────────────
// src/stem/tracts/health.reporter.ts  —  per-Will cognitive-health reporter
// ─────────────────────────────────────────────────────────────
//
// HealthReporter owns the composite cognitive-health view extracted from
// WillStem (R5-f2): a pure, read-only computation over a running Will's
// belief quality, affect state, and goal state, collapsed into a single
// `overallScore` and a 'healthy' | 'drifting' | 'degraded' status band.
// Intended for developer dashboards and platform monitoring.
//
// WillStem.getCognitiveHealth delegates here. The op touches only
// WillInstance fields (no Will id needed), so this method takes the
// resolved instance directly; WillStem still validates existence via
// _get(id) before delegating.
//
// Behaviour is preserved verbatim from the original WillStem method;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import type { CognitiveHealth, WillInstance } from '#stem/index'

/** Round to 3 decimals — keeps health payloads readable. */
const r3 = ( n: number ): number => Math.round( n * 1000 ) / 1000

export class HealthReporter {
  /**
   * Returns a composite health summary for a running Will.
   * Intended for developer dashboards and platform monitoring.
   *
   * Status bands:
   *   healthy  — normal operating range
   *   drifting — one or more indicators approaching problematic thresholds
   *   degraded — one or more indicators clearly outside healthy range
   */
  report( instance: WillInstance ): CognitiveHealth {
    const
    snap     = instance.simulation.stateManager.snapshot(),
    beliefs  = instance.cognition.semanticIntegrator.getBeliefs(),
    tick     = instance.tickCount

    // ── Belief quality ──────────────────────────────────────────
    const totalBeliefs = beliefs.length
    let
    confidenceSum = 0,
    highRiskCount = 0

    for( const b of beliefs ){
      confidenceSum += b.confidence
      if( b.confidence > 0.85 && b.supportingEpisodes < 3 ) highRiskCount++
    }

    const
    avgConfidence = totalBeliefs > 0 ? confidenceSum / totalBeliefs : 0,
    // Confidence health peaks at ~0.62 and falls off linearly toward either
    // extreme (over-confidence and chronic doubt are both unhealthy).
    beliefScore = totalBeliefs === 0
      ? 0.5  // no beliefs yet — neutral
      : Math.max( 0,
          1.0
          - Math.abs( avgConfidence - 0.62 ) * 1.5  // deviation from ideal
          - ( highRiskCount / Math.max( totalBeliefs, 1 ) ) * 0.8
        )

    // ── Affect state ────────────────────────────────────────────
    // Negative emotions AND sustained low valence both signal distress — the
    // latter is exactly what the executive early-fires on, so health tracks it too.
    const
    valence      = snap.metrics.get('affect.valence')     ?? 0,
    frustration  = snap.metrics.get('emotion.frustration') ?? 0,
    irritability = snap.metrics.get('emotion.irritability') ?? 0,
    stress       = snap.metrics.get('stress.load')         ?? 0,
    isElevated   = irritability > 0.55 || frustration > 0.65 || stress > 0.7,
    affectScore  = Math.max( 0,
      1.0
      - Math.max( 0, frustration  - 0.3  ) * 0.8
      - Math.max( 0, irritability - 0.3  ) * 0.8
      - Math.max( 0, stress       - 0.4  ) * 0.6
      - Math.max( 0, -valence     - 0.15 ) * 0.7   // sustained low valence drags health down
    )

    // ── Goal state ──────────────────────────────────────────────
    // Use the O(1) type index rather than scanning every entity — health is polled.
    let
    activeGoals = 0,
    totalGoals  = 0

    for( const entity of instance.simulation.stateManager.getEntitiesByType('goal') ){
      totalGoals++
      const s = entity.metadata?.status
      if( s === 'active' || s === 'in_progress' ) activeGoals++
    }

    const goalScore = totalGoals === 0
      ? 0.7   // no goals yet — mildly healthy
      : Math.min( 1, 0.4 + ( activeGoals / totalGoals ) * 0.6 )

    // ── Composite ───────────────────────────────────────────────
    const
    overallScore = ( beliefScore * 0.4 ) + ( affectScore * 0.4 ) + ( goalScore * 0.2 ),
    status: CognitiveHealth['status'] =
      overallScore >= 0.65 ? 'healthy'  :
      overallScore >= 0.40 ? 'drifting' : 'degraded'

    return {
      tick,
      status,
      overallScore: r3( overallScore ),
      beliefs: { total: totalBeliefs, avgConfidence: r3( avgConfidence ), highRisk: highRiskCount },
      affect:  { valence: r3( valence ), frustration: r3( frustration ), irritability: r3( irritability ), stress: r3( stress ), isElevated },
      goals:   { total: totalGoals, active: activeGoals }
    }
  }
}

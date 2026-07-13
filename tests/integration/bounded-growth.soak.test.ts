// ─────────────────────────────────────────────────────────────
// tests/integration/bounded-growth.soak.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The "persistent" claim, tested literally: a long-lived mind must not leak.
 * Fixes-program item 4 — runs a quiet standard-tier mind for thousands of
 * ticks and asserts that state stays BOUNDED:
 *
 *   1. total entity count plateaus (no per-tick accretion — even a 0.1/tick
 *      leak would add hundreds over the run);
 *   2. no single entity TYPE grows unboundedly in the second half (transient
 *      types like plan.prior / affordances must churn, not accrete; GC'd types
 *      like terminal plans and consolidated working-memory items must vanish);
 *   3. the metric vocabulary is fixed (a growing metrics map = a key leak,
 *      e.g. tick-stamped metric names);
 *   4. tick latency does not degrade (structure bloat shows up as slowdown).
 *
 * Two tiers: the always-on run (10K ticks, ~6 s at ~0.5 ms/tick) guards CI;
 * WILL_SOAK=1 unlocks the 100K-tick variant for manual/nightly runs.
 *
 * Env isolation: recall fully off + no keys (the capstone's hard-won lesson —
 * bun auto-loads a dev .env, and a live embedder turns an "offline" soak into
 * network calls).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
import type { WillConfig } from '#stem/mind'

const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_SEMANTIC_RECALL:   'false',
  WILL_EMBEDDING_MODEL:   'none',
  WILL_VECTOR_MEMORY:     '',
  WILL_SUMMARY_INTERVAL:  '100000',
  WILL_EMBEDDING_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const _saved: Record<string, string | undefined> = {}

function makeConfig( id: string ): WillConfig {
  return {
    id, name: 'SoakWill', profile: null,
    identity: {
      prompt: 'I am a long-lived test mind used to prove bounded growth.',
      values: [ 'endurance' ], traits: {}, style: 'quiet',
    },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 4242, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

interface Census {
  tick: number
  entities: number
  byType: Map<string, number>
  metricKeys: number
}

function census( state: { tick: number; entities: Map<string, { type: string }>; metrics: Map<string, number> } ): Census {
  const byType = new Map<string, number>()
  for( const e of state.entities.values() )
    byType.set( e.type, ( byType.get( e.type ) ?? 0 ) + 1 )
  return { tick: state.tick, entities: state.entities.size, byType, metricKeys: state.metrics.size }
}

async function runSoak( id: string, totalTicks: number ): Promise<void> {
  const { simulation } = assembleMind( id, makeConfig( id ) )

  const quarter = totalTicks / 4
  const samples: Census[] = []

  for( let q = 0; q < 4; q++ ){
    await simulation.step( quarter )
    samples.push( census( simulation.stateManager.snapshot() as never ) )
  }

  const [ q1, q2, , q4 ] = samples as [ Census, Census, Census, Census ]

  // ── 1. Total entities plateau ────────────────────────────────
  // Second-half growth must be a small fraction of the first-quarter buildup
  // (warm-up populates beliefs/config/identity entities; steady state churns).
  const secondHalfGrowth = q4.entities - q2.entities
  expect( secondHalfGrowth,
    `entities grew ${q2.entities}→${q4.entities} over the second half — per-tick leak?` )
    .toBeLessThan( Math.max( 60, q1.entities * 0.5 ) )

  // ── 2. No single type accretes in the second half ───────────
  for( const [ type, count ] of q4.byType ){
    const at2 = q2.byType.get( type ) ?? 0
    expect( count - at2,
      `entity type "${type}" grew ${at2}→${count} in the second half — unbounded accretion` )
      .toBeLessThan( Math.max( 40, at2 * 0.5 + 20 ) )
  }

  // ── 3. Metric vocabulary is fixed ────────────────────────────
  expect( q4.metricKeys - q2.metricKeys,
    `metric keys grew ${q2.metricKeys}→${q4.metricKeys} — tick-stamped key leak?` )
    .toBeLessThan( 20 )

  // ── 4. Tick latency does not degrade ─────────────────────────
  // Orchestrator keeps the last 1000 latencies; compare their mean to a sane
  // absolute bound (structure bloat manifests as multi-ms heuristic ticks).
  const latencies = ( simulation.orchestrator as unknown as { tickLatencies: readonly number[] } ).tickLatencies
  const recent = latencies.slice( -500 )
  const mean = recent.reduce( ( s, v ) => s + v, 0 ) / recent.length
  expect( mean, `mean tick latency ${mean.toFixed( 2 )}ms after ${totalTicks} ticks` ).toBeLessThan( 10 )
}

describe( 'bounded growth — the persistence soak', () => {
  beforeAll( () => {
    // Quiet the engine for the long run — RESTORED in afterAll: setLogger is a
    // process-global sink, and leaving it installed pollutes later test files
    // that spy on the default logger (caught by CI file-order differences).
    setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: console.error } )
    for( const k of Object.keys( ENV_OVERRIDES ) ){
      _saved[ k ] = process.env[ k ]
      const v = ENV_OVERRIDES[ k ]
      if( v === undefined ) delete process.env[ k ]
      else process.env[ k ] = v
    }
  })
  afterAll( () => {
    resetLogger()
    for( const k of Object.keys( ENV_OVERRIDES ) ){
      const v = _saved[ k ]
      if( v === undefined ) delete process.env[ k ]
      else process.env[ k ] = v
    }
  })

  it( 'a quiet mind stays bounded over 10K ticks', async () => {
    await runSoak( 'soak-10k', 10_000 )
  }, 120_000 )

  it.skipIf( !process.env['WILL_SOAK'] )( 'a quiet mind stays bounded over 100K ticks (WILL_SOAK=1)', async () => {
    await runSoak( 'soak-100k', 100_000 )
  }, 900_000 )
} )

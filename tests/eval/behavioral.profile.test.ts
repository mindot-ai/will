// ─────────────────────────────────────────────────────────────
// tests/eval/behavioral.profile.test.ts — the emergent-behavior regression net
// ─────────────────────────────────────────────────────────────
/**
 * Fixes-program item 5. The engine's heuristic constants (deliberation margins,
 * switch-cost hysteresis, habit relief, stress decay, …) are tuned by feel and
 * coupled across engines — a change to any of them can shift the EMERGENT
 * profile of a mind without failing a single unit test. This harness pins the
 * profile itself.
 *
 * One deterministic scripted life (fixed seed, mock executive, offline):
 *
 *   phase 1  ticks   1–400   quiet baseline
 *   phase 2  tick    401     a hostile threat appears (intensity 0.9)
 *            ticks 401–500   the mind lives under threat
 *   phase 3  tick    501     the threat deactivates
 *            ticks 501–800   recovery
 *
 * Sampled every tick, then asserted as BANDS (not exact values): the run is
 * fully deterministic, but bands keep intentional tuning PRs from dying on
 * noise-level shifts — while a constant change that lobotomizes the mind
 * (never deliberates / always deliberates / ignores threats / never recovers /
 * thrashes between intents) lands far outside them.
 *
 * The measured profile prints on every run: when a tuning PR legitimately
 * moves a signature, update the band CONSCIOUSLY in the same diff.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import type { WillConfig } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'

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

const QUIET_END    = 400
const THREAT_END   = 500
const TOTAL_TICKS  = 800

function makeConfig(): WillConfig {
  return {
    id: 'behavioral-profile', name: 'ProfileWill', profile: null,
    identity: {
      prompt: 'I am a test mind whose emergent behavioral profile is being measured.',
      values: [ 'steadiness' ], traits: {}, style: 'calm',
    },
    engineTier: 'standard', modelTier: 'haiku',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 20_260_704, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

interface Profile {
  /** Executive reasoning cycles per 100 quiet ticks (dual-process economy). */
  executiveCyclesPer100Quiet: number
  /** Fraction of quiet selection ticks flagged `deliberate` (System 2 recruitment). */
  quietDeliberateFraction: number
  /** Committed-intent switches per 100 quiet ticks (hysteresis / no-thrash). */
  intentSwitchesPer100Quiet: number
  /** Mean stress.load over the last 100 quiet ticks. */
  quietStressBaseline: number
  /** Peak stress.load during the threat phase. */
  threatStressPeak: number
  /** Ticks from threat onset until stress.load exceeds baseline + 0.1. */
  threatResponseTicks: number
  /** Ticks from threat removal until stress.load falls within baseline + 0.05. */
  stressRecoveryTicks: number
  /** Proceduralized-schema enactments accumulated by the end (habits formed). */
  habitualCountEnd: number
}

async function measureProfile(): Promise<Profile> {
  const { simulation } = assembleMind( 'behavioral-profile', makeConfig() )
  const sm = simulation.stateManager

  let executiveCycles = 0
  let lastExecutiveTick = -1
  let deliberateTicks = 0, selectionTicks = 0
  let intentSwitches = 0
  let lastIntentSchema: string | null = null
  const quietStressTail: number[] = []
  let threatResponseTicks = -1
  let stressPeak = 0
  let stressRecoveryTicks = -1
  let baseline = 0

  for( let t = 1; t <= TOTAL_TICKS; t++ ){
    if( t === QUIET_END + 1 )
      sm.setEntity( { id: 'eval-threat', type: 'threat', metadata: { hostile: true, intensity: 0.9, active: true } } )
    if( t === THREAT_END + 1 )
      sm.setEntity( { id: 'eval-threat', type: 'threat', metadata: { hostile: true, intensity: 0.9, active: false } } )

    await simulation.step( 1 )
    const s = sm.snapshot()
    const stress = s.metrics.get( 'stress.load' ) ?? 0

    // Quiet-phase signatures
    if( t <= QUIET_END ){
      if( s.metrics.has( 'agency.selection.deliberate' ) ){
        selectionTicks++
        if( ( s.metrics.get( 'agency.selection.deliberate' ) ?? 0 ) > 0 ) deliberateTicks++
      }
      // Track the committed intent's schema — a switch is a change between ticks.
      let schema: string | null = null
      for( const e of s.entities.values() )
        if( e.type === 'agency.intent' ){ schema = String( e.metadata?.schema ?? e.id ); break }
      if( schema !== null && lastIntentSchema !== null && schema !== lastIntentSchema ) intentSwitches++
      if( schema !== null ) lastIntentSchema = schema

      // Count executive cycles via executive.last_tick transitions (the mock
      // path writes no llm.total_calls — token metrics are live-call only).
      const execTick = s.metrics.get( 'executive.last_tick' ) ?? -1
      if( execTick !== lastExecutiveTick ){ if( lastExecutiveTick !== -1 || execTick >= 0 ) executiveCycles++; lastExecutiveTick = execTick }

      if( t > QUIET_END - 100 ) quietStressTail.push( stress )
      if( t === QUIET_END )
        baseline = quietStressTail.reduce( ( a, b ) => a + b, 0 ) / quietStressTail.length
    }

    // Threat phase: response latency + peak
    if( t > QUIET_END && t <= THREAT_END ){
      if( stress > stressPeak ) stressPeak = stress
      if( threatResponseTicks === -1 && stress > baseline + 0.1 )
        threatResponseTicks = t - QUIET_END
    }

    // Recovery phase
    if( t > THREAT_END && stressRecoveryTicks === -1 && stress <= baseline + 0.05 )
      stressRecoveryTicks = t - THREAT_END
  }

  const final = sm.snapshot()

  return {
    executiveCyclesPer100Quiet: ( executiveCycles / QUIET_END ) * 100,
    quietDeliberateFraction:  selectionTicks > 0 ? deliberateTicks / selectionTicks : 0,
    intentSwitchesPer100Quiet: ( intentSwitches / QUIET_END ) * 100,
    quietStressBaseline:      baseline,
    threatStressPeak:         stressPeak,
    threatResponseTicks,
    stressRecoveryTicks,
    habitualCountEnd:         final.metrics.get( 'agency.habitual.count' ) ?? 0,
  }
}

describe( 'behavioral profile — emergent-constant regression bands', () => {
  beforeAll( () => {
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

  it( 'the scripted life stays inside the healthy bands', async () => {
    const p = await measureProfile()

    // Always print — tuning PRs read this to update bands consciously.
    console.log( '─── behavioral profile:', JSON.stringify( p, null, 2 ) )

    // ── Dual-process economy: System 1 must dominate a quiet life ──
    // (mock executive: interval 50 + salience charges ⇒ a handful per 100 ticks;
    // an always-recruiting regression lands >40, a never-recruiting one at 0)
    expect( p.executiveCyclesPer100Quiet ).toBeGreaterThan( 0.5 )
    expect( p.executiveCyclesPer100Quiet ).toBeLessThan( 40 )

    // ── Deliberation gate: rare but alive in quiet ticks ──
    expect( p.quietDeliberateFraction ).toBeLessThan( 0.5 )

    // ── No thrash: switch-cost hysteresis holds ──
    expect( p.intentSwitchesPer100Quiet ).toBeLessThan( 60 )

    // ── Threat responsiveness: stress rises promptly under a hostile threat ──
    expect( p.threatResponseTicks, 'stress never responded to the threat' ).toBeGreaterThan( 0 )
    expect( p.threatResponseTicks ).toBeLessThanOrEqual( 30 )
    expect( p.threatStressPeak ).toBeGreaterThan( p.quietStressBaseline + 0.1 )

    // ── Regulation: stress recovers after the threat deactivates ──
    expect( p.stressRecoveryTicks, 'stress never recovered after threat removal' ).toBeGreaterThan( 0 )
    expect( p.stressRecoveryTicks ).toBeLessThanOrEqual( 250 )

    // ── Growth engine: a lived life proceduralizes something ──
    expect( p.habitualCountEnd ).toBeGreaterThan( 0 )
  }, 180_000 )
} )

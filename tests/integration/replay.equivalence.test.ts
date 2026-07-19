// ─────────────────────────────────────────────────────────────
// tests/integration/replay.equivalence.test.ts
// ─────────────────────────────────────────────────────────────

/**
 * Replay-equivalence harness — the capstone determinism test (REORIENT R2-d).
 *
 * R2 makes determinism a real, enforced invariant. The earlier slices banned
 * wall-clock/`Math.random`/`randomUUID` in the deterministic layers (R2-a/b/c-1)
 * and added the LLM record/re-feed seam (R2-c-2). This test proves the whole
 * promise end-to-end with the LLM *in the loop*:
 *
 *   Run A (record) — a real assembled mind (standard tier → ExecutiveEngine) runs
 *     N ticks with a deterministic clock and a mock LLM. A recorder captures every
 *     completion the executive produces.
 *   Run B (re-feed) — a freshly assembled mind with the SAME seed runs the SAME N
 *     ticks, but with the mock OFF and the recorded completions registered as a
 *     completion source. Every executive LLM call is satisfied from the transcript
 *     instead of the (non-deterministic, network) model.
 *
 * Assertion: run B reproduces run A's snapshot byte-for-byte — same tick, same
 * sim-time, every metric, every entity. This is what "deterministic replay"
 * actually means once an external oracle is involved, and it was untested before.
 *
 * The only field excluded from the comparison is each entity's `createdAt`: it is
 * the one wall-clock value a snapshot carries, seeded at assembly time in
 * src/stem/mind.ts (the stem layer, outside R2's scanned core/cognition
 * determinism boundary). It is creation provenance and feeds no replay
 * computation; everything stamped by the deterministic core — id, type, metadata,
 * `updatedAt`, `updatedAtTick` — must match exactly.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { assembleMind, type WillConfig } from '#stem/mind'
import {
  setCompletionRecorder,
  clearCompletionRecorder,
  setCompletionSource,
  clearCompletionSource,
  RecordedCompletionSource,
  type LLMCompletionRecord,
  type LLMCompletionSource,
} from '#core/completion.recorder'
import type { SimulationEntity, SimulationState } from '#core/types'

const WILL_ID  = 'will-r2d-replay'
const SEED     = 73_939
const TICKS    = 50
const DELTA_MS = 50

// Both runs share one Will id so the executive prompts (which embed the Will's
// identity) are byte-identical — the re-feed source verifies the prompt and
// throws on any divergence.
function makeConfig( testMode: boolean ): WillConfig {
  return {
    id:               WILL_ID,
    name:             'ReplayWill',
    profile:          null,
    identity: {
      prompt: 'I am a deterministic test mind used to prove replay equivalence.',
      values: [ 'honesty', 'curiosity' ],
      traits: { openness: 0.7, caution: 0.5 },
      style:  'concise',
    },
    anatomy: 'mind',                       // adds the ExecutiveEngine (LLM in the loop)
    persistentMemory:  false,
    snapshotInterval:  999_999,
    tickIntervalMs:    0,
    randomSeed:        SEED,
    executiveInterval: 5,                                // fire often → several completions captured
    clock:             { fixedDeltaMs: DELTA_MS, startTime: 0 },  // deterministic sim-time
    testMode,
  }
}

/** Drop the lone wall-clock provenance field; see the file header. */
function comparable( e: SimulationEntity ): Record<string, unknown> {
  const { createdAt: _createdAt, ...rest } = e
  return rest
}

/**
 * Wraps the strict re-feed source and counts only *successful* completions.
 * A miss or a prompt divergence throws inside the inner source (before the
 * counter increments), so a final `consumed === recorded` proves every executive
 * call in run B was served from the transcript — never a live model call.
 */
class CountingSource implements LLMCompletionSource {
  consumed = 0
  constructor( private readonly _inner: LLMCompletionSource ){}
  nextCompletion( tick: number, systemPrompt: string, userMessage: string ): LLMCompletionRecord {
    const record = this._inner.nextCompletion( tick, systemPrompt, userMessage ) as LLMCompletionRecord
    this.consumed++
    return record
  }
}

// ── Env isolation ─────────────────────────────────────────────
// Keep the run deterministic and offline: dormant async summarizer, no vector
// memory (no embedder network calls), and no live LLM key — the re-feed source
// must satisfy every executive call, so a stray live attempt should fail loudly
// rather than spend money or introduce non-determinism.
const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_SUMMARY_INTERVAL:  '100000',
  WILL_VECTOR_MEMORY:     '',
  // Recall must be FULLY off, not just key-less: a dev .env (auto-loaded by bun)
  // can carry WILL_SEMANTIC_RECALL=true + a google/… embedding model + a live
  // GOOGLE key, silently turning "offline" runs into real network embeds inside
  // buildExecutiveContext — chains hang/settle on network latency and the run
  // stops being deterministic. (This hole is what masked layer 3 for a while.)
  WILL_SEMANTIC_RECALL:   'false',
  WILL_EMBEDDING_MODEL:   'none',
  WILL_EMBEDDING_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  WILL_LLM_API_KEY:       undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const _savedEnv: Record<string, string | undefined> = {}

describe('Replay equivalence — LLM-as-oracle re-feed (R2-d)', () => {
  beforeAll( () => {
    for( const key of Object.keys( ENV_OVERRIDES ) ){
      _savedEnv[ key ] = process.env[ key ]
      const value = ENV_OVERRIDES[ key ]
      if( value === undefined ) delete process.env[ key ]
      else process.env[ key ] = value
    }
  })

  afterAll( () => {
    for( const key of Object.keys( ENV_OVERRIDES ) ){
      const value = _savedEnv[ key ]
      if( value === undefined ) delete process.env[ key ]
      else process.env[ key ] = value
    }
  })

  afterEach( () => {
    clearCompletionRecorder( WILL_ID )
    clearCompletionSource( WILL_ID )
  })

  /**
   * Step the simulation one tick at a time, draining each beat to QUIESCENCE.
   *
   * The facet-era executive is asynchronous ACROSS ticks: an LLM call issued at
   * tick N resolves off-tick (real timers + promise chains) and its effects are
   * consumed by later ticks. A single synchronous `step(N)` never yields, so the
   * pipeline starves and the recorder captures nothing. Fixed-round drains are
   * WORSE: capture becomes wall-clock-sensitive (2–5 completions per run on the
   * same seed). Draining until the completion counter stops moving pins every
   * chain to the tick that spawned it — in BOTH runs — which is precisely the
   * temporal determinism the equivalence assertion needs.
   */
  async function stepSettled(
    sim:     { step: ( n: number ) => Promise<unknown> | unknown },
    ticks:   number,
    counter: () => number,
  ): Promise<void> {
    for( let t = 0; t < ticks; t++ ){
      await sim.step( 1 )
      // Drain until the counter is quiet for 100 ms (20 × 5 ms rounds, cap 400).
      // The quiet window must DWARF the chain's internal timer hops (~4–20 ms
      // under bun's nested-setTimeout clamping): a 15 ms window races them and
      // turns this into a heisentest (a single console.log flipped the result).
      let last = -1, quiet = 0
      for( let r = 0; r < 400 && quiet < 20; r++ ){
        await new Promise( res => setTimeout( res, 5 ) )
        const now = counter()
        quiet = now === last ? quiet + 1 : 0
        last  = now
      }
    }
  }

  // RE-ENABLED (2026-07-04) — this test was skipped while the facet-era engine
  // had a real determinism gap. All three layers are now closed:
  //   1. LANDING (CompletionInbox): facet decision effects land tick-quantized
  //      in Phase 2 instead of at raw LLM-promise resolution.
  //   2. PAIRING (prompt-keyed re-feed): RecordedCompletionSource matches by
  //      byte-identical prompt within the tick — order-independent, still strict.
  //   3. ISSUE (per-tick facet pump): reasoning launches from the ExecutiveEngine
  //      react() pump with the tick's frozen snapshot, never at raw report time —
  //      issue tick and prompt bytes are pure functions of (tick, seed, inputs).
  // History + design record: .TODO/FACET_REPLAY_DETERMINISM.md.
  // NOTE the env-isolation lesson in ENV_OVERRIDES: recall must be FULLY off or
  // a dev .env silently turns this offline test into live network embeds.
  it('reproduces byte-identical state by re-feeding recorded LLM completions', async () => {
    // ── Run A: record ──────────────────────────────────────────
    const recordsA: LLMCompletionRecord[] = []
    setCompletionRecorder( WILL_ID, { recordCompletion: r => recordsA.push({ ...r }) } )

    const { simulation: simA } = assembleMind( WILL_ID, makeConfig( true ) )
    await stepSettled( simA, TICKS, () => recordsA.length )
    const snapA: SimulationState = simA.stateManager.snapshot()
    clearCompletionRecorder( WILL_ID )

    // The executive must actually have driven the LLM, or this proves nothing.
    expect( recordsA.length ).toBeGreaterThan( 0 )

    // ── Run B: re-feed ─────────────────────────────────────────
    // testMode OFF: without the source the director would hit the live API. The
    // source short-circuits every call with the recorded completion instead.
    const source = new CountingSource( new RecordedCompletionSource( recordsA ) )
    setCompletionSource( WILL_ID, source )

    const { simulation: simB } = assembleMind( WILL_ID, makeConfig( false ) )
    await stepSettled( simB, TICKS, () => source.consumed )
    const snapB: SimulationState = simB.stateManager.snapshot()
    clearCompletionSource( WILL_ID )

    // Every recorded completion was re-fed exactly once — no live call, no divergence.
    expect( source.consumed ).toBe( recordsA.length )

    // ── Byte-identical clock ───────────────────────────────────
    expect( snapB.tick ).toBe( TICKS )
    expect( snapB.tick ).toBe( snapA.tick )
    expect( snapB.time ).toBe( TICKS * DELTA_MS )   // deterministic clock: ticks × delta
    expect( snapB.time ).toBe( snapA.time )

    // ── Full metric equivalence — every key, not a hand-picked subset ──
    const metricKeys = new Set([ ...snapA.metrics.keys(), ...snapB.metrics.keys() ])
    for( const key of metricKeys )
      expect( snapB.metrics.get( key ), `metric "${key}" diverged on replay`)
        .toBe( snapA.metrics.get( key ) )
    expect( snapB.metrics.size ).toBe( snapA.metrics.size )

    // ── Full entity equivalence — every entity (createdAt provenance aside) ──
    expect( snapB.entities.size ).toBe( snapA.entities.size )
    const entityIds = new Set([ ...snapA.entities.keys(), ...snapB.entities.keys() ])
    for( const id of entityIds ){
      const a = snapA.entities.get( id )
      const b = snapB.entities.get( id )
      expect( b, `entity "${id}" present in run A but missing on replay`).toBeDefined()
      expect( a, `entity "${id}" present in run B but absent from run A`).toBeDefined()
      expect( comparable( b! ), `entity "${id}" diverged on replay`).toEqual( comparable( a! ) )
    }
  }, 120_000 )
})

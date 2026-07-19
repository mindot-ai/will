// ─────────────────────────────────────────────────────────────
// tests/integration/replay.conversation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Conversation-path replay equivalence — the peer to replay.equivalence (R2-d),
 * which exercises only the MASTER executive. Here a scripted conversation
 * (auditionEngine.ingest → conversation facet → [REPLY_TEXT] → outbox) runs
 * with the LLM in the loop:
 *
 *   Run A (record)  — mock LLM, ingest "Hello…" at a fixed tick, run N ticks;
 *                     a recorder captures every completion.
 *   Run B (re-feed) — fresh mind, same seed, same scripted ingest; mock OFF,
 *                     recorded completions served via RecordedCompletionSource.
 *
 * Assertions: the REPLY itself is byte-identical (content + target + the sim
 * tick it entered the outbox), and the full state snapshot matches metric-for-
 * metric, entity-for-entity. This closes fix-direction 3 of
 * .TODO/AUDITION_REPLY_DETERMINISM.md: conversational Wills replay, not just
 * background cognition.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { assembleMind, type WillConfig } from '#stem/mind'
import {
  setCompletionRecorder, clearCompletionRecorder,
  setCompletionSource, clearCompletionSource,
  RecordedCompletionSource,
  type LLMCompletionRecord,
  type LLMCompletionSource,
} from '#core/completion.recorder'
import type { SimulationEntity, SimulationState } from '#core/types'
import type { OutboxMessage } from '#types'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )

const WILL_ID     = 'will-replay-conversation'
const SEED        = 424242
const TICKS       = 40
const INGEST_TICK = 10
const DELTA_MS    = 50
const MESSAGE     = 'Hello, who are you?'

function makeConfig( testMode: boolean ): WillConfig {
  return {
    id:               WILL_ID,
    name:             'ReplayEcho',
    profile:          null,
    identity: {
      prompt: 'I am ReplayEcho, a deterministic conversational test mind.',
      values: [ 'honesty' ],
      traits: { openness: 0.7 },
      style:  'concise',
    },
    anatomy: 'mind',
    persistentMemory:  false,
    snapshotInterval:  999_999,
    tickIntervalMs:    0,
    randomSeed:        SEED,
    executiveInterval: 5,
    clock:             { fixedDeltaMs: DELTA_MS, startTime: 0 },
    // The conversation surface: listen (inbound) + talk/text (the reply path).
    allowedGenericEffectors: [ 'listen', 'talk', 'text' ],
    testMode,
  }
}

/** Wall-clock provenance stripped (same rule as the R2-d capstone). */
function comparable( e: SimulationEntity ): Record<string, unknown> {
  const { createdAt: _createdAt, ...rest } = e
  return rest
}

/** The reply facts that must replay byte-identically (wall-clock ids/times aside). */
function replyFacts( rows: OutboxMessage[] ): Array<Record<string, unknown>> {
  return rows.map( r => ( {
    to:      r.targetEntityId,
    content: r.content,
    via:     r.effectorName,
    tick:    r.createdAtTick,
  } ) )
}

class CountingSource implements LLMCompletionSource {
  consumed = 0
  constructor( private readonly _inner: LLMCompletionSource ){}
  nextCompletion( tick: number, systemPrompt: string, userMessage: string ): LLMCompletionRecord {
    const record = this._inner.nextCompletion( tick, systemPrompt, userMessage ) as LLMCompletionRecord
    this.consumed++
    return record
  }
}

// Offline discipline (belt) — the testMode network-embedder guard in
// _resolveVectorMemory is the suspenders; both runs must never touch a network.
const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_SUMMARY_INTERVAL:        '100000',
  WILL_VECTOR_MEMORY:           '',
  WILL_SEMANTIC_RECALL:         'false',
  WILL_EMBEDDING_MODEL:         'none',
  WILL_EMBEDDING_API_KEY:       undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  WILL_LLM_API_KEY:             undefined,
  ANTHROPIC_API_KEY:            undefined,
}
const _savedEnv: Record<string, string | undefined> = {}

describe('Replay equivalence — scripted conversation (audition path)', () => {
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
    resetLogger()
  })

  afterEach( () => {
    clearCompletionRecorder( WILL_ID )
    clearCompletionSource( WILL_ID )
  })

  /** Per-tick quiescence drain — same discipline as the R2-d capstone. */
  async function stepSettled(
    sim:     { step: ( n: number ) => Promise<unknown> | unknown },
    ticks:   number,
    counter: () => number,
  ): Promise<void> {
    for( let t = 0; t < ticks; t++ ){
      await sim.step( 1 )
      let last = -1, quiet = 0
      for( let r = 0; r < 400 && quiet < 20; r++ ){
        await new Promise( res => setTimeout( res, 5 ) )
        const now = counter()
        quiet = now === last ? quiet + 1 : 0
        last  = now
      }
    }
  }

  /**
   * One scripted conversation run: step to INGEST_TICK, deliver the message
   * (NOT awaited — ingest blocks on the turn, which resolves only as later
   * ticks pump the facet and land the decision), then step to TICKS.
   */
  async function run( testMode: boolean, counter: () => number ): Promise<{
    snap: SimulationState; outbox: OutboxMessage[]; turn: Promise<void>
  }> {
    const { simulation, cognition, outbox } = assembleMind( WILL_ID, makeConfig( testMode ) )
    await stepSettled( simulation, INGEST_TICK, counter )

    const turn = cognition.auditionEngine.ingest( {
      kind: 'text', entityId: 'sam', threadId: 't1', content: MESSAGE, speakerName: 'Sam',
    } as never ) as unknown as Promise<void>

    await stepSettled( simulation, TICKS - INGEST_TICK, counter )
    return { snap: simulation.stateManager.snapshot(), outbox, turn }
  }

  it('replays a conversation byte-identically — reply content, reply tick, full state', async () => {
    // ── Run A: record ──────────────────────────────────────────
    const recordsA: LLMCompletionRecord[] = []
    setCompletionRecorder( WILL_ID, { recordCompletion: r => recordsA.push({ ...r }) } )
    const a = await run( true, () => recordsA.length )
    clearCompletionRecorder( WILL_ID )

    expect( recordsA.length ).toBeGreaterThan( 0 )        // the LLM was in the loop
    expect( a.outbox.length ).toBeGreaterThan( 0 )        // and the Will actually replied
    await a.turn                                          // turn resolved (no timeout leak)

    // ── Run B: re-feed ─────────────────────────────────────────
    const source = new CountingSource( new RecordedCompletionSource( recordsA ) )
    setCompletionSource( WILL_ID, source )
    const b = await run( false, () => source.consumed )
    clearCompletionSource( WILL_ID )
    await b.turn

    // Every recorded completion re-fed exactly once — no live call, no divergence.
    expect( source.consumed ).toBe( recordsA.length )

    // ── The reply replays byte-identically ─────────────────────
    expect( replyFacts( b.outbox ) ).toEqual( replyFacts( a.outbox ) )

    // ── Clock ──────────────────────────────────────────────────
    expect( b.snap.tick ).toBe( a.snap.tick )
    expect( b.snap.time ).toBe( a.snap.time )

    // ── Full metric equivalence ────────────────────────────────
    const metricKeys = new Set([ ...a.snap.metrics.keys(), ...b.snap.metrics.keys() ])
    for( const key of metricKeys )
      expect( b.snap.metrics.get( key ), `metric "${key}" diverged on replay`)
        .toBe( a.snap.metrics.get( key ) )

    // ── Full entity equivalence ────────────────────────────────
    expect( b.snap.entities.size ).toBe( a.snap.entities.size )
    const entityIds = new Set([ ...a.snap.entities.keys(), ...b.snap.entities.keys() ])
    for( const id of entityIds ){
      const ea = a.snap.entities.get( id )
      const eb = b.snap.entities.get( id )
      expect( eb, `entity "${id}" missing on replay`).toBeDefined()
      expect( ea, `entity "${id}" absent from run A`).toBeDefined()
      expect( comparable( eb! ), `entity "${id}" diverged on replay`).toEqual( comparable( ea! ) )
    }
  }, 180_000 )
})

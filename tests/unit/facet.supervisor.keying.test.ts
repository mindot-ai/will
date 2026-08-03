// ─────────────────────────────────────────────────────────────
// tests/unit/facet.supervisor.keying.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Facet lifecycle, measured against what actually happened to a live Will.
 *
 * From one 29.7-minute production session (`lora.trace.jsonl`, 2929 ticks):
 * 290 facet spawns and 235 destroys — ten a minute. The idle TTL was a hardcoded
 * 50 ticks and the measured tick rate was 1.64/s, so a conversation facet was
 * destroyed THIRTY SECONDS after the human stopped typing. Replies in that
 * session were one to three minutes apart, so every message the operator sent
 * arrived at a facet that had never heard of him, and the mind re-asked a
 * question he had already answered. Four times.
 *
 * Three things had to be true and were not:
 *   1. a quiet thread outlives a human pause;
 *   2. one person is one thread — not a new facet per message, and not a rival
 *      facet opened alongside;
 *   3. losing the instance does not lose the thinking.
 */

import { describe, it, expect, vi } from 'vitest'
import { FacetSupervisor, type FacetSpawnDeps } from '#faculties/executive.engine/facet.supervisor'
import type { ReadonlySimulationState } from '#core/types'

// ── harness ───────────────────────────────────────────────────

vi.mock('#faculties/executive.engine/facet', () => {
  class ExecutiveFacet {
    facetId: string
    busy = false
    private _tick = 0
    private _history: string[] = []
    destroyed = false
    constructor( id: string ){ this.facetId = id }
    get lastActiveTick(){ return this._tick }
    markActive( t: number ){ this._tick = t }
    get reasoningHistory(){ return [ ...this._history ] }
    restoreReasoningHistory( h: string[] ){ this._history = [ ...h ] }
    /** Test-only: pretend the facet reasoned. */
    think( s: string ){ this._history.push( s ) }
    setStateRef(){ /* noop */ }
    setFocus(){ /* noop */ }
    report(){ /* noop */ }
    subscribe(){ return () => {} }
    setChunkHandler(){ /* noop */ }
    pump(){ /* noop */ }
    attachSessionLogger(){ /* noop */ }
    destroy(){ this.destroyed = true }
  }
  return { ExecutiveFacet }
} )

/** State at `tick`, optionally carrying an engine-config mirror. */
const stateAt = ( tick: number, params?: Record<string, unknown> ): ReadonlySimulationState => ( {
  tick,
  entities: new Map( params
    ? [ [ 'engine-config-executive', { id: 'engine-config-executive', type: 'engine.config', metadata: { engine: 'executive', params } } ] ]
    : [] ),
  metrics: new Map(),
} as unknown as ReadonlySimulationState )

const deps = ( state: ReadonlySimulationState, key?: string ): FacetSpawnDeps => ( {
  bus: {} as never, llmDirector: {} as never, stateRef: state,
  contextDeps: {} as never, promptDeps: {} as never, willId: 'w',
  ...( key ? { key } : {} ),
} )

/** Reach the mocked facet instance behind a handle. */
const facetOf = ( sup: FacetSupervisor, id: string ): { busy: boolean; think( s: string ): void; destroyed: boolean } =>
  ( sup as unknown as { _facets: Map<string, never> } )._facets.get( id ) as never

// ── 1. a quiet thread outlives a human pause ──────────────────

describe('the idle TTL is a property of the person, not a constant', () => {
  it('defaults to a human timescale, not thirty seconds', () => {
    const sup = new FacetSupervisor()
    const a = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!

    // 50 ticks — the old hardcoded TTL, ~30 seconds live. He is still typing.
    sup.pump( stateAt( 51 ) )
    expect( sup.size, 'a conversation must survive a pause longer than half a minute').toBe( 1 )

    // Same person speaks again: the SAME facet, not a cold replacement.
    expect( sup.spawn( deps( stateAt( 60 ), 'conversation:fabrice') ).handle!.facetId ).toBe( a.facetId )
  } )

  it('is read from the persona, so a mind can develop how long a thread stays open', () => {
    const sup = new FacetSupervisor()
    sup.spawn( deps( stateAt( 0, { facetIdleTtlTicks: 100 } ), 'conversation:fabrice') )

    sup.pump( stateAt( 90, { facetIdleTtlTicks: 100 } ) )
    expect( sup.size ).toBe( 1 )
    sup.pump( stateAt( 101, { facetIdleTtlTicks: 100 } ) )
    expect( sup.size ).toBe( 0 )
  } )

  it('still reaps a genuinely abandoned thread', () => {
    const sup = new FacetSupervisor()
    sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') )
    sup.pump( stateAt( 4000 ) )
    expect( sup.size ).toBe( 0 )
  } )
} )

// ── 2. one person is one thread ───────────────────────────────

describe('a key is a thread of attention, and there is one facet per thread', () => {
  it('returns the open facet rather than opening a rival on the same subject', () => {
    const sup = new FacetSupervisor()
    const first  = sup.spawn( deps( stateAt( 0 ),  'conversation:fabrice') ).handle!
    const second = sup.spawn( deps( stateAt( 10 ), 'conversation:fabrice') ).handle!

    expect( second.facetId ).toBe( first.facetId )
    expect( sup.size ).toBe( 1 )
  } )

  it('keeps different people apart', () => {
    const sup = new FacetSupervisor()
    const a = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!
    const b = sup.spawn( deps( stateAt( 0 ), 'conversation:ada') ).handle!
    expect( a.facetId ).not.toBe( b.facetId )
    expect( sup.size ).toBe( 2 )
  } )

  it('reusing a facet stamps it active, so answering does not age the thread out', () => {
    const sup = new FacetSupervisor()
    sup.spawn( deps( stateAt( 0, { facetIdleTtlTicks: 100 } ), 'conversation:fabrice') )
    // Reuse at 90 — inside the TTL. Without the re-stamp the next pump would reap it.
    sup.spawn( deps( stateAt( 90, { facetIdleTtlTicks: 100 } ), 'conversation:fabrice') )
    sup.pump( stateAt( 150, { facetIdleTtlTicks: 100 } ) )
    expect( sup.size ).toBe( 1 )
  } )

  it('opens a fresh facet once the keyed one is gone', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10 })
    const first = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!
    sup.pump( stateAt( 20 ) )
    const second = sup.spawn( deps( stateAt( 21 ), 'conversation:fabrice') ).handle!
    expect( second.facetId ).not.toBe( first.facetId )
  } )
} )

// ── 3. eviction takes the cheapest loss ───────────────────────

describe('pressure eviction never takes the live conversation first', () => {
  it('evicts a keyless transient before an open thread', () => {
    // The observed inversion: deciding to message someone spawned a transient
    // authoring facet, which evicted the LIVE CONVERSATION FACET WITH THAT SAME
    // PERSON — a conversation facet waiting on a human reply is, correctly, not
    // busy, so it was the most attractive LRU victim in the registry.
    const sup = new FacetSupervisor()
    const cfg = { maxFacets: 2 }

    const convo     = sup.spawn( deps( stateAt( 0, cfg ), 'conversation:fabrice') ).handle!
    const transient = sup.spawn( deps( stateAt( 5, cfg ) ) ).handle!   // outreach authoring — no key

    // Budget full. A new thread arrives; the transient is the cheapest loss even
    // though the conversation is older (plain LRU would have taken the conversation).
    sup.spawn( deps( stateAt( 9, cfg ), 'conversation:ada') )

    expect( facetOf( sup, transient.facetId ) ).toBeUndefined()
    expect( facetOf( sup, convo.facetId ) ).toBeDefined()
  } )

  it('falls back to the oldest open thread when every facet is keyed', () => {
    const sup = new FacetSupervisor()
    const cfg = { maxFacets: 2 }
    const oldest = sup.spawn( deps( stateAt( 0, cfg ), 'conversation:a') ).handle!
    sup.spawn( deps( stateAt( 5, cfg ), 'conversation:b') )
    sup.spawn( deps( stateAt( 9, cfg ), 'conversation:c') )

    expect( facetOf( sup, oldest.facetId ) ).toBeUndefined()
    expect( sup.size ).toBe( 2 )
  } )

  it('takes a busy facet only as a last resort — it drops an in-flight decision', () => {
    const sup = new FacetSupervisor()
    const cfg = { maxFacets: 2 }
    const busy  = sup.spawn( deps( stateAt( 0, cfg ) ) ).handle!
    const quiet = sup.spawn( deps( stateAt( 5, cfg ) ) ).handle!
    facetOf( sup, busy.facetId ).busy = true

    sup.spawn( deps( stateAt( 9, cfg ) ) )

    expect( facetOf( sup, quiet.facetId ), 'the quiet one goes first even though it is newer').toBeUndefined()
    expect( facetOf( sup, busy.facetId ) ).toBeDefined()
  } )
} )

// ── 4. losing the instance does not lose the thinking ─────────

describe('continuity belongs to the thread, not the facet carrying it', () => {
  it('resumes the prior reasoning when a reaped thread is re-opened', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10 })
    const first = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!
    facetOf( sup, first.facetId ).think('he is waiting on MindBurn; do not re-ask')

    sup.pump( stateAt( 20 ) )                       // reaped — he took a while to reply
    const second = sup.spawn( deps( stateAt( 21 ), 'conversation:fabrice') ).handle!

    expect( ( facetOf( sup, second.facetId ) as unknown as { reasoningHistory: string[] } ).reasoningHistory )
      .toEqual( [ 'he is waiting on MindBurn; do not re-ask' ] )
  } )

  it('carries it across an explicit destroy too', () => {
    const sup = new FacetSupervisor()
    const first = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!
    facetOf( sup, first.facetId ).think('mid-thought')
    first.destroy()

    const second = sup.spawn( deps( stateAt( 1 ), 'conversation:fabrice') ).handle!
    expect( ( facetOf( sup, second.facetId ) as unknown as { reasoningHistory: string[] } ).reasoningHistory )
      .toEqual( [ 'mid-thought' ] )
  } )

  it('never leaks one thread\'s thinking into another\'s', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10 })
    const a = sup.spawn( deps( stateAt( 0 ), 'conversation:fabrice') ).handle!
    facetOf( sup, a.facetId ).think('private to Fabrice')
    sup.pump( stateAt( 20 ) )

    const b = sup.spawn( deps( stateAt( 21 ), 'conversation:ada') ).handle!
    expect( ( facetOf( sup, b.facetId ) as unknown as { reasoningHistory: string[] } ).reasoningHistory ).toEqual( [] )
  } )

  it('carries nothing for a keyless facet — a transient has no thread to resume', () => {
    const sup = new FacetSupervisor({ idleTtlTicks: 10 })
    const t = sup.spawn( deps( stateAt( 0 ) ) ).handle!
    facetOf( sup, t.facetId ).think('one-shot')
    sup.pump( stateAt( 20 ) )

    const next = sup.spawn( deps( stateAt( 21 ) ) ).handle!
    expect( ( facetOf( sup, next.facetId ) as unknown as { reasoningHistory: string[] } ).reasoningHistory ).toEqual( [] )
  } )
} )

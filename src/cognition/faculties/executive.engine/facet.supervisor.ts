// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/facet.supervisor.ts
// ─────────────────────────────────────────────────────────────
//
// FacetSupervisor — facet lifecycle + attention budget (R5-g-3).
//
// A "facet" is a focused instance of the executive consciousness: an
// independent ExecutiveFacet reasoning loop that shares the master's
// cognitive state (identity, values, beliefs, memories) but runs OUTSIDE the
// tick cycle. PlanningEngine / AuditionEngine spawn facets to pursue work in
// parallel with the master; the master stays in charge of the global
// workspace.
//
// This collaborator owns the facet registry and the attention budget that
// caps how many may run at once:
//   • _facets        — live facet instances, keyed by id
//   • _facetCounter  — monotonic id source (facet-1, facet-2, …)
//   • _attentionFreeCapacity — free attention (0–1), updated from
//     `attention.state.changed`; it SCALES the ceiling below rather than being it.
//   • the ceiling itself is `engine-config-executive.maxFacets` read through the
//     persona-prior — how many things this particular mind can hold at once, a
//     trait the metacognition loop develops, not a constant.
//
// It also keeps `_lastStateRef` / `_sessionLogger` fresh so a facet's
// deferred destroy() logs against the same live values the engine would —
// broadcastStateRef() runs in the engine's reasonAsync (the only place the
// engine's own state ref changes), so the two never diverge.
//
// Deliberately left in the engine (not here):
//   • the `executive.facet.sync` / `audition.task.signal` bus subscriptions
//     and the `_facetSyncSubscribed` guard — they push into the engine's
//     gating salience buffer and are shared with the escalation path;
//   • the `executive.master.sync` publish — it reads the master's reasoning
//     output; the engine publishes it gated on `size`.
//
// Extracted from ExecutiveEngine (R5-g-3) as a delegating collaborator.
// `ExecutiveEngine.spawnFacet()` forwards here with an unchanged signature.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { ReadonlySimulationState } from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
import type { LLMDirector } from '#llm/index'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { ExecutiveFacet, type ExecutiveFacetHandle } from '#faculties/executive.engine/facet'
import type { CompletionInbox } from '#cognition/completion.inbox'
import type { ContextDependencies } from '#faculties/executive.engine/context'
import type { PromptDependencies } from '#faculties/executive.engine/prompt.factory'
import { readEffectiveParams } from '#cognition/persona.prior'

/**
 * Facets a Will can hold at once when nothing is seeded — the same value
 * `buildEngineConfigEntities` seeds, so a supervisor running against a state with
 * no engine-config mirror (unit tests, bare harnesses) behaves like a real mind
 * rather than collapsing to the old cap of 3.
 */
const DEFAULT_MAX_FACETS = 10

/**
 * The engine attachments a spawn needs, captured at call time. bus / director
 * / stateRef are required (spawn throws when any is missing); contextDeps /
 * promptDeps are built fresh by the engine from its current manager handles.
 */
export interface FacetSpawnDeps {
  bus:          CognitiveBus | null
  llmDirector:  LLMDirector | null
  stateRef:     ReadonlySimulationState | null
  contextDeps:  ContextDependencies
  promptDeps:   PromptDependencies
  willId:       string | null
  /** Tick-boundary landing for decision effects (see cognition/completion.inbox). */
  inbox?:       CompletionInbox | null
}

export type SpawnResult =
  { attention: 'available' | 'full', handle?: ExecutiveFacetHandle }

export class FacetSupervisor {
  private _facets = new Map<string, ExecutiveFacet>()
  private _facetCounter = 0
  private _attentionFreeCapacity = 1

  // Kept fresh so a facet's (later) destroy() logs against the same live
  // values the engine would — see broadcastStateRef / attachSessionLogger.
  private _lastStateRef: ReadonlySimulationState | null = null
  private _sessionLogger: SessionLogger | null = null

  /** Reap callbacks per facet — fired when the supervisor reaps (idle/LRU), not on explicit destroy(). */
  private _onReaped = new Map<string, () => void>()
  /** Ticks of inactivity before a facet is reaped (reclaims its attention budget). */
  private readonly _idleTtlTicks: number
  /** When the budget is full, evict the least-recently-active facet instead of refusing a spawn. */
  private readonly _evictLruOnPressure: boolean

  constructor( opts: { idleTtlTicks?: number; evictLruOnPressure?: boolean } = {} ){
    this._idleTtlTicks       = opts.idleTtlTicks       ?? 50
    this._evictLruOnPressure = opts.evictLruOnPressure ?? true
  }

  /** Number of live facets — the engine gates `master.sync` on this. */
  get size(): number { return this._facets.size }

  /** Ids of the facets currently alive — the engine prunes its subject map against these. */
  liveFacetIds(): Set<string> { return new Set( this._facets.keys() ) }

  /**
   * Ids of the facets currently REASONING — queued reports or an in-flight
   * `_reason()`. These are what the mind is actually attending to, and the engine
   * turns them into `attention.demand` entities so they cost the AttentionAllocator
   * real capacity.
   *
   * The distinction is the whole two-level model: an open facet is a thread the
   * mind is IN (bounded by the persona's `maxFacets`), a busy one is a thread it is
   * ATTENDING TO (bounded by the allocator's `maxFoci`, and paid for out of the
   * same 100-unit budget as every other focus). You can be in ten conversations and
   * attending to two. Without this, holding conversations cost the allocator
   * nothing, so `freeFraction` — the very signal the facet budget scales on —
   * reported the same spare attention whether the mind was idle or mid-thread with
   * three people.
   */
  busyFacetIds(): string[] {
    const out: string[] = []
    for( const [ id, facet ] of this._facets )
      if( facet.busy ) out.push( id )
    return out
  }

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  /**
   * Update the attention budget from an `attention.state.changed` event.
   *
   * `freeFraction` is the allocator's normalized 0–1 spare-attention signal
   * (free capacity ÷ baseline capacity). It scales the persona's facet ceiling:
   * fully free ⇒ the whole ceiling, half free ⇒ about half of it, never below 1.
   * (It must stay normalized — an earlier version received the raw 0–100 capacity,
   * inflating the budget ~100× so facets were bounded only by TTL/LRU.)
   */
  setAttentionState( freeFraction: number ): void {
    this._attentionFreeCapacity = Math.max( 0, freeFraction )
  }

  /** Push the latest state reference to every live facet (called each reasonAsync). */
  broadcastStateRef( state: ReadonlySimulationState ): void {
    this._lastStateRef = state
    for( const facet of this._facets.values() )
      facet.setStateRef( state )

    // Idle reaper: reclaim facets with no activity within the TTL window so a
    // quiet conversation never leaks attention budget forever. Sim tick only.
    this._reapIdle( state.tick as unknown as number )
  }

  /**
   * Per-tick pump — called from ExecutiveEngine.react() with the tick's frozen
   * snapshot. Refreshes every facet's state reference AND launches reasoning for
   * their queued reports (tick-discipline mode), in facet-creation order — a
   * fixed point in the serial engine schedule, so issue timing is deterministic.
   * Subsumes broadcastStateRef for the per-tick path; broadcastStateRef remains
   * for the master's mid-reasonAsync refresh.
   */
  pump( state: ReadonlySimulationState ): void {
    this._lastStateRef = state
    for( const facet of this._facets.values() )
      facet.pump( state )

    this._reapIdle( state.tick as unknown as number )
  }

  private _reapIdle( tick: number ): void {
    for( const [ id, facet ] of [ ...this._facets ] ){
      // Never reap a busy facet: queued reports / an in-flight LLM call span
      // many ticks (a real call is 10–30s), and destroying the facet clears the
      // listeners its pending decision lands on — a conversation reply would
      // vanish silently. The TTL measures *quiet* facets only.
      if( facet.busy ) continue
      if( tick - facet.lastActiveTick > this._idleTtlTicks )
        this._reap( id, 'idle')
    }
  }

  /** Destroy + deregister a facet and notify its owner. Shared by the reaper + LRU eviction. */
  private _reap( facetId: string, reason: 'idle' | 'lru'): void {
    const facet = this._facets.get( facetId )
    if( !facet ) return

    facet.destroy()
    this._facets.delete( facetId )
    const onReaped = this._onReaped.get( facetId )
    this._onReaped.delete( facetId )

    logger.info(`[executive] facet ${facetId} reaped (${reason}); remaining: ${this._facets.size}`)
    this._sessionLogger?.write({
      type:        'executive.facet.destroy',
      tick:        this._lastStateRef?.tick as unknown as number ?? 0,
      facetId,
      reason,
      totalFacets: this._facets.size,
    } as any)

    // Notify the owner (e.g. AuditionEngine) so it drops its handle + session state.
    try { onReaped?.() }
    catch( err ){ logger.error(`[executive] facet ${facetId} onReaped error:`, err ) }
  }

  private _leastRecentlyActive(): string | null {
    // Prefer a quiet victim: evicting a busy facet drops its in-flight decision
    // (same silent-loss mode the idle reaper guards against). Only when every
    // facet is busy does pressure eviction fall back to the absolute LRU — a
    // new conversation still preempts rather than being refused.
    let id: string | null = null
    let min = Infinity
    for( const [ fid, facet ] of this._facets )
      if( !facet.busy && facet.lastActiveTick < min ){ min = facet.lastActiveTick; id = fid }
    if( id ) return id

    for( const [ fid, facet ] of this._facets )
      if( facet.lastActiveTick < min ){ min = facet.lastActiveTick; id = fid }
    return id
  }

  /**
   * Spawn a focused facet of the executive consciousness.
   *
   * Creates an independent reasoning instance that shares the master's
   * cognitive state (identity, values, beliefs, memories) but operates
   * outside the tick cycle. The facet syncs bidirectionally with the
   * master via cognitive bus events.
   *
   * Returns a handle with report() and subscribe() methods.
   * The caller (PlanningEngine) uses report() to push step outcomes
   * and subscribe() to receive facet decisions.
   */
  spawn( deps: FacetSpawnDeps ): SpawnResult {
    if( !deps.bus )
      throw new Error('Cannot spawn facet — CognitiveBus not attached. Was addEngine() called?')

    if( !deps.llmDirector )
      throw new Error('Cannot spawn facet — LLM director not initialized. Set willId first.')

    if( !deps.stateRef )
      throw new Error('Cannot spawn facet — no state snapshot available. Wait for first tick.')

    // Authoritative current state ref from the engine — keep it so a later
    // destroy() logs the same tick the engine would.
    this._lastStateRef = deps.stateRef

    // How many focused facets this mind can hold at once.
    //
    // This is the OPEN-THREAD level. Its sibling is the allocator's
    // `engine-config-attention.maxFoci` — how many things the mind ATTENDS TO at
    // once — and the two are one economy, not two budgets: a facet that is actually
    // reasoning is published as an `attention.demand` (ExecutiveEngine.
    // _facetAttentionDemands) and competes for those foci slots against every
    // percept, paying `costPerFocus` out of the same 100-unit capacity. So a Will
    // can be IN ten conversations while ATTENDING TO two, and the cost of the ones
    // it is attending to flows back into the free fraction below. The same
    // openness/conscientiousness pair develops both levels (consolidator 27c/27d),
    // so they move together rather than drifting apart.
    //
    // Two layers, deliberately separate:
    //   • the CEILING is who this person is — `engine-config-executive.maxFacets`
    //     read through the persona-prior, so openness widens it and
    //     conscientiousness narrows it as the Will demonstrates those traits. It is
    //     a property of the mind, not a constant in the code.
    //   • the live ALLOWANCE is how loaded it is right now — spare attention scales
    //     the ceiling, so a tired or saturated mind takes on fewer new threads and
    //     recovers the room as attention frees up.
    //
    // Previously the second layer WAS the ceiling (one facet per 0.3 free units,
    // max 3), which put a hard architectural cap on the mind that no personality
    // could move: at 52% night capacity it resolved to exactly 1, so a Will could
    // hold one conversation and every second person to speak evicted the first.
    const ceiling   = Math.max( 1, Math.round( readEffectiveParams( deps.stateRef, 'engine-config-executive').maxFacets ?? DEFAULT_MAX_FACETS ) )
    const maxFacets = Math.max( 1, Math.min( ceiling, Math.round( ceiling * this._attentionFreeCapacity ) ) )

    if( this._facets.size >= maxFacets ){
      if( !this._evictLruOnPressure ){
        logger.info(`[executive] attention full (${this._facets.size}/${maxFacets} facets) `)
        return { attention: 'full' }
      }
      // Budget full but a new conversation arrived — evict the least-recently-active
      // facet so a fresh, live conversation preempts a stale one (no silent drop).
      const lru = this._leastRecentlyActive()
      if( !lru ) return { attention: 'full' }   // nothing evictable (shouldn't happen)
      logger.info(`[executive] attention full (${this._facets.size}/${maxFacets}) — evicting LRU facet ${lru}`)
      this._reap( lru, 'lru')
    }

    this._facetCounter++
    const facetId = `facet-${this._facetCounter}`

    const facet = new ExecutiveFacet(
      facetId,
      deps.bus,
      deps.llmDirector,
      deps.contextDeps,
      deps.promptDeps,
      deps.willId!,
      deps.inbox ?? null
    )

    // Attach session logger if available
    if( this._sessionLogger )
      facet.attachSessionLogger( this._sessionLogger )

    // Set initial state reference + stamp initial activity (spawn tick).
    facet.setStateRef( deps.stateRef )
    facet.markActive( deps.stateRef.tick as unknown as number )

    this._facets.set( facetId, facet )

    logger.info(`[executive] spawned facet → ${facetId} (total facets: ${this._facets.size})`)

    this._sessionLogger?.write({
      type:      'executive.facet.spawn',
      tick:      deps.stateRef.tick as unknown as number,
      facetId,
      totalFacets: this._facets.size,
    } as any)

    return {
      attention: 'available',
      handle: {
        facetId,
        setFocus:         ( focus )    => facet.setFocus( focus ),
        setStateRef:      ( state )    => facet.setStateRef( state ),
        report:           ( report )   => facet.report( report ),
        subscribe:        ( listener ) => facet.subscribe( listener ),
        onChunk:          ( handler )  => facet.setChunkHandler( handler ),
        onReaped:         ( handler )  => { this._onReaped.set( facetId, handler ) },
        destroy: () => {
          facet.destroy()
          this._facets.delete( facetId )
          this._onReaped.delete( facetId )   // explicit close — owner already knows; don't fire onReaped
          logger.info(`[executive] facet ${facetId} destroyed (remaining: ${this._facets.size})`)
          this._sessionLogger?.write({
            type:      'executive.facet.destroy',
            tick:      this._lastStateRef?.tick as unknown as number ?? 0,
            facetId,
            totalFacets: this._facets.size,
          } as any)
        }
      }
    }
  }
}

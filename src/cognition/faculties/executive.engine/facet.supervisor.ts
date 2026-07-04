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
//     `attention.state.changed`; one facet is allowed per ~0.3 free units.
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

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  /**
   * Update the attention budget from an `attention.state.changed` event.
   *
   * `freeFraction` is the allocator's normalized 0–1 spare-attention signal
   * (free capacity ÷ baseline capacity). It is consumed directly — one facet per
   * ~0.3 free units — so the budget binds on the same scale the `0.3` constant
   * and the default (`1` → 3 facets) assume. (Pre-fix this received the raw 0–100
   * capacity, inflating the budget ~100× so facets were bounded only by TTL/LRU.)
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
    for( const [ id, facet ] of [ ...this._facets ] )
      if( tick - facet.lastActiveTick > this._idleTtlTicks )
        this._reap( id, 'idle' )
  }

  /** Destroy + deregister a facet and notify its owner. Shared by the reaper + LRU eviction. */
  private _reap( facetId: string, reason: 'idle' | 'lru' ): void {
    const facet = this._facets.get( facetId )
    if( !facet ) return

    facet.destroy()
    this._facets.delete( facetId )
    const onReaped = this._onReaped.get( facetId )
    this._onReaped.delete( facetId )

    logger.info( `[executive] facet ${facetId} reaped (${reason}); remaining: ${this._facets.size}` )
    this._sessionLogger?.write({
      type:        'executive.facet.destroy',
      tick:        this._lastStateRef?.tick as unknown as number ?? 0,
      facetId,
      reason,
      totalFacets: this._facets.size,
    } as any)

    // Notify the owner (e.g. AuditionEngine) so it drops its handle + session state.
    try { onReaped?.() }
    catch( err ){ logger.error( `[executive] facet ${facetId} onReaped error:`, err ) }
  }

  private _leastRecentlyActive(): string | null {
    let id: string | null = null
    let min = Infinity
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
      throw new Error( 'Cannot spawn facet — CognitiveBus not attached. Was addEngine() called?' )

    if( !deps.llmDirector )
      throw new Error( 'Cannot spawn facet — LLM director not initialized. Set willId first.' )

    if( !deps.stateRef )
      throw new Error( 'Cannot spawn facet — no state snapshot available. Wait for first tick.' )

    // Authoritative current state ref from the engine — keep it so a later
    // destroy() logs the same tick the engine would.
    this._lastStateRef = deps.stateRef

    // One facet per ~0.3 free capacity units, floor at 1
    const maxFacets = Math.max( 1, Math.floor( this._attentionFreeCapacity / 0.3 ) )
    if( this._facets.size >= maxFacets ){
      if( !this._evictLruOnPressure ){
        logger.info( `[executive] attention full (${this._facets.size}/${maxFacets} facets) ` )
        return { attention: 'full' }
      }
      // Budget full but a new conversation arrived — evict the least-recently-active
      // facet so a fresh, live conversation preempts a stale one (no silent drop).
      const lru = this._leastRecentlyActive()
      if( !lru ) return { attention: 'full' }   // nothing evictable (shouldn't happen)
      logger.info( `[executive] attention full (${this._facets.size}/${maxFacets}) — evicting LRU facet ${lru}` )
      this._reap( lru, 'lru' )
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

    logger.info( `[executive] spawned facet → ${facetId} (total facets: ${this._facets.size})` )

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
          logger.info( `[executive] facet ${facetId} destroyed (remaining: ${this._facets.size})` )
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

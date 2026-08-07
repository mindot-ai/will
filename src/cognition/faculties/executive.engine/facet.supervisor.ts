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
//   • _byKey/_keyOf  — a facet's THREAD identity (`FacetSpawnDeps.key`), so one
//     subject is one facet however many callers ask for it, and so eviction can
//     tell an open conversation from a one-shot transient.
//   • _reasoningByKey — a thread's own reasoning, outliving the instance that
//     carried it, so re-opening resumes rather than starting cold.
//   • _attentionFreeCapacity — free attention (0–1), updated from
//     `attention.state.changed`; it SCALES the ceiling below rather than being it.
//   • the ceiling itself is `engine-config-executive.maxFacets` read through the
//     persona-prior — how many things this particular mind can hold at once, a
//     trait the metacognition loop develops, not a constant. Its sibling
//     `facetIdleTtlTicks` — how long a QUIET thread stays open — is read the same
//     way, for the same reason.
//
// It also keeps `_lastStateRef` / `_sessionLogger` fresh so a facet's
// deferred destroy() logs against the same live values the engine would —
// broadcastStateRef() runs in the engine's reasonAsync (the only place the
// engine's own state ref changes), so the two never diverge.
//
// Deliberately left in the engine (not here):
//   • `executive.facet.sync` / `executive.facet.handoff` handling — dispatched from
//     ExecutiveEngine.onCognitiveEvent (the bus keeps ONE subscription per
//     engineId, so a dedicated `subscribe(this.name, …)` is overwritten by the
//     orchestrator's registration); they push into the engine's gating salience
//     buffer and are shared with the escalation path;
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
 * Ticks of quiet before a facet is reaped, when nothing is seeded.
 *
 * This was a hardcoded 50 and it was catastrophic. Measured on a live Will at
 * 1.64 ticks/second, 50 ticks is THIRTY SECONDS — so a conversation facet was
 * destroyed half a minute after the human stopped typing. Her operator's replies
 * were one to three minutes apart, which means every message he sent arrived at a
 * brand-new facet with an empty reasoning history: 290 spawns and 235 destroys in
 * a 29-minute session, ten a minute. She was not losing the thread; the thread was
 * being destroyed between his turns, and re-asking the question he had already
 * answered is exactly what a cold facet does.
 *
 * The right scale is human, not machine: a conversation stays open across the pause
 * where someone goes to make coffee. 3000 ticks is ~30 minutes at that rate. Nothing
 * is leaked by being generous here — `maxFacets` plus LRU eviction is what actually
 * bounds the population, and this only decides when a QUIET thread is considered over.
 */
const DEFAULT_FACET_IDLE_TTL_TICKS = 3000

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
  /**
   * What this facet is FOR — a caller-chosen identity for the thread, e.g.
   * `conversation:discord:1019…`. Two spawns with the same key are the same
   * thread of attention, so the second returns the first's handle instead of
   * opening a rival facet on the same subject.
   *
   * Keying is opt-in because not every facet has a subject (a one-shot
   * deliberation does not). But a keyless facet is also the one the mind can
   * most afford to lose, so eviction takes those first — see _evictionVictim.
   *
   * Without this the registry was keyed only by `facet-N` and every caller
   * deduplicated (or didn't) on its own: AuditionEngine kept one facet per
   * speaker, `authorOutreach` kept none, and a proactive message to someone
   * could evict the live conversation with that same person.
   */
  key?:         string
}

export type SpawnResult = { attention: 'available' | 'full', handle?: ExecutiveFacetHandle }

/**
 * How a facet gets built. Exists so a caller can stand something else in place of
 * a real reasoning loop — chiefly a test that wants to observe the REGISTRY
 * (keying, eviction, continuity) without paying for an LLM director.
 *
 * A seam rather than a module mock, deliberately. `mock.module` / `vi.mock` is
 * process-global and permanent in Bun's runner: one file mocking this module
 * replaced ExecutiveFacet for every file that loaded AFTER it, in the same
 * process. That turned a green branch red — the audition reply tests sat waiting
 * on a facet whose `pump()` was a no-op and timed out at 30s — and because the
 * damage follows file order, the failing set differed between CI and a local run,
 * which reads exactly like flake. Injection is scoped to the supervisor that asked
 * for it and cannot reach anybody else.
 */
export type FacetFactory = ( facetId: string, deps: FacetSpawnDeps ) => ExecutiveFacet

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

  /** Live handles by facetId — returned again when a keyed spawn matches an open thread. */
  private _handles = new Map<string, ExecutiveFacetHandle>()
  /** `FacetSpawnDeps.key` → facetId, for the keyed spawns. */
  private _byKey = new Map<string, string>()
  /** facetId → its key, so reaping can clear both directions. */
  private _keyOf = new Map<string, string>()

  /**
   * A keyed thread's own prior reasoning, surviving the facet that produced it.
   *
   * A facet reaped mid-conversation used to take its train of thought with it: the
   * transcript survived (AuditionEngine holds the digest by thread) but everything
   * the mind had privately worked out about that person was gone, so the replacement
   * facet re-derived it — or, more often, re-asked. Continuity belongs to the thread,
   * not to the instance that happened to be carrying it.
   */
  private _reasoningByKey = new Map<string, string[]>()

  /** Constructor override for the idle TTL — null means read it from the persona. */
  private readonly _idleTtlOverride: number | null
  /** When the budget is full, evict the least-recently-active facet instead of refusing a spawn. */
  private readonly _evictLruOnPressure: boolean
  /** What a spawn constructs — see FacetFactory. */
  private readonly _createFacet: FacetFactory

  constructor( opts: { idleTtlTicks?: number; evictLruOnPressure?: boolean; createFacet?: FacetFactory } = {} ){
    this._idleTtlOverride    = opts.idleTtlTicks ?? null
    this._evictLruOnPressure = opts.evictLruOnPressure ?? true
    // `spawn` throws on a missing bus / director / stateRef before it ever gets
    // here, so the factory is only ever called with those present — the same
    // reason `willId` was already asserted at this call.
    this._createFacet        = opts.createFacet ?? ( ( facetId, deps ) => new ExecutiveFacet(
      facetId,
      deps.bus!,
      deps.llmDirector!,
      deps.contextDeps,
      deps.promptDeps,
      deps.willId!,
      deps.inbox ?? null
    ) )
  }

  /**
   * How long a quiet facet lives, in ticks.
   *
   * Read through the persona-prior like `maxFacets`, because it is the same kind of
   * fact about a person: how long a conversation stays open for them before it feels
   * finished. It was the one number in this economy that no personality could move —
   * the ceiling was developable while the thing doing the killing was a constant.
   */
  private _idleTtl( state: ReadonlySimulationState | null ): number {
    if( this._idleTtlOverride != null ) return this._idleTtlOverride
    if( !state ) return DEFAULT_FACET_IDLE_TTL_TICKS
    return Math.max(
      1,
      Math.round(
        readEffectiveParams( state, 'engine-config-executive').facetIdleTtlTicks
          ?? DEFAULT_FACET_IDLE_TTL_TICKS
      )
    )
  }

  /** Number of live facets — the engine gates `master.sync` on this. */
  get size(): number { return this._facets.size }

  /**
   * The facet already carrying `key`, if any — WITHOUT opening one.
   *
   * Lets a caller ask "am I already attending to this?" and act differently when
   * the answer is yes. The case it exists for: the mind decides, on its own
   * initiative, to say something to someone it is ALREADY in conversation with.
   * That is not a second thread; it is a thing to say in the thread that is open.
   */
  handleFor( key: string ): ExecutiveFacetHandle | undefined {
    const id = this._byKey.get( key )
    return id ? this._handles.get( id ) : undefined
  }

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
    const ttl = this._idleTtl( this._lastStateRef )
    for( const [ id, facet ] of [ ...this._facets ] ){
      // Never reap a busy facet: queued reports / an in-flight LLM call span
      // many ticks (a real call is 10–30s), and destroying the facet clears the
      // listeners its pending decision lands on — a conversation reply would
      // vanish silently. The TTL measures *quiet* facets only.
      if( facet.busy ) continue
      if( tick - facet.lastActiveTick > ttl )
        this._reap( id, 'idle')
    }
  }

  /** Destroy + deregister a facet and notify its owner. Shared by the reaper + LRU eviction. */
  private _reap( facetId: string, reason: 'idle' | 'lru'): void {
    const facet = this._facets.get( facetId )
    if( !facet ) return

    // Keep the thread's reasoning before the instance carrying it is destroyed,
    // so a later spawn on the same key resumes rather than starting cold.
    const key = this._keyOf.get( facetId )
    if( key ){
      const carried = facet.reasoningHistory
      if( carried.length ) this._reasoningByKey.set( key, carried )
      this._byKey.delete( key )
      this._keyOf.delete( facetId )
    }

    facet.destroy()
    this._facets.delete( facetId )
    this._handles.delete( facetId )
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

  /**
   * Who gets evicted when the budget is full, in order of what the mind can
   * afford to lose:
   *
   *   1. quiet AND keyless — a transient facet (a one-shot authoring pass, a
   *      deliberation) with nobody on the other end of it;
   *   2. quiet but keyed — an open thread with a real subject;
   *   3. busy — last resort, and it drops an in-flight decision.
   *
   * Tier 1 exists because of an observed inversion: a proactive outreach spawn
   * would evict the LIVE CONVERSATION FACET WITH THAT SAME PERSON. A conversation
   * facet waiting on the human's next message is, correctly, not `busy` — so it was
   * the most attractive LRU victim in the registry, and deciding to message someone
   * destroyed the conversation already open with them.
   */
  private _evictionVictim(): string | null {
    const oldestIn = ( pick: ( id: string, f: ExecutiveFacet ) => boolean ): string | null => {
      let id: string | null = null
      let min = Infinity
      for( const [ fid, facet ] of this._facets )
        if( pick( fid, facet ) && facet.lastActiveTick < min ){ min = facet.lastActiveTick; id = fid }
      return id
    }

    return oldestIn( ( fid, f ) => !f.busy && !this._keyOf.has( fid ) )
        ?? oldestIn( ( _fid, f ) => !f.busy )
        ?? oldestIn( () => true )
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

    // Same key ⇒ same thread of attention. Hand back the facet already carrying
    // it rather than opening a rival on the same subject: two facets on one person
    // is two minds answering as one, and both of them were reported to `_facetSubjects`,
    // so the master read itself as being in two conversations with the same person.
    if( deps.key ){
      const openId = this._byKey.get( deps.key )
      const open   = openId ? this._handles.get( openId ) : undefined
      if( open ){
        this._facets.get( openId! )?.markActive( deps.stateRef.tick as unknown as number )
        logger.info(`[executive] facet ${openId} reused for "${deps.key}"`)
        return { attention: 'available', handle: open }
      }
    }

    // How many focused facets this mind can hold at once.
    //
    // This is the OPEN-THREAD level. Its sibling is the allocator's
    // `engine-config-attention.maxFoci` — how many things the mind ATTENDS TO at
    // once — and the two are one economy, not two budgets: a facet that is actually
    // reasoning is published as an `attention` (ExecutiveEngine.
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
      // Budget full but a new thread arrived — evict the cheapest loss (transient
      // and quiet first, an open conversation only if there is nothing else) so a
      // live thread preempts a stale one without a silent drop.
      const lru = this._evictionVictim()
      if( !lru ) return { attention: 'full' }   // nothing evictable (shouldn't happen)
      logger.info(`[executive] attention full (${this._facets.size}/${maxFacets}) — evicting facet ${lru}`)
      this._reap( lru, 'lru')
    }

    this._facetCounter++
    const facetId = `facet-${this._facetCounter}`

    const facet = this._createFacet( facetId, deps )

    // Attach session logger if available
    if( this._sessionLogger )
      facet.attachSessionLogger( this._sessionLogger )

    // Set initial state reference + stamp initial activity (spawn tick).
    facet.setStateRef( deps.stateRef )
    facet.markActive( deps.stateRef.tick as unknown as number )

    this._facets.set( facetId, facet )

    if( deps.key ){
      this._byKey.set( deps.key, facetId )
      this._keyOf.set( facetId, deps.key )

      // Resume the thread's own thinking. The words were never lost (the digest
      // survives with the thread); what was lost was everything the mind had
      // privately worked out about this person, which is why a replacement facet
      // re-asked what it had already been told.
      const carried = this._reasoningByKey.get( deps.key )
      if( carried?.length ){
        facet.restoreReasoningHistory( carried )
        logger.info(`[executive] facet ${facetId} resumed "${deps.key}" (${carried.length} prior turns)`)
      }
    }

    logger.info(`[executive] spawned facet → ${facetId} (total facets: ${this._facets.size})`)

    this._sessionLogger?.write({
      type:      'executive.facet.spawn',
      tick:      deps.stateRef.tick as unknown as number,
      facetId,
      ...( deps.key ? { key: deps.key } : {} ),
      totalFacets: this._facets.size,
    } as any)

    const handle: ExecutiveFacetHandle = {
      facetId,
      setFocus:         ( focus )    => facet.setFocus( focus ),
      setStateRef:      ( state )    => facet.setStateRef( state ),
      report:           ( report )   => facet.report( report ),
      subscribe:        ( listener ) => facet.subscribe( listener ),
      onChunk:          ( handler )  => facet.setChunkHandler( handler ),
      onReaped:         ( handler )  => { this._onReaped.set( facetId, handler ) },
      destroy: () => {
        const key = this._keyOf.get( facetId )
        if( key ){
          const carried = facet.reasoningHistory
          if( carried.length ) this._reasoningByKey.set( key, carried )
          this._byKey.delete( key )
          this._keyOf.delete( facetId )
        }
        facet.destroy()
        this._facets.delete( facetId )
        this._handles.delete( facetId )
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

    this._handles.set( facetId, handle )
    return { attention: 'available', handle }
  }
}

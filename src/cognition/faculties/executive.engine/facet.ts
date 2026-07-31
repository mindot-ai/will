// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/facet.ts
// ─────────────────────────────────────────────────────────────

/**
 * ExecutiveFacet — focused attentional instance of the executive consciousness.
 *
 * Facets are true projections of the master executive identity:
 *   - Share master's identity, values, beliefs, and memories
 *   - Access LIVE state each reasoning cycle (not frozen snapshot)
 *   - Use the same PromptFactory as master for consistent prompting
 *   - Only the FOCUS section differentiates them from master
 *
 * The facet syncs bidirectionally with the master via cognitive bus events.
 * The focus section is provided by the creator engine (PlanningEngine, etc.)
 * via setFocus() — the facet has no hardcoded assumptions about what it's
 * reasoning about.
 *
 * Part of Shard 3 (Executive Layer) — runs asynchronously outside tick cycle.
 */

import { logger } from '#core/logger'
import type { ReadonlySimulationState } from '#core/types'
import { wallClock } from '#core/wall.clock'
import type { CognitiveBus } from '#cognition/bus'
import type { CompletionInbox } from '#cognition/completion.inbox'
import type { LLMDirector, LLMCallMeta } from '#llm/index'
import type { ExecutiveOutputFull, IdeationCandidate } from '#faculties/executive.engine/types'
import type { ContextDependencies } from '#faculties/executive.engine/context'
import type { SessionLogger } from '#stem/tracts/session.logger'
import {
  PromptFactory,
  type PromptDependencies,
  type FocusSection
} from '#faculties/executive.engine/prompt.factory'
import { parseResponse, buildFallbackOutput } from '#faculties/executive.engine/parser'
import { selectProcess, ideationTemperature, DELIBERATE_THRESHOLD } from '#faculties/executive.engine/effort.gate'
import { proposeCandidates } from '#faculties/executive.engine/deliberate.reasoning'
import { readEffectiveParams } from '#cognition/persona.prior'

// ── Facet event types ─────────────────────────────────────────

/**
 * Generic report interface — the facet doesn't interpret this.
 * The creator engine defines the structure and interprets responses.
 */
export interface FacetReport {
  /** The reason for this report (creator-defined) */
  type: string
  /** The payload content (creator-defined structure) */
  payload: unknown
  /** Optional context identifier for routing */
  contextId?: string
  /** Optional dynamic instructions to append to the user message */
  instructions?: string
}

export interface FacetDecision {
  facetId: string
  /** The reason/report type this decision responds to */
  respondingToType: string
  /** The decision payload (creator-defined structure) */
  decision: unknown
  reasoning: string
  confidence: number
}

export type FacetEventListener = ( decision: FacetDecision ) => void

export interface ExecutiveFacetHandle {
  /** Push a report into the facet — triggers a reasoning cycle */
  report: ( report: FacetReport ) => void
  /** Subscribe to facet decisions — returns unsubscribe function */
  subscribe: ( listener: FacetEventListener ) => () => void
  /** The facet's unique identifier */
  facetId: string
  /** Destroy the facet — unsubscribes from bus, cleans up */
  destroy: () => void
  /** Set the focus for this facet (called by creator before first report) */
  setFocus: ( focus: FocusSection ) => void
  /** Set the current state reference (called by orchestrator) */
  setStateRef: ( state: ReadonlySimulationState ) => void
  /**
   * Register a per-facet chunk handler.
   * Called when the creating engine wants per-entity token streaming
   * (e.g. AuditionEngine, one handler per conversation session).
   * Fires for every LLM token during `_reason()` — in addition to any
   * global `_chunkBroadcaster` wired via `setChunkBroadcaster()` on the
   * master ExecutiveEngine.
   */
  onChunk: ( handler: ( chunk: string ) => void ) => void
  /**
   * Register a callback fired when the supervisor REAPS this facet (idle TTL or
   * LRU eviction), as opposed to an explicit `destroy()`. Lets the owner (e.g.
   * AuditionEngine) drop its handle reference + session state when the facet is
   * reclaimed out from under it. Not fired by `destroy()`.
   */
  onReaped: ( handler: () => void ) => void
}

// ── ExecutiveFacet ────────────────────────────────────────────

export class ExecutiveFacet {
  readonly facetId: string

  private _bus: CognitiveBus
  private _llmDirector: LLMDirector
  private _contextDeps: ContextDependencies
  private _promptDeps: PromptDependencies
  private _willId: string
  private _listeners = new Set<FacetEventListener>()
  private _destroyed = false
  private _sessionLogger: SessionLogger | null = null

  /**
   * Tick-boundary landing (see cognition/completion.inbox.ts). When present,
   * subscriber notification is STAGED at LLM-promise resolution and applied by
   * the CognitiveOrchestrator in Phase 2 — so PlanningEngine / AuditionEngine
   * effects (plan mutations, outbox writes) never interleave with a tick in
   * flight. Null = legacy direct notification (bare facets in unit tests).
   */
  private _inbox: CompletionInbox | null = null

  /**
   * Reports waiting for the per-tick pump (tick-discipline mode only). Reasoning
   * launches from pump(), never from report() — see report() for why.
   */
  private _pendingReports: FacetReport[] = []

  /** Current focus for this facet — set by creator (PlanningEngine, etc.) */
  private _currentFocus: FocusSection | null = null

  /** Accumulated reasoning history for continuity across report() calls */
  private _facetReasoningHistory: string[] = []
  private _masterSyncHistory: string[] = []

  /** Confidence of this facet's *previous* decision — a dual-process gate signal. */
  private _lastConfidence = 0.5

  /** Current state reference (updated by orchestrator each tick) */
  private _currentStateRef: ReadonlySimulationState | null = null

  /**
   * Sim tick of the last activity (report). Used by FacetSupervisor's idle
   * reaper + LRU eviction. Sim tick (deterministic), never wallClock.
   */
  private _lastActiveTick = 0
  get lastActiveTick(): number { return this._lastActiveTick }
  /** Stamp activity at `tick` (called at spawn and on each report). */
  markActive( tick: number ): void { this._lastActiveTick = tick }

  /** _reason() calls currently in flight — a real LLM call spans many ticks. */
  private _inflight = 0
  /**
   * True while the facet has work the reaper must not discard: queued reports
   * awaiting the pump, or an in-flight _reason() whose decision hasn't landed.
   * The idle TTL only measures *quiet* facets — reaping a busy one destroys the
   * listeners its pending decision needs, silently dropping a conversation reply.
   */
  get busy(): boolean { return this._inflight > 0 || this._pendingReports.length > 0 }

  /**
   * Per-facet chunk handler — fires for every LLM token during _reason().
   * Set by the creating engine (e.g. AuditionEngine) for entity-scoped streaming.
   * Independent from the master's global _chunkBroadcaster.
   */
  private _chunkHandler: (( chunk: string ) => void) | null = null

  constructor(
    facetId: string,
    bus: CognitiveBus,
    llmDirector: LLMDirector,
    contextDeps: ContextDependencies,
    promptDeps: PromptDependencies,
    willId: string,
    inbox: CompletionInbox | null = null
  ){
    this.facetId = facetId
    this._bus = bus
    this._llmDirector = llmDirector
    this._contextDeps = contextDeps
    this._promptDeps = promptDeps
    this._willId = willId
    this._inbox = inbox

    // Subscribe to master sync events
    this._bus.subscribe(
      `executive-facet-${facetId}`,
      [ 'executive.master.sync' ],
      this._onMasterSync
    )

    logger.info(`[executive.facet] ${facetId} created`)
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Set the focus for this facet.
   * Called by the creator (PlanningEngine, etc.) before first report.
   */
  setFocus( focus: FocusSection ): void {
    this._currentFocus = focus
  }

  /**
   * Set the current state reference.
   * Called by the orchestrator each tick to keep facet in sync.
   */
  setStateRef( state: ReadonlySimulationState ): void {
    this._currentStateRef = state
  }

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  /** Register a per-facet chunk handler for entity-scoped token streaming. */
  setChunkHandler( handler: ( chunk: string ) => void ): void {
    this._chunkHandler = handler
  }

  async report( report: FacetReport ): Promise<void> {
    if( this._destroyed ) return

    // Stamp activity so the supervisor's idle reaper keeps an active facet alive.
    this.markActive( ( this._currentStateRef?.tick as number ) ?? this._lastActiveTick )

    logger.info(
      `[executive.facet] ${this.facetId} received report: type=${report.type}`
    )

    // Tick-discipline mode (inbox attached — the same signal that quantizes
    // decision LANDING): reasoning must not START at raw report time either.
    // A report can arrive from any wall-clock context (an ingest chain, another
    // chain's resolution), and launching _reason() there makes both the issue
    // tick and the prompt bytes race-dependent — the prompt reads live manager
    // state at whatever moment the chain happened to run. Queue instead; the
    // ExecutiveEngine pumps every facet once per tick (react() → supervisor
    // .pump()) with that tick's frozen snapshot, so reasoning launches at a
    // deterministic point with deterministic inputs. See
    // .TODO/FACET_REPLAY_DETERMINISM.md (layer 3).
    if( this._inbox ){
      this._pendingReports.push( report )
      return
    }

    // Legacy (bare facets in unit tests): trigger reasoning immediately.
    this._launchReason( report )
  }

  /**
   * Launch _reason() with in-flight accounting. `busy` must hold for the whole
   * span (a real LLM call is 10–30s ≈ many ticks) so the supervisor's idle
   * reaper never destroys a facet whose decision is still coming — that would
   * clear its listeners and silently drop the reply. Completion re-stamps
   * activity so the idle TTL measures quiet time *after* the decision, not
   * after the report that started it.
   */
  private _launchReason( report: FacetReport ): void {
    this._inflight++
    this._reason( report )
      .catch( err =>
        logger.error(`[executive.facet] ${this.facetId} reasoning error:`, err )
      )
      .finally( () => {
        this._inflight--
        this.markActive( ( this._currentStateRef?.tick as number ) ?? this._lastActiveTick )
      })
  }

  /**
   * Per-tick pump — called by the FacetSupervisor from the ExecutiveEngine's
   * react() with the tick's FROZEN snapshot. Refreshes the state reference,
   * then launches reasoning for every queued report, FIFO. The launch happens
   * at a fixed point in the serial engine order, so prompt inputs are a pure
   * function of (tick, seed, recorded external inputs) — replayable.
   */
  pump( state: ReadonlySimulationState ): void {
    if( this._destroyed ) return
    this.setStateRef( state )

    if( this._pendingReports.length === 0 ) return
    const batch = this._pendingReports
    this._pendingReports = []

    for( const report of batch )
      this._launchReason( report )
  }

  subscribe( listener: FacetEventListener ): () => void {
    this._listeners.add( listener )
    return () => { this._listeners.delete( listener ) }
  }

  destroy(): void {
    if( this._destroyed ) return
    this._destroyed = true

    this._bus.unsubscribe(`executive-facet-${this.facetId}`)
    this._listeners.clear()

    logger.info(`[executive.facet] ${this.facetId} destroyed`)
  }

  // ── Master sync ────────────────────────────────────────────

  private _onMasterSync = ( event: any ): void => {
    if( this._destroyed ) return

    const payload = event.payload as {
      facetId?: string
      reasoning?: string
      confidence?: number
      actionTypes?: string[]
      coherenceVersion?: number
      tick?: number
    }

    // Master syncs to all facets or a specific one
    if( payload.facetId && payload.facetId !== this.facetId ) return

    logger.info(`[executive.facet] ${this.facetId} synced from master (tick=${payload.tick})`)

    // Store master's latest reasoning for context in next report()
    if( payload.reasoning )
      this._masterSyncHistory.push(`[Master sync — tick ${payload.tick}] ${payload.reasoning.slice( 0, 400 )}`)

    // Keep only last 5 sync entries
    if( this._masterSyncHistory.length > 5 )
      this._masterSyncHistory = this._masterSyncHistory.slice( -5 )
  }

  // ── Reasoning ──────────────────────────────────────────────

  private async _reason( report: FacetReport ): Promise<void> {
    // Ensure we have current state
    if( !this._currentStateRef )
      throw new Error(`[executive.facet] ${this.facetId} no state reference available`)

    if( !this._currentFocus )
      throw new Error(`[executive.facet] ${this.facetId} no focus set. Call setFocus() before report().`)

    const currentState = this._currentStateRef

    // Build fresh context from current state
    // A focus may supply a recall query (e.g. the live conversation message) to
    // drive the single "## Relevant Memories" section — one recall surface (§5).
    const execContext = await PromptFactory.buildFreshContext( this._contextDeps, currentState, this._currentFocus?.recallQuery )

    const qualityModulation = PromptFactory.computeQualityModulation( currentState )
    const epistemicUncertainty = PromptFactory.computeEpistemicUncertainty( execContext, currentState )

    // Build focus section — the creator is responsible for providing
    // the appropriate content via setFocus()
    const focus: FocusSection = this._masterSyncHistory.length > 0
            ? {
                ...this._currentFocus,
                content: `${this._currentFocus.content}\n\n## Master Consciousness Updates\n${this._masterSyncHistory.join('\n')}`
              }
            : this._currentFocus

    // Build system prompt using PromptFactory — same schema as master, [REPLY] gated out.
    const systemPrompt = PromptFactory.buildSystemPrompt( {
      context: execContext,
      focus,
      deps: this._promptDeps,
      mode: 'facet'
    } )

    // Build user message — same live-state baseline as master.
    // Creator-engine context is injected via reportContent (per-report payload)
    // and focus.instructions (per-focus recurring context).
    // outputFormat overrides the standard schema when the creating engine needs it.
    //
    // Facet reasoning continuity: prepend this facet's own prior reasoning so it
    // isn't cold on each cycle. Injected before the caller's instructions so the
    // caller content always comes last (highest recency bias from the LLM).
    const continuityBlock = this._facetReasoningHistory.length > 0
      ? `## My Prior Reasoning (this facet)\n${this._facetReasoningHistory.join('\n')}`
      : ''

    const reportContent = [
      continuityBlock,
      report.instructions ?? ''
    ].filter( Boolean ).join('\n\n') || undefined

    // Dual-process — a facet is "the master over its focus", so it deliberates the same
    // way. The a-priori effort gate (shared `selectProcess`) picks fast vs deliberate
    // using the SAME developable `deliberateThreshold` as master (engine-config-executive),
    // so the Will's deliberativeness is unified across master and every focus. On the
    // deliberate path a propose pass generates options FOR THIS FOCUS (e.g. a planning
    // facet's continue/revise/replan/abandon), injected into the decision call below.
    const deliberateThreshold = readEffectiveParams( currentState, 'engine-config-executive').deliberateThreshold ?? DELIBERATE_THRESHOLD
    const processSelection = selectProcess( {
      epistemicUncertainty,
      priorConfidence:   this._lastConfidence,
      novelty:           currentState.metrics.get('perception.novelty') ?? 0,
      stressLoad:        currentState.metrics.get('stress.load') ?? 0,
      // A facet's "stakes-bearing moment" is a live message awaiting reply (conversation
      // facets set focus.recallQuery to it); planning/other facets rely on uncertainty.
      hasPendingMessage: !!this._currentFocus?.recallQuery,
    }, deliberateThreshold )

    let ideationCandidates: IdeationCandidate[] | undefined
    if( processSelection.process === 'deliberate'){
      const proposeTemperature = ideationTemperature( execContext.identity.traits[ 'creativity' ] ?? 0.5 )
      const ideationUserMessage = PromptFactory.buildUserMessage( {
        context: execContext,
        state: currentState,
        qualityModulation,
        epistemicUncertainty,
        pendingMessages: [],
        focus,
        deps: this._promptDeps,
        recentActionTypes: [],
        mode: 'facet',
        reportContent,
        outputFormat: PromptFactory.buildIdeationFormatInstruction(),
      } )
      ideationCandidates = await proposeCandidates( {
        director: this._llmDirector,
        systemPrompt,
        ideationUserMessage,
        tick: currentState.tick,
        proposeTemperature,
        meta: { category: 'executive', attribute: 'facet', function: this._currentFocus?.function ?? 'ideation', scope: this.facetId, demand: processSelection.effortScore },
      } )
      logger.info(
        `[executive.facet] ${this.facetId} ◆ deliberate propose tick=${currentState.tick}  ` +
        `candidates=${ideationCandidates?.length ?? 0}  temp=${proposeTemperature.toFixed( 2 )}`
      )
    }

    const userMessage = PromptFactory.buildUserMessage( {
      context: execContext,
      state: currentState,
      qualityModulation,
      epistemicUncertainty,
      pendingMessages: [],
      focus,
      deps: this._promptDeps,
      recentActionTypes: [],
      mode: 'facet',
      reportContent,
      outputFormat: focus.outputFormat,
      ideationCandidates
    } )

    // Log the call
    this._sessionLogger?.write( {
      type: 'executive.facet.call',
      tick: currentState.tick,
      facetId: this.facetId,
      promptChars: systemPrompt.length + userMessage.length,
      promptTokensEst: Math.round( ( systemPrompt.length + userMessage.length ) / 4 ),
      systemChars: systemPrompt.length,
      userChars: userMessage.length
    } )

    let output: ExecutiveOutputFull
    const llmStart = wallClock()  // perf timing only — latency is telemetry, never replay state

    try {
      // Use streaming call when a per-facet chunk handler is registered —
      // this enables entity-scoped token delivery (e.g. AuditionEngine SSE).
      // Falls back to regular call when no handler is present.
      // MODEL_ROUTING W0 — same effort gate as master, so a facet's demand is
      // measured on the identical scale (a live message awaiting reply is this
      // focus's stakes-bearing moment, and already weighs into the score).
      const facetMeta: LLMCallMeta = {
        category:  'executive',
        attribute: 'facet',
        // A focus that declares no function is making its decision call, the
        // facet's analogue of master's 'decision'. This previously fell back to
        // 'facet' — an *attribute* value, which quietly created a bogus bucket
        // in the by-function cost breakdown. The typed axes caught it.
        function:  this._currentFocus?.function ?? 'decision',
        scope:     this.facetId,
        demand:    processSelection.effortScore,
      }
      const result = this._chunkHandler
        ? await this._llmDirector.callStream( systemPrompt, userMessage, currentState.tick, this._chunkHandler, undefined, facetMeta )
        : await this._llmDirector.call( systemPrompt, userMessage, currentState.tick, undefined, facetMeta )
      output = parseResponse( result.text, currentState, [] )

      // System 2 — retain the options this facet weighed for its focus decision.
      if( ideationCandidates && ideationCandidates.length > 0 )
        output.consideredAlternatives = ideationCandidates.map( c => c.approach || c.description )

      logger.info(
        `[executive.facet] ${this.facetId} ✓ tick=${currentState.tick}  ` +
        `in=${result.inputTok} tok  out=${result.outputTok} tok  ` +
        `cache=${result.cacheReadTok ?? 0}r/${result.cacheWriteTok ?? 0}w  ` +
        `latency=${wallClock() - llmStart}ms`
      )

      this._sessionLogger?.write( {
        type: 'executive.facet.response',
        tick: currentState.tick,
        facetId: this.facetId,
        latencyMs: wallClock() - llmStart,
        responseChars: result.text.length,
        promptTokens: result.inputTok,
        completionTokens: result.outputTok,
        cacheReadTokens:  result.cacheReadTok ?? 0,
        cacheWriteTokens: result.cacheWriteTok ?? 0,
        responseExcerpt: result.text.slice( 0, 600 )
      } )
    }
    catch( err ){
      const msg = err instanceof Error ? err.message : String( err )
      logger.error(`[executive.facet] ${this.facetId} LLM call failed: ${msg.slice( 0, 200 )}`)

      this._sessionLogger?.write( {
        type: 'executive.facet.response',
        tick: currentState.tick,
        facetId: this.facetId,
        latencyMs: wallClock() - llmStart,
        error: msg.slice( 0, 300 )
      } )

      output = buildFallbackOutput( currentState, [] )
    }

    // Log the parsed output
    this._sessionLogger?.write( {
      type: 'executive.facet.output',
      tick: currentState.tick,
      facetId: this.facetId,
      confidence: output.confidence,
      reasoning: output.reasoning.slice( 0, 500 ),
      actions: output.actions,
      newBeliefs: output.newBeliefs ?? [],
      plansCount: output.plans?.length ?? 0,
      goalsNew: output.newGoals ?? [],
      goalsAbandon: output.goalsToAbandon ?? [],
      hasIntrospection: !!output.introspection,
      hasNarrative: !!output.narrative
    } )

    // Track this decision's confidence — a dual-process gate signal for the next report.
    this._lastConfidence = output.confidence

    // Store reasoning for continuity
    this._facetReasoningHistory.push(`[Report: ${report.type}] ${output.reasoning.slice( 0, 400 )}`)
    if( this._facetReasoningHistory.length > 10 )
      this._facetReasoningHistory = this._facetReasoningHistory.slice( -10 )

    // Convert executive output to facet decision — the creator defines the decision shape
    // via the focus.outputFormat. The facet simply passes through the parsed output
    // as the decision payload.
    const decision: FacetDecision = {
      facetId: this.facetId,
      respondingToType: report.type,
      decision: this._extractDecisionPayload( output, focus ),
      reasoning: output.reasoning,
      confidence: output.confidence
    }

    // Promote subscriber-visible fields from the decision object to the event payload
    // top-level so that GoalManager and SemanticIntegrator can read them without
    // knowing or casting the opaque `decision` type.
    // PlanningEngine (and other creating engines) still receive the full `decision`.
    const dec = ( typeof decision.decision === 'object' && decision.decision !== null )
      ? decision.decision as Record<string, unknown>
      : {}

    this._bus.publish( {
      type: 'executive.facet.progress',
      version: 1,
      sourceEngine: `executive-facet-${this.facetId}`,
      salience: Math.max( 0.5, decision.confidence ),
      payload: {
        facetId:          this.facetId,
        respondingToType: report.type,
        decision:         decision.decision,
        // promoted for GoalManager
        goalId:           dec[ 'goalId' ]         as string | undefined,
        goalProgress:     dec[ 'goalProgress' ]   as number | undefined,
        newGoals:         dec[ 'newGoals' ],
        goalsToAbandon:   dec[ 'goalsToAbandon' ],
        // promoted for SemanticIntegrator
        newBeliefs:       dec[ 'newBeliefs' ],
        // promoted for SemanticIntegrator (learned facts about others → keid-tagged beliefs)
        knownEntityUpdates: dec[ 'knownEntityUpdates' ],
        contextId:        report.contextId,
        tick:             currentState.tick
      }
    } )

    // Conscious learning about others — route name/feeling to known.entity.tracker (the
    // dossier owner) the same way the master does, so routine (un-escalated) conversation
    // also records who/what it's dealing with. Facts ride the promoted field above.
    const keUpdates = dec[ 'knownEntityUpdates' ] as ExecutiveOutputFull['knownEntityUpdates'] | undefined
    if( keUpdates )
      for( const u of keUpdates )
        if( u.keid && u.keid !== 'agent-self' && ( u.name || u.feeling != null ) )
          this._bus.publish( {
            type: 'known.entity.learned', version: 1,
            sourceEngine: `executive-facet-${this.facetId}`,
            salience: 0.5, payload: { keid: u.keid, name: u.name, feeling: u.feeling }
          } )

    // Sync back to master
    this._bus.publish( {
      type: 'executive.facet.sync',
      version: 1,
      sourceEngine: `executive-facet-${this.facetId}`,
      salience: Math.max( 0.5, decision.confidence ),
      payload: {
        facetId: this.facetId,
        reasoning: output.reasoning,
        confidence: output.confidence,
        actionTypes: output.actions.map( a => a.type ),
        // WHO this facet is engaged with (FocusSection.subject*). The master keeps
        // the singular seat, so it needs the person, not just the facet number.
        ...( focus.subjectEntityId ? { subjectEntityId: focus.subjectEntityId } : {} ),
        ...( focus.subjectName     ? { subjectName:     focus.subjectName     } : {} ),
        tick: currentState.tick
      }
    } )

    // Notify all listeners (PlanningEngine, AuditionEngine, etc.).
    //
    // Through the CompletionInbox when attached: this runs at LLM-promise
    // resolution — an arbitrary wall-clock moment — and listeners mutate shared
    // state (plans, the outbox). Staging the notification quantizes the landing
    // to the next tick's Phase 2, alongside the bus events published above, so
    // the whole decision (events + listener effects) lands atomically at one
    // tick boundary. Without an inbox (bare facets in tests): direct, as before.
    const notify = (): void => {
      for( const listener of this._listeners )
        try { listener( decision ) }
        catch( err ){ logger.error(`[executive.facet] ${this.facetId} listener error:`, err ) }
    }

    if( this._inbox ) this._inbox.enqueue(`${this.facetId}:decision`, notify )
    else notify()
  }

  /**
   * Extract the decision payload from the executive output.
   *
   * If the creating engine supplied a `focus.extractDecision` callback, delegate
   * entirely to it — the engine knows what fields it needs and how to derive them
   * from the LLM output (e.g. reading action type as a directive, computing
   * goalProgress from plan state, etc.).
   *
   * If no callback is provided, fall back to a generic passthrough of the
   * LLM's raw actions and goal-mutation lists. This is safe for any facet that
   * doesn't need domain-specific decision routing.
   */
  private _extractDecisionPayload( output: ExecutiveOutputFull, focus: FocusSection ): unknown {
    if( focus.extractDecision ) return focus.extractDecision( output )

    // Generic fallback — no plan-specific assumptions
    return {
      actions:            output.actions,
      newGoals:           output.newGoals,
      goalsToAbandon:     output.goalsToAbandon,
      newBeliefs:         output.newBeliefs,
      knownEntityUpdates: output.knownEntityUpdates
    }
  }
}

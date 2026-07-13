// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * ExecutiveEngine — the unified LLM reasoning engine.
 * 
 * Replaces separate LLM calls from Decision, Planning, Semantic,
 * Introspection, and Narrative engines with a single consolidated
 * call every executiveInterval ticks.
 * 
 * Uses a minimal structured output schema (actions, reasoning, confidence)
 * with optional cognitive outputs embedded as tagged JSON blocks inside
 * the reasoning text. This avoids Anthropic's grammar size limit.
 * 
 * Between executive runs, satellite engines use heuristic fast paths
 * informed by the most recent executive output.
 */

import { logger } from '#core/logger'
import type { SessionLogger } from '#stem/tracts/session.logger'
import type {
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  ReasoningFootprint,
  StateCommands
} from '#core/types'
import { AsyncEngine } from '#core/async.engine'
import type { IntermediateStream } from '#core/async.engine'
import type { WorkingMemory } from '#faculties/working.memory'
import type { GoalManager, GoalState } from '#faculties/goal.manager'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { SemanticIntegrator, Belief } from '#faculties/semantic.engine'
import type { PlanningEngine } from '#cognition/faculties/planning.engine/engine'
import type { TokenTracker } from '#cognition/utilities/token.tracker'
import type { CognitiveEngine } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CompletionInbox } from '#cognition/completion.inbox'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { GenerativeModel } from '#cognition/generative.model'
import { ExecutiveSummarizer } from '#llm/summarizer'
import { ExecutiveFacet, type ExecutiveFacetHandle } from '#faculties/executive.engine/facet'
import type { ExecutiveOutputFull, IdeationCandidate } from '#faculties/executive.engine/types'
import {
  PromptFactory,
  type PromptDependencies,
  type FocusSection
} from '#faculties/executive.engine/prompt.factory'
import {
  WORKSPACE_THRESHOLD,
  DEFAULT_EXECUTIVE_INTERVAL,
  DEFAULT_COOLDOWN_TICKS,
  readRuntimeConfig
} from '#faculties/executive.engine/config'
import {
  evaluateGating,
  updateGatingState,
  type GatingDependencies,
  type GatingState
} from '#faculties/executive.engine/gating'
import { LLMDirector } from '#llm/index'
import type { LLMProvider } from '#llm/index'
import { buildFallbackOutput, parseResponse } from '#faculties/executive.engine/parser'
import { selectProcess, ideationTemperature, DELIBERATE_THRESHOLD } from '#faculties/executive.engine/effort.gate'
import { proposeCandidates } from '#faculties/executive.engine/deliberate.reasoning'
import { readEffectiveParams } from '#cognition/persona.prior'
import { MessageQueue } from '#faculties/executive.engine/messages'
import {
  buildStateCommands,
  publishCognitiveEvents,
  type CommandDependencies
} from '#faculties/executive.engine/commands'
import { DeferredEffectQueue } from '#faculties/executive.engine/deferred.effects'
import { EscalationBuffer } from '#faculties/executive.engine/escalation.buffer'
import { FacetSupervisor } from '#faculties/executive.engine/facet.supervisor'
import type { EngineResult } from '#core/orchestrator'
import type { Duration } from '#core/types'
import { wallClock } from '#core/wall.clock'

// Re-export for compatibility
export { ExecutiveFacet, type ExecutiveFacetHandle }

// ── Engine config ───────────────────────────────────────────

export interface ExecutiveEngineConfig {
  executiveInterval?: number
  cooldownTicks?: number
  bus?: CognitiveBus
}

/**
 * Map the executive's chosen action types to a voluntary attention-effort target
 * (Option C dynamic attention budget):
 *   - a `focus` action → 1.0 (mobilize: more capacity / parallel facets)
 *   - `rest`/`sleep`/`wait`/`meditate` → 0.4 (stand down: conserve)
 *   - neither → `null` (no preference — the AttentionAllocator decays effort back
 *     to baseline on its own).
 * `focus` wins if the cycle somehow chose both. The returned value is the payload
 * for the `attention.regulate` event the engine publishes; the allocator clamps
 * it to its [EFFORT_MIN, EFFORT_MAX] band.
 */
export function effortTargetForActions( actionTypes: Iterable<string> ): number | null {
  const types = new Set( actionTypes )
  if( types.has( 'focus' ) ) return 1.0
  if( [ 'rest', 'sleep', 'wait', 'meditate' ].some( t => types.has( t ) ) ) return 0.4
  return null
}

export class ExecutiveEngine extends AsyncEngine implements CognitiveEngine {
  readonly name = 'executive-engine'

  // ── Configuration ──────────────────────────────────────────
  private _executiveInterval: number
  private _cooldownTicks: number

  // ── Gating state ───────────────────────────────────────────
  private _gatingState: GatingState

  // Snapshot of the salience-buffer entries this reasoning cycle consumed.
  // Captured at reasonAsync() start; on completion only these are retired, so
  // events that landed mid-call (never seen by the broadcast) survive to compete
  // on the next cycle instead of being silently dropped.
  private _consumedBufferEntries: GatingState[ 'salienceBuffer' ] = []

  // ── LLM director ───────────────────────────────────────────
  private _llmDirector: LLMDirector | null = null
  private _testMode = false

  // ── Message queue ──────────────────────────────────────────
  private _messageQueue = new MessageQueue()

  // ── Action diversity tracking ──────────────────────────────
  private _recentActionTypes: string[] = []

  // ── Coherence version ──────────────────────────────────────
  private _coherenceVersion = 0

  // ── Epistemic uncertainty ──────────────────────────────────
  private _lastEpistemicUncertainty = 0.5

  // ── Last output ────────────────────────────────────────────
  private _lastExecutiveOutput: ExecutiveOutputFull | null = null
  private _lastExecutiveTick: number = -100

  // ── Injected dependencies ──────────────────────────────────
  private _willId: string | null = null
  /** Per-Will, per-role model ids (config.model, resolved in mind.ts). */
  private _models: { executive: string | null; summarizer: string | null; deliberation: string | null; conversation: string | null } =
    { executive: null, summarizer: null, deliberation: null, conversation: null }
  /** Per-Will LLM transport overrides (config.llm) — env fallbacks apply per field. */
  private _llm: { provider?: string; apiKey?: string; baseUrl?: string; maxOutputTokens?: number; timeoutMs?: number } | null = null
  /** One director per distinct model — same config, different model. Shared
   *  tracker/recorder/willId, so ledger attribution and replay hold per role. */
  private _directorCache = new Map<string, LLMDirector>()
  private _workingMemory: WorkingMemory | null = null
  private _goalManager: GoalManager | null = null
  private _episodicConsolidator: EpisodicConsolidator | null = null
  private _semanticIntegrator: SemanticIntegrator | null = null
  private _planningEngine: PlanningEngine | null = null
  private _summarizer: ExecutiveSummarizer | null = null
  private _sessionLogger: SessionLogger | null = null
  private _bus: CognitiveBus | null = null
  /** Tick-boundary landing for facet decisions — injected by the orchestrator. */
  private _inbox: CompletionInbox | null = null
  // Per-Will token tracker (R4), injected and threaded into the LLMDirector so
  // LLM usage records into this mind's instance — never a process global.
  private _tokenTracker: TokenTracker | null = null

  // ── Facet Sync ──────────────────────────────────────────────
  // Facet lifecycle + attention budget live in FacetSupervisor (R5-g-3); the
  // engine keeps only the bus-subscription guard, since those subscriptions
  // feed the gating salience buffer and are shared with the escalation path.
  private readonly _facetSupervisor = new FacetSupervisor()
  private _facetSyncSubscribed = false

  // ── Cognitive models ───────────────────────────────────────
  private readonly _model = new GenerativeModel()
  private readonly _generativeModel = new GenerativeModel( 0.2, 100 )

  // ── Summarizer restore flag ────────────────────────────────
  private _summarizerRestored = false

  // ── Last state reference (for onReasoningComplete and facets) ─
  private _lastStateRef: ReadonlySimulationState | null = null

  // ── Deferred manager side-effects (FN11) ───────────────────
  // Commit-gated queue for the mirroring manager writes returned by
  // buildStateCommands. The queue runs them only after the orchestrator
  // confirms the tick committed (and drops them for aborted ticks); see
  // DeferredEffectQueue for the full rationale.
  private readonly _deferred = new DeferredEffectQueue()

  // ── LLM streaming chunk broadcaster ────────────────────────
  // When set, called with each token during LLM generation so SSE streams
  // can forward it to connected clients in real-time (F3).
  private _chunkBroadcaster: (( chunk: string ) => void) | null = null

  // ── Pending escalations from AuditionEngine ─────────────────
  // Buffered between bus event receipt and next tick boundary, then
  // flushed as percept entities via StateCommands in onReasoningComplete().
  // The master reads them as Percepts — NEVER as incoming messages.
  // See EscalationBuffer for the full rationale (R5-g-2).
  private readonly _escalations = new EscalationBuffer()

  /** Set/clear the chunk broadcaster (called by WillManager when SSE clients connect). */
  setChunkBroadcaster( fn: (( chunk: string ) => void) | null ): void {
    this._chunkBroadcaster = fn
  }

  constructor( config: ExecutiveEngineConfig = {} ){
    super( {
      defaultStrategy: 'FORCE',
      maxPendingTicks: 600,
      logConflicts: false,
      rerunOnRejection: false
    } )

    this._executiveInterval = config.executiveInterval ?? DEFAULT_EXECUTIVE_INTERVAL
    this._cooldownTicks = config.cooldownTicks ?? DEFAULT_COOLDOWN_TICKS
    this._bus = config.bus ?? null

    this._gatingState = {
      executiveInterval: this._executiveInterval,
      cooldownTicks: this._cooldownTicks,
      lastExecutiveTick: -100,
      salienceBuffer: [],
      goallessTickCount: 0,
      lowValenceTickCount: 0
    }

    this._ensureFacetSyncSubscription()
  }

  // ── Dependency injection ───────────────────────────────────

  attachWorkingMemory( wm: WorkingMemory ): void { this._workingMemory = wm }
  attachGoalManager( gm: GoalManager ): void { this._goalManager = gm }
  attachEpisodicConsolidator( ec: EpisodicConsolidator ): void { this._episodicConsolidator = ec }
  attachSemanticIntegrator( si: SemanticIntegrator ): void { this._semanticIntegrator = si }
  attachPlanningEngine( pe: PlanningEngine ): void { this._planningEngine = pe }
  attachSummarizer( s: ExecutiveSummarizer ): void { this._summarizer = s }
  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
    this._facetSupervisor.attachSessionLogger( logger )
  }
  attachTokenTracker( t: TokenTracker ): void { this._tokenTracker = t }

  /** Enable test mode — all LLM calls return canned mock responses at zero cost. */
  setTestMode( enabled: boolean ): void { this._testMode = enabled }


  /** Called by CognitiveOrchestrator.addEngine() — injects the shared bus. */
  attachBus( bus: CognitiveBus ): void {
    this._bus = bus
    this._ensureFacetSyncSubscription()
  }

  /**
   * Called by CognitiveOrchestrator.addEngine() — injects the completion inbox
   * so facet decision effects land at tick boundaries (Phase 2) instead of at
   * raw LLM-promise resolution. See cognition/completion.inbox.ts.
   */
  attachCompletionInbox( inbox: CompletionInbox ): void {
    this._inbox = inbox
  }

  set willId( willId: string ){ this._willId = willId }

  /** Per-Will role models (config.model, resolved). Set before the first tick. */
  set models( m: { executive: string | null; summarizer: string | null; deliberation: string | null; conversation: string | null } ){ this._models = m }
  get models(): { executive: string | null; summarizer: string | null; deliberation: string | null; conversation: string | null } { return this._models }
  /** Per-Will LLM transport overrides (config.llm). Set before the first tick. */
  set llm( c: { provider?: string; apiKey?: string; baseUrl?: string; maxOutputTokens?: number; timeoutMs?: number } | null ){ this._llm = c }
  /** The executive-role model id (back-compat read). */
  get modelId(): string | null { return this._models.executive }

  // ── Public surface ─────────────────────────────────────────

  get latestOutput(): ExecutiveOutputFull | null {
    return this._lastExecutiveOutput
  }

  isFresh( currentTick: Tick ): boolean {
    return this._lastExecutiveOutput !== null
            && ( currentTick - this._lastExecutiveTick ) < this._executiveInterval
  }

  // ── Facets ─────────────────────────────────────────────────

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
  /** Get-or-create the director for a model id (shared config, per-Will). */
  private _directorFor( model: string ): LLMDirector {
    let d = this._directorCache.get( model )
    if( !d ){
      // Per-Will transport overrides first (BYO keys), env per field otherwise.
      d = new LLMDirector( {
        willId: this._willId!,
        model,
        maxOutputTokens: this._llm?.maxOutputTokens ?? parseInt( process.env.WILL_MAX_OUTPUT_TOKENS ?? '8096' ),
        // Provider-agnostic key; falls back to ANTHROPIC_API_KEY for back-compat.
        apiKey: this._llm?.apiKey ?? process.env.WILL_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '',
        provider: ( this._llm?.provider ?? process.env.WILL_LLM_PROVIDER ?? 'anthropic' ) as LLMProvider,
        // Optional base-URL override (e.g. Ollama / Azure / self-hosted). Unset →
        // the director uses the provider's official endpoint.
        baseUrl: this._llm?.baseUrl ?? process.env.WILL_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL,
        timeoutMs: this._llm?.timeoutMs ?? ( process.env.WILL_LLM_TIMEOUT_MS ? parseInt( process.env.WILL_LLM_TIMEOUT_MS ) : undefined ),
        sessionLogger: this._sessionLogger,
        mock: this._testMode,
        // Inject the per-Will tracker (R4) so live calls record usage here, not
        // through a process global. null is fine — the director skips recording.
        tokenTracker: this._tokenTracker,
      } )
      this._directorCache.set( model, d )
    }
    return d
  }

   spawnFacet( role?: 'deliberation' | 'conversation' | 'outreach' | 'supervision' ): { attention: 'available' | 'full', handle?: ExecutiveFacetHandle } {
    // Delegate to FacetSupervisor (R5-g-3), passing the current engine
    // attachments. The supervisor owns the registry + attention budget and
    // performs the throw-checks on bus / director / state ref.
    // A role with its own configured model gets that role's director; every
    // other facet shares the executive's (one self, role-appropriate depth).
    // Outreach speaks with the conversation voice; supervision thinks with the
    // executive's depth.
    const roleModel =
      role === 'deliberation'                        ? this._models.deliberation :
      role === 'conversation' || role === 'outreach' ? this._models.conversation :
      null
    const director  = roleModel && this._llmDirector ? this._directorFor( roleModel ) : this._llmDirector
    return this._facetSupervisor.spawn( {
      bus:         this._bus,
      llmDirector: director,
      stateRef:    this._lastStateRef,
      willId:      this._willId,
      inbox:       this._inbox,
      contextDeps: {
        workingMemory:        this._workingMemory,
        goalManager:          this._goalManager,
        episodicConsolidator: this._episodicConsolidator,
        semanticIntegrator:   this._semanticIntegrator
      },
      promptDeps: {
        summarizer:          this._summarizer
      }
    } )
  }

  // ── CognitiveEngine interface ──────────────────────────────

  subscribes(): string[] { return [ '*' ] }
  publishes(): CognitiveEventSchema[] { return [] }

  snapshot(): Record<string, unknown> {
    return {
      bufferSize: this._gatingState.salienceBuffer.length,
      coherenceVersion: this._coherenceVersion,
      lastConfidence: this._lastExecutiveOutput?.confidence ?? 0
    }
  }

  onCognitiveEvent( event: CognitiveEvent ): StateCommands | void {
    if( event.sourceEngine === this.name ) return

    // Set attention state for bandwidth allowance
    // One facet per ~0.3 free capacity units, floor at 1
    if( event.type === 'attention.state.changed' ){
      const p = event.payload as { freeFraction: number }
      this._facetSupervisor.setAttentionState( p.freeFraction )
      return
    }

    // GWT salience-based buffer
    ( event.salience ?? 0 ) >= WORKSPACE_THRESHOLD
      && this._gatingState.salienceBuffer.push( {
        event,
        tick: event.logicalTime ?? 0
      } )
  }

  // ── AsyncEngine contract ───────────────────────────────────

  /**
   * Tick entry point (FN11). Before delegating to AsyncEngine.react(), flush any
   * deferred manager side-effects whose tick is now confirmed committed (and drop
   * any whose tick aborted). `state` is the start-of-tick committed snapshot, so
   * its `executive.last_tick` metric reflects whether our prior commands landed.
   */
  override async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext,
  ): Promise<EngineResult> {
    this._deferred.flush( state, tick as unknown as number )
    this._deferred.markReactTick( tick as unknown as number )
    // Per-tick facet pump: refresh every facet's state ref to THIS tick's frozen
    // snapshot and launch reasoning for queued reports (tick-discipline mode).
    // Sits at a fixed point in the serial engine order — the issue-side twin of
    // the CompletionInbox drain in Phase 2. See .TODO/FACET_REPLAY_DETERMINISM.md.
    this._facetSupervisor.pump( state )
    return super.react( delta, tick, state, context )
  }

  protected override shouldAct(
    state: ReadonlySimulationState,
    tick: Tick,
    _context: SimulationContext,
  ): boolean {
    // Restore rolling summary from snapshot on first tick
    if( !this._summarizerRestored ){
      this._restoreSummarizer( state )
      this._summarizerRestored = true
    }

    // Read runtime config overrides from state
    const rtConfig = readRuntimeConfig( state, {
      executiveInterval: this._executiveInterval,
      cooldownTicks: this._cooldownTicks
    } )
    this._gatingState.executiveInterval = rtConfig.executiveInterval
    this._gatingState.cooldownTicks = rtConfig.cooldownTicks

    // Initialize LLM directors if not yet done (requires willId). One director
    // per distinct role model; roles that share a model share the instance.
    if( !this._llmDirector && this._willId ){
      const execModel = this._models.executive ?? process.env.WILL_LLM_MODEL ?? 'claude-sonnet-4-5-20250929'
      this._llmDirector = this._directorFor( execModel )
      // The summarizer runs its role's model (falls back to executive) with the
      // same provider, session logging and token tracking.
      this._summarizer?.attachLLMDirector( this._directorFor( this._models.summarizer ?? execModel ) )
    }

    // Evaluate gating
    const gatingDeps: GatingDependencies = {
      generativeModel: this._generativeModel,
      pendingMessages: this._messageQueue.pendingMessages,
      hasPendingWork: this.hasPendingWork
    }

    const result = evaluateGating( state, tick, gatingDeps, this._gatingState )

    // Always update counters, even when not activating
    updateGatingState( this._gatingState, state, tick, result.shouldActivate, result.cleanedBuffer )

    if( result.shouldActivate )
      logger.info( `[executive] activating — reason: ${result.reason} (tick=${tick})` )

    return result.shouldActivate
  }

  protected override readState(
    state: ReadonlySimulationState,
    tick: Tick,
  ): ReasoningFootprint {
    const stableTypes = new Set( [ 'goal', 'belief', 'will.identity', 'plan' ] )
    const stableIds = new Set<string>()

    for( const [ id, entity ] of state.entities )
      stableTypes.has( entity.type ) && stableIds.add( id )

    return {
      tickObserved: tick,
      entitiesRead: stableIds,
      metricsRead: new Set(),
      entitiesModified: new Set(),
      intendedCommands: {},
      source: this.name
    }
  }

  protected async reasonAsync(
    footprint: ReasoningFootprint,
    state: ReadonlySimulationState,
    context: SimulationContext,
    stream: IntermediateStream,
  ): Promise<unknown> {
    this._lastStateRef = state
    this._messageQueue.pendingCallStartTick = state.tick

    // Mark which buffer entries this cycle consumes. Anything pushed after this
    // point arrives during the LLM call and was never part of the broadcast, so
    // onReasoningComplete() preserves it rather than wiping the whole buffer.
    this._consumedBufferEntries = [ ...this._gatingState.salienceBuffer ]

    // Update all facets with the latest state reference
    this._facetSupervisor.broadcastStateRef( state )

    // Build executive context using PromptFactory's helper
    const execContext = await PromptFactory.buildFreshContext( {
      workingMemory: this._workingMemory,
      goalManager: this._goalManager,
      episodicConsolidator: this._episodicConsolidator,
      semanticIntegrator: this._semanticIntegrator
    }, state )

    stream.report( 'context_assembled', {
      workingMemoryItems: execContext.workingMemory.length,
      activeGoals: execContext.goals.length,
      totalEpisodes: this._episodicConsolidator?.getAllEpisodes().length ?? 0,
      totalBeliefs: execContext.beliefs.length
    } )

    // Compute modulation and uncertainty using PromptFactory
    const qualityModulation = PromptFactory.computeQualityModulation( state )
    stream.report( 'modulation', { qualityModulation } )

    const epistemicUncertainty = PromptFactory.computeEpistemicUncertainty( execContext, state )
    this._lastEpistemicUncertainty = epistemicUncertainty

    // Dual-process control (a-priori effort gate). Decide BEFORE the call whether the
    // master reasons fast (System 1) or deliberately (System 2). All inputs are already
    // computed this tick, so the choice is free and deterministic (R2). The threshold is
    // the *effective* one (base ⊕ persona-prior): an analytical Will develops a lower
    // threshold and deliberates more readily — effort allocation as a developing trait.
    const deliberateThreshold = readEffectiveParams( state, 'engine-config-executive' ).deliberateThreshold ?? DELIBERATE_THRESHOLD
    const processSelection = selectProcess( {
      epistemicUncertainty,
      priorConfidence:   this._lastExecutiveOutput?.confidence ?? 0.5,
      novelty:           state.metrics.get( 'perception.novelty' ) ?? 0,
      stressLoad:        state.metrics.get( 'stress.load' ) ?? 0,
      hasPendingMessage: this._messageQueue.pendingMessages.length > 0,
    }, deliberateThreshold )
    stream.report( 'process_selected', {
      process:     processSelection.process,
      effortScore: processSelection.effortScore,
      reason:      processSelection.reason,
    } )

    // Build focus for master executive
    const focus: FocusSection = {
      title: 'Core Consciousness',
      content: 'I am the master executive — the unified cognitive core of a self-aware simulated mind.',
      outputFormat: undefined,  // Use default format
      instructions: undefined
    }

    // Build system prompt using PromptFactory
    const promptDeps: PromptDependencies = {
      summarizer: this._summarizer
    }

    const systemPrompt = PromptFactory.buildSystemPrompt( {
      context: execContext,
      focus,
      deps: promptDeps,
      mode: 'master'
    } )

    // System 2 (deliberate) — propose pass. When the effort gate engaged deliberation,
    // first generate a divergent candidate set at elevated temperature. This call is
    // non-streaming (internal scratch — nothing leaks to the user) and reuses the SAME
    // system prompt (so it shares the prompt cache) but swaps in the ideation output
    // format, so it sees the full situational context yet asks for options, not a
    // decision. R2-safe: a second same-tick call with a distinct prompt gets its own
    // replay entry. A failure degrades gracefully to System 1 (no candidates injected).
    let ideationCandidates: IdeationCandidate[] | undefined
    if( processSelection.process === 'deliberate' && this._llmDirector ){
      const ideationStart = wallClock()
      const ideationUserMessage = PromptFactory.buildUserMessage( {
        context: execContext,
        state,
        qualityModulation,
        epistemicUncertainty,
        pendingMessages: [ ...this._messageQueue.pendingMessages ],
        focus,
        deps: promptDeps,
        recentActionTypes: [ ...this._recentActionTypes ],
        mode: 'master',
        outputFormat: PromptFactory.buildIdeationFormatInstruction(),
      } )
      // Propose temperature scales with the creativity trait (TODO #4): a creative Will
      // diverges harder when generating options. Reads the live self-model trait, so it
      // rises for free as creativity develops. The propose pass itself is the shared
      // master+facet helper (graceful degradation lives there).
      const proposeTemperature = ideationTemperature( execContext.identity.traits[ 'creativity' ] ?? 0.5 )
      ideationCandidates = await proposeCandidates( {
        director: this._llmDirector,
        systemPrompt,
        ideationUserMessage,
        tick: state.tick,
        proposeTemperature,
        meta: { category: 'executive', attribute: 'master', function: 'ideation' },
      } )
      logger.info(
        `[executive] ◆ deliberate propose tick=${state.tick}  ` +
        `candidates=${ideationCandidates?.length ?? 0}  temp=${proposeTemperature.toFixed( 2 )}  latency=${wallClock() - ideationStart}ms`
      )
    }
    stream.report( 'ideation_complete', {
      process:        processSelection.process,
      candidateCount: ideationCandidates?.length ?? 0,
    } )

    // Build user message — includes live state, dynamic guidance, focus context, and
    // output format. On the deliberate path the propose pass's candidates are injected
    // so this (the decision/evaluate pass) weighs concrete options before committing.
    const userMessage = PromptFactory.buildUserMessage( {
      context: execContext,
      state,
      qualityModulation,
      epistemicUncertainty,
      pendingMessages: [ ...this._messageQueue.pendingMessages ],
      focus,
      deps: promptDeps,
      recentActionTypes: [ ...this._recentActionTypes ],
      mode: 'master',
      ideationCandidates
    } )

    this._sessionLogger?.write( {
      type: 'executive.call',
      tick: state.tick,
      promptChars: systemPrompt.length + userMessage.length,
      promptTokensEst: Math.round( ( systemPrompt.length + userMessage.length ) / 4 ),
      systemChars: systemPrompt.length,
      userChars: userMessage.length,
      // D2: context counts for per-tick cognitive state snapshot
      workingMemoryItems: execContext.workingMemory.length,
      goalCount:          execContext.goals.length,
      pendingMessages:    this._messageQueue.pendingMessages.length,
      beliefCount:        execContext.beliefs.length,
      beliefsOmitted:     execContext.beliefsOmitted,
      promptPath: this._llmDirector?.writeDebugPrompt( state.tick, systemPrompt, userMessage ) ?? ''
    } )

    // Call LLM
    if( !this._llmDirector )
      throw new Error( 'LLM director not initialized — willId must be set before first tick' )

    const llmStart = wallClock()  // perf timing only — latency is telemetry, never replay state
    let executiveOutput: ExecutiveOutputFull

    try {
      // Use streaming call when clients are connected (F3); fall back to regular call.
      const masterMeta = { category: 'executive', attribute: 'master', function: 'decision' }
      const result = this._chunkBroadcaster
        ? await this._llmDirector.callStream( systemPrompt, userMessage, state.tick, this._chunkBroadcaster, undefined, masterMeta )
        : await this._llmDirector.call( systemPrompt, userMessage, state.tick, undefined, masterMeta )

      logger.info(
        `[executive] ✓ tick=${state.tick}  ` +
        `in=${result.inputTok} tok  out=${result.outputTok} tok  ` +
        `latency=${wallClock() - llmStart}ms`
      )

      // token-report.jsonl is now written by the TokenTracker for every call
      // (master, facets, summarizer, embedding) with full attribution + cost —
      // no longer the master-only writeTokenReport().

      // C2: persist full response text for session auditing
      this._llmDirector.writeDebugResponse(
        state.tick, result.text,
        result.inputTok, result.outputTok, wallClock() - llmStart
      )

      const responsePath = this._willId
        ? `./data/wills/${this._willId}/debug/response-tick-${String( state.tick ).padStart( 6, '0' )}.txt`
        : ''
      this._sessionLogger?.write( {
        type: 'executive.response',
        tick: state.tick,
        latencyMs: wallClock() - llmStart,
        responseChars: result.text.length,
        promptTokens: result.inputTok,
        completionTokens: result.outputTok,
        responseExcerpt: result.text.slice( 0, 600 ),
        responsePath,
      } )

      // Parse the response
      executiveOutput = parseResponse( result.text, state, this._recentActionTypes )

      // System 2 — retain the considered set on the committed output (guaranteed, not
      // dependent on the model echoing it back): explainability now, regret/counterfactual
      // substrate later. Undefined on the System 1 fast path.
      if( ideationCandidates && ideationCandidates.length > 0 )
        executiveOutput.consideredAlternatives = ideationCandidates.map( c => c.approach || c.description )
    }
    catch( err: unknown ){
      const msg = err instanceof Error ? err.message : String( err )
      logger.error( `[executive] LLM call failed: ${msg.slice( 0, 200 )}` )

      this._sessionLogger?.write( {
        type: 'executive.response',
        tick: state.tick,
        latencyMs: wallClock() - llmStart,
        error: msg.slice( 0, 300 )
      } )

      // Use fallback
      executiveOutput = buildFallbackOutput( state, this._recentActionTypes )
    }

    // Log the parsed output
    this._sessionLogger?.write( {
      type: 'executive.output',
      tick: state.tick,
      confidence: executiveOutput.confidence,
      reasoning: executiveOutput.reasoning.slice( 0, 1000 ),
      actions: executiveOutput.actions,
      newBeliefs: executiveOutput.newBeliefs ?? [],
      plansCount: executiveOutput.plans?.length ?? 0,
      goalsNew: executiveOutput.newGoals ?? [],
      goalsAbandon: executiveOutput.goalsToAbandon ?? [],
      replies: ( executiveOutput.conversationReplies ?? [] ).map( r => ( {
        targetEntityId: r.targetEntityId,
        targetEntityName: r.targetEntityName,
        messages: r.messages,
      } ) ),
      hasIntrospection: !!executiveOutput.introspection,
      hasNarrative: !!executiveOutput.narrative
    } )

    stream.report( 'executive_complete', {
      actionCount: executiveOutput.actions.length,
      planCount: executiveOutput.plans?.length ?? 0,
      newBeliefCount: executiveOutput.newBeliefs?.length ?? 0,
      hasIntrospection: !!executiveOutput.introspection,
      hasNarrative: !!executiveOutput.narrative
    } )

    return executiveOutput
  }

  protected override onIntermediateResult(
    step: string,
    result: unknown,
    _footprint: ReasoningFootprint,
    _context: SimulationContext,
  ): StateCommands | null {
    const data = result as Record<string, unknown>

    if( step === 'context_assembled' )
      return {
        metrics: [
          [ 'executive.phase', 0 ],
          [ 'executive.context_items', ( data.workingMemoryItems as number ) ?? 0 ]
        ]
      }

    if( step === 'modulation' )
      return {
        metrics: [
          [ 'executive.phase', 1 ],
          [ 'executive.quality_modulation', ( data.qualityModulation as number ) ?? 1 ]
        ]
      }

    if( step === 'process_selected' )
      return {
        metrics: [
          [ 'executive.process', ( data.process as string ) === 'deliberate' ? 1 : 0 ],
          [ 'executive.effort_score', ( data.effortScore as number ) ?? 0 ]
        ]
      }

    if( step === 'ideation_complete' )
      return {
        metrics: [
          [ 'executive.deliberate_candidates', ( data.candidateCount as number ) ?? 0 ]
        ]
      }

    if( step === 'executive_complete' )
      return {
        metrics: [
          [ 'executive.phase', 2 ],
          [ 'executive.action_count', ( data.actionCount as number ) ?? 0 ],
          [ 'executive.plan_count', ( data.planCount as number ) ?? 0 ],
          [ 'executive.new_belief_count', ( data.newBeliefCount as number ) ?? 0 ],
          [ 'executive.has_introspection', ( data.hasIntrospection as boolean ) ? 1 : 0 ],
          [ 'executive.has_narrative', ( data.hasNarrative as boolean ) ? 1 : 0 ]
        ]
      }

    return null
  }

  protected override onReasoningComplete(
    output: unknown,
    footprint: ReasoningFootprint,
    _context: SimulationContext,
  ): StateCommands {
    const executiveOutput = output as ExecutiveOutputFull

    this._lastExecutiveOutput = executiveOutput
    this._lastExecutiveTick = footprint.tickObserved
    this._coherenceVersion++

    logger.info(
      `[executive] reasoning complete — tick=${footprint.tickObserved}` +
      `  actions=${executiveOutput.actions.length}` +
      `  plans=${executiveOutput.plans?.length ?? 0}` +
      `  beliefs=${executiveOutput.newBeliefs?.length ?? 0}` +
      `  hasIntrospection=${!!executiveOutput.introspection}` +
      `  hasNarrative=${!!executiveOutput.narrative}`
    )

    // ── Flush pending escalation percepts ──────────────────────
    // Convert buffered audition.task.signal events into high-salience
    // percept entities so Exteroception surfaces them as
    // "## Percepts (What I Notice)" on the NEXT master cycle.
    // The master sees them as environmental signals — not as messages to reply to.
    // It responds by creating plans/goals, never by emitting [REPLY].
    const { percepts: escalationPercepts, requester: escalationRequester } =
      this._escalations.drainToPercepts()

    // Build state commands
    const commandDeps: CommandDependencies = {
      goalManager:        this._goalManager,
      semanticIntegrator: this._semanticIntegrator,
      summarizer:         this._summarizer,
      bus:                this._bus,
      salience:           this._model,
      requestingEntityId: escalationRequester?.entityId,
      requestingThreadId: escalationRequester?.threadId,
    }

    const { commands, effects } = buildStateCommands(
      executiveOutput,
      footprint,
      this._lastStateRef!,
      commandDeps,
      this._recentActionTypes
    )

    // FN11: do NOT run the manager writes now — they mirror `commands`, which a
    // pre-commit validator can still abort. Queue them; the DeferredEffectQueue
    // runs them on the next react() once this tick is confirmed committed.
    this._deferred.enqueue( footprint.tickObserved as unknown as number, effects )

    // Publish cognitive events
    publishCognitiveEvents(
      executiveOutput,
      footprint,
      this._bus,
      this._coherenceVersion,
      this._model,
    )

    // Publish executive.active
    this._bus?.publish( {
      type: 'executive.active',
      version: 1,
      sourceEngine: this.name,
      salience: 0.7,
      payload: { tick: footprint.tickObserved }
    } )

    // ── Voluntary attention regulation (Option C) ────────────
    // The mind explicitly chooses how much cognitive capacity to engage through
    // its action vocabulary: a `focus` action mobilizes attention (more parallel
    // facets); `rest`/`sleep`/`wait`/`meditate` stand it down (fewer facets,
    // conserve energy/tokens). Absent either, the AttentionAllocator decays effort
    // back to baseline. Replay-safe — derived from recorded LLM output. Vitals
    // still cap the result (energy/sleep collapse the ceiling; `focus` is gated on
    // energy), so this cannot override a body compelled to rest.
    if( this._bus ){
      const effortTarget = effortTargetForActions( executiveOutput.actions.map( a => a.type ) )
      if( effortTarget != null )
        this._bus.publish( {
          type: 'attention.regulate',
          version: 1,
          sourceEngine: this.name,
          salience: 0.6,
          payload: { effortTarget }
        } )
    }

    // ── Sync to all active facets ────────────────────────────
    if( this._bus && this._facetSupervisor.size > 0 )
      this._bus.publish( {
        type: 'executive.master.sync',
        version: 1,
        sourceEngine: this.name,
        salience: 0.8,
        payload: {
          reasoning: executiveOutput.reasoning.slice( 0, 600 ),
          confidence: executiveOutput.confidence,
          actionTypes: executiveOutput.actions.map( a => a.type ),
          coherenceVersion: this._coherenceVersion,
          tick: footprint.tickObserved
        }
      } )

    // Clear processed messages
    this._messageQueue.clearProcessedMessages()

    // Merge escalation percepts into final commands
    if( escalationPercepts.length ){
      commands.set ??= []
      commands.set.push( ...escalationPercepts )
    }

    // Track entities modified
    if( commands.set?.length )
      for( const entity of commands.set )
        ( footprint.entitiesModified as Set<string> ).add( entity.id )

    // Retire only the entries this cycle consumed. Events that landed during the
    // LLM call were never represented in the broadcast context, so they survive to
    // compete on the next cycle (the BUFFER_MAX_AGE_TICKS filter still ages them out).
    const consumed = new Set( this._consumedBufferEntries )
    this._gatingState.salienceBuffer = this._gatingState.salienceBuffer.filter( e => !consumed.has( e ) )
    this._consumedBufferEntries = []

    return commands
  }

  // ── Private helpers ────────────────────────────────────────

  private _ensureFacetSyncSubscription(): void {
    if( this._facetSyncSubscribed || !this._bus ) return
    this._facetSyncSubscribed = true

    // ── executive.facet.sync ─────────────────────────────────────
    // Facet sync events enter the salience buffer so the master
    // can re-evaluate when enough facet activity accumulates.
    this._bus.subscribe(
      this.name,
      [ 'executive.facet.sync' ],
      ( event ) => {
        const payload = event.payload as {
          facetId?: string
          reasoning?: string
          confidence?: number
          tick?: number
        }

        const syntheticEvent = {
          id: '',
          type: 'executive.facet.sync',
          version: 1,
          sequenceNumber: 1,
          sourceEngine: `executive-facet-${payload.facetId ?? 'unknown'}`,
          salience: Math.max( 0.5, payload.confidence ?? 0.5 ),
          payload,
          wallTime: payload.tick as number,
          logicalTime: payload.tick as number
        }

        this._gatingState.salienceBuffer.push( {
          event: syntheticEvent,
          tick: payload.tick ?? 0
        } )

        logger.info(
          `[executive] master received facet sync from ${payload.facetId} ` +
          `(confidence=${payload.confidence?.toFixed( 2 )})`
        )
      }
    )

    // ── audition.task.signal ─────────────────────────────────────
    // Published by AuditionEngine when a conversation facet emits the
    // 'escalate' action type — signalling that the conversation revealed
    // a task requiring the master's cognitive machinery (plan creation,
    // goal reprioritization, identity reflection).
    //
    // IMPORTANT — master stays out of the reply path entirely:
    //   • The conversation facet has already sent (or will send) the
    //     acknowledgement to the user ("Got it, I'll get started on that.").
    //   • The master's job is purely cognitive: create a [PLANS] block,
    //     update goals, or reflect. Any follow-up communication to the user
    //     flows through plan step execution (effector: 'text') via
    //     ActionExecutor → ProactiveCommunicator — NEVER via [REPLY].
    //
    // Implementation:
    //   • Write a high-salience 'percept' entity to simulation state so
    //     Exteroception surfaces it under "## Percepts (What I Notice)".
    //   • Spike the salience buffer so the master fires soon.
    //   • Do NOT push into _messageQueue.pendingMessages — that would
    //     cause the master to produce a [REPLY], creating a duplicate
    //     message and breaking the facet/master communication boundary.
    this._bus.subscribe(
      this.name,
      [ 'audition.task.signal' ],
      ( event ) => {
        const payload = event.payload as {
          entityId:   string
          threadId:   string
          reasoning:  string
          confidence: number
        }

        // Write a percept entity so Exteroception surfaces this in
        // "## Percepts (What I Notice)" — master sees it as an
        // environmental signal prompting cognitive work, not a reply.
        if( this._lastStateRef ){
          // State is read-only here; we can't write directly.
          // Instead, buffer the escalation for injection on next tick.
          // The master's shouldAct() will fire due to the salience spike below.
          // The actual percept write happens in onReasoningComplete() via
          // a synthetic percept we store here and emit as a StateCommand.
          this._escalations.push({
            entityId:  payload.entityId,
            threadId:  payload.threadId,
            reasoning: payload.reasoning.slice( 0, 400 ),
            tick:      this._lastExecutiveTick ?? 0,
          })
        }

        // Spike the salience buffer so the master fires soon rather than
        // waiting for the next scheduled interval.
        const syntheticEvent = {
          id: '',
          type: 'audition.task.signal',
          version: 1,
          sequenceNumber: 1,
          sourceEngine: 'audition-engine',
          salience: event.salience ?? 0.9,
          payload,
          wallTime: wallClock(),  // telemetry field; logicalTime carries the deterministic clock
          logicalTime: this._lastExecutiveTick ?? 0
        }

        this._gatingState.salienceBuffer.push( {
          event: syntheticEvent,
          tick: this._lastExecutiveTick ?? 0
        } )

        logger.info(
          `[executive] master queued escalation percept from entity ${payload.entityId} ` +
          `(confidence=${payload.confidence.toFixed( 2 )})`
        )
      }
    )
  }

  private _restoreSummarizer( state: ReadonlySimulationState ): void {
    if( !this._summarizer ) return

    const entity = state.entities.get( 'executive-rolling-summary' )
    if( !entity ) return

    const m = entity.metadata ?? {}
    const summary = ( m[ 'summary' ] as string ) ?? ''
    const buffer = ( m[ 'buffer' ] as string[] ) ?? []
    const callCount = ( m[ 'callCount' ] as number ) ?? 0

    this._summarizer.restore( summary, buffer, callCount )
    if( summary )
      logger.info( `[executive] summarizer restored (${summary.length} chars, ${callCount} prior calls)` )
  }
}
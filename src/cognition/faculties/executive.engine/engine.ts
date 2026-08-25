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
  StateCommands,
  EntityInput
} from '#core/types'
import { AsyncEngine } from '#core/async.engine'
import {
  actionRecordEntity, staleActionRecordIds, type ActionStatus,
} from '#faculties/executive.engine/action.record'
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
import { DeliberationCache } from '#cognition/cache/deliberation.cache'
import { extractFingerprint } from '#cognition/cache/fingerprint'
import type { DeliberationCacheConfig, DeliberationCacheSnapshot } from '#cognition/cache/types'
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
import { MOCK_PROVIDER, MOCK_MODEL } from '#llm/index'
import { getCompletionSource } from '#core/completion.recorder'
import { providerKeyFromEnv, type LLMProvider, type LLMCallMeta, type ProviderCredential, type LLMWire } from '#llm/index'
import type { ModelRouter } from '#llm/routing'
import { buildFallbackOutput, parseResponse } from '#faculties/executive.engine/parser'
import { selectProcess, ideationTemperature, DELIBERATE_THRESHOLD } from '#faculties/executive.engine/effort.gate'
import { proposeCandidates } from '#faculties/executive.engine/deliberate.reasoning'
import { readEffectiveParams } from '#cognition/persona.prior'
import {
  buildStateCommands,
  publishCognitiveEvents,
  type CommandDependencies
} from '#faculties/executive.engine/commands'
import { DeferredEffectQueue } from '#faculties/executive.engine/deferred.effects'
import { EscalationBuffer, type HandoffBody } from '#faculties/executive.engine/escalation.buffer'
import { FacetSupervisor } from '#faculties/executive.engine/facet.supervisor'
import type { EngineResult } from '#core/orchestrator'
import type { Duration } from '#core/types'
import { wallClock } from '#core/wall.clock'


/**
 * How hard a reasoning facet pulls on attention, as an `attention.demand` urgency.
 *
 * Deliberately below 1: holding a live conversation is a real claim on attention,
 * but the allocator sorts candidates into `maxFoci` slots by salience, and a facet
 * that always outranked everything would starve perception — the mind would stop
 * noticing the world whenever it was talking. At 0.7 an urgent percept still wins
 * a slot; routine traffic does not.
 */
const FACET_ATTENTION_URGENCY = 0.7

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
  if( types.has('focus') ) return 1.0
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

  // ── Action diversity tracking ──────────────────────────────
  private _recentActionTypes: string[] = []

  // ── Coherence version ──────────────────────────────────────
  private _coherenceVersion = 0

  // ── Epistemic uncertainty ──────────────────────────────────
  private _lastEpistemicUncertainty = 0.5

  // ── Last output ────────────────────────────────────────────
  private _lastExecutiveOutput: ExecutiveOutputFull | null = null
  private _lastExecutiveTick: number = -100

  // ── DeliberationCache (optional fast path) ─────────────────
  private _cache: DeliberationCache | null = null
  private _cacheRestored = false
  private _pendingVerify: { fingerprint: Float32Array; cachedActionTypes: string[] } | null = null
  // Last cache outcome this cycle, surfaced as metrics/events from the committed path.
  private _lastCacheHit = false
  private _lastCacheConfidence = 0
  private _lastCacheNeighborCount = 0

  // ── Injected dependencies ──────────────────────────────────
  private _willId: string | null = null
  /**
   * The Will's default model (config.model's `executive` role, resolved in
   * mind.ts). Every other role reaches its model through the router — see
   * `compileRoleRouter`.
   */
  private _modelId: string | null = null
  /** Per-Will LLM transport overrides (config.llm) — env fallbacks apply per field. */
  private _llm: { provider?: string; apiKey?: string; baseUrl?: string; maxOutputTokens?: number; timeoutMs?: number; credentials?: Partial<Record<string, ProviderCredential>>; router?: ModelRouter | null; wire?: LLMWire } | null = null
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

  /**
   * Who each live facet is engaged with AND what it concluded there, learned from
   * `executive.facet.sync`. Keyed by facetId; the last sync wins. Rendered into
   * the master's own prompt so the singular seat can reason across its
   * conversations "as if they were sitting at the same table" — which it cannot
   * do while it only knows facet numbers. Stale entries age out on read (see
   * _activeConversations).
   *
   * `concluded` IS THE RETURN LEG, and it did not exist. `executive.facet.sync`
   * has always carried the facet's full `reasoning`; this handler received it and
   * dropped it on the floor. So the sync was one-way: the master's thinking flows
   * DOWN to facets as "What I've Been Turning Over", while what a facet worked out
   * came back as identity and a salience spike — that attention had been engaged,
   * and with whom, never what it concluded.
   *
   * A facet is the same mind with a focus, not a subordinate reporting in. A mind
   * that cannot read back its own thinking from where its attention has been is
   * split, and the prompt comment two files over already named the consequence:
   * "telling one person it has contacted another when it has not".
   *
   * It is kept HERE, on the engine, rather than as a percept, because a percept is
   * swept after 2 ticks and a working-memory item decays below the retrieval
   * threshold in about 9 — while the master's own interval is 15. Anything routed
   * that way is usually gone before the master next reads. This survives to the
   * next cycle by construction.
   */
  private _facetSubjects = new Map<string, {
    entityId:   string
    name?:      string
    tick:       number
    concluded?: string
    /** Commitments the facet declared toward a THIRD party while attending here. */
    promised?:  Array<{ what: string; target?: string; gist?: string; tick: number }>
  }>()

  // ── Cognitive models ───────────────────────────────────────
  private readonly _model = new GenerativeModel()
  private readonly _generativeModel = new GenerativeModel( 0.2, 100 )

  // ── Summarizer restore flag ────────────────────────────────
  private _summarizerRestored = false

  // ── Last state reference (for onReasoningComplete and facets) ─
  private _lastStateRef: ReadonlySimulationState | null = null

  /**
   * The tick currently being processed, refreshed every react() — distinct from
   * `_lastStateRef` (which tracks the REASONING tick and must not move under
   * onReasoningComplete) and from `_lastExecutiveTick` (the last cycle that ran).
   *
   * Off-tick arrivals — a facet handoff, in particular — need to be stamped with
   * when they actually happened. Using `_lastExecutiveTick` for that dated them to
   * the last master cycle, which can be hundreds of ticks behind.
   */
  private _currentTick = 0

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

  /**
   * The Will's default model. Set before the first tick.
   *
   * This replaced a four-role map (W7): the other roles are routing rules now,
   * compiled in mind.ts, so the engine holds one model and one router rather
   * than a model per role plus a router.
   */
  set modelId( id: string | null ){ this._modelId = id }
  get modelId(): string | null { return this._modelId }

  /** Per-Will LLM transport overrides (config.llm). Set before the first tick. */
  set llm( c: { provider?: string; apiKey?: string; baseUrl?: string; maxOutputTokens?: number; timeoutMs?: number; credentials?: Partial<Record<string, ProviderCredential>>; router?: ModelRouter | null; wire?: LLMWire } | null ){ this._llm = c }

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
  /**
   * The provider, from config or environment — never guessed.
   *
   * This used to default to 'anthropic', which is how a Will configured for one
   * vendor could quietly talk to another. An unset provider is a configuration
   * error, and saying so at construction is far cheaper than a 401 mid-tick.
   */
  private _requireProvider(): LLMProvider {
    const provider = this._llm?.provider ?? process.env.WILL_LLM_PROVIDER
      ?? ( this._noLiveCalls() ? MOCK_PROVIDER : undefined )
    if( !provider )
      throw new Error(
        'No LLM provider configured. Set one on the Will (llm.provider) or in ' +
        'the environment (WILL_LLM_PROVIDER) — the engine carries no default.'
      )
    return provider as LLMProvider
  }

  /**
   * True when this Will cannot make a live call, so provider/model are not
   * required: mock mode, or a replay re-feeding recorded completions.
   */
  private _noLiveCalls(): boolean {
    return this._testMode || ( !!this._willId && !!getCompletionSource( this._willId ) )
  }

  /**
   * Build this Will's one and only director.
   *
   * There used to be a cache of them, keyed by model, because the per-role
   * model map had no other way to make a role use a different model. Routing
   * gave it one — the role map now compiles to rules (see `compileRoleRouter`)
   * and a single director resolves every call's endpoint per call. That is also
   * strictly more faithful: a facet follows the work it is doing rather than
   * whatever role it happened to be spawned under.
   */
  private _buildDirector( model: string ): LLMDirector {
    // Resolved first: the key fallback below is keyed by it.
    const provider = this._requireProvider()

    // Per-Will transport overrides first (BYO keys), env per field otherwise.
    return new LLMDirector( {
      willId: this._willId!,
      model,
      maxOutputTokens: this._llm?.maxOutputTokens ?? parseInt( process.env.WILL_MAX_OUTPUT_TOKENS ?? '8096'),
      // Config, then the provider-agnostic env, then THIS provider's own env.
      // The last step is not the fallback W9 removed: that one ended at
      // ANTHROPIC_API_KEY for every provider, so a Will pointed elsewhere sent
      // Anthropic's key to a stranger. This one can only ever read the key
      // belonging to the provider actually configured.
      apiKey: this._llm?.apiKey ?? process.env.WILL_LLM_API_KEY ?? providerKeyFromEnv( provider ) ?? '',
      provider,
      // Optional base-URL override (e.g. Ollama / Azure / self-hosted). Unset →
      // the director uses the provider's official endpoint.
      baseUrl: this._llm?.baseUrl ?? process.env.WILL_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL,
      timeoutMs: this._llm?.timeoutMs ?? ( process.env.WILL_LLM_TIMEOUT_MS ? parseInt( process.env.WILL_LLM_TIMEOUT_MS ) : undefined ),
      sessionLogger: this._sessionLogger,
      mock: this._testMode,
      // Inject the per-Will tracker (R4) so live calls record usage here, not
      // through a process global. null is fine — the director skips recording.
      tokenTracker: this._tokenTracker,
      // Credentials for routed calls, narrowed by the stem from the host's
      // per-provider map. Prices from that same map ride to the TokenTracker
      // instead, so nothing carries pricing into the call path.
      ...( this._llm?.credentials ? { credentials: this._llm.credentials } : {} ),
      // Per-call model selection — the host's router chained with the rules
      // compiled from the per-role model map.
      ...( this._llm?.router ? { router: this._llm.router } : {} ),
      // Dialect for the default provider — required for anything outside the
      // known set, so the engine never guesses how to talk to an endpoint.
      ...( this._llm?.wire ? { wire: this._llm.wire } : {} ),
    } )
  }

  /**
   * Spawn a facet.
   *
   * `role` declares the facet's intent at the call site. It no longer selects a
   * model: that used to happen here, pinning a facet for life to whatever role
   * it was spawned under, and it now happens per call from the focus function
   * the caller sets immediately afterwards (W7). The two always agreed — every
   * spawn site sets a focus whose `function` matches its role — so the routed
   * answer is the same one, decided later and from the work itself.
   */
   spawnFacet(
    role?: 'deliberation' | 'conversation' | 'outreach' | 'supervision',
    /**
     * What this facet is FOR — see `FacetSpawnDeps.key`. Two spawns with the same
     * key get the same facet, so callers no longer each invent their own dedup
     * (and `authorOutreach`, which had none, no longer opens a rival facet on a
     * person the mind is already talking to).
     */
    key?: string,
  ): { attention: 'available' | 'full', handle?: ExecutiveFacetHandle } {
    void role
    // Delegate to FacetSupervisor (R5-g-3), passing the current engine
    // attachments. The supervisor owns the registry + attention budget and
    // performs the throw-checks on bus / director / state ref.
    return this._facetSupervisor.spawn( {
      ...( key ? { key } : {} ),
      bus:         this._bus,
      llmDirector: this._llmDirector,
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

  /**
   * The facet already attending to `key`, if one is open — without spawning.
   * See FacetSupervisor.handleFor.
   */
  facetFor( key: string ): ExecutiveFacetHandle | undefined {
    return this._facetSupervisor.handleFor( key )
  }

  // ── CognitiveEngine interface ──────────────────────────────

  subscribes(): string[] { return [ '*' ] }
  publishes(): CognitiveEventSchema[] { return [] }

  /**
   * Fold one resolved act into the mind's record of its own doing.
   *
   * `withheld` is kept distinct from `failed` deliberately: the mind formed the
   * act and chose not to complete it, which is a judgement, not an inability.
   * Collapsing them is the #123 mistake — a COO learning it was bad at speaking
   * from the times it decided not to speak.
   */
  private _recordAction( event: CognitiveEvent ): StateCommands | void {
    const p = event.payload as {
      actionType?: unknown; success?: unknown; targetEntityId?: unknown
      description?: unknown; planId?: unknown; tick?: unknown
    } | undefined
    const type = typeof p?.actionType === 'string' ? p.actionType : undefined
    if( !type ) return

    const status: ActionStatus = event.type === 'action.withheld' ? 'withheld'
      : p?.success === false ? 'failed'
      : 'completed'

    const record = actionRecordEntity({
      type, status,
      tick: typeof p?.tick === 'number' ? p.tick : 0,
      ...( typeof p?.targetEntityId === 'string' ? { targetEntityId: p.targetEntityId } : {} ),
      // WHOLE. 120 here, 300 at the session log and 700 at the MCP boundary were
      // three unexamined numbers cutting the same string, and the cut was the
      // engine deciding how much of what a host said the mind was allowed to
      // keep. What a host sends is consumed in its entirety; what the engine
      // itself composes it may bound (see `PERCEPT_SUMMARY_CAP`), because there
      // it is not destroying anyone's only copy.
      //
      // Safe to leave unbounded only because P2 split fate from facts: this
      // carries a FATE, which is short by nature. The answer to a lookup leaves
      // through `observation` and reaches the mind as a percept.
      outcome: typeof p?.description === 'string' ? p.description : '',
      ...( typeof p?.planId === 'string' ? { planId: p.planId } : {} ),
    })

    // Pruning happens in `react`, which has frozen state to prune against; an
    // event handler sees only the event.
    return { set: [ record ] }
  }

  snapshot(): Record<string, unknown> {
    return {
      bufferSize: this._gatingState.salienceBuffer.length,
      coherenceVersion: this._coherenceVersion,
      lastConfidence: this._lastExecutiveOutput?.confidence ?? 0
    }
  }

  onCognitiveEvent( event: CognitiveEvent ): StateCommands | void {
    if( event.sourceEngine === this.name ) return

    // What became of what I did.
    //
    // the outcomes section has existed — section, builder and type —
    // since it was written, fed by `context.ts` scanning `decision.record` for
    // an `actionStatus` that nothing in the engine has ever set. It rendered 0
    // times across every prompt a live COO received. So the mind could see what
    // it had SAID and never what it had DONE, and its only other record of
    // acting is `## Recent Actions`, which is built from the executive's own
    // DECISIONS. A record of acting that contains only intentions cannot
    // distinguish an intention from an act — and one did not, reporting a spec
    // as drafted and sent when it had no effectors and had sent nothing.
    //
    // Written here because these events already arrive here (`subscribes()` is
    // `['*']`) and the returned commands are drained onto state by the
    // orchestrator. See `action.record.ts`.
    if( event.type === 'action.outcome' || event.type === 'action.withheld')
      return this._recordAction( event )

    // Spare attention scales the facet allowance within the persona's ceiling.
    if( event.type === 'attention.state.changed'){
      const p = event.payload as { freeFraction: number }
      this._facetSupervisor.setAttentionState( p.freeFraction )
      return
    }

    // The facet legs. These MUST be dispatched here rather than through their own
    // `bus.subscribe` calls: the bus keeps one subscription per engineId, and the
    // orchestrator's `subscribe( engine.name, engine.subscribes(), … )` runs after
    // `attachBus`, so anything registered separately is silently replaced. This
    // `['*']` subscription is the engine's only live one.
    if( event.type === 'executive.facet.sync'){
      this._onFacetSync( event )
      return
    }

    if( event.type === 'executive.facet.handoff'){
      this._onFacetHandoff( event )
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
    this._currentTick = tick as unknown as number
    this._deferred.flush( state, tick as unknown as number )
    this._deferred.markReactTick( tick as unknown as number )
    // Per-tick facet pump: refresh every facet's state ref to THIS tick's frozen
    // snapshot and launch reasoning for queued reports (tick-discipline mode).
    // Sits at a fixed point in the serial engine order — the issue-side twin of
    // the CompletionInbox drain in Phase 2. See .TODO/FACET_REPLAY_DETERMINISM.md.
    this._facetSupervisor.pump( state )

    const result = await super.react( delta, tick, state, context )

    // Reasoning facets occupy attention. Merged into whatever this tick already
    // produced — AsyncEngine.react returns commands on every tick, reasoning or not,
    // so the allocator sees the cost land the tick it is incurred.
    const focus = this._facetAttentionDemands( state, tick as unknown as number )
    if( focus.set.length || focus.delete.length ){
      result.commands ??= {}
      result.commands.set    = [ ...( result.commands.set    ?? [] ), ...focus.set ]
      result.commands.delete = [ ...( result.commands.delete ?? [] ), ...focus.delete ]
    }

    // Hold as many acts as the prompt shows and no more. Done here rather than
    // in the event handler because pruning needs frozen state to prune against.
    const stale = staleActionRecordIds( state.entities as never )
    if( stale.length > 0 ){
      result.commands ??= {}
      result.commands.delete = [ ...( result.commands.delete ?? [] ), ...stale ]
    }

    return result
  }

  /**
   * What the mind is attending to because a facet is reasoning about it, as
   * `attention.demand` entities the AttentionAllocator allocates real capacity
   * against (`_extractSalienceSignals` reads this type; `costPerFocus` is then
   * charged against the same 100-unit budget as perceptual foci).
   *
   * This closes a loop that was open in one direction only: the allocator's
   * `freeFraction` scaled the facet budget, but facets never appeared in
   * `_activeFocus`, so holding three conversations reported exactly as much spare
   * attention as holding none. The budget was being scaled by a signal blind to the
   * thing it was bounding.
   *
   * `urgency` sits below 1 on purpose: a live conversation is a genuine claim on
   * attention but must not automatically outrank every percept — the allocator sorts
   * candidates by salience into `maxFoci` slots, and a facet that always won would
   * starve perception. Only BUSY facets are charged; an open-but-quiet thread is one
   * the mind is in, not one it is attending to.
   */
  private _facetAttentionDemands(
    state: ReadonlySimulationState,
    tick: number,
  ): { set: EntityInput[]; delete: string[] } {
    const busy = this._facetSupervisor.busyFacetIds()
    const set: EntityInput[] = []
    const live = new Set<string>()

    for( const facetId of busy ){
      const id = `facet-attending-${facetId}`
      live.add( id )
      const subject = this._facetSubjects.get( facetId )
      set.push({
        id,
        type: 'attention.demand',
        metadata: {
          urgency: FACET_ATTENTION_URGENCY,
          source:  'executive-facet',
          facetId,
          ...( subject?.entityId ? { subjectEntityId: subject.entityId } : {} ),
          ...( subject?.name     ? { subjectName:     subject.name     } : {} ),
          // NOT `generatesGoal` — GoalManager turns flagged demands into goals, and
          // "I am talking to someone" is a state, not something to pursue.
          tick,
        },
      })
    }

    // Release the attention a facet held once it stops reasoning (or is reaped).
    const del: string[] = []
    for( const [ id, e ] of state.entities )
      if( e.type === 'attention.demand'
          && ( e.metadata as Record<string, unknown> | undefined )?.['source'] === 'executive-facet'
          && !live.has( id ) )
        del.push( id )

    return { set, delete: del }
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

    // Restore the deliberation cache from state on first tick (parallels the summary)
    if( this._cache && !this._cacheRestored ){
      this._restoreDeliberationCache( state )
      this._cacheRestored = true
    }

    // Read runtime config overrides from state
    const rtConfig = readRuntimeConfig( state, {
      executiveInterval: this._executiveInterval,
      cooldownTicks: this._cooldownTicks
    } )
    this._gatingState.executiveInterval = rtConfig.executiveInterval
    this._gatingState.cooldownTicks = rtConfig.cooldownTicks

    // Initialize the LLM director if not yet done (requires willId). One per
    // Will — every role reaches its model through the router.
    if( !this._llmDirector && this._willId ){
      // No default model. The engine used to fall back to a Claude id for every
      // provider but GLM, which meant a misconfigured Will asked the wrong
      // vendor for the wrong model and failed at the first tick with a 404
      // instead of at construction with a sentence.
      //
      // Two cases legitimately have no credentials and are exempt: a test-mode
      // Will (never reaches a network — demanding a key would break the whole
      // point of the no-key quickstart) and a replay (completions are re-fed
      // from the tape, which carries the model that actually served them). The
      // sentinel is what a mock run records, so the tape still says plainly
      // that nothing real answered.
      const defaultModel = this._modelId ?? process.env.WILL_LLM_MODEL
        ?? ( this._noLiveCalls() ? MOCK_MODEL : undefined )
      if( !defaultModel )
        throw new Error(
          'No LLM model configured. Set one on the Will (llm.model) or in the ' +
          'environment (WILL_LLM_MODEL) — the engine carries no default.'
        )
      this._llmDirector = this._buildDirector( defaultModel )
      // The summarizer shares that director. Its calls tag themselves
      // `category: 'summarizer'`, which is what a configured summarizer role
      // compiles to — so it still gets its own model, chosen per call.
      this._summarizer?.attachLLMDirector( this._llmDirector )
    }

    // Evaluate gating
    const gatingDeps: GatingDependencies = {
      generativeModel: this._generativeModel,
      hasPendingWork: this.hasPendingWork
    }

    const result = evaluateGating( state, tick, gatingDeps, this._gatingState )

    // Always update counters, even when not activating
    updateGatingState( this._gatingState, state, tick, result.shouldActivate, result.cleanedBuffer )

    if( result.shouldActivate )
      logger.info(`[executive] activating — reason: ${result.reason} (tick=${tick})`)

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

    // Mark which buffer entries this cycle consumes. Anything pushed after this
    // point arrives during the LLM call and was never part of the broadcast, so
    // onReasoningComplete() preserves it rather than wiping the whole buffer.
    this._consumedBufferEntries = [ ...this._gatingState.salienceBuffer ]

    // Update all facets with the latest state reference
    this._facetSupervisor.broadcastStateRef( state )

    // ── DeliberationCache fast path (optional) ───────────────
    // A learned interpolation of past executive outputs. When a highly similar,
    // highly competent precedent exists we skip the LLM entirely. R2-safe: the
    // fingerprint, retrieval and composition are pure functions of the frozen
    // state and the cache's own snapshotted contents. The mandatory bookkeeping
    // above (buffer marking, facet broadcast) has already run, so a cache hit and
    // a slow tick leave the facet/buffer discipline in the same state.
    this._pendingVerify = null
    if( this._cache ){
      const cacheTick = footprint.tickObserved as unknown as number
      this._cache.decay()
      const fp = extractFingerprint( state )
      const cacheResult = this._cache.retrieve( fp, cacheTick )
      this._lastCacheHit           = cacheResult.hit
      this._lastCacheConfidence    = cacheResult.confidence
      this._lastCacheNeighborCount = cacheResult.neighbors.length

      if( cacheResult.hit && cacheResult.output ){
        if( !this._cache.shouldVerify() ){
          // FAST PATH — return the composed output; this tick spends no tokens.
          stream.report('executive_complete', {
            actionCount:      cacheResult.output.actions.length,
            planCount:        0,
            newBeliefCount:   cacheResult.output.newBeliefs?.length ?? 0,
            hasIntrospection: false,
            hasNarrative:     false,
          } )
          logger.info(
            `[executive] ⚡ cache hit tick=${cacheTick}  ` +
            `ρ=${cacheResult.confidence.toFixed( 3 )}  neighbors=${cacheResult.neighbors.length}`
          )
          return cacheResult.output
        }
        // Hit selected for verification — run the LLM and score the cache against it.
        this._pendingVerify = {
          fingerprint:       fp,
          cachedActionTypes: cacheResult.output.actions.map( a => a.type ),
        }
      }
    }

    // Build executive context using PromptFactory's helper
    const execContext = await PromptFactory.buildFreshContext( {
      workingMemory: this._workingMemory,
      goalManager: this._goalManager,
      episodicConsolidator: this._episodicConsolidator,
      semanticIntegrator: this._semanticIntegrator
    }, state )

    stream.report('context_assembled', {
      workingMemoryItems: execContext.workingMemory.length,
      activeGoals: execContext.goals.length,
      totalEpisodes: this._episodicConsolidator?.getAllEpisodes().length ?? 0,
      totalBeliefs: execContext.beliefs.length
    } )

    // Compute modulation and uncertainty using PromptFactory
    const qualityModulation = PromptFactory.computeQualityModulation( state )
    stream.report('modulation', { qualityModulation } )

    const epistemicUncertainty = PromptFactory.computeEpistemicUncertainty( execContext, state )
    this._lastEpistemicUncertainty = epistemicUncertainty

    // Dual-process control (a-priori effort gate). Decide BEFORE the call whether the
    // master reasons fast (System 1) or deliberately (System 2). All inputs are already
    // computed this tick, so the choice is free and deterministic (R2). The threshold is
    // the *effective* one (base ⊕ persona-prior): an analytical Will develops a lower
    // threshold and deliberates more readily — effort allocation as a developing trait.
    const deliberateThreshold = readEffectiveParams( state, 'engine-config-executive').deliberateThreshold ?? DELIBERATE_THRESHOLD
    const processSelection = selectProcess( {
      epistemicUncertainty,
      priorConfidence:   this._lastExecutiveOutput?.confidence ?? 0.5,
      novelty:           state.metrics.get('perception.novelty') ?? 0,
      stressLoad:        state.metrics.get('stress.load') ?? 0,
      // Something a conversation surfaced is waiting on the master and has not
      // been dealt with. This used to read the pending-message queue, which was
      // never filled — so the effort gate's `pending_reply` term was structurally
      // zero for every master that has ever run. Escalations are the master's real
      // version of "someone is waiting on me": the facets do the replying, the
      // master owns what they escalate.
      hasPendingMessage: this._escalations.size > 0,
    }, deliberateThreshold )
    stream.report('process_selected', {
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
          focus,
        deps: promptDeps,
        recentActionTypes: [ ...this._recentActionTypes ],
        mode: 'master',
        activeConversations: this._activeConversations(),
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
        meta: {
          category: 'executive',
          attribute: 'master',
          process: 'ideation',
          function: '-',
          demand: processSelection.effortScore
        },
      } )
      logger.info(
        `[executive] ◆ deliberate propose tick=${state.tick}  ` +
        `candidates=${ideationCandidates?.length ?? 0}  temp=${proposeTemperature.toFixed( 2 )}  latency=${wallClock() - ideationStart}ms`
      )
    }
    stream.report('ideation_complete', {
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
      focus,
      deps: promptDeps,
      recentActionTypes: [ ...this._recentActionTypes ],
      mode: 'master',
      activeConversations: this._activeConversations(),
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
      beliefCount:        execContext.beliefs.length,
      beliefsOmitted:     execContext.beliefsOmitted,
      promptPath: this._llmDirector?.writeDebugPrompt( state.tick, systemPrompt, userMessage ) ?? ''
    } )

    // Call LLM
    if( !this._llmDirector )
      throw new Error('LLM director not initialized — willId must be set before first tick')

    const llmStart = wallClock()  // perf timing only — latency is telemetry, never replay state
    let executiveOutput: ExecutiveOutputFull

    try {
      // Use streaming call when clients are connected (F3); fall back to regular call.
      // MODEL_ROUTING W0 — the effort gate already weighed this tick's demand
      // (uncertainty, prior confidence, novelty, a pending reply, stress load);
      // forward it rather than inventing a second measure of the same thing.
      const masterMeta: LLMCallMeta = { category: 'executive', attribute: 'master', process: 'decision', function: '-', demand: processSelection.effortScore }
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
        ? `./data/wills/${this._willId}/debug/response-tick-${String( state.tick ).padStart( 6, '0')}.txt`
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
      logger.error(`[executive] LLM call failed: ${msg.slice( 0, 200 )}`)

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
      hasIntrospection: !!executiveOutput.introspection,
      hasNarrative: !!executiveOutput.narrative
    } )

    stream.report('executive_complete', {
      actionCount: executiveOutput.actions.length,
      planCount: executiveOutput.plans?.length ?? 0,
      newBeliefCount: executiveOutput.newBeliefs?.length ?? 0,
      hasIntrospection: !!executiveOutput.introspection,
      hasNarrative: !!executiveOutput.narrative
    } )

    // ── DeliberationCache learning (slow path) ───────────────
    // extractFingerprint is pure over the frozen `state`, so recomputing here
    // yields the identical vector used on entry — no need to thread it through.
    if( this._cache ){
      const learnTick = footprint.tickObserved as unknown as number
      if( this._pendingVerify ){
        const match = this._actionTypesMatch(
          this._pendingVerify.cachedActionTypes,
          executiveOutput.actions.map( a => a.type ),
        )
        this._cache.updateCompetence( this._pendingVerify.fingerprint, match ? 1 : 0, learnTick )
        this._pendingVerify = null
      } else {
        this._cache.learn( extractFingerprint( state ), executiveOutput, learnTick )
      }
    }

    return executiveOutput
  }

  protected override onIntermediateResult(
    step: string,
    result: unknown,
    _footprint: ReasoningFootprint,
    _context: SimulationContext,
  ): StateCommands | null {
    const data = result as Record<string, unknown>

    if( step === 'context_assembled')
      return {
        metrics: [
          [ 'executive.phase', 0 ],
          [ 'executive.context_items', ( data.workingMemoryItems as number ) ?? 0 ]
        ]
      }

    if( step === 'modulation')
      return {
        metrics: [
          [ 'executive.phase', 1 ],
          [ 'executive.quality_modulation', ( data.qualityModulation as number ) ?? 1 ]
        ]
      }

    if( step === 'process_selected')
      return {
        metrics: [
          [ 'executive.process', ( data.process as string ) === 'deliberate' ? 1 : 0 ],
          [ 'executive.effort_score', ( data.effortScore as number ) ?? 0 ]
        ]
      }

    if( step === 'ideation_complete')
      return {
        metrics: [
          [ 'executive.deliberate_candidates', ( data.candidateCount as number ) ?? 0 ]
        ]
      }

    if( step === 'executive_complete')
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
    // Convert buffered executive.facet.handoff events into high-salience
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

    // Merge escalation percepts into the final commands.
    //
    // `_reconcileUndertakings` used to sit here, discharging promises the engine
    // judged kept and dropping restatements. Both are gone with the undertaking
    // harness: a promise is no longer a percept, so there is nothing to
    // reconcile. What the facet declared rides the sync tract to the master's own
    // prompt, and what to do about it — including whether it is still worth
    // doing — is the mind's, through the goal machinery it already has.
    if( escalationPercepts.length ){
      commands.set ??= []
      commands.set.push( ...escalationPercepts )
    }

    // ── Persist deliberation cache (mirrors the rolling summary) ──
    // Written each executive cycle so the learned patterns survive snapshot/
    // restore (R2). Bounded by maxPatterns; the stored output objects are only
    // ever read back, so state's deep-freeze of them is harmless.
    if( this._cache ){
      commands.set ??= []
      commands.set.push( {
        id: 'executive-deliberation-cache',
        type: 'executive.cache',
        metadata: { snapshot: this._cache.snapshot() },
      } )

      // Surface cache state the R2-safe way: metrics ride the returned
      // StateCommands (never a frozen-state mutation), and hit/miss events
      // publish from this committed path so faculties can react to how
      // automatic the Will is becoming.
      const total = this._cache.hitCount + this._cache.missCount
      commands.metrics ??= []
      commands.metrics.push(
        [ 'cache.hit',        this._lastCacheHit ? 1 : 0 ],
        [ 'cache.confidence', this._lastCacheConfidence ],
        [ 'cache.hit_rate',   total > 0 ? this._cache.hitCount / total : 0 ],
        [ 'cache.size',       this._cache.size ],
      )
      this._bus?.publish( this._lastCacheHit
        ? {
            type: 'cache.hit', version: 1, sourceEngine: this.name,
            salience: this._lastCacheConfidence,
            payload: { confidence: this._lastCacheConfidence, neighborCount: this._lastCacheNeighborCount },
          }
        : {
            type: 'cache.miss', version: 1, sourceEngine: this.name,
            salience: 0.3,
            payload: { confidence: this._lastCacheConfidence },
          } )
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

  /**
   * The people the mind is in conversation with right now, newest first.
   *
   * Pruned against the supervisor's live facets on every read: a reaped facet is a
   * conversation that has ended, and a master that still believes it is mid-thread
   * with someone reasons about a table that is no longer there.
   */
  private _activeConversations(): { entityId: string; name?: string; sinceTick: number }[] {
    const live = this._facetSupervisor.liveFacetIds()
    for( const id of [ ...this._facetSubjects.keys() ] )
      if( !live.has( id ) ) this._facetSubjects.delete( id )

    return [ ...this._facetSubjects.values() ]
      .sort( ( a, b ) => b.tick - a.tick )
      .map( s => ({
        entityId: s.entityId,
        ...( s.name ? { name: s.name } : {} ),
        sinceTick: s.tick,
        ...( s.concluded ? { concluded: s.concluded } : {} ),
        ...( s.promised?.length ? { promised: s.promised } : {} ),
      }) )
  }

  /**
   * Facet sync — remember WHO each facet is with, and wake the master.
   *
   * Reached from `onCognitiveEvent`, NOT from its own `bus.subscribe`. The bus
   * stores one subscription per engineId (`_subscriptions.set( engineId, … )`),
   * so a second `subscribe(this.name, …)` silently REPLACES the first — and the
   * orchestrator registers `subscribe( engine.name, engine.subscribes(), … )`
   * after `attachBus`, which replaced everything registered here. Two dedicated
   * handlers used to be installed at this point; the second overwrote the first
   * and the orchestrator then overwrote that, so neither ever ran. The escalation
   * leg had been dead in production for its whole life: a facet could escalate,
   * the audition engine published, and nothing was listening.
   */
  /**
   * Retire undertakings the mind has already honoured, and refuse to restate one
   * it is already carrying.
   *
   * An undertaking percept says, in the first person, "I said I would reach X and
   * nothing has gone to them yet". That sentence has to stop being true at some
   * point, and nothing made it stop. Measured on a live Will: SEVEN of them
   * accumulated in state, every one still asserting nothing had been sent, while
   * a `conversation.sent` to that person sat right beside them. She read seven
   * standing unfulfilled promises every cycle and dutifully sent the same message
   * again, five times in five minutes and once more in the next session — the
   * percept meant to stop her forgetting a promise was making her unable to
   * believe she had kept it.
   *
   * Discharged by EVIDENCE, not by a timer: a `conversation.sent` to that target,
   * written no earlier than the undertaking, means the contact happened. That
   * record is durable and snapshots with the state, so the discharge survives a
   * restart exactly as the promise does — which the tick-scoped satiation in
   * `enactionFootprint` deliberately cannot.
   *
   * It stays a decision, not an erasure. Retiring the percept removes the standing
   * claim that the words are unsent; whether to say more to that person is then an
   * ordinary competition like any other.
   */
  private _onFacetSync( event: CognitiveEvent ): void {
    const payload = event.payload as {
      facetId?: string
      reasoning?: string
      confidence?: number
      tick?: number
      subjectEntityId?: string
      subjectName?: string
    }

    // Remember WHO this facet is with, and WHAT it worked out there. The second
    // half is the return leg: `reasoning` has always been on this payload and was
    // read into a local and then dropped, so the master learned that its attention
    // had been engaged and never what it concluded.
    //
    // Carried whole, not clipped. For the master this is the only copy — the
    // facet's own history is in the facet, and once that conversation ends the
    // thinking is gone. Live facets are few (one per open conversation), so this
    // is bounded by how many people the mind is talking to, not by traffic.
    if( payload.facetId && payload.subjectEntityId ){
      const prior = this._facetSubjects.get( payload.facetId )
      this._facetSubjects.set( payload.facetId, {
        entityId: payload.subjectEntityId,
        ...( payload.subjectName ? { name: payload.subjectName } : {} ),
        tick: payload.tick ?? this._lastExecutiveTick ?? 0,
        ...( payload.reasoning ? { concluded: payload.reasoning } : {} ),
        // Promises ride along rather than being re-derived: a commitment the facet
        // DECLARED is a fact, while the same thing read back out of prose is a
        // guess. Preserved across syncs until the master has read them.
        ...( prior?.promised?.length ? { promised: prior.promised } : {} ),
      })
    }

    // Unconditional (not gated on WORKSPACE_THRESHOLD like ordinary traffic):
    // a facet reporting back is the master's own attention returning, and the
    // point of the spike is that it re-evaluates rather than waiting out its
    // interval.
    this._gatingState.salienceBuffer.push({
      event,
      tick: payload.tick ?? event.logicalTime ?? 0,
    })

    logger.info(
      `[executive] master received facet sync from ${payload.facetId}` +
      ( payload.subjectName || payload.subjectEntityId
        ? ` (with ${payload.subjectName ?? payload.subjectEntityId})` : '') +
      ` (confidence=${payload.confidence?.toFixed( 2 )})`
    )
  }

  /**
   * A focused part of me surfaced something the singular seat owns — work to plan
   * (`escalation`) or an intention toward a third party (`undertaking`).
   *
   * ONE handler for every facet type. This was `_onAuditionTaskSignal`, listening
   * on a topic named for one sense engine and typed with one sense engine's nouns
   * (`entityId`, `threadId`), which meant a planning, supervision or deliberation
   * facet had no way to hand anything up at all. See EscalationBuffer for the full
   * rationale; new kinds go in `HandoffBody`, not in a new topic and a new handler
   * beside this one.
   *
   * Master stays out of the reply path entirely:
   *   • The facet has already said (or will say) whatever the person in front of
   *     it needed to hear.
   *   • The master's job is purely cognitive: create a [PLANS] block, update
   *     goals, reflect, or decide whether it still means to make that contact.
   *     Any follow-up communication flows through the agency competition —
   *     NEVER via [REPLY].
   *
   * Buffered rather than written directly: state is read-only here, so
   * `EscalationBuffer.drainToPercepts()` emits it as a StateCommand on the next
   * master cycle, where Exteroception surfaces it under "## Percepts (What I Notice)".
   */
  private _onFacetHandoff( event: CognitiveEvent ): void {
    const payload = event.payload as {
      facetId?:         string
      subjectEntityId?: string
      subjectName?:     string
      threadId?:        string
      confidence?:      number
      tick?:            number
      body:             HandoffBody
    }
    if( !payload?.body?.kind ) return

    // NOW, not the last time the master happened to run.
    //
    // This was `this._lastExecutiveTick`, so an undertaking formed at tick 900 was
    // stamped 780 if that was the last master cycle. `_reconcileUndertakings`
    // discharges on "contacted at or after `madeAt`", which means a message sent at
    // tick 800 — BEFORE the promise existed — retired it. Over-discharge is the safe
    // direction, which is why it never surfaced as a symptom, but it made the promise
    // unfalsifiable: it could be marked kept by something that happened first.
    const tick = payload.tick ?? this._currentTick

    // AN UNDERTAKING RIDES THE TRACT, NOT A HARNESS OF ITS OWN.
    //
    // It used to become a percept plus a standing ideomotor intent plus a bespoke
    // discharge rule — the engine deciding how hard a promise pulls and when it
    // counts as kept. That is judgement, and judgement is the mind's. What is not
    // the mind's to supply is the FACT crossing from where its attention was to
    // where its singular seat is; that crossing is anatomy.
    //
    // So it is filed with what the facet concluded and rendered to the master at
    // its next cycle. Reading that it promised someone something and has not done
    // it, the master may form a goal — which it can already do, and which the goal
    // machinery then lifts, plans and completes. Or it may not, and that is a
    // decision rather than a mechanism failing.
    //
    // The old route could not have worked anyway: a percept is swept at +2 ticks
    // and decays out of working memory at about +9, while the master's interval
    // is 15. The notice was usually gone before the seat it was addressed to ran.
    // Spike the salience buffer FIRST, for both kinds. The master must NOT be
    // handed the inbound as a message to answer — that would make it produce a
    // [REPLY], duplicating the facet's and breaking the facet/master boundary.
    // (The queue that once carried inbound this way was removed in #114: nothing
    // ever filled it.) Done before the undertaking branch returns, so a promise
    // still pulls the master's next cycle forward rather than waiting out the
    // interval — which matters more now that the promise is what it will read.
    this._gatingState.salienceBuffer.push({ event, tick })

    const from = payload.subjectName ?? payload.subjectEntityId ?? payload.facetId ?? 'a focus'

    if( payload.body.kind === 'undertaking'){
      const body = payload.body
      // Keyed by facet because that is what the master's view of its open threads
      // is keyed by. A handoff with no facet id has nowhere to file — say so
      // rather than dropping it quietly, which is how a promise disappears with
      // nobody able to tell whether it was ever made.
      if( !payload.facetId ){
        logger.warn(`[executive] commitment "${ body.what }" arrived with no facetId — nowhere to file it`)
        return
      }
      // Created if absent: a facet can hand something up before its first sync,
      // and requiring the entry to exist first made that promise vanish.
      const at = this._facetSubjects.get( payload.facetId ) ?? {
        entityId: payload.subjectEntityId ?? payload.facetId,
        ...( payload.subjectName ? { name: payload.subjectName } : {} ),
        tick,
      }
      at.promised = [
        // Deduped on WHAT was promised, falling back to the target when two
        // wordings mean the same contact: restating a promise is the same
        // promise, and the master does not need telling twice.
        ...( at.promised ?? [] ).filter( p =>
          p.what !== body.what && !( body.target !== undefined && p.target === body.target ) ),
        { what: body.what,
          ...( body.target ? { target: body.target } : {} ),
          ...( body.gist   ? { gist:   body.gist   } : {} ), tick },
      ]
      this._facetSubjects.set( payload.facetId, at )
      logger.info(
        `[executive] filed commitment from ${from} → "${ body.what }" ` +
        `(it reads this at its next cycle; what to do about it is its own call)`
      )
      return
    }

    this._escalations.push({
      tick,
      ...( payload.facetId         ? { facetId:         payload.facetId }         : {} ),
      ...( payload.subjectEntityId ? { subjectEntityId: payload.subjectEntityId } : {} ),
      ...( payload.subjectName     ? { subjectName:     payload.subjectName }     : {} ),
      ...( payload.threadId        ? { threadId:        payload.threadId }        : {} ),
      body: { ...payload.body, reasoning: ( payload.body.reasoning ?? '').slice( 0, 400 ) },
    })

    logger.info(
      `[executive] master queued escalation percept from ${from} ` +
      `(confidence=${payload.confidence?.toFixed( 2 )})`
    )
  }

  // ── DeliberationCache wiring ───────────────────────────────

  /** Enable the deliberation cache (off by default). Call during mind assembly. */
  enableCache( config?: DeliberationCacheConfig ): void {
    this._cache = new DeliberationCache( config )
  }

  /** True when the cache is active. */
  get cacheEnabled(): boolean { return this._cache !== null }

  /** Telemetry snapshot for harnesses / eval. Null when disabled. */
  cacheStats(): { size: number; hits: number; misses: number } | null {
    if( !this._cache ) return null
    return { size: this._cache.size, hits: this._cache.hitCount, misses: this._cache.missCount }
  }

  /**
   * Reafference hook — update cache competence from a confirmed action outcome.
   * Optional, layered on top of the inline verify loop. Reward follows the
   * research sketch: mean of (action succeeded, stress relief, goal progress).
   */
  onActionOutcome(
    state: ReadonlySimulationState,
    tick: Tick,
    success: boolean,
    stressDelta: number,
    goalProgressDelta: number,
  ): void {
    if( !this._cache ) return
    const reward = (
      ( success ? 1 : 0 ) +
      ( 1 - Math.max( 0, Math.min( 1, stressDelta ) ) ) +
      Math.max( 0, Math.min( 1, goalProgressDelta ) )
    ) / 3
    this._cache.updateCompetence( extractFingerprint( state ), reward, tick )
  }

  private _actionTypesMatch( a: string[], b: string[] ): boolean {
    if( a.length !== b.length ) return false
    for( let i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false
    return true
  }

  private _restoreDeliberationCache( state: ReadonlySimulationState ): void {
    if( !this._cache ) return
    const entity = state.entities.get('executive-deliberation-cache')
    if( !entity ) return
    const snap = entity.metadata?.[ 'snapshot' ] as DeliberationCacheSnapshot | undefined
    if( snap ) this._cache.restore( snap )
  }

  private _restoreSummarizer( state: ReadonlySimulationState ): void {
    if( !this._summarizer ) return

    const entity = state.entities.get('executive-rolling-summary')
    if( !entity ) return

    const m = entity.metadata ?? {}
    const summary = ( m[ 'summary' ] as string ) ?? ''
    const buffer = ( m[ 'buffer' ] as string[] ) ?? []
    const callCount = ( m[ 'callCount' ] as number ) ?? 0

    this._summarizer.restore( summary, buffer, callCount )
    if( summary )
      logger.info(`[executive] summarizer restored (${summary.length} chars, ${callCount} prior calls)`)
  }
}
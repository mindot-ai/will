// ─────────────────────────────────────────────────────────────
// src/cognition/generics/token.tracker.ts
// ─────────────────────────────────────────────────────────────

/**
 * TokenTracker — monitors LLM token consumption across all engines.
 * 
 * Hooks into the LLM calls to record:
 *   - Prompt tokens (input)
 *   - Completion tokens (output)
 *   - Total tokens
 *   - Cost (based on model pricing)
 *   - Per-engine breakdowns
 *   - Per-agent breakdowns
 * 
 * Exposes as metrics so the orchestrator and runner can log costs,
 * and the ParameterOptimizer can factor cost into optimization decisions.
 */
import { logger } from '#core/logger'
import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult } from '#cognition/types'
import { appendFileSync, mkdirSync } from 'node:fs'
import { wallClock } from '#core/wall.clock'
// NOTE: no transport import here. cognition/ must not depend on the stem
// transport layer (determinism contract). The tracker exposes a neutral
// onRecord() sink; the stem bridges records onto the transport.

// ── Attribution axes ──────────────────────────────────────
//
// Typed rather than free strings so a deviation is caught at the call site
// instead of surfacing as a silently-unmatched routing rule or a cost bucket
// nobody notices is empty. These live here (not in #llm) because cognition is
// the lower layer — #llm already imports from this module, and the reverse
// would be circular.

/** Top-level cost bucket for an LLM call. */
export type LLMCallCategory =
  | 'executive'       // the master consciousness and its facets
  | 'summarizer'      // rolling memory consolidation
  | 'embedding'       // semantic-memory vectorisation
  | 'identity-guard'  // creation-time persona review

/** The actor/subsystem doing the work. */
export type LLMCallAttribute =
  | 'master'   // the executive itself
  | 'facet'    // a spawned focus (conversation, planning, outreach, supervision)
  | 'memory'   // consolidation / embedding
  | 'guard'    // a safety reviewer

/** The specific cognitive function being paid for. */
export type LLMCallFunction =
  | 'decision'           // the master's fused decision call
  | 'ideation'           // the deliberate path's propose pass
  | 'deliberation'       // action choice under contest
  | 'conversation'       // a live reply
  | 'outreach'           // an unprompted message
  | 'planning'           // plan formation / revision
  | 'supervision'        // plan-step supervision
  | 'consolidation'      // rolling summary
  | 'recall'             // embedding a query
  | 'index'              // embedding a write
  | 'identity-coherence' // persona review

/** One attributed ledger record (5-axis attribution + tokens + cost). */
export type TokenLedgerRecord = Record<string, unknown>
export type TokenRecordListener = ( record: TokenLedgerRecord ) => void

// ── Prompt-cache pricing (Anthropic) ──────────────────────
// `input_tokens` in the API usage already EXCLUDES cached tokens, so the full
// input cost is: fresh input ×1 + cache reads ×0.1 + cache writes ×1.25.
const CACHE_READ_MULT  = 0.1
const CACHE_WRITE_MULT = 1.25

/**
 * Normalize a model id to its bare form so a raw provider string
 * ("claude-sonnet-5-20260114", "anthropic/claude-haiku-4-5", "glm-5.2[1m]")
 * matches a host price keyed plainly — and vice versa. Exact keys are tried
 * first, so a host that prices a long-context variant differently just lists it
 * verbatim and that wins.
 */
function normalizeModelKey( model: string ): string {
  let m = model.toLowerCase().trim()
  const slash = m.lastIndexOf('/')
  if( slash >= 0 ) m = m.slice( slash + 1 )    // drop "provider/" prefix
  m = m.replace( /\[[^\]]*\]$/, '')             // drop a trailing qualifier, e.g. "[1m]"
  return m.replace( /[-@]\d{6,8}$/, '')         // drop trailing -YYYYMMDD date stamp
}
/** USD per 1M tokens for one model. */
export interface ModelPrice { input: number; output: number }

/**
 * Host-supplied prices, keyed by model id. Matching is exact first, then
 * normalized (provider prefix, date stamp and context qualifier stripped), so
 * `claude-sonnet-5` matches `claude-sonnet-5-20260114`.
 *
 * Prices belong to the host: they change on a vendor's schedule, differ per
 * account, and are ~0 for a self-hosted model. The engine ships none.
 */
export type PriceTable = Record<string, ModelPrice>

/** Models already warned about as unpriced — one line each, not one per call. */
const _unpricedWarned = new Set<string>()

/**
 * Resolve the price for a model id from the host's table.
 *
 * The engine ships no prices at all. A table baked into a release is wrong the
 * week a vendor changes a rate, differs per account, and is meaningless for a
 * self-hosted model — and a *partial* table is worse than none, because some
 * models then report plausible-but-stale numbers while others honestly report
 * nothing. Prices live with the host, next to the routing policy they inform.
 *
 * `null` does NOT mean free — it means *unknown*, and the caller reports zero
 * cost with `priced: false` so the gap stays visible rather than confidently
 * wrong. (The removed built-in default priced every unrecognised model at
 * Sonnet's rate, overstating a budget model's output by ~54×.)
 */
export function resolvePricing( model: string, hostPrices?: PriceTable ): ModelPrice | null {
  if( !hostPrices ) return null

  const exact = hostPrices[ model ]
  if( exact ) return exact

  // A host table keyed by bare ids still matches a dated / provider-prefixed
  // model id, and vice versa.
  const norm = normalizeModelKey( model )
  if( hostPrices[ norm ] ) return hostPrices[ norm ]

  for( const [ key, price ] of Object.entries( hostPrices ) ){
    if( normalizeModelKey( key ) === norm ) return price
  }

  return null
}

export interface TokenUsage {
  /** Model identifier (e.g., 'openai/gpt-4o') */
  model: string
  /**
   * The provider that actually served this call.
   *
   * Not derivable from `model`: routing is what makes the same model id
   * reachable from several places — `deepseek-v3` direct, through a gateway, or
   * self-hosted — at prices that differ by orders of magnitude. Without this a
   * host billing across a multi-vendor routing table can attribute spend to a
   * model but never to the vendor it actually paid.
   *
   * Optional because a caller recording usage directly (outside the LLM
   * director) may not know it; absent means unattributed, not "the default".
   */
  provider?: string
  /** Input/prompt tokens consumed */
  promptTokens: number
  /** Output/completion tokens consumed */
  completionTokens: number
  /** Total tokens */
  totalTokens: number
  /** Anthropic prompt-cache read tokens (billed at 0.1× input). Optional. */
  cacheReadTokens?: number
  /** Anthropic prompt-cache write tokens (billed at 1.25× input). Optional. */
  cacheWriteTokens?: number
  /** Estimated cost in USD. Zero when `priced` is false — unknown, not free. */
  estimatedCostUsd: number
  /**
   * Whether a price was found for this model. False ⇒ `estimatedCostUsd` is 0
   * because nothing priced it, NOT because the call was free. A consumer
   * summing costs should surface unpriced calls rather than fold them in as
   * zero.
   */
  priced: boolean

  /**
   * How much this call demanded, 0..1 — the cognitive measure the router saw.
   *
   * Recorded so routing can be ANSWERED rather than argued. Every call computes
   * this, routes on it, and until now threw it away — which left questions like
   * "is deliberation being rated by the tick's mood rather than the stakes of
   * its own choice?" with no dataset at all.
   *
   * Absent means UNMEASURED, never zero. It must stay nullable all the way to
   * storage: a call that never reported demand and a call that reported 0.0 are
   * different facts, and collapsing them would put a floor of invented
   * confidence under exactly the analysis this exists to enable.
   */
  demand?: number

  // ── 5-axis cost attribution ──────────────────────────────
  category:  LLMCallCategory
  attribute: LLMCallAttribute
  function:  LLMCallFunction
  /** Optional specific id or namespace: facet id, entity id, model name. */
  scope?: string
  /** Human-readable label — auto-composed from the axes when the caller omits it. */
  label: string

  /** Optional pre-cache prompt size estimate (chars/4) — for cache-savings analysis. */
  estPromptTokens?: number

  /** Tick when the call completed */
  tick: Tick
  /** Latency in milliseconds */
  latencyMs: number
}

/** What callers pass to {@link TokenTracker.recordUsage} — cost and label are derived. */
export type RecordUsageInput = Omit<TokenUsage, 'estimatedCostUsd' | 'label' | 'priced'> & { label?: string }

/** Compose a stable, readable label from the attribution axes. */
function composeLabel( m: { category: LLMCallCategory; attribute: LLMCallAttribute; function: LLMCallFunction; scope?: string } ): string {
  const base = `${m.category}/${m.attribute}/${m.function}`
  return m.scope ? `${base}#${m.scope}` : base
}

export interface TokenTrackerConfig {
  /**
   * Host-supplied model prices (USD per 1M tokens), merged from the per-provider
   * `prices` maps in `WillLLMConfig.providers`. These win over the built-in
   * fallback table. Omitted ⇒ fallback only.
   */
  prices?: PriceTable
  /** Whether to emit cost events */
  emitCostEvents?: boolean
  /** Cost threshold for warning events */
  costWarningThresholdUsd?: number
  /**
   * When set together with `writeLedger`, every recorded call is appended (with
   * full 5-axis attribution + cost) to `./data/wills/<willId>/debug/token-report.jsonl`
   * — the complete, billable per-Will usage ledger (master, facets, summarizer,
   * embedding, guard — not just the master path).
   */
  willId?: string
  /** Append the attributed ledger to disk (dev convenience). Off in prod/tests/replay. */
  writeLedger?: boolean
}

export class TokenTracker implements SimulationEngine {
  readonly name     = 'token-tracker'
  
  private _emitCostEvents: boolean
  private _costWarningThreshold: number
  private _prices: PriceTable | undefined

  // All recorded usage for the simulation run
  private _usageLog: TokenUsage[] = []

  // Running totals
  private _totalPromptTokens = 0
  private _totalCompletionTokens = 0
  private _totalCost = 0

  // Per-axis breakdowns (cost + tokens), keyed by category and by function.
  private _categoryCosts  = new Map<string, number>()
  private _categoryTokens = new Map<string, { prompt: number; completion: number }>()
  private _functionCosts  = new Map<string, number>()
  private _functionTokens = new Map<string, { prompt: number; completion: number }>()
  // Per-provider spend. The axis a host actually reconciles against invoices —
  // "which vendor did we pay?" is not answerable from the model id once routing
  // can reach one model through several of them.
  private _providerCosts  = new Map<string, number>()
  private _providerTokens = new Map<string, { prompt: number; completion: number }>()

  // Per-tick costs (for spike detection)
  private _tickCosts: number[] = []
  private _maxTickCostSamples = 1000

  // Track last cost warning tick to avoid spam
  private _lastCostWarningTick = 0
  private _lastProcessedIndex = 0

  // Attributed-ledger transports. Listeners are the production transport (the
  // stem bridges them onto the ExternalTransport); the file (`_ledgerPath`) is a
  // dev-only mirror, null when disabled.
  private _recordListeners = new Set<TokenRecordListener>()
  private _ledgerPath: string | null
  private _ledgerDirReady = false

  constructor( config: TokenTrackerConfig = {} ){
    this._emitCostEvents        = config.emitCostEvents        ?? true
    this._costWarningThreshold  = config.costWarningThresholdUsd ?? 0.05
    this._prices                = config.prices
    this._ledgerPath = ( config.writeLedger && config.willId )
      ? `./data/wills/${config.willId}/debug/token-report.jsonl`
      : null
  }

  // ── Public API: record usage ──────────────────────────────

  /**
   * Record a completed LLM call.
   * Called by LLMDirector.call after each completion (src/llm/index.ts).
   */
  recordUsage( usage: RecordUsageInput ): void {
    const pricing    = resolvePricing( usage.model, this._prices )
    const cacheRead  = usage.cacheReadTokens  ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0

    // No price ⇒ cost 0 and `priced: false`. Warn once per model id so an
    // unconfigured provider is visible without flooding the log.
    if( !pricing && !_unpricedWarned.has( usage.model ) ){
      _unpricedWarned.add( usage.model )
      logger.warn(
        `[tokens] no price for "${usage.model}" — reporting cost 0 for it. ` +
        `Supply one via llm.providers.<provider>.prices to get cost telemetry.`
      )
    }

    const costUsd = pricing
      ? ( usage.promptTokens     / 1_000_000 ) * pricing.input  +
        ( usage.completionTokens / 1_000_000 ) * pricing.output +
        ( cacheRead              / 1_000_000 ) * pricing.input * CACHE_READ_MULT  +
        ( cacheWrite             / 1_000_000 ) * pricing.input * CACHE_WRITE_MULT
      : 0

    const full: TokenUsage = {
      ...usage,
      label:            usage.label ?? composeLabel( usage ),
      priced:           pricing !== null,
      estimatedCostUsd: Math.round( costUsd * 1_000_000 ) / 1_000_000, // round to micro-dollars
    }

    this._usageLog.push( full )

    // Running totals
    this._totalPromptTokens     += full.promptTokens
    this._totalCompletionTokens += full.completionTokens
    this._totalCost             += full.estimatedCostUsd

    // Per-axis breakdowns — the repartition surface (category × function).
    this._accumulate( this._categoryCosts, this._categoryTokens, full.category, full )
    this._accumulate( this._functionCosts, this._functionTokens, full.function, full )
    // Unattributed rather than guessed: a caller that did not say which
    // provider served the call must not be silently folded into the default.
    this._accumulate( this._providerCosts, this._providerTokens, full.provider ?? 'unattributed', full )

    // Complete attributed ledger record (every call, all axes + cost): notify
    // record listeners (the stem forwards them onto the transport) and mirror to
    // a file in dev. Accounting must never break a completion → both best-effort.
    this._emitLedger( full )
  }

  /**
   * Subscribe to every attributed ledger record (5-axis attribution + tokens +
   * cost). Neutral sink — the stem bridges these onto the ExternalTransport so
   * cognition/ stays free of any transport dependency. Returns an unsubscribe fn.
   */
  onRecord( listener: TokenRecordListener ): () => void {
    this._recordListeners.add( listener )
    return () => { this._recordListeners.delete( listener ) }
  }

  private _emitLedger( full: TokenUsage ): void {
    if( this._recordListeners.size === 0 && !this._ledgerPath ) return

    const record: TokenLedgerRecord = {
      tick:          full.tick,
      ts:            new Date( wallClock() ).toISOString(), // determinism-ok: ledger timestamp is telemetry, never replay state
      model:         full.model,
      provider:      full.provider,
      category:      full.category,
      attribute:     full.attribute,
      function:      full.function,
      scope:         full.scope,
      label:         full.label,
      inputTok:      full.promptTokens,
      outputTok:     full.completionTokens,
      cacheReadTok:  full.cacheReadTokens  ?? 0,
      cacheWriteTok: full.cacheWriteTokens ?? 0,
      estPromptTok:  full.estPromptTokens,
      costUsd:       full.estimatedCostUsd,
      // Whether costUsd came from a real price. False ⇒ 0 because nothing
      // priced this model, NOT because the call was free — a consumer summing
      // spend must not fold unpriced calls in as zero.
      priced:        full.priced,
      // Undefined stays undefined — see TokenUsage.demand. A consumer that
      // coerces this to 0 has silently invented a measurement.
      demand:        full.demand,
      latencyMs:     full.latencyMs,
    }

    // Production transport — listeners (bridged onto the transport by the stem)
    // persist / re-bill from this.
    for( const fn of this._recordListeners ){
      try { fn( record ) }
      catch { /* listener fault must never break a completion */ }
    }

    // Dev-only file mirror.
    if( this._ledgerPath ){
      try {
        if( !this._ledgerDirReady ){
          mkdirSync( this._ledgerPath.slice( 0, this._ledgerPath.lastIndexOf('/') ), { recursive: true } )
          this._ledgerDirReady = true
        }
        appendFileSync( this._ledgerPath, JSON.stringify( record ) + '\n')
      }
      catch { /* ledger file is best-effort */ }
    }
  }

  /** Fold one call's cost + tokens into a (cost, tokens) breakdown pair under `key`. */
  private _accumulate(
    costMap:  Map<string, number>,
    tokenMap: Map<string, { prompt: number; completion: number }>,
    key:      string,
    full:     TokenUsage,
  ): void {
    costMap.set( key, ( costMap.get( key ) ?? 0 ) + full.estimatedCostUsd )
    const prev = tokenMap.get( key ) ?? { prompt: 0, completion: 0 }
    tokenMap.set( key, {
      prompt:     prev.prompt     + full.promptTokens,
      completion: prev.completion + full.completionTokens,
    })
  }

  // ── Engine interface ─────────────────────────────────────

  async react(
    _delta: Duration,
    tick: Tick,
    _state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Compute this tick's cost (usage recorded since last tick)
    const tickCost = this._computeTickCost()
    this._tickCosts.push( tickCost )
    if( this._tickCosts.length > this._maxTickCostSamples )
      this._tickCosts.shift()

    // Metrics — TOKENS ONLY (W8c).
    //
    // Token counts are a physical, deterministic fact of a call and belong in
    // state. Dollars are the host's accounting over that fact: prices differ per
    // account, change on a vendor's schedule, and are ~0 self-hosted. Nothing in
    // cognition ever read them (the sole consumer was a console runner), yet
    // while they sat in state a host editing its price table changed state bytes
    // and broke replay-equivalence over a number that influenced nothing.
    //
    // Cost still reaches the host every call on the ledger path
    // (`onRecord` → the stem's transport bridge), which is where it was already
    // being consumed. See `totalCostUsd` / `costBreakdown()` for in-process reads.
    commands.metrics!.push(
      [ 'llm.prompt_tokens_total',      this._totalPromptTokens ],
      [ 'llm.completion_tokens_total',  this._totalCompletionTokens ],
      [ 'llm.total_calls',              this._usageLog.length ],
    )

    // Per-axis TOKEN breakdown — the transparency surface for "how much goes
    // into conversation vs executive vs embedding". The matching cost
    // breakdown is host-side now (W8c); `costBreakdown()` still exposes it
    // in-process for anyone holding the tracker.
    for( const [ cat, tok ] of this._categoryTokens ){
      commands.metrics!.push(
        [ `llm.prompt_tokens.${cat}`,     tok.prompt ],
        [ `llm.completion_tokens.${cat}`, tok.completion ],
      )
    }

    // Cost warning event
    if( tickCost > this._costWarningThreshold 
        && this._emitCostEvents 
        && tick - this._lastCostWarningTick > 50 ){
      this._lastCostWarningTick = tick
      events.push({
        type: 'llm.cost_spike',
        source: this.name,
        payload: {
          tickCost,
          totalCost: this._totalCost,
          categoryBreakdown: Object.fromEntries( this._categoryCosts ),
          functionBreakdown: Object.fromEntries( this._functionCosts ),
        },
      })
    }


    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Public query methods ─────────────────────────────────

  /** Total cost since simulation start */
  get totalCostUsd(): number { return this._totalCost }

  /** Total tokens consumed */
  get totalTokens(): { prompt: number; completion: number } {
    return {
      prompt:    this._totalPromptTokens,
      completion: this._totalCompletionTokens,
    }
  }

  /** Cost broken down by category ('executive' | 'summarizer' | 'embedding' | …). */
  get categoryBreakdown(): ReadonlyMap<string, number> {
    return this._categoryCosts
  }

  /** Token counts (prompt + completion) broken down by category. */
  get categoryTokenBreakdown(): ReadonlyMap<string, { prompt: number; completion: number }> {
    return this._categoryTokens
  }

  /** Cost broken down by function ('decision' | 'ideation' | 'conversation' | 'planning' | …). */
  get functionBreakdown(): ReadonlyMap<string, number> {
    return this._functionCosts
  }

  /** Token counts (prompt + completion) broken down by function. */
  get functionTokenBreakdown(): ReadonlyMap<string, { prompt: number; completion: number }> {
    return this._functionTokens
  }

  /**
   * Cost broken down by provider ('anthropic' | 'glm' | 'moonshot' | …), plus
   * an `unattributed` bucket for usage recorded without one.
   *
   * This is the axis a host reconciles against vendor invoices. Calls whose
   * model went unpriced contribute 0 here, so compare against
   * `getUsageLog()`'s `priced` flag before treating a small number as a small
   * bill.
   */
  get providerBreakdown(): ReadonlyMap<string, number> {
    return this._providerCosts
  }

  /** Token counts (prompt + completion) broken down by provider. */
  get providerTokenBreakdown(): ReadonlyMap<string, { prompt: number; completion: number }> {
    return this._providerTokens
  }

  /** Cost per call average */
  get averageCostPerCall(): number {
    if( this._usageLog.length === 0 ) return 0
    return this._totalCost / this._usageLog.length
  }

  /** Cost per tick average */
  get averageCostPerTick(): number {
    return this._averageTickCost()
  }

  /** Estimated cost per hour at current rate */
  estimateHourlyCost(): number {
    if( this._tickCosts.length === 0 ) return 0
    const avgTickCost = this._averageTickCost()
    // Assume 1 tick/second (or read actual tick rate from config)
    return avgTickCost * 3600
  }

  /** Full usage log for export/analysis */
  getUsageLog(): ReadonlyArray<TokenUsage> {
    return this._usageLog
  }

  /** Reset all counters (for new simulation run) */
  reset(): void {
    this._usageLog = []
    this._totalPromptTokens = 0
    this._totalCompletionTokens = 0
    this._totalCost = 0
    this._categoryCosts.clear()
    this._categoryTokens.clear()
    this._functionCosts.clear()
    this._functionTokens.clear()
    this._providerCosts.clear()
    this._providerTokens.clear()
    this._tickCosts = []
  }

  // ── Internal ─────────────────────────────────────────────

  private _computeTickCost(): number {
    // Sum costs of calls that completed since last tick
    // In practice, track the index of last-processed call
    // For simplicity: return average (engine.react is called once/tick)
    // A more precise approach uses a last-processed index
    if( this._usageLog.length === 0 ) return 0
    
    // Return the cost of the most recent call(s) as a simple heuristic
    // A production version would track a cursor
    // Sum all calls recorded since last tick
    let total = 0
    for( let i = this._lastProcessedIndex; i < this._usageLog.length; i++ )
      total += this._usageLog[i]!.estimatedCostUsd
    
    this._lastProcessedIndex = this._usageLog.length

    return total
  }

  private _averageTickCost(): number {
    if( this._tickCosts.length === 0 ) return 0
    return this._tickCosts.reduce( ( s, c ) => s + c, 0 ) / this._tickCosts.length
  }
}

// NOTE (R4): the former process-global `_tracker` + getTokenTracker/
// setTokenTracker accessors were removed. The TokenTracker is now a per-Will
// instance — created in stem/mind.ts, registered as an engine, and injected
// into the executive's LLMDirector via attachTokenTracker(). This keeps
// usage/cost from conflating across Wills and lets parallel runs stay isolated.
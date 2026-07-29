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

/** One attributed ledger record (5-axis attribution + tokens + cost). */
export type TokenLedgerRecord = Record<string, unknown>
export type TokenRecordListener = ( record: TokenLedgerRecord ) => void

// ── Pricing table (USD per 1M tokens) ─────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'openai/gpt-4o':              { input: 2.50,  output: 10.00 },
  'openai/gpt-4o-mini':         { input: 0.15,  output: 0.60  },
  'openai/gpt-4-turbo':         { input: 10.00, output: 30.00 },
  'openai/gpt-3.5-turbo':       { input: 0.50,  output: 1.50  },
  
  // Anthropic (Claude 4.x family — prices per 1M tokens)
  'anthropic/claude-haiku-4-5':  { input: 1.00,  output: 5.00  },
  'anthropic/claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'anthropic/claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'anthropic/claude-opus-4-7':   { input: 5.00,  output: 25.00 },
  // Legacy aliases kept for backward compat
  'anthropic/claude-haiku-4':    { input: 1.00,  output: 5.00  },
  'anthropic/claude-opus-4':     { input: 5.00,  output: 25.00 },
  
  // Z.ai (GLM-5 family). `glm-5.2[1m]` is the same model asking for its 1M
  // context window — same rate, so it gets its own row rather than relying on
  // the normalizer (a future long-context tier would price differently).
  'glm/glm-5.2':                { input: 1.40,  output: 4.40  },
  'glm/glm-5.2[1m]':            { input: 1.40,  output: 4.40  },

  // Google
  'google/gemini-2.0-flash':    { input: 0.10,  output: 0.40  },
  'google/gemini-2.0-pro':      { input: 1.25,  output: 5.00  },
  
  // Meta (via Groq/Replicate)
  'meta/llama-3.3-70b':         { input: 0.59,  output: 0.79  },
  'meta/llama-4-maverick':      { input: 0.20,  output: 0.60  },
  
  // DeepSeek
  'deepseek/deepseek-v3':       { input: 0.27,  output: 1.10  },
  'deepseek/deepseek-r1':       { input: 0.55,  output: 2.19  },

  // Embeddings (input-only — no completion tokens). Priced per 1M input tokens.
  'openai/text-embedding-3-small': { input: 0.02, output: 0 },
  'openai/text-embedding-3-large': { input: 0.13, output: 0 },
  'google/text-embedding-004':     { input: 0,    output: 0 },  // free tier
  'google/gemini-embedding-001':   { input: 0,    output: 0 },  // free tier

  // Fallback for unknown models
  '__default__':                { input: 3.00,  output: 15.00 },
}

// ── Prompt-cache pricing (Anthropic) ──────────────────────
// `input_tokens` in the API usage already EXCLUDES cached tokens, so the full
// input cost is: fresh input ×1 + cache reads ×0.1 + cache writes ×1.25.
const CACHE_READ_MULT  = 0.1
const CACHE_WRITE_MULT = 1.25

/**
 * Normalize a model id to its bare, dateless form so a raw provider model string
 * ("claude-sonnet-4-5-20250929", "anthropic/claude-haiku-4-5") resolves to the
 * right pricing row. Without this, every non-default id missed the `provider/model`
 * keys and silently fell through to __default__ ($3/$15) — pricing Haiku ~3× and
 * DeepSeek ~11× too high, and breaking per-model cost telemetry entirely.
 */
function normalizeModelKey( model: string ): string {
  let m = model.toLowerCase().trim()
  const slash = m.lastIndexOf('/')
  if( slash >= 0 ) m = m.slice( slash + 1 )   // drop "provider/" prefix
  return m.replace( /[-@]\d{6,8}$/, '')        // drop trailing -YYYYMMDD date stamp
}

// Pre-index the pricing table by normalized model name for O(1), date-insensitive
// lookup. Built once at module load.
const PRICING_BY_NORM: Record<string, { input: number; output: number }> = ( () => {
  const out: Record<string, { input: number; output: number }> = {}
  for( const [ key, price ] of Object.entries( MODEL_PRICING ) ){
    if( key === '__default__') continue
    out[ normalizeModelKey( key ) ] = price
  }
  return out
} )()

/** Resolve the pricing row for any model id (exact, normalized, then default). */
export function resolvePricing( model: string ): { input: number; output: number } {
  return PRICING_BY_NORM[ normalizeModelKey( model ) ]
      ?? MODEL_PRICING[ model ]
      ?? MODEL_PRICING['__default__']!
}

export interface TokenUsage {
  /** Model identifier (e.g., 'openai/gpt-4o') */
  model: string
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
  /** Estimated cost in USD */
  estimatedCostUsd: number

  // ── 5-axis cost attribution ──────────────────────────────
  /** Top-level cost bucket: 'executive' | 'summarizer' | 'embedding' | 'identity-guard' | … */
  category: string
  /** Actor/subsystem doing the work: 'master' | 'facet' | 'memory' | 'guard' | … */
  attribute: string
  /** Cognitive function: 'decision' | 'ideation' | 'conversation' | 'planning' | 'deliberation' | 'outreach' | 'consolidation' | 'recall' | 'index' | 'identity-coherence' | … */
  function: string
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
export type RecordUsageInput = Omit<TokenUsage, 'estimatedCostUsd' | 'label'> & { label?: string }

/** Compose a stable, readable label from the attribution axes. */
function composeLabel( m: { category: string; attribute: string; function: string; scope?: string } ): string {
  const base = `${m.category}/${m.attribute}/${m.function}`
  return m.scope ? `${base}#${m.scope}` : base
}

export interface TokenTrackerConfig {
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
    const pricing    = resolvePricing( usage.model )
    const cacheRead  = usage.cacheReadTokens  ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    const costUsd =
      ( usage.promptTokens     / 1_000_000 ) * pricing.input  +
      ( usage.completionTokens / 1_000_000 ) * pricing.output +
      ( cacheRead              / 1_000_000 ) * pricing.input * CACHE_READ_MULT  +
      ( cacheWrite             / 1_000_000 ) * pricing.input * CACHE_WRITE_MULT

    const full: TokenUsage = {
      ...usage,
      label:            usage.label ?? composeLabel( usage ),
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

    // Metrics
    commands.metrics!.push(
      [ 'llm.prompt_tokens_total',      this._totalPromptTokens ],
      [ 'llm.completion_tokens_total',  this._totalCompletionTokens ],
      [ 'llm.cost_total_usd',           this._totalCost ],
      [ 'llm.cost_this_tick_usd',       tickCost ],
      [ 'llm.cost_avg_per_tick_usd',    this._averageTickCost() ],
      [ 'llm.total_calls',              this._usageLog.length ],
    )

    // Per-axis cost + token breakdown — the transparency surface for
    // "how much goes into conversation vs executive vs embedding" (by category)
    // and "decision vs ideation vs conversation vs planning…" (by function).
    for( const [ cat, cost ] of this._categoryCosts ){
      commands.metrics!.push([ `llm.cost.${cat}`, cost ])
    }
    for( const [ cat, tok ] of this._categoryTokens ){
      commands.metrics!.push(
        [ `llm.prompt_tokens.${cat}`,     tok.prompt ],
        [ `llm.completion_tokens.${cat}`, tok.completion ],
      )
    }
    for( const [ fn, cost ] of this._functionCosts ){
      commands.metrics!.push([ `llm.cost.fn.${fn}`, cost ])
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
// ─────────────────────────────────────────────────────────────
// src/llm/index.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { Tick } from '#core/types'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { writeFileSync, mkdirSync } from 'node:fs'
import type { TokenTracker } from '#cognition/utilities/token.tracker'
import { type ModelRouter, isNullRouter } from '#llm/routing'
import { getCompletionRecorder, getCompletionSource } from '#core/completion.recorder'
import type { LLMCompletionRecord } from '#core/completion.recorder'
import { withGate } from '#llm/gate'
import { matchConversationFocus, wrapReplyText } from '#llm/wire.contracts'

export type LLMProvider = 'anthropic' | 'glm' | 'deepseek' | 'openai' | 'google'

/**
 * Providers that speak the Anthropic Messages wire.
 *
 * Z.ai ships a real Anthropic-compatible endpoint for GLM — it is what Claude
 * Code itself targets — so GLM rides this path rather than the OpenAI scaffold.
 * That buys it everything the path already has: token streaming, the first-byte
 * deadline, prompt-cache breakpoints, and the structured-output contract. GLM is
 * therefore a second *production* provider, not a fifth scaffold.
 */
const ANTHROPIC_WIRE = new Set<LLMProvider>( [ 'anthropic', 'glm' ] )

/** Does this provider accept Anthropic-shaped requests? */
export function speaksAnthropicWire( provider: LLMProvider ): boolean {
  return ANTHROPIC_WIRE.has( provider )
}

/** Official API base URL (including version segment) for a provider. */
export function defaultBaseFor( provider: LLMProvider ): string {
  switch( provider ){
    case 'anthropic': return 'https://api.anthropic.com/v1'
    // Z.ai documents the base as `…/api/anthropic` because the Anthropic SDK
    // appends `/v1/messages`; this client appends `/messages`, so the version
    // segment belongs here — verified against the live endpoint.
    case 'glm':       return 'https://api.z.ai/api/anthropic/v1'
    case 'openai':    return 'https://api.openai.com/v1'
    case 'deepseek':  return 'https://api.deepseek.com/v1'
    case 'google':    return 'https://generativelanguage.googleapis.com/v1beta'
  }
}

/**
 * The model the executive recruits when none is pinned.
 *
 * Provider-specific because the default is *sent* — a GLM Will with no
 * `WILL_LLM_MODEL` would otherwise ask Z.ai for a Claude id and get a 404 it
 * could do nothing with. The scaffolded providers (openai/deepseek/google) keep
 * today's value: they need an explicit `WILL_LLM_MODEL` to work at all, and
 * inventing ids for them here would look like support that does not exist.
 */
export function defaultModelFor( provider: LLMProvider ): string {
  return provider === 'glm' ? 'glm-5.2' : 'claude-sonnet-4-5-20250929'
}

/**
 * Auth + version headers for the Anthropic wire.
 *
 * Anthropic authenticates with `x-api-key`. Z.ai's compat endpoint accepts
 * either that or the `Authorization: Bearer` its own docs describe (both were
 * probed against the live endpoint; each is read and validated). GLM sends both
 * — same secret, same host — so the mind keeps working whichever one Z.ai
 * eventually settles on.
 */
export function anthropicWireHeaders( provider: LLMProvider, apiKey: string ): Record<string, string> {
  return {
    'Content-Type':      'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key':         apiKey,
    ...( provider === 'glm' ? { Authorization: `Bearer ${ apiKey }` } : {} ),
  }
}
export interface LLMDirectorConfig {
  willId: string
  model: string
  maxOutputTokens: number
  apiKey: string
  provider: LLMProvider
  sessionLogger: SessionLogger | null
  /** When true, all LLM calls return canned deterministic responses — no API cost. */
  mock?: boolean
  /**
   * Override the provider's API base URL (including the version segment, e.g.
   * `http://localhost:11434/v1` for Ollama). Defaults to the provider's
   * official endpoint. This is what lets `deepseek` actually reach DeepSeek
   * and lets `openai` point at any OpenAI-compatible server.
   */
  baseUrl?: string
  /**
   * Timeout in ms. On the Anthropic streaming path this is a *first-byte*
   * (time-to-first-token) deadline — a long-but-healthy completion is never
   * aborted mid-generation. Other providers treat it as a whole-request
   * deadline. Default 90s.
   */
  timeoutMs?: number
  /**
   * Per-Will token tracker (R4). When provided, completed live calls record
   * their usage/cost here. Omitted/null → recording is skipped (e.g. mock or
   * replay runs). This replaces the former process-global getTokenTracker().
   */
  tokenTracker?: TokenTracker | null
  /**
   * MODEL_ROUTING W3 — per-call model selection. Absent (or NULL_ROUTER) means
   * every call uses the default model below, exactly as before the seam existed.
   * A router that throws, or names a provider with no usable credential, falls
   * back to the default: a routing problem must never kill a running mind.
   */
  router?: ModelRouter | null
  /**
   * Per-provider credentials for routed calls. The top-level `apiKey`/`baseUrl`
   * remain the default entry; a route to a provider absent from this map falls
   * back to the default endpoint.
   */
  credentials?: Partial<Record<LLMProvider, { apiKey: string; baseUrl?: string }>>
}

/**
 * Everything a single call needs to reach a model. Resolved once per call and
 * threaded through the provider methods — never stored on the instance, because
 * the concurrency gate lets several calls be in flight on one director at once
 * and per-call state on `this` would race between them.
 */
export interface CallEndpoint {
  provider:        LLMProvider
  model:           string
  apiKey:          string
  baseUrl:         string | null
  maxOutputTokens: number
}

// ── LLM call result ──────────────────────────────────────────

export interface LLMCallResult {
  text: string
  inputTok: number
  outputTok: number
  /** Anthropic prompt-cache: tokens served from cache (~0.1× cost). Telemetry. */
  cacheReadTok?: number
  /** Anthropic prompt-cache: tokens written to cache this call (~1.25× cost). Telemetry. */
  cacheWriteTok?: number
}

/**
 * Cost-attribution metadata for a single LLM call. The same director instance is
 * shared by the master executive, every facet (conversation/planning/outreach),
 * the summarizer, and the ideation/propose pass — so the *call site* tags itself
 * here, letting the TokenTracker break spend down per category for transparency.
 */
export interface LLMCallMeta {
  /** Top-level cost bucket: 'executive' | 'summarizer' | 'embedding' | 'identity-guard' | … */
  category: string
  /** The actor/subsystem doing the work: 'master' | 'facet' | 'memory' | 'guard' | … */
  attribute: string
  /** The specific cognitive function: 'decision' | 'ideation' | 'conversation' | 'planning' | 'deliberation' | 'outreach' | 'consolidation' | 'recall' | 'index' | 'identity-coherence' | … */
  function: string
  /** Optional specific id or namespace: facet id, entity id, model name. */
  scope?: string
  /** Free-form human-readable label. Auto-composed from the axes when omitted. */
  label?: string
  /**
   * How much this call demands, 0..1 — MODEL_ROUTING W0.
   *
   * A *cognitive* measure, never a commercial one: it says how consequential or
   * uncertain this moment is, never who is paying for it. Two faculties already
   * compute it and simply forward what they have — the master and its facets
   * pass `effortScore` (the a-priori effort gate: uncertainty, prior
   * confidence, novelty, a pending reply, stress load), and deliberation passes
   * the agency stakes of the choice under consideration. Structurally
   * background work (summarising, guarding, embedding, delivery) reports a low
   * constant, because it is background whether the mind is calm or in crisis.
   *
   * Absent means UNKNOWN, not zero: a consumer must fall back to its default
   * rather than treat a missing value as "cheapest possible".
   *
   * This field is inert with respect to cognition. It rides along to whoever
   * resolves the model for a call; no engine may read it back and behave
   * differently, or the routing layer becomes a hidden input to the mind.
   */
  demand?: number
}

/** Structurally background work — see `LLMCallMeta.demand`. */
export const BACKGROUND_DEMAND = 0.1

/**
 * Escalation is elevated by construction: the buffer only fires once something
 * has already failed to resolve on its own.
 */
export const ESCALATION_DEMAND = 0.7

/** Default attribution when a caller does not tag itself (back-compat). */
const DEFAULT_CALL_META: LLMCallMeta = { category: 'executive', attribute: 'master', function: 'decision' }

export class LLMDirector {
  private _willId: string
  private _model: string
  private _maxOutputTokens: number
  private _apiKey: string
  private _provider: LLMProvider
  private _sessionLogger: SessionLogger | null
  private _mock: boolean
  private _baseUrl: string | null
  private _timeoutMs: number
  private _tokenTracker: TokenTracker | null
  private _router: ModelRouter | null
  private _credentials: Partial<Record<LLMProvider, { apiKey: string; baseUrl?: string }>>
  /** Default endpoint — what every call used before the routing seam existed. */
  private _defaultEndpoint: CallEndpoint
  /** Routes already warned about (missing credential / bad provider) — log once. */
  private _routeWarned = new Set<string>()

  constructor( config: LLMDirectorConfig ) {
    this._willId = config.willId
    this._model = config.model
    this._maxOutputTokens = config.maxOutputTokens
    this._apiKey = config.apiKey
    this._provider = config.provider
    this._sessionLogger = config.sessionLogger
    this._mock = config.mock ?? false
    this._baseUrl = config.baseUrl ?? null
    this._timeoutMs = config.timeoutMs ?? 90_000
    this._tokenTracker = config.tokenTracker ?? null
    this._router = config.router ?? null
    this._credentials = config.credentials ?? {}
    this._defaultEndpoint = {
      provider:        this._provider,
      model:           this._model,
      apiKey:          this._apiKey,
      baseUrl:         this._baseUrl,
      maxOutputTokens: this._maxOutputTokens,
    }
  }

  /**
   * Resolve which model serves this call. Falls back to the default endpoint
   * whenever the router has no opinion, throws, or names a provider we hold no
   * credential for — degrade, never crash.
   */
  private _resolveEndpoint( meta: LLMCallMeta ): CallEndpoint {
    if( isNullRouter( this._router ) ) return this._defaultEndpoint

    let route
    try { route = this._router!.route( meta ) }
    catch( err ){
      this._warnRouteOnce(`throw:${this._router!.name}`,
        `router "${this._router!.name}" threw — using the default model`, err )
      return this._defaultEndpoint
    }
    if( !route ) return this._defaultEndpoint

    // The default provider's credential is reused when the route names it;
    // otherwise the route needs its own entry.
    const cred = route.provider === this._defaultEndpoint.provider
      ? { apiKey: this._defaultEndpoint.apiKey, baseUrl: this._defaultEndpoint.baseUrl ?? undefined }
      : this._credentials[ route.provider ]

    if( !cred?.apiKey ){
      this._warnRouteOnce(`cred:${route.provider}`,
        `no credential for routed provider "${route.provider}" — using the default model` )
      return this._defaultEndpoint
    }

    return {
      provider:        route.provider,
      model:           route.model,
      apiKey:          cred.apiKey,
      baseUrl:         route.baseUrl ?? cred.baseUrl ?? null,
      maxOutputTokens: route.maxOutputTokens ?? this._defaultEndpoint.maxOutputTokens,
    }
  }

  private _warnRouteOnce( key: string, message: string, err?: unknown ): void {
    if( this._routeWarned.has( key ) ) return
    this._routeWarned.add( key )
    logger.warn(`[llm.routing] ${message}`, err instanceof Error ? err.message : '')
  }

  // ── Mock response (test mode) ────────────────────────────

  /**
   * Returns a structurally valid executive output with zero API cost.
   * Used when `mock: true` — e.g. for `bw_test_` key holders and the Playground.
   *
   * The response rotates through a small set of cognitively distinct actions so
   * the Will's state panel shows believable variety across ticks.
   */
  /**
   * Returns a deterministic mock LLM response parseable by the executive engine.
   *
   * Format for a conversation-facet turn (AuditionEngine): the facet focus renders
   *   Speaker: <name> (id: <entityId>)
   *   Current message: "<content>"
   * and CONVERSATION_OUTPUT_FORMAT expects a JSON reasoning object followed by a
   * [REPLY_TEXT] block — the block is the only part that reaches the speaker
   * (streamed live, then landed in the outbox by the facet decision).
   *
   * Format for background ticks (no conversation focus):
   *   {"actions":[{"type":"...","reasoning":"...","expectedOutcome":"..."}],...}
   *   Strategy 1 (JSON.parse) handles this directly.
   */
  private _mockResponse( tick: number, userMessage: string = ''): LLMCallResult {
    // ── Conversation facet turn ────────────────────────────────
    // Detect the AuditionEngine facet focus via the SHARED contract (see
    // llm/wire.contracts.ts) — the render/match pair whose earlier drift
    // silently broke every test-mode conversation.
    const turn = matchConversationFocus( userMessage )

    if( turn ){
      const content = turn.content

      const REPLY_CYCLES = [
        `Hi! You said: "${content.length > 50 ? content.slice( 0, 50 ) + '…' : content}" — I heard you, and I'm listening.`,
        `That's something worth thinking about. Tell me more about what's on your mind.`,
        `I'm here, and I find myself genuinely curious about what you mean by that.`,
        `I want to engage with what you're saying honestly — say more.`,
      ]

      const reply = REPLY_CYCLES[ tick % REPLY_CYCLES.length ]!

      const text = [
        '```json',
        JSON.stringify({
          actions:    [],
          reasoning:  'Someone is speaking with me. I want to respond genuinely from who I am.',
          confidence: 0.85,
        }),
        '```',
        '',
        wrapReplyText( reply ),
      ].join('\n')

      return { text, inputTok: 0, outputTok: 0 }
    }

    // ── Background tick — no pending conversation ─────────────
    // Output valid JSON so Strategy 1 (JSON.parse) succeeds directly.
    const BG_CYCLES = [
      { type: 'observe',        reasoning: 'Taking stock of my environment — everything seems calm.',       outcome: 'Better situational awareness'    },
      { type: 'reflect',        reasoning: 'Exploring my sense of purpose and what matters to me.',         outcome: 'Deeper self-understanding'        },
      { type: 'learn',          reasoning: 'Integrating what I have perceived and experienced recently.',    outcome: 'Richer context model'             },
      { type: 'express_emotion',reasoning: 'Acknowledging a feeling of openness and curiosity.',            outcome: 'Emotional authenticity'           },
    ]

    const bg     = BG_CYCLES[ tick % BG_CYCLES.length ]!
    const text   = JSON.stringify({
      actions:    [ { type: bg.type, reasoning: bg.reasoning, expectedOutcome: bg.outcome } ],
      reasoning:  `Background cycle ${tick % BG_CYCLES.length + 1}. ${bg.reasoning}`,
      confidence: 0.7,
    })

    return { text, inputTok: 0, outputTok: 0 }
  }

  // ── Chunk streaming ─────────────────────────────────────────

  /**
   * Stream tokens from the LLM. Calls `onChunk` for each text delta as it
   * arrives, then returns the full result once the stream is done.
   * Currently Anthropic only — other providers fall back to a single-chunk call.
   */
  async callStream(
    systemPrompt: string,
    userMessage:  string,
    tick:         number,
    onChunk:      ( chunk: string ) => void,
    /** Optional sampling temperature. Omitted ⇒ the provider's default. */
    temperature?: number,
    /** Cost-attribution tag for this call. Defaults to the master executive. */
    meta:         LLMCallMeta = DEFAULT_CALL_META,
  ): Promise<LLMCallResult> {
    const start = Date.now()

    // Replay re-feed takes precedence over both live and mock paths (R2-c).
    const replay = this._replayCompletion( systemPrompt, userMessage, tick )
    if( replay ){
      // Mirror the original run's streaming: the live (non-mock) path streamed
      // raw text via onChunk, while the mock path intentionally did not.
      if( !replay.mock ) onChunk( replay.text )
      return { text: replay.text, inputTok: replay.inputTok, outputTok: replay.outputTok }
    }

    // MODEL_ROUTING W3 — resolve once, then thread it: several calls can be in
    // flight on this director at once, so the endpoint must travel with the call
    // rather than live on `this`. Resolved before the mock branch so a mock run
    // records the endpoint that WOULD have served the call — the tape then says
    // the same thing in mock and live runs.
    const ep = this._resolveEndpoint( meta )

    if( this._mock ){
      const result = this._mockResponse( tick, userMessage )
      // In mock mode we don't stream raw internal text — the response will be
      // emitted from the outbox content by the SSE layer.  onChunk is intentionally
      // not called here so no internal [REPLY] / JSON format leaks to the client.
      this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - start, true, ep )
      return result
    }

    const result = speaksAnthropicWire( ep.provider )
      ? await this._callAnthropicStream( ep, systemPrompt, userMessage, onChunk, temperature )
      : await ( async () => {
          // Other providers: fall back to regular call, emit whole response as one chunk
          const r = await this._callProvider( ep, systemPrompt, userMessage, temperature )
          onChunk( r.text )
          return r
        } )()

    // Token tracking lives here too: streamed calls (conversation facets, the
    // master when broadcasting) previously bypassed the tracker entirely, so all
    // streamed spend was invisible. Record it with the caller's attribution.
    this._track( result, meta, tick, Date.now() - start, this._estPromptTokens( systemPrompt, userMessage ), ep )
    this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - start, false, ep )
    return result
  }

  /**
   * Record a completed live call's token usage + cost into this Will's tracker,
   * tagged with the caller's attribution (category/label). Optional — absent on
   * mock/replay directors, so the call is simply skipped. Cache read/write tokens
   * are forwarded so the tracker prices them at 0.1× / 1.25× input.
   */
  private _track( result: LLMCallResult, meta: LLMCallMeta, tick: Tick, latencyMs: number, estPromptTokens?: number, ep: CallEndpoint = this._defaultEndpoint ): void {
    this._tokenTracker?.recordUsage({
      // The model that actually served this call — routed or default. Pricing
      // must follow the real model, or routed spend is attributed wrongly.
      model:            ep.model,
      promptTokens:     result.inputTok,
      completionTokens: result.outputTok,
      totalTokens:      result.inputTok + result.outputTok,
      cacheReadTokens:  result.cacheReadTok,
      cacheWriteTokens: result.cacheWriteTok,
      category:         meta.category,
      attribute:        meta.attribute,
      function:         meta.function,
      scope:            meta.scope,
      label:            meta.label,
      estPromptTokens,
      tick,
      latencyMs,
    })
  }

  /** Pre-cache prompt size estimate (chars/4) — mirrors the old token-report `ourEstTok`. */
  private _estPromptTokens( systemPrompt: string, userMessage: string ): number {
    return Math.round( ( systemPrompt.length + userMessage.length ) / 4 )
  }

  /**
   * Capture an LLM completion into the active replay recorder for this Will,
   * when one is registered (see core/completion.recorder). No-op otherwise.
   * The LLM is the non-deterministic oracle; recording its input+output is the
   * prerequisite for deterministic re-execution (REORIENT R2, deferred).
   */
  private _recordCompletion(
    systemPrompt: string,
    userMessage:  string,
    tick:         number,
    result:       LLMCallResult,
    latencyMs:    number,
    mock:         boolean,
    ep:           CallEndpoint = this._defaultEndpoint,
  ): void {
    try {
      getCompletionRecorder( this._willId )?.recordCompletion({
        tick,
        willId:          this._willId,
        // Record the endpoint that actually served the call: the tape is what
        // replay re-feeds, so it must say which model produced this text.
        provider:        ep.provider,
        model:           ep.model,
        maxOutputTokens: ep.maxOutputTokens,
        systemPrompt,
        userMessage,
        text:            result.text,
        inputTok:        result.inputTok,
        outputTok:       result.outputTok,
        mock,
        latencyMs,
        timestamp:       Date.now(),
      })
    }
    catch { /* recorder is optional — never let recording break a completion */ }
  }

  /**
   * Replay re-feed (REORIENT R2-c). When a completion source is registered for
   * this Will, return the recorded completion for `tick` instead of calling the
   * non-deterministic model. The source verifies the prompt and throws on a miss
   * or divergence, so a replay can never silently re-call the LLM. Returns
   * `undefined` when no source is registered (the normal live path).
   */
  private _replayCompletion(
    systemPrompt: string,
    userMessage:  string,
    tick:         number,
  ): LLMCompletionRecord | undefined {
    return getCompletionSource( this._willId )?.nextCompletion( tick, systemPrompt, userMessage )
  }

  private async _callAnthropicStream(
    ep:           CallEndpoint,
    systemPrompt: string,
    userMessage:  string,
    onChunk:      ( chunk: string ) => void,
    temperature?: number,
  ): Promise<LLMCallResult> {
    // First-byte deadline only: a hard timeout on the whole stream would
    // truncate a healthy but long generation, so the timer is cleared once
    // the response headers arrive.
    const controller = new AbortController()
    const timer = setTimeout( () => controller.abort(), this._timeoutMs )

    let res: Response
    try {
      res = await fetch(`${this._resolvedBase( ep )}/messages`, {
        method: 'POST',
        headers: anthropicWireHeaders( ep.provider, ep.apiKey ),
        body: JSON.stringify({
          model:      ep.model,
          max_tokens: ep.maxOutputTokens,
          ...( temperature !== undefined ? { temperature } : {} ),
          stream:     true,
          system:     this._systemField( systemPrompt ),
          messages:   [{ role: 'user', content: userMessage }],
        }),
        signal: controller.signal,
      })
    }
    catch( err ){
      clearTimeout( timer )
      if( controller.signal.aborted )
        throw new Error(`LLM stream to ${ep.provider} timed out after ${this._timeoutMs}ms (no response)`)
      throw err
    }

    clearTimeout( timer )

    if( !res.ok )
      throw new Error(`Anthropic stream ${res.status}: ${( await res.text() ).slice(0, 300)}`)

    const reader  = res.body!.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ''
    let   fullText    = ''
    let   inputTok    = 0
    let   outputTok   = 0
    let   cacheReadTok  = 0
    let   cacheWriteTok = 0

    try {
      while( true ){
        const { done, value } = await reader.read()
        if( done ) break
        buffer += decoder.decode( value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''   // last (possibly incomplete) line stays in buffer

        for( const line of lines ){
          if( !line.startsWith('data: ') ) continue
          const raw = line.slice(6).trim()
          if( raw === '[DONE]') break

          try {
            const ev = JSON.parse( raw ) as {
              type: string
              delta?: { type: string; text?: string; stop_reason?: string }
              message?: { usage?: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
              usage?:   { output_tokens: number }
            }

            if( ev.type === 'message_start' && ev.message?.usage ){
              inputTok      = ev.message.usage.input_tokens
              cacheReadTok  = ev.message.usage.cache_read_input_tokens     ?? 0
              cacheWriteTok = ev.message.usage.cache_creation_input_tokens ?? 0
            }
            else if( ev.type === 'content_block_delta' && ev.delta?.text ){
              fullText += ev.delta.text
              onChunk( ev.delta.text )
            }
            else if( ev.type === 'message_delta' && ev.usage?.output_tokens ){
              outputTok = ev.usage.output_tokens
            }
          }
          catch { /* ignore malformed events */ }
        }
      }
    }
    finally {
      reader.releaseLock()
    }

    return { text: fullText, inputTok, outputTok, cacheReadTok, cacheWriteTok }
  }

  /**
   * Call the LLM directly via fetch — no SDK, no middleware.
   * Routes through withGate for concurrency limiting and 429 retry.
   */
  async call(
    systemPrompt: string,
    userMessage: string,
    tick: Tick,
    /** Optional sampling temperature. Omitted ⇒ the provider's default (behaviour
     *  unchanged). Used by the deliberate path's ideation (propose) pass to diverge. */
    temperature?: number,
    /** Cost-attribution tag for this call. Defaults to the master executive. */
    meta: LLMCallMeta = DEFAULT_CALL_META,
  ): Promise<LLMCallResult> {
    const llmStart = Date.now()

    // Replay re-feed takes precedence over both live and mock paths (R2-c).
    const replay = this._replayCompletion( systemPrompt, userMessage, tick )
    if( replay )
      return { text: replay.text, inputTok: replay.inputTok, outputTok: replay.outputTok }

    const ep = this._resolveEndpoint( meta )

    if( this._mock ){
      const result = this._mockResponse( tick, userMessage )
      this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - llmStart, true, ep )
      return result
    }

    // The Anthropic-wire providers route through the streaming path so the
    // deadline is first-byte (TTFT), not whole-request: a long-but-healthy
    // executive completion (often 20–40s on Sonnet) no longer trips the timeout
    // mid-generation. onChunk is a no-op here — call() returns the full
    // accumulated text; live token chunks go through callStream(). Other
    // providers keep the whole-request deadline.
    const result = await withGate(
      () => speaksAnthropicWire( ep.provider )
        ? this._callAnthropicStream( ep, systemPrompt, userMessage, () => {}, temperature )
        : this._callProvider( ep, systemPrompt, userMessage, temperature ),
      'executive/direct',
    )

    // Record token usage + cost into this Will's injected tracker (R4), tagged
    // with the caller's attribution. Optional — absent on mock/replay directors.
    this._track( result, meta, tick, Date.now() - llmStart, this._estPromptTokens( systemPrompt, userMessage ), ep )

    this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - llmStart, false, ep )
    return result
  }

  private _callProvider(
    ep: CallEndpoint,
    systemPrompt: string,
    userMessage: string,
    temperature?: number,
  ): Promise<LLMCallResult> {
    switch( ep.provider ){
      case 'anthropic': return this._callAnthropic( ep, systemPrompt, userMessage, temperature )
      case 'glm': return this._callAnthropic( ep, systemPrompt, userMessage, temperature )
      case 'deepseek': return this._callOpenAI( ep, systemPrompt, userMessage, temperature )
      case 'openai': return this._callOpenAI( ep, systemPrompt, userMessage, temperature )
      case 'google': return this._callGoogle( ep, systemPrompt, userMessage, temperature )
      default: throw new Error(`Unknown LLM provider: ${ep.provider}`)
    }
  }

  /** Default API base URL (including version segment) for a provider. */
  private _baseFor( provider: LLMProvider ): string {
    return defaultBaseFor( provider )
  }

  /** Resolved API base: explicit override wins, else the provider default. */
  private _resolvedBase( ep: CallEndpoint ): string {
    return ep.baseUrl ?? this._baseFor( ep.provider )
  }

  /**
   * fetch() with a hard per-request deadline. A hung connection is aborted
   * after _timeoutMs and surfaced as a clear error instead of hanging forever.
   * Mirrors the embedder hardening in vector.embedder.ts.
   */
  private async _fetchWithTimeout( url: string, init: RequestInit ): Promise<Response> {
    try {
      return await fetch( url, { ...init, signal: AbortSignal.timeout( this._timeoutMs ) } )
    }
    catch( err ){
      // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
      if( err instanceof Error && err.name === 'TimeoutError')
        throw new Error(`LLM request to ${this._provider} timed out after ${this._timeoutMs}ms`)
      throw err
    }
  }

  /**
   * Anthropic `system` field with a single prompt-cache breakpoint. The system
   * prompt is fully stable per context (PromptFactory keeps every volatile section
   * — including `## Current Focus` — in the user message), so one ephemeral
   * breakpoint caches the whole thing: reused across master ticks and shared
   * across a Will's conversation facets. GA — no beta header required.
   */
  private _systemField( systemPrompt: string ): Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }> {
    return [ { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } } ]
  }

  private async _callAnthropic( ep: CallEndpoint, systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    const body = {
      model: ep.model,
      max_tokens: ep.maxOutputTokens,
      ...( temperature !== undefined ? { temperature } : {} ),
      system: this._systemField( systemPrompt ),
      messages: [{ role: 'user', content: userMessage }]
    }

    const res = await this._fetchWithTimeout(`${this._resolvedBase( ep )}/messages`, {
      method: 'POST',
      headers: anthropicWireHeaders( ep.provider, ep.apiKey ),
      body: JSON.stringify( body )
    })

    if( !res.ok )
      throw new Error(`${ep.provider} API ${res.status}: ${( await res.text() ).slice(0, 300)}`)

    const
    data = await res.json() as {
      content: Array<{ type: string; text: string }>
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    },
    text = data.content.find( b => b.type === 'text')?.text ?? ''

    return {
      text,
      inputTok:      data.usage.input_tokens,
      outputTok:     data.usage.output_tokens,
      cacheReadTok:  data.usage.cache_read_input_tokens     ?? 0,
      cacheWriteTok: data.usage.cache_creation_input_tokens ?? 0,
    }
  }

  private async _callOpenAI( ep: CallEndpoint, systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    const body = {
      model: ep.model,
      max_completion_tokens: ep.maxOutputTokens,
      ...( temperature !== undefined ? { temperature } : {} ),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    }

    const res = await this._fetchWithTimeout(`${this._resolvedBase( ep )}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if( !res.ok )
      throw new Error(`OpenAI API ${res.status}: ${( await res.text() ).slice(0, 300)}`)

    const
    data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    },
    text = data.choices[0]?.message?.content ?? ''

    return {
      text,
      inputTok: data.usage.prompt_tokens,
      outputTok: data.usage.completion_tokens
    }
  }

  private async _callGoogle( ep: CallEndpoint, systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    // Gemini carries the system prompt in a dedicated `systemInstruction`
    // field and the conversation in `contents`.
    const body = {
      systemInstruction: { parts: [ { text: systemPrompt } ] },
      contents:          [ { role: 'user', parts: [ { text: userMessage } ] } ],
      generationConfig:  {
        maxOutputTokens: ep.maxOutputTokens,
        ...( temperature !== undefined ? { temperature } : {} ),
      },
    }

    const res = await this._fetchWithTimeout(
      `${this._resolvedBase( ep )}/models/${ep.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': ep.apiKey,
        },
        body: JSON.stringify( body ),
      }
    )

    if( !res.ok )
      throw new Error(`Google API ${res.status}: ${( await res.text() ).slice(0, 300)}`)

    const data = await res.json() as {
      candidates?:   Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }

    const text = ( data.candidates?.[ 0 ]?.content?.parts ?? [] )
      .map( p => p.text ?? '')
      .join('')

    return {
      text,
      inputTok:  data.usageMetadata?.promptTokenCount     ?? 0,
      outputTok: data.usageMetadata?.candidatesTokenCount ?? 0,
    }
  }

  /**
   * Write the full prompt to a debug file for inspection.
   * Mirrors the original _writeDebugPrompt behavior.
   */
  writeDebugPrompt(
    tick: Tick,
    systemPrompt: string,
    userMessage: string,
  ): string {
    try {
      const debugDir = `./data/wills/${this._willId}/debug`
      mkdirSync( debugDir, { recursive: true })

      const totalChars = systemPrompt.length + userMessage.length
      const estimatedTokens = Math.round( totalChars / 4 )

      const content = [
        '='.repeat(80),
        `EXECUTIVE CALL — Tick ${tick}`,
        '='.repeat(80),
        `OUR BUILD: sys=${systemPrompt.length} chars  user=${userMessage.length} chars  total=~${estimatedTokens} tok`,
        `PROVIDER:  ${this._provider} (direct fetch — no SDK middleware)`,
        `MODEL:     ${this._model}`,
        '='.repeat(80),
        '',
        `=== SYSTEM PROMPT (${systemPrompt.length} chars) ===`,
        systemPrompt,
        '',
        `=== USER MESSAGE (${userMessage.length} chars) ===`,
        userMessage,
      ].join('\n')

      const filepath = `${debugDir}/prompt-tick-${String( tick ).padStart( 6, '0')}.txt`
      writeFileSync( filepath, content )

      logger.info(`[executive] Debug prompt written → ${filepath} (~${estimatedTokens} tok estimated)`)

      return filepath
    }
    catch( err ){
      logger.warn(`[executive] Failed to write debug prompt: ${err}`)
      return ''
    }
  }

  /**
   * Write the full LLM response text to `response-tick-N.txt` alongside the
   * corresponding `prompt-tick-N.txt`. This gives developers the complete
   * reasoning trace without truncation — useful for debugging planning failures.
   */
  writeDebugResponse(
    tick: Tick,
    responseText: string,
    inputTok: number,
    outputTok: number,
    latencyMs: number,
  ): void {
    try {
      const debugDir = `./data/wills/${this._willId}/debug`
      mkdirSync( debugDir, { recursive: true })

      const content = [
        '='.repeat(80),
        `EXECUTIVE RESPONSE — Tick ${tick}`,
        '='.repeat(80),
        `TOKENS:   in=${inputTok}  out=${outputTok}  latency=${latencyMs}ms`,
        `LENGTH:   ${responseText.length} chars`,
        '='.repeat(80),
        '',
        responseText,
      ].join('\n')

      const filepath = `${debugDir}/response-tick-${String( tick ).padStart( 6, '0')}.txt`
      writeFileSync( filepath, content )
    }
    catch {
      /* non-critical */
    }
  }

}
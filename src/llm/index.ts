// ─────────────────────────────────────────────────────────────
// src/llm/index.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { Tick } from '#core/types'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { writeFileSync, mkdirSync } from 'node:fs'
import type { TokenTracker } from '#cognition/utilities/token.tracker'
import { getCompletionRecorder, getCompletionSource } from '#core/completion.recorder'
import type { LLMCompletionRecord } from '#core/completion.recorder'
import { withGate } from '#llm/gate'

export type LLMProvider = 'anthropic' | 'deepseek' | 'openai' | 'google'
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
}

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
  private _mockResponse( tick: number, userMessage: string = '' ): LLMCallResult {
    // ── Conversation facet turn ────────────────────────────────
    // Detect the AuditionEngine facet focus (see audition.engine _buildFocus).
    const speakerMatch = userMessage.match( /Speaker: .+? \(id: .+?\)/ )
    const messageMatch = userMessage.match( /Current message: "([\s\S]+?)"/ )

    if( speakerMatch && messageMatch ){
      const content = messageMatch[1]!

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
        '[REPLY_TEXT]',
        reply,
        '[/REPLY_TEXT]',
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

    if( this._mock ){
      const result = this._mockResponse( tick, userMessage )
      // In mock mode we don't stream raw internal text — the response will be
      // emitted from the outbox content by the SSE layer.  onChunk is intentionally
      // not called here so no internal [REPLY] / JSON format leaks to the client.
      this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - start, true )
      return result
    }

    const result = this._provider === 'anthropic'
      ? await this._callAnthropicStream( systemPrompt, userMessage, onChunk, temperature )
      : await ( async () => {
          // Other providers: fall back to regular call, emit whole response as one chunk
          const r = await this._callProvider( systemPrompt, userMessage, temperature )
          onChunk( r.text )
          return r
        } )()

    // Token tracking lives here too: streamed calls (conversation facets, the
    // master when broadcasting) previously bypassed the tracker entirely, so all
    // streamed spend was invisible. Record it with the caller's attribution.
    this._track( result, meta, tick, Date.now() - start, this._estPromptTokens( systemPrompt, userMessage ) )
    this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - start, false )
    return result
  }

  /**
   * Record a completed live call's token usage + cost into this Will's tracker,
   * tagged with the caller's attribution (category/label). Optional — absent on
   * mock/replay directors, so the call is simply skipped. Cache read/write tokens
   * are forwarded so the tracker prices them at 0.1× / 1.25× input.
   */
  private _track( result: LLMCallResult, meta: LLMCallMeta, tick: Tick, latencyMs: number, estPromptTokens?: number ): void {
    this._tokenTracker?.recordUsage({
      model:            this._model,
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
  ): void {
    try {
      getCompletionRecorder( this._willId )?.recordCompletion({
        tick,
        willId:          this._willId,
        provider:        this._provider,
        model:           this._model,
        maxOutputTokens: this._maxOutputTokens,
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
      res = await fetch(`${this._resolvedBase()}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this._apiKey,
        },
        body: JSON.stringify({
          model:      this._model,
          max_tokens: this._maxOutputTokens,
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
        throw new Error( `LLM stream to ${this._provider} timed out after ${this._timeoutMs}ms (no response)` )
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
          if( raw === '[DONE]' ) break

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

    if( this._mock ){
      const result = this._mockResponse( tick, userMessage )
      this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - llmStart, true )
      return result
    }

    // Anthropic routes through the streaming path so the deadline is first-byte
    // (TTFT), not whole-request: a long-but-healthy executive completion (often
    // 20–40s on Sonnet) no longer trips the timeout mid-generation. onChunk is a
    // no-op here — call() returns the full accumulated text; live token chunks go
    // through callStream(). Other providers keep the whole-request deadline.
    const result = await withGate(
      () => this._provider === 'anthropic'
        ? this._callAnthropicStream( systemPrompt, userMessage, () => {}, temperature )
        : this._callProvider( systemPrompt, userMessage, temperature ),
      'executive/direct',
    )

    // Record token usage + cost into this Will's injected tracker (R4), tagged
    // with the caller's attribution. Optional — absent on mock/replay directors.
    this._track( result, meta, tick, Date.now() - llmStart, this._estPromptTokens( systemPrompt, userMessage ) )

    this._recordCompletion( systemPrompt, userMessage, tick, result, Date.now() - llmStart, false )
    return result
  }

  private _callProvider(
    systemPrompt: string,
    userMessage: string,
    temperature?: number,
  ): Promise<LLMCallResult> {
    switch( this._provider ){
      case 'anthropic': return this._callAnthropic( systemPrompt, userMessage, temperature )
      case 'deepseek': return this._callOpenAI( systemPrompt, userMessage, temperature )
      case 'openai': return this._callOpenAI( systemPrompt, userMessage, temperature )
      case 'google': return this._callGoogle( systemPrompt, userMessage, temperature )
      default: throw new Error(`Unknown LLM provider: ${this._provider}`)
    }
  }

  /** Default API base URL (including version segment) for a provider. */
  private _baseFor( provider: LLMProvider ): string {
    switch( provider ){
      case 'anthropic': return 'https://api.anthropic.com/v1'
      case 'openai':    return 'https://api.openai.com/v1'
      case 'deepseek':  return 'https://api.deepseek.com/v1'
      case 'google':    return 'https://generativelanguage.googleapis.com/v1beta'
    }
  }

  /** Resolved API base: explicit override wins, else the provider default. */
  private _resolvedBase(): string {
    return this._baseUrl ?? this._baseFor( this._provider )
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
      if( err instanceof Error && err.name === 'TimeoutError' )
        throw new Error( `LLM request to ${this._provider} timed out after ${this._timeoutMs}ms` )
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

  private async _callAnthropic( systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    const body = {
      model: this._model,
      max_tokens: this._maxOutputTokens,
      ...( temperature !== undefined ? { temperature } : {} ),
      system: this._systemField( systemPrompt ),
      messages: [{ role: 'user', content: userMessage }]
    }

    const res = await this._fetchWithTimeout(`${this._resolvedBase()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': this._apiKey
      },
      body: JSON.stringify( body )
    })

    if( !res.ok )
      throw new Error(`Anthropic API ${res.status}: ${( await res.text() ).slice(0, 300)}`)

    const
    data = await res.json() as {
      content: Array<{ type: string; text: string }>
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    },
    text = data.content.find( b => b.type === 'text' )?.text ?? ''

    return {
      text,
      inputTok:      data.usage.input_tokens,
      outputTok:     data.usage.output_tokens,
      cacheReadTok:  data.usage.cache_read_input_tokens     ?? 0,
      cacheWriteTok: data.usage.cache_creation_input_tokens ?? 0,
    }
  }

  private async _callOpenAI( systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    const body = {
      model: this._model,
      max_completion_tokens: this._maxOutputTokens,
      ...( temperature !== undefined ? { temperature } : {} ),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    }

    const res = await this._fetchWithTimeout(`${this._resolvedBase()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
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

  private async _callGoogle( systemPrompt: string, userMessage: string, temperature?: number ): Promise<LLMCallResult> {
    // Gemini carries the system prompt in a dedicated `systemInstruction`
    // field and the conversation in `contents`.
    const body = {
      systemInstruction: { parts: [ { text: systemPrompt } ] },
      contents:          [ { role: 'user', parts: [ { text: userMessage } ] } ],
      generationConfig:  {
        maxOutputTokens: this._maxOutputTokens,
        ...( temperature !== undefined ? { temperature } : {} ),
      },
    }

    const res = await this._fetchWithTimeout(
      `${this._resolvedBase()}/models/${this._model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': this._apiKey,
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
      .map( p => p.text ?? '' )
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

      const filepath = `${debugDir}/prompt-tick-${String( tick ).padStart( 6, '0' )}.txt`
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

      const filepath = `${debugDir}/response-tick-${String( tick ).padStart( 6, '0' )}.txt`
      writeFileSync( filepath, content )
    }
    catch {
      /* non-critical */
    }
  }

}
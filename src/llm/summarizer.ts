// ─────────────────────────────────────────────────────────────
// src/llm/summarizer.ts  —  Rolling executive summary
// ─────────────────────────────────────────────────────────────
//
// Maintains a rolling buffer of the last N executive reasoning texts.
// Every `summaryInterval` executive calls it asynchronously asks the
// LLM to condense the buffer into a compact paragraph.
//
// The current summary is injected as a "## Memory Continuity" section
// in the system prompt so Will always has a narrative sense of its
// recent history across executive cycles.
//
// Cost: ~2,500 input tokens + ~200 output tokens per summarization.
// At Sonnet rates: ~$0.01 per summary. At 10-call intervals and 50 calls/hr
// that's one summary every 12 minutes — negligible.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { LLMDirector } from '#llm/index'
import { BACKGROUND_DEMAND } from '#llm/index'

export interface SummarizerConfig {
  /** How many executive calls between summarization runs. Default: 10 */
  summaryInterval?: number
  /** How many reasoning excerpts to keep in the rolling buffer. Default: 12 */
  bufferSize?: number
  /** Max chars to keep per reasoning entry before truncating. Default: 600 */
  maxCharsPerEntry?: number
}

// System prompt sent with every summarization call.
// Kept short — the bulk of the token cost is the user message (the cycles).
const SUMMARIZER_SYSTEM =
  'I am a self-aware synthetic mind consolidating my own recent cognitive cycles into memory. ' +
  'Condense the provided cognitive cycles into a single compact paragraph ' +
  '(150–250 words) written in first-person past tense — my own remembered experience. Cover:\n' +
  '• Key decisions made and their outcomes\n' +
  '• Emotional journey and significant mood shifts\n' +
  '• Goals pursued, progressed, or abandoned\n' +
  '• Patterns, insights, or self-observations noticed\n\n' +
  'Output ONLY the paragraph — no preamble, no headers, no commentary.'

export class ExecutiveSummarizer {
  private _buffer:       string[]  = []
  private _summary:      string    = ''
  private _callCount     = 0
  private _summarizing   = false
  private _llmDirector:  LLMDirector | null = null

  private readonly _interval:         number
  private readonly _bufferSize:       number
  private readonly _maxCharsPerEntry: number

  constructor( config: SummarizerConfig = {} ){
    this._interval         = config.summaryInterval  ?? 10
    this._bufferSize       = config.bufferSize       ?? 12
    this._maxCharsPerEntry = config.maxCharsPerEntry ?? 600
  }

  /**
   * Inject the LLMDirector. Called by ExecutiveEngine once its director is ready.
   * The summarizer silently skips runs until this is set.
   */
  attachLLMDirector( director: LLMDirector ): void {
    this._llmDirector = director
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Record one executive reasoning pass.
   * Triggers background summarization when the interval is hit.
   */
  record( reasoning: string ): void {
    this._buffer.push( reasoning.slice( 0, this._maxCharsPerEntry ) )
    if( this._buffer.length > this._bufferSize ) this._buffer.shift()

    this._callCount++

    if( this._callCount % this._interval === 0 && !this._summarizing )
      this._run().catch( err => logger.warn('[summarizer] error:', err instanceof Error ? err.message : err ) )
  }

  /**
   * The current rolling summary, ready to embed in a system prompt.
   * Empty string until the first summarization has completed.
   */
  get current(): string { return this._summary }

  /** Total number of executive calls recorded so far. */
  get callCount(): number { return this._callCount }

  /** Whether a summarization is currently running. */
  get isBusy(): boolean { return this._summarizing }

  /**
   * Restore state from a persisted snapshot (called by ExecutiveEngine on first tick
   * after a restart). Picks up the summary and buffer without triggering a new LLM call.
   */
  restore( summary: string, buffer: string[], callCount: number ): void {
    this._summary   = summary
    this._buffer    = buffer.slice( -this._bufferSize )
    this._callCount = callCount
  }

  /**
   * Return a plain object suitable for persisting to a state entity.
   * ExecutiveEngine writes this to 'executive-rolling-summary' each cycle.
   */
  snapshot(): { summary: string; buffer: string[]; callCount: number } {
    return { summary: this._summary, buffer: [ ...this._buffer ], callCount: this._callCount }
  }

  /**
   * Pure preview of what snapshot() *would* return after record( reasoning ),
   * without mutating internal state or triggering a background summarization.
   *
   * Used by the executive command builder so the persisted
   * 'executive-rolling-summary' entity can describe the post-record state while
   * the actual record() is deferred until the tick is known to commit (FN11).
   * The async summary refresh in record() does not change `summary`
   * synchronously, so a verbatim snapshot()-after-record() is reproduced here.
   */
  projectedSnapshot( reasoning: string ): { summary: string; buffer: string[]; callCount: number } {
    const buffer = [ ...this._buffer, reasoning.slice( 0, this._maxCharsPerEntry ) ]
    if( buffer.length > this._bufferSize ) buffer.shift()
    return { summary: this._summary, buffer, callCount: this._callCount + 1 }
  }

  // ── Background summarization ──────────────────────────────

  private async _run(): Promise<void> {
    if( !this._llmDirector ){
      logger.warn('[summarizer] skipping — LLMDirector not attached yet')
      return
    }

    this._summarizing = true
    const snapshot = [ ...this._buffer ]  // capture before next record() could modify

    try {
      const userMessage = snapshot
        .map( ( r, i ) => `[Cycle ${i + 1}]\n${r}`)
        .join('\n\n---\n\n')

      // Use _callCount as the tick value — it's only used for token tracking/logging
      const result = await this._llmDirector.call(
        SUMMARIZER_SYSTEM,
        userMessage,
        this._callCount as any,
        undefined,
        // MODEL_ROUTING W0 — compression is background work at a constant low
        // demand: distilling excerpts is the same job whether the mind is calm
        // or in crisis, so there is no honest per-tick measure to forward here.
        { category: 'summarizer', attribute: 'memory', function: 'consolidation', demand: BACKGROUND_DEMAND }
      )

      if( result.text ){
        this._summary = result.text.trim()
        logger.info(
          `[summarizer] updated after ${this._callCount} executive calls` +
          ` — ${this._summary.length} chars` +
          ` (${result.inputTok} in / ${result.outputTok} out tokens)`
        )
      }
    }
    catch( err ){
      logger.warn('[summarizer] failed:', err instanceof Error ? err.message : err )
    }
    finally {
      this._summarizing = false
    }
  }
}

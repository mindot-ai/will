// ─────────────────────────────────────────────────────────────
// src/core/completion.recorder.ts
// ─────────────────────────────────────────────────────────────

/**
 * LLM completion record/replay seam.
 *
 * The LLM is an external, non-deterministic oracle: to re-run a session
 * deterministically (REORIENT R2) the recorder captures each completion's full
 * input (model, params, prompt) and output, and on replay a *source* re-feeds
 * those recorded completions instead of re-calling the model. This module is
 * both halves of that seam — the capture sink (R2-b) and the re-feed source
 * (R2-c). Both registries are keyed by willId so each Will routes to its own
 * recorder/source (unlike the process-global token tracker — see REORIENT R4).
 */

import type { Tick, Timestamp } from '#core/types'

export interface LLMCompletionRecord {
  tick: Tick
  willId: string
  provider: string
  model: string
  maxOutputTokens: number
  systemPrompt: string
  userMessage: string
  text: string
  inputTok: number
  outputTok: number
  /** True when produced by the deterministic mock path (no API call). */
  mock: boolean
  latencyMs: number
  timestamp: Timestamp
}

export interface LLMCompletionSink {
  recordCompletion( record: LLMCompletionRecord ): void
}

const _sinks = new Map<string, LLMCompletionSink>()

export function setCompletionRecorder( willId: string, sink: LLMCompletionSink ): void {
  _sinks.set( willId, sink )
}

export function clearCompletionRecorder( willId: string ): void {
  _sinks.delete( willId )
}

export function getCompletionRecorder( willId: string ): LLMCompletionSink | undefined {
  return _sinks.get( willId )
}

// ── Replay re-feed source (R2-c) ─────────────────────────────

/**
 * Supplies recorded completions back to the LLM director during replay. A
 * registered source short-circuits the live API call: the director returns the
 * recorded output instead of re-invoking the non-deterministic model. Returning
 * `undefined` means "no recorded completion — fall through to a live call"; a
 * strict source (see RecordedCompletionSource) instead throws on a miss so a
 * replay can never silently diverge.
 */
export interface LLMCompletionSource {
  nextCompletion(
    tick: number,
    systemPrompt: string,
    userMessage: string,
  ): LLMCompletionRecord | undefined
}

/**
 * Strict re-feed source backed by an array of recorded completions. Matches by
 * tick, then by BYTE-IDENTICAL PROMPT within the tick — order-independent.
 *
 * Why prompt-keyed, not FIFO: concurrent LLM chains (the master executive and
 * a deliberation facet) can ISSUE their same-tick calls in either order — that
 * interleaving is scheduler timing, not seed-pinned state, so it may flip
 * between the recording run and the replay run. Positional matching mispairs
 * at the first flip and reports a phantom "prompt diverged". Keying each call
 * to its own record by exact prompt makes the pairing insensitive to issue
 * order while remaining strict: the prompts themselves are pure functions of
 * deterministic state, so a real divergence still has no matching record and
 * throws. Identical duplicate prompts within a tick consume FIFO.
 */
export class RecordedCompletionSource implements LLMCompletionSource {
  private _byTick = new Map<number, LLMCompletionRecord[]>()

  constructor( completions: readonly LLMCompletionRecord[] ){
    for( const c of completions ){
      const queue = this._byTick.get( c.tick )
      if( queue ) queue.push( c )
      else this._byTick.set( c.tick, [ c ] )
    }
  }

  nextCompletion( tick: number, systemPrompt: string, userMessage: string ): LLMCompletionRecord {
    const queue = this._byTick.get( tick )
    if( !queue || queue.length === 0 )
      throw new Error(`replay: no recorded LLM completion for tick ${tick} (recording is incomplete or call timing diverged)`)

    const idx = queue.findIndex( r => r.systemPrompt === systemPrompt && r.userMessage === userMessage )
    if( idx === -1 )
      throw new Error(`replay: LLM prompt diverged at tick ${tick} — no recorded completion matches this call (upstream non-determinism)`)

    return queue.splice( idx, 1 )[ 0 ]!
  }
}

const _sources = new Map<string, LLMCompletionSource>()

export function setCompletionSource( willId: string, source: LLMCompletionSource ): void {
  _sources.set( willId, source )
}

export function clearCompletionSource( willId: string ): void {
  _sources.delete( willId )
}

export function getCompletionSource( willId: string ): LLMCompletionSource | undefined {
  return _sources.get( willId )
}

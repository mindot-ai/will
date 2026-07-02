// ─────────────────────────────────────────────────────────────
// src/stem/session.logger.ts
// ─────────────────────────────────────────────────────────────
//
// Captures every significant event in a Will's cognitive cycle:
//
//   tick             — per-tick metrics snapshot + entity counts
//   event            — every semantic event from the EventBus
//   executive.call     — LLM call metadata (model, prompt size, path)
//   executive.response — LLM response (tokens, latency, raw excerpt)
//   executive.output   — parsed structured output (actions, beliefs, ...)
//   action.execute   — effector execution result and feedback
//   belief.integrate — belief written to store (pre/post confidence cap)
//   conversation.in  — inbound message from an external entity
//   conversation.out — outbound message composed by the Will
//   session.start    — written once on logger creation
//   session.end      — written on close()
//
// Transport: every entry is forwarded (via `emit`/`attachEmit`) to the stem,
// which emits it as a `session_log` envelope on the Will's ExternalTransport —
// so the product wrapper / consumer owns persistence (Postgres, S3, Kafka,
// SSE …). The Will itself no longer uploads to S3.
//
// Files: in DEVELOPMENT only (see `fileLoggingEnabled()`), the same NDJSON is
// also written to data/wills/{willId}/sessions/{sessionId}.jsonl. One JSON
// object per line; parse with `jq`, Python, or any NDJSON reader.
// ─────────────────────────────────────────────────────────────

import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'

/** Forwards each entry to the consumer (the stem bridges it onto the transport). */
export type SessionLogEmit = ( record: Record<string, unknown> ) => void

// ── Entry type union ──────────────────────────────────────────

export type LogEntryType =
  | 'session.start'
  | 'session.end'
  | 'tick'
  | 'event'
  | 'executive.call'
  | 'executive.response'
  | 'executive.output'
  | 'executive.facet.spawn'
  | 'executive.facet.call'
  | 'executive.facet.response'
  | 'executive.facet.output'
  | 'executive.facet.destroy'
  | 'action.execute'
  | 'action.error'
  | 'action.outcome'
  | 'belief.integrate'
  | 'conversation.in'
  | 'conversation.out'
  | 'plan.step.activated'
  | 'plan.step.outcome'
  | 'goal.progress'
  | 'goal.achieved'
  | 'goal.blocked'
  | 'goal.abandoned'
  | 'outbox.push'
  | 'outbox.expire'

interface BaseEntry {
  type:     LogEntryType
  wallTime: number
  tick?:    number
}

export type LogEntry = BaseEntry & Record<string, unknown>

export interface SessionLoggerOptions {
  /**
   * Forward every entry to the consumer (typically the stem, which emits it as a
   * `session_log` envelope on the transport). May also be set later via
   * {@link SessionLogger.attachEmit} once the Will instance exists.
   */
  emit?:        SessionLogEmit | null
  /** Also write a local NDJSON file. Dev convenience only; off in production. */
  fileLogging?: boolean
  /** Override the data directory for the dev file (default `./data`). */
  dataDir?:     string
}

// ── SessionLogger ─────────────────────────────────────────────

export class SessionLogger {
  readonly sessionId: string
  /** Local file path — empty string when file logging is disabled. */
  readonly filePath:  string

  private readonly _stream:     WriteStream | null
  private          _emit:       SessionLogEmit | null
  private          _closed   = false
  private          _count    = 0

  constructor( willId: string, dataDir: string = './data', opts: SessionLoggerOptions = {} ) {
    const ts  = new Date().toISOString().replace( /[:.]/g, '-' ).slice( 0, 19 )
    const rnd = Math.random().toString( 36 ).slice( 2, 8 )
    this.sessionId = `${ts}-${rnd}`

    this._emit = opts.emit ?? null

    const fileLogging = opts.fileLogging ?? false
    if( fileLogging ){
      const dir = join( opts.dataDir ?? dataDir, 'wills', willId, 'sessions' )
      mkdirSync( dir, { recursive: true } )
      this.filePath = join( dir, `${this.sessionId}.jsonl` )
      this._stream  = createWriteStream( this.filePath, { flags: 'a' } )
    } else {
      this.filePath = ''
      this._stream  = null
    }
  }

  /**
   * Late-bind the consumer forwarder (the stem sets this once the Will instance
   * exists, so it can emit a `session_log` envelope on the instance's transport).
   */
  attachEmit( emit: SessionLogEmit ): void {
    this._emit = emit
  }

  write( entry: Omit<LogEntry, 'wallTime'> ): void {
    if( this._closed ) return
    const record = { wallTime: Date.now(), ...entry }

    // Forward first — this is the production transport; the consumer persists it.
    try { this._emit?.( record ) }
    catch { /* a listener fault must never block the tick loop */ }

    // File is a dev-only mirror.
    if( this._stream ){
      try { this._stream.write( JSON.stringify( record ) + '\n' ) }
      catch { /* never block the tick loop on a log failure */ }
    }

    this._count++
  }

  /**
   * Emits `session.end` and closes the local file stream (if any). Persistence
   * of the streamed entries is the consumer's responsibility — the Will no longer
   * uploads anywhere itself.
   */
  close(): void {
    if( this._closed ) return
    this.write({ type: 'session.end', totalEntries: this._count + 1 })
    this._closed = true
    this._stream?.end()
  }

  get entryCount(): number { return this._count }
  get isClosed():   boolean { return this._closed }
}

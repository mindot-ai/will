// ─────────────────────────────────────────────────────────────
// src/llm/gate.ts
// ─────────────────────────────────────────────────────────────

/**
 * Global concurrency gate for all LLM calls.
*
 * Two protections:
 *   1. Semaphore — caps simultaneous in-flight requests so independent
 *      engines (decision, semantic, planning…) can run in parallel up to
 *      the concurrency limit without flooding the API.
 *   2. Retry with exponential backoff — on 429 the call waits and retries.
 *
 * No minimum interval is enforced.  A fixed inter-call floor causes
 * starvation: every engine serialises into a single queue and slower
 * engines (semantic integrator) never get a timely slot because faster
 * engines (decision) keep resetting the clock.  The retry mechanism is
 * the right tool for actual rate-limit overages.
 *
 * Configured via env vars:
 *   WILL_LLM_CONCURRENCY    max simultaneous LLM calls (default 2)
 *   WILL_LLM_MAX_RETRIES    retries before giving up on a 429 (default 4)
 *   WILL_LLM_RETRY_BASE_MS  first retry wait, doubles each attempt (default 2000)
 */

import { logger } from '#core/logger'

const MAX_CONCURRENT = parseInt( process.env.WILL_LLM_CONCURRENCY ?? '2')

// Read lazily (per retry, not per module load) so tests and live tuning can
// adjust the backoff without re-importing the module. Jitter scales with the
// base delay (base/2 ⇒ up to 1000 ms at the 2000 ms default — unchanged).
const maxRetries  = () => parseInt( process.env.WILL_LLM_MAX_RETRIES   ?? '4')
const baseDelayMs = () => parseInt( process.env.WILL_LLM_RETRY_BASE_MS ?? '2000')

// ── Semaphore ─────────────────────────────────────────────────

export class LLMSemaphore {
  private _running = 0
  private readonly _max: number
  private _queue: Array<() => void> = []

  constructor( max: number ){ this._max = max }

  async acquire(): Promise<() => void> {
    if( this._running < this._max ){
      this._running++
      return this._release()
    }

    // No free slot — wait until one is handed off directly to us. The releasing
    // call transfers its slot without decrementing _running, so we must NOT
    // increment here: we already own the slot the moment we resume.
    await new Promise<void>( resolve => this._queue.push( resolve ) )
    return this._release()
  }

  private _release(): () => void {
    let done = false
    return () => {
      if( done ) return
      done = true

      // Hand the slot directly to the next waiter, keeping _running unchanged so
      // a concurrent acquire() can't slip into a transient gap and over-admit
      // past _max. Only decrement when nobody is waiting.
      const next = this._queue.shift()
      if( next ) next()
      else this._running--
    }
  }

  get running(): number { return this._running }
  get queued():  number { return this._queue.length }
}

export const llmGate = new LLMSemaphore( MAX_CONCURRENT )

// ── Rate-limit detection ──────────────────────────────────────

export function isRateLimitError( err: unknown ): boolean {
  if( !( err instanceof Error ) ) return false
  const msg = err.message

  return (
    msg.includes('rate_limit_error')          ||
    ( err as { statusCode?: number } ).statusCode === 429 ||
    msg.includes('rate limit')                ||
    msg.includes('429')
  )
}

// ── Gate + retry wrapper ──────────────────────────────────────

/**
 * Run `fn` through the global semaphore with automatic 429 retry.
 *
 * - Waits for a slot before calling `fn`
 * - On 429: releases the slot, waits (exponential backoff + jitter), retries
 * - Throws after MAX_RETRIES exhausted, or for non-retryable errors
 */
export async function withGate<T>(
  fn: () => Promise<T>,
  label: string,
  gate: LLMSemaphore = llmGate
): Promise<T> {
  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while( true ){
    const release = await gate.acquire()
    let retryDelay: number | null = null

    try {
      const result = await fn()
      return result
    }
    catch( err ){
      if( isRateLimitError( err ) && attempt < maxRetries() ){
        attempt++
        const base = baseDelayMs()
        retryDelay = Math.min(
          60_000,
          base * Math.pow( 2, attempt ) + Math.random() * ( base / 2 )
        )
      }
      else throw err
    }
    finally { release() }

    // Slot released in `finally` above — the backoff wait happens OUTSIDE the
    // slot-holding region, so a rate-limited call no longer starves the other
    // engines of concurrency while it sleeps.
    logger.warn(
      `[LLMGate] ${label} rate limited — retry ${attempt}/${maxRetries()} in ${Math.round( retryDelay! )}ms` +
      `  (running=${gate.running} queued=${gate.queued})`
    )
    await new Promise( r => setTimeout( r, retryDelay! ) )
  }
}

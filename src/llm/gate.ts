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
 *   2. Retry with exponential backoff — on a transient provider error
 *      (429 rate limit, or a 5xx/529 overload) the call waits and retries.
 *
 * No minimum interval is enforced.  A fixed inter-call floor causes
 * starvation: every engine serialises into a single queue and slower
 * engines (semantic integrator) never get a timely slot because faster
 * engines (decision) keep resetting the clock.  The retry mechanism is
 * the right tool for actual rate-limit overages.
 *
 * Configured via env vars:
 *   WILL_LLM_CONCURRENCY    max simultaneous LLM calls (default 2)
 *   WILL_LLM_RESPONSIVE_CONCURRENCY  slots reserved for calls someone outside
 *                           the mind is waiting on (default 1)
 *   WILL_LLM_MAX_RETRIES    retries before giving up on a transient error (default 4)
 *   WILL_LLM_RETRY_BASE_MS  first retry wait, doubles each attempt (default 2000)
 */

import { logger } from '#core/logger'
import type { LLMCallFunction } from '#cognition/utilities/token.tracker'

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

// ── The responsive lane ───────────────────────────────────────

/**
 * A second gate, for calls someone OUTSIDE the mind is waiting on.
 *
 * `WILL_LLM_CONCURRENCY` ships with the comment "the minimum is 3: orbital,
 * conversation, summary" — an intended allocation that one shared semaphore
 * cannot enforce. Three slots means any three callers, and a mind deliberating
 * at ~1,100 output tokens a call keeps all three warm indefinitely.
 *
 * Measured on a live COO over 7 hours: 29 of 45 replies began at or past the
 * limit, and the worst spent 117 of its 131 seconds waiting for a slot rather
 * than generating — 545 tokens at 4.2 tok/s against a provider that does ~39.
 * From outside, that is a mind that read your message and said nothing.
 *
 * The distinction drawn here is NOT that conversation matters more. It is that
 * something outside the mind is blocked on this call — a property of the call
 * itself, which is why the predicate is named for the property and not for a
 * list of blessed functions. Rumination can wait its turn. A person waiting for
 * an answer cannot tell a mind that is thinking from one that is gone.
 */
const RESPONSIVE_CONCURRENCY = parseInt( process.env.WILL_LLM_RESPONSIVE_CONCURRENCY ?? '1')

export const responsiveGate = new LLMSemaphore( RESPONSIVE_CONCURRENCY )

/**
 * The cognitive functions something outside the mind is blocked on.
 *
 * `outreach` is deliberately absent: the mind started that one, and nobody is
 * sitting on the other end waiting. Only work that a waiting party is already
 * owed belongs in the reserved lane — widen this and the reservation stops
 * meaning anything.
 */
const AWAITED_OUTSIDE: ReadonlySet<LLMCallFunction> = new Set([ 'conversation' ])

/** Whether someone outside the mind is blocked on a call of this function. */
export function isAwaitedOutside( fn: LLMCallFunction | undefined ): boolean {
  return fn !== undefined && AWAITED_OUTSIDE.has( fn )
}

/** The lane a call of this function belongs in. */
export function gateFor( fn: LLMCallFunction | undefined ): LLMSemaphore {
  return isAwaitedOutside( fn ) ? responsiveGate : llmGate
}

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

// ── Retryable transient errors ────────────────────────────────

/**
 * Transient provider statuses worth retrying: rate limits (429) and the
 * server-side overload / gateway family (500, 502, 503, 504) plus Anthropic's
 * 529 Overloaded. All are conditions where the same request may succeed
 * shortly after — unlike 4xx client errors, which will fail identically.
 *
 * NOT included: timeouts and generic network failures. Whether to retry those
 * is a separate policy decision (a timeout may have already spent a slow
 * generation) and is deliberately out of scope here.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([ 429, 500, 502, 503, 504, 529 ])

/**
 * The HTTP status an LLM error carries, from a structured field if present, or
 * else parsed from the message the fetch path actually throws.
 *
 * The direct/stream callers in `index.ts` do not attach a `statusCode`; they
 * throw the status inside the message text — `` `${provider} API ${status}: …` ``
 * and `` `Anthropic stream ${status}: …` ``. We read the field first (for any
 * error that does carry one) and fall back to the message shape.
 */
function statusOf( err: Error ): number | undefined {
  const field = ( err as { statusCode?: number; status?: number } ).statusCode
             ?? ( err as { status?: number } ).status
  if( typeof field === 'number' ) return field

  const m = err.message.match( /\b(?:API|stream)\s+(\d{3})\b/ )
  return m ? parseInt( m[ 1 ]!, 10 ) : undefined
}

/**
 * Whether an error is a transient provider condition worth retrying.
 *
 * A recognised status decides it outright (so a `400`/`401`/`404` is fatal even
 * if the message happens to contain other digits). With no status anywhere, we
 * defer to `isRateLimitError` so a provider that phrases a rate limit in prose
 * ("rate limit reached", `rate_limit_error`) still retries as it always has.
 */
export function isRetryableError( err: unknown ): boolean {
  if( !( err instanceof Error ) ) return false

  const status = statusOf( err )
  if( status !== undefined ) return RETRYABLE_STATUS.has( status )

  return isRateLimitError( err )
}

// ── Gate + retry wrapper ──────────────────────────────────────

/**
 * Run `fn` through the global semaphore with automatic retry of transient
 * provider errors (see `isRetryableError`: 429 + the 5xx/529 overload family).
 *
 * - Waits for a slot before calling `fn`
 * - On a transient error: releases the slot, waits (exponential backoff +
 *   jitter), retries
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
      if( isRetryableError( err ) && attempt < maxRetries() ){
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
      `[LLMGate] ${label} transient error — retry ${attempt}/${maxRetries()} in ${Math.round( retryDelay! )}ms` +
      `  (running=${gate.running} queued=${gate.queued})`
    )
    await new Promise( r => setTimeout( r, retryDelay! ) )
  }
}

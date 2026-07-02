// ─────────────────────────────────────────────────────────────
// src/core/logger.ts
// ─────────────────────────────────────────────────────────────

/**
 * Injectable diagnostic logger for the Will library.
 *
 * Will is embedded inside a host process (the API server, the dev runner,
 * tests). A library has no business deciding where diagnostic output goes,
 * so every internal `console.*` call routes through this seam instead. The
 * host installs its own sink once at startup via `setLogger()`; everything
 * downstream calls `logger.info()/warn()/error()/debug()` and never touches
 * `console` directly.
 *
 * This is deliberately NOT the same thing as `SessionLogger` (stem/tracts),
 * which writes the structured NDJSON cognitive event stream. This logger is
 * for unstructured operational diagnostics — "rate limited, retrying",
 * "S3 upload failed", "engine X skipped" — the lines that used to be
 * `console.warn`.
 *
 * Default behaviour is identical to the previous direct `console.*` usage:
 * `ConsoleLogger` forwards each level to the matching console method, so
 * installing nothing changes nothing.
 *
 * Usage:
 *   import { logger } from '#core/logger'
 *   logger.warn('[LLMGate] rate limited — retrying')
 *
 *   // host, once at startup:
 *   import { setLogger } from 'will'
 *   setLogger(myStructuredLogger)
 */

export interface Logger {
  debug( message?: unknown, ...args: unknown[] ): void
  info ( message?: unknown, ...args: unknown[] ): void
  warn ( message?: unknown, ...args: unknown[] ): void
  error( message?: unknown, ...args: unknown[] ): void
}

/**
 * Default sink: forwards to the global console. `debug` → console.debug,
 * `info` → console.info (stdout, same channel as the old console.log calls),
 * `warn`/`error` → their console equivalents (stderr). Behaviour matches the
 * pre-refactor direct console usage exactly.
 */
export class ConsoleLogger implements Logger {
  debug( message?: unknown, ...args: unknown[] ): void { console.debug( message, ...args ) }
  info ( message?: unknown, ...args: unknown[] ): void { console.info ( message, ...args ) }
  warn ( message?: unknown, ...args: unknown[] ): void { console.warn ( message, ...args ) }
  error( message?: unknown, ...args: unknown[] ): void { console.error( message, ...args ) }
}

/**
 * No-op sink — useful for tests or hosts that want Will to stay silent.
 */
export class SilentLogger implements Logger {
  debug(): void {}
  info (): void {}
  warn (): void {}
  error(): void {}
}

// Module-level current logger. Mutable so a host can swap it once at startup.
let _logger: Logger = new ConsoleLogger()

/**
 * Stable indirection object. Callers import this and call `logger.info(...)`;
 * `setLogger()` re-points the underlying sink without callers re-importing.
 */
export const logger: Logger = {
  debug: ( message?: unknown, ...args: unknown[] ) => _logger.debug( message, ...args ),
  info : ( message?: unknown, ...args: unknown[] ) => _logger.info ( message, ...args ),
  warn : ( message?: unknown, ...args: unknown[] ) => _logger.warn ( message, ...args ),
  error: ( message?: unknown, ...args: unknown[] ) => _logger.error( message, ...args ),
}

/** Install a custom sink for all subsequent Will diagnostic logging. */
export function setLogger( next: Logger ): void { _logger = next }

/** Reset to the default console sink. Primarily for tests. */
export function resetLogger(): void { _logger = new ConsoleLogger() }

/** The currently-installed sink (the real object, not the indirection). */
export function getLogger(): Logger { return _logger }

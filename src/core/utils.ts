// ─────────────────────────────────────────────────────────────
// src/core/utils.ts
// ─────────────────────────────────────────────────────────────

import type { SeededPRNG, SimulationContext } from '#core/types'
import { wallClock } from '#core/wall.clock'

// ── PRNG ─────────────────────────────────────────────────────

/**
 * Creates a Mulberry32 PRNG from the given seed.
 * Mulberry32 is a fast, high-quality 32-bit generator
 * with a full 2^32 period.
 */
export function createPRNG( seed: number ): SeededPRNG {
  // Ensure unsigned 32-bit start state
  let s = seed >>> 0

  function next(): number {
    s += 0x6D2B79F5
    let t = Math.imul( s ^ ( s >>> 15 ), 1 | s )
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t
    return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296
  }

  return {
    get state(){ return s },
    next,
    nextInt: ( min, max ) => Math.floor( next() * ( max - min ) ) + min,
    nextBool: ( probability = 0.5 ) => next() < probability,
  }
}

// ── Immutability ─────────────────────────────────────────────

/**
 * Recursively `Object.freeze` a value and everything reachable from it, then
 * return the same reference. Primitives (and `null`) pass through untouched.
 *
 * This is the runtime half of the double-buffer contract (R3): the type system
 * marks the per-tick state snapshot `ReadonlyDeep`, but that is erased at
 * runtime — a careless `entity.foo = x` on a value an engine *read* would
 * silently corrupt the shared state and break determinism invisibly. Freezing
 * the value turns that mutation into a loud `TypeError` (all ESM is strict
 * mode) the instant it happens, so the "read-only snapshot" guarantee is
 * enforced, not merely conventional.
 *
 * Cycle-safe: the container is frozen *before* its children are visited, so a
 * reference that points back into an already-frozen object short-circuits on
 * the `isFrozen` guard rather than recursing forever. Idempotent — re-freezing
 * an already-frozen graph is a cheap no-op.
 */
export function deepFreeze<T>( value: T ): T {
  // Only objects/arrays/functions are freezable; primitives are immutable already.
  if( value === null || typeof value !== 'object' ) return value
  if( Object.isFrozen( value ) ) return value

  // Freeze the container first so a cyclic reference back to it hits the
  // isFrozen guard above on re-entry (prevents infinite recursion).
  Object.freeze( value )

  for( const key of Object.keys( value as Record<string, unknown> ) )
    deepFreeze( ( value as Record<string, unknown> )[ key ] )

  return value
}

// ── Context helpers ──────────────────────────────────────────

/**
 * Creates a minimal SimulationContext with required prng.
 * Use for standalone operations (tests, step calls) where a full
 * simulation is not running.
 */
export function createContext( simulationId: string, runId: string, seed?: number ): SimulationContext {
  return {
    simulationId,
    runId,
    tags: {},
    prng: createPRNG( seed ?? wallClock() )
  }
}
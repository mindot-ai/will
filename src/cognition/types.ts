// ─────────────────────────────────────────────────────────────
// src/cognition/cognitive.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * CognitiveEngine — additive interface for engines that participate in the
 * event-driven cognitive bus architecture.
 *
 * Any SimulationEngine can opt in by implementing these four methods.
 * Engines that don't implement it continue to work normally via react().
 * Migration can happen engine-by-engine with no orchestrator changes.
 */

import type { StateCommands } from '#core/types'
import type { CognitiveEvent } from '#cognition/bus'
import type { SimulationEngine } from '#core/orchestrator'
import type { CognitiveEventSchema } from '#cognition/schema.registry'

// Re-export core engine types so cognition-layer files have one import point
export type { SimulationEngine, EngineResult, TickMiddleware } from '#core/orchestrator'

export interface CognitiveEngine extends SimulationEngine {
  /** Event schemas this engine may publish — declared at registration time. */
  publishes(): CognitiveEventSchema[]

  /** Topic patterns this engine subscribes to — used for bus wiring and cycle detection. */
  subscribes(): string[]

  /**
   * Declare which schema versions this engine accepts for a given event type.
   * If not implemented (or returns empty), any version is accepted.
   * The bus will attempt migration before delivery when version is not in the list.
   * Phase A: per-subscriber version filtering.
   */
  acceptsVersions?( eventType: string ): number[]

  /** Called by the bus on event delivery — never called concurrently. */
  onCognitiveEvent( event: CognitiveEvent ): StateCommands | void

  /** Full local state snapshot for cold-start bootstrap and debugging. */
  snapshot(): Record<string, unknown>

  /**
   * Rehydrate engine-internal mutable state from a prior snapshot() payload (FN9).
   *
   * snapshot() captures private accumulating state (activity multipliers, salience
   * baselines, generative-model predictions) that the event-sourced SimulationState
   * never sees; restore() is the matching seam that lets a snapshot/replay reproduce
   * it instead of resuming with freshly-zeroed internals. Optional and additive:
   * engines that don't implement it keep their old behaviour, and a restore caller
   * must treat it as best-effort (feature-detect before calling).
   */
  restore?( snapshot: Record<string, unknown> ): void
}

export function isCognitiveEngine( engine: SimulationEngine ): engine is CognitiveEngine {
  return (
    typeof ( engine as CognitiveEngine ).publishes         === 'function' &&
    typeof ( engine as CognitiveEngine ).subscribes        === 'function' &&
    typeof ( engine as CognitiveEngine ).onCognitiveEvent  === 'function' &&
    typeof ( engine as CognitiveEngine ).snapshot          === 'function'
  )
}

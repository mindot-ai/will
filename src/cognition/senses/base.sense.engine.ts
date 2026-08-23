// ─────────────────────────────────────────────────────────────
// src/cognition/senses/base.sense.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * BaseSenseEngine — the shared perceptual pipeline (§6).
 *
 * Every sense engine repeats the same skeleton: CognitiveEngine boilerplate,
 * an effector gate, a kind filter, and a percept publish on `senses.<domain>.percept`.
 * This base captures all of it as a template method so each concrete engine only
 * declares WHAT it senses (`domain`, `acceptedKinds`, optional `gateEffector`) and
 * implements the domain-specific `_perceive()`.
 *
 * Flow (template method `ingest`):
 *   effector gate (optional) → kind filter → `_perceive(input)`
 *
 * `_perceive()` does the domain work and calls `publishPercept()` — the single
 * chokepoint for emitting on the bus. That chokepoint is also where a future
 * cross-modal binder would observe percepts of the same `sourceEntityId` across
 * domains (see §6 cross-modal note).
 *
 * - `AuditionEngine` extends this and overrides `publishes()`/`snapshot()` for its
 *   extra `executive.facet.handoff` schema and session snapshot.
 * - The four shell engines extend `ShellSenseEngine` (below) and are ~6 lines each.
 */

import { logger } from '#core/logger'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { StateCommands } from '#core/types'
import type { AccessGrants } from '#agency/access.grants'
import { provenanceOf } from '#senses/provenance'
import type { SenseEngine, SensoryInput, SenseDomain, Percept } from '#senses/index'

export abstract class BaseSenseEngine implements SenseEngine {
  abstract readonly name:   string
  abstract readonly domain: SenseDomain

  /**
   * The `SensoryInput.kind` values this engine consumes. Inputs of any other
   * kind are ignored silently by `ingest()` (no warning, no work) — this is how
   * a single `ingestSensory(domain, input)` call can be routed leniently.
   */
  protected abstract readonly acceptedKinds: ReadonlySet<SensoryInput['kind']>

  /**
   * Effector that gates ingestion (e.g. audition → 'listen'). When set and
   * AccessGrants denies it, `ingest()` is a silent no-op — the engine stays
   * wired but functionally inactive. `null` = always active.
   */
  protected readonly gateEffector: string | null = null

  protected _bus:    CognitiveBus | null = null
  protected _grants: AccessGrants | null = null

  // ── Wiring ───────────────────────────────────────────────
  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  /** Inject the AccessGrants so `ingest()` honours `gateEffector` (the permission gate). */
  attachGrants( g: AccessGrants ): void { this._grants = g }

  // ── CognitiveEngine defaults ─────────────────────────────
  publishes(): CognitiveEventSchema[] {
    return [ { type: `senses.${this.domain}.percept`, version: 1, validate: () => null } ]
  }
  subscribes(): string[] { return [] }
  onCognitiveEvent( _e: CognitiveEvent ): StateCommands | void { /* sense engines are ingest-driven */ }
  snapshot(): Record<string, unknown> { return { domain: this.domain } }

  // ── SenseEngine: the shared template ─────────────────────
  /**
   * Apply the effector gate + kind filter common to every sense, then delegate
   * the domain-specific work to `_perceive()`. Subclasses never re-handle gating
   * or filtering — they only implement `_perceive()`.
   */
  async ingest( input: SensoryInput ): Promise<void> {
    // Permission gate — AccessGrants decides whether this sense may ingest.
    if( this.gateEffector && this._grants && !this._grants.isAllowed( this.gateEffector ) ) return
    if( !this.acceptedKinds.has( input.kind ) ) return
    await this._perceive( input )
  }

  /** Domain-specific perception. Invoked only for accepted kinds, past the gate. */
  protected abstract _perceive( input: SensoryInput ): Promise<void>

  // ── Shared helpers ───────────────────────────────────────
  /**
   * Publish a percept on this engine's `senses.<domain>.percept` topic. The
   * single emit chokepoint — the AttentionAllocator (and, in future, a
   * cross-modal binder) observes percepts here.
   *
   * `from` is the signal this percept was transduced FROM, and it is required
   * rather than optional on purpose: every percept has a cause, and the one
   * fact transduction must not lose is whose doing that cause was. Taking it
   * here — instead of stashing the in-flight input on a field — is what keeps
   * the stamp correct while `_perceive()` is async and two ingests overlap.
   * A percept arrives already stamped; downstream never has to guess.
   */
  protected publishPercept( percept: Percept, from: SensoryInput ): void {
    // Both fields are stripped off the engine's percept before being re-applied
    // from `from`, rather than spread-over. A conditional overwrite left a hole:
    // an engine could fabricate a `sourceIntentId` and it survived whenever the
    // host supplied none — provenance the mind would later trust, laundered by
    // the very step that exists to establish it. The host's assertion is the
    // only authority, so it is applied wholesale.
    const { provenance: _stale, sourceIntentId: _staleIntent, ...rest } = percept
    const stamped: Percept = {
      ...rest,
      provenance: provenanceOf( from ),
      ...( from.sourceIntentId ? { sourceIntentId: from.sourceIntentId } : {} ),
    }

    this._bus?.publish({
      type:         `senses.${this.domain}.percept`,
      version:      1,
      sourceEngine: this.name,
      salience:     stamped.salience,
      payload:      stamped,
    })
  }
}

/**
 * ShellSenseEngine — base for the not-yet-implemented senses
 * (vision, somatosensation, olfaction, gustation).
 *
 * `_perceive()` logs a warning (only ever reached for an accepted kind, since the
 * base filters first) and `snapshot()` advertises shell status. A concrete shell
 * is just: `name`, `domain`, and `acceptedKinds`.
 */
export abstract class ShellSenseEngine extends BaseSenseEngine {
  snapshot(): Record<string, unknown> {
    return { domain: this.domain, status: 'shell' }
  }

  protected async _perceive( _input: SensoryInput ): Promise<void> {
    logger.warn(`[${this.name}] ingest() called — engine is a shell, not yet implemented.`)
  }
}

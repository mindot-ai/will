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
import type { SensorySignal } from '#senses/provenance'
import { perceptEntity, type PerceptEntity } from '#cognition/percept.entity'
import { fnv1a } from '#agency/consequence'
import type { SenseEngine, SensoryInput, SenseDomain, Percept, Transduced } from '#senses/index'

export abstract class BaseSenseEngine implements SenseEngine {
  abstract readonly name:   string
  abstract readonly domain: SenseDomain

  /**
   * The `SensoryInput.kind` values this engine consumes. Inputs of any other
   * kind are ignored silently by `ingest()` (no warning, no work) — this is how
   * a single `senseSignal(domain, input)` call can be routed leniently.
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
  protected _trace:  (( e: PerceptEntity ) => void) | null = null
  protected _now:    (() => number) | null = null

  /**
   * Whether this sense lays down a `percept` trace in state (SIGNAL_BOUNDARY P0).
   *
   * ON by default, because that is the contract a host is owed: implement a
   * sense, and what it senses reaches the five things that read percepts — the
   * rupture gate, reafference credit, working memory, the executive prompt, and
   * novelty. Before this, `publishPercept()` emitted a bus event three
   * subscribers glanced at for one tick and nothing else, so a robot host
   * ingesting frames could never remember having SEEN anything.
   *
   * `AuditionEngine` overrides it to `false` — see the comment there. It is the
   * documented exception, not the template.
   */
  protected readonly tracesPercepts: boolean = true

  // ── Wiring ───────────────────────────────────────────────
  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  /** Inject the AccessGrants so `ingest()` honours `gateEffector` (the permission gate). */
  attachGrants( g: AccessGrants ): void { this._grants = g }

  /**
   * Wire the sense to state: where a percept goes, and what tick it is now.
   *
   * Both together, never one: a percept without a tick is uncollectable — the
   * sweeper reads `metadata.tick` and nothing else — which is the leak P0 step 2
   * closed in two other writers. And the tick has to be injected rather than
   * remembered, because a sense is INGEST-DRIVEN and off-tick: it has no `react()`
   * to be handed one in. Audition's own `_lastDecisionTick` is the cautionary
   * case — it lags to whenever the executive last decided, so a message arriving
   * forty ticks later would be stamped forty ticks stale and swept on arrival.
   */
  attachPerceptTrace( write: ( e: PerceptEntity ) => void, currentTick: () => number ): void {
    this._trace = write
    this._now   = currentTick
  }

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
  async sense( input: SensoryInput ): Promise<void> {
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
   *
   * The percept arrives as `Transduced`, i.e. WITHOUT the two fields, so a
   * sense engine cannot supply them at all. An earlier cut let one through: the
   * stamp overwrote `provenance` unconditionally but `sourceIntentId` only when
   * the host supplied one, so an engine could fabricate an intent id and it
   * survived — provenance the mind would later trust, laundered by the very
   * step that exists to establish it. The type now refuses it outright; the
   * host's assertion is the only authority.
   *
   * Returns the stamped percept so a sense engine that needs it downstream (as
   * audition does, to route the turn) uses the SAME object the bus saw, rather
   * than a second one that could drift from it.
   */
  protected publishPercept<P extends Percept>( percept: Transduced<P>, from: SensorySignal ): P {
    // Stripped, then re-applied — belt AND braces. `Transduced` makes forging a
    // compile error, but a type is only as strong as the compiler that saw it:
    // a JS host, or a consumer built against an older .d.ts, hands over whatever
    // it likes. The strip is what holds at runtime.
    const { provenance: _stale, sourceIntentId: _staleIntent, ...rest } =
      percept as Transduced<P> & Partial<SensorySignal>

    const stamped = {
      ...rest,
      provenance: from.provenance,
      ...( from.sourceIntentId ? { sourceIntentId: from.sourceIntentId } : {} ),
    } as P

    this._bus?.publish({
      type:         `senses.${this.domain}.percept`,
      version:      1,
      sourceEngine: this.name,
      salience:     stamped.salience,
      payload:      stamped,
    })

    this._writeTrace( stamped )
    return stamped
  }

  /**
   * Lay the percept down in state, so it reaches the faculties that read
   * percepts rather than only the three that were listening on the bus this
   * tick. Silent when the sense opts out or the host wired no sink.
   *
   * The id is content-derived and tick-stamped — never `wallClock()` — because
   * this entity lives in state, and a wall-clock id makes a recorded and a
   * replayed run diverge (R2). Two identical signals from one entity on one
   * tick collapse to one percept, which is the same coalescing audition already
   * applies to a burst of identical messages.
   */
  private _writeTrace( p: Percept ): void {
    if( !this.tracesPercepts || !this._trace || !this._now ) return

    const tick = this._now()
    this._trace( perceptEntity( {
      id:         `sense-${ this.domain }-${ tick }-${ fnv1a( `${ p.sourceEntityId }\u0000${ p.summary }` ) }`,
      tick,
      salience:   p.salience,
      category:   this.domain,
      summary:    p.summary,
      provenance: p.provenance,
      entityId:   p.sourceEntityId,
      ...( p.sourceIntentId !== undefined ? { sourceIntentId: p.sourceIntentId } : {} ),
      ...( p.data           !== undefined ? { data:           p.data           } : {} ),
    } ) )
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

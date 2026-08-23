// ─────────────────────────────────────────────────────────────
// src/cognition/senses/index.ts
// ─────────────────────────────────────────────────────────────

/**
 * Perceptual Tier — 5 Senses Architecture
 *
 * Shared types and the SenseEngine interface for all sense engines.
 * Sense engines are CognitiveEngines that also expose an `ingest()` method
 * for external stimuli to enter Will's cognitive pipeline.
 *
 * Events flow on the existing CognitiveBus under the `senses.*` topic prefix:
 *   senses.audition.percept   — LanguagePercept from AuditionEngine
 *   senses.vision.percept     — (shell, future)
 *   senses.somatosensation.percept — (shell, future)
 *   senses.olfaction.percept  — (shell, future)
 *   senses.gustation.percept  — (shell, future)
 *
 * AttentionAllocator subscribes to 'senses.*' to receive all percepts.
 */

import type { CognitiveEngine } from '#cognition/types'
import type { CognitiveBus }    from '#cognition/bus'
import type { SensorySignal }   from './provenance'

// ── Domain ────────────────────────────────────────────────────

export type SenseDomain =
  | 'audition'        // language, voice — AuditionEngine
  | 'vision'          // images, video   — VisionEngine (shell)
  | 'somatosensation' // webhooks, events — SomatosensationEngine (shell)
  | 'olfaction'       // ambient signals  — OlfactionEngine (shell)
  | 'gustation'       // self-evaluation  — GustationEngine (shell)

// ── Provenance (re-exported from ./provenance) ────────────────

export type { SignalProvenance, SensorySignal, Transduced } from './provenance'
export { asProvenance } from './provenance'

// ── Percept types ─────────────────────────────────────────────

/**
 * Base percept published on the CognitiveBus.
 *
 * It extends `SensorySignal` because transduction does not change whose doing a
 * signal was: what the host stamped on the input is what the percept carries.
 * `BaseSenseEngine.publishPercept()` applies both from the input, so a percept
 * ALWAYS carries provenance — no consumer downstream ever writes a fallback.
 */
export interface Percept extends SensorySignal {
  domain:         SenseDomain
  sourceEntityId: string
  timestamp:      number
  salience:       number   // 0–1, computed by the sense engine
  raw:            unknown  // original input object
  /**
   * What was sensed, in words. REQUIRED, because it is the only field the rest
   * of the mind can read: `extractPercepts` renders `summary` (falling back to
   * `content`) and skips a percept without one, and `working.memory` ingests on
   * the same field. A sense that cannot say what it sensed produces a percept
   * that exists and is invisible — which is what every shell sense would have
   * done the moment it was implemented.
   *
   * Not `raw`, which is the original input object and is for a consumer that
   * knows the modality. This is for the ones that do not.
   */
  summary:        string
}

/** Audition-specific percept — carries language content and thread context. */
export interface LanguagePercept extends Percept {
  domain:          'audition'
  channel:         'text' | 'voice'
  content:         string
  speakerEntityId: string
  threadId:        string
  /** Rolling context: last N user + will turns in the thread. */
  digest:          string
}

// ── Sensory input types (discriminated union) ─────────────────

// Audition
export interface TextMessage extends SensorySignal {
  kind:     'text'
  entityId: string
  threadId: string
  content:  string
  /** Display name — used in the facet focus content. */
  speakerName?: string
  /**
   * True when `threadId` is a PRIVATE thread — this someone and the mind, nobody
   * else listening. The single fact that decides whether a room is the right
   * place for a given utterance, and the Discord edge has always computed it
   * (`isDM`) and discarded it before the mind could see it: a follow-up promised
   * in a DM went out to a public channel, because the roster's "where did I last
   * see them" is a different question from "where did I promise this".
   *
   * Undefined means the channel did not say, which is honestly different from
   * false — an unknown room is not known to be public.
   */
  direct?: boolean
  /**
   * What this room is CALLED, where the channel knows.
   *
   * A room has had a dossier of its own since 0.9.0 and no way to be named, so
   * every place the mind knew was the id it was reached at —
   * `discord:1531261362838441996`. It rendered to the mind as "something", which
   * is what the prompt says for a `thing` with no name, and left a mind deciding
   * *where* to say something choosing between two opaque numbers.
   *
   * A display label, not an address: `#general` is what a person calls the room,
   * `discord:1531…` is how a message gets there, and 0.9.0 established that those
   * are different facts. The bridge composes it, because what a room is called is
   * a platform's business and the mind should not learn Discord's spelling.
   */
  threadName?: string
}

export interface VoiceChunk extends SensorySignal {
  kind:           'voice'
  entityId:       string
  threadId:       string
  audioBuffer?:   Buffer
  transcription?: string
}

// Vision (stub)
export interface ImageFrame extends SensorySignal {
  kind:     'image'
  entityId: string
  data:     Buffer
  mimeType: string
}

export interface VideoSegment extends SensorySignal {
  kind:      'video'
  entityId:  string
  frames:    ImageFrame[]
  durationMs: number
}

// Somatosensation (stub)
export interface WebhookEvent extends SensorySignal {
  kind:    'webhook'
  source:  string
  payload: unknown
  headers: Record<string, string>
}

export interface SystemSignal extends SensorySignal {
  kind:   'system'
  signal: string
  data:   unknown
}

// Olfaction (stub)
export interface AmbientMetric extends SensorySignal {
  kind:      'ambient'
  metricKey: string
  value:     number
  trend:     'rising' | 'falling' | 'stable'
}

export interface BackgroundSignal extends SensorySignal {
  kind:     'background'
  category: string
  data:     unknown
}

// Gustation (stub)
export interface InternalEvaluation extends SensorySignal {
  kind:    'self-eval'
  context: string
  trigger: string
}

export interface SelfAssessmentTrigger extends SensorySignal {
  kind:      'assessment'
  goalId?:   string
  checkType: string
}

/** Discriminated union of all sensory input kinds. */
export type SensoryInput =
  | TextMessage
  | VoiceChunk
  | ImageFrame
  | VideoSegment
  | WebhookEvent
  | SystemSignal
  | AmbientMetric
  | BackgroundSignal
  | InternalEvaluation
  | SelfAssessmentTrigger

// ── SenseEngine interface ─────────────────────────────────────

/**
 * SenseEngine — a CognitiveEngine that also accepts external stimuli.
 *
 * Sense engines implement the full CognitiveEngine contract
 * (publishes, subscribes, onCognitiveEvent, snapshot) plus:
 *   - `domain`: declares which sensory domain this engine handles
 *   - `ingest()`: entry point for external stimuli (called by WillManager)
 *   - `attachBus()`: called automatically by CognitiveOrchestrator.addEngine()
 *
 * Shell engines have no-op `ingest()` bodies — they log a warning and return.
 * Full engines (AuditionEngine) process percepts and publish to the bus.
 */
export interface SenseEngine extends CognitiveEngine {
  readonly domain: SenseDomain
  attachBus( bus: CognitiveBus ): void
  ingest( input: SensoryInput ): Promise<void>
}

// ── Re-exports ────────────────────────────────────────────────

export { BaseSenseEngine, ShellSenseEngine } from './base.sense.engine'
export { AuditionEngine }    from './audition.engine/engine'
export { VisionEngine }      from './vision.engine'
export { SomatosensationEngine } from './somatosensation.engine'
export { OlfactionEngine }   from './olfaction.engine'
export { GustationEngine }   from './gustation.engine'

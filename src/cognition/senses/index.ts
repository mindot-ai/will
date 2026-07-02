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

// ── Domain ────────────────────────────────────────────────────

export type SenseDomain =
  | 'audition'        // language, voice — AuditionEngine
  | 'vision'          // images, video   — VisionEngine (shell)
  | 'somatosensation' // webhooks, events — SomatosensationEngine (shell)
  | 'olfaction'       // ambient signals  — OlfactionEngine (shell)
  | 'gustation'       // self-evaluation  — GustationEngine (shell)

// ── Percept types ─────────────────────────────────────────────

/** Base percept published on the CognitiveBus. */
export interface Percept {
  domain:         SenseDomain
  sourceEntityId: string
  timestamp:      number
  salience:       number   // 0–1, computed by the sense engine
  raw:            unknown  // original input object
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
export interface TextMessage {
  kind:     'text'
  entityId: string
  threadId: string
  content:  string
  /** Display name — used in the facet focus content. */
  speakerName?: string
}

export interface VoiceChunk {
  kind:           'voice'
  entityId:       string
  threadId:       string
  audioBuffer?:   Buffer
  transcription?: string
}

// Vision (stub)
export interface ImageFrame {
  kind:     'image'
  entityId: string
  data:     Buffer
  mimeType: string
}

export interface VideoSegment {
  kind:      'video'
  entityId:  string
  frames:    ImageFrame[]
  durationMs: number
}

// Somatosensation (stub)
export interface WebhookEvent {
  kind:    'webhook'
  source:  string
  payload: unknown
  headers: Record<string, string>
}

export interface SystemSignal {
  kind:   'system'
  signal: string
  data:   unknown
}

// Olfaction (stub)
export interface AmbientMetric {
  kind:      'ambient'
  metricKey: string
  value:     number
  trend:     'rising' | 'falling' | 'stable'
}

export interface BackgroundSignal {
  kind:     'background'
  category: string
  data:     unknown
}

// Gustation (stub)
export interface InternalEvaluation {
  kind:    'self-eval'
  context: string
  trigger: string
}

export interface SelfAssessmentTrigger {
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

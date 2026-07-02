// ─────────────────────────────────────────────────────────────
// src/cognition/senses/vision.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * VisionEngine [SHELL] — sight / visual perception.
 *
 * Future: multimodal LLM calls to interpret image frames and video segments;
 * publishes `senses.vision.percept` events via the shared BaseSenseEngine flow.
 *
 * Currently a structural stub — `_perceive()` (inherited from ShellSenseEngine)
 * logs a warning and returns. The base handles the effector gate, kind filter,
 * percept publish, and CognitiveEngine boilerplate.
 */

import type { SensoryInput } from '#senses/index'
import { ShellSenseEngine } from '#senses/base.sense.engine'

export class VisionEngine extends ShellSenseEngine {
  readonly name   = 'vision-engine'
  readonly domain = 'vision' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'image', 'video' ] )
}

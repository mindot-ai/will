// ─────────────────────────────────────────────────────────────
// src/cognition/senses/gustation.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * GustationEngine [SHELL] — taste / internal self-evaluation.
 *
 * Handles internal self-evaluation triggers and identity alignment checks —
 * Will's "taste", introspective quality assessment of its own outputs and
 * identity coherence after significant events. Future: post-action quality
 * assessment into ConfidenceCalibrator / BiasDetector and SelfModelUpdater.
 *
 * Currently a structural stub — `_perceive()` (inherited from ShellSenseEngine)
 * logs a warning and returns. The base handles gate / filter / publish / boilerplate.
 */

import type { SensoryInput } from '#senses/index'
import { ShellSenseEngine } from '#senses/base.sense.engine'

export class GustationEngine extends ShellSenseEngine {
  readonly name   = 'gustation-engine'
  readonly domain = 'gustation' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'self-eval', 'assessment' ] )
}

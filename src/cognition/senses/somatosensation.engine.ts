// ─────────────────────────────────────────────────────────────
// src/cognition/senses/somatosensation.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * SomatosensationEngine [SHELL] — touch / physical-world interaction.
 *
 * Handles webhook events, system signals, and external API callbacks — Will's
 * "touch", its awareness of interaction with external systems. Future: route
 * incoming webhooks as percepts into ThreatEvaluator / RewardEvaluator.
 *
 * Currently a structural stub — `_perceive()` (inherited from ShellSenseEngine)
 * logs a warning and returns. The base handles gate / filter / publish / boilerplate.
 */

import type { SensoryInput } from '#senses/index'
import { ShellSenseEngine } from '#senses/base.sense.engine'

export class SomatosensationEngine extends ShellSenseEngine {
  readonly name   = 'somatosensation-engine'
  readonly domain = 'somatosensation' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'webhook', 'system' ] )
}

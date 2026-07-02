// ─────────────────────────────────────────────────────────────
// src/cognition/senses/olfaction.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * OlfactionEngine [SHELL] — smell / ambient background monitoring.
 *
 * Handles ambient metrics and background signals — slow drifts and low-priority
 * environmental monitoring. Will's "smell", detecting the ambient atmosphere
 * before explicit events occur. Future: feed low-salience signals into
 * AffectiveBlender for slow-burn mood modulation.
 *
 * Currently a structural stub — `_perceive()` (inherited from ShellSenseEngine)
 * logs a warning and returns. The base handles gate / filter / publish / boilerplate.
 */

import type { SensoryInput } from '#senses/index'
import { ShellSenseEngine } from '#senses/base.sense.engine'

export class OlfactionEngine extends ShellSenseEngine {
  readonly name   = 'olfaction-engine'
  readonly domain = 'olfaction' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'ambient', 'background' ] )
}

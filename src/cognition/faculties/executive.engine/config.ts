// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/config.ts
// ─────────────────────────────────────────────────────────────

import type { ReadonlySimulationState } from '#core/types'
import type { ExecutiveEngineConfig } from '#faculties/executive.engine/types'

// ── Constants ────────────────────────────────────────────────

export const WORKSPACE_THRESHOLD = 0.4
export const BUFFER_SALIENCE_TRIGGER = 2.5
export const BUFFER_MAX_AGE_TICKS = 30

export const DEFAULT_EXECUTIVE_INTERVAL = 15
export const DEFAULT_COOLDOWN_TICKS = 5

// ── Runtime config reader ────────────────────────────────────

export interface ExecutiveRuntimeConfig {
  executiveInterval: number
  cooldownTicks: number
}

export function readRuntimeConfig(
  state: ReadonlySimulationState,
  base: ExecutiveEngineConfig
): ExecutiveRuntimeConfig {
  const cfg = state.entities.get('engine-config-executive')
  if( !cfg )
    return {
      executiveInterval: base.executiveInterval ?? DEFAULT_EXECUTIVE_INTERVAL,
      cooldownTicks: base.cooldownTicks ?? DEFAULT_COOLDOWN_TICKS
    }

  const p = cfg.metadata?.params as Record<string, number> | undefined
  if( !p )
    return {
      executiveInterval: base.executiveInterval ?? DEFAULT_EXECUTIVE_INTERVAL,
      cooldownTicks: base.cooldownTicks ?? DEFAULT_COOLDOWN_TICKS
    }

  return {
    executiveInterval: p.executiveInterval ?? base.executiveInterval ?? DEFAULT_EXECUTIVE_INTERVAL,
    cooldownTicks: p.cooldownTicks ?? base.cooldownTicks ?? DEFAULT_COOLDOWN_TICKS
  }
}
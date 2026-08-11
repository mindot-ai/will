// ─────────────────────────────────────────────────────────────
// src/stem/profiles/index.ts — World profile registry
// ─────────────────────────────────────────────────────────────
//
// A world profile is a named configuration preset that:
//   1. Pre-grants effectors appropriate for a use case
//   2. Injects context into the executive prompt ("## My Environment")
//
// Profiles are pure config — no execution logic.
// The host system still executes all effectors via effector_invoked SSE events.
// ─────────────────────────────────────────────────────────────

export interface WorldProfile {
  id:          string
  name:        string
  description: string
  /** Effectors pre-granted when this profile is active. */
  effectors:   string[]
  /**
   * Appended to the executive prompt under "## My Environment".
   * Tells the Will what world it inhabits and how to behave in it.
   */
  context:     string
}

const _registry: Record<string, WorldProfile> = {}

/** Register a world profile. Built-in profiles register on module import. */
export function registerProfile( profile: WorldProfile ): void {
  _registry[ profile.id ] = profile
}

/** Resolve a profile by id. Returns undefined if not registered. */
export function resolveProfile( id: string ): WorldProfile | undefined {
  return _registry[ id ]
}

/** List all registered profile ids. */
export function listProfiles(): string[] {
  return Object.keys( _registry )
}


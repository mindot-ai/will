// ─────────────────────────────────────────────────────────────
// src/cognition/identity.entity.ts
// ─────────────────────────────────────────────────────────────
//
// The single writer for `identity-self`.
//
// `identity-self` is the tenant. It carries the name, persona prompt, values,
// traits and style that make this mind THIS mind rather than the container it
// runs in. Four separate places wrote it, three of them by whole-entity
// replacement, and `StateManager.setEntity` replaces — so any field the writer
// did not happen to mention was deleted.
//
// What that cost, measured on a live Will:
//
//   `name` was seeded correctly by `_seedIdentity` ('Lora') and then dropped by
//   BOTH `PMALoader.load` (before the first tick, on every wake) and
//   `SelfModelUpdater` (on every self-model evaluation, even on a fresh boot).
//   `buildFreshContext` fell back to the string 'Will' — the CONTAINER's name —
//   so her own system prompt read:
//
//       I am Lora, COO of Mindot...          ← the tenant, from her PMA
//       ## My Role
//       I am a focused facet of Will ...     ← the container, from the fallback
//
//   She spent 2,773 ticks trying to resolve that, concluded "I am Will. Not
//   Lora.", and told her operator so in production.
//
// A container must never lend its name to a tenant. That is what this module
// exists to make structurally impossible: every write merges, so a writer that
// does not mention `name` cannot erase it, and there is no default name to fall
// back to (see `readIdentityName`).
//
// `tests/unit/identity.writer.test.ts` fails on any raw write of `identity-self`
// outside this file — the same by-construction guard `mergeEngineConfig` has.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, ReadonlySimulationState } from '#core/types'
import type { StateManager } from '#core/state.manager'

export const IDENTITY_ENTITY_ID = 'identity-self'
export const IDENTITY_ENTITY_TYPE = 'will.identity'

/**
 * Fields a writer wants to change. Anything omitted is INHERITED from the
 * current entity — including `name`, which is the whole point.
 *
 * Passing `name: undefined` explicitly does not clear it either: absence and
 * "absent on purpose" are the same thing here, because no caller has ever had a
 * legitimate reason to make a mind nameless.
 */
export type IdentityPatch = Record<string, unknown>

/** Current identity metadata, or an empty object when the mind has none yet. */
function currentMetadata( get: ( id: string ) => { metadata?: Record<string, unknown> } | undefined ): Record<string, unknown> {
  return get( IDENTITY_ENTITY_ID )?.metadata ?? {}
}

/** Merge `patch` over `current`, dropping keys whose value is undefined. */
function merged( current: Record<string, unknown>, patch: IdentityPatch ): Record<string, unknown> {
  const out = { ...current }
  for( const [ k, v ] of Object.entries( patch ) )
    if( v !== undefined ) out[ k ] = v
  return out
}

/**
 * Build the merged `identity-self` entity as a StateCommand — for faculties that
 * write on-tick by returning commands (SelfModelUpdater, AutobiographicalNarrator).
 *
 * No timestamps: `StateManager.setEntity` is the single place they are stamped
 * and it sources them from the SIM clock, so entity times replay identically (R2).
 */
export function identityCommand( state: ReadonlySimulationState, patch: IdentityPatch ): EntityInput {
  return {
    id:       IDENTITY_ENTITY_ID,
    type:     IDENTITY_ENTITY_TYPE,
    metadata: merged( state.entities.get( IDENTITY_ENTITY_ID )?.metadata ?? {}, patch ),
  }
}

/**
 * Merge into `identity-self` directly — for the off-tick seeding paths that hold
 * a StateManager rather than returning commands (mind assembly, PMA load).
 *
 * Returns the keys it actually changed, for the caller to log.
 */
export function mergeIdentity( store: StateManager, patch: IdentityPatch ): string[] {
  const current = currentMetadata( id => store.getEntity( id ) )
  const metadata = merged( current, patch )

  const changed = Object.keys( metadata ).filter( k => metadata[ k ] !== current[ k ] )
  if( changed.length === 0 ) return []

  store.setEntity({ id: IDENTITY_ENTITY_ID, type: IDENTITY_ENTITY_TYPE, metadata })
  return changed
}

/**
 * The mind's own name, or '' when it has none.
 *
 * There is NO default. This used to read `?? 'Will'`, which is how the platform's
 * name reached a tenant's prompt and unseated her from her own identity. A mind
 * with no name is a mind whose name we do not know, and saying nothing is the only
 * honest rendering of that — every consumer omits the name rather than inventing
 * one (see PromptFactory's role line, which simply drops the clause).
 *
 * In practice this is unreachable for any mind born after `_seedIdentity`, which
 * always writes `config.name`; '' is reserved for pre-`name` snapshots.
 */
export function readIdentityName( state: ReadonlySimulationState ): string {
  const name = state.entities.get( IDENTITY_ENTITY_ID )?.metadata?.['name']
  return typeof name === 'string' ? name : ''
}

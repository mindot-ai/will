// ─────────────────────────────────────────────────────────────
// src/agency/revocation.ts  —  commitment-revocation tombstones
// ─────────────────────────────────────────────────────────────
//
// EXAFFERENCE P4. When the world ruptures hard enough (rupture ≥
// RUPTURE_REVOKE_GATE), the ActionSelector doesn't just soften its switch cost
// (P3) — it *lets go* of a commitment it was still weighing: a `deliberating`
// intent. But the selector cannot delete that intent directly. Registration
// order is Selector → Deliberation → Executor, and each engine reads the frozen
// tick-start snapshot, so a same-tick selector-delete + deliberation-set on the
// same intent applies set-after-delete → the intent is RESURRECTED as `selected`
// and enacted despite revocation (the P0 audit's resurrection race).
//
// The tombstone breaks that race by construction: the selector writes a SEPARATE
// `agency.revocation` entity keyed by the intent id (no same-entity write). One
// tick later both honorers see it from frozen state:
//   • the Deliberation engine skips + deletes tombstoned `deliberating` intents;
//   • the Executor refuses to enact a tombstoned `selected` intent (the half-race
//     where deliberation committed `selected` the same tick the tombstone landed).
// Revocation commits NO successor — the field re-forms and next tick selects.
// A short TTL reaps a tombstone whose intent already vanished for another reason.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export const REVOCATION_TYPE = 'agency.revocation'

/** Rupture at/above which a still-deliberating commitment is revoked (rarer than
 *  P3's recruitment-grade softening — letting go is a bigger step than easing up). */
export const RUPTURE_REVOKE_GATE = 0.7

/** Safety reap: a tombstone whose intent disappeared otherwise dies after this. */
export const REVOCATION_TTL_TICKS = 5

export function revocationId( intentId: string ): string {
  return `agency-revocation-${ intentId }`
}

/** Build the tombstone for a revoked intent (keyed by intent id — one per intent). */
export function revocationEntity(
  intentId: string, schema: string, rupture: number, tick: Tick,
): EntityInput {
  return {
    id:   revocationId( intentId ),
    type: REVOCATION_TYPE,
    metadata: { intentId, schema, rupture, tick, expiresAt: tick + REVOCATION_TTL_TICKS },
  }
}

/** Intent ids under a live (unexpired) revocation tombstone, from frozen state. */
export function revokedIntentIds(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  tick:     Tick,
): Set<string> {
  const out = new Set<string>()
  for( const [ , e ] of entities ){
    if( e.type !== REVOCATION_TYPE ) continue
    const m = ( e.metadata ?? {} ) as Record<string, unknown>
    const intentId = typeof m['intentId'] === 'string' ? m['intentId'] as string : undefined
    const expiresAt = typeof m['expiresAt'] === 'number' ? m['expiresAt'] as number : 0
    if( intentId && tick < expiresAt ) out.add( intentId )
  }
  return out
}

/** Ids of expired tombstones to sweep (TTL reap for intents that vanished otherwise). */
export function staleRevocationIds(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  tick:     Tick,
): string[] {
  const stale: string[] = []
  for( const [ id, e ] of entities ){
    if( e.type !== REVOCATION_TYPE ) continue
    const m = ( e.metadata ?? {} ) as Record<string, unknown>
    const expiresAt = typeof m['expiresAt'] === 'number' ? m['expiresAt'] as number : 0
    if( tick >= expiresAt ) stale.push( id )
  }
  return stale
}

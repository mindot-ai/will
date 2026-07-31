// ─────────────────────────────────────────────────────────────
// src/cognition/agency/restart.ts  —  the restart boundary
// ─────────────────────────────────────────────────────────────
//
// Two different things happen when a Will wakes from a snapshot, and conflating
// them is what made this a recurring class of bug rather than a single one:
//
//   1. TIME must not go backwards. Entities come back stamped with the tick they
//      were written at, so the clock has to resume from the snapshot's tick
//      rather than restart at 0 (WillStem.createWill does this via
//      `clock.setTick`). Otherwise every `tick - stampedTick` in the codebase —
//      42 comparison sites across 19 files — computes a NEGATIVE age, and the
//      guards built on them inverted spectacularly: an awaiting intent whose age
//      read -589 could never time out, and the selector's staleness decay
//      `1 - staleness × STALE_DECAY` became `1 + 19.6`, AMPLIFYING an incumbent
//      from 0.47 to 9.74 and making it permanently unpreemptable.
//
//   2. Work that was IN FLIGHT does not resume. Resuming the clock fixes the
//      arithmetic but says nothing about the semantics: an action dispatched
//      moments before hibernation is not still dispatched hours later, and the
//      window in which the world might have echoed our own words has closed.
//      Leaving these behind is worse under a resumed clock than under a reset
//      one, because they now look plausibly RECENT — an awaiting intent would be
//      reconciled as a genuine timeout, teaching the mind that reaching that
//      person does not work, when all that happened is that it slept.
//
// This module owns (2): what the agency considers in-flight, and therefore what
// must not cross the boundary. It is deliberately a short, explicit list rather
// than a heuristic — anything the agency stamps with a tick and expects to
// resolve within a few of them belongs here.
// ─────────────────────────────────────────────────────────────

import { CONSEQUENCE_TYPE } from '#agency/consequence'

/** Entity type of a committed action awaiting the world's answer. */
const INTENT_TYPE = 'agency.intent'

/**
 * Ids of the restored entities that represent work in flight when the mind went
 * to sleep. Pure — the caller drops them.
 *
 *   • `agency.intent` with status 'awaiting' — dispatched, never answered. It is
 *     ABANDONED, not failed: sleeping is not the world declining to answer, and
 *     recording a failure here would teach reafference a lesson about the process
 *     lifecycle rather than about the action.
 *   • `agency.consequence` — the expected sensory footprint of an act, used both
 *     to recognise our own echo (P2) and to damp repeating ourselves (P5). Its
 *     TTL is a handful of ticks; across a sleep the echo will never arrive, and a
 *     stale one both mis-attributes genuine replies as self-caused and suppresses
 *     contact that should now be free to happen.
 *
 * A `selected` intent is deliberately NOT cleared: it has not been dispatched, so
 * it is still an intention the mind holds rather than an action in flight.
 */
export function inFlightOnRestore(
  entities: ReadonlyMap<string, { type: string; metadata?: Record<string, unknown> }>,
): string[] {
  const drop: string[] = []

  for( const [ id, e ] of entities ){
    if( e.type === CONSEQUENCE_TYPE ){ drop.push( id ); continue }
    if( e.type === INTENT_TYPE && e.metadata?.['status'] === 'awaiting') drop.push( id )
  }

  return drop
}

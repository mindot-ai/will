// ─────────────────────────────────────────────────────────────
// src/agency/settlement.ts  —  having thought about it
// ─────────────────────────────────────────────────────────────
//
// The agency has always been able to represent having ACTED. It could not
// represent having DECIDED.
//
// System 2 is recruited when the field is ambiguous — `margin < marginGate` in
// the ActionSelector, where margin is the activation gap between the top two
// affordances. The DeliberationEngine then resolves the contest and writes back
// exactly one thing: that intent flipped to 'selected', carrying `deliberated:
// true`. Nothing reads `deliberated`. The synthesizer rebuilds the field from
// scratch next tick, the same rivals score the same, the margin is again below
// the gate, and the same question is deliberated again.
//
// Measured on a live COO over 7 hours: 149 deliberations, median gap between
// them 17 seconds, 139 of 148 gaps under a minute — one LLM call every ~3 ticks
// for the whole run, and the single largest line in her cost. She could see it
// and had no mechanism to leave it:
//
//   "Nothing has changed since my last ten deliberation cycles. Goal-7 is
//    externally blocked — this is a fact, not a diagnosis I need to reach again."
//   "I have composed the same message to FKEM across twelve deliberation cycles
//    and not sent it."
//   "There is nothing left to deliberate. I am looking."
//
// So: a settlement is the trace a verdict leaves in the field it was called in
// to resolve. It is the missing peer of a family the engine already has —
// having acted damps re-acting (`justEnacted`), having spoken damps re-speaking
// (`spokeAnywhereAt`), having committed can be withdrawn (revocation
// tombstones) — and having thought damped nothing at all.
//
// The mechanism is deliberately ONE quantity doing both jobs. Raising the
// settled option's activation means (a) the verdict has force, so System 1 does
// not coin-flip its way to a different answer on the next tick of the same flat
// field, and (b) the margin to the runner-up widens past the gate, so System 2
// is not recruited for a question it has already answered. The flatness is what
// summoned deliberation; the verdict is what gives the field the shape it
// lacked.
//
// And it DECAYS, like everything else here. This is a refractory period, not a
// lock — the user's objection to "a hard conditional gate that does not promise
// any flexibility or dynamism of the mind" is the whole design constraint. As
// the settlement ages the field flattens again and the question genuinely
// re-opens; a rupture revokes it outright through the machinery that already
// exists. A mind may always change its mind. It should not have to reach the
// same conclusion every three seconds to keep holding it.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export const SETTLEMENT_TYPE = 'agency.settlement'

/**
 * Ticks a verdict holds before the question is genuinely open again.
 *
 * Set to the satiation window rather than the echo window, and the symmetry is
 * the argument: having thought about something should hold about as long as
 * having done it. The echo window (`CONSEQUENCE_TTL_TICKS`, 30) answers "could
 * the world still be replying to me" — a different and necessarily shorter
 * question that has nothing to do with whether a choice is settled.
 *
 * At the COO's observed rate (~5s/tick) this is roughly five minutes of held
 * verdict, against a mind that was re-deciding every three ticks.
 */
export const SETTLEMENT_TTL_TICKS = 60

export interface SettlementDescriptor {
  /** The act that won the contest. */
  schema:          string
  /** Its object, when it has one — keyed exactly as satiation is, on purpose. */
  targetEntityId?: string
  /**
   * The rivals it was weighed against.
   *
   * Not used for matching — a settlement is keyed on what WON, so a slightly
   * differently-framed contest still meets a verdict the mind has already
   * reached. Carried because "I decided this over that" is the introspectable
   * fact, and a settlement with no memory of what it beat is a preference with
   * no reason attached.
   */
  over?:           readonly string[]
  tick:            Tick
  expiresAt:       Tick
}

/** Stable id — one settlement per (schema, target), so re-deciding refreshes it. */
export function settlementId( schema: string, targetEntityId?: string ): string {
  return `agency-settlement-${ schema }${ targetEntityId ? `-${ targetEntityId }` : '' }`
}

/** Build the settlement entity. Ordinary state, so it snapshots and replays (FN9). */
export function settlementEntity( d: SettlementDescriptor ): EntityInput {
  return {
    id:   settlementId( d.schema, d.targetEntityId ),
    type: SETTLEMENT_TYPE,
    metadata: { ...d, ...( d.over ? { over: [ ...d.over ] } : {} ) },
  }
}

/**
 * Read a settlement back off entity metadata.
 *
 * Decoded field-for-field, including `over`. A value written by one side and
 * never read by the other is the defect shape this codebase has now hit six
 * times, and it is the exact defect this module exists to fix — `deliberated:
 * true` was written on every deliberated intent and read by nobody.
 */
export function readSettlement(
  m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined,
): SettlementDescriptor | null {
  const meta = ( m instanceof Map ? Object.fromEntries( m ) : m ?? {} ) as Record<string, unknown>
  const schema = typeof meta['schema'] === 'string' ? meta['schema'] as string : undefined
  if( !schema ) return null

  const over = Array.isArray( meta['over'] )
    ? ( meta['over'] as unknown[] ).filter( ( x ): x is string => typeof x === 'string' )
    : undefined

  return {
    schema,
    targetEntityId: typeof meta['targetEntityId'] === 'string' ? meta['targetEntityId'] as string : undefined,
    ...( over && over.length > 0 ? { over } : {} ),
    tick:      typeof meta['tick']      === 'number' ? meta['tick']      as number : 0,
    expiresAt: typeof meta['expiresAt'] === 'number' ? meta['expiresAt'] as number : 0,
  }
}

/** The live (unexpired) settlements in frozen state, in stable id order. */
export function liveSettlements(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  tick:     Tick,
): SettlementDescriptor[] {
  const out: Array<{ id: string; d: SettlementDescriptor }> = []

  for( const [ id, e ] of entities ){
    if( e.type !== SETTLEMENT_TYPE ) continue
    const d = readSettlement( e.metadata )
    if( !d ) continue
    // Stamped LATER than now ⇒ restored from a previous session, where the tick
    // counter restarts at 1 on wake. Without this a woken mind reads every
    // settlement it ever made as freshly decided and cannot deliberate at all.
    // The same trap `liveConsequences` documents, and the same fix.
    if( d.tick > tick ) continue
    if( tick < d.expiresAt ) out.push({ id, d })
  }

  return out.sort( ( a, b ) => ( a.id < b.id ? -1 : a.id > b.id ? 1 : 0 ) ).map( x => x.d )
}

/** Settlement ids that have aged out — swept by the DeliberationEngine. */
export function expiredSettlementIds(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  tick:     Tick,
): string[] {
  const out: string[] = []
  for( const [ id, e ] of entities ){
    if( e.type !== SETTLEMENT_TYPE ) continue
    const d = readSettlement( e.metadata )
    if( d && tick >= d.expiresAt ) out.push( id )
  }
  return out
}

/**
 * How much of a verdict on this (schema, target) is still standing, 1 → 0.
 *
 * Linear decay over the window, matching `enactionFootprint` — the two are
 * mirror images and should feel the same from inside: one is the fading pull
 * not to repeat an act, this is the fading weight of having already chosen.
 *
 * An objectless act matches an objectless settlement only. Deciding to `rest`
 * says nothing about whether to `reach-out` to Ada, and a verdict that leaked
 * across objects would be a mind that mistakes one question for another.
 */
export function settlementForce(
  settlements:    readonly SettlementDescriptor[],
  schema:         string,
  targetEntityId: string | undefined,
  tick:           Tick,
  windowTicks:    number = SETTLEMENT_TTL_TICKS,
): number {
  if( windowTicks <= 0 ) return 0

  let strongest = 0
  for( const s of settlements ){
    if( s.schema !== schema || s.targetEntityId !== targetEntityId ) continue
    const remaining = ( windowTicks - ( tick - s.tick ) ) / windowTicks
    if( remaining > strongest ) strongest = remaining
  }

  return strongest < 0 ? 0 : strongest > 1 ? 1 : strongest
}

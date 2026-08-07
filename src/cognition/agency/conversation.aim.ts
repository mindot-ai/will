// ─────────────────────────────────────────────────────────────
// src/agency/conversation.aim.ts  —  did the words achieve what they were for?
// ─────────────────────────────────────────────────────────────
//
// A communicative act has an AIM that is not its EXECUTION. Sending succeeded;
// that is a fact about the channel. Whether anyone answered is a fact about the
// world, it arrives later, and until this module existed nothing in the mind
// represented it.
//
// The cost of not representing it, measured on a live Will: `agency.skill` for
// `reach-out` read `enactments 28, successes 28` — a 100% success rate, because
// the outbox accepted every one. Habit (0.78) and value (0.5) therefore rose with
// each repetition while the only opposing term, satiation, is bounded and decays.
// The mind asked one person the same question eleven times in two and a half
// minutes and, from the inside, every one of them was the first: it could see
// `✓ reach-out` in its recent outcomes and nothing at all about being ignored.
//
// So this is not a rule against repeating. It is the missing PERCEPT. The mind
// gets to know that it spoke and was not answered; what to do about that is its
// own business — a person who has been ignored twice may well try a third time,
// and should be able to, having noticed.
//
// Everything here is pure and tick-denominated: no wall clock, no RNG, no state
// writes. Ids and decisions stay identical between a recorded run and its replay
// (R2). The resolution is folded into state by ReafferenceEngine, which already
// owns the question "did the world confirm my act?".
// ─────────────────────────────────────────────────────────────

import type { Tick } from '#core/types'

export const SENT_TYPE     = 'conversation.sent'
export const RECEIVED_TYPE = 'conversation.received'

/**
 * How long the mind waits before it counts a silence as an answer in itself.
 *
 * Deliberately much longer than the echo window (`CONSEQUENCE_TTL_TICKS`, 30), a
 * motor await (`AWAIT_TIMEOUT`, 15), or satiation (`repeatWindowTicks`, 60).
 * Those ask "did my act leave the building?" and "does saying it again feel right
 * yet?"; this asks "did a person get back to me?", and people take their time. At
 * the 1s tick a hosted Will actually runs on, 240 is four minutes — long enough
 * that a silence is genuinely a silence and not somebody typing.
 *
 * Tuned through the persona prior rather than fixed, because how long a quiet
 * takes to mean something is a trait — the same reason `facetIdleTtlTicks` and
 * `repeatWindowTicks` are not constants.
 */
export const DEFAULT_REPLY_WINDOW_TICKS = 240

/** Minimal shape this module needs off a state entity — keeps it testable without a StateManager. */
export interface EntityLike {
  type:     string
  tick?:    number
  metadata?: ReadonlyMap<string, unknown> | Record<string, unknown>
}

/** One thing the mind said to one person, and what became of it. */
export interface SpokenTurn {
  entityId:         string
  targetEntityId:   string
  targetEntityName?: string
  preview:          string
  tick:             Tick
  /** Set once the target has spoken after this turn. */
  answeredAt?:      Tick
  /** Set once the reply window closed on a silence — recorded so it is announced once, not every tick. */
  unansweredAt?:    Tick
  /** An acknowledgement closes a turn rather than opening one; it awaits nothing. */
  isAck:            boolean
}

function meta( e: EntityLike ): Record<string, unknown> {
  const m = e.metadata
  if( !m ) return {}
  return m instanceof Map ? Object.fromEntries( m ) : m as Record<string, unknown>
}
function str( v: unknown ): string | undefined { return typeof v === 'string' ? v : undefined }
function num( v: unknown ): number | undefined {
  return typeof v === 'number' && Number.isFinite( v ) ? v : undefined
}

/**
 * Every `conversation.sent` in state, as turns.
 *
 * The tick comes from `metadata.tick` where the writer set one, else the entity's
 * own tick — `StateManager.setEntity` stamps that from the sim clock on every
 * write. The fallback is not decoration: the two writers (ProactiveCommunicator
 * and AuditionEngine) disagree about which they fill, and defaulting to 0 made
 * every record of the second kind look infinitely old. Same rule as
 * `spokenAtByEntity`, deliberately.
 */
export function readSpokenTurns( entities: ReadonlyMap<string, EntityLike> ): SpokenTurn[] {
  const out: SpokenTurn[] = []
  for( const [ id, e ] of entities ){
    if( e.type !== SENT_TYPE ) continue
    const m      = meta( e )
    const target = str( m['targetEntityId'] )
    if( !target ) continue
    out.push({
      entityId:         id,
      targetEntityId:   target,
      targetEntityName: str( m['targetEntityName'] ),
      preview:          str( m['preview'] ) ?? '',
      tick:             ( num( m['tick'] ) ?? num( e.tick ) ?? 0 ) as Tick,
      answeredAt:       num( m['answeredAt'] )   as Tick | undefined,
      unansweredAt:     num( m['unansweredAt'] ) as Tick | undefined,
      isAck:            m['isAck'] === true,
    })
  }
  // Stable, deterministic order: oldest first, ties broken by id so two turns on
  // one tick never swap between a run and its replay.
  return out.sort( ( a, b ) => a.tick - b.tick || ( a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0 ) )
}

/**
 * When each person last spoke TO the mind, from `conversation.received`.
 *
 * This is the evidence that an utterance was answered. It is deliberately the
 * whole of the evidence: any turn from them after we spoke counts, without trying
 * to decide whether it was *about* what we said. Matching on topic would be a
 * guess dressed as a fact, and getting it wrong in the strict direction would
 * teach the mind it is being ignored by someone who is talking to it.
 */
export function lastHeardByEntity( entities: ReadonlyMap<string, EntityLike> ): Map<string, Tick> {
  const out = new Map<string, Tick>()
  for( const [ , e ] of entities ){
    if( e.type !== RECEIVED_TYPE ) continue
    const m      = meta( e )
    const source = str( m['sourceKeid'] )
    if( !source ) continue
    const at = ( num( m['tick'] ) ?? num( e.tick ) ?? 0 ) as Tick
    if( at > ( out.get( source ) ?? -Infinity ) ) out.set( source, at )
  }
  return out
}

/** A turn still in the air: said, not acknowledged-only, and not yet answered. */
export function isOpen( t: SpokenTurn ): boolean {
  return !t.isAck && t.answeredAt === undefined
}

export interface Resolution {
  /** Turns the target has now answered — fold `answeredAt` into them. */
  answered:   Array<{ turn: SpokenTurn; at: Tick }>
  /** Turns whose reply window closed in silence, newly, this tick. */
  unanswered: SpokenTurn[]
}

/**
 * Fold the world's answer (or its absence) onto the turns still in the air.
 *
 * Pure: reads frozen state, writes nothing, decides nothing about what the mind
 * should do next. A turn resolves exactly once — `answeredAt`/`unansweredAt` are
 * the latches, so the announcement fires on one tick rather than every tick for
 * the rest of the session.
 *
 * A silence is only reported once the window has fully elapsed. Before that the
 * turn is simply open, which is a third state and the honest one: not yet
 * answered is not the same as ignored, and collapsing them would have the mind
 * conclude it was being snubbed one tick after speaking.
 */
export function resolveReplyExpectations(
  entities:    ReadonlyMap<string, EntityLike>,
  tick:        Tick,
  windowTicks: number = DEFAULT_REPLY_WINDOW_TICKS,
): Resolution {
  const turns     = readSpokenTurns( entities )
  const lastHeard = lastHeardByEntity( entities )

  const answered:   Resolution['answered'] = []
  const unanswered: SpokenTurn[]           = []

  for( const t of turns ){
    if( t.isAck || t.answeredAt !== undefined ) continue

    const heard = lastHeard.get( t.targetEntityId )
    if( heard !== undefined && heard > t.tick ){
      answered.push({ turn: t, at: heard })
      continue
    }

    // Already announced as a silence — stays open, but says nothing more.
    if( t.unansweredAt !== undefined ) continue
    // A turn stamped LATER than now came back with a restored snapshot whose tick
    // counter has not caught up. Reading it as `tick - t.tick` negative would make
    // it trivially "not yet due" forever, which is the benign direction, but a
    // window <= 0 would then fire on everything at once. Guard both.
    if( windowTicks > 0 && tick - t.tick >= windowTicks ) unanswered.push( t )
  }

  return { answered, unanswered }
}

/**
 * The turns worth showing the mind: still in the air, newest first, capped.
 *
 * This is what makes repetition visible from the inside. `conversation.sent` has
 * always been in state — 57 records on the Will above — and reached no prompt at
 * all, so the mind's only view of having spoken was `✓ reach-out` under "Recent
 * Action Outcomes": a tick mark, no words, no person, no silence.
 */
export function openTurns(
  entities: ReadonlyMap<string, EntityLike>,
  limit:    number = 6,
): SpokenTurn[] {
  return readSpokenTurns( entities ).filter( isOpen ).reverse().slice( 0, limit )
}

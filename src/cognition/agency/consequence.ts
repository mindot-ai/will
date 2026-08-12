// ─────────────────────────────────────────────────────────────
// src/agency/consequence.ts  —  expected-consequence descriptors
// ─────────────────────────────────────────────────────────────
//
// EXAFFERENCE P1. The efference copy predicts an action's *reward*; a
// consequence descriptor predicts its *sensory footprint* — what the world will
// look like because we acted. The MotorSchemaExecutor registers one at the
// enaction moment for world-facing actions only (delivered communicate, or the
// async communicate/external hold); sync innate enactions have internal effects
// and get none. Descriptors are ordinary entities, so they snapshot/restore and
// replay with the state (FN9), and they expire on a tick-denominated TTL that
// deliberately OUTLIVES intent resolution — a host ack does not stop the
// channel echo from arriving two ticks later.
//
// Dark in P1: written and expired, consumed by nothing. P2's corollary-
// discharge matcher reads them to tag percept provenance
// ('reafferent' | 'exafferent') and attenuate self-caused salience.
// Matching stays deterministic: FNV-1a content hashes, no clocks, no RNG.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export const CONSEQUENCE_TYPE = 'agency.consequence'

/** Salience multiplier applied to a matched (reafferent) percept — attenuated,
 *  not zeroed: a *surprising* consequence of our own action can still climb. */
export const ATTENUATION = 0.25

/** Minimum descriptor-text length for substring matching — below this a
 *  containment hit is too cheap to mean "these are my own words". */
export const MIN_TEXT_MATCH_LEN = 12

/**
 * Ticks a descriptor stays live — 2 × the executor's `AWAIT_TIMEOUT`, so a
 * descriptor survives both a stranded await (15 ticks) and the late sensory
 * echo of an already-reconciled action.
 */
export const CONSEQUENCE_TTL_TICKS = 30

export interface ConsequenceDescriptor {
  /** The enacting intent — sensory reafference can reconcile to it (P5). */
  intentId:        string
  schema:          string
  mode:            'communicate' | 'external'
  /** Communication effector name (talk/text/gesture/broadcast), when known. */
  effector?:       string
  targetEntityId?: string
  /** FNV-1a over the authored outbound text (delivered communicate). */
  textHash?:       number
  /** The authored outbound text itself — enables substring matching on echoes
   *  that arrive decorated ("Alice said: …"). Internal state, never emitted. */
  text?:           string
  /** FNV-1a over the canonicalized parameters (async dispatch). */
  paramsHash?:     number
  /**
   * Dispatched but NOT YET PERFORMED — a communicate held awaiting words that do
   * not exist yet.
   *
   * The footprint is written when an intent goes to the async hold, which for an
   * EXTERNAL effector is the act itself (the host is doing it now, and asking
   * twice while waiting is the thing satiation should prevent). For a communicate
   * it is not: the facet has not authored anything, and the mind has said nothing.
   *
   * Counting it as satiation meant ATTEMPTING to speak silenced the mind exactly
   * as hard as speaking. Dormant until `justEnacted` first reached the
   * competition, then immediately visible: a live COO willed `reach-out` 63 times
   * in four minutes, delivered NOTHING, and 18 of those lost to `justEnacted`
   * readings of 0.93–0.98 against a mind that had not spoken once that run. Each
   * attempt wrote a fresh footprint, so the damping never decayed.
   *
   * P2's echo matching is unaffected — a pending descriptor carries no text to
   * match on, which is the same fact from the other side.
   */
  pending?:        boolean
  expiresAt:       Tick
  tick:            Tick
}

/** Deterministic 32-bit FNV-1a — the shared content-match key (P2 matcher uses the same). */
export function fnv1a( text: string ): number {
  let h = 0x811c9dc5
  for( let i = 0; i < text.length; i++ ){
    h ^= text.charCodeAt( i )
    h = Math.imul( h, 0x01000193 ) >>> 0
  }
  return h >>> 0
}

/**
 * Canonicalize parameters into a stable string before hashing: keys sorted
 * recursively so `{a,b}` and `{b,a}` produce the same key. Deterministic and
 * cheap; not a serialization format (never parsed back).
 */
export function paramsKey( value: unknown ): string {
  if( value === null || typeof value !== 'object')
    return typeof value === 'string' ? JSON.stringify( value ) : String( value )
  if( Array.isArray( value ) )
    return `[${ value.map( paramsKey ).join(',') }]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys( obj ).sort()
  return `{${ keys.map( k => `${ k }:${ paramsKey( obj[k] ) }` ).join(',') }}`
}

/** Build the descriptor entity (id keyed by intent — one footprint per enaction). */
export function consequenceEntity( d: ConsequenceDescriptor ): EntityInput {
  return {
    id:   `agency-consequence-${ d.intentId }`,
    type: CONSEQUENCE_TYPE,
    metadata: { ...d },
  }
}

/** Read a descriptor back off entity metadata (P2 matcher + tests). */
export function readConsequence(
  m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined,
): ConsequenceDescriptor | null {
  const meta = ( m ?? {} ) as Record<string, unknown>
  const intentId = typeof meta['intentId'] === 'string' ? meta['intentId'] as string : undefined
  const schema   = typeof meta['schema']   === 'string' ? meta['schema']   as string : undefined
  const mode     = meta['mode'] === 'communicate' || meta['mode'] === 'external' ? meta['mode'] : undefined
  if( !intentId || !schema || !mode ) return null
  return {
    intentId, schema, mode,
    effector:       typeof meta['effector']       === 'string' ? meta['effector']       as string : undefined,
    targetEntityId: typeof meta['targetEntityId'] === 'string' ? meta['targetEntityId'] as string : undefined,
    textHash:       typeof meta['textHash']       === 'number' ? meta['textHash']       as number : undefined,
    text:           typeof meta['text']           === 'string' ? meta['text']           as string : undefined,
    paramsHash:     typeof meta['paramsHash']     === 'number' ? meta['paramsHash']     as number : undefined,
    // Decoded, not just written — a field only one side knows about is the shape
    // of defect this codebase has hit five times now.
    pending:        meta['pending'] === true ? true : undefined,
    expiresAt:      typeof meta['expiresAt']      === 'number' ? meta['expiresAt']      as number : 0,
    tick:           typeof meta['tick']           === 'number' ? meta['tick']           as number : 0,
  }
}

// ── P2: the corollary-discharge matcher ──────────────────────────────────────

/** Collect the live (unexpired) descriptors from frozen state, in stable id order. */
export function liveConsequences(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  tick:     Tick,
): ConsequenceDescriptor[] {
  const out: ConsequenceDescriptor[] = []
  for( const [ , e ] of entities ){
    if( e.type !== CONSEQUENCE_TYPE ) continue
    const d = readConsequence( e.metadata )
    if( !d ) continue
    // A descriptor stamped LATER than now came from a previous session: descriptors
    // snapshot with the state, and the tick counter restarts at 1 on wake. Without
    // this the expiry test (`tick < expiresAt`) reads every restored descriptor as
    // freshly live — measured: a Will woke at tick 1 holding three reach-out
    // descriptors stamped 575–596 with expiry 605–626, so for the WHOLE session it
    // believed it had just messaged that person moments ago. It damped every
    // reach-out to them and delivered nothing, and the P2 matcher would equally
    // have attenuated their genuine replies as its own echo.
    if( d.tick > tick ) continue
    if( tick < d.expiresAt ) out.push( d )
  }
  return out.sort( ( a, b ) => ( a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0 ) )
}

/**
 * High-precision text matching only (P2): a candidate text is *ours* when it
 * hashes exactly to a descriptor's outbound text, or contains that text
 * verbatim (echoes arrive decorated — "Alice said: …"). Deliberately NO
 * entity-correspondence matching for external effectors yet: over-attribution
 * (muting a genuine world event) is the dangerous direction; under-attribution
 * is the status quo. Pure, deterministic, first match in stable order wins.
 */
export function matchConsequenceText(
  descriptors: readonly ConsequenceDescriptor[],
  candidate:   string,
): ConsequenceDescriptor | null {
  if( candidate.length === 0 ) return null
  const candidateHash = fnv1a( candidate )
  for( const d of descriptors ){
    if( d.textHash !== undefined && d.textHash === candidateHash ) return d
    if( d.text !== undefined && d.text.length >= MIN_TEXT_MATCH_LEN && candidate.includes( d.text ) ) return d
  }
  return null
}

// ── P5: the act's own footprint, felt as satiation ───────────────────────────

/**
 * How much of an act's own footprint is still live for this (schema, target),
 * 1 → 0 as the descriptor ages out. 0 when nothing matching is in flight.
 *
 * This is the consumer #112 always described and the descriptors never had. A
 * delivered message wrote its footprint here and nothing ever read it back, so
 * the standing `ideomotor.intent` that produced it kept re-winning the
 * competition and the same words went out again — observed three times, ~21
 * ticks apart, to the same person, while the mind believed each was the first.
 *
 * Deliberately a decaying quantity, not a lock. Right after acting it is ~1 and
 * the pull to repeat is strongly damped; as the window in which the world could
 * still answer runs out it returns to 0 and the appetite comes back on its own.
 * That is a refractory period, not a rule: the mind may still repeat itself if
 * something has become pressing enough to out-compete the damping, which is
 * exactly what a person does when the silence starts to matter.
 *
 * Matches on (schema, target) rather than on the words, because at the moment
 * the competition runs the words do not exist yet — a facet authors them later.
 * "I have just reached out to this person and do not yet know how it landed" is
 * the honest predicate, and it is the one that governs whether to speak again.
 */
export function enactionFootprint(
  descriptors:    readonly ConsequenceDescriptor[],
  schema:         string,
  targetEntityId: string | undefined,
  tick:           Tick,
  windowTicks:    number = CONSEQUENCE_TTL_TICKS,
  /**
   * Tick of the last thing SAID to each entity, from `conversation.sent`.
   *
   * Descriptors cannot carry satiation on their own: the executor deletes them at
   * `tick >= expiresAt` (motor.schema.executor's TTL sweep), so nothing survives
   * past the echo window and a satiation window longer than it was silently a
   * no-op. Observed live: the same relay delivered twice with `justEnacted` never
   * once reaching the competition.
   *
   * `conversation.sent` is the durable record of having spoken — written by
   * ProactiveCommunicator at push time, snapshotted with the state, and already
   * what discharges an undertaking. Keyed by person rather than by schema on
   * purpose: having just spoken to someone damps speaking to them again, however
   * that speaking happens to be schematised.
   */
  spokenAt?:      ReadonlyMap<string, number>,
  /**
   * Tick this schema was last enacted — `LearnedSkill.lastEnactedTick`, used for
   * an act with NO OBJECT, where "I have just done this" is the whole of the fact
   * and there is no target to key on.
   *
   * Without it the innate floor could not satiate at all. Every objectless stance
   * returned here at the first line, so `repeat` — the largest damping weight in
   * the competition at 0.30 — was structurally zero for `orient · attend · rest ·
   * withdraw · reflect · wait · express`, while `habit` (+0.20) outweighed the
   * novelty it spends (−0.10). A stance that won once therefore won harder next
   * tick, forever. Measured: `express` at habit 1.0 taking 144 of 145 decisions
   * across 300 quiet ticks, with nothing in the mind able to represent that it had
   * just done it.
   *
   * The skill record is the right source for the same reason `conversation.sent`
   * is for speaking: descriptors are swept at the echo TTL, and `agency.outcome`
   * is consumed and deleted the tick after it is written, so neither survives a
   * satiation window. `lastEnactedTick` is durable and snapshotted.
   */
  selfEnactedAt?: number,
  /**
   * Tick this mind last SPOKE — to anyone. Supplied only for a speaking act, and
   * satiating over the shorter echo window rather than the full repeat window.
   *
   * Satiation was keyed entirely by listener, so "I have already said this" had
   * no bearing once the listener changed. Live, a COO drafted one scoping
   * outline and put substantially the same thing into three destinations inside
   * three minutes — general, a DM, a second channel — with nothing damping it,
   * because each was a different key. She could SEE it: `## What I've Said
   * Lately` listed her own turns across all targets and she posted again 31
   * seconds later. The record was there; the pull had no opposing force.
   *
   * Deliberately WEAKER than the per-person arm, via the shorter window: telling
   * a second person something is legitimate and must stay cheap, while saying it
   * again to someone who already heard it should not be. And deliberately from
   * `conversation.sent` — what was actually SAID — not from the schema's
   * `lastEnactedTick`, which also counts attempts that authored no words and
   * would let a run of declined outreach satiate the mind into silence.
   *
   * Replies are unaffected: an answer to an inbound message is delivered by the
   * audition facet through the outbox and never enters this competition. This
   * damps only self-initiated outreach — which is exactly what broadcasting is.
   */
  spokeAnywhereAt?: number,
): number {
  if( windowTicks <= 0 ) return 0

  if( !targetEntityId ){
    if( selfEnactedAt === undefined ) return 0
    const remaining = ( windowTicks - ( tick - selfEnactedAt ) ) / windowTicks
    return remaining < 0 ? 0 : remaining > 1 ? 1 : remaining
  }

  let strongest = 0

  const spoken = spokenAt?.get( targetEntityId )
  if( spoken !== undefined ){
    const remaining = ( windowTicks - ( tick - spoken ) ) / windowTicks
    if( remaining > strongest ) strongest = remaining
  }

  // Having just spoken AT ALL — the arm that is not about the listener. Over the
  // echo window, so it is real but short: a second person is cheap to tell, a
  // third destination in ninety seconds is not. See `spokeAnywhereAt`.
  if( spokeAnywhereAt !== undefined ){
    const remaining = ( CONSEQUENCE_TTL_TICKS - ( tick - spokeAnywhereAt ) ) / CONSEQUENCE_TTL_TICKS
    if( remaining > strongest ) strongest = remaining
  }

  for( const d of descriptors ){
    if( d.schema !== schema || d.targetEntityId !== targetEntityId ) continue
    // You cannot be satiated by something you have not done. See `pending`.
    if( d.pending ) continue
    // Measured from when the act happened, against the SATIATION window — not from
    // the descriptor's own expiry, which is the echo window and a different
    // question. Conflating them meant "how long before I say this again" was
    // pinned to "how long until the world's reply could still arrive", and the
    // second is necessarily short. Observed: re-deliveries landing ~25 ticks
    // apart against a 30-tick echo TTL, so the damping had decayed to almost
    // nothing exactly when the next impulse arrived.
    const elapsed   = tick - d.tick
    const remaining = ( windowTicks - elapsed ) / windowTicks
    if( remaining > strongest ) strongest = remaining
  }

  return strongest < 0 ? 0 : strongest > 1 ? 1 : strongest
}

/**
 * When the mind last SAID something to each person, from the durable
 * `conversation.sent` records. Feeds `enactionFootprint`'s satiation.
 *
 * Unlike consequence descriptors these are never swept, so satiation can run on
 * whatever window the persona wants rather than being capped by the echo TTL.
 */
export function spokenAtByEntity(
  entities: ReadonlyMap<string, { type: string; updatedAtTick?: number; tick?: number; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
): Map<string, number> {
  const out = new Map<string, number>()

  for( const [ , e ] of entities ){
    if( e.type !== 'conversation.sent') continue
    const m      = ( e.metadata ?? {} ) as Record<string, unknown>
    const target = typeof m['targetEntityId'] === 'string' ? m['targetEntityId'] as string : undefined
    if( !target ) continue
    // `metadata.tick` where the writer set one, else the entity's own tick, which
    // StateManager.setEntity stamps from the sim clock on every write. The fallback
    // matters: not every path that records having spoken fills the metadata field,
    // and defaulting to 0 made every record look infinitely old.
    // `updatedAtTick` is the field `StateManager.setEntity` actually stamps.
    // This read `e.tick`, which does not exist on SimulationEntity — so the
    // fallback the comment above describes has never once fired, and any writer
    // that omitted `metadata.tick` was treated as having spoken at tick 0, i.e.
    // infinitely long ago, i.e. not satiating at all.
    const at = typeof m['tick']          === 'number' ? m['tick'] as number
             : typeof e.updatedAtTick    === 'number' ? e.updatedAtTick
             : typeof e.tick             === 'number' ? e.tick
             : 0
    if( at > ( out.get( target ) ?? -Infinity ) ) out.set( target, at )
  }

  return out
}

// ── ACP-P1: entity correspondence (ACTION_CONDITIONED_PREDICTION §2) ─────────

/** Salience multiplier for an entity-correspondence match — gentler than a
 *  text match (0.25): the change is on our action's target while its
 *  descriptor lives, but we are less certain it is ours. */
export const CORRESPONDENCE_ATTENUATION = 0.5

/**
 * A live **external**-mode descriptor is a standing prediction that its
 * `targetEntityId` is about to change *because of us*. A `modified` percept on
 * exactly that entity is claimed as reafference (an `appeared` entity is new
 * information, not our footprint). Communicate descriptors are excluded — the
 * text path owns them. First match in stable order; pure.
 */
export function matchConsequenceEntity(
  descriptors: readonly ConsequenceDescriptor[],
  entityId:    string,
  changeType:  string,
): ConsequenceDescriptor | null {
  if( changeType !== 'modified' || entityId.length === 0 ) return null
  for( const d of descriptors )
    if( d.mode === 'external' && d.targetEntityId === entityId ) return d
  return null
}

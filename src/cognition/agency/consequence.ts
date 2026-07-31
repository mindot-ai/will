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
): number {
  if( !targetEntityId ) return 0

  let strongest = 0
  for( const d of descriptors ){
    if( d.schema !== schema || d.targetEntityId !== targetEntityId ) continue
    const remaining = ( d.expiresAt - tick ) / CONSEQUENCE_TTL_TICKS
    if( remaining > strongest ) strongest = remaining
  }

  return strongest < 0 ? 0 : strongest > 1 ? 1 : strongest
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

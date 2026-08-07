// ─────────────────────────────────────────────────────────────
// src/cognition/social.identity.ts  —  what something IS, vs where to find it
// ─────────────────────────────────────────────────────────────
//
// A `keid` used to be minted by the transport: `discord:${author.id}`,
// `whatsapp:${userId}`. Identity WAS the address, and whichever channel spoke
// first won the right to name the person. Everything downstream inherited that:
// twenty-two files key off a keid, so the same human met on two channels was two
// people to the reputation tracker, the theory-of-mind model, the attachment
// bond and the PMA — with no way to notice, and no way to say so.
//
// It also made "how should I reach them?" unaskable. There was exactly one id
// and it WAS a route, so the question collapsed into a roster guess about where
// the person was last seen. Live, that sent a follow-up promised in a DM into a
// public channel, because the roster's last-seen answer is not the same question
// as "where did I promise this".
//
// So identity and route are separated here:
//
//   ke:<opaque>       — a referent. Never a route. The anchor everything hangs on.
//   handle            — a way that referent has been reachable, with the
//                       circumstances under which it worked.
//
// Deliberately NOT social-only. `keid` has always stood for *known entity* id and
// the dossier has carried `kind: 'sentient' | 'thing'` since it shipped; the
// first cut of this minted `person:` ids, which was a narrower word than the
// system already used. A document, a repo, a dashboard, a room each have a what
// and a where, and the where can change while the what stays put.
//
// This is closer to how a person actually holds it. You know someone; you know
// places; and separately you know where you usually find whom. Three things that
// compose, not one contact record — which is why a handle carries evidence
// (`lastAnsweredTick`) rather than a priority number somebody configured.
//
// Everything here is pure and deterministic. `mintReferentId` hashes the first
// transport id ever seen for that referent, so a recorded run and its replay mint
// the same id (R2) — no clock, no counter, no RNG.
// ─────────────────────────────────────────────────────────────

import type { Tick } from '#core/types'
import { fnv1a } from '#agency/consequence'

/**
 * Marks an id as a referent rather than an address.
 *
 * `ke` for known-entity, which is what `keid` has always stood for — the
 * vocabulary was never social. The first cut of this minted `person:` ids and
 * that was a narrower word than the system uses: the dossier has carried
 * `kind: 'sentient' | 'thing'` since it shipped, and the split here is not a
 * social idea. It is referent vs. access path, which is how anything is held —
 * you remember the book, and separately that it is on the shelf, on the Kindle,
 * or at the library. A document, a repo, a dashboard, a room all have several
 * routes that come and go while the thing itself stays put.
 */
export const REFERENT_PREFIX = 'ke:'

export const ALIAS_TYPE  = 'known-entity-alias'
export const DOSSIER_TYPE = 'known-entity'

/** True for an anchor, false for a transport address (`discord:…`, `whatsapp:…`). */
export function isReferentId( id: string ): boolean {
  return id.startsWith( REFERENT_PREFIX )
}

/**
 * Mint the anchor for a referent first met at `seedKeid`.
 *
 * Kind is deliberately NOT in the id. It lives on the dossier, because kind is
 * LEARNED and correctable — a handle you took for a bot turns out to be a person.
 * Baked into the id, correcting it would mean re-identifying, and every faculty
 * keyed off that id would lose its history of them at the moment it finally
 * understood what they were.
 *
 * Deterministic by construction: the same first-seen transport id always yields
 * the same referent id, so a replay of a recorded run mints identically and the
 * state hashes match (R2). A counter would drift the moment two runs met people
 * in a different order; a clock or RNG would never match at all.
 *
 * Opaque on purpose. The moment an id is readable as `ke:discord:123`
 * something downstream starts parsing it back into a route, and the separation
 * this whole module exists for quietly stops holding.
 */
export function mintReferentId( seedKeid: string ): string {
  return `${ REFERENT_PREFIX }${ fnv1a( seedKeid ).toString( 36 ) }`
}

/**
 * A way this referent has been reachable, and what happened there.
 *
 * `kind` is the one fact that decides whether a room is the right place for a
 * given utterance, and it was being computed at the Discord edge (`isDM`) and
 * discarded before the mind could see it.
 *
 * `lastAnsweredTick` is evidence, not configuration — it arrives free from the
 * `social.responsiveness` signal. It is what lets the mind prefer the DM because
 * that is where this person actually answers, rather than because a constant in
 * the code says DMs rank higher.
 */
export interface Handle {
  /** The transport address — what a channel bridge can actually deliver to. */
  keid:             string
  /**
   * 'dm' — a private thread. 'room' — somewhere others are listening. Left open
   * for a non-social referent, where the meaningful distinction is a different one.
   */
  kind:             'dm' | 'room' | 'unknown'
  /** The place this handle lives in, once places are dossiers of their own. */
  place?:           string
  /** When the mind last SAID something here. */
  lastUsedTick?:    Tick
  /** When someone last answered it here — the only evidence that this route works. */
  lastAnsweredTick?: Tick
  /** Free-form, so a host can mark what its own vocabulary cares about. */
  tags?:            string[]
}

interface EntityLike {
  type:      string
  metadata?: Record<string, unknown>
}

function str( v: unknown ): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * alias keid → canonical referent id.
 *
 * Every transport address a referent has been met at is an alias of its anchor,
 * which is what lets the twenty-two keid consumers keep working untouched: they
 * still see one opaque string per referent, it is simply no longer a route.
 */
export function readAliases( entities: ReadonlyMap<string, EntityLike> ): Map<string, string> {
  const out = new Map<string, string>()
  for( const [ , e ] of entities ){
    if( e.type !== ALIAS_TYPE ) continue
    const a = str( e.metadata?.['aliasKeid'] )
    const c = str( e.metadata?.['canonicalKeid'] )
    if( a && c ) out.set( a, c )
  }
  return out
}

/** Follow an alias chain to the anchor. Cycle-safe; returns the input when unaliased. */
export function canonicalOf( aliases: ReadonlyMap<string, string>, keid: string ): string {
  const seen = new Set<string>()
  let id = keid
  while( true ){
    const next = aliases.get( id )
    if( !next || next === id || seen.has( next ) ) return id
    seen.add( id )
    id = next
  }
}

/**
 * Resolve anything the mind might name — an anchor, a transport address, or a
 * learned name — to the anchor.
 *
 * ONE resolver, because there were two and they disagreed:
 * `extractKnownEntities` folded aliases (so the prompt showed one person) while
 * `resolveKnownEntity` did not (so willing a reach-out to that same person could
 * resolve to a keid that had been merged away, and the intention evaporated).
 * Same question, two answers, in the same tick.
 *
 * Name matching stays last and exact. It is the weakest evidence here — two
 * people genuinely can share a name — and the KnownEntityTracker's recognition
 * pass already guards fusing them.
 */
export function resolveKeid(
  entities: ReadonlyMap<string, EntityLike>,
  ref:      string,
): string | undefined {
  const needle = ref.trim().toLowerCase()
  if( !needle ) return undefined

  const aliases = readAliases( entities )

  // An anchor or an address named directly.
  const direct = canonicalOf( aliases, ref.trim() )
  for( const [ , e ] of entities )
    if( e.type === DOSSIER_TYPE && str( e.metadata?.['keid'] ) === direct ) return direct

  // Otherwise a keid or a name, case-insensitively, in stable entity order.
  for( const [ , e ] of entities ){
    if( e.type !== DOSSIER_TYPE ) continue
    const keid = str( e.metadata?.['keid'] )
    if( !keid ) continue
    if( keid.toLowerCase() === needle ) return canonicalOf( aliases, keid )
    if( str( e.metadata?.['name'] )?.toLowerCase() === needle ) return canonicalOf( aliases, keid )
  }

  // A known alias whose dossier was absorbed — still a real reference to someone.
  for( const [ alias, canon ] of aliases )
    if( alias.toLowerCase() === needle ) return canon

  return undefined
}

/** The name the mind has learned for this referent, or undefined — never a placeholder. */
export function nameOf( entities: ReadonlyMap<string, EntityLike>, referentId: string ): string | undefined {
  for( const [ , e ] of entities ){
    if( e.type !== DOSSIER_TYPE || str( e.metadata?.['keid'] ) !== referentId ) continue
    return str( e.metadata?.['name'] )?.trim() || undefined
  }
  return undefined
}

/** Every route the mind holds for this referent, most recently answered first. */
export function handlesOf( entities: ReadonlyMap<string, EntityLike>, referentId: string ): Handle[] {
  for( const [ , e ] of entities ){
    if( e.type !== DOSSIER_TYPE || str( e.metadata?.['keid'] ) !== referentId ) continue
    const raw = e.metadata?.['handles']
    if( !Array.isArray( raw ) ) return []
    return ( raw as Handle[] )
      .filter( h => h && typeof h.keid === 'string' )
      .sort( ( a, b ) =>
        ( b.lastAnsweredTick ?? -1 ) - ( a.lastAnsweredTick ?? -1 )
        || ( b.lastUsedTick ?? -1 ) - ( a.lastUsedTick ?? -1 )
        || ( a.keid < b.keid ? -1 : a.keid > b.keid ? 1 : 0 ) )
  }
  return []
}

/**
 * The route to use when the mind has expressed no preference.
 *
 * A DEFAULT, not a decision. Which room to speak in is the mind's call, made
 * from the circumstances it can now see; this only answers "nothing was chosen
 * and the words must still go somewhere" — the case where the alternative is
 * dropping the message.
 *
 * Ordering is evidence-first: somewhere this person has actually answered beats
 * somewhere they have not, and a DM beats a room only as a tiebreak. A live Will
 * lost a promised follow-up into a public channel precisely because its fallback
 * ranked "where I last saw them" above "where they talk to me".
 */
export function defaultHandle( handles: readonly Handle[] ): Handle | undefined {
  if( handles.length === 0 ) return undefined
  const answered = handles.filter( h => h.lastAnsweredTick !== undefined )
  const pool     = answered.length > 0 ? answered : handles
  return pool.find( h => h.kind === 'dm') ?? pool[0]
}

/**
 * Fold a newly-seen address into a person's handle list.
 *
 * Merges rather than appends: meeting someone again in a room already known is
 * not a new way to reach them, it is news about an existing one. Pure — returns
 * a fresh array, so a caller writing it back through `setEntity` cannot
 * accidentally share a mutable reference with frozen state.
 */
export function withHandle( handles: readonly Handle[], next: Handle ): Handle[] {
  const out = handles.filter( h => h.keid !== next.keid )
  const old = handles.find( h => h.keid === next.keid )
  out.push( old ? { ...old, ...next,
    // Never let a fresh sighting erase evidence the old record already held.
    lastUsedTick:     next.lastUsedTick     ?? old.lastUsedTick,
    lastAnsweredTick: next.lastAnsweredTick ?? old.lastAnsweredTick,
    tags: [ ...new Set([ ...( old.tags ?? [] ), ...( next.tags ?? [] ) ]) ],
  } : next )
  return out.sort( ( a, b ) => ( a.keid < b.keid ? -1 : a.keid > b.keid ? 1 : 0 ) )
}

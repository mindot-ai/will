// ─────────────────────────────────────────────────────────────
// tests/unit/social.identity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Who someone IS, separated from where to find them.
 *
 * A `keid` was minted by the transport — `discord:${author.id}` — so identity WAS
 * the address and whichever channel spoke first won the right to name the person.
 * Twenty-two files key off a keid, so one human met on two channels was two
 * people to reputation, theory-of-mind, attachment and the PMA, with no way to
 * notice and no way to say so.
 *
 * It also made "how should I reach them?" unaskable: there was one id and it WAS
 * a route. Live, a follow-up promised in a DM went out to a public channel,
 * because the roster's "where did I last see them" is not the question
 * "where did I promise this".
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REFERENT_PREFIX, isReferentId, mintReferentId, readAliases, canonicalOf,
  resolveKeid, nameOf, handlesOf, defaultHandle, withHandle, type Handle,
} from '#cognition/social.identity'

interface E { type: string; metadata?: Record<string, unknown> }
const world = ( ...rows: Array<[ string, E ]> ): Map<string, E> => new Map( rows )

const dossier = ( keid: string, extra: Record<string, unknown> = {} ): [ string, E ] =>
  [ `ke-${ keid }`, { type: 'known-entity', metadata: { keid, ...extra } } ]
const alias = ( a: string, canon: string ): [ string, E ] =>
  [ `kea-${ a }`, { type: 'known-entity-alias', metadata: { aliasKeid: a, canonicalKeid: canon } } ]

// ── the anchor ───────────────────────────────────────────────

describe('a referent id is an identity, never a route', () => {
  it('is recognisable as an anchor', () => {
    expect( isReferentId( mintReferentId('discord:123') ) ).toBe( true )
    expect( isReferentId('discord:123') ).toBe( false )
    expect( mintReferentId('discord:123').startsWith( REFERENT_PREFIX ) ).toBe( true )
  } )

  it('mints identically for the same first sighting — a replay must match', () => {
    // R2: a counter would drift the moment two runs met people in a different
    // order, and a clock or RNG would never match at all.
    expect( mintReferentId('discord:1019376031150379101') ).toBe( mintReferentId('discord:1019376031150379101') )
  } )

  it('mints differently for different referents', () => {
    expect( mintReferentId('discord:111') ).not.toBe( mintReferentId('discord:222') )
  } )

  it('is opaque — the route cannot be read back out of it', () => {
    // The moment an id reads as `ke:discord:123`, something downstream starts
    // parsing it back into a route and the whole separation quietly stops holding.
    const id = mintReferentId('discord:1019376031150379101')
    expect( id ).not.toContain('discord')
    expect( id ).not.toContain('1019376031150379101')
  } )
} )

// ── one resolver, because there were two and they disagreed ──

describe('resolving anything the mind might name', () => {
  const PID = mintReferentId('discord:111')
  const w = world(
    dossier( PID, { name: 'Fabrice', handles: [
      { keid: 'discord:111', kind: 'dm' }, { keid: 'whatsapp:999', kind: 'dm' },
    ] } ),
    alias('discord:111', PID ),
    alias('whatsapp:999', PID ),
  )

  it('resolves the anchor itself', () => {
    expect( resolveKeid( w, PID ) ).toBe( PID )
  } )

  it('resolves a transport address to the someone behind it', () => {
    expect( resolveKeid( w, 'discord:111') ).toBe( PID )
    expect( resolveKeid( w, 'whatsapp:999') ).toBe( PID )
  } )

  it('resolves the SAME someone from two different channels', () => {
    // The whole point. One human met twice was two people to every faculty that
    // keys off a keid — reputation, theory-of-mind, attachment, the PMA.
    expect( resolveKeid( w, 'discord:111') ).toBe( resolveKeid( w, 'whatsapp:999') )
  } )

  it('resolves a learned name', () => {
    expect( resolveKeid( w, 'Fabrice') ).toBe( PID )
    expect( resolveKeid( w, 'fabrice') ).toBe( PID )
  } )

  it('returns nothing for someone it has never met — it does not invent a referent', () => {
    // `resolveKnownEntity` returning undefined is how the executive learns it
    // named someone unreachable, which it now reports rather than swallowing.
    expect( resolveKeid( w, 'Someone Else') ).toBeUndefined()
    expect( resolveKeid( w, '') ).toBeUndefined()
  } )

  it('resolves an alias whose dossier was absorbed by a recognition merge', () => {
    // `_recognise` deletes the absorbed dossier and leaves only the redirect, so
    // a reference to the old id has nothing to match on — and the OLD resolver
    // never read the alias table, so willing a reach-out to that person resolved
    // to nothing and the intention evaporated silently.
    const merged = world( dossier( PID, { name: 'Fabrice' } ), alias('discord:legacy', PID ) )
    expect( resolveKeid( merged, 'discord:legacy') ).toBe( PID )
  } )

  it('survives a cyclic alias table rather than hanging', () => {
    const bad = world( dossier('a'), alias('a', 'b'), alias('b', 'a') )
    expect( () => resolveKeid( bad, 'a') ).not.toThrow()
  } )

  it('follows a chain of aliases to the anchor', () => {
    const chain = readAliases( world( alias('x', 'y'), alias('y', PID ) ) )
    expect( canonicalOf( chain, 'x') ).toBe( PID )
  } )

  it('never substitutes a placeholder for an unlearned name', () => {
    // A keid leaking here had the mind addressing `discord:1019376031150379101`
    // by name; a default would have it addressing the wrong person by the wrong one.
    expect( nameOf( world( dossier('p:1') ), 'p:1') ).toBeUndefined()
    expect( nameOf( world( dossier('p:1', { name: '  ' }) ), 'p:1') ).toBeUndefined()
  } )
} )

// ── handles: the routes, with the circumstances attached ─────

describe('the ways the mind knows to reach someone', () => {
  const PID = mintReferentId('discord:111')
  const withHandles = ( hs: Handle[] ) => world( dossier( PID, { handles: hs } ) )

  it('holds every route, rather than discarding all but one', () => {
    // The recognition merge USED to absorb an alias and delete its dossier,
    // keeping only a redirect — so the mind concluded "same person" and threw
    // away the second way to reach them. Choosing a route was impossible by
    // construction, because there was only ever one left.
    const hs = handlesOf( withHandles([
      { keid: 'discord:dm:1', kind: 'dm' }, { keid: 'discord:room:9', kind: 'room' },
    ]), PID )
    expect( hs.map( h => h.keid ).sort() ).toEqual([ 'discord:dm:1', 'discord:room:9' ])
  } )

  it('orders by where they actually answer, not by where they were last seen', () => {
    const hs = handlesOf( withHandles([
      { keid: 'room', kind: 'room', lastUsedTick: 900 },
      { keid: 'dm',   kind: 'dm',   lastUsedTick: 100, lastAnsweredTick: 120 },
    ]), PID )
    expect( hs[0]!.keid ).toBe('dm')
  } )

  it('prefers a route that has actually worked', () => {
    const chosen = defaultHandle([
      { keid: 'room', kind: 'room', lastUsedTick: 900 },
      { keid: 'dm',   kind: 'dm',   lastAnsweredTick: 120 },
    ])
    expect( chosen?.keid ).toBe('dm')
  } )

  it('still answers when nothing has ever worked — dropping the message is worse', () => {
    const chosen = defaultHandle([ { keid: 'room', kind: 'room' } ])
    expect( chosen?.keid ).toBe('room')
  } )

  it('has nothing to offer for someone with no known route', () => {
    expect( defaultHandle([]) ).toBeUndefined()
    expect( handlesOf( world( dossier('p:1') ), 'p:1') ).toEqual([])
  } )

  it('is a DEFAULT and not a decision — a room can be chosen over a DM', () => {
    // Which room to speak in is the mind's call, made from circumstances it can
    // now see. This only covers "nothing was chosen and the words must still go
    // somewhere", so it must never be the only path to a room.
    const hs = handlesOf( withHandles([
      { keid: 'room', kind: 'room', lastAnsweredTick: 500 },
      { keid: 'dm',   kind: 'dm' },
    ]), PID )
    expect( hs.map( h => h.keid ) ).toContain('room')
  } )
} )

describe('folding a fresh sighting into what is already known', () => {
  it('updates an existing route rather than stacking a duplicate', () => {
    const out = withHandle([ { keid: 'discord:dm:1', kind: 'dm', lastUsedTick: 10 } ],
                            { keid: 'discord:dm:1', kind: 'dm', lastUsedTick: 50 } )
    expect( out ).toHaveLength( 1 )
    expect( out[0]!.lastUsedTick ).toBe( 50 )
  } )

  it('never lets a fresh sighting erase evidence already held', () => {
    // Being seen in a room again is news about that room, not grounds to forget
    // that they once answered there.
    const out = withHandle([ { keid: 'r', kind: 'room', lastAnsweredTick: 42 } ],
                            { keid: 'r', kind: 'room', lastUsedTick: 99 } )
    expect( out[0]!.lastAnsweredTick ).toBe( 42 )
    expect( out[0]!.lastUsedTick ).toBe( 99 )
  } )

  it('adds a genuinely new route', () => {
    const out = withHandle([ { keid: 'a', kind: 'dm' } ], { keid: 'b', kind: 'room' } )
    expect( out.map( h => h.keid ) ).toEqual([ 'a', 'b' ])
  } )

  it('unions tags instead of replacing them', () => {
    const out = withHandle([ { keid: 'a', kind: 'dm', tags: [ 'work' ] } ],
                            { keid: 'a', kind: 'dm', tags: [ 'urgent' ] } )
    expect( out[0]!.tags!.sort() ).toEqual([ 'urgent', 'work' ])
  } )

  it('returns a fresh array — frozen state must never share a mutable reference', () => {
    const original: Handle[] = [ { keid: 'a', kind: 'dm' } ]
    const out = withHandle( original, { keid: 'b', kind: 'room' } )
    expect( out ).not.toBe( original )
    expect( original ).toHaveLength( 1 )
  } )

  it('orders deterministically, so two runs write byte-identical state', () => {
    const a = withHandle( withHandle([], { keid: 'z', kind: 'dm' } ), { keid: 'a', kind: 'room' } )
    const b = withHandle( withHandle([], { keid: 'a', kind: 'room' } ), { keid: 'z', kind: 'dm' } )
    expect( a.map( h => h.keid ) ).toEqual( b.map( h => h.keid ) )
  } )
} )

// ── the two seats that make it visible ───────────────────────

describe('the room a message was addressed in survives the edge', () => {
  const read = ( p: string ): string => readFileSync( join( process.cwd(), 'src', p ), 'utf8')

  it('Discord stops discarding isDM', () => {
    // Computed on every inbound since this bridge shipped, used only to pick a
    // roster field. It is the one fact that makes a room the right or wrong place
    // to say something — and a follow-up promised in a DM went out to #general.
    expect( read('channels/discord.ts') ).toMatch( /direct: isDM/ )
  } )

  it('WhatsApp distinguishes a group from a one-to-one chat', () => {
    expect( read('channels/whatsapp.ts') ).toMatch( /@g\.us/ )
  } )

  it('carries it through the SDK boundary without inventing a default', () => {
    // Undefined is honestly different from false: an unknown room is not known to
    // be public, and defaulting would have the mind treat every unlabelled thread
    // as safe to speak in.
    const sdk = read('sdk/will.ts')
    expect( sdk ).toMatch( /direct\?: boolean/ )
    expect( sdk ).toMatch( /stimulus\.direct !== undefined/ )
  } )

  it('reaches the dossier as a handle with its kind', () => {
    const tracker = read('cognition/faculties/known.entity.tracker.ts')
    expect( tracker ).toMatch( /raw\?\.direct === 'boolean'/ )
    expect( tracker ).toMatch( /enc\.direct === true \? 'dm'/ )
  } )
} )

describe('an anchor is translated to somewhere the world can be spoken to', () => {
  const read = ( p: string ): string => readFileSync( join( process.cwd(), 'src', p ), 'utf8')

  it('translates at the ONE seam both send paths cross', () => {
    // ProactiveCommunicator.enqueue() and AuditionEngine.enqueueReply() both
    // funnel through OutboxWriter. Doing it in each would mean doing it twice and
    // getting it wrong once.
    expect( read('stem/tracts/outbox.writer.ts') ).toContain('attachRouting')
    expect( read('stem/mind.ts') ).toContain('outboxWriter.attachRouting(')
  } )

  it('lets a chosen room WIN over the fallback', () => {
    // A reply answers into the thread it was asked in. The mind picking a room is
    // a decision; the handle default only covers "it made none", and the
    // alternative to the fallback is dropping the message.
    const w = read('stem/tracts/outbox.writer.ts')
    expect( w ).toMatch( /const thread = row\.threadId \?\? routed\?\.threadId/ )
  } )

  it('leaves an address alone — only an anchor needs translating', () => {
    expect( read('stem/mind.ts') ).toMatch( /if\( !isReferentId\( targetEntityId \) \) return null/ )
  } )

  it('never drops a message for want of a handle', () => {
    // Returning null falls through to the row as written, so the bridge's own
    // roster fallback still applies. Silence would be the worse failure.
    const m = read('stem/mind.ts')
    expect( m ).toMatch( /if\( !address \) return null/ )
  } )

  it('picks an address on the same platform as the room', () => {
    // Otherwise a reply in a Discord thread could be addressed to a WhatsApp
    // handle — the exact confusion the anchor exists to make impossible.
    expect( read('stem/mind.ts') ).toMatch( /a\.startsWith\(`\$\{ scheme \}:`\)/ )
  } )
} )

// ── an identity the heuristic is not entitled to settle ──────

describe('two records of one someone, both established', () => {
  const read = ( p: string ): string => readFileSync( join( process.cwd(), 'src', p ), 'utf8')
  const tracker = read('cognition/faculties/known.entity.tracker.ts')

  it('does not loosen the guard — fusing two real people is the dangerous direction', () => {
    // Absorbing an established relationship would take a real person's whole
    // history with them. The heuristic must keep refusing.
    expect( tracker ).toContain('RECOGNITION_MERGE_MAX_ENCOUNTERS')
  } )

  it('keeps the near-miss as a DOUBT instead of dropping it silently', () => {
    // The whole failure: a blocked merge vanished, so the same human
    // well-established on two channels stayed two people permanently and nothing
    // anywhere recorded that it had nearly noticed.
    expect( tracker ).toContain('suspectedSameAs')
  } )

  it('says nothing when concurrency already answered the question', () => {
    // Two people talking at once are two people. That is evidence AGAINST, not
    // insufficient evidence FOR, and there is nothing to wonder about.
    // Ordering is the assertion: the concurrency bail comes BEFORE the block that
    // records a doubt, so two concurrent interlocutors produce no suspicion at all
    // rather than one the mind then has to carry around and rule out.
    const bail  = tracker.indexOf('RECOGNITION_CONCURRENCY_WINDOW ) continue')
    const doubt = tracker.indexOf('a.suspectedSameAs = [')
    expect( bail ).toBeGreaterThan( 0 )
    expect( doubt ).toBeGreaterThan( bail )
  } )

  it('shows the mind the doubt, as a question and not a conclusion', () => {
    const factory = read('cognition/faculties/executive.engine/prompt.factory.ts')
    expect( factory ).toContain('this may be the same someone under another handle')
    expect( factory ).toContain('I do not know')
  } )

  it('lets the MIND settle it, doing what the heuristic will not', () => {
    // It has evidence a name-match does not — usually that somebody just told it.
    expect( tracker ).toMatch( /if\( u\.sameAs \)/ )
    expect( read('cognition/faculties/executive.engine/types.ts') ).toMatch( /sameAs\?:\s+string/ )
    expect( read('cognition/faculties/executive.engine/commands.ts') ).toContain('u.sameAs')
    expect( read('cognition/faculties/executive.engine/facet.ts') ).toContain('u.sameAs')
  } )

  it('fuses through ONE implementation, however it was concluded', () => {
    // "These are the same person" must mean the same thing whichever decided it.
    // Only who is ENTITLED to decide differs.
    expect( tracker ).toContain('private _fuse(')
    expect( tracker ).toMatch( /this\._fuse\( canon, alias, commands \)/ )
    expect( tracker ).toMatch( /this\._fuse\( d, other, commands \)/ )
  } )

  it('repoints every address at the survivor, or the person re-forks on the next message', () => {
    const body = tracker.slice( tracker.indexOf('private _fuse('), tracker.indexOf('private _resolution') )
    expect( body ).toMatch( /if\( c === alias\.keid \) this\._aliases\.set\( a, canon\.keid \)/ )
  } )

  it('clears the doubt once it is answered', () => {
    const body = tracker.slice( tracker.indexOf('private _fuse('), tracker.indexOf('private _resolution') )
    expect( body ).toContain('suspectedSameAs = settled')
  } )
} )

describe('a room is something the mind can know', () => {
  const tracker = readFileSync( join( process.cwd(), 'src/cognition/faculties/known.entity.tracker.ts'), 'utf8')

  it('gives a shared room its own dossier', () => {
    // `kind: 'thing'` existed since this tracker shipped and nothing had ever
    // created one — the seat for a non-person was built and left empty.
    expect( tracker ).toMatch( /this\._getOrCreate\( enc\.thread, 'place', tick \)/ )
  } )

  it('does NOT give a private thread one — a DM is not a place, it is the person', () => {
    // Otherwise every someone would be doubled by a room that is only them.
    expect( tracker ).toMatch( /if\( enc\.direct === false \)\{/ )
  } )

  it('lets the mind see where it can reach someone and how that has gone', () => {
    const factory = readFileSync( join( process.cwd(), 'src/cognition/faculties/executive.engine/prompt.factory.ts'), 'utf8')
    expect( factory ).toContain('reachable:')
    expect( factory ).toContain('never answered me there')
  } )
} )

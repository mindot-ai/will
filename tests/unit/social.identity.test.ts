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
import {
  PERSON_PREFIX, isPersonId, mintPersonId, readAliases, canonicalOf,
  resolveKeid, nameOf, handlesOf, defaultHandle, withHandle, type Handle,
} from '#cognition/social.identity'

interface E { type: string; metadata?: Record<string, unknown> }
const world = ( ...rows: Array<[ string, E ]> ): Map<string, E> => new Map( rows )

const dossier = ( keid: string, extra: Record<string, unknown> = {} ): [ string, E ] =>
  [ `ke-${ keid }`, { type: 'known-entity', metadata: { keid, ...extra } } ]
const alias = ( a: string, canon: string ): [ string, E ] =>
  [ `kea-${ a }`, { type: 'known-entity-alias', metadata: { aliasKeid: a, canonicalKeid: canon } } ]

// ── the anchor ───────────────────────────────────────────────

describe('a person id is an identity, never a route', () => {
  it('is recognisable as an anchor', () => {
    expect( isPersonId( mintPersonId('discord:123') ) ).toBe( true )
    expect( isPersonId('discord:123') ).toBe( false )
    expect( mintPersonId('discord:123').startsWith( PERSON_PREFIX ) ).toBe( true )
  } )

  it('mints identically for the same first sighting — a replay must match', () => {
    // R2: a counter would drift the moment two runs met people in a different
    // order, and a clock or RNG would never match at all.
    expect( mintPersonId('discord:1019376031150379101') ).toBe( mintPersonId('discord:1019376031150379101') )
  } )

  it('mints differently for different people', () => {
    expect( mintPersonId('discord:111') ).not.toBe( mintPersonId('discord:222') )
  } )

  it('is opaque — the route cannot be read back out of it', () => {
    // The moment an id reads as `person:discord:123`, something downstream starts
    // parsing it back into a route and the whole separation quietly stops holding.
    const id = mintPersonId('discord:1019376031150379101')
    expect( id ).not.toContain('discord')
    expect( id ).not.toContain('1019376031150379101')
  } )
} )

// ── one resolver, because there were two and they disagreed ──

describe('resolving anything the mind might name', () => {
  const PID = mintPersonId('discord:111')
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
  const PID = mintPersonId('discord:111')
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

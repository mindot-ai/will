// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.room-name.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A room the mind can name.
 *
 * 0.9.0 gave a shared room a dossier of its own — a place earns the same things a
 * person does, and "nobody ever answers me in here" is a fact about the ROOM. But
 * nothing could ever NAME one, so every place the mind knew was the id it was
 * reached at (`discord:1531261362838441996`). The prompt renders a `thing` with no
 * name as "something", so a mind deciding where to speak was choosing between two
 * opaque numbers and shown neither.
 *
 * Behavioural, not a source grep: what matters is that the dossier comes out of a
 * real tick carrying the name, through the same encounter path a percept takes.
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'

type Any = Record<string, unknown>

const emptyState = ( tick: number ) => ( { tick, entities: new Map(), metrics: new Map() } as Any )

/** A heard message, as `senses.audition.percept` delivers it. */
const heard = ( over: Any = {} ): Any => ( {
  type:    'senses.audition.percept',
  payload: {
    domain: 'audition',
    sourceEntityId: 'discord:U1',
    raw: { speakerName: 'Ada', threadId: 'discord:c1', direct: false, threadName: '#general in Mindot', ...over },
  },
} )

const written = ( r: Any ) => ( ( r?.['commands'] as Any )?.['set'] as Any[] ?? [] )

/**
 * The dossier for a transport address, resolved THROUGH the alias table.
 *
 * A room is anchored like anybody else: `discord:c1` becomes `kea-discord:c1`
 * pointing at an opaque `ke:` referent, and the dossier hangs off the anchor. A
 * test that looked up the raw address would find nothing and read as a failure of
 * naming, when it is 0.9.0's identity model working — the address is where the
 * room is reached, not what it IS.
 */
const byAddress = ( r: Any, address: string ): Any | undefined => {
  const alias = written( r ).find( e => e['id'] === `kea-${ address }` )
  const canonical = alias ? ( alias['metadata'] as Any )?.['canonicalKeid'] : undefined
  if( !canonical ) return undefined
  return written( r ).find( e =>
    e['type'] === 'known-entity' && ( e['metadata'] as Any )?.['keid'] === canonical ) as Any | undefined
}

async function tick( t: KnownEntityTracker, events: Any[], at = 100 ): Promise<Any> {
  for( const e of events ) t.onCognitiveEvent( e as never )
  return await t.react( 1000 as never, at as never, emptyState( at ) as never, {} as never ) as unknown as Any
}

describe('a room learns what it is called', () => {
  it('names the place dossier from the label the channel offered', async () => {
    const t = new KnownEntityTracker()
    const r = await tick( t, [ heard() ] )

    const room = byAddress( r, 'discord:c1')
    expect( room, 'a shared room must earn a dossier').toBeDefined()
    expect( ( room!['metadata'] as Any )['name'] ).toBe('#general in Mindot')
    // Still a thing, not a someone — naming a room must not promote it to a person.
    expect( ( room!['metadata'] as Any )['kind'] ).toBe('thing')
  } )

  it('leaves the room unnamed when the channel offers no label', async () => {
    const t = new KnownEntityTracker()
    const r = await tick( t, [ heard( { threadName: undefined } ) ] )

    const room = byAddress( r, 'discord:c1')
    expect( room ).toBeDefined()
    // Unnamed, never labelled with its own id — the same rule a person gets.
    expect( ( room!['metadata'] as Any )['name'] ).toBeUndefined()
  } )

  it('does not confuse the room\'s name with the speaker\'s', async () => {
    const t = new KnownEntityTracker()
    const r = await tick( t, [ heard() ] )

    expect( ( byAddress( r, 'discord:U1')!['metadata'] as Any )['name'] ).toBe('Ada')
    expect( ( byAddress( r, 'discord:c1')!['metadata'] as Any )['name'] ).toBe('#general in Mindot')
  } )

  it('keeps the first name it learned rather than re-taking it every encounter', async () => {
    // Re-taking it would churn the cached prompt on a rename, and a name the mind
    // already holds is the mind's — not the platform's to overwrite.
    const t = new KnownEntityTracker()
    const first = await tick( t, [ heard() ], 100 )
    // The anchor is minted ONCE and persisted; a later tick does not re-emit the
    // alias, so carry the referent forward rather than re-resolving the address.
    const anchor = ( byAddress( first, 'discord:c1')!['metadata'] as Any )['keid']

    const r = await tick( t, [ heard( { threadName: '#renamed' } ) ], 200 )
    const room = written( r ).find( e =>
      e['type'] === 'known-entity' && ( e['metadata'] as Any )?.['keid'] === anchor )!

    expect( ( room['metadata'] as Any )['name'] ).toBe('#general in Mindot')
  } )

  it('gives a private thread no dossier to name — a DM is the person, not a place', async () => {
    const t = new KnownEntityTracker()
    const r = await tick( t, [ heard( { direct: true, threadId: 'discord:dm1', threadName: '#dm' } ) ] )

    expect( byAddress( r, 'discord:dm1'), 'a DM must not be doubled as a place').toBeUndefined()
    expect( byAddress( r, 'discord:U1') ).toBeDefined()
  } )
} )

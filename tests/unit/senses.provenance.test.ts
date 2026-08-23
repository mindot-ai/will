// ─────────────────────────────────────────────────────────────
// tests/unit/senses.provenance.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P0a — provenance survives the live sense.
 *
 * `base.sense.engine.test.ts` pins the stamping contract at the chokepoint with
 * a test double. This pins the one sense that is actually wired: audition builds
 * its `LanguagePercept` by hand, from a dozen fields, and hands it to
 * `publishPercept()` — the risk this covers is that it hands over the RIGHT
 * signal. A percept stamped from the wrong `TextMessage` would be worse than an
 * unstamped one, because it would be confidently wrong about whose doing it was.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import type { TextMessage, Percept } from '#senses/index'

function heard( over: Partial<TextMessage> = {} ): TextMessage {
  return { kind: 'text', entityId: 'discord:U1', threadId: 'discord:c1', content: 'hi', provenance: 'exafferent', ...over }
}

/** Ingest one message and return the percept that reached the bus. */
async function perceptFor( msg: TextMessage ): Promise<Percept> {
  const engine   = new AuditionEngine()
  const percepts: Percept[] = []
  engine.attachBus( {
    publish: ( e: { type: string; payload: unknown } ) => {
      if( e.type === 'senses.audition.percept') percepts.push( e.payload as Percept )
    },
    subscribe: () => {},
  } as never )

  await engine.ingest( msg )
  expect( percepts ).toHaveLength( 1 )
  return percepts[0]!
}

describe('audition carries provenance onto the percept (P0a)', () => {
  it('an ordinary inbound message is exafferent — someone spoke to me', async () => {
    expect( ( await perceptFor( heard() ) ).provenance ).toBe('exafferent')
  } )

  it('a host-declared echo of my own utterance is reafferent, with its intent', async () => {
    // The case that motivates the field: a Discord bridge receiving back the
    // message the mind just sent. Nothing inside the mind can tell that from a
    // stranger repeating the words — only the boundary knows.
    const p = await perceptFor( heard( {
      content:        'the thing I just said',
      provenance:     'reafferent',
      sourceIntentId: 'agency.intent:speak-42',
    } ) )
    expect( p.provenance ).toBe('reafferent')
    expect( p.sourceIntentId ).toBe('agency.intent:speak-42')
  } )

  it('the stamp belongs to THIS message, not a neighbouring one', async () => {
    // Guards the hand-off: audition passes `msg` to publishPercept(), and this
    // fails if it ever passes something else that happens to be in scope.
    const p = await perceptFor( heard( { entityId: 'discord:U2', provenance: 'unknown' } ) )
    expect( p.provenance ).toBe('unknown')
    expect( p.sourceEntityId ).toBe('discord:U2')
  } )
} )

// ── Audition is the grandfathered exception (P0 step 3) ────────
describe('audition lays down NO percept trace — deliberately, and on the record', () => {
  it('publishes to the bus but writes no percept entity', async () => {
    // Every other sense traces; audition does not, because it is the only live
    // one and switching it on routes every inbound message to five consumers it
    // has never reached — the rupture gate, working memory, the executive
    // prompt, novelty, reafference credit. That is a measured rollout, not a
    // refactor. This test is what makes turning it on deliberate: flip
    // `tracesPercepts` and this fails, which is the point of it.
    const engine   = new AuditionEngine()
    const written: unknown[] = []
    const published: unknown[] = []
    engine.attachBus( { publish: ( e: unknown ) => published.push( e ), subscribe: () => {} } as never )
    engine.attachPerceptTrace( x => written.push( x ), () => 5 )

    await engine.ingest( heard() )

    expect( published.length ).toBeGreaterThan( 0 )   // the bus still hears it
    expect( written ).toHaveLength( 0 )               // state does not
  } )

  it('still summarises what it heard, so turning the trace on needs no other change', async () => {
    // The summary is produced whether or not it is written — audition is opted
    // out of the WRITE, not degraded. Flipping the flag yields a well-formed
    // percept immediately rather than an empty one.
    const p = await perceptFor( heard( { speakerName: 'Ada', content: 'is the deploy done?' } ) )
    expect( p.summary ).toContain('Ada')
    expect( p.summary ).toContain('is the deploy done?')
  } )
} )

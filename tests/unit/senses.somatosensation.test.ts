// ─────────────────────────────────────────────────────────────
// tests/unit/senses.somatosensation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P1 — the first shell to become a real sense.
 *
 * The wake event was a hand-written `percept` entity in `stem/index.ts`, and
 * every bug it had came from being hand-written: no tick (so it never expired,
 * and told the executive "I was offline for 3 hours" for the rest of the mind's
 * life) and no provenance (so the rupture gate excluded it exactly as it
 * excludes the mind's own echo). P0 step 2 fixed both BY HAND. This removes the
 * hand — and these tests are about that: not that the wake works, but that
 * nothing about the wake is special any more.
 */

import { describe, it, expect } from 'vitest'
import { SomatosensationEngine, SYSTEM_SIGNAL_SALIENCE } from '#senses/somatosensation.engine'
import type { Percept } from '#senses/index'

function wired(){
  const published: Percept[] = []
  const traced: Array<{ id: string; type: string; metadata: Record<string, unknown> }> = []
  const e = new SomatosensationEngine()
  e.attachBus( { publish: ( ev: { payload: unknown } ) => published.push( ev.payload as Percept ),
                 subscribe: () => {} } as never )
  e.attachPerceptTrace( x => traced.push( x as never ), () => 42 )
  return { e, published, traced }
}

describe('somatosensation transduces a system signal', () => {
  it('a host-supplied summary is what the mind reads', async () => {
    // `summary` is the only field the executive prompt renders, so a signal
    // without one reaches the mind as a name and nothing else.
    const { e, published } = wired()
    await e.ingest( { kind: 'system', signal: 'WAKE', provenance: 'exafferent',
                      data: { summary: 'I was offline for 3 hours. I am now online again.' } } )
    expect( published[0]!.summary ).toBe('I was offline for 3 hours. I am now online again.')
    expect( published[0]!.sourceEntityId ).toBe('system:WAKE')
  } )

  it('falls back to the signal name when the host says nothing', async () => {
    const { e, published } = wired()
    await e.ingest( { kind: 'system', signal: 'WAKE', provenance: 'exafferent', data: {} } )
    expect( published[0]!.summary ).toBe('Something happened: WAKE.')
  } )

  it('defaults loud enough to rupture, because something happened TO the mind', async () => {
    // Above exteroception's ambient 0.3 and above action.selector's gate (0.4).
    const { e, published } = wired()
    await e.ingest( { kind: 'system', signal: 'WAKE', provenance: 'exafferent', data: {} } )
    expect( published[0]!.salience ).toBe( SYSTEM_SIGNAL_SALIENCE )
    expect( SYSTEM_SIGNAL_SALIENCE ).toBeGreaterThan( 0.4 )
  } )

  it('a host may override the salience, and it is clamped', async () => {
    const { e, published } = wired()
    await e.ingest( { kind: 'system', signal: 'X', provenance: 'exafferent', data: { salience: 9 } } )
    expect( published[0]!.salience ).toBe( 1 )
  } )
} )

describe('the wake stops being special', () => {
  it('lays down a percept trace like any other sense — ticked and stamped', async () => {
    // The two things the hand-written version kept getting wrong, now supplied
    // by the machinery rather than remembered by a caller.
    const { e, traced } = wired()
    await e.ingest( { kind: 'system', signal: 'WAKE', provenance: 'exafferent',
                      data: { summary: 'I was offline for 3 hours.' } } )
    expect( traced ).toHaveLength( 1 )
    expect( traced[0]!.metadata['tick'] ).toBe( 42 )              // sweepable
    expect( traced[0]!.metadata['provenance'] ).toBe('exafferent') // rupture-eligible
    expect( traced[0]!.metadata['category'] ).toBe('somatosensation')
    expect( traced[0]!.metadata['summary'] ).toBe('I was offline for 3 hours.')
  } )

  it('a reafferent signal is carried as such — a webhook the mind\'s own write fired', async () => {
    // The case the door exists for: not everything that touches the mind is the
    // world. Only the host can tell, so only the host says.
    const { e, traced } = wired()
    await e.ingest( { kind: 'webhook', source: 'github', headers: {},
                      provenance: 'reafferent', sourceIntentId: 'intent-12',
                      payload: { summary: 'The push I made landed.' } } )
    expect( traced[0]!.metadata['provenance'] ).toBe('reafferent')
    expect( traced[0]!.metadata['sourceIntentId'] ).toBe('intent-12')
  } )

  it('ignores a kind that is not its own, silently', async () => {
    const { e, published, traced } = wired()
    await e.ingest( { kind: 'text', entityId: 'e', threadId: 't', content: 'hi', provenance: 'exafferent' } )
    expect( published ).toHaveLength( 0 )
    expect( traced ).toHaveLength( 0 )
  } )
} )

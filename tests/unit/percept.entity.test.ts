// ─────────────────────────────────────────────────────────────
// tests/unit/percept.entity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P0 — one shape for a `percept` entity.
 *
 * Five places write one and none of them agreed on what one is; two forgot
 * `tick` and three forgot `provenance`, both silently, and both cost something
 * real. These pin the two guarantees that make those omissions impossible, and
 * they are written to fail LOUDLY if either becomes optional again — the whole
 * point of the constructor is that a field cannot be forgotten if the type
 * asks for it.
 */

import { describe, it, expect } from 'vitest'
import { perceptEntity, PERCEPT_TYPE, PERCEPT_STALE_AFTER_TICKS } from '#cognition/percept.entity'
import type { PerceptFacts } from '#cognition/percept.entity'

const core: PerceptFacts = {
  id: 'p-1', tick: 7, salience: 0.5, category: 'system',
  summary: 'something reached me', provenance: 'exafferent',
}

describe('perceptEntity — the two fields that cannot be forgotten', () => {
  it('tick is required — without it the entity is never swept', () => {
    // `exteroception._collectStalePerceptIds` is the ONLY sweeper of this type
    // and collects only entities whose `metadata.tick` is a number. An omission
    // makes the entity immortal: that is how `msg-delivered-<id>` leaks one per
    // message ever sent. If this stops erroring, the leak is buildable again.
    // @ts-expect-error — tick is not optional
    const noTick: PerceptFacts = { id: 'p', salience: 0, category: 'c', summary: 's', provenance: 'exafferent' }
    expect( noTick.id ).toBe('p')
  } )

  it('provenance is required — untagged means unrupturable', () => {
    // `action.selector`'s rupture gate counts only `'exafferent'` percepts, so
    // an untagged one can never rupture a commitment, exactly as the mind's own
    // echo cannot.
    // @ts-expect-error — provenance is not optional
    const noProv: PerceptFacts = { id: 'p', tick: 1, salience: 0, category: 'c', summary: 's' }
    expect( noProv.id ).toBe('p')
  } )

  it('every built entity is sweepable — numeric tick, always', () => {
    const e = perceptEntity( core )
    expect( e.type ).toBe( PERCEPT_TYPE )
    expect( typeof e.metadata['tick'] ).toBe('number')
  } )
} )

describe('perceptEntity — the core is not a writer\'s to overwrite', () => {
  it('extra carries writer-specific fields alongside the core', () => {
    const e = perceptEntity( core, { messageId: 'm-9', facetId: 'f-1' } )
    expect( e.metadata['messageId'] ).toBe('m-9')
    expect( e.metadata['facetId'] ).toBe('f-1')
    expect( e.metadata['summary'] ).toBe('something reached me')
  } )

  it('extra CANNOT clobber tick or provenance', () => {
    // A writer able to overwrite its own tick or provenance is back where it
    // started, so the core is spread last on purpose.
    const e = perceptEntity( core, { tick: 999, provenance: 'reafferent', salience: 1 } )
    expect( e.metadata['tick'] ).toBe( 7 )
    expect( e.metadata['provenance'] ).toBe('exafferent')
    expect( e.metadata['salience'] ).toBe( 0.5 )
  } )
} )

describe('perceptEntity — optional facts are absent, not undefined', () => {
  it('omits every optional field the writer did not supply', () => {
    const m = perceptEntity( core ).metadata
    for( const k of [ 'sourceIntentId', 'entityId', 'changeType', 'valence', 'valenceSource' ] )
      expect( k in m ).toBe( false )
  } )

  it('carries them when supplied, including a zero valence', () => {
    // 0 is a real valence — neutral — and a truthiness check would drop it.
    const m = perceptEntity( { ...core, provenance: 'reafferent', sourceIntentId: 'i-3',
                               entityId: 'w', changeType: 'delivered',
                               valence: 0, valenceSource: 'entity' } ).metadata
    expect( m['sourceIntentId'] ).toBe('i-3')
    expect( m['entityId'] ).toBe('w')
    expect( m['changeType'] ).toBe('delivered')
    expect( m['valence'] ).toBe( 0 )
    expect( m['valenceSource'] ).toBe('entity')
  } )
} )

describe('PERCEPT_STALE_AFTER_TICKS', () => {
  it('matches the window Exteroception actually sweeps on', () => {
    // A staging window, not a durability one: persistence happens downstream
    // through WorkingMemory → EpisodicConsolidator → vector. If these two ever
    // disagree, percepts are swept before or after the faculties that read them.
    expect( PERCEPT_STALE_AFTER_TICKS ).toBe( 2 )
  } )
} )

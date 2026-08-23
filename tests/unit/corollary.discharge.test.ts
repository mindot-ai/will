// ─────────────────────────────────────────────────────────────
// tests/unit/corollary.discharge.test.ts
// ─────────────────────────────────────────────────────────────
// EXAFFERENCE P2 — the corollary-discharge matcher. Proves the pure matcher
// (liveConsequences + matchConsequenceText) splits afference by exact content
// hash and verbatim containment, and that Exteroception applies it at percept
// creation: an echo of our own delivered words surfaces as a *reafferent*
// percept with attenuated salience, while the world's own events stay
// *exafferent* at full salience — byte-identical to a run with no descriptor.
//
// Harness mirrors agency.execution.test.ts: a mutable state cast to
// ReadonlySimulationState, driven one tick at a time.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, SimulationEntity,
} from '#core/types'
import { Exteroception } from '#faculties/exteroception'
import {
  consequenceEntity, liveConsequences, matchConsequenceText,
  ATTENUATION, MIN_TEXT_MATCH_LEN, fnv1a, CONSEQUENCE_TYPE,
  type ConsequenceDescriptor,
} from '#agency/consequence'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }

function freshState(): MutState {
  return { tick: 0, time: 0, entities: new Map(), metrics: new Map() }
}
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function putEntity( s: MutState, id: string, type: string, metadata: Record<string, unknown> ): void {
  s.entities.set( id, { id, type, createdAt: 0, updatedAt: 0, metadata } as SimulationEntity )
}

/** Seed a live consequence descriptor for delivered words `text`. */
function seedDescriptor( s: MutState, intentId: string, text: string, expiresAt = 30 ): void {
  const d: ConsequenceDescriptor = {
    intentId, schema: 'reach-out', mode: 'communicate', effector: 'text',
    targetEntityId: 'alice', textHash: fnv1a( text ), text, expiresAt, tick: 0,
  }
  const ent = consequenceEntity( d )
  s.entities.set( ent.id, { ...ent, createdAt: 0, updatedAt: 0 } as SimulationEntity )
}

/** Run one Exteroception tick, return the percept entities it committed. */
async function perceive( s: MutState, tick: number ): Promise<SimulationEntity[]> {
  const eng = new Exteroception()
  const r = await eng.react( 0, tick, frozen( s ), CTX )
  return ( r.commands?.set ?? [] ).filter( e => e.type === 'percept') as SimulationEntity[]
}

const desc = ( text: string, over: Partial<ConsequenceDescriptor> = {} ): ConsequenceDescriptor => ({
  intentId: 'i1', schema: 'reach-out', mode: 'communicate',
  textHash: fnv1a( text ), text, expiresAt: 30, tick: 0, ...over,
})

// ── the pure matcher ─────────────────────────────────────────────────────────

describe('matchConsequenceText — high-precision only', () => {
  it('matches on exact content hash', () => {
    const d = [ desc('hello there Alice') ]
    expect( matchConsequenceText( d, 'hello there Alice') ).toBe( d[0] )
  })

  it('matches a decorated echo by verbatim containment', () => {
    const d = [ desc('hello there Alice, how are you') ]
    expect( matchConsequenceText( d, 'Alice said: hello there Alice, how are you') ).toBe( d[0] )
  })

  it('does NOT containment-match text shorter than MIN_TEXT_MATCH_LEN', () => {
    const short = 'hi'   // < 12 chars
    expect( short.length ).toBeLessThan( MIN_TEXT_MATCH_LEN )
    // exact-equal still hash-matches; but a longer candidate merely *containing*
    // the short text must not — too cheap to mean "my own words".
    const d = [ desc( short ) ]
    expect( matchConsequenceText( d, 'hi there, this is someone else entirely') ).toBeNull()
  })

  it('returns null on no match and on empty candidate', () => {
    const d = [ desc('hello there Alice') ]
    expect( matchConsequenceText( d, 'a completely different message') ).toBeNull()
    expect( matchConsequenceText( d, '') ).toBeNull()
  })

  it('first descriptor in stable order wins', () => {
    const d = [ desc('shared body of the message', { intentId: 'a' }),
                desc('shared body of the message', { intentId: 'b' }) ]
    expect( matchConsequenceText( d, 'shared body of the message')!.intentId ).toBe('a')
  })
})

describe('liveConsequences — TTL filter + stable order', () => {
  it('drops expired descriptors and sorts by intentId', () => {
    const s = freshState()
    seedDescriptor( s, 'z-live', 'still live message body', 30 )
    seedDescriptor( s, 'a-live', 'another live message body', 30 )
    seedDescriptor( s, 'm-dead', 'expired message body', 5 )
    const live = liveConsequences( s.entities, 10 )   // tick 10: expiresAt 5 is dead
    expect( live.map( d => d.intentId ) ).toEqual([ 'a-live', 'z-live' ])
  })
})

// ── Exteroception integration ────────────────────────────────────────────────

describe('Exteroception — corollary discharge at percept creation', () => {
  it('tags a matching echo reafferent and attenuates its salience', async () => {
    const text = 'I have been thinking about what you said earlier'

    // Control: the same incoming message, no descriptor → exafferent, base salience.
    const ctrl = freshState()
    putEntity( ctrl, 'msg-1', 'message', { content: text, salience: 0.8 } )
    const cp = ( await perceive( ctrl, 5 ) ).find( p => p.metadata?.['entityId'] === 'msg-1')!
    expect( cp.metadata?.['provenance'] ).toBe('exafferent')
    const baseSalience = cp.metadata?.['salience'] as number

    // Match: identical message + a live descriptor for those exact words.
    const s = freshState()
    putEntity( s, 'msg-1', 'message', { content: text, salience: 0.8 } )
    seedDescriptor( s, 'intent-42', text )
    const p = ( await perceive( s, 5 ) ).find( x => x.metadata?.['entityId'] === 'msg-1')!

    expect( p.metadata?.['provenance'] ).toBe('reafferent')
    expect( p.metadata?.['sourceIntentId'] ).toBe('intent-42')
    expect( p.metadata?.['salience'] ).toBeCloseTo( baseSalience * ATTENUATION, 10 )
  })

  it('leaves an unrelated world event exafferent and byte-identical to a descriptor-free run', async () => {
    const build = ( withDescriptor: boolean ): MutState => {
      const s = freshState()
      putEntity( s, 'msg-2', 'message', { content: 'a supplier just cancelled the delivery', salience: 0.7 } )
      if( withDescriptor ) seedDescriptor( s, 'intent-9', 'entirely different words I said to Bob' )
      return s
    }
    const without = ( await perceive( build( false ), 3 ) ).find( p => p.metadata?.['entityId'] === 'msg-2')!
    const with_   = ( await perceive( build( true  ), 3 ) ).find( p => p.metadata?.['entityId'] === 'msg-2')!

    expect( with_.metadata?.['provenance'] ).toBe('exafferent')
    expect( with_.metadata ).not.toHaveProperty('sourceIntentId')
    expect( with_.metadata?.['salience'] ).toBe( without.metadata?.['salience'] )
  })

  it('never perceives its own consequence descriptors (internal type)', async () => {
    const s = freshState()
    seedDescriptor( s, 'intent-1', 'a message body long enough to consider' )
    const percepts = await perceive( s, 2 )
    expect( percepts.some( p => p.metadata?.['category'] === CONSEQUENCE_TYPE ) ).toBe( false )
  })

  it('an expired descriptor no longer captures its echo', async () => {
    const text = 'the words I said a long time ago now'
    const s = freshState()
    putEntity( s, 'msg-3', 'message', { content: text, salience: 0.6 } )
    seedDescriptor( s, 'intent-old', text, /* expiresAt */ 4 )
    const p = ( await perceive( s, 10 ) ).find( x => x.metadata?.['entityId'] === 'msg-3')!   // tick 10 > 4
    expect( p.metadata?.['provenance'] ).toBe('exafferent')
  })

  it('is deterministic — identical state yields identical tagged percepts', async () => {
    const build = (): MutState => {
      const s = freshState()
      putEntity( s, 'msg-a', 'message', { content: 'echoed words coming back to me', salience: 0.8 } )
      putEntity( s, 'msg-b', 'message', { content: 'a fresh event from the world', salience: 0.5 } )
      seedDescriptor( s, 'intent-x', 'echoed words coming back to me' )
      return s
    }
    const run = async (): Promise<string> => {
      const ps = await perceive( build(), 7 )
      return JSON.stringify( ps
        .map( p => ({ e: p.metadata?.['entityId'], prov: p.metadata?.['provenance'], sal: p.metadata?.['salience'] }) )
        .sort( ( a, b ) => String( a.e ).localeCompare( String( b.e ) ) ) )
    }
    expect( await run() ).toBe( await run() )
  })
})

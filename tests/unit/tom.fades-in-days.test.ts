// ─────────────────────────────────────────────────────────────
// tests/unit/tom.fades-in-days.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Theory of mind — the read of someone fades in days, and is let go.
 *
 * The fade took `rate × ticks since update` every tick: a step that grew with the
 * silence, so a colleague's model hit its 0.05 floor two ticks after 100 quiet
 * ticks, and every woken model (dated to tick 0) on its first tick. The floor sat
 * at the prune line, so no model was ever let go either.
 */

import { describe, it, expect } from 'vitest'
import { TheoryOfMind } from '#faculties/theory.of.mind'

const HOUR = 3_600_000

const stateAt = ( tick: number, ...entities: Array<Record<string, unknown>> ) =>
  ( { tick, time: tick * 1000, entities: new Map( entities.map( e => [ e['id'] as string, e ] ) ),
      metrics: new Map<string, number>() } ) as never

const heard = ( tom: TheoryOfMind, keid = 'alex') =>
  tom.onCognitiveEvent( { type: 'interaction.occurred', payload:
    { keid, valence: 0.5, intensity: 0.5, directedAtSelf: true, interactionType: 'greet' } } as never )

const step = ( tom: TheoryOfMind, tick: number, deltaMs = 1000 ) =>
  tom.react( deltaMs as never, tick as never, stateAt( tick ), {} as never )

describe('a quiet colleague is still read an hour later', () => {
  it('holds through the quiet window, then fades by a fixed step per second', async () => {
    const tom = new TheoryOfMind()
    heard( tom )
    await step( tom, 1 )
    const read = tom.getModel('alex')!.modelConfidence      // 0.3 + 0.02

    for( let t = 2; t <= 101; t++ ) await step( tom, t )
    expect( tom.getModel('alex')!.modelConfidence ).toBe( read )   // within the quiet window

    for( let t = 102; t <= 3700; t++ ) await step( tom, t )        // an hour of silence at 1 tick/s
    const after = tom.getModel('alex')!.modelConfidence
    expect( after ).toBeLessThan( read )
    expect( after ).toBeGreaterThan( 0.3 )                         // ~0.0025 an hour, not to the floor
  } )
} )

describe('a read fades out in days, and is let go — in state too', () => {
  it('is held at three days of silence and gone by five, its entity deleted', async () => {
    const tom = new TheoryOfMind()
    heard( tom )
    await step( tom, 1, HOUR )

    let deleted: string[] = []
    let tick = 1
    const hours = async ( n: number ) => {
      for( let i = 0; i < n; i++ ){
        const r = await step( tom, ++tick, HOUR )
        deleted = [ ...deleted, ...( r.commands?.delete ?? [] ) ]
      }
    }

    await hours( 100 + 72 )            // the quiet window, then three days
    expect( tom.getModel('alex') ).toBeDefined()
    expect( deleted ).toEqual( [] )

    await hours( 48 )                  // five days
    expect( tom.getModel('alex') ).toBeUndefined()
    expect( deleted ).toContain('tom-alex')
  } )
} )

describe('a woken model keeps when it last heard from them', () => {
  it('persists lastUpdated, and restores it rather than tick 0', async () => {
    const tom = new TheoryOfMind()
    heard( tom )
    const r = await step( tom, 40 )
    const saved = r.commands!.set!.find( e => e.id === 'tom-alex')!
    expect( saved.metadata!['lastUpdated'] ).toBe( 40 )

    const woken = new TheoryOfMind()
    await woken.react( 1000 as never, 1000 as never, stateAt( 1000,
      { id: 'tom-alex', type: 'theory_of_mind', metadata: { keid: 'alex', modelConfidence: 0.7,
        dominantIntention: 'collaborate', estimatedEmotion: 'neutral', lastUpdated: 950 } } ), {} as never )
    expect( woken.getModel('alex')!.modelConfidence ).toBe( 0.7 )
    expect( woken.getModel('alex')!.lastUpdated ).toBe( 950 )
  } )

  it('a model saved before lastUpdated was kept starts its quiet at the wake', async () => {
    const woken = new TheoryOfMind()
    await woken.react( 1000 as never, 5000 as never, stateAt( 5000,
      { id: 'tom-sam', type: 'theory_of_mind', metadata: { keid: 'sam', modelConfidence: 0.6,
        dominantIntention: null, estimatedEmotion: 'neutral' } } ), {} as never )
    expect( woken.getModel('sam')!.modelConfidence ).toBe( 0.6 )
  } )
} )

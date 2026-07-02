// ─────────────────────────────────────────────────────────────
// tests/unit/empathy.contagion.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Empathy → affect integration (closing the inert-faculty gap). empathy.simulator now
 * emits a vicarious valence/arousal (resonating with others' emotions, amplified by
 * closeness), and affective.blender folds it into the blended PAD — so empathy actually
 * MOVES the Will's affect (emotion contagion).
 */

import { describe, it, expect } from 'vitest'
import { AffectiveBlender } from '#faculties/affective.blender'

const affectValence = ( r: any ): number =>
  ( r.commands?.metrics ?? [] ).find( ( [ k ]: [string, number] ) => k === 'affect.valence' )?.[ 1 ] ?? NaN

const runWith = async ( vicariousValence?: number ): Promise<any> => {
  const ab = new AffectiveBlender()
  const metrics = new Map<string, number>()
  if( vicariousValence !== undefined ) metrics.set( 'empathy.vicarious_valence', vicariousValence )
  const state = { tick: 1, entities: new Map(), metrics } as any
  return ab.react( 100 as any, 1 as any, state, {} as any )
}

describe( 'AffectiveBlender — empathy vicarious affect (emotion contagion)', () => {
  it( 'pulls the blended affect toward others’ emotion (sad company ⇒ lower valence than happy company)', async () => {
    const sad   = affectValence( await runWith( -0.6 ) )
    const happy = affectValence( await runWith(  0.6 ) )
    expect( sad ).toBeLessThan( happy )
  } )

  it( 'no vicarious signal sits between the two (the contagion is what moves it)', async () => {
    const sad     = affectValence( await runWith( -0.6 ) )
    const neutral = affectValence( await runWith() )
    const happy   = affectValence( await runWith(  0.6 ) )
    expect( neutral ).toBeGreaterThan( sad )
    expect( neutral ).toBeLessThan( happy )
  } )
} )

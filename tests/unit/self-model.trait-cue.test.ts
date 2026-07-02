// ─────────────────────────────────────────────────────────────
// tests/unit/self-model.trait-cue.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A positive self-belief now nudges only the trait(s) it is actually *about* (keyword
 * cue), not every trait. This guards against the prior behaviour where one positive
 * self-belief inflated EVERY trait — and therefore every Channel-A disposition the
 * persona-prior develops — regardless of behaviour.
 */

import { describe, it, expect } from 'vitest'
import { traitsCuedBySelfBelief } from '#faculties/self.model.updater'

describe( 'traitsCuedBySelfBelief — targeted self-belief → trait cue', () => {
  it( 'maps a belief to only the trait it is about', () => {
    expect( traitsCuedBySelfBelief( 'I am a curious explorer' ) ).toEqual( [ 'openness' ] )
    expect( traitsCuedBySelfBelief( 'I stay calm under pressure' ) ).toEqual( [ 'emotional-stability' ] )
    expect( traitsCuedBySelfBelief( 'I am kind and helpful to others' ) ).toEqual( [ 'agreeableness' ] )
  } )

  it( 'can map to more than one trait when the statement spans facets', () => {
    const cued = traitsCuedBySelfBelief( 'I am a creative and curious thinker' )
    expect( cued ).toContain( 'creativity' )
    expect( cued ).toContain( 'openness' )
  } )

  it( 'returns NOTHING for a self-belief that names no trait — no blanket inflation', () => {
    expect( traitsCuedBySelfBelief( 'I exist in this world' ) ).toEqual( [] )
    expect( traitsCuedBySelfBelief( 'I had lunch at noon' ) ).toEqual( [] )
  } )

  it( 'is case-insensitive', () => {
    expect( traitsCuedBySelfBelief( 'I AM DISCIPLINED AND THOROUGH' ) ).toEqual( [ 'conscientiousness' ] )
  } )
} )

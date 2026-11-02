// ─────────────────────────────────────────────────────────────
// tests/unit/record.drive-tags.test.ts
// ─────────────────────────────────────────────────────────────
//
// Pins the one record defect that `.TODO/references.ts` cannot catch, because
// it was a well-formed claim that happened to be false rather than a dead name.
//
// `EffectorDeclaration.tags` used to document `'nourishment'` as an example of
// "a tag the drive system recognises". It is not one: `driveUrgency` knows three
// families and every other tag contributes ZERO to the drive term — silently, at
// the second-largest weight in the competition. A host author copying the
// example got a dead prior and no warning.
//
// Neither a dead-path nor a dead-symbol check sees that, and prose cannot be
// verified in general. So the comment is made executable instead: the test reads
// the mapping bullets out of the doc comment and asserts each tag it advertises
// actually reaches a drive. Change `driveUrgency` without changing the comment,
// or the comment without changing `driveUrgency`, and this fails.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveUrgency, type BiasContext } from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'

const TYPES = join( import.meta.dirname, '../../src/cognition/agency/types.ts' )

/** Every drive pressing at once — so a tag that reaches ANY drive reads > 0. */
const ALL_PRESSING: BiasContext = {
  goalTargets:     new Set<string>(),
  maxGoalPriority: 0,
  drives:          { energy: 1, sleep: 1, stress: 1, social: 1 },
  threat:          1,
  inhibition:      0,
}

const withTag = ( tag: string ): Affordance => ( { tags: [ tag ] } as unknown as Affordance )

/**
 * The tags the doc comment advertises — quoted literals on its mapping bullets,
 * i.e. the lines carrying an arrow. Deliberately NOT every quoted token in the
 * block: the same comment names `'external'`/`'host'` as routing markers and
 * `'nourishment'`-style counter-examples would be fair to mention too.
 */
const advertised = (): string[] => {
  const src = readFileSync( TYPES, 'utf8' )
  const block = /Routing tags folded into the schema[\s\S]*?\n\s*\*\/\n/.exec( src )
  expect( block, 'the tags doc comment moved — re-point this test' ).not.toBeNull()

  return [ ...new Set(
    block![ 0 ].split('\n')
      .filter( l => l.includes('→') )
      .flatMap( l => [ ...l.matchAll( /'([a-z-]+)'/g ) ].map( m => m[ 1 ]! ) ),
  ) ]
}

describe('the drive tags the declaration advertises are the ones it recognises', () => {
  it('every advertised tag reaches a drive', () => {
    const tags = advertised()
    expect( tags.length, 'the comment advertises no tags at all' ).toBeGreaterThan( 0 )

    for( const tag of tags )
      expect( driveUrgency( withTag( tag ), ALL_PRESSING ), `'${ tag }' reaches no drive` )
        .toBeGreaterThan( 0 )
  })

  it('it advertises every family driveUrgency actually knows', () => {
    // The converse: a family the code honours but the comment omits is the same
    // defect pointing the other way — a host cannot use what it is not told.
    const tags = advertised()
    for( const known of [ 'regulatory', 'self-care', 'rest', 'social', 'self-protection' ] )
      expect( tags, `driveUrgency honours '${ known }' and the comment omits it` ).toContain( known )
  })

  it('any other tag contributes zero — which is what made the old example a defect', () => {
    for( const tag of [ 'nourishment', 'epistemic', 'instrumental', 'curiosity', 'external', 'host' ] )
      expect( driveUrgency( withTag( tag ), ALL_PRESSING ), `'${ tag }' unexpectedly reaches a drive` )
        .toBe( 0 )
  })
})

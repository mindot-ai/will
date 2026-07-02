// ─────────────────────────────────────────────────────────────
// tests/unit/semantic.integrator.restore-beliefs.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression: restoring stored beliefs (PMA / snapshot) must be verbatim —
 * preserving every id and final confidence — not run through the live
 * integrateExecutiveBelief path, which (a) merges semantically-similar beliefs
 * (dropping ids + averaging confidence) and (b) re-caps confidence by evidence.
 * That corruption was the cause of PMA reconstruction-fidelity drift (beliefs
 * scored 0.625 on a real scenario because similar stored beliefs collapsed).
 */

import { describe, it, expect } from 'vitest'
import { SemanticIntegrator, type Belief } from '#faculties/semantic.engine/integrator'

const belief = ( over: Partial<Belief> = {} ): Belief => ( {
  id:                 'b-' + Math.random().toString( 36 ).slice( 2 ),
  statement:          'the sky is blue',
  category:           'world_fact',
  confidence:         0.6,
  supportingEpisodes: 3,
  lastUpdatedAt:      1,
  tags:               [ 'sky' ],
  history:            [],
  ...over,
} )

describe( 'SemanticIntegrator — restoreBeliefs is verbatim (PMA reconstruction)', () => {
  it( 'preserves every id and confidence for beliefs that would otherwise merge', () => {
    const integ = new SemanticIntegrator()

    // Same category + shared tag ⇒ _shouldMerge() would absorb these into one
    // via integrateExecutiveBelief, averaging confidence and dropping an id.
    const a = belief( { id: 'a', statement: 'the sky is blue',          confidence: 0.9, tags: [ 'sky' ] } )
    const b = belief( { id: 'b', statement: 'the sky looks blue today', confidence: 0.3, tags: [ 'sky' ] } )

    integ.restoreBeliefs( [ a, b ] )

    const byId = new Map( integ.getBeliefs().map( x => [ x.id, x.confidence ] ) )
    expect( integ.getBeliefs().length ).toBe( 2 )
    expect( byId.get( 'a' ) ).toBe( 0.9 )   // exact — not averaged to 0.6
    expect( byId.get( 'b' ) ).toBe( 0.3 )
  } )

  it( 'does not re-cap confidence by evidence count', () => {
    const integ = new SemanticIntegrator()
    // High confidence, thin episodic support — integrateExecutiveBelief would cap
    // this down; a verbatim restore must keep the stored value.
    integ.restoreBeliefs( [ belief( { id: 'hi', confidence: 0.95, supportingEpisodes: 0 } ) ] )
    expect( integ.getBeliefs().find( x => x.id === 'hi' )?.confidence ).toBe( 0.95 )
  } )

  it( 'seeds a history entry when none is provided and keeps an existing one', () => {
    const integ = new SemanticIntegrator()
    integ.restoreBeliefs( [
      belief( { id: 'no-hist',   history: [] } ),
      belief( { id: 'with-hist', history: [ { tick: 2, confidence: 0.6, delta: 0.1, cause: 'reinforced' } ] } ),
    ] )
    const loaded = integ.getBeliefs()
    expect( loaded.find( x => x.id === 'no-hist'   )?.history?.length ).toBe( 1 )
    expect( loaded.find( x => x.id === 'with-hist' )?.history?.length ).toBe( 1 )
  } )
} )

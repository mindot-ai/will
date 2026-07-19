// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.facet-writepath.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 2.2b — the facet write-path. A conversation facet applies its output
 * via executive.facet.progress (not buildStateCommands), so knownEntityUpdates follows the
 * same split as newBeliefs: facts → the SemanticIntegrator (keid-tagged social beliefs,
 * riding the memory pipeline); name/feeling → a known.entity.learned event the facet
 * publishes for known.entity.tracker. This covers the facts half (the integrator).
 */

import { describe, it, expect } from 'vitest'
import { SemanticIntegrator } from '#faculties/semantic.engine/integrator'

const facetProgress = ( knownEntityUpdates: unknown ) => ( {
  type: 'executive.facet.progress', salience: 0.6,
  payload: { facetId: 'f1', tick: 5, knownEntityUpdates },
} as any )

describe('SemanticIntegrator — facet knownEntityUpdates → keid-tagged beliefs (2.2b)', () => {
  it('integrates each learned fact as a keid-tagged social belief', () => {
    const si = new SemanticIntegrator()
    const integrated: Array<{ statement: string; category: string; tags: string[] }> = []
    ;( si as any ).integrateExecutiveBelief = ( b: any ) => integrated.push( b )

    si.onCognitiveEvent( facetProgress( [
      { keid: 'web:42', name: 'Mara', learned: [ 'studies coral reefs', 'lives by the sea' ], feeling: 0.3 },
    ] ) )

    expect( integrated ).toHaveLength( 2 )
    expect( integrated.map( b => b.statement ) ).toEqual( [ 'studies coral reefs', 'lives by the sea' ] )
    expect( integrated[0]!.category ).toBe('social_belief')
    expect( integrated[0]!.tags ).toContain('keid:web:42')
  } )

  it('records nothing for an update with no learned facts (name-only)', () => {
    const si = new SemanticIntegrator()
    const integrated: any[] = []
    ;( si as any ).integrateExecutiveBelief = ( b: any ) => integrated.push( b )

    si.onCognitiveEvent( facetProgress( [ { keid: 'web:42', name: 'Mara' } ] ) )
    expect( integrated ).toHaveLength( 0 )   // name/feeling go to the tracker, not beliefs
  } )

  it('ignores facts attributed to the self', () => {
    const si = new SemanticIntegrator()
    const integrated: any[] = []
    ;( si as any ).integrateExecutiveBelief = ( b: any ) => integrated.push( b )

    si.onCognitiveEvent( facetProgress( [ { keid: 'agent-self', learned: [ 'I like tea' ] } ] ) )
    expect( integrated ).toHaveLength( 0 )
  } )
} )

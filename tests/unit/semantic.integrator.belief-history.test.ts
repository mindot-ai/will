// ─────────────────────────────────────────────────────────────
// tests/unit/semantic.integrator.belief-history.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression: the integrator must not share a live array reference with the state it
 * emits. Applied state is deep-frozen by the orchestrator, so if a belief's `history`
 * (or `tags`) array is handed over by reference, the integrator's own working copy
 * freezes — and the next in-place mutation (_recordHistory push/shift when a belief is
 * reinforced) throws "Attempted to assign to readonly property". Both the emit path and
 * the snapshot-restore path must copy.
 */

import { describe, it, expect } from 'vitest'
import { SemanticIntegrator, type Belief } from '#faculties/semantic.engine/integrator'

const CTX = {} as any
const emptyState = () => ( { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as any )

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

const beliefEntity = ( res: any ) => ( res.commands?.set ?? [] ).find( ( e: any ) => e.type === 'belief')

describe('SemanticIntegrator — belief history survives state freezing (regression)', () => {
  it('reinforcing a belief after its persisted state was frozen does not throw', async () => {
    const integ = new SemanticIntegrator()
    integ.integrateExecutiveBelief( belief(), 1 )

    // Persist, then simulate the orchestrator deep-freezing the applied state.
    const ent = beliefEntity( await integ.react( 0, 1, emptyState(), CTX ) )
    expect( ent ).toBeDefined()
    Object.freeze( ( ent.metadata as any ).history )
    Object.freeze( ( ent.metadata as any ).tags )

    // Reinforce the same belief (same tag + category ⇒ merges ⇒ _recordHistory push).
    expect( () => integ.integrateExecutiveBelief( belief( { confidence: 0.7, lastUpdatedAt: 2 } ), 2 ) ).not.toThrow()

    // …and the reinforcement was actually recorded (internal array is a live copy).
    const ent2 = beliefEntity( await integ.react( 0, 2, emptyState(), CTX ) )
    expect( ( ent2.metadata as any ).history.length ).toBeGreaterThan( 1 )
  } )

  it('a belief restored from frozen state can still record history', async () => {
    const state = {
      tick: 5, time: 0, metrics: new Map(),
      entities: new Map( [ [ 'b1', { id: 'b1', type: 'belief', metadata: {
        statement: 'the sky is blue', category: 'world_fact', confidence: 0.6,
        supportingEpisodes: 3, lastUpdatedAt: 1,
        tags:    Object.freeze( [ 'sky' ] ),
        history: Object.freeze( [ { tick: 0, confidence: 0.6, delta: 0.6, cause: 'created' } ] ),
      } } ] ] ),
    } as any

    const integ = new SemanticIntegrator()
    await integ.react( 0, 5, state, CTX )   // first tick ⇒ _restoreFromState copies the arrays out

    expect( () => integ.integrateExecutiveBelief( belief( { confidence: 0.7, lastUpdatedAt: 6 } ), 6 ) ).not.toThrow()
  } )
} )

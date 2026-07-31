// ─────────────────────────────────────────────────────────────
// tests/integration/agency.composite-learning.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Learned composites — a capability the container offered and no tenant could reach.
 *
 * `ReafferenceEngine` subscribes to `agency.composite.proposed`, and its handler is
 * the ONLY caller of `SchemaRepertoire.registerComposite()` anywhere in the tree.
 * Nothing published the event. So for the entire life of every Will the repertoire
 * could hold the innate floor and nothing else, and the instrumental→habitual
 * gradient the whole design is built around was reachable only through a door
 * nobody knocked on (#114).
 *
 * The producer is the mind itself: a `[SKILLS]` block naming a compound action as
 * one thing it does. That is the right seam for a container — it hands the tenant
 * the ability to name a skill and does not decide which skills exist.
 *
 * This drives the whole loop over a real bus rather than calling the handler:
 *   executive output → publishCognitiveEvents → bus → ReafferenceEngine
 *     → registerComposite → repertoire.schemas() → competes as an affordance
 */

import { describe, it, expect, vi } from 'vitest'
import { createTestBus } from '#cognition/bus'
import { publishCognitiveEvents } from '#faculties/executive.engine/commands'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { INNATE_SCHEMAS } from '#agency/schemas/innate'
import { GenerativeModel } from '#cognition/generative.model'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { ReasoningFootprint } from '#core/types'

vi.spyOn( console, 'info').mockImplementation( () => {} )

const footprint = ( tick: number ) => ( {
  tickObserved: tick, entitiesRead: new Set(), metricsRead: new Set(),
  entitiesModified: new Set(), intendedCommands: {}, source: 'executive-engine',
} as unknown as ReasoningFootprint )

const output = ( newSkills?: ExecutiveOutputFull['newSkills'] ): ExecutiveOutputFull => ( {
  actions: [ { type: 'wait', reasoning: 'r', expectedOutcome: 'o' } ],
  reasoning: 'thinking', confidence: 0.8,
  ...( newSkills ? { newSkills } : {} ),
} as ExecutiveOutputFull )

/** Repertoire + reafference wired to a bus the way the orchestrator does. */
function wired(){
  const bus        = createTestBus()
  const repertoire = new SchemaRepertoire( INNATE_SCHEMAS )
  const engine     = new ReafferenceEngine( repertoire )

  bus.subscribe( engine.name, engine.subscribes(), e => { engine.onCognitiveEvent( e ) } )
  return { bus, repertoire }
}

const emit = ( bus: ReturnType<typeof createTestBus>, out: ExecutiveOutputFull ) => {
  publishCognitiveEvents( out, footprint( 10 ), bus, 1, new GenerativeModel() )
  bus.flush()
}

describe('composite learning — the mind can name a compound action', () => {
  it('registers a proposed composite into the repertoire, over the real bus', () => {
    const { bus, repertoire } = wired()
    const before = repertoire.schemas().length

    emit( bus, output( [ { id: 'brief-then-wait', composedOf: [ 'reach-out', 'wait' ] } ] ) )

    expect( repertoire.schemas().length ).toBe( before + 1 )
    const learned = repertoire.schemas().find( s => s.id === 'brief-then-wait')
    expect( learned ).toBeDefined()
    expect( learned!.kind ).toBe('composite')
    expect( learned!.composedOf ).toEqual( [ 'reach-out', 'wait' ] )
  } )

  it('carries the tags and cost the mind gave it', () => {
    const { bus, repertoire } = wired()
    emit( bus, output( [ { id: 'check-in', composedOf: [ 'reach-out', 'attend' ], tags: [ 'social' ], cost: 0.25 } ] ) )

    const learned = repertoire.schemas().find( s => s.id === 'check-in')!
    expect( learned.tags ).toEqual( [ 'social' ] )
    expect( learned.cost ).toBe( 0.25 )
  } )

  it('registers several proposals independently', () => {
    const { bus, repertoire } = wired()
    emit( bus, output( [
      { id: 'a-then-b', composedOf: [ 'reach-out', 'wait' ] },
      { id: 'c-then-d', composedOf: [ 'inspect', 'reflect' ] },
    ] ) )

    expect( repertoire.schemas().find( s => s.id === 'a-then-b') ).toBeDefined()
    expect( repertoire.schemas().find( s => s.id === 'c-then-d') ).toBeDefined()
  } )

  it('refuses a "composite" of one — that is just the schema it already had', () => {
    const { bus, repertoire } = wired()
    const before = repertoire.schemas().length

    emit( bus, output( [ { id: 'not-compound', composedOf: [ 'wait' ] } ] ) )

    expect( repertoire.schemas().length ).toBe( before )
  } )

  it('changes nothing when the mind names no skills (the ordinary cycle)', () => {
    const { bus, repertoire } = wired()
    const before = repertoire.schemas().length

    emit( bus, output() )

    expect( repertoire.schemas().length ).toBe( before )
  } )

  it('makes the learned skill available to the competition, not just the registry', () => {
    // The point of registering it: `AffordanceSynthesizer` builds candidates from
    // `repertoire.schemas()`, so a composite that lands here can be selected and
    // proceduralize into a habit. Before this seam had a producer, that gradient
    // was unreachable for every Will.
    const { bus, repertoire } = wired()
    emit( bus, output( [ { id: 'greet-and-ask', composedOf: [ 'reach-out', 'attend' ], tags: [ 'social' ] } ] ) )

    const ids = repertoire.schemas().map( s => s.id )
    expect( ids ).toContain('greet-and-ask')
    // and the innate floor is untouched
    expect( ids ).toContain('reach-out')
    expect( ids ).toContain('wait')
  } )
} )

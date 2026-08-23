// ─────────────────────────────────────────────────────────────
// tests/integration/sense.boundary.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Where this mind ends and its world begins.
 *
 * The invariant, stated behaviourally: A MIND ALONE IN THE DARK PERCEIVES
 * NOTHING. Cognition and world share one entity map, so nothing structural stops
 * the outward sense from walking the mind's own bookkeeping — and for five weeks
 * nothing did. A quiet 300-tick boot produced 36,721 percepts, all of them the
 * mind watching its own affordance field churn, against a 50-per-tick sensory
 * cap. What that cost was not visible where it was caused: the executive's
 * "Recently observed" ran on phantoms, and the agency, asked to find the action
 * in the situation, found a situation made entirely of its own bookkeeping.
 *
 * This is the guard that keeps the boundary true as the anatomy grows. It is
 * behavioural on purpose — a new engine writing a new undeclared entity type
 * fails it without anyone remembering a list exists.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
import { MIND_OWN_ENTITY_TYPES, endogenousTypes } from '#cognition/sense.boundary'
import type { WillConfig } from '#stem/mind'
import type { SimulationEntity } from '#core/types'

const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_SEMANTIC_RECALL:   'false',
  WILL_EMBEDDING_MODEL:   'none',
  WILL_VECTOR_MEMORY:     '',
  WILL_SUMMARY_INTERVAL:  '100000',
  WILL_EMBEDDING_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const _saved: Record<string, string | undefined> = {}

function makeConfig( id: string ): WillConfig {
  return {
    id, name: 'BoundaryWill', profile: null,
    identity: {
      prompt: 'I am a test mind used to prove the sense boundary holds.',
      values: [ 'clarity' ], traits: {}, style: 'quiet',
    },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 4242, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

interface Percept { entityId?: string; category?: string; summary?: string }

/** Every percept currently in state, as its metadata. */
function percepts( entities: Map<string, SimulationEntity> ): Percept[] {
  const out: Percept[] = []
  for( const e of entities.values() )
    if( e.type === 'percept') out.push( ( e.metadata ?? {} ) as Percept )
  return out
}

describe('the sense boundary — where I end and the world begins', () => {
  beforeAll( () => {
    setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: console.error } )
    for( const k of Object.keys( ENV_OVERRIDES ) ){
      _saved[ k ] = process.env[ k ]
      const v = ENV_OVERRIDES[ k ]
      if( v === undefined ) delete process.env[ k ]
      else process.env[ k ] = v
    }
  })
  afterAll( () => {
    resetLogger()
    for( const k of Object.keys( ENV_OVERRIDES ) ){
      const v = _saved[ k ]
      if( v === undefined ) delete process.env[ k ]
      else process.env[ k ] = v
    }
  })

  it('a mind alone in the dark perceives nothing', async () => {
    const { simulation } = assembleMind('dark', makeConfig('dark') )

    // Long enough for the agency pipeline, the executive, planning, calibration
    // and the affective layer to all have churned many times over.
    const offenders = new Map<string, string>()   // category → an example summary
    for( let i = 0; i < 300; i++ ){
      await simulation.step( 1 )
      const state = simulation.stateManager.snapshot() as never as { entities: Map<string, SimulationEntity> }
      for( const p of percepts( state.entities ) ){
        // EVERY percept, not only those whose category is already in the set.
        // Checking membership could only ever catch a type that is BOTH listed
        // and perceived — an enforcement failure — and was blind by construction
        // to a type MISSING from the list, which is the failure that actually
        // happened twice (`agency.enacted`, `agency.availability`). In the dark
        // there is no world, so any percept at all is the mind sensing itself.
        offenders.set( p.category ?? `removed:${ p.entityId }`, p.summary ?? '')
      }
    }

    expect( [ ...offenders ].map( ( [ c, s ] ) => `${ c } — ${ s }`),
      'the mind perceived its own machinery as world events')
      .toEqual( [] )
  }, 120_000 )

  it('the world still gets through — anything the mind did not write is perceived', async () => {
    const { simulation } = assembleMind('lit', makeConfig('lit') )
    await simulation.step( 3 )

    // A type no engine claims. The world is open: the mind has never heard of a
    // `weather-front` and perceives it anyway.
    simulation.stateManager.setEntity({
      id: 'front-1', type: 'weather-front',
      metadata: { name: 'a squall line', salience: 0.7 },
    })
    await simulation.step( 1 )

    const state = simulation.stateManager.snapshot() as never as { entities: Map<string, SimulationEntity> }
    expect( percepts( state.entities ).some( p => p.entityId === 'front-1') ).toBe( true )
  }, 60_000 )

  it('and its leaving is perceived too — a removal asks the same question', async () => {
    const { simulation } = assembleMind('gone', makeConfig('gone') )
    await simulation.step( 3 )

    simulation.stateManager.setEntity({
      id: 'front-2', type: 'weather-front', metadata: { name: 'a squall line' },
    })
    await simulation.step( 1 )
    simulation.stateManager.deleteEntity('front-2')
    await simulation.step( 1 )

    const state = simulation.stateManager.snapshot() as never as { entities: Map<string, SimulationEntity> }
    expect( percepts( state.entities ).some(
      p => p.entityId === 'front-2' && p.category === 'removed') ).toBe( true )
  }, 60_000 )

  it('a tenant\'s own cognitive engine declares its machinery and is not perceived', async () => {
    const { simulation } = assembleMind('tenant', makeConfig('tenant') )

    // A host brings its own faculty. It says what it writes ABOUT THE MIND, and
    // the container takes it at its word — no core edit, no list to find.
    simulation.addEngine({
      name:   'tenant-faculty',
      writes: [ 'tenant.rumination' ],
      async react(){
        return { commands: { set: [ { id: 'rum-1', type: 'tenant.rumination', metadata: {} } ] } }
      },
    })
    await simulation.step( 5 )

    const state = simulation.stateManager.snapshot() as never as { entities: Map<string, SimulationEntity> }
    expect( state.entities.has('rum-1') ).toBe( true )
    expect( percepts( state.entities ).some( p => p.entityId === 'rum-1') ).toBe( false )
  }, 60_000 )

  it('an undeclared host type stays world — silence is the right default for a tenant', () => {
    // The asymmetry the design rests on: the SELF is enumerable, the world is
    // not. So an engine that says nothing is assumed to be furnishing a world.
    const union = endogenousTypes( [ { name: 'quiet' } as never ] )
    expect( union ).toBe( MIND_OWN_ENTITY_TYPES )
    expect( union.has('weather-front') ).toBe( false )
  })
})

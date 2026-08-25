// ─────────────────────────────────────────────────────────────
// tests/integration/agency.looks-at-the-room.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The whole point of `inspect`: a mind that cannot place where it is looks.
 *
 * This is the loop the Discord bridge answers — a room arrives as a referent it
 * has not resolved, curiosity raises an `inspect` bound to that referent, the
 * host is asked, and the answer comes back as a percept it judges for itself.
 * Every piece shipped separately and the loop had never once run: live, `inspect`
 * proceduralized to habit 0.64 within fifteen ticks and spent its decisions on
 * `agency-intent-14` and `affordance-15-orient-orient` — the mind's own
 * bookkeeping, which Exteroception was handing it as world events.
 *
 * So the assertion that matters is not just that she looks, but WHAT AT. An
 * intent aimed at an engine-internal entity is the defect returning, and it is
 * invisible from inside a green suite otherwise.
 *
 * Driven through the cognitive bus rather than `auditionEngine.sense`, which
 * needs an LLM: everything downstream of the percept — tracker, synthesizer,
 * selector, executor — is the real pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
import { MIND_OWN_ENTITY_TYPES } from '#cognition/sense.boundary'
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
    id, name: 'RoomWill', profile: null,
    identity: {
      prompt: 'I am somewhere I have not been before.',
      values: [ 'clarity' ], traits: {}, style: 'quiet',
    },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 11, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

/** A heard message in a named room, as `senses.audition.percept` delivers it. */
const heardInGeneral = {
  type: 'senses.audition.percept', version: 1,
  sourceEngine: 'audition-engine', salience: 0.7,
  payload: {
    domain: 'audition', sourceEntityId: 'discord:U1',
    raw: {
      speakerName: 'Ada', threadId: 'discord:c1',
      direct: false, threadName: '#general in Mindot',
    },
  },
}

describe('a mind that cannot place where it is', () => {
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

  it('looks at the room, and never at its own bookkeeping', async () => {
    const { simulation } = assembleMind('room', makeConfig('room') )
    const bus = ( simulation.orchestrator as never as
      { _bus: { publish( e: unknown ): void } } )._bus

    const intents: Array<{ schema: string; target?: string }> = []
    const seen = new Set<string>()

    for( let i = 0; i < 200; i++ ){
      if( i % 20 === 5 ) bus.publish( heardInGeneral as never )
      await simulation.step( 1 )

      const state = simulation.stateManager.snapshot() as never as
        { entities: Map<string, SimulationEntity> }
      for( const [ id, e ] of state.entities ){
        if( e.type !== 'agency.intent' || seen.has( id ) ) continue
        seen.add( id )
        intents.push({
          schema: String( e.metadata?.['schema'] ?? '?'),
          target: typeof e.metadata?.['targetEntityId'] === 'string'
            ? e.metadata['targetEntityId'] as string : undefined,
        })
      }
    }

    const state = simulation.stateManager.snapshot() as never as
      { entities: Map<string, SimulationEntity> }

    // The room is a referent in its own right — a thing, met and named.
    const room = [ ...state.entities.values() ].find(
      e => e.type === 'known-entity' && e.metadata?.['name'] === '#general in Mindot')
    expect( room, 'the room never became something she knows about').toBeDefined()
    expect( room!.metadata?.['kind'] ).toBe('thing')

    const roomKeid = String( room!.metadata?.['keid'] )
    const looks    = intents.filter( i => i.schema === 'inspect')

    expect( looks.length, 'she never looked at anything').toBeGreaterThan( 0 )
    expect( looks.some( i => i.target === roomKeid ),
      `she looked, but never at the room: ${ JSON.stringify( looks ) }`).toBe( true )

    // The defect returning would look exactly like this: an act committed against
    // an entity that is the mind's own machinery rather than anything in a world.
    const internal = intents.filter( i => {
      if( !i.target ) return false
      const t = state.entities.get( i.target )
      return t !== undefined && MIND_OWN_ENTITY_TYPES.has( t.type ) && t.type !== 'known-entity'
    })
    expect( internal, 'an intent was aimed at the mind\'s own bookkeeping').toEqual( [] )

    // And every target is a referent, never a raw engine id.
    const enginey = intents.filter( i =>
      i.target !== undefined
      && /^(affordance|agency-intent|agency-outcome|ideomotor|facet|percept)[-:]/.test( i.target ) )
    expect( enginey, 'an intent was aimed at a raw engine entity id').toEqual( [] )
  }, 120_000 )
})

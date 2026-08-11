// ─────────────────────────────────────────────────────────────
// tests/integration/effector.reaches.the.host.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A host-owned effector the Will chooses must reach the host that owns it.
 *
 * It never did. `_emitDispatch` published `agency.invocation` on the
 * **CognitiveBus** — the mind's internal fabric, where affective.blender,
 * stress.regulator and attention.allocator appraise it. `WillStem` buffers
 * invocations for delivery from `simulation.eventBus.subscribeAll`, the
 * **observable** bus. The two have no bridge, so `bufferInvocation` was
 * subscribed to a bus that has never carried the event.
 *
 * Measured on a live boot: `agency.invocation.dispatched` incremented,
 * `pendingEffectorInvocations` stayed empty, the intent held `awaiting`, and
 * fifteen ticks later `[motor] ⏱ "inspect" timed out after 15 ticks`. Her
 * session log carried 449 `drive.energy` events and not one `agency.*`.
 *
 * Communication was always fine — the outbox is a separate mechanism, which is
 * why a Will could speak but never act on the world.
 *
 * Both ends were unit-tested and the crossing was not: `policy.*.test.ts` calls
 * `bufferInvocation` directly, true about the controller and silent about
 * whether anything reaches it. Same shape as the affordance-field hop, and this
 * test is deliberately at the seam.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
import type { WillConfig } from '#stem/mind'
import type { SimulationEntity, SimulationEvent } from '#core/types'

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
    id, name: 'ActingWill', profile: null,
    identity: {
      prompt: 'I am a mind with a hand.',
      values: [ 'curiosity' ], traits: {}, style: 'quiet',
    },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 11, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

/** A heard message in a named room — how a room becomes something to look at. */
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

describe('a host-owned effector', () => {
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

  it('reaches the bus the host is listening on', async () => {
    const { simulation } = assembleMind('acting', makeConfig('acting') )
    const bus = ( simulation.orchestrator as never as
      { _bus: { publish( e: unknown ): void } } )._bus

    // Exactly what WillStem subscribes to in order to buffer an invocation.
    const observed: SimulationEvent[] = []
    simulation.eventBus.subscribeAll( ( e: SimulationEvent ) => { observed.push( e ) } )

    for( let i = 0; i < 200; i++ ){
      if( i % 20 === 5 ) bus.publish( heardInGeneral as never )
      await simulation.step( 1 )
    }

    const invocations = observed.filter( e => e.type === 'agency.invocation')
    expect( invocations.length,
      'no invocation reached the observable bus — the host would never see it')
      .toBeGreaterThan( 0 )

    // And it must carry what a surface needs to act at all: the referent, plus
    // the host-side address that referent was met at.
    const inspect = invocations.find( e =>
      ( e.payload as Record<string, unknown> )['schema'] === 'inspect')
    expect( inspect, 'she never dispatched an inspect').toBeDefined()

    const payload = inspect!.payload as Record<string, unknown>
    expect( typeof payload['intentId'] ).toBe('string')      // the ack correlation handle
    expect( typeof payload['targetEntityId'] ).toBe('string')

    const state = simulation.stateManager.snapshot() as never as
      { entities: Map<string, SimulationEntity> }
    const room = [ ...state.entities.values() ].find(
      e => e.type === 'known-entity' && e.metadata?.['name'] === '#general in Mindot')

    // When the target is the room, the bridge must get the address it holds.
    const roomLooks = invocations.filter( e =>
      ( e.payload as Record<string, unknown> )['targetEntityId'] === String( room?.metadata?.['keid'] ) )
    if( roomLooks.length > 0 ){
      const addresses = ( roomLooks[0]!.payload as Record<string, unknown> )['targetAddresses']
      expect( Array.isArray( addresses ) && ( addresses as string[] ).includes('discord:c1'),
        `the bridge got no address it can use: ${ JSON.stringify( addresses ) }`).toBe( true )
    }
  }, 120_000 )
})

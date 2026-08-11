// ─────────────────────────────────────────────────────────────
// tests/integration/agency.stance-rotation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A mind with nothing to do does not get stuck doing one thing.
 *
 * The innate floor is entirely objectless — `orient · attend · rest · withdraw ·
 * reflect · wait · express` — and satiation could not touch it: with no target
 * to key on, `enactionFootprint` returned 0 at its first line, and the field it
 * fed was dropped at the state hop anyway. So `repeat` (−0.30, the largest
 * damping weight) was zero for the floor while `habit` (+0.20) outweighed the
 * novelty a practised act spends (−0.10). A stance that won once won harder next
 * tick, forever.
 *
 * Measured, 300 quiet ticks: `express` took 144 of 145 decisions at habit 1.0.
 * Not a preference — a tic, and the mind held no representation with which to
 * notice it. After: 32 of 142, with the whole floor rotating.
 *
 * The fix gives the mind the FACT ("I have just done this", from the durable
 * `LearnedSkill.lastEnactedTick`) and lets the existing competition weigh it.
 * Nothing forbids repetition: a real need still out-competes a decaying damp,
 * which is why `rest` still wins when energy actually falls.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
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
    id, name: 'QuietWill', profile: null,
    identity: {
      prompt: 'I am a test mind with nothing in particular to do.',
      values: [ 'patience' ], traits: {}, style: 'quiet',
    },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 4242, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

describe('a mind with nothing to do', () => {
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

  it('rotates its stances instead of proceduralising one into a tic', async () => {
    const { simulation } = assembleMind('quiet', makeConfig('quiet') )

    const chosen      = new Map<string, number>()
    const seenIntents = new Set<string>()

    for( let i = 0; i < 300; i++ ){
      await simulation.step( 1 )
      const state = simulation.stateManager.snapshot() as never as { entities: Map<string, SimulationEntity> }
      for( const [ id, e ] of state.entities ){
        if( e.type !== 'agency.intent' || seenIntents.has( id ) ) continue
        seenIntents.add( id )
        const schema = String( e.metadata?.['schema'] ?? '?')
        chosen.set( schema, ( chosen.get( schema ) ?? 0 ) + 1 )
      }
    }

    const total = [ ...chosen.values() ].reduce( ( a, b ) => a + b, 0 )
    expect( total, 'the mind should be acting at all').toBeGreaterThan( 50 )

    const report = [ ...chosen ].sort( ( a, b ) => b[1] - a[1] )
      .map( ( [ s, n ] ) => `${ s }=${ n }`).join(' ')

    // No single stance owns the mind. The pre-fix run sat at 99%.
    const [ , topCount ] = report ? [ ...chosen ].sort( ( a, b ) => b[1] - a[1] )[0]! : [ '', 0 ]
    expect( topCount / total, `one stance dominates: ${ report }`).toBeLessThan( 0.6 )

    // And it is genuinely rotating, not alternating between two.
    expect( chosen.size, `too few distinct stances: ${ report }`).toBeGreaterThanOrEqual( 4 )
  }, 120_000 )
})

// ─────────────────────────────────────────────────────────────
// tests/unit/agency.acp-attention.test.ts
// ─────────────────────────────────────────────────────────────
// ACP-P2, first consumer (ACTION_CONDITIONED_PREDICTION §3). Measurement
// drove the design: after a stable stretch the salience denominator (EW
// variance) collapses, so ANY deviation saturates `attention.state.changed`
// salience at 1.0 — a conservative anticipation nudge is invisible there. The
// measurable lever is PRECISION: after our own enaction the next observe of
// the two gating streams carries self-caused weight (×0.35 — below the
// workspace gate even at saturation), restored explicitly after one observe
// so a genuine world surprise the following tick is NOT dampened.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity } from '#core/types'
import { AttentionAllocator } from '#faculties/attention.allocator'
import { WORKSPACE_THRESHOLD } from '#faculties/executive.engine/config'

const CTX = {} as unknown as SimulationContext

function loadState( perceptCount: number, salience = 0.5 ): ReadonlySimulationState {
  const entities = new Map<string, SimulationEntity>()
  for( let i = 0; i < perceptCount; i++ )
    entities.set(`p-${ i }`, { id: `p-${ i }`, type: 'percept', createdAt: 0, updatedAt: 0,
      metadata: { salience } } as SimulationEntity )
  return { tick: 1, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
}

function busSpy(): { bus: unknown; events: Array<{ type: string; salience: number }> } {
  const events: Array<{ type: string; salience: number }> = []
  return { bus: { publish: ( e: { type: string; salience: number } ) => events.push( e ) }, events }
}

const enaction = ( type: string ) => ({
  type, version: 1, sourceEngine: 'motor-schema-executor', salience: 0.6,
  payload: { schema: 'reach-out', intentId: 'i1', targetEntityId: 'alice', parameters: {}, tick: 30 },
}) as never

/** Prime an allocator on a steady load until its usage/free predictions settle. */
async function primed(): Promise<{ alloc: AttentionAllocator; events: Array<{ type: string; salience: number }> }> {
  const alloc = new AttentionAllocator()
  const spy = busSpy(); alloc.attachBus( spy.bus as never )
  for( let t = 0; t < 30; t++ ) await alloc.react( 1000, t, loadState( 3 ), CTX )
  spy.events.length = 0   // discard priming-phase publishes
  return { alloc, events: spy.events }
}

const stateChangeSalience = ( events: Array<{ type: string; salience: number }> ) =>
  events.find( e => e.type === 'attention.state.changed')?.salience

describe('AttentionAllocator — efferent anticipation (ACP-P2 first consumer)', () => {
  it('an unprompted load shift saturates surprise — the world grabs the workspace (control)', async () => {
    const base = await primed()
    await base.alloc.react( 1000, 31, loadState( 8, 0.9 ), CTX )
    const sal = stateChangeSalience( base.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )   // recruits
  })

  it('the same shift right after our own enaction carries self-caused weight — below the workspace gate', async () => {
    const acp = await primed()
    acp.alloc.onCognitiveEvent( enaction('agency.communicate') )
    await acp.alloc.react( 1000, 31, loadState( 8, 0.9 ), CTX )
    const sal = stateChangeSalience( acp.events )
    // Still published (the state DID change — gating is error-based), but its
    // workspace pull is attenuated below the recruitment threshold.
    if( sal !== undefined ) expect( sal ).toBeLessThan( WORKSPACE_THRESHOLD )
  })

  it('precision is restored after ONE observe: a world shift the NEXT tick surprises at full weight', async () => {
    const acp = await primed()
    acp.alloc.onCognitiveEvent( enaction('agency.enacted') )
    await acp.alloc.react( 1000, 31, loadState( 8, 0.9 ), CTX )   // self-caused, attenuated
    acp.events.length = 0
    await acp.alloc.react( 1000, 32, loadState( 1, 0.2 ), CTX )   // the world collapses the load
    const sal = stateChangeSalience( acp.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )   // NOT dampened
  })

  it('subscribes to all three enaction events', () => {
    const subs = new AttentionAllocator().subscribes()
    for( const t of [ 'agency.enacted', 'agency.communicate', 'agency.invocation' ] )
      expect( subs ).toContain( t )
  })
})

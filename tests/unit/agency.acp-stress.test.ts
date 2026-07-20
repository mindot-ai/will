// ─────────────────────────────────────────────────────────────
// tests/unit/agency.acp-stress.test.ts
// ─────────────────────────────────────────────────────────────
// ACP-P2, final inventoried consumer: the StressRegulator knows when a stress
// swing is its own doing. Precision-only (no directional prior — acting can
// load OR relieve), restored after exactly one observe.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity } from '#core/types'
import { StressRegulator } from '#faculties/stress.regulator'
import { WORKSPACE_THRESHOLD } from '#faculties/executive.engine/config'

const CTX = {} as unknown as SimulationContext

function loadMetric( load: number ): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map<string, SimulationEntity>(),
    metrics: new Map([ [ 'stress.load', load ] ]) } as unknown as ReadonlySimulationState
}
function busSpy(): { bus: unknown; events: Array<{ type: string; salience: number }> } {
  const events: Array<{ type: string; salience: number }> = []
  return { bus: { publish: ( e: { type: string; salience: number } ) => events.push( e ) }, events }
}
const enaction = { type: 'agency.invocation', version: 1, sourceEngine: 'motor-schema-executor',
  salience: 0.6, payload: { schema: 'wave-hands', intentId: 'i1', tick: 30 } } as never

async function primed(): Promise<{ reg: StressRegulator; events: Array<{ type: string; salience: number }> }> {
  const reg = new StressRegulator()
  const spy = busSpy(); reg.attachBus( spy.bus as never )
  for( let t = 0; t < 30; t++ ) await reg.react( 1000, t, loadMetric( 10 ), CTX )
  spy.events.length = 0
  return { reg, events: spy.events }
}
const changedSalience = ( events: Array<{ type: string; salience: number }> ) =>
  events.find( e => e.type === 'stress.state.changed')?.salience

describe('StressRegulator — efferent anticipation (ACP-P2 final consumer)', () => {
  it('an unprompted stress jolt reaches the workspace (control)', async () => {
    const base = await primed()
    await base.reg.react( 1000, 31, loadMetric( 85 ), CTX )
    const sal = changedSalience( base.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )
  })

  it('the same jolt right after our own enaction carries self-caused weight — below the gate', async () => {
    const acp = await primed()
    acp.reg.onCognitiveEvent( enaction )
    await acp.reg.react( 1000, 31, loadMetric( 85 ), CTX )
    const sal = changedSalience( acp.events )
    expect( sal ).toBeDefined()                        // zone change still publishes
    expect( sal! ).toBeLessThan( WORKSPACE_THRESHOLD ) // …but does not recruit
  })

  it('precision restores after ONE observe: the world can jolt at full weight next tick', async () => {
    const acp = await primed()
    acp.reg.onCognitiveEvent( enaction )
    await acp.reg.react( 1000, 31, loadMetric( 85 ), CTX )
    acp.events.length = 0
    await acp.reg.react( 1000, 32, loadMetric( 5 ), CTX )   // the world swings back
    const sal = changedSalience( acp.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )
  })

  it('subscribes to all three enaction events', () => {
    const subs = new StressRegulator().subscribes()
    for( const t of [ 'agency.enacted', 'agency.communicate', 'agency.invocation' ] )
      expect( subs ).toContain( t )
  })
})

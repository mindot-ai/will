// ─────────────────────────────────────────────────────────────
// tests/unit/agency.acp-blender.test.ts
// ─────────────────────────────────────────────────────────────
// ACP-P2, second consumer: the AffectiveBlender knows when an arousal swing
// is its own doing. Same measured pattern as the AttentionAllocator: the
// self-caused observe carries ACP_SELF_PRECISION (< WORKSPACE_THRESHOLD even
// at saturation), restored explicitly after one observe so the world's own
// jolts land at full weight the very next tick.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity } from '#core/types'
import { AffectiveBlender } from '#faculties/affective.blender'
import { WORKSPACE_THRESHOLD } from '#faculties/executive.engine/config'

const CTX = {} as unknown as SimulationContext

function emotionState( metrics: Record<string, number> ): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map<string, SimulationEntity>(),
    metrics: new Map( Object.entries( metrics ) ) } as unknown as ReadonlySimulationState
}

function busSpy(): { bus: unknown; events: Array<{ type: string; salience: number }> } {
  const events: Array<{ type: string; salience: number }> = []
  return { bus: { publish: ( e: { type: string; salience: number } ) => events.push( e ) }, events }
}

const enaction = ( type: string ) => ({
  type, version: 1, sourceEngine: 'motor-schema-executor', salience: 0.6,
  payload: { schema: 'reach-out', intentId: 'i1', tick: 30 },
}) as never

const CALM  = { 'emotion.contentment': 0.3 }
const JOLT  = { 'emotion.fear': 0.9, 'emotion.vigilance': 0.8 }   // arousal spike

/** Prime a blender on a calm emotional field until its arousal prediction settles. */
async function primed(): Promise<{ blender: AffectiveBlender; events: Array<{ type: string; salience: number }> }> {
  const blender = new AffectiveBlender()
  const spy = busSpy(); blender.attachBus( spy.bus as never )
  for( let t = 0; t < 30; t++ ) await blender.react( 1000, t, emotionState( CALM ), CTX )
  spy.events.length = 0
  return { blender, events: spy.events }
}

const changedSalience = ( events: Array<{ type: string; salience: number }> ) =>
  events.find( e => e.type === 'affect.state.changed')?.salience

describe('AffectiveBlender — efferent anticipation (ACP-P2 second consumer)', () => {
  it('an unprompted arousal jolt reaches the workspace (control)', async () => {
    const base = await primed()
    await base.blender.react( 1000, 31, emotionState( JOLT ), CTX )
    const sal = changedSalience( base.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )
  })

  it('the same jolt right after our own enaction carries self-caused weight — below the gate', async () => {
    const acp = await primed()
    acp.blender.onCognitiveEvent( enaction('agency.communicate') )
    await acp.blender.react( 1000, 31, emotionState( JOLT ), CTX )
    const sal = changedSalience( acp.events )
    expect( sal ).toBeDefined()                        // affect.state.changed always publishes
    expect( sal! ).toBeLessThan( WORKSPACE_THRESHOLD ) // …but does not recruit
  })

  it('precision restores after ONE observe: the world can jolt at full weight next tick', async () => {
    const acp = await primed()
    acp.blender.onCognitiveEvent( enaction('agency.enacted') )
    await acp.blender.react( 1000, 31, emotionState( JOLT ), CTX )    // self-caused, attenuated
    acp.events.length = 0
    await acp.blender.react( 1000, 32, emotionState( CALM ), CTX )    // the world swings back
    const sal = changedSalience( acp.events )
    expect( sal ).toBeDefined()
    expect( sal! ).toBeGreaterThanOrEqual( WORKSPACE_THRESHOLD )
  })

  it('subscribes to all three enaction events', () => {
    const subs = new AffectiveBlender().subscribes()
    for( const t of [ 'agency.enacted', 'agency.communicate', 'agency.invocation' ] )
      expect( subs ).toContain( t )
  })
})

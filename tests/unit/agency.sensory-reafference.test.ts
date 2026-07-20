// ─────────────────────────────────────────────────────────────
// tests/unit/agency.sensory-reafference.test.ts
// ─────────────────────────────────────────────────────────────
// EXAFFERENCE P5 — sensory reafference learns. When the world echoes our own
// action back through the senses (a P2-tagged `reafferent` percept carrying
// `sourceIntentId`) and the intent is still `awaiting` with no host ack, the
// ReafferenceEngine synthesizes a SOFT outcome: the skill accrues competence
// and the awaiting intent is freed — instead of sitting until AWAIT_TIMEOUT and
// being learned as a failure. A host ack (or any real outcome) WINS: it grades
// the intent and the sensory path stands down, never double-scoring.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = (): MutState => ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState
function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}
const metricVal = ( c: StateCommands | undefined, k: string ) => ( c?.metrics ?? [] ).find( m => m[0] === k )?.[1]

/** Seed an `awaiting` external intent with its persisted efference copy. */
function awaitingIntent( s: MutState, id: string, schema: string ): void {
  s.entities.set( id, { id, type: 'agency.intent', createdAt: 0, updatedAt: 0, metadata: {
    status: 'awaiting', schema, parameters: {}, predictedReward: 0.5, predictedValence: 0, dispatchedAt: 1,
  } } as SimulationEntity )
}
/** Seed a percept as P2 would tag a matched echo of our own words. */
function reafferentPercept( s: MutState, id: string, sourceIntentId: string, tick: number ): void {
  s.entities.set( id, { id, type: 'percept', createdAt: 0, updatedAt: 0, metadata: {
    provenance: 'reafferent', sourceIntentId, salience: 0.2, category: 'message', tick,
  } } as SimulationEntity )
}
function realOutcome( s: MutState, id: string, schema: string, intentId: string ): void {
  s.entities.set( id, { id, type: 'agency.outcome', createdAt: 0, updatedAt: 0, metadata: {
    schema, intentId, success: true, outcomeQuality: 0.8, predictedReward: 0.5,
  } } as SimulationEntity )
}

describe('ReafferenceEngine — sensory reafference (P5)', () => {
  it('an echo of our own action confirms an ack-less awaiting intent: skill learns + intent freed', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    awaitingIntent( s, 'intent-say', 'reach-out')
    reafferentPercept( s, 'percept-echo', 'intent-say', 3 )

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    // A soft confirmation was recorded…
    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 1 )
    expect( metricVal( r.commands, 'agency.learning.updates') ).toBe( 1 )
    const skill = rep.skills().get('reach-out')
    expect( skill ).toBeDefined()
    expect( skill!.enactments ).toBe( 1 )
    expect( skill!.successes ).toBe( 1 )                 // manifested = success
    // …and the awaiting intent was freed (no longer blocking the serial Will).
    expect( s.entities.get('intent-say') ).toBeUndefined()
  })

  it('a host ack WINS: a graded intent is not also sensory-scored (no double count)', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    awaitingIntent( s, 'intent-say', 'reach-out')
    realOutcome( s, 'agency-outcome-real', 'reach-out', 'intent-say')   // the ack
    reafferentPercept( s, 'percept-echo', 'intent-say', 3 )             // and the echo

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    // Only the real outcome scored — the sensory path stood down.
    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 0 )
    expect( metricVal( r.commands, 'agency.learning.updates') ).toBe( 1 )
    const skill = rep.skills().get('reach-out')!
    expect( skill.enactments ).toBe( 1 )                 // once, not twice
    expect( skill.valueEstimate ).toBeGreaterThan( 0 )   // graded by the ack's 0.8, not the soft 0.6
  })

  it('a reafferent percept for an already-resolved intent (not awaiting) does nothing', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    reafferentPercept( s, 'percept-echo', 'intent-gone', 3 )   // no awaiting intent by that id

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 0 )
    expect( metricVal( r.commands, 'agency.learning.updates') ).toBe( 0 )
    expect( rep.skills().size ).toBe( 0 )
  })

  it('an EXAFFERENT percept (the world, not our echo) never confirms anything', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    awaitingIntent( s, 'intent-say', 'reach-out')
    s.entities.set('percept-world', { id: 'percept-world', type: 'percept', createdAt: 0, updatedAt: 0, metadata: {
      provenance: 'exafferent', salience: 0.9, category: 'message', tick: 3,
    } } as SimulationEntity )

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 0 )
    expect( s.entities.get('intent-say') ).toBeDefined()   // still awaiting
  })

  it('scores each awaiting intent at most once even with several echoes', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    awaitingIntent( s, 'intent-say', 'reach-out')
    reafferentPercept( s, 'percept-echo-1', 'intent-say', 3 )
    reafferentPercept( s, 'percept-echo-2', 'intent-say', 3 )

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 1 )
    expect( rep.skills().get('reach-out')!.enactments ).toBe( 1 )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/agency.learning.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 3 + 4 — the growth engine. Proves the repertoire learns from outcomes
// (value, habit, the proceduralization curve, forgetting), the ReafferenceEngine
// drives it from state, and — the payoff — that a schema enacted reliably through
// the FULL pipeline proceduralizes and then stops recruiting the LLM.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { reconcileInvocation } from '#agency/reconcile.learning'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { ActionSelector } from '#agency/engines/action.selector'
import { DeliberationEngine } from '#agency/engines/deliberation.engine'
import { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = ( metrics: Record<string, number> = {} ): MutState =>
  ({ tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}
const ofType = ( s: MutState, t: string ) => [ ...s.entities.values() ].filter( e => e.type === t )
const metricVal = ( c: StateCommands | undefined, k: string ) => ( c?.metrics ?? [] ).find( m => m[0] === k )?.[1]

function outcomeEnt( s: MutState, id: string, schema: string ): void {
  s.entities.set( id, { id, type: 'agency.outcome', createdAt: 0, updatedAt: 0,
    metadata: { schema, success: true, outcomeQuality: 0.8, predictedReward: 0.8 } } as SimulationEntity )
}
function busSpy(): { bus: unknown; events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return { bus: { publish: ( e: { type: string; payload: Record<string, unknown> } ) => events.push( e ) }, events }
}

describe('ReafferenceEngine — discovery & creation hooks', () => {
  it('emits agency.schema.discovered on the FIRST enaction only', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const spy = busSpy(); reaff.attachBus( spy.bus as never )

    const s = freshState()
    outcomeEnt( s, 'agency-outcome-1', 'rest')
    const r1 = await reaff.react( 0, 5, frozen( s ), CTX ); apply( s, r1.commands )
    expect( spy.events.filter( e => e.type === 'agency.schema.discovered') ).toHaveLength( 1 )
    expect( metricVal( r1.commands, 'agency.discovered.count') ).toBe( 1 )

    // Second enaction of the same schema → already known → no re-discovery.
    spy.events.length = 0
    outcomeEnt( s, 'agency-outcome-2', 'rest')
    const r2 = await reaff.react( 0, 6, frozen( s ), CTX )
    expect( spy.events.filter( e => e.type === 'agency.schema.discovered') ).toHaveLength( 0 )
    expect( metricVal( r2.commands, 'agency.discovered.count') ).toBe( 0 )
  })

  it('registers a composite proposed via agency.composite.proposed (creation seam)', () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    reaff.onCognitiveEvent({ type: 'agency.composite.proposed',
      payload: { id: 'settle', composedOf: [ 'withdraw', 'rest', 'reflect' ], tags: [ 'self-care' ] } } as never )

    const s = rep.getSchema('settle')
    expect( s?.kind ).toBe('composite')
    expect( s?.composedOf ).toEqual( [ 'withdraw', 'rest', 'reflect' ] )
  })

  it('ignores a malformed composite proposal (no id / fewer than 2 steps)', () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    reaff.onCognitiveEvent({ type: 'agency.composite.proposed', payload: { id: 'x', composedOf: [ 'rest' ] } } as never )
    expect( rep.getSchema('x') ).toBeUndefined()
  })
})

// ── repertoire learning rules ────────────────────────────────────────────────

describe('SchemaRepertoire — learning rules', () => {
  it('confident success grows habit; surprise/failure erodes it', () => {
    const rep = new SchemaRepertoire()
    const up  = rep.recordOutcome({ schema: 'rest', success: true, outcomeQuality: 0.85, predictedReward: 0.85, tick: 1 })
    expect( up.skill.habitStrength ).toBeGreaterThan( 0 )

    const before = rep.recordOutcome({ schema: 'rest', success: true, outcomeQuality: 0.85, predictedReward: 0.85, tick: 2 }).skill.habitStrength
    const after  = rep.recordOutcome({ schema: 'rest', success: false, outcomeQuality: 0.1, predictedReward: 0.85, tick: 3 }).skill.habitStrength
    expect( after ).toBeLessThan( before )   // a failure/surprise erodes the habit
  })

  it('valueEstimate moves (EMA) toward observed outcome quality', () => {
    const rep = new SchemaRepertoire()
    const s = rep.recordOutcome({ schema: 'y', success: true, outcomeQuality: 1, predictedReward: 0.5, tick: 1 }).skill
    expect( s.valueEstimate ).toBeGreaterThan( 0.5 )
    expect( s.valueEstimate ).toBeLessThan( 1 )
  })

  it('repeated reliable, predictable success proceduralizes (crosses the threshold once)', () => {
    const rep = new SchemaRepertoire()
    let proceduralizedFires = 0
    for( let i = 0; i < 20; i++ )
      if( rep.recordOutcome({ schema: 'z', success: true, outcomeQuality: 0.9, predictedReward: 0.9, tick: i }).proceduralized )
        proceduralizedFires++

    expect( rep.getSkill('z')!.habitStrength ).toBeGreaterThanOrEqual( 0.6 )
    expect( proceduralizedFires ).toBe( 1 )   // the crossing is reported exactly once
  })

  it('forgets a learned composite that decays below the floor while idle', () => {
    const rep = new SchemaRepertoire()
    rep.registerComposite({ id: 'macro', kind: 'composite', source: 'repertoire', binds: 'none', cost: 0.1, composedOf: [ 'rest', 'wait' ] })
    rep.recordOutcome({ schema: 'macro', success: true, outcomeQuality: 0.5, predictedReward: 0.5, tick: 1 })

    let dropped: string[] = []
    for( let t = 1000; t < 1012; t++ ) dropped = dropped.concat( rep.decay( t ) )

    expect( dropped ).toContain('macro')
    expect( rep.getSchema('macro') ).toBeUndefined()   // template forgotten too
  })
})

// ── the reafference engine ───────────────────────────────────────────────────

describe('ReafferenceEngine — outcomes → competence', () => {
  it('folds an outcome into the skill, mirrors an agency.skill entity, and consumes the outcome', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()
    s.entities.set('agency-outcome-1-x', {
      id: 'agency-outcome-1-x', type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'rest', success: true, outcomeQuality: 0.8, predictedReward: 0.8 },
    } )

    apply( s, ( await reaff.react( 0, 5, frozen( s ), CTX ) ).commands )

    expect( rep.getSkill('rest') ).toBeDefined()
    expect( s.entities.has('agency-outcome-1-x') ).toBe( false )          // consumed
    const skill = ofType( s, 'agency.skill')[0]
    expect( skill?.metadata?.['schema'] ).toBe('rest')
    expect( s.metrics.get('agency.skill.count') ).toBe( 1 )
  })

  it('host-ack reconciliation: a confirmed invocation learns AND frees the awaiting intent', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    // An external effector is in flight, awaiting the host.
    s.entities.set('agency-intent-9', {
      id: 'agency-intent-9', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'open_airlock', status: 'awaiting', predictedReward: 0.5 },
    } )

    // The host executes it and acks → write the reconciliation outcome.
    const outcome = reconcileInvocation('agency-intent-9', 'open_airlock',
      { success: true, outcomeQuality: 0.85, description: 'Airlock opened.' }, 10, { reward: 0.5, valence: 0 } )
    s.entities.set( outcome.id, { createdAt: 0, updatedAt: 0, ...outcome } as never )

    apply( s, ( await reaff.react( 0, 11, frozen( s ), CTX ) ).commands )

    // Learned from the real result…
    expect( rep.getSkill('open_airlock')?.enactments ).toBe( 1 )
    // …and the serial Will is free again.
    expect( s.entities.has('agency-intent-9') ).toBe( false )
  })

  it('host-ack of a PLAN step emits action.outcome{planId,stepId} (the async plan-advance signal)', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const spy   = busSpy(); reaff.attachBus( spy.bus as never )
    const s     = freshState()

    // An external action committed from a plan's frontier prior, awaiting the host.
    s.entities.set('agency-intent-7', {
      id: 'agency-intent-7', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'open_airlock', status: 'awaiting', planId: 'plan-3', stepId: 'step-1', predictedReward: 0.5 },
    } )

    // The host acks → reconcile carries the intent's plan provenance onto the outcome.
    const outcome = reconcileInvocation('agency-intent-7', 'open_airlock',
      { success: true, outcomeQuality: 0.9, description: 'Airlock opened.' }, 12,
      { reward: 0.5, valence: 0 }, { planId: 'plan-3', stepId: 'step-1' } )
    expect( outcome.metadata?.[ 'planId' ] ).toBe('plan-3')
    s.entities.set( outcome.id, { createdAt: 0, updatedAt: 0, ...outcome } as never )

    apply( s, ( await reaff.react( 0, 13, frozen( s ), CTX ) ).commands )

    // The executor never saw this ack (the intent was awaiting), so reafference is the
    // SOLE emitter of the action.outcome the PlanningEngine advances on.
    const ao = spy.events.find( e => e.type === 'action.outcome')
    expect( ao ).toBeDefined()
    expect( ao!.payload[ 'planId' ] ).toBe('plan-3')
    expect( ao!.payload[ 'stepId' ] ).toBe('step-1')
    expect( ao!.payload[ 'success' ] ).toBe( true )
    // …and the awaiting intent is freed.
    expect( s.entities.has('agency-intent-7') ).toBe( false )
  })
})

// ── end-to-end: the Will grows ───────────────────────────────────────────────

describe('full pipeline — a schema proceduralizes through use, then skips the LLM', () => {
  it('synth → select → execute → learn, over many ticks, builds a habit', async () => {
    const rep   = new SchemaRepertoire()
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( rep )
    const sel   = new ActionSelector()
    const delib = new DeliberationEngine()   // no executive → confirms the substrate winner (System 1)
    const exec  = new MotorSchemaExecutor(); exec.attachRepertoire( rep )
    const reaff = new ReafferenceEngine( rep )

    // A persistently tired Will: rest stays the strongly-driven, available choice.
    const s = freshState({ 'energy.level': 25 })

    // Mini-orchestrator: every engine reads the same frozen snapshot, then all
    // commands are applied together — exactly the real tick contract.
    const step = async ( tick: number ) => {
      const cmds: ( StateCommands | undefined )[] = []
      for( const eng of [ synth, sel, delib, exec, reaff ] )
        cmds.push( ( await eng.react( 0, tick, frozen( s ), CTX ) ).commands )
      for( const c of cmds ) apply( s, c )
    }
    for( let t = 1; t <= 50; t++ ) await step( t )

    const rest = rep.getSkill('rest')
    expect( rest ).toBeDefined()
    expect( rest!.enactments ).toBeGreaterThan( 3 )                 // it actually ran, repeatedly
    expect( rest!.habitStrength ).toBeGreaterThanOrEqual( 0.6 )     // …and became a habit
    expect( s.metrics.get('agency.habitual.count') ).toBeGreaterThanOrEqual( 1 )

    // The payoff: with the LEARNED habit, a stakes condition that recruits the LLM
    // for a novice no longer does so for this expert.
    const restField = ( habit: number ) => {
      const fs = freshState({ 'threat.level': 0.7 })
      fs.entities.set('aff-rest', {
        id: 'aff-rest', type: 'affordance', createdAt: 0, updatedAt: 0,
        metadata: {
          schema: 'rest', source: 'innate', parameters: {}, expectedReward: 0.9, expectedValence: 0.2,
          cost: 0, habitStrength: habit, available: true, tags: [ 'regulatory' ], tick: 0,
        },
      } )
      return fs
    }
    const deliberate = async ( habit: number ) => {
      const r = await new ActionSelector().react( 0, 1, frozen( restField( habit ) ), CTX )
      return ( r.commands?.metrics ?? [] ).find( m => m[0] === 'agency.selection.deliberate')?.[1]
    }
    expect( await deliberate( 0 ) ).toBe( 1 )                       // novice deliberates
    expect( await deliberate( rest!.habitStrength ) ).toBe( 0 )     // expert does not
  })
})

// ── snapshot/restore: a learned composite survives ──────────────────────────
// A composite lives only in the in-memory repertoire `_templates`. Reafference
// mirrors it to an `agency.schema` entity so it travels with the deterministic
// state snapshot; on restore the repertoire is rebuilt innate-only and the
// synthesizer rehydrates the template before the executor needs to resolve it.

describe('composite schemas survive snapshot + restore', () => {
  it('mirrors a composite to agency.schema, rehydrates it on restore, and the executor still expands it', async () => {
    // ── Phase 1: a Will invents a composite and lives a tick ──
    const repA   = new SchemaRepertoire()
    repA.registerComposite({
      id: 'macro', kind: 'composite', source: 'repertoire', binds: 'none',
      cost: 0.1, composedOf: [ 'rest', 'wait' ],
    })
    const reaffA = new ReafferenceEngine( repA )

    const s = freshState()
    // Reafference mirrors the repertoire's composites into agency.schema entities.
    apply( s, ( await reaffA.react( 0, 5, frozen( s ), CTX ) ).commands )

    const mirrored = ofType( s, 'agency.schema')
    expect( mirrored ).toHaveLength( 1 )
    expect( mirrored[0]?.id ).toBe('agency-schema-macro')
    expect( mirrored[0]?.metadata?.['composedOf'] ).toEqual( [ 'rest', 'wait' ] )

    // ── Phase 2: snapshot/restore ──
    // assembleMind rebuilds the repertoire innate-only; stateManager.restore
    // brings the entities (incl. agency-schema-macro) back. Model that with a
    // fresh repertoire + fresh engines reading the SAME state `s`.
    const repB   = new SchemaRepertoire()
    const synthB = new AffordanceSynthesizer(); synthB.attachRepertoire( repB )
    const execB  = new MotorSchemaExecutor();   execB.attachRepertoire( repB )

    expect( repB.getSchema('macro') ).toBeUndefined()   // the bug: the definition is gone

    // A composite intent was committed pre-snapshot and is restored mid-flight.
    s.entities.set('agency-intent-macro', {
      id: 'agency-intent-macro', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'macro', status: 'selected' },
    } )

    // ── One restored tick: synth (ticks first) rehydrates → executor resolves ──
    const restoredStep = async ( tick: number ) => {
      const cmds: ( StateCommands | undefined )[] = []
      for( const eng of [ synthB, execB ] )
        cmds.push( ( await eng.react( 0, tick, frozen( s ), CTX ) ).commands )
      for( const c of cmds ) apply( s, c )
    }
    await restoredStep( 6 )

    // Rehydrated from the agency.schema entity — and within the same tick, so the
    // executor (which ticks after the synthesizer) saw a whole repertoire.
    expect( repB.getSchema('macro')?.kind ).toBe('composite')

    // The payoff: the executor EXPANDED the macro (composite path) instead of
    // misrouting it to the host — the parent is 'expanding' and its first
    // sub-intent (step 0 = 'rest') exists.
    expect( s.entities.get('agency-intent-macro')?.metadata?.['status'] ).toBe('expanding')
    expect( s.entities.get('agency-intent-macro-sub-0')?.metadata?.['schema'] ).toBe('rest')
  })
})

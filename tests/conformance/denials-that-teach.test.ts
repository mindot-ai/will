// ─────────────────────────────────────────────────────────────
// tests/conformance/denials-that-teach.test.ts
// ─────────────────────────────────────────────────────────────
// Will's implementation of the HELM × Will conformance pack. The scenarios
// themselves live in `scenarios.ts` — language-neutral, serializable, and the
// half we contribute upstream. This file proves Will satisfies them.
//
// Everything here asserts OBSERVABLE STATE, never a type name: availability,
// competence, what reached the world, what was recorded. That is the point —
// a consumer conforms by behaving correctly, whatever it calls things inside.
//
// Verdicts are written in HELM's WIRE spelling and pushed through `helmAdapter`
// below, which is the four-arm map the P6 transport will reuse verbatim. So the
// pack exercises the translation too, not just the fates behind it.

import { describe, it, expect, afterEach } from 'vitest'
import { SCENARIOS, packSummary, type Scenario } from './scenarios'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { scoreAffordance, DEFAULT_WEIGHTS } from '#agency/selection.scoring'
import { effectorController } from '#stem/tracts/effector.controller'
import {
  setVerdictRecorder, clearVerdictRecorder,
  setVerdictSource, clearVerdictSource, RecordedVerdictSource,
  type PolicyVerdictRecord,
} from '#stem/policy/verdict.recorder'
import type { PolicyArbiter, Verdict } from '#stem/policy/arbiter'
import type { WillInstance } from '#stem/index'
import type { effectorInvocation } from '#types'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import type { Affordance } from '#agency/types'

const WILL_ID = 'conformance-will'
const CTX     = {} as unknown as SimulationContext
const SCHEMA  = 'trade'

// ── the wire → Will map (the P6 adapter, in miniature) ───────────────────────
//
// HELM's four finality values become Will's two axes. This is the ONLY place
// HELM's spellings appear; everything downstream speaks Will's vocabulary.

type HelmFinality = 'class_forbidden' | 'ungranted' | 'instance_parameter' | 'instance_context'

function helmAdapter( finality: HelmFinality, reasonCode = 'POLICY', counterfactual?: Verdict['counterfactual'] ): Verdict {
  switch( finality ){
    case 'ungranted':          return { decision: 'escalate', reasonCode }
    case 'class_forbidden':    return { decision: 'deny', reasonCode, finality: 'class' }
    case 'instance_context':   return { decision: 'deny', reasonCode, finality: 'context' }
    case 'instance_parameter': return { decision: 'deny', reasonCode, finality: 'parameter',
                                        ...( counterfactual ? { counterfactual } : {} ) }
  }
}

// ── harnesses ────────────────────────────────────────────────────────────────

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = (): MutState => ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}

/** A mind fragment: the real repertoire + the real learning engine. */
function mind(){
  const repertoire = new SchemaRepertoire()
  const engine     = new ReafferenceEngine( repertoire )
  const state      = freshState()
  let   seq        = 0

  /** Deliver a verdict as the world's answer to an attempt, and let the mind learn. */
  const receive = async ( v: Verdict, tick: number ): Promise<StateCommands | undefined> => {
    const id = `outcome-${ ++seq }`
    state.entities.set( id, {
      id, type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: {
        schema: SCHEMA, intentId: `intent-${ seq }`, success: false,
        refused: true, finality: v.finality,
      },
    } as SimulationEntity )
    const out = await engine.react( 0, tick, frozen( state ), CTX )
    apply( state, out.commands )
    return out.commands
  }

  /** Let the mind ENACT successfully, so there is real competence to protect. */
  const succeed = async ( tick: number ): Promise<void> => {
    const id = `outcome-${ ++seq }`
    state.entities.set( id, {
      id, type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: {
        schema: SCHEMA, intentId: `intent-${ seq }`, success: true,
        outcomeQuality: 0.9, predictedReward: 0.5,
      },
    } as SimulationEntity )
    apply( state, ( await engine.react( 0, tick, frozen( state ), CTX ) ).commands )
  }

  return { repertoire, engine, state, receive, succeed }
}

/** How strongly the mind would reach for the ability right now. */
function reach( repertoire: SchemaRepertoire ): number {
  const availability = repertoire.availabilityOf( SCHEMA )
  const affordance: Affordance = {
    id: 'a-1', schema: SCHEMA, source: 'external', parameters: {},
    expectedValence: 0, expectedReward: 0.8, cost: 0.1, habitStrength: 0,
    available: true, tags: [], tick: 1,
    ...( availability < 1 ? { availability } : {} ),
  }
  return scoreAffordance( affordance, {
    goalTargets: new Set<string>(), maxGoalPriority: 0,
    drives: { energy: 0, sleep: 0, stress: 0, social: 0 }, threat: 0, inhibition: 0,
  }, DEFAULT_WEIGHTS )
}

/** A stem with a real state manager, for the dispatch/hold/resolve scenarios. */
function stem( intentId: string ){
  const entities = new Map<string, SimulationEntity>()
  entities.set( intentId, {
    id: intentId, type: 'agency.intent', createdAt: 0, updatedAt: 0,
    metadata: { schema: SCHEMA, status: 'awaiting', predictedReward: 0.5, predictedValence: 0 },
  } as SimulationEntity )

  const instance = {
    config: { id: WILL_ID }, tickCount: 10,
    pendingEffectorInvocations: [] as effectorInvocation[],
    simulation: { stateManager: {
      snapshot:  () => ({ entities }),
      setEntity: ( e: { id: string } ) => entities.set( e.id, e as SimulationEntity ),
      setMetric: () => {},
    } },
    cognition: { outboxWriter: { enqueue: () => {} } },
  }
  return { instance: instance as unknown as WillInstance, raw: instance, entities }
}

const fixed = ( v: Verdict ): PolicyArbiter => ({ name: 'pack', evaluate: () => v })
const payload = ( intentId: string ) => ({ intentId, schema: SCHEMA, parameters: {}, tick: 9 })

afterEach( () => { clearVerdictRecorder( WILL_ID ); clearVerdictSource( WILL_ID ) } )

// ── the pack ─────────────────────────────────────────────────────────────────

const byId = ( id: string ): Scenario => {
  const s = SCENARIOS.find( x => x.id === id )
  if( !s ) throw new Error(`no scenario ${ id }`)
  return s
}
/** Title each test with the scenario's own words, so failures read as pack failures. */
const T = ( id: string ): string => `${ id } · ${ byId( id ).title }`

describe('Denials That Teach — conformance pack (consumer side)', () => {

  it( T('S1'), async () => {
    const m = mind()
    await m.succeed( 1 )                                    // real competence to protect
    const skillBefore = { ...m.repertoire.getSkill( SCHEMA )! }
    const reachBefore = reach( m.repertoire )

    await m.receive( helmAdapter('class_forbidden'), 2 )

    expect( reach( m.repertoire ) ).toBeLessThan( reachBefore )       // reaches for it less
    expect( m.repertoire.getSkill( SCHEMA ) ).toEqual( skillBefore )  // knows it just as well
  } )

  it( T('S2'), async () => {
    const m = mind()
    await m.succeed( 1 )
    const skillBefore = { ...m.repertoire.getSkill( SCHEMA )! }

    await m.receive(
      helmAdapter('instance_parameter', 'BOUND', { field: 'amount', requested: 500, allowed: 100 } ),
      2,
    )

    expect( m.repertoire.getSkill( SCHEMA ) ).toEqual( skillBefore )  // competence untouched
    expect( m.repertoire.availabilityOf( SCHEMA ) ).toBeGreaterThan( 0.8 )  // still readily reachable
  } )

  it( T('S3'), async () => {
    const m = mind()
    await m.succeed( 1 )
    const skillBefore = { ...m.repertoire.getSkill( SCHEMA )! }
    const reachBefore = reach( m.repertoire )

    const cmds = await m.receive( helmAdapter('instance_context', 'TAINT'), 2 )

    expect( reach( m.repertoire ) ).toBe( reachBefore )               // nothing moved
    expect( m.repertoire.getSkill( SCHEMA ) ).toEqual( skillBefore )
    expect( m.repertoire.availability().size ).toBe( 0 )              // nothing written at all
    expect( cmds?.delete ?? [] ).toContain('intent-2')                // but the action IS released
  } )

  it( T('S4'), () => {
    const { instance, raw, entities } = stem('intent-approve')
    const c = new effectorController()
    c.setArbiter( fixed( helmAdapter('ungranted', 'APPROVAL_REQUIRED') ) )

    c.bufferInvocation( instance, payload('intent-approve') )
    c.applyPolicyOutcomes( instance )
    expect( raw.pendingEffectorInvocations ).toHaveLength( 0 )        // withheld while unresolved
    expect( entities.get('intent-approve')!.metadata!['escalated'] ).toBe( true )

    c.resolveEscalation( instance, 'intent-approve', true )
    c.applyPolicyOutcomes( instance )

    expect( raw.pendingEffectorInvocations ).toHaveLength( 1 )        // reached the world once
    // The SAME action resumed — not a re-issue. Both correlation handles must
    // still be the id the action was first proposed with.
    expect( raw.pendingEffectorInvocations[0]!.id ).toBe('intent-approve')
    expect( raw.pendingEffectorInvocations[0]!.decisionRecordId ).toBe('intent-approve')
  } )

  it( T('S5'), () => {
    const { instance, raw, entities } = stem('intent-expire')
    const c = new effectorController()
    c.setArbiter( fixed( helmAdapter('ungranted') ) )

    c.bufferInvocation( instance, payload('intent-expire') )
    c.applyPolicyOutcomes( instance )

    // Nobody answers. Advance past the documented hold window.
    ;( instance as unknown as { tickCount: number } ).tickCount = 10 + 31
    c.applyPolicyOutcomes( instance )

    expect( raw.pendingEffectorInvocations ).toHaveLength( 0 )        // never reached the world
    const outcome = [ ...entities.values() ].find( e => e.type === 'agency.outcome')
    expect( outcome ).toBeDefined()                                   // resolved, not hanging
    expect( outcome!.metadata ).toMatchObject({ refused: true })      // as a refusal
    expect( entities.get('intent-expire')!.metadata!['escalated'] ).toBeUndefined()
  } )

  it( T('S6'), async () => {
    const m = mind()
    let tick = 1
    for( let i = 0; i < 8; i++ ) await m.receive( helmAdapter('class_forbidden'), tick++ )

    const suppressed = m.repertoire.availabilityOf( SCHEMA )
    expect( suppressed ).toBeLessThan( 0.1 )     // strongly suppressed …
    expect( suppressed ).toBeGreaterThan( 0 )    // … but never zeroed: re-probe stays possible

    // The policy relaxes: denials simply stop. No restart, no manual reset.
    let recovered = suppressed
    for( let i = 0; i < 40; i++ ){
      m.repertoire.decay( tick++ )
      const now = m.repertoire.availabilityOf( SCHEMA )
      expect( now ).toBeGreaterThanOrEqual( recovered )   // monotone, and gradual
      recovered = now
    }
    expect( recovered ).toBeGreaterThan( suppressed )
  } )

  it( T('S7'), () => {
    const tape: PolicyVerdictRecord[] = []
    setVerdictRecorder( WILL_ID, { recordVerdict: r => tape.push( r ) } )

    const live = stem('intent-replay')
    const lc   = new effectorController()
    lc.setArbiter( fixed( helmAdapter('class_forbidden', 'NO') ) )
    lc.bufferInvocation( live.instance, payload('intent-replay') )
    lc.applyPolicyOutcomes( live.instance )
    const liveDispatched = live.raw.pendingEffectorInvocations.length
    expect( tape ).toHaveLength( 1 )

    // Replay the SAME tape. The arbiter is a SPY, and we assert on the call
    // count rather than only on the outcome — a throwing arbiter would be
    // caught by the fail-closed path and produce a denial too, which is the
    // same observable result as a correct replay. Counting the calls is the
    // only assertion that actually distinguishes "re-fed" from "re-consulted".
    clearVerdictRecorder( WILL_ID )
    setVerdictSource( WILL_ID, new RecordedVerdictSource( tape ) )
    let consulted = 0
    const replay = stem('intent-replay')
    const rc     = new effectorController()
    rc.setArbiter({
      name: 'must-not-run',
      evaluate: () => { consulted++; return helmAdapter('instance_context') },
    } )
    rc.bufferInvocation( replay.instance, payload('intent-replay') )
    rc.applyPolicyOutcomes( replay.instance )

    expect( consulted ).toBe( 0 )                                                  // never consulted
    expect( replay.raw.pendingEffectorInvocations.length ).toBe( liveDispatched )   // same decision
    // …and the decision that was re-fed is the RECORDED one, not a fresh default.
    const replayed = [ ...replay.entities.values() ].find( e => e.type === 'agency.outcome')
    expect( replayed!.metadata ).toMatchObject({ refused: true, finality: 'class' })
  } )

  it( T('S8'), async () => {
    const m = mind()
    await m.succeed( 1 )
    const out = await m.engine.react( 0, 2, frozen( m.state ), CTX )

    expect( m.repertoire.availability().size ).toBe( 0 )                       // no policy state
    const metricNames = ( out.commands?.metrics ?? [] ).map( x => x[0] )
    expect( metricNames ).not.toContain('agency.refused.count')                // no policy telemetry
    expect( metricNames ).not.toContain('agency.policy.revoked')

    // And with no arbiter installed the seam does not intercept at all.
    const { instance, raw } = stem('intent-quiet')
    new effectorController().bufferInvocation( instance, payload('intent-quiet') )
    expect( raw.pendingEffectorInvocations ).toHaveLength( 1 )
  } )

  it( T('S9'), async () => {
    const tape: PolicyVerdictRecord[] = []
    setVerdictRecorder( WILL_ID, { recordVerdict: r => tape.push( r ) } )

    const { instance, raw, entities } = stem('intent-fault')
    const c = new effectorController()
    c.setArbiter({ name: 'unreachable', evaluate: () => { throw new Error('PDP unreachable') } } )

    c.bufferInvocation( instance, payload('intent-fault') )
    c.applyPolicyOutcomes( instance )

    expect( raw.pendingEffectorInvocations ).toHaveLength( 0 )        // withheld — fail closed
    expect( tape ).toHaveLength( 1 )                                  // and RECORDED, so replay agrees
    expect( tape[0] ).toMatchObject({ decision: 'deny' })

    // The outage must not read as incompetence: feed the resulting ack to a mind
    // that is good at this, and confirm its competence survives untouched.
    const outcome = [ ...entities.values() ].find( e => e.type === 'agency.outcome')!
    const m = mind()
    await m.succeed( 1 )
    const skillBefore = { ...m.repertoire.getSkill( SCHEMA )! }

    m.state.entities.set('fault-ack', {
      id: 'fault-ack', type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: { ...outcome.metadata, schema: SCHEMA, intentId: 'intent-fault' },
    } as SimulationEntity )
    apply( m.state, ( await m.engine.react( 0, 2, frozen( m.state ), CTX ) ).commands )

    expect( m.repertoire.getSkill( SCHEMA ) ).toEqual( skillBefore )  // competence untouched
    expect( m.repertoire.availability().size ).toBe( 0 )              // and nothing else moved
  } )
} )

// ── the pack is self-describing: every scenario must have a test ─────────────

describe('pack integrity', () => {
  it('runs every scenario declared in the manifest', () => {
    const declared = SCENARIOS.map( s => s.id )
    expect( declared ).toEqual([ 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9' ])
    expect( new Set( declared ).size ).toBe( declared.length )
  } )

  it('states honestly where the reference consumer stands', () => {
    const { total, asserted, partial, pending } = packSummary()
    expect( asserted + partial + pending ).toBe( total )
    // Anything not fully asserted MUST say what is missing — a pack that quietly
    // under-tests is worse than one that reports a gap.
    for( const s of SCENARIOS )
      if( s.status !== 'asserted') expect( s.note, `${ s.id } lacks a note` ).toBeTruthy()
  } )
} )

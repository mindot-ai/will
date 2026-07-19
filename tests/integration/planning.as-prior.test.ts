// ─────────────────────────────────────────────────────────────
// tests/integration/planning.as-prior.test.ts
// ─────────────────────────────────────────────────────────────
// The planning↔agency seam, end-to-end on the real engines (no LLM, no mocks of
// the pipeline). Proves the re-grounded model from PLANNING_AS_PRIOR_TODO.md:
//
//   PlanningEngine projects its ready frontier as a `plan.prior`
//     → AffordanceSynthesizer surfaces it as a COMPETING affordance (source 'plan')
//     → ActionSelector wins it on its merits (+ planBias), commits an intent
//        carrying planId/stepId provenance
//     → MotorSchemaExecutor enacts it and emits action.outcome{planId,stepId}
//     → PlanningEngine advances the frontier and completes the plan.
//
// No `plan.step.dispatched`, no directed intent, no executor plan-coupling — the
// plan BIASES the one competition and the body enacts what it affords. This is the
// seam that was previously only ever tested with each side stubbed.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { PlanningEngine }        from '#cognition/faculties/planning.engine/engine'
import { SchemaRepertoire }      from '#agency/schemas/repertoire'
import { INNATE_SCHEMAS }        from '#agency/schemas/innate'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { ActionSelector }        from '#agency/engines/action.selector'
import { DeliberationEngine }    from '#agency/engines/deliberation.engine'
import { MotorSchemaExecutor }   from '#agency/engines/motor.schema.executor'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}
const ofType = ( s: MutState, t: string ) => [ ...s.entities.values() ].filter( e => e.type === t )

/** Executive stub: a single automatic-tier plan with one sync-stance step. */
function executiveStub( steps: Array<{ action: string; description: string; expectedOutcome: string; prerequisites?: string[]; estimatedDuration: number }> ){
  return {
    isFresh: () => true,
    latestOutput: { plans: [ {
      action: 'execute', goalId: 'goal-1', executionTier: 'automatic',
      expectedOutcome: 'goal reached', estimatedCost: 5, feasibility: 0.8, steps,
    } ] },
  } as any
}
// priority 0.6 < deliberateGoalPriority (0.7) ⇒ plan stays AUTOMATIC (no facet spawned,
// so no executive facet machinery needed); still a healthy planBias strength.
const goalStub = { getGoal: () => ( { id: 'goal-1', priority: 0.6 } ), getActiveGoals: () => [] } as any

describe('planning as a top-down prior — end-to-end on the real agency pipeline', () => {
  it('a plan biases the competition, the field enacts the step, and the plan advances', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const bus = { publish: ( e: any ) => { events.push( e ); }, subscribe: () => {}, unsubscribe: () => {} } as any

    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire ); synth.attachBus( bus )
    const selector = new ActionSelector();     selector.attachBus( bus )
    const delib = new DeliberationEngine();     delib.attachBus( bus )   // no executive ⇒ confirms the substrate winner
    const exec = new MotorSchemaExecutor();     exec.attachRepertoire( repertoire ); exec.attachBus( bus )

    const planning = new PlanningEngine( { bus } )
    planning.attachGoalManager( goalStub )
    // 'reflect' is an innate, objectless, SYNC stance — always afforded, enacts in one
    // tick. The plan's frontier step suggests it; the prior biases the field toward it.
    planning.attachExecutiveEngine( executiveStub( [
      { action: 'reflect', description: 'think it through', expectedOutcome: 'insight', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    // Healthy body state — what the regulators publish in a live mind; without it the
    // schema preconditions (e.g. reflect's energy gate) read 0 and nothing is afforded.
    const s: MutState = { tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( {
      'energy.level': 100, 'stress.load': 0, 'sleep.pressure': 0, 'affect.valence': 0, 'attention.capacity': 8,
    } ) ) }

    const planOutcomes: Array<{ type: string; payload: Record<string, unknown> }> = []

    // Pipeline order mirrors mind.ts: planning (core) → synthesize → select →
    // deliberate → enact. The executor's action.outcome is routed back to planning
    // (the bus does this live in an assembled mind).
    for( let tick = 1; tick <= 6; tick++ ){
      s.tick = tick
      apply( s, ( await planning.react( 0 as any, tick as any, frozen( s ), CTX ) ).commands )
      apply( s, ( await synth.react(    0 as any, tick as any, frozen( s ), CTX ) ).commands )
      apply( s, ( await selector.react( 0 as any, tick as any, frozen( s ), CTX ) ).commands )
      apply( s, ( await delib.react(    0 as any, tick as any, frozen( s ), CTX ) ).commands )
      apply( s, ( await exec.react(     0 as any, tick as any, frozen( s ), CTX ) ).commands )

      // Route enaction outcomes back to the planner (what the cognitive bus does live).
      for( const e of events.splice( 0 ) ){
        if( e.type === 'action.outcome'){
          if( ( e.payload as any )?.planId === 'plan-1') planOutcomes.push( e )
          planning.onCognitiveEvent( e as any )
        }
      }
    }

    const plan = planning.getPlan('goal-1')!

    // The plan never dispatched — it biased the field, which enacted the step.
    expect( plan.status ).toBe('completed')
    expect( plan.steps[ 0 ]?.status ).toBe('completed')

    // The proof of the seam: the executor emitted an action.outcome carrying the
    // plan provenance — which can ONLY be there if it flowed plan.prior → affordance
    // → committed intent → enaction. No dispatch channel produced it.
    expect( planOutcomes.length ).toBeGreaterThan( 0 )
    expect( ( planOutcomes[0]?.payload as any )?.stepId ).toBe('step-0')
    expect( ( planOutcomes[0]?.payload as any )?.actionType ).toBe('reflect')
  } )

  it('projects the frontier as a competing plan.prior — never a directed intent', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const bus = { publish: ( e: any ) => { events.push( e ); }, subscribe: () => {}, unsubscribe: () => {} } as any

    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire ); synth.attachBus( bus )

    const planning = new PlanningEngine( { bus } )
    planning.attachGoalManager( goalStub )
    planning.attachExecutiveEngine( executiveStub( [
      { action: 'reflect', description: 'think', expectedOutcome: 'insight', prerequisites: [], estimatedDuration: 3 },
    ] ) )

    const s: MutState = { tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( {
      'energy.level': 100, 'stress.load': 0, 'sleep.pressure': 0, 'affect.valence': 0, 'attention.capacity': 8,
    } ) ) }

    // Tick 1: planning activates the frontier and projects the prior.
    s.tick = 1
    apply( s, ( await planning.react( 0 as any, 1 as any, frozen( s ), CTX ) ).commands )

    const priors = ofType( s, 'plan.prior')
    expect( priors.length ).toBe( 1 )
    expect( priors[0]?.metadata?.[ 'schema' ] ).toBe('reflect')
    expect( priors[0]?.metadata?.[ 'planId' ] ).toBe('plan-1')
    expect( priors[0]?.metadata?.[ 'stepId' ] ).toBe('step-0')
    expect( priors[0]?.metadata?.[ 'planBias' ] as number ).toBeGreaterThan( 0 )

    // No directed plan intent was ever created (the old dispatch path is gone).
    expect( ofType( s, 'agency.intent').length ).toBe( 0 )

    // Tick 1 synthesizer: the prior surfaces as a COMPETING affordance, source 'plan'.
    apply( s, ( await synth.react( 0 as any, 1 as any, frozen( s ), CTX ) ).commands )
    const planAffordance = ofType( s, 'affordance').find( a => a.metadata?.[ 'source' ] === 'plan')
    expect( planAffordance ).toBeDefined()
    expect( planAffordance?.metadata?.[ 'planId' ] ).toBe('plan-1')
    expect( planAffordance?.metadata?.[ 'available' ] ).toBe( true )
  } )
} )

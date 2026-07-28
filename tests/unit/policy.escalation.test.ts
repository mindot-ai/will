// ─────────────────────────────────────────────────────────────
// tests/unit/policy.escalation.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P4 — ESCALATE is a speech act. An escalated intent is HELD
// (the executor stops timing it out), the Will voices a first-person ask ONCE,
// and a host resolution approves (dispatch) or denies (refuse) it; unanswered,
// it degrades to a refusal at the extended TTL.

import { describe, it, expect } from 'vitest'
import { effectorController } from '#stem/tracts/effector.controller'
import { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'
import type { PolicyArbiter, Verdict } from '#stem/policy/arbiter'
import type { WillInstance } from '#stem/index'
import type {
  effectorInvocation,
} from '#types'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'

const CTX = {} as unknown as SimulationContext
const WILL_ID = 'will-1'

// ── controller harness ────────────────────────────────────────────────────────

function stub( awaitingIntentId: string, tick = 8 ){
  const entities = new Map<string, SimulationEntity>()
  entities.set( awaitingIntentId, {
    id: awaitingIntentId, type: 'agency.intent', createdAt: 0, updatedAt: 0,
    metadata: { schema: 'trade', status: 'awaiting', predictedReward: 0.5, predictedValence: 0 },
  } as SimulationEntity )

  const stateManager = {
    snapshot:  () => ({ entities }),
    setEntity: ( e: { id: string } ) => entities.set( e.id, e as SimulationEntity ),
    setMetric: () => {},
  }
  const voiced: Array<{ content: string; effectorName: string; targetEntityId: string }> = []
  const instance = {
    config: { id: WILL_ID }, tickCount: tick, pendingEffectorInvocations: [] as effectorInvocation[],
    simulation: { stateManager },
    cognition:  { outboxWriter: { enqueue: ( row: { content: string; effectorName: string; targetEntityId: string } ) => { voiced.push( row ); return 'm-1' } } },
  }
  return { instance, entities, voiced }
}
const asInstance = ( s: unknown ): WillInstance => s as WillInstance
const payload = ( over: Record<string, unknown> = {} ) => ({ intentId: 'i-1', schema: 'trade', parameters: {}, tick: 8, ...over })
const escalateArbiter: PolicyArbiter = { name: 'esc', evaluate: (): Verdict => ({ decision: 'escalate', reasonCode: 'APPROVAL_REQUIRED' }) }

describe('P4 — escalate holds and voices once', () => {
  it('marks the intent held, voices exactly one ask, and does not dispatch', () => {
    const { instance, entities, voiced } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( entities.get('i-1')!.metadata!['escalated'] ).toBe( true )
    expect( entities.get('i-1')!.metadata!['escalationExpiresAt'] ).toBe( 8 + 30 )
    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )   // withheld
    expect( voiced ).toHaveLength( 1 )
    expect( voiced[0]!.effectorName ).toBe('broadcast')
    expect( voiced[0]!.content ).toContain('trade')

    // Not once per tick: a second boundary pass re-voices nothing.
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( voiced ).toHaveLength( 1 )
  })
})

describe('P4 — resolution', () => {
  it('approval dispatches the SAME intent id and releases the hold', () => {
    const { instance, entities } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    c.resolveEscalation( asInstance( instance ), 'i-1', true )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( instance.pendingEffectorInvocations ).toHaveLength( 1 )
    expect( instance.pendingEffectorInvocations[0]!.id ).toBe('i-1')      // same intent resumes
    expect( entities.get('i-1')!.metadata!['escalated'] ).toBeUndefined() // hold released
  })

  it('denial refuses the held intent (refused outcome, class)', () => {
    const { instance, entities } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    c.resolveEscalation( asInstance( instance ), 'i-1', false )
    c.applyPolicyOutcomes( asInstance( instance ) )

    const outcome = entities.get('agency-outcome-8-i-1')
    expect( outcome ).toBeDefined()
    expect( outcome!.metadata ).toMatchObject({ refused: true, finality: 'class', success: false })
    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('resolving an unknown intent is a harmless no-op', () => {
    const { instance } = stub('i-1')
    const c = new effectorController()
    expect( () => {
      c.resolveEscalation( asInstance( instance ), 'nope', true )
      c.applyPolicyOutcomes( asInstance( instance ) )
    } ).not.toThrow()
    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )
  })
})

describe('P4 — expiry degrades to a refusal', () => {
  it('an unanswered escalation refuses at the extended TTL', () => {
    const { instance, entities } = stub('i-1', 8 )
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )      // raised at tick 8, expires at 38

    instance.tickCount = 37
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( entities.has('agency-outcome-37-i-1') ).toBe( false )   // still held

    instance.tickCount = 38
    c.applyPolicyOutcomes( asInstance( instance ) )
    const outcome = entities.get('agency-outcome-38-i-1')
    expect( outcome ).toBeDefined()
    expect( outcome!.metadata ).toMatchObject({ refused: true, finality: 'parameter' })
  })
})

// ── executor hold ─────────────────────────────────────────────────────────────

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = (): MutState => ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState
function applyCmds( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
}

describe('P4 — the executor holds an escalated intent past the await timeout', () => {
  it('does not time out an escalated awaiting intent, but does time out a plain one', async () => {
    const s = freshState()
    s.entities.set('held', { id: 'held', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'trade', status: 'awaiting', dispatchedAt: 1, escalated: true, escalationExpiresAt: 40, predictedReward: 0.5 } } as SimulationEntity )
    s.entities.set('plain', { id: 'plain', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'open_airlock', status: 'awaiting', dispatchedAt: 1, predictedReward: 0.5 } } as SimulationEntity )

    // Tick 20 — well past AWAIT_TIMEOUT (15) for both.
    applyCmds( s, ( await new MotorSchemaExecutor().react( 0, 20, frozen( s ), CTX ) ).commands )

    expect( s.entities.has('held') ).toBe( true )      // escalated → held, not reconciled
    expect( s.entities.has('plain') ).toBe( false )    // plain → timed out and freed
  })
})

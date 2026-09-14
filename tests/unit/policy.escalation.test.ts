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
import { readSpokenTurns, SENT_TYPE } from '#agency/conversation.aim'
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

  // The simulation clock, deliberately NOT the lifecycle's tick.
  //
  // `applyPolicyOutcomes` passes `instance.tickCount` — process-local, starts at
  // 0 each boot — while `conversation.sent` is read in sim-clock space. Setting
  // them to the same number here would let a record stamped from either one pass,
  // which is exactly how the defect shipped.
  const clock = { currentTick: 9_000 }
  const stateManager = {
    snapshot:  () => ({ entities }),
    setEntity: ( e: { id: string } ) => entities.set( e.id, e as SimulationEntity ),
    setMetric: () => {},
  }
  const voiced: Array<{ content: string; effectorName: string; targetEntityId: string }> = []
  const instance = {
    config: { id: WILL_ID }, tickCount: tick, pendingEffectorInvocations: [] as effectorInvocation[],
    simulation: { stateManager, clock },
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

// ── the ask is a thing she said ───────────────────────────────────────────────

/**
 * An escalation is a speech act, and speech the mind cannot remember making is
 * worse than silence.
 *
 * The ask goes out through the outbox directly — no intent, no `_deliver` — so
 * nothing wrote the `conversation.sent` that `## What I've Said Lately` is built
 * from. The one utterance missing from her record was the one she was being
 * asked about.
 *
 * Live, at 15:31:02 she broadcast "I want to discord_unban_member, but I need
 * your approval before I can do this. May I go ahead?" Asked who she meant, she
 * answered "I didn't send that. I've never asked to unban anyone" — and again,
 * and again, seven messages across four minutes. She was right every time. Her
 * prompt listed her replies to him and did not contain the ask.
 *
 * Both halves are pinned here, because writing an entity nothing reads is the
 * same bug wearing the other face: the record must be the one `readSpokenTurns`
 * actually returns.
 */
describe('P4 — she remembers asking', () => {
  it('records the ask as something she said, in the words she said it in', () => {
    const { instance, entities, voiced } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    const sent = [ ...entities.values() ].filter( e => e.type === SENT_TYPE )
    expect( sent, 'the ask left the mind and nothing recorded it').toHaveLength( 1 )
    // The SAME words, not a paraphrase of them — she is asked about what she said.
    expect( String( sent[0]!.metadata!['preview'] ) ).toBe( voiced[0]!.content.slice( 0, 100 ) )
  })

  it('and the record is the one the prompt is built from', () => {
    const { instance, entities } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    const turns = readSpokenTurns( entities )
    expect( turns, 'written, but not where the prompt looks').toHaveLength( 1 )
    expect( turns[0]!.preview ).toContain('trade')
    // The world's clock (9000), not the lifecycle's counter (8). Stamped with the
    // latter the ask sorts to the oldest turn she has and falls off the end of
    // `## What I've Said Lately` — present in state, absent from the prompt.
    expect( turns[0]!.tick, 'stamped from the wrong clock').toBe( 9_000 )
    // Not an ack: `## What I've Said Lately` filters those out, and an approval
    // ask filtered out of her own record is the whole defect again.
    expect( turns[0]!.isAck ).toBe( false )
  })

  it('two escalations on one tick are two things she said', () => {
    // A shared id would leave her remembering one of them — the same overwrite
    // that once left the mind with exactly one memory per person, forever.
    const { instance, entities } = stub('i-1')
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload({ schema: 'trade' }) )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'i-2', schema: 'deploy' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( readSpokenTurns( entities ) ).toHaveLength( 2 )
  })

  it('records nothing when the words never left', () => {
    const { instance, entities } = stub('i-1')
    ;( instance.cognition as { outboxWriter: { enqueue: () => string } } ).outboxWriter.enqueue =
      () => { throw new Error('outbox down') }
    const c = new effectorController(); c.setArbiter( escalateArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( readSpokenTurns( entities ),
      'a memory of speech that never happened is the same fault mirrored').toHaveLength( 0 )
  })
})

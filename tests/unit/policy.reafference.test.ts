// ─────────────────────────────────────────────────────────────
// tests/unit/policy.reafference.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P1 — the graded refusal ack + the verdict tape.
// Proves a denial is queued during the flush and reconciled as a
// host-rejection-shaped failure at the next tick boundary (via
// confirmExecution), that escalate withholds without refusing, that every
// verdict is captured on the willId-keyed tape, and that a registered source
// re-feeds recorded verdicts WITHOUT re-consulting the arbiter (replay).

import { describe, it, expect, afterEach } from 'vitest'
import { effectorController } from '#stem/tracts/effector.controller'
import type { PolicyArbiter, Verdict } from '#stem/policy/arbiter'
import {
  setVerdictRecorder, clearVerdictRecorder,
  setVerdictSource, clearVerdictSource,
  RecordedVerdictSource,
  type PolicyVerdictRecord, type PolicyVerdictSink,
} from '#stem/policy/verdict.recorder'
import type { WillInstance } from '#stem/index'
import type { effectorInvocation } from '#types'
import type { SimulationEntity } from '#core/types'

const WILL_ID = 'will-1'

// ── harnesses ────────────────────────────────────────────────────────────────

/** Light stub — enough for buffering / recording / enqueue (no simulation). */
interface LightStub { config: { id: string }; pendingEffectorInvocations: effectorInvocation[] }
function lightStub(): LightStub {
  return { config: { id: WILL_ID }, pendingEffectorInvocations: [] }
}

/** Full-ish stub with a fake state manager, so confirmExecution can reconcile. */
function stateStub( awaitingIntentId: string ){
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
  const instance = {
    config: { id: WILL_ID }, tickCount: 8, pendingEffectorInvocations: [] as effectorInvocation[],
    simulation: { stateManager },
  }
  return { instance, entities }
}

const asInstance = ( s: unknown ): WillInstance => s as WillInstance

function payload( over: Record<string, unknown> = {} ): Record<string, unknown> {
  return { intentId: 'agency-intent-1', schema: 'trade', parameters: {}, tick: 7, ...over }
}

function fixed( verdict: Verdict, async = false ): PolicyArbiter {
  return { name: 'fixed', evaluate: () => ( async ? Promise.resolve( verdict ) : verdict ) }
}

const flush = (): Promise<void> => new Promise( r => setTimeout( r, 0 ) )

afterEach( () => {
  clearVerdictRecorder( WILL_ID )
  clearVerdictSource( WILL_ID )
} )

// ── the refusal ack ───────────────────────────────────────────────────────────

describe('P1 — graded refusal ack', () => {
  it('queues a denial, then reconciles it as a failure outcome at the boundary', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'NO_TRADE', finality: 'class' }) )

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    // Withheld from the host, not yet reconciled — it waits for the boundary.
    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )
    expect( entities.has('agency-outcome-8-agency-intent-1') ).toBe( false )

    c.applyPolicyOutcomes( asInstance( instance ) )

    const outcome = entities.get('agency-outcome-8-agency-intent-1')
    expect( outcome ).toBeDefined()
    expect( outcome!.type ).toBe('agency.outcome')
    expect( outcome!.metadata ).toMatchObject({ schema: 'trade', success: false, intentId: 'agency-intent-1' })
    expect( String( outcome!.metadata!['description'] ) ).toContain('refused by policy: NO_TRADE (class)')
  })

  it('drains the refusal queue exactly once', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'X' }) )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )

    c.applyPolicyOutcomes( asInstance( instance ) )
    entities.delete('agency-outcome-8-agency-intent-1')     // prove a second drain writes nothing
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( entities.has('agency-outcome-8-agency-intent-1') ).toBe( false )
  })

  it('escalate withholds WITHOUT queuing a refusal (P4 owns the hold)', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'escalate' }) )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )

    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )   // not handed to host
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( entities.size ).toBe( 1 )                                 // no outcome written; intent still awaiting
  })

  it('allow reaches the host and queues no refusal', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'allow' }) )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )

    expect( instance.pendingEffectorInvocations ).toHaveLength( 1 )
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( entities.size ).toBe( 1 )
  })

  it('reconciles an async denial once its verdict resolves', async () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'ASYNC_NO' }, true ) )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )

    c.applyPolicyOutcomes( asInstance( instance ) )                   // nothing queued yet
    expect( entities.has('agency-outcome-8-agency-intent-1') ).toBe( false )
    await flush()
    c.applyPolicyOutcomes( asInstance( instance ) )                   // now the queue has it
    expect( entities.has('agency-outcome-8-agency-intent-1') ).toBe( true )
  })
})

// ── the verdict tape ──────────────────────────────────────────────────────────

function collectingSink(): { sink: PolicyVerdictSink; records: PolicyVerdictRecord[] } {
  const records: PolicyVerdictRecord[] = []
  return { sink: { recordVerdict: ( r ) => records.push( r ) }, records }
}

describe('P1 — verdict tape (capture)', () => {
  it('records a denial verdict with its finality and counterfactual', () => {
    const { sink, records } = collectingSink()
    setVerdictRecorder( WILL_ID, sink )
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'CAP', finality: 'parameter',
      counterfactual: { field: 'amount', requested: 500, allowed: 100 } }) )
    c.bufferInvocation( asInstance( lightStub() ), payload() )

    expect( records ).toHaveLength( 1 )
    expect( records[0] ).toMatchObject({
      tick: 7, willId: WILL_ID, intentId: 'agency-intent-1', schema: 'trade', arbiter: 'fixed',
      decision: 'deny', reasonCode: 'CAP', finality: 'parameter',
      counterfactual: { field: 'amount', requested: 500, allowed: 100 },
    })
  })

  it('records allow verdicts too, so replay can reproduce every decision', () => {
    const { sink, records } = collectingSink()
    setVerdictRecorder( WILL_ID, sink )
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'allow' }) )
    c.bufferInvocation( asInstance( lightStub() ), payload() )
    expect( records ).toHaveLength( 1 )
    expect( records[0]!.decision ).toBe('allow')
  })

  it('records nothing when no arbiter is configured (byte-identical default)', () => {
    const { sink, records } = collectingSink()
    setVerdictRecorder( WILL_ID, sink )
    const c = new effectorController()   // null arbiter
    c.bufferInvocation( asInstance( lightStub() ), payload() )
    expect( records ).toHaveLength( 0 )
  })
})

// ── the verdict source (replay re-feed) ───────────────────────────────────────

/** An arbiter that must never be called during replay. */
const forbiddenArbiter: PolicyArbiter = {
  name: 'forbidden',
  evaluate: () => { throw new Error('arbiter consulted during replay') },
}

function record( over: Partial<PolicyVerdictRecord> = {} ): PolicyVerdictRecord {
  return {
    tick: 7, willId: WILL_ID, intentId: 'agency-intent-1', schema: 'trade',
    arbiter: 'fixed', decision: 'allow', timestamp: 0, ...over,
  }
}

describe('P1 — verdict source (replay)', () => {
  it('re-feeds a recorded ALLOW without consulting the arbiter', () => {
    setVerdictSource( WILL_ID, new RecordedVerdictSource([ record({ decision: 'allow' }) ]) )
    const s = lightStub()
    const c = new effectorController()
    c.setArbiter( forbiddenArbiter )
    expect( () => c.bufferInvocation( asInstance( s ), payload() ) ).not.toThrow()
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('re-feeds a recorded DENY, queuing the refusal, arbiter untouched', () => {
    setVerdictSource( WILL_ID, new RecordedVerdictSource([ record({ decision: 'deny', reasonCode: 'R' }) ]) )
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( forbiddenArbiter )
    c.bufferInvocation( asInstance( instance ), payload() )
    c.applyPolicyOutcomes( asInstance( instance ) )
    expect( entities.has('agency-outcome-8-agency-intent-1') ).toBe( true )
  })

  it('buffers on a source MISS (the live run had no verdict here)', () => {
    setVerdictSource( WILL_ID, new RecordedVerdictSource([]) )   // empty tape
    const s = lightStub()
    const c = new effectorController()
    c.setArbiter( forbiddenArbiter )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('does not record while replaying from a source', () => {
    const { sink, records } = collectingSink()
    setVerdictRecorder( WILL_ID, sink )
    setVerdictSource( WILL_ID, new RecordedVerdictSource([ record({ decision: 'allow' }) ]) )
    const c = new effectorController()
    c.bufferInvocation( asInstance( lightStub() ), payload() )
    expect( records ).toHaveLength( 0 )   // the source path is upstream of the sink
  })
})

// ── the arbiter-fault path (P5 · conformance S9) ──────────────────────────────

describe('P5 — an arbiter FAULT fails closed without teaching incompetence', () => {
  const throwing: PolicyArbiter = {
    name: 'throwing',
    evaluate: () => { throw new Error('PDP unreachable') },
  }
  const rejecting: PolicyArbiter = {
    name: 'rejecting',
    evaluate: () => Promise.reject( new Error('PDP unreachable') ),
  }

  it('still withholds the effect — fail-closed is unchanged', () => {
    const s = lightStub()
    const c = new effectorController()
    c.setArbiter( throwing )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('reconciles as a REFUSAL, not the silent timeout that landed on competence', () => {
    // Before P5 the fault queued nothing, so the held intent expired at
    // AWAIT_TIMEOUT and reconciled as a plain failure — teaching the mind it was
    // unskilled at something a PDP outage merely prevented.
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( throwing )

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    const outcome = entities.get('agency-outcome-8-agency-intent-1')
    expect( outcome ).toBeDefined()
    expect( outcome!.metadata ).toMatchObject({ refused: true, finality: 'context' })
    expect( String( outcome!.metadata!['description'] ) ).toContain('ARBITER_UNAVAILABLE')
  })

  it('marks it "context" so nothing about the ability moves — the outage is not a fact about the act', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( throwing )
    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    // 'context' is what the ReafferenceEngine routes to the no-op branch
    // (proved in policy.taxonomy.test.ts) — assert the tag, which is the contract.
    expect( entities.get('agency-outcome-8-agency-intent-1')!.metadata!['finality'] ).toBe('context')
  })

  it('records the fault on the tape, so replay reproduces the withholding', () => {
    // Without this the source has nothing to re-feed, and a source MISS
    // reproduces a buffered ALLOW: the live run withheld, the replay dispatched.
    const { sink, records } = collectingSink()
    setVerdictRecorder( WILL_ID, sink )
    const c = new effectorController()
    c.setArbiter( throwing )
    c.bufferInvocation( asInstance( lightStub() ), payload() )

    expect( records ).toHaveLength( 1 )
    expect( records[0] ).toMatchObject({
      decision: 'deny', reasonCode: 'ARBITER_UNAVAILABLE', finality: 'context', arbiter: 'throwing',
    })
  })

  it('handles an async REJECTION the same way as a sync throw', async () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( rejecting )

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    await flush()
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( instance.pendingEffectorInvocations ).toHaveLength( 0 )
    expect( entities.get('agency-outcome-8-agency-intent-1')!.metadata )
      .toMatchObject({ refused: true, finality: 'context' })
  })
})

// ── the counterfactual reaches the outcome (ENVELOPE_NARROWING P0) ────────────

describe('ENVELOPE_NARROWING P0 — the counterfactual survives the ack', () => {
  const bounded: Verdict = {
    decision: 'deny', reasonCode: 'BOUND', finality: 'parameter',
    counterfactual: { field: 'amount', requested: 500, allowed: 100 },
  }

  it('stamps it onto the refused outcome, so tape and outcome agree', () => {
    // It reached the verdict tape and the log line before; the outcome — the
    // thing the mind actually learns from — dropped it.
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed( bounded ) )

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( entities.get('agency-outcome-8-agency-intent-1')!.metadata )
      .toMatchObject({ refused: true, finality: 'parameter',
                       counterfactual: { field: 'amount', requested: 500, allowed: 100 } })
  })

  it('writes NO counterfactual key when the arbiter reported no bound', () => {
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'NO_TRADE', finality: 'class' }) )

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    const meta = entities.get('agency-outcome-8-agency-intent-1')!.metadata!
    expect( meta ).toMatchObject({ refused: true })
    expect('counterfactual' in meta ).toBe( false )   // quiet path unchanged
  })

  it('survives the replay path too — a re-fed verdict carries it', () => {
    setVerdictSource( WILL_ID, new RecordedVerdictSource([ record({
      decision: 'deny', reasonCode: 'BOUND', finality: 'parameter',
      counterfactual: { field: 'amount', requested: 500, allowed: 100 },
    }) ]) )
    const { instance, entities } = stateStub('agency-intent-1')
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'allow' }) )   // must not be consulted

    c.bufferInvocation( asInstance( instance ), payload({ intentId: 'agency-intent-1' }) )
    c.applyPolicyOutcomes( asInstance( instance ) )

    expect( entities.get('agency-outcome-8-agency-intent-1')!.metadata!['counterfactual'] )
      .toMatchObject({ field: 'amount', allowed: 100 })
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/policy.rupture.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P3 — refusal as rupture. A CLASS-final policy refusal of a
// schema the Will is still deliberating makes it LET GO of that commitment,
// reusing the EXAFFERENCE P4 tombstone. The load-bearing invariant: a refusal is
// an agency.outcome, never a percept, so it contributes ZERO exafferent rupture —
// the mind can never rupture itself with its own boundary. An instance refusal,
// or a refusal of a different schema, never revokes.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'
import { ActionSelector } from '#agency/engines/action.selector'
import { REVOCATION_TYPE, revocationId } from '#agency/revocation'

const CTX = {} as unknown as SimulationContext

interface Ent { id: string; type: string; metadata?: Record<string, unknown> }

function makeState( tick: number, entities: Ent[], metrics: Record<string, number> = {} ): ReadonlySimulationState {
  const em = new Map<string, unknown>()
  for( const e of entities ) em.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick, time: 0, entities: em, metrics: new Map( Object.entries( metrics ) ) } as unknown as ReadonlySimulationState
}

const deliberating = ( id: string, schema: string ): Ent =>
  ({ id, type: 'agency.intent', metadata: { status: 'deliberating', schema, candidates: [ { schema } ] } })

/** A refused agency.outcome as applyPolicyOutcomes → reconcileInvocation writes it. */
const refused = ( id: string, schema: string, finality: 'class' | 'instance' ): Ent =>
  ({ id, type: 'agency.outcome', metadata: { schema, intentId: `i-${ schema }`, success: false, refused: true, finality } })

/** A strong exafferent percept — the world-surprise path, for contrast. */
const exafferent = ( id: string, salience: number, tick: number ): Ent =>
  ({ id, type: 'percept', metadata: { salience, provenance: 'exafferent', tick, entityId: 'w', category: 'message' } })

function busSpy(): { bus: unknown; events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return { bus: { publish: ( e: { type: string; payload: Record<string, unknown> } ) => events.push( e ) }, events }
}

const setOf     = ( r: { commands?: { set?: Array<{ id: string; type: string }> } } ) => r.commands?.set ?? []
const metricVal = ( r: { commands?: { metrics?: Array<[ string, number ]> } }, k: string ) =>
  ( r.commands?.metrics ?? [] ).find( m => m[0] === k )?.[1]

async function run( state: ReadonlySimulationState ) {
  const sel = new ActionSelector()
  const spy = busSpy(); sel.attachBus( spy.bus as never )
  const res = await sel.react( 0, ( state as { tick: number } ).tick, state, CTX )
  return { res, events: spy.events }
}

describe('P3 — a class refusal revokes an in-flight deliberation of the same schema', () => {
  it('writes a tombstone for the deliberating intent + emits agency.policy.revoked', async () => {
    const s = makeState( 5, [ deliberating('intent-d', 'trade'), refused('o', 'trade', 'class') ] )
    const { res, events } = await run( s )

    const tomb = setOf( res ).find( e => e.type === REVOCATION_TYPE )
    expect( tomb ).toBeDefined()
    expect( tomb!.id ).toBe( revocationId('intent-d') )
    expect( metricVal( res, 'agency.commitment.revoked') ).toBe( 1 )
    expect( metricVal( res, 'agency.policy.revoked') ).toBe( 1 )

    const ev = events.find( e => e.type === 'agency.commitment.revoked')
    expect( ev!.payload['reason'] ).toBe('policy-refusal')   // NOT exafferent-rupture
  })

  it('an INSTANCE refusal does not revoke (not with those params ≠ never)', async () => {
    const s = makeState( 5, [ deliberating('intent-d', 'trade'), refused('o', 'trade', 'instance') ] )
    const { res, events } = await run( s )
    expect( setOf( res ).some( e => e.type === REVOCATION_TYPE ) ).toBe( false )
    expect( metricVal( res, 'agency.policy.revoked') ).toBeUndefined()
    expect( events.some( e => e.type === 'agency.commitment.revoked') ).toBe( false )
  })

  it('a class refusal of a DIFFERENT schema leaves the deliberation alone', async () => {
    const s = makeState( 5, [ deliberating('intent-d', 'ponder'), refused('o', 'trade', 'class') ] )
    const { res } = await run( s )
    expect( setOf( res ).some( e => e.type === REVOCATION_TYPE ) ).toBe( false )
    expect( metricVal( res, 'agency.policy.revoked') ).toBeUndefined()
  })
})

describe('P3 — the invariant: a refusal never feeds exafferent rupture', () => {
  it('a refused outcome contributes zero rupture (no stability erosion, no rupture event)', async () => {
    // Deliberating a DIFFERENT schema, so policy-revoke cannot fire either — the
    // only thing present that could rupture is the refusal, and it must not.
    const s = makeState( 5, [ deliberating('intent-d', 'ponder'), refused('o', 'trade', 'class') ] )
    const { res, events } = await run( s )
    expect( metricVal( res, 'situation.stability') ).toBeUndefined()          // no erosion
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
    expect( setOf( res ).some( e => e.type === REVOCATION_TYPE ) ).toBe( false )
  })

  it('the exafferent path still revokes and is labelled distinctly', async () => {
    const s = makeState( 5, [ deliberating('intent-d', 'ponder'), exafferent('p', 0.95, 5 ) ] )
    const { res, events } = await run( s )
    expect( setOf( res ).some( e => e.type === REVOCATION_TYPE ) ).toBe( true )
    expect( metricVal( res, 'agency.policy.revoked') ).toBeUndefined()        // not policy-driven
    expect( events.find( e => e.type === 'agency.commitment.revoked')!.payload['reason'] ).toBe('exafferent-rupture')
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/agency.revocation.test.ts
// ─────────────────────────────────────────────────────────────
// EXAFFERENCE P4 — commitment revocation, the letting-go. A hard exafferent
// rupture (≥ RUPTURE_REVOKE_GATE) makes the ActionSelector drop a commitment it
// was still weighing — a `deliberating` intent — without a successor, so the
// field re-forms and the next tick selects. Because the selector can't safely
// delete an intent a later engine will resurrect (the P0 audit's set-after-
// delete race), it writes an `agency.revocation` tombstone that the Deliberation
// engine and the Executor honor next tick. These tests drive each of the three
// engines directly and prove the seam end to end.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity, EntityInput } from '#core/types'
import { ActionSelector } from '#agency/engines/action.selector'
import { DeliberationEngine } from '#agency/engines/deliberation.engine'
import { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'
import { revocationEntity, revocationId, REVOCATION_TYPE } from '#agency/revocation'

const CTX = {} as unknown as SimulationContext

interface Ent { id: string; type: string; metadata?: Record<string, unknown> }
function makeState( tick: number, entities: Ent[] ): ReadonlySimulationState {
  const em = new Map<string, unknown>()
  for( const e of entities ) em.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick, time: 0, entities: em, metrics: new Map() } as unknown as ReadonlySimulationState
}
function withEntity( s: ReadonlySimulationState, e: EntityInput ): ReadonlySimulationState {
  ( s.entities as unknown as Map<string, unknown> ).set( e.id, { ...e, createdAt: 0, updatedAt: 0 } )
  return s
}

const deliberating = ( id: string, schema: string ): Ent =>
  ({ id, type: 'agency.intent', metadata: { status: 'deliberating', schema, candidates: [ { schema } ] } })
const selectedIntent = ( id: string, schema: string ): Ent =>
  ({ id, type: 'agency.intent', metadata: { status: 'selected', schema, parameters: {}, expectedReward: 0.5 } })
const exafferent = ( id: string, salience: number, tick: number ): Ent =>
  ({ id, type: 'percept', metadata: { salience, provenance: 'exafferent', tick, entityId: 'w', category: 'threat' } })

function busSpy(): { bus: unknown; events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return {
    bus: {
      publish: ( e: { type: string; payload: Record<string, unknown> } ) => events.push( e ),
      // The bus contract includes subscribe — engines wire their listeners in
      // attachBus(). A publish-only double is an incomplete bus, not a smaller one.
      subscribe: () => () => {},
    },
    events,
  }
}
const setOf   = ( r: { commands?: { set?: EntityInput[] } } ) => r.commands?.set ?? []
const delOf   = ( r: { commands?: { delete?: string[] } } ) => r.commands?.delete ?? []
const metricV = ( r: { commands?: { metrics?: Array<[ string, number ]> } }, k: string ) =>
  ( r.commands?.metrics ?? [] ).find( m => m[0] === k )?.[1]

// ── the selector issues the tombstone ────────────────────────────────────────

describe('ActionSelector — issues a revocation under hard rupture', () => {
  it('writes a tombstone (no successor) + emits agency.commitment.revoked', async () => {
    const sel = new ActionSelector(); const spy = busSpy(); sel.attachBus( spy.bus as never )
    const s = makeState( 5, [ deliberating('intent-d', 'ponder'), exafferent('p', 0.95, 5 ) ] )
    const r = await sel.react( 0, 5, s, CTX )

    const tomb = setOf( r ).find( e => e.type === REVOCATION_TYPE )
    expect( tomb ).toBeDefined()
    expect( tomb!.id ).toBe( revocationId('intent-d') )
    expect( ( tomb!.metadata as Record<string, unknown> )['intentId'] ).toBe('intent-d')

    // No successor committed this tick — the field re-forms next tick.
    expect( setOf( r ).some( e => e.type === 'agency.intent') ).toBe( false )
    expect( metricV( r, 'agency.commitment.revoked') ).toBe( 1 )

    const evs = spy.events.filter( e => e.type === 'agency.commitment.revoked')
    expect( evs ).toHaveLength( 1 )                       // exactly once
    expect( evs[0]!.payload['from'] ).toBe('ponder')
    expect( evs[0]!.payload['reason'] ).toBe('exafferent-rupture')
  })

  it('a rupture below the revoke gate does NOT revoke (only softens — P3)', async () => {
    const sel = new ActionSelector(); const spy = busSpy(); sel.attachBus( spy.bus as never )
    // salience 0.6 → rupture (0.6−0.4)/0.6 ≈ 0.33 < RUPTURE_REVOKE_GATE (0.7)
    const s = makeState( 5, [ deliberating('intent-d', 'ponder'), exafferent('p', 0.6, 5 ) ] )
    const r = await sel.react( 0, 5, s, CTX )
    expect( setOf( r ).some( e => e.type === REVOCATION_TYPE ) ).toBe( false )
    expect( spy.events.some( e => e.type === 'agency.commitment.revoked') ).toBe( false )
    expect( metricV( r, 'agency.selection.busy') ).toBe( 1 )   // still just waiting/blocking
  })
})

// ── the Deliberation engine honors it ────────────────────────────────────────

describe('DeliberationEngine — honors the tombstone (skip + delete)', () => {
  it('drops a tombstoned deliberating intent and its tombstone; never deliberates it', async () => {
    const eng = new DeliberationEngine()               // no executive → System-1 path
    let s = makeState( 6, [ deliberating('intent-d', 'ponder') ] )
    s = withEntity( s, revocationEntity('intent-d', 'ponder', 0.9, 5 ) )   // live tombstone

    const r = await eng.react( 0, 6, s, CTX )
    expect( delOf( r ) ).toContain('intent-d')
    expect( delOf( r ) ).toContain( revocationId('intent-d') )
    // Not committed to 'selected' — no revoked intent survives as an action.
    expect( setOf( r ).some( e => e.id === 'intent-d') ).toBe( false )
  })

  it('still deliberates a NON-tombstoned intent alongside a revoked one', async () => {
    const eng = new DeliberationEngine()
    let s = makeState( 6, [ deliberating('intent-a', 'revoked-one'), deliberating('intent-b', 'live-one') ] )
    s = withEntity( s, revocationEntity('intent-a', 'revoked-one', 0.9, 5 ) )

    const r = await eng.react( 0, 6, s, CTX )
    expect( delOf( r ) ).toContain('intent-a')
    const committed = setOf( r ).find( e => e.id === 'intent-b')
    expect( committed ).toBeDefined()                                   // b proceeds
    expect( ( committed!.metadata as Record<string, unknown> )['status'] ).toBe('selected')
  })
})

// ── the Executor honors it (the half-race) ───────────────────────────────────

describe('MotorSchemaExecutor — refuses a tombstoned selected intent', () => {
  it('does not enact a revoked selected intent; deletes intent + tombstone', async () => {
    const exec = new MotorSchemaExecutor(); const spy = busSpy(); exec.attachBus( spy.bus as never )
    let s = makeState( 7, [ selectedIntent('intent-s', 'rest') ] )
    s = withEntity( s, revocationEntity('intent-s', 'rest', 0.9, 6 ) )

    const r = await exec.react( 0, 7, s, CTX )
    expect( delOf( r ) ).toContain('intent-s')
    expect( delOf( r ) ).toContain( revocationId('intent-s') )
    // No enaction: no outcome entity, no agency.enacted for this intent.
    expect( setOf( r ).some( e => e.type === 'agency.outcome') ).toBe( false )
    expect( spy.events.some( e => e.type === 'agency.enacted') ).toBe( false )
  })

  it('a preempted composite dies whole: parent + queued sub, neither enacted (registry #4)', async () => {
    const exec = new MotorSchemaExecutor(); const spy = busSpy(); exec.attachBus( spy.bus as never )
    let s = makeState( 7, [
      // The state the executor sees the tick AFTER an immediate-switch preemption:
      // the parent it advanced in-tick, the sub that advance queued, and the
      // challenger the selector committed.
      { id: 'macro', type: 'agency.intent', metadata: { status: 'expanding', schema: 'settle-self', steps: [ 'withdraw', 'rest' ], cursor: 1 } },
      { id: 'macro-sub-1', type: 'agency.intent', metadata: { status: 'selected', parentIntentId: 'macro', schema: 'rest', parameters: {}, expectedReward: 0.5 } },
      selectedIntent('intent-challenger', 'rest'),
    ] )
    s = withEntity( s, revocationEntity('macro', 'settle-self', 0.9, 6 ) )

    const r = await exec.react( 0, 7, s, CTX )

    // The whole macro is gone — parent, its queued sub, and the tombstone.
    expect( delOf( r ) ).toContain('macro')
    expect( delOf( r ) ).toContain('macro-sub-1')
    expect( delOf( r ) ).toContain( revocationId('macro') )
    // Exactly ONE enaction this tick: the challenger. The serial body holds.
    const enacted = spy.events.filter( e => e.type === 'agency.enacted')
    expect( enacted ).toHaveLength( 1 )
    expect( enacted[0]!.payload['schema'] ).toBe('rest')
    const outcomes = setOf( r ).filter( e => e.type === 'agency.outcome')
    expect( outcomes ).toHaveLength( 1 )
    expect( ( outcomes[0]!.metadata as Record<string, unknown> )['intentId'] ).toBe('intent-challenger')
  })

  it('reaps an expired orphan tombstone (intent already gone)', async () => {
    const exec = new MotorSchemaExecutor()
    let s = makeState( 20, [] )
    s = withEntity( s, revocationEntity('intent-gone', 'x', 0.9, /* tick */ 5 ) )   // expiresAt 10 < 20
    const r = await exec.react( 0, 20, s, CTX )
    expect( delOf( r ) ).toContain( revocationId('intent-gone') )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/agency.rupture.test.ts
// ─────────────────────────────────────────────────────────────
// EXAFFERENCE P3 — the exafferent-rupture channel. Proves the world can revoke
// engagement, not only win it: a strong exafferent percept (P2-tagged) softens
// the Will's switch cost and erodes situation.stability, so an awaiting action
// it would otherwise keep waiting on gets preempted. And — the load-bearing
// invariant — the mind can never be ruptured by the echo of its own action
// (a reafferent percept does nothing), and a world with no exafferent shock is
// byte-identical to pre-P3 (no stability metric, no rupture event).

import { describe, it, expect } from 'vitest'
import { SYSTEM_SIGNAL_SALIENCE } from '#senses/somatosensation.engine'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'
import { ActionSelector } from '#agency/engines/action.selector'
import { scoreAffordance, type BiasContext } from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'

const CTX = {} as unknown as SimulationContext

interface Ent { id: string; type: string; metadata?: Record<string, unknown> }

function makeState( tick: number, entities: Ent[], metrics: Record<string, number> = {} ): ReadonlySimulationState {
  const em = new Map<string, unknown>()
  for( const e of entities ) em.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick, time: 0, entities: em, metrics: new Map( Object.entries( metrics ) ) } as unknown as ReadonlySimulationState
}

/** A single available affordance (the sole challenger → the competition winner). */
function challenger( schema: string, over: Partial<Affordance> = {} ): Ent {
  return { id: `aff-${ schema }`, type: 'affordance', metadata: {
    schema, source: 'innate', parameters: {}, expectedValence: 0, expectedReward: 0.5,
    cost: 0.05, habitStrength: 0, available: true, tags: [], tick: 1, ...over,
  } }
}

const NEUTRAL_BIAS: BiasContext = {
  goalTargets: new Set(), maxGoalPriority: 0,
  drives: { energy: 0, sleep: 0, stress: 0, social: 0 }, threat: 0, inhibition: 0,
}

/** An awaiting incumbent of a DIFFERENT schema (so `sameAction` is false), fresh
 *  (dispatchedAt = tick → zero staleness), with a chosen activation. */
function awaiting( schema: string, activation: number, tick: number ): Ent {
  return { id: 'intent-await', type: 'agency.intent', metadata: {
    status: 'awaiting', schema, targetEntityId: 'x', activation, dispatchedAt: tick,
  } }
}

function percept( id: string, salience: number, provenance: string, tick: number ): Ent {
  return { id, type: 'percept', metadata: { salience, provenance, tick, entityId: 'w', category: 'message' } }
}

function busSpy(): { bus: unknown; events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return { bus: { publish: ( e: { type: string; payload: Record<string, unknown> } ) => events.push( e ) }, events }
}

const metricVal = ( r: { commands?: { metrics?: Array<[ string, number ]> } }, k: string ) =>
  ( r.commands?.metrics ?? [] ).find( m => m[0] === k )?.[1]
const deletes = ( r: { commands?: { delete?: string[] } } ) => r.commands?.delete ?? []

async function run( state: ReadonlySimulationState ) {
  const sel = new ActionSelector()
  const spy = busSpy(); sel.attachBus( spy.bus as never )
  const res = await sel.react( 0, ( state as { tick: number } ).tick, state, CTX )
  return { res, events: spy.events }
}

describe('rupture — the quiet path is byte-identical to pre-P3', () => {
  it('no exafferent percept ⇒ no stability metric and no rupture event', async () => {
    const s = makeState( 5, [ challenger('rest'), awaiting('wander', 0.9, 5 ) ] )
    const { res, events } = await run( s )
    expect( metricVal( res, 'situation.stability') ).toBeUndefined()
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
  })

  it('a REAFFERENT percept (our own echo) cannot rupture — nothing changes', async () => {
    const s = makeState( 5, [
      challenger('rest'), awaiting('wander', 0.9, 5 ),
      percept('p-echo', 0.95, 'reafferent', 5 ),   // strong, but ours
    ] )
    const { res, events } = await run( s )
    expect( metricVal( res, 'situation.stability') ).toBeUndefined()
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
  })

  it('a WAKE percept now ruptures — the behaviour P0 step 2 changed', async () => {
    // The real shape SomatosensationEngine now produces for a WAKE signal
    // (SIGNAL_BOUNDARY P1): exafferent, salience SYSTEM_SIGNAL_SALIENCE, ticked,
    // categorised by the sense that transduced it. `stem/index.ts` no longer
    // hand-writes this — it ingests a `SystemSignal` and the sense builds it.
    //
    // While it was untagged it failed this gate exactly as the mind's own echo
    // does, so a mind returning after hours away could not be ruptured by
    // noticing that. The gate is unchanged; the percept now answers it.
    const wake = { id: 'sense-somatosensation-5-1234', type: 'percept', metadata: {
      tick: 5, salience: SYSTEM_SIGNAL_SALIENCE, category: 'somatosensation',
      summary: 'I was offline for 3 hours. I am now online again.',
      provenance: 'exafferent', entityId: 'system:WAKE',
    } } as Ent
    const s = makeState( 5, [ challenger('rest'), awaiting('wander', 0.9, 5 ), wake ] )
    const { res, events } = await run( s )
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( true )
    expect( metricVal( res, 'situation.stability') ).toBeLessThan( 1 )
  })

  it('the same wake percept UNTAGGED does not rupture — isolating the tag as the cause', async () => {
    const untaggedWake = { id: 'sense-somatosensation-5-1234', type: 'percept', metadata: {
      tick: 5, salience: SYSTEM_SIGNAL_SALIENCE, category: 'somatosensation',
      summary: 'I was offline for 3 hours. I am now online again.',
      entityId: 'system:WAKE',
    } } as Ent
    const s = makeState( 5, [ challenger('rest'), awaiting('wander', 0.9, 5 ), untaggedWake ] )
    const { events } = await run( s )
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
  })

  it('an UNTAGGED percept cannot rupture either — pinning today, not endorsing it', async () => {
    // The gate is `=== 'exafferent'`, so a percept with NO provenance field is
    // excluded exactly as our own echo is. No writer produces one any more —
    // P0 step 2 tagged the last three — so this now pins the GATE rather than
    // any live path: it is what makes `perceptEntity()` requiring provenance
    // load-bearing instead of tidy. If the gate is ever widened to
    // `!== 'reafferent'`, this is the test that has to change with it.
    const untagged = { id: 'p-wake', type: 'percept', metadata: {
      salience: 0.95, tick: 5, entityId: 'w', category: 'system',
    } } as Ent
    const s = makeState( 5, [ challenger('rest'), awaiting('wander', 0.9, 5 ), untagged ] )
    const { res, events } = await run( s )
    expect( metricVal( res, 'situation.stability') ).toBeUndefined()
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
  })
})

describe('rupture — a strong exafferent percept fires the channel', () => {
  it('emits agency.situation.rupture and knocks situation.stability below 1', async () => {
    const s = makeState( 5, [
      challenger('rest'), awaiting('wander', 0.9, 5 ),
      percept('p-shock', 0.9, 'exafferent', 5 ),
    ] )
    const { res, events } = await run( s )
    const ev = events.find( e => e.type === 'agency.situation.rupture')
    expect( ev ).toBeDefined()
    expect( ev!.payload['rupture'] as number ).toBeGreaterThan( 0 )
    expect( metricVal( res, 'situation.stability')! ).toBeLessThan( 1 )
  })

  it('an exafferent percept below the salience gate does NOT rupture', async () => {
    const s = makeState( 5, [
      challenger('rest'), awaiting('wander', 0.9, 5 ),
      percept('p-mild', 0.3, 'exafferent', 5 ),   // < RUPTURE_SALIENCE_GATE (0.4)
    ] )
    const { res, events } = await run( s )
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
    expect( metricVal( res, 'situation.stability') ).toBeUndefined()
  })

  it('a stale exafferent percept (older than the window) does NOT rupture', async () => {
    const s = makeState( 10, [
      challenger('rest'), awaiting('wander', 0.9, 10 ),
      percept('p-old', 0.9, 'exafferent', 6 ),   // 10 - 6 = 4 > RUPTURE_WINDOW_TICKS (2)
    ] )
    const { events } = await run( s )
    expect( events.some( e => e.type === 'agency.situation.rupture') ).toBe( false )
  })
})

describe('rupture — the headline: it softens an awaiting preemption', () => {
  // Pin the challenger's activation, then place the incumbent JUST below it — a
  // gap smaller than the calm switch cost (so the Will keeps waiting) but the
  // incumbent still outranks it once rupture zeroes the switch cost.
  const chAff = challenger('rest').metadata as unknown as Affordance
  const A = scoreAffordance( chAff, NEUTRAL_BIAS )
  const incumbentActivation = A - 0.02   // gap 0.02 < calm switchCost (~0.15·(1−stakes))

  it('calm: keeps waiting on the incumbent (no preemption)', async () => {
    const s = makeState( 5, [ challenger('rest'), awaiting('wander', incumbentActivation, 5 ) ] )
    const { res } = await run( s )
    expect( metricVal( res, 'agency.selection.busy') ).toBe( 1 )
    expect( deletes( res ) ).not.toContain('intent-await')
  })

  it('ruptured: the same field now preempts the awaiting incumbent', async () => {
    const s = makeState( 5, [
      challenger('rest'), awaiting('wander', incumbentActivation, 5 ),
      percept('p-shock', 1.0, 'exafferent', 5 ),   // full rupture ⇒ switch cost → 0
    ] )
    const { res } = await run( s )
    expect( deletes( res ) ).toContain('intent-await')          // incumbent preempted
    expect( metricVal( res, 'agency.selection.preempted') ).toBe( 1 )
  })
})

describe('rupture — situation.stability recovers when calm', () => {
  it('mean-reverts toward 1 on a quiet tick and keeps writing until settled', async () => {
    const s = makeState( 5, [ challenger('rest') ], { 'situation.stability': 0.5 } )
    const { res } = await run( s )
    const next = metricVal( res, 'situation.stability')!
    expect( next ).toBeGreaterThan( 0.5 )                        // recovering
    expect( next ).toBeCloseTo( 0.5 + 0.05 * ( 1 - 0.5 ), 10 )   // prev + RECOVERY·(1−prev)
  })
})

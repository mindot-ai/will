// ─────────────────────────────────────────────────────────────
// tests/integration/agency.settles-a-question.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The loop, end to end — and that it closes.
 *
 * The pathology in full: the selector recruits System 2 when `margin <
 * marginGate` (0.06), margin being the activation gap between the top two
 * affordances. A field whose options are variations on one theme shares nearly
 * every scoring term, so the margin is structurally tiny and the gate is open
 * every tick. Deliberation resolves the contest, writes `deliberated: true` on
 * that one intent, and returns. The synthesizer rebuilds the field from scratch,
 * the same rivals score the same, the margin is again under the gate, and the
 * mind deliberates the same question again.
 *
 * Measured on a live COO: 149 deliberations in 7 hours, median gap 17 seconds,
 * 139 of 148 gaps under a minute. She wrote, in her own reasoning: "Nothing has
 * changed since my last ten deliberation cycles. Goal-7 is externally blocked —
 * this is a fact, not a diagnosis I need to reach again."
 *
 * This file runs the actual engines against each other rather than asserting on
 * either one alone, because every defect in this family has been a value that
 * one engine produced and another did not read.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { DeliberationEngine, type DeliberationFacetProvider } from '#agency/engines/deliberation.engine'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { readAffordance } from '#agency/engines/action.selector'
import { scoreAffordance, DEFAULT_WEIGHTS, type BiasContext } from '#agency/selection.scoring'
import {
  SETTLEMENT_TYPE, SETTLEMENT_TTL_TICKS, readSettlement, liveSettlements, settlementId,
} from '#agency/settlement'

const CTX = {} as unknown as SimulationContext

type Ent = { id: string; type: string; metadata?: Record<string, unknown> }

function stateOf( tick: number, ents: Ent[], metrics: Record<string, number> = {} ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  for( const e of ents )
    entities.set( e.id, { ...e, createdAt: 0, updatedAt: 0 } )
  return {
    tick, time: 0, entities, metrics: new Map( Object.entries( metrics ) ),
  } as unknown as ReadonlySimulationState
}

/** A facet that always reaches the same verdict — which is the real situation. */
function decides( choice: string ): DeliberationFacetProvider {
  return {
    spawnFacet() {
      let listener: ( ( d: { decision: unknown } ) => void ) | null = null
      return {
        attention: 'available',
        handle: {
          setFocus() {},
          subscribe( l ) { listener = l; return () => { listener = null } },
          async report() { listener?.({ decision: { actions: [ { type: choice } ] } }) },
          destroy() {},
        },
      }
    },
  }
}

const CANDIDATES = [
  { schema: 'withdraw' },
  { schema: 'reach-out', targetEntityId: 'ke:fkem' },
  { schema: 'inspect',   targetEntityId: 'ke:room' },
]

const deliberatingIntent = ( tick: number ): Ent => ({
  id: `agency-intent-${ tick }`, type: 'agency.intent',
  metadata: { status: 'deliberating', schema: 'reach-out', parameters: {}, candidates: CANDIDATES, tick },
})

const bias = (): BiasContext => ({
  valence: 0, threat: 0, inhibition: 0,
  drives: { energy: 0, sleep: 0, social: 0, stress: 0 },
  goalTargets: new Map(),
} as unknown as BiasContext )

// ─────────────────────────────────────────────────────────────

describe('deliberating leaves a trace in the field it resolved', () => {
  it('writes a settlement naming the act that won and the rivals it beat', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( decides('withdraw') )

    const set = ( await eng.react( 0, 100, stateOf( 100, [ deliberatingIntent( 100 ) ] ), CTX ) ).commands?.set
    const settlement = ( set ?? [] ).find( e => e.type === SETTLEMENT_TYPE )

    expect( settlement, 'System 2 reached a verdict and the field learned nothing').toBeDefined()

    const d = readSettlement( settlement!.metadata )
    expect( d?.schema ).toBe('withdraw')
    expect( d?.expiresAt ).toBe( 100 + SETTLEMENT_TTL_TICKS )
    expect( d?.over, 'what it was chosen OVER is the introspectable reason')
      .toEqual( [ 'reach-out', 'inspect' ] )
  })

  it('does NOT settle when no executive thought about it', async () => {
    // The no-executive path confirms the substrate's provisional winner without
    // reaching a conclusion. A mind must not be held to a verdict it never formed.
    const set = ( await new DeliberationEngine()
      .react( 0, 100, stateOf( 100, [ deliberatingIntent( 100 ) ] ), CTX ) ).commands?.set

    expect( ( set ?? [] ).some( e => e.type === SETTLEMENT_TYPE ) ).toBe( false )
  })

  it('and the settlement it wrote actually widens the margin next tick', async () => {
    // The whole point. The verdict must reach the competition as a force, or the
    // gate is open again on the very next tick and nothing has changed.
    const eng = new DeliberationEngine()
    eng.attachExecutive( decides('withdraw') )

    const settlement = ( ( await eng.react(
      0, 100, stateOf( 100, [ deliberatingIntent( 100 ) ] ), CTX ) ).commands?.set ?? [] )
      .find( e => e.type === SETTLEMENT_TYPE )!

    // Next tick: the synthesizer rebuilds the field, now with the verdict in state.
    const withVerdict = await new AffordanceSynthesizer().react( 0, 101, stateOf( 101,
      [ { id: settlement.id, type: settlement.type, metadata: settlement.metadata as Record<string, unknown> } ],
      { 'energy.level': 60 } ), CTX )
    const without = await new AffordanceSynthesizer().react(
      0, 101, stateOf( 101, [], { 'energy.level': 60 } ), CTX )

    const pick = ( r: { commands?: { set?: EntityInput[] } } ) =>
      ( r.commands?.set ?? [] ).find( e => e.metadata?.['schema'] === 'withdraw' )!
    const scoreOf = ( e: EntityInput ) =>
      scoreAffordance( readAffordance( e.id, e.metadata ), bias(), DEFAULT_WEIGHTS )

    const gain = scoreOf( pick( withVerdict ) ) - scoreOf( pick( without ) )
    expect( gain, 'a verdict that does not clear the 0.06 ambiguity gate cannot stop the loop')
      .toBeGreaterThan( 0.06 )
  })

  it('sweeps its own aged-out verdicts, so state does not grow forever', async () => {
    const stale = {
      id: settlementId('withdraw'), type: SETTLEMENT_TYPE,
      metadata: { schema: 'withdraw', tick: 10, expiresAt: 40 },
    }
    const res = await new DeliberationEngine().react( 0, 200, stateOf( 200, [ stale ] ), CTX )
    expect( res.commands?.delete ).toContain( stale.id )
  })

  it('re-deciding refreshes one settlement rather than piling up new ones', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( decides('withdraw') )

    const first = ( ( await eng.react( 0, 100, stateOf( 100, [ deliberatingIntent( 100 ) ] ), CTX ) )
      .commands?.set ?? [] ).find( e => e.type === SETTLEMENT_TYPE )!
    const again = ( ( await eng.react( 0, 400, stateOf( 400, [ deliberatingIntent( 400 ) ] ), CTX ) )
      .commands?.set ?? [] ).find( e => e.type === SETTLEMENT_TYPE )!

    expect( again.id ).toBe( first.id )
    expect( readSettlement( again.metadata )?.expiresAt ).toBe( 400 + SETTLEMENT_TTL_TICKS )
  })
})

describe('and the mind can still change its mind', () => {
  it('the verdict fades on its own, re-opening the question', async () => {
    const held = ( tick: number ) => liveSettlements( new Map([ [ settlementId('withdraw'),
      { type: SETTLEMENT_TYPE, metadata: { schema: 'withdraw', tick: 100, expiresAt: 160 } } ] ]), tick )

    expect( held( 101 ) ).toHaveLength( 1 )
    expect( held( 200 ), 'a verdict must not be permanent — the question comes back').toHaveLength( 0 )
  })

  it('a verdict formed before the world changed does not survive the change', async () => {
    // The failure this shares with the FKEM incident: a decision made in one
    // situation, executed into another, with nothing looking in between. A hard
    // exafferent rupture means the premises the mind decided on were just
    // contradicted, so the settlement lapses with them — and NOT only when
    // something happens to be mid-deliberation, since the whole point of a
    // settlement is that it outlives the intent that formed it.
    const { ActionSelector } = await import('#agency/engines/action.selector')

    const settlement: Ent = {
      id: settlementId('withdraw'), type: SETTLEMENT_TYPE,
      metadata: { schema: 'withdraw', tick: 100, expiresAt: 100 + SETTLEMENT_TTL_TICKS },
    }
    // A maximally surprising exafferent percept — read straight off frozen state
    // by `computeRupture`, so this does not depend on bus plumbing.
    const rupturing: Ent = {
      id: 'percept-1', type: 'percept',
      metadata: { provenance: 'exafferent', salience: 1, tick: 110, content: 'the world just changed' },
    }

    const res = await new ActionSelector().react(
      0, 110, stateOf( 110, [ settlement, rupturing ], { 'situation.stability': 1 } ), CTX )

    expect( res.commands?.delete, 'the verdict outlived the situation that produced it')
      .toContain( settlement.id )
  })

  it('but an ordinary tick leaves a standing verdict alone', async () => {
    // The counterpart, and what keeps the above from passing for the wrong
    // reason: without a rupture the settlement must survive untouched.
    const { ActionSelector } = await import('#agency/engines/action.selector')

    const settlement: Ent = {
      id: settlementId('withdraw'), type: SETTLEMENT_TYPE,
      metadata: { schema: 'withdraw', tick: 100, expiresAt: 100 + SETTLEMENT_TTL_TICKS },
    }

    const res = await new ActionSelector().react(
      0, 110, stateOf( 110, [ settlement ], { 'situation.stability': 1 } ), CTX )

    expect( res.commands?.delete ?? [] ).not.toContain( settlement.id )
  })
})

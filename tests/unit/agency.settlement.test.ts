// ─────────────────────────────────────────────────────────────
// tests/unit/agency.settlement.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Having thought about it.
 *
 * The agency could represent having ACTED and could not represent having
 * DECIDED. System 2 was recruited on a flat field, resolved the contest, wrote
 * `deliberated: true` on that one intent — and nothing read it. The synthesizer
 * rebuilt the field from scratch next tick, the same rivals scored the same, the
 * margin was again under the gate, and the same question was deliberated again.
 *
 * Measured on a live COO over 7 hours: 149 deliberations, median gap 17s, 139 of
 * 148 gaps under a minute. She could see the loop and had no mechanism to leave
 * it — "Nothing has changed since my last ten deliberation cycles. Goal-7 is
 * externally blocked — this is a fact, not a diagnosis I need to reach again."
 *
 * A settlement is the trace a verdict leaves in the field it was called in to
 * resolve, and it is one quantity doing both jobs: the verdict gets force, and
 * the margin to the runner-up widens past the gate that summons System 2.
 */

import { describe, it, expect } from 'vitest'
import {
  settlementEntity, readSettlement, liveSettlements, settlementForce,
  expiredSettlementIds, settlementId, SETTLEMENT_TYPE, SETTLEMENT_TTL_TICKS,
  type SettlementDescriptor,
} from '#agency/settlement'
import { scoreAffordance, DEFAULT_WEIGHTS } from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'

const settled = ( over: Partial<SettlementDescriptor> = {} ): SettlementDescriptor => ({
  schema: 'reach-out', targetEntityId: 'ke:ada',
  tick: 100, expiresAt: 100 + SETTLEMENT_TTL_TICKS, ...over,
})

const entities = ( ...ds: SettlementDescriptor[] ) =>
  new Map( ds.map( d => {
    const e = settlementEntity( d )
    return [ e.id, { type: e.type, metadata: e.metadata as Record<string, unknown> } ]
  }) )

describe('a verdict already reached', () => {
  it('holds strongly right after it is made, and fades on its own', () => {
    const s = [ settled() ]
    expect( settlementForce( s, 'reach-out', 'ke:ada', 100 ) ).toBeCloseTo( 1, 5 )
    expect( settlementForce( s, 'reach-out', 'ke:ada', 130 ) ).toBeCloseTo( 0.5, 5 )
    expect( settlementForce( s, 'reach-out', 'ke:ada', 160 ) ).toBe( 0 )
    expect( settlementForce( s, 'reach-out', 'ke:ada', 999 ),
      'a verdict must not outlive its window — this is a refractory period, not a lock').toBe( 0 )
  })

  it('does not leak onto a different question', () => {
    const s = [ settled() ]
    expect( settlementForce( s, 'reach-out', 'ke:bob', 101 ),
      'deciding about Ada says nothing about Bob').toBe( 0 )
    expect( settlementForce( s, 'inspect', 'ke:ada', 101 ),
      'deciding to reach out says nothing about inspecting').toBe( 0 )
  })

  it('keeps objectless verdicts separate from ones with an object', () => {
    const s = [ settled({ schema: 'rest', targetEntityId: undefined }) ]
    expect( settlementForce( s, 'rest', undefined, 101 ) ).toBeGreaterThan( 0 )
    expect( settlementForce( s, 'rest', 'ke:ada', 101 ) ).toBe( 0 )
  })
})

describe('the settlement entity', () => {
  it('survives the round-trip — written AND read back, every field', () => {
    // The defect shape this codebase has hit six times, and precisely the one
    // this module exists to fix: `deliberated: true` was written on every
    // deliberated intent and decoded by nobody.
    const d = settled({ over: [ 'inspect', 'withdraw' ] })
    const back = readSettlement( settlementEntity( d ).metadata )

    expect( back ).toEqual( d )
    expect( back?.over, 'the rivals are the introspectable reason — "I chose this OVER that"')
      .toEqual( [ 'inspect', 'withdraw' ] )
  })

  it('is keyed on what won, so re-deciding refreshes rather than accumulates', () => {
    expect( settlementEntity( settled({ tick: 100 }) ).id )
      .toBe( settlementEntity( settled({ tick: 400 }) ).id )
    expect( settlementEntity( settled() ).type ).toBe( SETTLEMENT_TYPE )
  })

  it('reads back from a Map, not just a plain object', () => {
    // Frozen state hands metadata over as a ReadonlyMap in some paths and a
    // record in others. A decoder that only handles one silently returns null.
    const meta = new Map( Object.entries( settlementEntity( settled() ).metadata! ) )
    expect( readSettlement( meta )?.schema ).toBe('reach-out')
  })
})

describe('collecting live settlements', () => {
  it('drops the ones that have aged out', () => {
    const live = liveSettlements( entities( settled(), settled({
      schema: 'inspect', targetEntityId: 'ke:room', tick: 10, expiresAt: 40 }) ), 101 )
    expect( live.map( s => s.schema ) ).toEqual( [ 'reach-out' ] )
    expect( expiredSettlementIds( entities( settled({ tick: 10, expiresAt: 40 }) ), 101 ) )
      .toEqual( [ settlementId('reach-out', 'ke:ada') ] )
  })

  it('ignores a settlement stamped in the future — the restart trap', () => {
    // Settlements snapshot with the state and the tick counter restarts at 1 on
    // wake. Without this guard a woken mind reads every verdict it ever made as
    // freshly decided and cannot deliberate at all. `liveConsequences` documents
    // the same trap after a Will spent a whole session believing it had just
    // messaged someone.
    expect( liveSettlements( entities( settled({ tick: 575, expiresAt: 635 }) ), 1 ) ).toEqual( [] )
  })
})

describe('what the verdict does to the competition', () => {
  const affordance = ( over: Partial<Affordance> = {} ): Affordance => ({
    id: 'a-1', schema: 'reach-out', source: 'innate', parameters: {},
    expectedValence: 0, expectedReward: 0.2, cost: 0.1, habitStrength: 0.3,
    available: true, tags: [], tick: 100, ...over,
  } as Affordance)

  const bias = {
    goalTargets: new Map<string, number>(), maxGoalPriority: 0,
    drives: { energy: 0, sleep: 0, social: 0, stress: 0 }, threat: 0, inhibition: 0,
  } as never

  it('widens the margin past the gate that summons System 2', () => {
    // MARGIN_THRESHOLD is 0.06. The whole pathology was a field flat enough to
    // sit under it every tick, so the verdict has to be what gives the field the
    // shape it lacked.
    const plain   = scoreAffordance( affordance(), bias )
    const decided = scoreAffordance( affordance({ settled: 1 }), bias )

    expect( decided - plain ).toBeCloseTo( DEFAULT_WEIGHTS.settled, 5 )
    expect( decided - plain,
      'a fresh verdict must clear the ambiguity gate or nothing stops the loop')
      .toBeGreaterThan( 0.06 )
  })

  it('has stopped clearing that gate by the time it has mostly decayed', () => {
    // The question genuinely re-opens; it does not merely become cheaper to
    // re-ask. At 20% remaining the boost is 0.06 — exactly the gate — so beyond
    // that the contest is live again.
    const plain = scoreAffordance( affordance(), bias )
    expect( scoreAffordance( affordance({ settled: 0.1 }), bias ) - plain ).toBeLessThan( 0.06 )
  })

  it('is a weight, not a veto — a pressing rival still wins', () => {
    // A settled option that could not be out-competed would be the hard
    // conditional gate this design exists to avoid: no flexibility, no dynamism.
    //
    // "Pressing" means what the scorer means by it — a goal pointed at this, and
    // a drive gone urgent — not merely a high expected reward, which is one of
    // the weakest levers in the competition (0.25 against `goal` and `social` at
    // 0.30 each).
    const pressing = {
      ...bias as object,
      goalTargets: new Map([ [ 'ke:bob', 1 ] ]), maxGoalPriority: 1,
      drives: { energy: 0, sleep: 0, social: 1, stress: 0 },
    } as never

    const held  = scoreAffordance( affordance({ settled: 1 }), bias )
    const urgent = scoreAffordance(
      affordance({ targetEntityId: 'ke:bob', tags: [ 'social' ] }), pressing )

    expect( urgent, 'a standing verdict must not outrank a goal with a drive behind it')
      .toBeGreaterThan( held )
  })

  it('but does hold against the flat field that summoned it', () => {
    // The counterpart, and the actual job: against rivals that differ by almost
    // nothing — which is what "the field was ambiguous" MEANS — the verdict wins
    // and keeps winning until it decays.
    const rival = scoreAffordance( affordance({ id: 'a-2', expectedReward: 0.22 }), bias )
    const held  = scoreAffordance( affordance({ settled: 0.5 }), bias )
    expect( held ).toBeGreaterThan( rival )
  })

  it('leaves a mind that has never deliberated scoring exactly as before', () => {
    expect( scoreAffordance( affordance({ settled: undefined }), bias ) )
      .toBe( scoreAffordance( affordance({ settled: 0 }), bias ) )
  })
})

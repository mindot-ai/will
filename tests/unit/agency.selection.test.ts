// ─────────────────────────────────────────────────────────────
// tests/unit/agency.selection.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 1 — the competition. Proves the substrate selects on its own (System 1),
// recruits the LLM only on ambiguity or stakes (System 2), and that an
// overlearned habit raises its own deliberation threshold (the gradient).

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { ActionSelector } from '#agency/engines/action.selector'
import {
  scoreAffordance, competitionEntropy, goalRelevance, driveUrgency,
  type BiasContext,
} from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'
import { REVOCATION_TYPE, revocationId } from '#agency/revocation'

const CTX = {} as unknown as SimulationContext

function makeState( opts: {
  tick?:     number
  metrics?:  Record<string, number>
  entities?: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>
} ): ReadonlySimulationState {
  const metrics  = new Map<string, number>( Object.entries( opts.metrics ?? {} ) )
  const entities = new Map<string, unknown>()
  for( const e of opts.entities ?? [] )
    entities.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick: opts.tick ?? 1, time: 0, entities, metrics } as unknown as ReadonlySimulationState
}

/** Build an `affordance` entity with sensible defaults. */
function aff( o: Partial<Affordance> & { id: string; schema: string } ) {
  return {
    id:   o.id,
    type: 'affordance',
    metadata: {
      schema:          o.schema,
      source:          o.source          ?? 'innate',
      parameters:      o.parameters      ?? {},
      targetEntityId:  o.targetEntityId,
      evokedBy:        o.evokedBy,
      expectedValence: o.expectedValence ?? 0,
      expectedReward:  o.expectedReward  ?? 0.3,
      cost:            o.cost            ?? 0.05,
      habitStrength:   o.habitStrength   ?? 0,
      available:       o.available       ?? true,
      tags:            o.tags            ?? [],
      tick:            o.tick            ?? 1,
    },
  }
}

const NEUTRAL_BIAS: BiasContext = {
  goalTargets:     new Set(),
  maxGoalPriority: 0,
  drives:          { energy: 0, sleep: 0, stress: 0, social: 0 },
  threat:          0,
  inhibition:      0,
}

const intentOf = ( set: EntityInput[] | undefined ) =>
  ( set ?? [] ).find( e => e.type === 'agency.intent')
const metricVal = ( res: { commands?: { metrics?: Array<[ string, number ]> } }, key: string ) =>
  ( res.commands?.metrics ?? [] ).find( m => m[0] === key )?.[1]

// ── pure scoring ────────────────────────────────────────────────────────────

describe('scoring — the activation arithmetic', () => {
  it('reward and goal-target match raise activation; cost lowers it', () => {
    const base = aff({ id: 'a', schema: 's', expectedReward: 0.2, cost: 0.5 }).metadata as unknown as Affordance
    const rich = { ...base, expectedReward: 0.9, cost: 0.0 }
    expect( scoreAffordance( rich, NEUTRAL_BIAS ) ).toBeGreaterThan( scoreAffordance( base, NEUTRAL_BIAS ) )
  })

  it('goalRelevance is structural — returns goal priority only on target match', () => {
    const a = { targetEntityId: 'alice' } as unknown as Affordance
    const bias = { ...NEUTRAL_BIAS, goalTargets: new Set([ 'alice' ]), maxGoalPriority: 0.8 }
    expect( goalRelevance( a, bias ) ).toBe( 0.8 )
    expect( goalRelevance( { targetEntityId: 'bob' } as unknown as Affordance, bias ) ).toBe( 0 )
  })

  it('driveUrgency routes homeostatic pressure by schema tags', () => {
    const restful = { tags: [ 'regulatory' ] } as unknown as Affordance
    const social  = { tags: [ 'social' ] } as unknown as Affordance
    const bias = { ...NEUTRAL_BIAS, drives: { energy: 0.9, sleep: 0.2, stress: 0, social: 0.4 } }
    expect( driveUrgency( restful, bias ) ).toBe( 0.9 )
    expect( driveUrgency( social,  bias ) ).toBe( 0.4 )
  })

  it('entropy is ~0 for a dominant winner and ~1 for a flat field', () => {
    expect( competitionEntropy([ 1.0, 0.1, 0.05 ]) ).toBeLessThan( 0.4 )
    expect( competitionEntropy([ 0.5, 0.5, 0.5, 0.5 ]) ).toBeCloseTo( 1, 5 )
  })
})

// ── the selector engine ─────────────────────────────────────────────────────

describe('ActionSelector — System 1 default', () => {
  it('commits the dominant affordance as an intent without deliberating', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 1, makeState({
      metrics:  {},
      entities: [
        aff({ id: 'a1', schema: 'reach-out', source: 'social', expectedReward: 0.9, cost: 0.1,
              targetEntityId: 'alice', tags: [ 'social' ], expectedValence: 0.3 }),
        aff({ id: 'a2', schema: 'wait', expectedReward: 0.2, cost: 0.01, tags: [ 'neutral' ] }),
        // a goal pointed at alice sharpens the winner into a confident choice
        { id: 'goal-alice', type: 'goal', metadata: { status: 'active', targetEntityId: 'alice', priority: 0.9 } },
      ],
    }), CTX )

    const intent = intentOf( res.commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('reach-out')
    expect( intent?.metadata?.['deliberate'] ).toBe( false )
    expect( metricVal( res, 'agency.selection.deliberate') ).toBe( 0 )
  })

  it('excludes unavailable affordances from the competition', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 1, makeState({
      entities: [
        aff({ id: 'a1', schema: 'reach-out', expectedReward: 0.9, available: false }),  // gated out
        aff({ id: 'a2', schema: 'rest', expectedReward: 0.3, available: true }),
      ],
    }), CTX )
    expect( intentOf( res.commands?.set )?.metadata?.['schema'] ).toBe('rest')
  })

  it('defers (acts serially) while a committed/composite action is in flight', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 2, makeState({
      entities: [
        { id: 'agency-intent-1', type: 'agency.intent', metadata: { status: 'selected' } },
        aff({ id: 'a1', schema: 'wait' }),
      ],
    }), CTX )
    // 'selected' (one-tick) and 'expanding' (composite) are left to finish — busy.
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( metricVal( res, 'agency.selection.busy') ).toBe( 1 )
  })
})

describe('ActionSelector — preemption (the smarter serializer)', () => {
  // A weak incumbent the Will is awaiting a host on.
  const awaitingIntent = ( activation: number, schema = 'reach-out', target = 'alice') => ({
    id: 'agency-intent-1', type: 'agency.intent',
    metadata: { status: 'awaiting', activation, schema, targetEntityId: target, dispatchedAt: 1 },
  })

  it('keeps waiting when no challenger beats the awaiting incumbent by the switch cost', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [
        awaitingIntent( 0.5 ),                                   // strong incumbent
        aff({ id: 'a1', schema: 'wait', expectedReward: 0.2, cost: 0.05 } ),  // weak challenger
      ],
    }), CTX )
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( res.commands?.delete ?? [] ).not.toContain('agency-intent-1')
    expect( metricVal( res, 'agency.selection.preempted') ?? 0 ).toBe( 0 )
  })

  it('preempts when a clearly stronger challenger appears (commits it, cancels the await)', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      metrics:  {},
      entities: [
        awaitingIntent( 0.2 ),                                   // weak incumbent
        aff({ id: 'a1', schema: 'rest', expectedReward: 0.9, cost: 0.0,
              tags: [ 'regulatory' ], targetEntityId: undefined } ),
      ],
    }), CTX )
    const intent = intentOf( res.commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('rest')       // challenger committed
    expect( res.commands?.delete ).toContain('agency-intent-1') // await cancelled
    expect( metricVal( res, 'agency.selection.preempted') ).toBe( 1 )
  })

  it('a high-stakes challenger overrides almost immediately (switch cost ≈ 0)', async () => {
    // A threat-driven withdraw outscores the incumbent only slightly — it would NOT
    // beat it under the full switch cost, but its high stakes collapse the cost so it
    // preempts anyway. (Threat also raises the challenger's own risk, so the margin is thin.)
    const res = await new ActionSelector().react( 0, 2, makeState({
      metrics:  { 'threat.level': 0.9, 'stress.load': 60 },
      entities: [
        awaitingIntent( 0.2 ),
        aff({ id: 'a1', schema: 'withdraw', expectedReward: 0.5, cost: 0.03,
              tags: [ 'self-protection' ], expectedValence: -0.4, targetEntityId: undefined } ),
      ],
    }), CTX )
    expect( intentOf( res.commands?.set )?.metadata?.['schema'] ).toBe('withdraw')
    expect( metricVal( res, 'agency.selection.preempted') ).toBe( 1 )
  })

  // ── composite preemption (immediate switch, registry #4) ────
  const macro = ( activation: number, schema = 'settle-self') => ([
    { id: 'macro', type: 'agency.intent', metadata: { status: 'expanding', activation, schema } },
    { id: 'macro-sub-0', type: 'agency.intent', metadata: { status: 'selected', parentIntentId: 'macro', schema: 'withdraw' } },
  ])

  it('cuts a mid-composite routine AND commits the challenger the same tick (immediate switch)', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [
        ...macro( 0.2 ),
        aff({ id: 'a1', schema: 'rest', expectedReward: 0.9, cost: 0.0, tags: [ 'regulatory' ] }),
      ],
    }), CTX )
    // Tombstoned, never deleted — the executor's in-tick macro-advance would
    // resurrect a deleted parent (set-after-delete) and double-enact.
    expect( res.commands?.delete ?? [] ).not.toContain('macro')
    const tomb = ( res.commands?.set ?? [] ).find( e => e.type === REVOCATION_TYPE )
    expect( tomb?.id ).toBe( revocationId('macro') )
    // …and the challenger takes the body immediately (the tick the old
    // cancel-only path used to waste).
    expect( intentOf( res.commands?.set )?.metadata?.['schema'] ).toBe('rest')
    expect( metricVal( res, 'agency.selection.preempted') ).toBe( 1 )
  })

  it('lets a mid-composite routine continue against a weak challenger', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [
        ...macro( 0.5 ),
        aff({ id: 'a1', schema: 'wait', expectedReward: 0.2, cost: 0.05 }),
      ],
    }), CTX )
    expect( res.commands?.delete ?? [] ).not.toContain('macro')
    expect( metricVal( res, 'agency.selection.preempted') ?? 0 ).toBe( 0 )
    expect( metricVal( res, 'agency.selection.busy') ).toBe( 1 )
  })

  it('an orphan macro sub (parent already cancelled) blocks until it drains', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [
        { id: 'macro-sub-0', type: 'agency.intent', metadata: { status: 'selected', parentIntentId: 'gone', schema: 'rest' } },
        aff({ id: 'a1', schema: 'reach-out', expectedReward: 0.9 }),
      ],
    }), CTX )
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( metricVal( res, 'agency.selection.busy') ).toBe( 1 )
  })

  it('does not churn when the field still favours the action being awaited', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      metrics:  { 'drive.social': 0.9 },
      entities: [
        awaitingIntent( 0.3, 'reach-out', 'alice'),
        aff({ id: 'a1', schema: 'reach-out', source: 'social', targetEntityId: 'alice',
              expectedReward: 0.9, tags: [ 'social' ] } ),                 // same action, top of field
      ],
    }), CTX )
    // winner == incumbent → keep waiting, no preemption, no churn
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( metricVal( res, 'agency.selection.preempted') ?? 0 ).toBe( 0 )
    expect( metricVal( res, 'agency.selection.busy') ).toBe( 1 )
  })
})

describe('ActionSelector — switch resistance develops (R2 Channel A)', () => {
  // A weak action the Will is awaiting a host on (incumbentStrength ≈ 0.193 at tick 2),
  // and a marginal challenger: a fully-habitual `wait` (habit 1 ⇒ novelty 0 ⇒ stakes 0,
  // so the switch cost applies undiscounted) with reward 1.0 / cost 0 ⇒ activation 0.45.
  // That sits in the band that preempts at the base switch cost (0.15) but NOT once it is
  // hardened to 0.45 — by long focus or by a developed persona-prior.
  const awaiting = {
    id: 'agency-intent-1', type: 'agency.intent',
    metadata: { status: 'awaiting', activation: 0.2, schema: 'reach-out', targetEntityId: 'alice', dispatchedAt: 1 },
  }
  const challenger = aff({ id: 'a1', schema: 'wait', expectedReward: 1.0, cost: 0.0,
                           habitStrength: 1, expectedValence: 0 })

  it('preempts at the base switch cost (no focus, no developed prior)', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [ awaiting, challenger ],
    }), CTX )
    expect( intentOf( res.commands?.set )?.metadata?.['schema'] ).toBe('wait')
    expect( res.commands?.delete ).toContain('agency-intent-1')
    expect( metricVal( res, 'agency.selection.preempted') ).toBe( 1 )
  })

  it('long focus hardens the switch cost so the same challenger no longer preempts', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      metrics:  { 'task_switch.current_focus_ticks': 200 },   // 0.15·(1+200·0.01) = 0.45
      entities: [ awaiting, challenger ],
    }), CTX )
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( res.commands?.delete ?? [] ).not.toContain('agency-intent-1')
    expect( metricVal( res, 'agency.selection.preempted') ?? 0 ).toBe( 0 )
  })

  it('a developed persona-prior (a conscientious Will) hardens it the same way', async () => {
    const res = await new ActionSelector().react( 0, 2, makeState({
      entities: [
        awaiting, challenger,
        { id: 'engine-config-action-selector', type: 'engine-config', metadata: { params: { switchCost: 0.15 } } },
        { id: 'persona-prior', type: 'persona.prior',
          metadata: { priors: { 'engine-config-action-selector': { switchCost: 0.30 } }, version: 1, updatedAtTick: 0 } },
      ],
    }), CTX )
    expect( ( res.commands?.set ?? [] ).find( e => e.type === 'agency.intent') ).toBeUndefined()
    expect( metricVal( res, 'agency.selection.preempted') ?? 0 ).toBe( 0 )
  })
})

describe('ActionSelector — shared deliberativeness (R1 Channel A)', () => {
  // The selector and the executive EffortGate are the two consumers of ONE deliberativeness
  // disposition: the persona-prior on engine-config-executive.deliberateThreshold. A lowered
  // threshold (analytical Will) ⇒ deliberate more; a raised one (decisive Will) ⇒ less.
  const personaPrior = ( deliberateThresholdDelta: number ) => ({
    id: 'persona-prior', type: 'persona.prior',
    metadata: { priors: { 'engine-config-executive': { deliberateThreshold: deliberateThresholdDelta } }, version: 1, updatedAtTick: 0 },
  })
  // A clear winner (large margin ⇒ margin gate inert) whose stakes sit just under the base
  // stakes gate (0.60): stakes = |valence|. 0.55 commits at neutral; 0.65 deliberates at neutral.
  const field = ( valence: number, prior?: number ) => makeState({
    entities: [
      aff({ id: 'a1', schema: 'withdraw', expectedReward: 0.9, cost: 0.0, expectedValence: valence }),
      aff({ id: 'a2', schema: 'wait',     expectedReward: 0.1, cost: 0.0 }),
      ...( prior !== undefined ? [ personaPrior( prior ) ] : [] ),
    ],
  })

  it('an analytical Will (developed lower threshold) deliberates where a neutral Will commits', async () => {
    const neutral    = await new ActionSelector().react( 0, 1, field( -0.55 ),        CTX )  // stakes 0.55 < 0.60
    const analytical = await new ActionSelector().react( 0, 1, field( -0.55, -0.25 ), CTX )  // gate lowered to 0.50
    expect( metricVal( neutral,    'agency.selection.deliberate') ).toBe( 0 )
    expect( metricVal( analytical, 'agency.selection.deliberate') ).toBe( 1 )
  })

  it('a decisive Will (developed higher threshold) commits where a neutral Will deliberates', async () => {
    const neutral  = await new ActionSelector().react( 0, 1, field( -0.65 ),       CTX )  // stakes 0.65 > 0.60
    const decisive = await new ActionSelector().react( 0, 1, field( -0.65, 0.25 ), CTX )  // gate raised to 0.70
    expect( metricVal( neutral,  'agency.selection.deliberate') ).toBe( 1 )
    expect( metricVal( decisive, 'agency.selection.deliberate') ).toBe( 0 )
  })

  it('no prior ⇒ base gates unchanged (a newborn Will behaves exactly as before)', async () => {
    const res = await new ActionSelector().react( 0, 1, field( -0.55 ), CTX )
    expect( intentOf( res.commands?.set )?.metadata?.['schema'] ).toBe('withdraw')
    expect( metricVal( res, 'agency.selection.deliberate') ).toBe( 0 )
  })
})

describe('ActionSelector — competition weights develop (Channel A scoring)', () => {
  const selectorConfig = {
    id: 'engine-config-action-selector', type: 'engine-config',
    metadata: { params: { riskWeight: 0.20, noveltyWeight: 0.10 } },
  }
  const selectorPrior = ( params: Record<string, number> ) => ({
    id: 'persona-prior', type: 'persona.prior',
    metadata: { priors: { 'engine-config-action-selector': params }, version: 1, updatedAtTick: 0 },
  })

  it('an open Will (raised novelty weight) picks the untried option a neutral Will skips', async () => {
    // habit-act outscores novel-act at the base novelty weight (0.10); a developed weight
    // (0.50) flips the winner toward the unpracticed.
    const field = ( prior?: { id: string; type: string; metadata?: Record<string, unknown> } ) => makeState({ entities: [
      aff({ id: 'h', schema: 'habit-act', expectedReward: 0.5, habitStrength: 1, cost: 0.0 }),
      aff({ id: 'n', schema: 'novel-act', expectedReward: 0.3, habitStrength: 0, cost: 0.0 }),
      selectorConfig, ...( prior ? [ prior ] : [] ),
    ] })
    const neutral = await new ActionSelector().react( 0, 1, field(), CTX )
    const open    = await new ActionSelector().react( 0, 1, field( selectorPrior({ noveltyWeight: 0.40 }) ), CTX )
    expect( intentOf( neutral.commands?.set )?.metadata?.['schema'] ).toBe('habit-act')
    expect( intentOf( open.commands?.set    )?.metadata?.['schema'] ).toBe('novel-act')
  })

  it('a steadier Will (lowered risk weight) dares the risky-but-rewarding option', async () => {
    // safe-act outscores risky-act at the base risk weight (0.20); a lowered weight (→0)
    // stops the anticipated downside from suppressing the bolder option.
    const field = ( prior?: { id: string; type: string; metadata?: Record<string, unknown> } ) => makeState({ entities: [
      aff({ id: 's', schema: 'safe-act',  expectedReward: 0.5, expectedValence:  0.0, cost: 0.0 }),
      aff({ id: 'r', schema: 'risky-act', expectedReward: 0.7, expectedValence: -0.9, cost: 0.0 }),
      selectorConfig, ...( prior ? [ prior ] : [] ),
    ] })
    const neutral = await new ActionSelector().react( 0, 1, field(), CTX )
    const steady  = await new ActionSelector().react( 0, 1, field( selectorPrior({ riskWeight: -0.20 }) ), CTX )
    expect( intentOf( neutral.commands?.set )?.metadata?.['schema'] ).toBe('safe-act')
    expect( intentOf( steady.commands?.set  )?.metadata?.['schema'] ).toBe('risky-act')
  })
})

describe('ActionSelector — System 2 recruitment', () => {
  it('flags deliberation when the field is flat (high entropy)', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 1, makeState({
      entities: [
        aff({ id: 'a1', schema: 'orient',  expectedReward: 0.3, cost: 0.05 }),
        aff({ id: 'a2', schema: 'attend',  expectedReward: 0.3, cost: 0.05 }),
        aff({ id: 'a3', schema: 'reflect', expectedReward: 0.3, cost: 0.05 }),
        aff({ id: 'a4', schema: 'wait',    expectedReward: 0.3, cost: 0.05 }),
      ],
    }), CTX )
    expect( metricVal( res, 'agency.selection.deliberate') ).toBe( 1 )
  })

  it('routes an ambiguous winner to the Deliberator (status deliberating + candidates)', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 1, makeState({
      entities: [
        aff({ id: 'a1', schema: 'orient',  expectedReward: 0.3, cost: 0.05 }),
        aff({ id: 'a2', schema: 'attend',  expectedReward: 0.3, cost: 0.05 }),
        aff({ id: 'a3', schema: 'reflect', expectedReward: 0.3, cost: 0.05 }),
      ],
    }), CTX )
    const intent = intentOf( res.commands?.set )
    expect( intent?.metadata?.['status'] ).toBe('deliberating')   // not 'selected' — handed to System 2
    expect( Array.isArray( intent?.metadata?.['candidates'] ) ).toBe( true )
    expect( ( intent?.metadata?.['candidates'] as unknown[] ).length ).toBeGreaterThan( 1 )
  })

  it('flags deliberation under high stakes even with a clear winner', async () => {
    const sel = new ActionSelector()
    const res = await sel.react( 0, 1, makeState({
      metrics:  { 'threat.level': 0.8 },
      entities: [
        aff({ id: 'a1', schema: 'withdraw', expectedReward: 0.9, cost: 0.03, tags: [ 'self-protection' ] }),
        aff({ id: 'a2', schema: 'wait',     expectedReward: 0.1, cost: 0.01 }),
      ],
    }), CTX )
    const intent = intentOf( res.commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('withdraw')
    expect( intent?.metadata?.['deliberate'] ).toBe( true )
  })

  it('an overlearned habit raises its own deliberation threshold (the gradient)', async () => {
    const field = ( habit: number ) => makeState({
      metrics:  { 'threat.level': 0.7 },  // stakes = 0.7, base threshold = 0.6 → deliberate unless relieved
      entities: [
        aff({ id: 'a1', schema: 'rest', expectedReward: 0.9, cost: 0.0, habitStrength: habit, tags: [ 'regulatory' ] }),
        aff({ id: 'a2', schema: 'wait', expectedReward: 0.1, cost: 0.01 }),
      ],
    })

    const novice = intentOf( ( await new ActionSelector().react( 0, 1, field( 0.0 ), CTX ) ).commands?.set )
    const expert = intentOf( ( await new ActionSelector().react( 0, 1, field( 0.6 ), CTX ) ).commands?.set )

    expect( novice?.metadata?.['schema'] ).toBe('rest')
    expect( expert?.metadata?.['schema'] ).toBe('rest')
    expect( novice?.metadata?.['deliberate'] ).toBe( true )   // 0.7 > 0.60
    expect( expert?.metadata?.['deliberate'] ).toBe( false )  // 0.7 < 0.60 + 0.6·0.25 = 0.75
  })
})

// ── stage 0 → stage 1 integration ───────────────────────────────────────────

describe('synthesizer → selector', () => {
  it('a salient known mind flows from field to a committed reach-out intent', async () => {
    const synth = new AffordanceSynthesizer()
    const world = makeState({
      metrics:  { 'energy.level': 70 },
      entities: [ {
        id: 'ke-alice', type: 'known-entity',
        metadata: { keid: 'alice', kind: 'sentient', name: 'Alice', familiarity: 0.9, valence: 0.6 },
      } ],
    })

    // Stage 0: synthesize the field, then materialize it as state for stage 1.
    const fieldCmds = ( await synth.react( 0, 1, world, CTX ) ).commands
    const fieldState = makeState({
      tick: 1,
      // rested but lonely — the social drive is what tips a familiar, liked mind
      // past the mild pull of an objectless stance.
      metrics: { 'energy.level': 70, 'drive.social': 0.7 },
      entities: ( fieldCmds?.set ?? [] ).map( e => ({
        id: e.id, type: e.type, metadata: e.metadata as Record<string, unknown>,
      }) ),
    })

    // Stage 1: select.
    const intent = intentOf( ( await new ActionSelector().react( 0, 1, fieldState, CTX ) ).commands?.set )
    expect( intent ).toBeDefined()
    expect( intent?.metadata?.['schema'] ).toBe('reach-out')
    expect( intent?.metadata?.['targetEntityId'] ).toBe('alice')
  })
})

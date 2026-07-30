// ─────────────────────────────────────────────────────────────
// tests/unit/agency.social-prior.test.ts
// ─────────────────────────────────────────────────────────────
// #112 via #113 — what the mind has LEARNED about a person biases acting toward them.
//
// The first attempt at #112 applied a hardcoded 0.75^n damping curve directly in
// scoreAffordance, keyed off a counter the mind could not see. That was the wrong
// layer: `availability`, the thing it imitated, is a harness the mind LEARNS from
// (ReafferenceEngine → noteRefusal → decays back). This is the right one — the term
// is fed by ReputationTracker, which learns from `interaction.occurred`, which only
// began firing once inbound conversation reached social cognition (#113).

import { describe, it, expect } from 'vitest'
import { scoreAffordance, DEFAULT_WEIGHTS, type BiasContext } from '#agency/selection.scoring'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import type { Affordance } from '#agency/types'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

const CTX = {} as unknown as SimulationContext

const NEUTRAL: BiasContext = {
  goalTargets:     new Set(),
  maxGoalPriority: 0,
  drives:          { energy: 0, sleep: 0, stress: 0, social: 0 },
  threat:          0,
  inhibition:      0,
}

const reachOut = ( extra: Partial<Affordance> = {} ): Affordance => ( {
  id: 'a', schema: 'reach-out', source: 'ideomotor', parameters: {},
  targetEntityId: 'fabrice', expectedValence: 0.2, expectedReward: 0.6,
  cost: 0.1, habitStrength: 0, available: true,
  tags: [ 'social', 'communication' ], willBias: 0.75, tick: 1,
  ...extra,
} as Affordance )

function stateWith(
  entities: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>,
  metrics: Record<string, number> = {},
): ReadonlySimulationState {
  const map = new Map<string, unknown>()
  for( const e of entities ) map.set( e.id, { ...e, createdAt: 0, updatedAt: 0 } )
  return { tick: 1, time: 0, entities: map, metrics: new Map( Object.entries( metrics ) ) } as unknown as ReadonlySimulationState
}

const rep = ( keid: string, trustworthiness: number, confidence: number ) => ( {
  id: `rep-${ keid }`, type: 'reputation', metadata: { keid, trustworthiness, confidence },
} )

/** The socialPrior the synthesizer computes for a reach-out at `keid`. */
async function priorFor( state: ReadonlySimulationState ): Promise<number> {
  const res = await new AffordanceSynthesizer().react( 0, 1, state, CTX )
  const aff = ( res.commands?.set ?? [] ).find(
    e => e.type === 'affordance' && ( e.metadata as any )?.schema === 'reach-out'
      && ( e.metadata as any )?.targetEntityId === 'fabrice',
  )
  return ( aff?.metadata as any )?.socialPrior ?? 0
}

describe('socialPrior — learned, not a constant', () => {
  const known = { id: 'ke-f', type: 'known-entity', metadata: { keid: 'fabrice', kind: 'sentient', name: 'Fabrice' } }

  it('is 0 for someone the mind has formed no opinion of', async () => {
    // A mind that knows no one scores exactly as it did before this term existed.
    expect( await priorFor( stateWith([ known ]) ) ).toBe( 0 )
  } )

  it('is negative for someone whose trustworthiness has fallen', async () => {
    expect( await priorFor( stateWith([ known, rep('fabrice', 0.2, 1 ) ]) ) ).toBeLessThan( 0 )
  } )

  it('is positive for someone who has proven reliable', async () => {
    expect( await priorFor( stateWith([ known, rep('fabrice', 0.9, 1 ) ]) ) ).toBeGreaterThan( 0 )
  } )

  it('scales with the confidence of the opinion, not just its content', async () => {
    // An opinion held on two interactions must not push like one held on fifty.
    const tentative = await priorFor( stateWith([ known, rep('fabrice', 0.1, 0.1 ) ]) )
    const settled   = await priorFor( stateWith([ known, rep('fabrice', 0.1, 1.0 ) ]) )
    expect( Math.abs( tentative ) ).toBeLessThan( Math.abs( settled ) )
  } )

  it('reads only the addressee — another person\'s reputation does not leak in', async () => {
    expect( await priorFor( stateWith([ known, rep('someone-else', 0.05, 1 ) ]) ) ).toBe( 0 )
  } )

  it('mood tilts it, but weakly — a bad day is not a verdict on anyone', async () => {
    const low = await priorFor( stateWith( [ known ], { 'affect.valence': -1 } ) )
    expect( low ).toBeLessThan( 0 )
    // Far smaller than a settled negative opinion of the person themselves.
    const opinion = await priorFor( stateWith([ known, rep('fabrice', 0.0, 1 ) ]) )
    expect( Math.abs( low ) ).toBeLessThan( Math.abs( opinion ) )
  } )
} )

describe('socialPrior — effect on the competition', () => {
  const express: Affordance = {
    id: 'r', schema: 'express', source: 'innate', parameters: {},
    expectedValence: 0.1, expectedReward: 0.55, cost: 0.02, habitStrength: 0,
    available: true, tags: [ 'affective', 'expression' ], tick: 1,
  } as Affordance

  it('someone who has stopped engaging makes reaching out lose to staying quiet', () => {
    const quiet = scoreAffordance( express, NEUTRAL )
    expect( scoreAffordance( reachOut(), NEUTRAL ) ).toBeGreaterThan( quiet )
    expect( scoreAffordance( reachOut({ socialPrior: -0.8 }), NEUTRAL ) ).toBeLessThan( quiet )
  } )

  it('is signed — trust pulls toward contact, not merely less away from it', () => {
    const neutral = scoreAffordance( reachOut(), NEUTRAL )
    expect( scoreAffordance( reachOut({ socialPrior:  0.6 }), NEUTRAL ) ).toBeGreaterThan( neutral )
    expect( scoreAffordance( reachOut({ socialPrior: -0.6 }), NEUTRAL ) ).toBeLessThan( neutral )
  } )

  it('a strong goal can still overrule a poor opinion — it biases, it does not decide', () => {
    const bias = { ...NEUTRAL, goalTargets: new Set([ 'fabrice' ]), maxGoalPriority: 1 }
    expect( scoreAffordance( reachOut({ socialPrior: -0.8 }), bias ) )
      .toBeGreaterThan( scoreAffordance( express, bias ) )
  } )

  it('contributes nothing when absent — the quiet path is unchanged', () => {
    const a = reachOut()
    expect( scoreAffordance( { ...a, socialPrior: 0 }, NEUTRAL, DEFAULT_WEIGHTS ) )
      .toBe( scoreAffordance( a, NEUTRAL, DEFAULT_WEIGHTS ) )
  } )
} )

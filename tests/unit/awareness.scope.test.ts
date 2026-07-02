// ─────────────────────────────────────────────────────────────
// tests/unit/awareness.scope.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Per-facet awareness scoping (the prompt-context analogue of `subscribes()`).
 *
 * A facet renders only the cognitive-context sections its creating engine
 * declared via `focus.awareness` (default: DEFAULT_FACET_AWARENESS); master
 * always renders FULL_AWARENESS. Entity-scoped sections (plans) can be filtered
 * to a single requester via `focus.awarenessEntityId`.
 */

import { describe, it, expect } from 'vitest'
import {
  buildUserMessage,
  DEFAULT_FACET_AWARENESS,
  type FocusSection,
  type AwarenessScope,
} from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

// ── Fixtures ──────────────────────────────────────────────────

const plan = ( id: string, entityId?: string ) => ( {
  id, goalId: 'goal-1', status: 'executing', executionTier: 'automatic',
  totalSteps: 4, completedSteps: 1, expectedOutcome: `outcome ${id}`, requestingEntityId: entityId,
} )

function makeContext( over: Partial<ExecutiveContext> = {} ): ExecutiveContext {
  return {
    identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [ { id: 'goal-1', description: 'do the thing', priority: 0.8, progress: 0.25, status: 'active' } ],
    plans: [],
    relevantPlanIds: [],
    percepts: [],
    workingMemory: [],
    memories: [],
    beliefs: [ { statement: 'water is wet', category: 'world_fact', confidence: 0.9 } ],
    beliefsOmitted: 0,
    recentActions: [],
    ...over,
  } as ExecutiveContext
}

function render( focus: Partial<FocusSection>, mode: 'master' | 'facet', ctx = makeContext() ): string {
  return buildUserMessage( {
    context: ctx,
    state: { tick: 5, metrics: new Map(), entities: new Map() } as any,
    qualityModulation: 1,
    epistemicUncertainty: 0.3,
    deps: { summarizer: null },
    focus: { title: 'T', content: 'focus body', ...focus },
    mode,
  } )
}

// ── Tests ─────────────────────────────────────────────────────

describe( 'awareness scoping — buildUserMessage', () => {
  const ctxWithPlan = makeContext( { plans: [ plan( 'plan-1', 'E1' ) ] } )

  it( 'a facet that declares "plans" sees the Active Plans section', () => {
    const out = render( { awareness: [ ...DEFAULT_FACET_AWARENESS, 'plans' ] }, 'facet', ctxWithPlan )
    expect( out ).toContain( '## Active Plans' )
    expect( out ).toContain( 'plan-1' )
  } )

  it( 'a facet with default awareness does NOT see plans, but still sees goals', () => {
    const out = render( {}, 'facet', ctxWithPlan )   // no awareness → DEFAULT_FACET_AWARENESS
    expect( out ).not.toContain( '## Active Plans' )
    expect( out ).toContain( '## Active Goals' )
  } )

  it( 'declaring an explicit scope set drops the defaults not listed', () => {
    const out = render( { awareness: [ 'plans' ] as AwarenessScope[] }, 'facet', ctxWithPlan )
    expect( out ).toContain( '## Active Plans' )
    expect( out ).not.toContain( '## Active Goals' )   // 'goals' not declared
    expect( out ).not.toContain( '## Your Beliefs' )
  } )

  it( 'awarenessEntityId scopes plans to a single requester', () => {
    const ctx = makeContext( { plans: [ plan( 'plan-1', 'E1' ), plan( 'plan-2', 'E2' ) ] } )
    const out = render( { awareness: [ 'plans' ] as AwarenessScope[], awarenessEntityId: 'E1' }, 'facet', ctx )
    expect( out ).toContain( 'plan-1' )
    expect( out ).not.toContain( 'plan-2' )
  } )

  it( 'master mode always renders the full set regardless of focus.awareness', () => {
    const out = render( { awareness: [ 'goals' ] as AwarenessScope[] }, 'master', ctxWithPlan )
    expect( out ).toContain( '## Active Plans' )   // master ignores the manifest
    expect( out ).toContain( '## Active Goals' )
    expect( out ).toContain( '## Your Beliefs' )
  } )

  it( 'default facet awareness still includes goals, beliefs', () => {
    const out = render( {}, 'facet' )
    expect( out ).toContain( '## Active Goals' )
    expect( out ).toContain( '## Your Beliefs' )
  } )
} )

// ── Stage 2: recall-relevance scoping of plans ────────────────

describe( 'awareness scoping — recall-relevance filter (Stage 2)', () => {
  const twoPlans = () => makeContext( {
    plans: [ plan( 'plan-1', 'E1' ), plan( 'plan-2', 'E2' ) ],
    relevantPlanIds: [ 'plan-2' ],
  } )

  it( 'unions the requester’s plans (entityId) with recall-surfaced plans (relevantPlanIds)', () => {
    const out = render( { awareness: [ 'plans' ] as AwarenessScope[], awarenessEntityId: 'E1' }, 'facet', twoPlans() )
    expect( out ).toContain( 'plan-1' )   // E1's own
    expect( out ).toContain( 'plan-2' )   // recall-relevant (E2's), surfaced by relevance
  } )

  it( 'relevance alone scopes plans for a facet with no entityId', () => {
    const out = render( { awareness: [ 'plans' ] as AwarenessScope[] }, 'facet', twoPlans() )
    expect( out ).toContain( 'plan-2' )       // recall-relevant
    expect( out ).not.toContain( 'plan-1' )   // not relevant, no requester scope
  } )

  it( 'master ignores the relevance filter (sees all plans)', () => {
    const out = render( { awareness: [ 'goals' ] as AwarenessScope[] }, 'master', twoPlans() )
    expect( out ).toContain( 'plan-1' )
    expect( out ).toContain( 'plan-2' )
  } )
} )

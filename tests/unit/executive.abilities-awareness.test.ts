// ─────────────────────────────────────────────────────────────
// tests/unit/executive.abilities-awareness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Deliberation-surfacing (Phase 2). The host abilities afforded to the Will
 * *right now* — read from the current `affordance` field (source 'external',
 * available) — are joined into ExecutiveContext.abilities and rendered as
 * "## Abilities Available Now", so System 2 reasons with knowledge of what it
 * can do + what each is for. Framed as self-knowledge, not a tool-call menu:
 * the Will still expresses intent and the agency field enacts the fit. Innate
 * stances (already in the preamble) and unavailable abilities never surface.
 */

import { describe, it, expect } from 'vitest'
import { extractAbilities } from '#faculties/executive.engine/context'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

const affordanceState = () => {
  const entities = new Map<string, any>()
  entities.set('aff-give-ada', { id: 'aff-give-ada', type: 'affordance', metadata: {
    schema: 'give', source: 'external', available: true, description: 'Offer an item to someone present',
    targetEntityId: 'ada', parameters: { targetEntityName: 'Ada' } } } )
  entities.set('aff-forage', { id: 'aff-forage', type: 'affordance', metadata: {
    schema: 'forage', source: 'external', available: true, description: 'Search the area for food' } } )
  // innate stance — already in the preamble, must NOT surface here
  entities.set('aff-rest', { id: 'aff-rest', type: 'affordance', metadata: { schema: 'rest', source: 'innate', available: true } } )
  // unavailable external — filtered out
  entities.set('aff-sprint', { id: 'aff-sprint', type: 'affordance', metadata: { schema: 'sprint', source: 'external', available: false, description: 'x' } } )
  return { tick: 1, entities, metrics: new Map() } as any
}

describe('extractAbilities — afforded host abilities from the field', () => {
  it('surfaces available external abilities with meaning + bound target; skips innate + unavailable', () => {
    const abilities = extractAbilities( affordanceState() )!
    const names = abilities.map( a => a.name )
    expect( names ).toContain('give')
    expect( names ).toContain('forage')
    expect( names ).not.toContain('rest')      // innate — omitted
    expect( names ).not.toContain('sprint')    // unavailable — omitted

    const give = abilities.find( a => a.name === 'give')!
    expect( give.description ).toBe('Offer an item to someone present')
    expect( give.target ).toBe('Ada')          // resolved from parameters.targetEntityName
  } )

  it('returns undefined when no external abilities are afforded', () => {
    expect( extractAbilities( { tick: 1, entities: new Map(), metrics: new Map() } as any ) ).toBeUndefined()
  } )
} )

describe('buildUserMessage — renders the abilities block', () => {
  const baseCtx = (): ExecutiveContext => ( {
    identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [],
  } as ExecutiveContext )

  const render = ( abilities?: ExecutiveContext['abilities'] ): string =>
    buildUserMessage( {
      context: { ...baseCtx(), abilities },
      state: { tick: 5, metrics: new Map(), entities: new Map() } as any,
      qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master',
    } )

  it('renders available abilities with target + meaning', () => {
    const msg = render( [
      { name: 'give', description: 'Offer an item', target: 'Ada' },
      { name: 'forage', description: 'Search for food' },
    ] )
    expect( msg ).toContain('## Abilities Available Now')
    expect( msg ).toContain('**give** (toward Ada) — Offer an item')
    expect( msg ).toContain('**forage** — Search for food')
  } )

  it('omits the block when there are no abilities', () => {
    expect( render() ).not.toContain('## Abilities Available Now')
    expect( render( [] ) ).not.toContain('## Abilities Available Now')
  } )
} )

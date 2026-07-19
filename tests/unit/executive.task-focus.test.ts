// ─────────────────────────────────────────────────────────────
// tests/unit/executive.task-focus.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * task.switcher → executive reasoning (closing the inert-faculty gap). task.switcher
 * tracked a current focus + switch cost that reached nothing. Now the focus + the cost of
 * switching away are surfaced into ExecutiveContext.currentFocus and rendered as
 * "## Task Focus" — so the Will weighs task-persistence, and the pull-to-stay scales with
 * the conscientiousness-developable switch cost (#28).
 */

import { describe, it, expect } from 'vitest'
import { extractCurrentFocus } from '#faculties/executive.engine/context'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

const goals: ExecutiveContext['goals'] = [ { id: 'g1', description: 'finish the report', priority: 0.8, progress: 0.4, status: 'active' } ]

const stateFocusedOn = ( goalId: string | null, focusTicks: number, switchCost: number ) => {
  const entities = new Map<string, any>()
  if( goalId ) entities.set('task-switch-focus', { id: 'task-switch-focus', type: 'task.focus', metadata: { goalId, focusTicks } } )
  const metrics = new Map<string, number>([ [ 'task_switch.switch_cost', switchCost ] ])
  return { tick: 60, entities, metrics } as any
}

describe('extractCurrentFocus — surfaces task.switcher focus', () => {
  it('joins the focus entity to the goal description + switch cost', () => {
    const f = extractCurrentFocus( stateFocusedOn('g1', 12, 0.35 ), goals )!
    expect( f.goalId ).toBe('g1')
    expect( f.goalDescription ).toBe('finish the report')
    expect( f.focusTicks ).toBe( 12 )
    expect( f.switchCost ).toBe( 0.35 )
  } )

  it('is undefined when nothing is in focus', () => {
    expect( extractCurrentFocus( stateFocusedOn( null, 0, 0.3 ), goals ) ).toBeUndefined()
  } )
} )

describe('buildUserMessage — Task Focus block + persistence resistance', () => {
  const render = ( currentFocus?: ExecutiveContext['currentFocus'] ): string =>
    buildUserMessage( {
      context: {
        identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
        worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
        affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
        goals, plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
        beliefs: [], beliefsOmitted: 0, recentActions: [], currentFocus,
      } as ExecutiveContext,
      state: { tick: 5, metrics: new Map(), entities: new Map() } as any,
      qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master',
    } )

  it('renders the focus + a stronger pull-to-stay for a higher (conscientious) switch cost', () => {
    const low  = render( { goalId: 'g1', goalDescription: 'finish the report', focusTicks: 12, switchCost: 0.30 } )
    const high = render( { goalId: 'g1', goalDescription: 'finish the report', focusTicks: 12, switchCost: 0.50 } )
    expect( low ).toContain('## Task Focus')
    expect( low ).toContain('finish the report')
    expect( low ).toContain('some inertia to overcome')
    expect( high ).toContain('a strong pull to see this through')
  } )

  it('omits the block when nothing is in focus', () => {
    expect( render() ).not.toContain('## Task Focus')
  } )
} )

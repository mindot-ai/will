// ─────────────────────────────────────────────────────────────
// tests/unit/recall.budget.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §5.3 — explicit char budget on the "## Relevant Memories" recall block.
 *
 * The recall surface is rendered in the deterministic order set by
 * buildExecutiveContext (semantic matches first, then recent). The renderer
 * adds lines until the next would overflow the budget, then emits an explicit
 * "[+N omitted]" tail — so a long recall set can never crowd out the rest of the
 * prompt, and the model is told the surface was truncated rather than empty.
 */

import { describe, it, expect } from 'vitest'
import { buildUserMessage, type FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

type Memory = ExecutiveContext['memories'][number]

function makeContext( memories: Memory[] ): ExecutiveContext {
  return {
    identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [],
    memories,
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [],
  } as ExecutiveContext
}

function render( memories: Memory[] ): string {
  const focus: Partial<FocusSection> = { title: 'T', content: 'focus body' }
  return buildUserMessage( {
    context: makeContext( memories ),
    state: { tick: 100, metrics: new Map(), entities: new Map() } as any,
    qualityModulation: 1,
    epistemicUncertainty: 0.3,
    deps: { summarizer: null },
    focus: focus as FocusSection,
    mode: 'master',          // FULL_AWARENESS → memories section rendered
  } )
}

/** Slice out just the "## Relevant Memories" section text. */
function memoriesSection( prompt: string ): string {
  const start = prompt.indexOf('## Relevant Memories')
  expect( start ).toBeGreaterThanOrEqual( 0 )
  const rest  = prompt.slice( start )
  const next  = rest.indexOf('\n## ', 1 )
  return next === -1 ? rest : rest.slice( 0, next )
}

const mem = ( content: string, relevance = 0.7, tick = 90 ): Memory =>
  ( { content, relevance, emotionalContext: 'neutral', tick } )

describe('Relevant Memories — char budget (§5.3)', () => {
  it('renders every memory in order when under budget (no omission tail)', () => {
    const memories = [ mem('first thing'), mem('second thing'), mem('third thing') ]
    const section  = memoriesSection( render( memories ) )

    expect( section ).toContain('first thing')
    expect( section ).toContain('second thing')
    expect( section ).toContain('third thing')
    expect( section ).not.toContain('omitted')
    // Order preserved (deterministic recall order — not re-sorted here).
    expect( section.indexOf('first thing') ).toBeLessThan( section.indexOf('second thing') )
    expect( section.indexOf('second thing') ).toBeLessThan( section.indexOf('third thing') )
  } )

  it('truncates an oversized recall set and reports the omitted count', () => {
    // 30 memories × ~200 chars each ≫ 1200-char budget → most are omitted.
    const memories = Array.from( { length: 30 }, ( _v, i ) =>
      mem(`memory-${i} ` + 'x'.repeat( 200 ), 0.5, 90 ) )
    const section  = memoriesSection( render( memories ) )

    // Budget bounds the block — far short of the full 30×~230 chars.
    expect( section.length ).toBeLessThan( 1700 )
    // Highest-priority (first) memories survive; later ones are dropped.
    expect( section ).toContain('memory-0')
    expect( section ).not.toContain('memory-29')

    // The omission tail names a positive count and the full store is intact.
    const tailMatch = section.match( /\[\+(\d+) omitted/ )
    expect( tailMatch ).not.toBeNull()
    const omitted = Number( tailMatch![1] )
    expect( omitted ).toBeGreaterThan( 0 )

    // Rendered + omitted must account for the whole set.
    const rendered = ( section.match( /- memory-/g ) ?? [] ).length
    expect( rendered + omitted ).toBe( 30 )
  } )

  it('always keeps the first memory even when it alone exceeds the budget', () => {
    const huge     = mem('huge ' + 'y'.repeat( 4000 ), 0.9 )
    const section  = memoriesSection( render( [ huge, mem('tiny tail', 0.1 ) ] ) )

    expect( section ).toContain('huge')
    // The single huge line consumed the budget — the second is omitted.
    expect( section ).toContain('[+1 omitted')
    expect( section ).not.toContain('tiny tail')
  } )

  it('renders the empty-state line when there are no memories', () => {
    const section = memoriesSection( render( [] ) )
    expect( section ).toContain('No relevant memories')
    expect( section ).not.toContain('omitted')
  } )
} )

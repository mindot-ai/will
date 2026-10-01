// ─────────────────────────────────────────────────────────────
// tests/unit/recall.budget.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * "## Relevant Memories" — every recalled memory, whole, in recall order.
 *
 * The block had its own 1,200-character budget (§5.3): it stopped at the first
 * line that would overflow it, and said "[+N omitted]". Once a remembered
 * observation carries its data that line is the first one, and every memory after
 * it was hidden. What bounds a call now is the call's own budget against its
 * window (LOSSLESS P5a): a large memory is a document — its handle and size —
 * never a reason to hide the ones after it. How MANY are recalled is P5c.
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

describe('Relevant Memories — whole, in recall order', () => {
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

  it('renders every memory recalled, whole — 30 lines of ~200 characters, none omitted', () => {
    const memories = Array.from( { length: 30 }, ( _v, i ) =>
      mem(`memory-${i} ` + 'x'.repeat( 200 ), 0.5, 90 ) )
    const section  = memoriesSection( render( memories ) )
    expect( ( section.match( /- memory-\d+ x{200} /g ) ?? [] ) ).toHaveLength( 30 )
    expect( section ).not.toContain('omitted')
  } )

  it('a long memory does not hide the ones after it', () => {
    const huge     = mem('huge ' + 'y'.repeat( 4000 ), 0.9 )
    const section  = memoriesSection( render( [ huge, mem('tiny tail', 0.1 ) ] ) )
    expect( section ).toContain('huge ' + 'y'.repeat( 4000 ) )
    expect( section ).toContain('tiny tail')
  } )

  it('renders the empty-state line when there are no memories', () => {
    const section = memoriesSection( render( [] ) )
    expect( section ).toContain('No relevant memories')
    expect( section ).not.toContain('omitted')
  } )
} )

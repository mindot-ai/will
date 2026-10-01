// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p5b.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P5b — no single thing she is shown is cut.
 *
 * P5a made every call fit its window, so a cut is no longer what keeps a call
 * small: an item too big for a page is paged, not shortened. What was left were
 * fixed-length cuts of single items, each measured on Lora's recorded prompts:
 *
 * - `## Memory Continuity` at 1,200 characters, marked "[...summarized]": the
 *   summarizer writes 150–250 words, so all 731 prompts that had it were cut,
 *   and the cut took the paragraph's end — what she had noticed about herself.
 * - A plan's expected outcome at 80 — the line she judges the plan by. Her three
 *   plans ran 140–205; all 843 lines were cut.
 * - A held item's label at 120, a remembered one's at 200, when it had no words
 *   of its own.
 * - A host's own `summary` at 100, as if the engine had written it — and the
 *   data beneath leaves `summary` out, so the rest was read nowhere. And a
 *   percept's id hashed that cut label, so two different answers that began
 *   alike were one percept: the second overwrote the first.
 */

import { describe, it, expect } from 'vitest'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { buildExecutiveContext } from '#faculties/executive.engine/context'
import { SomatosensationEngine } from '#senses/somatosensation.engine'
import { ExecutiveSummarizer } from '#llm/summarizer'
import { PERCEPT_SUMMARY_CAP } from '#cognition/percept.entity'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

const NONE = { workingMemory: null, goalManager: null, episodicConsolidator: null, semanticIntegrator: null }

describe('Memory Continuity is the paragraph the summarizer wrote, whole', () => {
  it('a 230-word summary renders whole — not cut at 1,200 and called "summarized"', () => {
    const paragraph = 'I spent the morning on the payments migration and kept the review moving. '.repeat( 20 )
      + 'What I noticed about myself: I reach for reassurance before I have checked the facts.'
    expect( paragraph.length ).toBeGreaterThan( 1_200 )
    const summarizer = new ExecutiveSummarizer()
    summarizer.restore( paragraph, [], 10 )
    const prompt = render( {}, { summarizer } )
    expect( prompt ).toContain(`## Memory Continuity\n${ paragraph }`)
    expect( prompt ).not.toContain('[...summarized]')
  } )
} )

describe('a plan shows the outcome she judges it by, whole', () => {
  it('from the plan entity to the prompt', async () => {
    const outcome = 'FKEM can post in #general again, the ban log records who lifted it and why, '
      + 'and no other member was affected — checked by reading the audit log after the unban.'
    expect( outcome.length ).toBeGreaterThan( 80 )
    const state = { tick: 9, metrics: new Map(), entities: new Map( [ [ 'plan-1', { id: 'plan-1', type: 'plan',
      metadata: { goalId: 'goal-1', status: 'active', executionTier: 'deliberate', steps: [ {}, {} ], expectedOutcome: outcome } } ] ] ) }
    const context = await buildExecutiveContext( state as never, NONE )
    expect( render( context ) ).toContain(`2 steps (deliberate) — "${ outcome }"`)
  } )
} )

describe('a held or remembered item without words of its own is shown whole', () => {
  it('working memory: a string, and an object with no summary — its data beneath, once', async () => {
    // No writer today puts these in working memory (it admits percepts, which have a
    // label); the fallbacks are the defence, and they cut.
    const thought = 'The unban request came from a moderator, not from FKEM — '.repeat( 4 )
    const wm = { getItems: () => [
      { type: 'thought', content: thought, activation: 0.7 },
      { type: 'note', content: { topic: 'payments', owner: 'ada', data: { open: 2 } }, activation: 0.6 },
    ] }
    const context = await buildExecutiveContext( { tick: 9, metrics: new Map(), entities: new Map() } as never,
      { ...NONE, workingMemory: wm as never } )
    const prompt = render( context )
    expect( prompt ).toContain(`- [thought] ${ thought } (activation: 0.70)`)
    expect( prompt ).toContain('- [note] {"topic":"payments","owner":"ada"} (activation: 0.60)\n    {"open":2}')
  } )

  it('a remembered episode of a shape recall does not know is itself, whole — not 200 characters of it', async () => {
    const content = { kind: 'handover', from: 'ada', notes: 'Ledger writer moves behind schema review; '.repeat( 8 ) }
    const consolidator = { semanticQuery: async () => [ { id: 'episodic-3-0', timestamp: 3, activationStrength: 0.6,
      sourceType: 'note', emotionalTags: {}, content } ], query: () => [], markRetrieved(){} }
    const context = await buildExecutiveContext( { tick: 9, metrics: new Map(), entities: new Map() } as never,
      { ...NONE, episodicConsolidator: consolidator as never } )
    expect( render( context ) ).toContain(`- ${ JSON.stringify( content ) } (relevance: 0.60`)
  } )
} )

describe('a host\'s own words reach her whole', () => {
  it('a summary longer than the engine\'s label budget is in the prompt whole', async () => {
    const summary = 'I looked into #payments-migration: it is for: tracking the ledger move, the schema review '
      + 'and the cut-over plan; it sits under #engineering; 47 people are in it.'
    expect( summary.length ).toBeGreaterThan( PERCEPT_SUMMARY_CAP )
    const state = await sensed( [ { signal: 'discord_inspect_channel', data: { summary, memberCount: 47 }, intent: 'i-1' } ] )
    const prompt = render( await buildExecutiveContext( state as never, NONE ) )
    expect( prompt ).toContain(`- [somatosensation] ${ summary } (salience:`)
  } )

  it('a long answer is labelled by what was done — the whole of it beneath', async () => {
    const answer = JSON.stringify( Array.from( { length: 40 }, ( _, i ) => ( { number: 400 + i, state: 'open' } ) ) )
    const state = await sensed( [ { signal: 'list_pull_requests', data: answer, intent: 'i-1' } ] )
    const prompt = render( await buildExecutiveContext( state as never, NONE ) )
    expect( prompt ).toMatch( /- \[somatosensation\] list_pull_requests: \[\{"number":400,"state":"open"\}.*… \(salience: 0\.75\)\n {4}\[\{"number":400/ )
    expect( prompt ).toContain( answer )
  } )
} )

describe('two answers are two percepts, even when their labels match', () => {
  it('two acts of one tool on one tick, answers alike for the first hundred characters', async () => {
    const page = ( n: number ) => JSON.stringify( Array.from( { length: 20 }, () => ( { state: 'open', repo: 'mindot-ai/will' } ) ) ) + `#${ n }`
    const state = await sensed( [
      { signal: 'list_pull_requests', data: page( 1 ), intent: 'i-1' },
      { signal: 'list_pull_requests', data: page( 2 ), intent: 'i-2' },
    ] )
    const percepts = [ ...state.entities.values() ].filter( e => e.type === 'percept')
    expect( percepts.map( p => p.metadata['sourceIntentId'] ).sort() ).toEqual( [ 'i-1', 'i-2' ] )
    expect( percepts.map( p => p.metadata['data'] ).sort() ).toEqual( [ page( 1 ), page( 2 ) ] )
  } )

  it('two events from the world on one tick, alike for the first hundred characters', async () => {
    const push = ( sha: string ) => JSON.stringify( { ref: 'refs/heads/main', repository: 'mindot-ai/will', pusher: 'ada',
      message: 'Move the ledger writer behind the schema review', head: sha } )
    const state = await sensed( [ { signal: 'github', data: push( 'a1f3' ) }, { signal: 'github', data: push( 'b2e4' ) } ] )
    const percepts = [ ...state.entities.values() ].filter( e => e.type === 'percept')
    expect( percepts.map( p => p.metadata['data'] ).sort() ).toEqual( [ push( 'a1f3' ), push( 'b2e4' ) ] )
  } )

  it('two acts that each said the same thing are each answered', async () => {
    const state = await sensed( [
      { signal: 'add_label', data: 'Done (no output).', intent: 'i-1' },
      { signal: 'add_label', data: 'Done (no output).', intent: 'i-2' },
    ] )
    expect( [ ...state.entities.values() ].filter( e => e.type === 'percept') ).toHaveLength( 2 )
  } )

  it('the same signal twice on one tick is still one percept', async () => {
    const wake = { signal: 'WAKE', data: { summary: 'I was offline for 3 hours.' } }
    const state = await sensed( [ wake, wake ] )
    expect( [ ...state.entities.values() ].filter( e => e.type === 'percept') ).toHaveLength( 1 )
  } )
} )

// ── helpers ──────────────────────────────────────────────────

type Entity = { id: string; type: string; metadata: Record<string, unknown> }

/** Signals through the real sense, laid down in state as the trace writes them. */
async function sensed( signals: Array<{ signal: string; data: unknown; intent?: string }> ){
  const entities = new Map<string, Entity>()
  const sense = new SomatosensationEngine()
  sense.attachPerceptTrace( e => entities.set( ( e as Entity ).id, e as Entity ), () => 9 )
  for( const s of signals )
    await sense.sense( { kind: 'system', signal: s.signal, data: s.data,
      provenance: s.intent ? 'reafferent' : 'exafferent', ...( s.intent ? { sourceIntentId: s.intent } : {} ) } )
  return { tick: 9, metrics: new Map(), entities }
}

function render( parts: Partial<ExecutiveContext>, deps: Record<string, unknown> = { summarizer: null } ): string {
  const context = { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [], ...parts } as unknown as ExecutiveContext
  return buildUserMessage( { context, state: { tick: 9, metrics: new Map(), entities: new Map() } as never,
    qualityModulation: 1, epistemicUncertainty: 0.3, deps, focus: { title: 'T', content: 'c' }, mode: 'master' } as never )
}

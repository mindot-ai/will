// ─────────────────────────────────────────────────────────────
// tests/unit/executive.ideation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Ideation data + prompt layer for the deliberate (System 2) path — increment 2a.
 *
 * The propose pass emits a divergent candidate set (`parseIdeation`); the decision
 * pass receives those candidates injected into its user message
 * (`buildUserMessage({ ideationCandidates })`) and is told to weigh them, then commit.
 * All pure — no LLM, no engine wiring yet (that is increment 2b).
 */

import { describe, it, expect } from 'vitest'
import { parseIdeation } from '#faculties/executive.engine/parser'
import { buildUserMessage, PromptFactory } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext, IdeationCandidate } from '#faculties/executive.engine/types'

// ── Fixtures ──────────────────────────────────────────────────

const candidate = ( over: Partial<IdeationCandidate> = {} ): IdeationCandidate => ( {
  approach: 'ask', description: 'ask a clarifying question', upside: 'avoids wrong assumptions', risk: 'adds a turn', ...over,
} )

function makeContext(): ExecutiveContext {
  return {
    identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [],
  } as ExecutiveContext
}

const render = ( ideationCandidates?: IdeationCandidate[] ): string =>
  buildUserMessage( {
    context: makeContext(),
    state: { tick: 5, metrics: new Map(), entities: new Map() } as any,
    qualityModulation: 1,
    epistemicUncertainty: 0.3,
    deps: { summarizer: null },
    focus: { title: 'T', content: 'focus body' },
    mode: 'master',
    ideationCandidates,
  } )

// ── parseIdeation ─────────────────────────────────────────────

describe( 'parseIdeation — the propose pass', () => {
  it( 'parses a fenced ```json candidate block', () => {
    const text = 'Here are options:\n```json\n{"candidates":[{"approach":"ask","description":"d","upside":"u","risk":"r"}]}\n```'
    const out = parseIdeation( text )
    expect( out.candidates ).toHaveLength( 1 )
    expect( out.candidates[0] ).toEqual( { approach: 'ask', description: 'd', upside: 'u', risk: 'r' } )
  } )

  it( 'parses raw JSON without a code fence', () => {
    const out = parseIdeation( '{"candidates":[{"approach":"a","description":"d","upside":"u","risk":"r"},{"approach":"b","description":"d2","upside":"u2","risk":"r2"}]}' )
    expect( out.candidates ).toHaveLength( 2 )
  } )

  it( 'recovers the array via balanced-bracket extraction around messy surrounding text', () => {
    const text = 'preamble {"candidates": [{"approach":"x","description":"has a } brace in it","upside":"u","risk":"r"}]} trailing noise'
    const out = parseIdeation( text )
    expect( out.candidates ).toHaveLength( 1 )
    expect( out.candidates[0]!.description ).toContain( '}' )
  } )

  it( 'coerces missing fields to empty strings and drops wholly-empty entries', () => {
    const out = parseIdeation( '{"candidates":[{"approach":"a"},{},{"description":"d"}]}' )
    expect( out.candidates ).toHaveLength( 2 )           // the empty {} is dropped
    expect( out.candidates[0]!.upside ).toBe( '' )
  } )

  it( 'degrades to an empty set on un-parseable garbage (never throws)', () => {
    expect( parseIdeation( 'no json here at all' ) ).toEqual( { candidates: [] } )
  } )
} )

// ── Ideation format instruction ───────────────────────────────

describe( 'buildIdeationFormatInstruction', () => {
  it( 'asks to PROPOSE a divergent candidate set (not decide)', () => {
    const inst = PromptFactory.buildIdeationFormatInstruction()
    expect( inst ).toContain( '"candidates"' )
    expect( inst ).toMatch( /PROPOSE|Diverge|distinct/ )
    expect( inst ).not.toContain( '"actions"' )         // ideation must not ask for committed actions
  } )
} )

// ── Candidate injection into the decision pass ────────────────

describe( 'buildUserMessage — ideation candidate injection (decision pass)', () => {
  it( 'renders the candidate set when present', () => {
    const msg = render( [ candidate( { approach: 'ask' } ), candidate( { approach: 'proceed', description: 'act on best guess' } ) ] )
    expect( msg ).toContain( '## Candidate Approaches' )
    expect( msg ).toContain( 'ask' )
    expect( msg ).toContain( 'act on best guess' )
    expect( msg ).toMatch( /why I rejected the others/ )
  } )

  it( 'omits the section entirely on the System 1 path (no candidates)', () => {
    expect( render() ).not.toContain( '## Candidate Approaches' )
    expect( render( [] ) ).not.toContain( '## Candidate Approaches' )
  } )
} )

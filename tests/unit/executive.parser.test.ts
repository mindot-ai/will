// ─────────────────────────────────────────────────────────────
// tests/unit/executive.parser.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for executive tagged-block JSON parsing (FN10).
 *
 * Regression target: parseJsonBlock() unconditionally ran a destructive
 * un-escape (\" → ", \\n → literal newline, \\ → \) before JSON.parse. When the
 * LLM emitted *correctly-escaped* JSON (the common case), that mangled it, the
 * parse threw, and the catch silently returned null — dropping PLANS / BELIEFS /
 * GOALS / NARRATIVE / IDENTITY / EFFECTORS / SELF_OBS intermittently, depending
 * on whether the content happened to contain escapable characters.
 *
 * The fix is parse-then-repair: try the block verbatim first, only fall back to
 * the un-escape repair when the verbatim parse fails.
 */

import { describe, it, expect } from 'vitest'
import { parseResponse } from '#faculties/executive.engine/parser'
import type { ReadonlySimulationState } from '#core/types'

function emptyState(): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState
}

// A valid actions payload followed by tagged blocks of *correctly-escaped* JSON.
// The embedded \" and \n are proper JSON escapes — verbatim-parseable, but the
// old destructive un-escape turned them into raw quotes/newlines and broke them.
const RESPONSE_WITH_ESCAPES = `{"actions":[{"type":"observe","reasoning":"watch","expectedOutcome":"learn"}],"confidence":0.7}

[NARRATIVE]
{"narrative":"He said \\"hello\\" to me.\\nThen left.","currentSelfView":"calm"}
[/NARRATIVE]

[BELIEFS]
{"newBeliefs":[{"statement":"Quotes like \\"this\\" are fine","category":"world","confidence":0.8,"evidence":"single_observation","tags":["t"]}]}
[/BELIEFS]

[SELF_OBS]
{"selfObservations":["I notice I said \\"hi\\" twice"]}
[/SELF_OBS]`

describe('executive parser — non-destructive tagged-block JSON (FN10)', () => {
  it('keeps blocks whose valid JSON contains escaped quotes/newlines', () => {
    const out = parseResponse( RESPONSE_WITH_ESCAPES, emptyState(), [] )

    // Actions still parse (Strategy 2 balanced-array extractor).
    expect( out.actions[0]!.type ).toBe('observe')
    expect( out.confidence ).toBe( 0.7 )

    // NARRATIVE survives — the old un-escape would have produced raw quotes
    // (`He said "hello"...`) → invalid JSON → dropped block.
    expect( out.narrative ).toBe('He said "hello" to me.\nThen left.')
    expect( out.currentSelfView ).toBe('calm')

    // BELIEFS survives with its escaped quote intact.
    expect( out.newBeliefs ).toHaveLength( 1 )
    expect( out.newBeliefs![0]!.statement ).toBe('Quotes like "this" are fine')

    // SELF_OBS survives.
    expect( out.selfObservations ).toEqual( [ 'I notice I said "hi" twice' ] )
  })

  it('parses a [KNOWN_ENTITIES] block into knownEntityUpdates (Phase 2.2)', () => {
    const response = `{"actions":[{"type":"observe","reasoning":"r","expectedOutcome":"o"}],"confidence":0.6}

[KNOWN_ENTITIES]
{"knownEntityUpdates":[{"keid":"web:42","name":"Mara","learned":["studies coral reefs"],"feeling":0.3}]}
[/KNOWN_ENTITIES]`
    const out = parseResponse( response, emptyState(), [] )
    expect( out.knownEntityUpdates ).toHaveLength( 1 )
    expect( out.knownEntityUpdates![0]!.keid ).toBe('web:42')
    expect( out.knownEntityUpdates![0]!.name ).toBe('Mara')
    expect( out.knownEntityUpdates![0]!.learned ).toEqual( [ 'studies coral reefs' ] )
  })

  it('still parses plain (non-escaped) JSON blocks', () => {
    const response = `{"actions":[{"type":"reflect","reasoning":"r","expectedOutcome":"o"}],"confidence":0.5}

[GOALS_NEW]
{"newGoals":[{"description":"rest more","priority":3,"tags":["health"],"completionType":"open"}]}
[/GOALS_NEW]`

    const out = parseResponse( response, emptyState(), [] )
    expect( out.newGoals ).toHaveLength( 1 )
    expect( out.newGoals![0]!.description ).toBe('rest more')
  })

  it('falls back to the repair pass for a double-escaped block', () => {
    // Here the block is NOT verbatim-parseable (`{\"k\": ...}`); the repair
    // pass un-escapes it. Proves the fallback is retained, not removed.
    const response = `{"actions":[{"type":"observe","reasoning":"r","expectedOutcome":"o"}],"confidence":0.5}

[NARRATIVE]
{\\"narrative\\": \\"recovered via repair\\"}
[/NARRATIVE]`

    const out = parseResponse( response, emptyState(), [] )
    expect( out.narrative ).toBe('recovered via repair')
  })

  it('drops an unparseable optional block without affecting actions', () => {
    const response = `{"actions":[{"type":"observe","reasoning":"r","expectedOutcome":"o"}],"confidence":0.5}

[BELIEFS]
this is not json at all {{{
[/BELIEFS]`

    const out = parseResponse( response, emptyState(), [] )
    expect( out.actions[0]!.type ).toBe('observe')
    expect( out.newBeliefs ).toBeUndefined()
  })
})

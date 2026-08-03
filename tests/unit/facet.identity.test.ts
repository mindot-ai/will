// ─────────────────────────────────────────────────────────────
// tests/unit/facet.identity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A facet is the same person attending to one thing — never a subordinate
 * instance of a separate consciousness.
 *
 * Master/facet is how the CONTAINER divides attention. Telling the tenant about
 * it was not merely untrue, it was operationally expensive, and both costs were
 * observed on a live Will:
 *
 *   1. STANCE. Told it was "a facet of X" whose "master consciousness runs in
 *      parallel", the mind built — its own words — "an entire operational stance
 *      around being subordinate: waiting for direction, asking permission".
 *
 *   2. A SECOND PARTY IT COULD ADDRESS. Once "the master" existed as someone
 *      else, the facet addressed it — and a conversation facet's only outbound
 *      channel is the reply to the human. Its operator received, verbatim:
 *          "Will — I need to stop. I've now reached out to Fabrice four times..."
 *          "Will here. Am I Lora or am I you?"
 *
 * So the facet prompt names no architecture at all, and the block carrying the
 * wider reasoning is written in the first person.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PromptFactory, type FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

const context = ( name: string ): ExecutiveContext => ( {
  identity: {
    name,
    prompt: `I am ${name}, COO of Mindot.`,
    values: [ 'candour' ],
    traits: { openness: 0.7 },
    style:  'terse',
  },
  goals: [], beliefs: [], memories: [], workingMemory: [], percepts: [],
  affect: { dominantEmotion: 'neutral', valence: 0, arousal: 0.5, dominance: 0.5, blends: [] },
} as unknown as ExecutiveContext )

const focus = ( over: Partial<FocusSection> = {} ): FocusSection => ( {
  title: 'Active Conversation', content: 'Speaker: Fabrice', function: 'conversation', ...over,
} as FocusSection )

const build = ( mode: 'master' | 'facet', name = 'Lora' ): string =>
  PromptFactory.buildSystemPrompt( { context: context( name ), focus: focus(), deps: {} as never, mode } )

describe('a facet is told who it is, not what it runs on', () => {
  it('says the mind\'s own name and what it is attending to', () => {
    const p = build('facet')
    expect( p ).toContain('I am Lora.')
    expect( p ).toContain('Active Conversation')
  } )

  it('never names the architecture that spawned it', () => {
    const p = build('facet').toLowerCase()
    // Each of these was in the old prompt, and each is a fact about the container.
    for( const leak of [ 'facet of', 'master consciousness', 'the master', 'syncs back', 'subordinate' ] )
      expect( p, `facet prompt must not contain "${leak}"` ).not.toContain( leak )
  } )

  it('emits no Consciousness Architecture section at all for a facet', () => {
    // Not "an empty one" — an empty section under a heading reads as a section
    // the mind failed to fill in, which is its own kind of confusing.
    expect( build('facet') ).not.toContain('## Consciousness Architecture')
    expect( build('master') ).toContain('## Consciousness Architecture')
  } )

  it('still grounds the MASTER in the architecture — it is the seat that coordinates', () => {
    const p = build('master')
    expect( p ).toContain('unified cognitive core of Lora')
    expect( p ).toContain('Focused facets may run simultaneously')
  } )
} )

describe('a nameless mind is nameless, in every mode', () => {
  it('claims no name rather than borrowing the platform\'s', () => {
    for( const mode of [ 'master', 'facet' ] as const ){
      const p = build( mode, '')
      expect( p ).not.toMatch( /\bI am Will\b/ )
      expect( p ).not.toMatch( /facet of Will/ )
    }
  } )

  it('degrades to a clause that reads properly, not a dangling "I am ."', () => {
    expect( build('facet', '') ).not.toContain('I am .')
    expect( build('facet', '') ).toContain('Right now my whole attention is on')
  } )
} )

describe('the wider reasoning reaches a facet in the first person', () => {
  const facetSrc = readFileSync(
    join( process.cwd(), 'src/cognition/faculties/executive.engine/facet.ts'), 'utf8')
  /**
   * Comments stripped: the prose above these lines legitimately quotes the old
   * headings while explaining why they are gone, and would fail the assertions
   * that the headings are absent.
   */
  const rendered = facetSrc
    .replace( /\/\*[\s\S]*?\*\//g, '')
    .replace( /(^|[^:])\/\/[^\n]*/g, '$1')

  it('labels the block as the mind\'s own thinking, not a report from a superior', () => {
    expect( rendered ).toContain("## What I've Been Turning Over")
    expect( rendered ).not.toContain('## Master Consciousness Updates')
  } )

  it('stamps each entry with a tick alone — no "Master sync" prefix to address', () => {
    const entry = facetSrc.match( /_masterSyncHistory\.push\(`([^`]*)`/ )?.[1] ?? ''
    expect( entry ).toMatch( /^\[tick \$\{/ )
    expect( entry.toLowerCase() ).not.toContain('master')
  } )

  it('names the facet\'s own carried reasoning without calling it a facet', () => {
    expect( rendered ).toContain('## Where My Thinking Had Got To')
    expect( rendered ).not.toContain('(this facet)')
  } )
} )

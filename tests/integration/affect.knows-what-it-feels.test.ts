// ─────────────────────────────────────────────────────────────
// tests/integration/affect.knows-what-it-feels.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Being told what you feel.
 *
 * `context.ts` read `state.entities.get('affective-state')` for the non-numeric
 * side of affect. `AffectiveBlender` writes `affect-blends`. Nothing has ever
 * written `affective-state` — it appears in exactly one place in the tree, the
 * read — so `dominantEmotion` took its `?? 'neutral'` fallback in every prompt
 * ever rendered. The blender also never put `dominantEmotion` on the entity at
 * all; it went to the metrics map as a numeric code, and a prompt cannot say
 * "I feel 20".
 *
 * Measured on a live COO at tick 10213:
 *
 *   frustration      1.000
 *   boredom          1.000
 *   irritability     0.667
 *   ...
 *   affect.dominant_emotion = 10   (frustration)
 *
 * and her prompt said: "Dominant emotion: neutral".
 *
 * A mind saturated on frustration and boredom, told it feels neutral, has no
 * representation with which to act on either.
 *
 * The id is now a shared constant. Two string literals in two files cannot
 * disagree if there is only one.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState } from '#core/types'
import { AFFECT_STATE_ID, AFFECT_STATE_TYPE } from '#faculties/affective.blender'
import { buildExecutiveContext } from '#faculties/executive.engine/context'

const DEPS = {
  workingMemory:      { getItems: () => [] },
  goalManager:        { getActiveGoals: () => [] },
  semanticIntegrator: { getBeliefs: () => [] },
} as never
const FOCUS = { title: '', content: '' } as never

function stateWith( metadata: Record<string, unknown> | null ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  if( metadata )
    entities.set( AFFECT_STATE_ID, {
      id: AFFECT_STATE_ID, type: AFFECT_STATE_TYPE, createdAt: 0, updatedAt: 0, metadata })
  return {
    tick: 10213, time: 0, entities,
    metrics: new Map<string, number>([
      [ 'affect.valence', -0.099 ], [ 'affect.arousal', 0.365 ], [ 'affect.dominance', 0 ],
      [ 'energy.level', 92 ],
    ]),
  } as unknown as ReadonlySimulationState
}

describe('what the mind is told it feels', () => {
  it('reaches the context — the live frustration case', async () => {
    const ctx = await buildExecutiveContext(
      stateWith({ dominantEmotion: 'frustration', blends: [] }), DEPS )

    expect( ctx.affect.dominantEmotion, 'it said "neutral" while saturated on frustration')
      .toBe('frustration')
  })

  it('and reaches the PROMPT, which is the only place it matters', async () => {
    const { PromptFactory } = await import('#faculties/executive.engine/prompt.factory')
    const state   = stateWith({ dominantEmotion: 'frustration', blends: [] })
    const context = await buildExecutiveContext( state, DEPS )
    const prompt  = PromptFactory.buildUserMessage({ state, context, deps: DEPS, focus: FOCUS } as never )

    expect( prompt ).toContain('Dominant emotion: frustration')
    expect( prompt ).not.toContain('Dominant emotion: neutral')
  })

  it('carries blends through when the blender detects any', async () => {
    const ctx = await buildExecutiveContext(
      stateWith({ dominantEmotion: 'joy', blends: [ 'bittersweet' ] }), DEPS )
    expect( ctx.affect.blends ).toEqual( [ 'bittersweet' ] )
  })

  it('still says neutral when there is genuinely nothing to report', async () => {
    // The fallback is correct for a mind that has not felt anything yet — it was
    // only wrong as the ALWAYS case.
    const ctx = await buildExecutiveContext( stateWith( null ), DEPS )
    expect( ctx.affect.dominantEmotion ).toBe('neutral')
    expect( ctx.affect.blends ).toEqual( [] )
  })

  it('the numeric core still comes from metrics, unchanged', async () => {
    const ctx = await buildExecutiveContext(
      stateWith({ dominantEmotion: 'boredom', blends: [] }), DEPS )
    expect( ctx.affect.valence ).toBeCloseTo( -0.099, 6 )
    expect( ctx.affect.arousal ).toBeCloseTo( 0.365, 6 )
  })
})

describe('the writer and the reader agree by construction', () => {
  it('the blender writes the id the context reads', async () => {
    // The whole defect in one assertion. Before this, the writer said
    // 'affect-blends' and the reader said 'affective-state', and nothing failed.
    const { AffectiveBlender } = await import('#faculties/affective.blender')
    const blender = new AffectiveBlender()
    const res = await blender.react( 0, 1 as never, stateWith( null ), {} as never )

    const written = ( res.commands?.set ?? [] ).find( e => e.type === AFFECT_STATE_TYPE )
    expect( written, 'the blender must write the affect entity every tick').toBeDefined()
    expect( written!.id ).toBe( AFFECT_STATE_ID )
    expect( written!.metadata, 'dominantEmotion was never on the entity — only the numeric code, in metrics')
      .toHaveProperty('dominantEmotion')
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/forgetting.curve.immutable.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for ForgettingCurve no longer mutating shared state (FN8).
 *
 * Regression target: react() wrote `episode.activationStrength = …` straight
 * onto the live objects returned by the consolidator's getAllEpisodes(), during
 * its own read phase. Those references may already be held by other engines
 * this tick, so the in-place write mutated shared state out of band — bypassing
 * the command pipeline and the double-buffer commit, and unsafe under the
 * optimistic-concurrency (AsyncEngine) path. The fix computes decay purely and
 * commits it through EpisodicConsolidator.applyDecay(), which replaces changed
 * episodes with updated copies (single writer, no reach-in).
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { ForgettingCurve } from '#faculties/forgetting.curve'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState } from '#core/types'

function makeEpisode( id: string, activationStrength: number ): EpisodicMemory {
  return {
    id,
    timestamp: 0,
    content: {},
    emotionalTags: {},
    affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength,
    retrievalCount: 0,
    lastRetrievedAt: null,
    tags: [],
    sourceType: 'percept',
    createdAt: 0,
  }
}

function emptyState(): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState
}

const ctx = createContext( 'sim', 'run', 42 )

describe( 'ForgettingCurve — no shared-state mutation (FN8)', () => {
  it( 'does not mutate the live episode objects in place', async () => {
    const consolidator = new EpisodicConsolidator({ autoIndex: false })
    const curve = new ForgettingCurve({ pruningThreshold: 0 })  // never prune here
    curve.attachConsolidator( consolidator )
    consolidator.restoreEpisodes([ makeEpisode( 'a', 0.8 ), makeEpisode( 'b', 0.6 ) ])

    // Freeze the references the curve borrows: the OLD code's in-place write
    // would throw a TypeError on a frozen object.
    const handedOut = consolidator.getAllEpisodes()
    handedOut.forEach( Object.freeze )
    const refA = handedOut[0]!

    await expect( curve.react( 1000, 1, emptyState(), ctx ) ).resolves.toBeDefined()

    // The reference handed out earlier is untouched…
    expect( refA.activationStrength ).toBe( 0.8 )
    // …while the consolidator now reports the decayed value via a fresh object.
    const after = consolidator.getAllEpisodes()
    expect( after[0]!.id ).toBe( 'a' )
    expect( after[0]!.activationStrength ).toBeLessThan( 0.8 )
    expect( after[0] ).not.toBe( refA )
  })

  it( 'replaces only changed episodes, leaving unchanged ones by reference', async () => {
    const consolidator = new EpisodicConsolidator({ autoIndex: false })
    const curve = new ForgettingCurve({ pruningThreshold: 0 })
    curve.attachConsolidator( consolidator )
    consolidator.restoreEpisodes([ makeEpisode( 'decays', 0.8 ), makeEpisode( 'floored', 0 ) ])

    const before = consolidator.getAllEpisodes()
    const refDecays = before[0]!
    const refFloored = before[1]!  // already 0 → stays 0 → no replacement

    await curve.react( 1000, 1, emptyState(), ctx )

    const after = consolidator.getAllEpisodes()
    expect( after[0] ).not.toBe( refDecays )     // changed → replaced
    expect( after[1] ).toBe( refFloored )         // unchanged → same reference
  })

  it( 'still decays activation deterministically through the owner', async () => {
    const consolidator = new EpisodicConsolidator({ autoIndex: false })
    const curve = new ForgettingCurve({ pruningThreshold: 0, baseForgettingRate: 0.1, emotionProtection: 0 })
    curve.attachConsolidator( consolidator )
    consolidator.restoreEpisodes([ makeEpisode( 'a', 0.5 ) ])

    await curve.react( 1000, 1, emptyState(), ctx )  // 1s, rate 0.1 → 0.5 - 0.1 = 0.4

    expect( consolidator.getAllEpisodes()[0]!.activationStrength ).toBeCloseTo( 0.4, 6 )
  })
})

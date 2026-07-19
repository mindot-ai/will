// ─────────────────────────────────────────────────────────────
// tests/unit/dream.simulator.immutable.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * DreamSimulator no longer mutates shared episode state in place.
 *
 * Regression target: react() wrote reactivation boosts (activationStrength),
 * REM dampening (emotionalTags) and recombination tags straight onto the live
 * objects returned by getAllEpisodes(), during its own read phase — the same
 * shared-reference hazard ForgettingCurve was hardened against (FN8). The fix
 * computes the new values on working-copy drafts and commits them through
 * EpisodicConsolidator.applyDreamUpdates(), which replaces touched episodes with
 * updated copies (single writer, no reach-in). Episodes are DEEP-frozen here so a
 * stray in-place write to any field (incl. nested emotionalTags / tags) throws.
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { DreamSimulator } from '#faculties/dream.simulator'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState } from '#core/types'

function makeEpisode( id: string, over: Partial<EpisodicMemory> = {} ): EpisodicMemory {
  return {
    id, timestamp: 0, content: {}, emotionalTags: {},
    affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength: 0.5, retrievalCount: 0, lastRetrievedAt: null,
    tags: [], sourceType: 'percept', createdAt: 0, ...over,
  }
}

function deepFreeze( ep: EpisodicMemory ): EpisodicMemory {
  Object.freeze( ep.emotionalTags )
  Object.freeze( ep.tags )
  return Object.freeze( ep )
}

function emptyState(): ReadonlySimulationState {
  return { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState
}

const ctx = createContext('sim', 'run', 42 )

function sleepingDream( config = {} ): DreamSimulator {
  const dream = new DreamSimulator( config )
  // Enter sleep so react() actually does work.
  dream.onCognitiveEvent( { type: 'sleep.begun', salience: 0.5 } as never )
  return dream
}

describe('DreamSimulator — no shared-state mutation', () => {
  it('does not mutate live episodes in place (reactivation + dampening)', async () => {
    const consolidator = new EpisodicConsolidator( { autoIndex: false } )
    const dream = sleepingDream( { maxReactivationsPerTick: 5, emotionalDampeningRate: 0.5, recombinationProbability: 0 } )
    dream.attachConsolidator( consolidator )
    consolidator.restoreEpisodes( [ makeEpisode('a', { activationStrength: 0.5, emotionalTags: { fear: 0.8 } } ) ] )

    const refA = consolidator.getAllEpisodes()[0]!
    deepFreeze( refA )

    // Old code mutated the frozen object → TypeError; new code touches drafts.
    await expect( dream.react( 1000 as never, 1 as never, emptyState(), ctx ) ).resolves.toBeDefined()

    // Borrowed reference untouched…
    expect( refA.activationStrength ).toBe( 0.5 )
    expect( refA.emotionalTags.fear ).toBe( 0.8 )

    // …while the consolidator reports the reactivated + dampened values on a fresh object.
    const after = consolidator.getAllEpisodes()[0]!
    expect( after ).not.toBe( refA )
    expect( after.activationStrength ).toBeCloseTo( 0.53, 6 )   // +0.03 reactivation
    expect( after.emotionalTags.fear ).toBeCloseTo( 0.4, 6 )    // 0.8 * (1 - 0.5)
  } )

  it('replaces only touched episodes, leaving the rest by reference', async () => {
    const consolidator = new EpisodicConsolidator( { autoIndex: false } )
    // Only the single highest-scoring episode is reactivated; the other is left alone.
    const dream = sleepingDream( { maxReactivationsPerTick: 1, recombinationProbability: 0 } )
    dream.attachConsolidator( consolidator )
    consolidator.restoreEpisodes( [
      makeEpisode('hot',  { emotionalTags: { fear: 0.9 } } ),  // higher reactivation score
      makeEpisode('cold', { emotionalTags: {} } ),             // untouched
    ] )

    const before = consolidator.getAllEpisodes()
    const refHot = before[0]!, refCold = before[1]!

    await dream.react( 1000 as never, 1 as never, emptyState(), ctx )

    const after = consolidator.getAllEpisodes()
    expect( after[0] ).not.toBe( refHot )    // reactivated → replaced
    expect( after[1] ).toBe( refCold )       // untouched → same reference
  } )

  it('cross-pollinates tags via recombination without mutating shared objects', async () => {
    const consolidator = new EpisodicConsolidator( { autoIndex: false } )
    const dream = sleepingDream( { maxReactivationsPerTick: 1, recombinationProbability: 1 } )
    dream.attachConsolidator( consolidator )
    consolidator.restoreEpisodes( [
      makeEpisode('src',  { emotionalTags: { joy: 0.9 }, tags: [ 'shared', 'a' ] } ),  // reactivated, recombines
      makeEpisode('peer', { emotionalTags: {},           tags: [ 'shared', 'b' ] } ),  // recombination partner
    ] )

    const before = consolidator.getAllEpisodes()
    const refSrc = deepFreeze( before[0]! )
    const refPeer = deepFreeze( before[1]! )

    await expect( dream.react( 1000 as never, 1 as never, emptyState(), ctx ) ).resolves.toBeDefined()

    // Frozen originals untouched.
    expect( refSrc.tags ).toEqual( [ 'shared', 'a' ] )
    expect( refPeer.activationStrength ).toBe( 0.5 )

    // src gained peer's distinct tag on a fresh object; peer got its recombination boost.
    const after = consolidator.getAllEpisodes()
    expect( after[0] ).not.toBe( refSrc )
    expect( after[0]!.tags ).toContain('b')
    expect( after[0]!.tags ).toEqual( [ 'shared', 'a', 'b' ] )
    expect( after[1] ).not.toBe( refPeer )
    expect( after[1]!.activationStrength ).toBeCloseTo( 0.52, 6 )  // +0.02 recombination
  } )
} )

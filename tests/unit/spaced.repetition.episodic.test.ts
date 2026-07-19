// ─────────────────────────────────────────────────────────────
// tests/unit/spaced.repetition.episodic.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Waking episodic rehearsal (episodic spaced repetition). SpacedRepetition
 * already runs scheduled SM-2 review for beliefs; it now also rehearses the most
 * salient *due* episodes each review cycle (while awake — DreamSimulator owns
 * sleep), marking them retrieved so the ForgettingCurve's retrievalBoost keeps
 * them alive.
 */

import { describe, it, expect } from 'vitest'
import { SpacedRepetition } from '#faculties/spaced.repetition'
import type { EpisodicMemory } from '#faculties/episodic.consolidator'

function ep( id: string, over: Partial<EpisodicMemory> = {} ): EpisodicMemory {
  return {
    id, timestamp: 1 as never, content: id, emotionalTags: {},
    affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength: 0.6, retrievalCount: 0, lastRetrievedAt: null,
    tags: [], sourceType: 'percept', createdAt: 0, ...over,
  }
}

function stub( episodes: EpisodicMemory[] ){
  const retrieved: Array<{ id: string; tick: number }> = []
  const consolidator = {
    getAllEpisodes: () => episodes,
    markRetrieved: ( id: string, tick: number ) => retrieved.push( { id, tick } ),
  } as never
  return { consolidator, retrieved }
}

function runReact( sr: SpacedRepetition, tick: number, metrics = new Map<string, number>() ){
  return sr.react( 0 as never, tick as never, { tick, metrics, entities: new Map() } as never, {} as never )
}

describe('SpacedRepetition — episodic rehearsal (waking)', () => {
  it('rehearses the most salient due episodes and skips fresh / faint ones', async () => {
    const episodes = [
      ep('hot',   { emotionalTags: { fear: 0.9 }, activationStrength: 0.5 } ),                          // due + salient
      ep('mild',  { emotionalTags: { joy: 0.3 },  activationStrength: 0.6 } ),                          // due + mild
      ep('flat',  { emotionalTags: {},            activationStrength: 0.9 } ),                          // due but low score
      ep('fresh', { emotionalTags: { fear: 0.9 }, activationStrength: 0.5, lastRetrievedAt: 9 as never } ), // retrieved 1 tick ago → not due
      ep('faint', { emotionalTags: { fear: 0.9 }, activationStrength: 0.02 } ),                         // below pruning floor
    ]
    const { consolidator, retrieved } = stub( episodes )
    const sr = new SpacedRepetition( { reviewIntervalTicks: 5, maxReviewsPerCycle: 2 } )
    sr.attachEpisodicConsolidator( consolidator )

    await runReact( sr, 10 )

    const ids = retrieved.map( r => r.id )
    expect( ids ).toContain('hot')
    expect( ids ).toContain('mild')
    expect( ids ).not.toContain('flat')   // capped at 2, lower score
    expect( ids ).not.toContain('fresh')  // retrieved within the interval
    expect( ids ).not.toContain('faint')  // below the pruning floor
    expect( retrieved.every( r => r.tick === 10 ) ).toBe( true )
  } )

  it('does not rehearse while sleeping (DreamSimulator owns sleep)', async () => {
    const { consolidator, retrieved } = stub( [ ep('hot', { emotionalTags: { fear: 0.9 } } ) ] )
    const sr = new SpacedRepetition( { reviewIntervalTicks: 5 } )
    sr.attachEpisodicConsolidator( consolidator )

    await runReact( sr, 10, new Map( [ [ 'state.sleeping', 1 ] ] ) )
    expect( retrieved ).toHaveLength( 0 )
  } )

  it('respects episodicRehearsalEnabled=false', async () => {
    const { consolidator, retrieved } = stub( [ ep('hot', { emotionalTags: { fear: 0.9 } } ) ] )
    const sr = new SpacedRepetition( { reviewIntervalTicks: 5, episodicRehearsalEnabled: false } )
    sr.attachEpisodicConsolidator( consolidator )

    await runReact( sr, 10 )
    expect( retrieved ).toHaveLength( 0 )
  } )

  it('only rehearses once the review interval has elapsed', async () => {
    const { consolidator, retrieved } = stub( [ ep('hot', { emotionalTags: { fear: 0.9 } } ) ] )
    const sr = new SpacedRepetition( { reviewIntervalTicks: 50 } )
    sr.attachEpisodicConsolidator( consolidator )

    await runReact( sr, 10 )           // 10 < 50 → no cycle yet
    expect( retrieved ).toHaveLength( 0 )
  } )
} )

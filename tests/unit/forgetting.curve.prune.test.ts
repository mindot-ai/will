// ─────────────────────────────────────────────────────────────
// tests/unit/forgetting.curve.prune.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for ForgettingCurve eviction (FN7).
 *
 * Regression target: the pruning branch only incremented a local counter —
 * nothing was ever removed. Episodes decayed toward zero activation and then
 * stayed in the store forever (unbounded growth), while the
 * `memory.pruned_this_tick` metric reported prunes that never happened.
 * The fix routes eviction through EpisodicConsolidator.pruneEpisodes(), which
 * removes from the store, the id index, and the vector index, and emits the
 * matching state deletions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { ForgettingCurve } from '#faculties/forgetting.curve'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState, StateCommands } from '#core/types'
import type { VectorMemoryAdapter } from '#memory/vector.adapter'

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
  return {
    tick: 1,
    time: 0,
    entities: new Map(),
    metrics: new Map(),
  } as unknown as ReadonlySimulationState
}

function metricMap( commands: { metrics?: Array<[ string, number ]> } ): Map<string, number> {
  return new Map( commands.metrics ?? [] )
}

describe( 'ForgettingCurve — eviction (FN7)', () => {
  let consolidator: EpisodicConsolidator
  let curve: ForgettingCurve
  const ctx = createContext( 'sim', 'run', 42 )

  beforeEach( () => {
    consolidator = new EpisodicConsolidator({ autoIndex: false })
    curve = new ForgettingCurve({ pruningThreshold: 0.01, maxPrunePerTick: 10 })
    curve.attachConsolidator( consolidator )
  })

  it( 'removes sub-threshold episodes from the store', async () => {
    consolidator.restoreEpisodes([
      makeEpisode( 'keep-1', 0.9 ),
      makeEpisode( 'drop-1', 0.005 ),
      makeEpisode( 'keep-2', 0.5 ),
      makeEpisode( 'drop-2', 0.0 ),
    ])

    const commands = ( await curve.react( 1000, 1, emptyState(), ctx ) ).commands as StateCommands

    const remaining = consolidator.getAllEpisodes().map( e => e.id )
    expect( remaining ).toEqual( [ 'keep-1', 'keep-2' ] )
    // Pruned entities must be deleted from sim state too.
    expect( ( commands.delete ?? [] ).sort() ).toEqual( [ 'drop-1', 'drop-2' ] )
  })

  it( 'reports an honest pruned/total metric (no phantom prunes)', async () => {
    consolidator.restoreEpisodes([
      makeEpisode( 'a', 0.9 ),
      makeEpisode( 'b', 0.001 ),
      makeEpisode( 'c', 0.001 ),
    ])

    const commands = ( await curve.react( 1000, 1, emptyState(), ctx ) ).commands as StateCommands
    const m = metricMap( commands )

    expect( m.get( 'memory.pruned_this_tick' ) ).toBe( 2 )
    expect( m.get( 'memory.total_episodes' ) ).toBe( 1 )
    expect( consolidator.getAllEpisodes() ).toHaveLength( 1 )
  })

  it( 'does not prune when every episode is above threshold', async () => {
    consolidator.restoreEpisodes([ makeEpisode( 'a', 0.9 ), makeEpisode( 'b', 0.5 ) ])

    const commands = ( await curve.react( 1000, 1, emptyState(), ctx ) ).commands as StateCommands

    expect( commands.delete ?? [] ).toHaveLength( 0 )
    expect( metricMap( commands ).get( 'memory.pruned_this_tick' ) ).toBe( 0 )
    expect( consolidator.getAllEpisodes() ).toHaveLength( 2 )
  })

  it( 'honours maxPrunePerTick', async () => {
    const limited = new ForgettingCurve({ pruningThreshold: 0.01, maxPrunePerTick: 2 })
    limited.attachConsolidator( consolidator )
    consolidator.restoreEpisodes([
      makeEpisode( 'a', 0 ), makeEpisode( 'b', 0 ),
      makeEpisode( 'c', 0 ), makeEpisode( 'd', 0 ),
    ])

    const commands = ( await limited.react( 1000, 1, emptyState(), ctx ) ).commands as StateCommands

    expect( commands.delete ?? [] ).toHaveLength( 2 )
    expect( consolidator.getAllEpisodes() ).toHaveLength( 2 )
  })

  it( 'evicts pruned episodes from the vector index', async () => {
    const deleted: string[] = []
    const mockVector = {
      delete: async ( id: string ) => { deleted.push( id ) },
    } as unknown as VectorMemoryAdapter

    const withVector = new EpisodicConsolidator({ autoIndex: false, vectorMemory: mockVector })
    const c2 = new ForgettingCurve({ pruningThreshold: 0.01, maxPrunePerTick: 10 })
    c2.attachConsolidator( withVector )
    withVector.restoreEpisodes([ makeEpisode( 'live', 0.8 ), makeEpisode( 'dead', 0 ) ])

    await c2.react( 1000, 1, emptyState(), ctx )

    expect( deleted ).toEqual( [ 'dead' ] )
  })
})

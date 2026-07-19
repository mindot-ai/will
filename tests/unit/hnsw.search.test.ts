// ─────────────────────────────────────────────────────────────
// tests/unit/hnsw.search.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for HNSWIndex graph traversal (FN4).
 *
 * Regression target: _searchLayer expanded `entry.connections` — the fixed
 * starting node — on every loop iteration instead of the candidate just
 * popped from the frontier. That collapsed the greedy walk into a single-hop
 * scan of the entry node's immediate neighbourhood, so any vector more than
 * one graph hop from the entry point was unreachable and recall cratered.
 * The fix traverses the popped node's connections, restoring the multi-hop
 * best-first walk. These tests assert reachability beyond the entry's direct
 * neighbours and high recall@1 over a dataset far larger than M.
 */

import { describe, it, expect } from 'vitest'
import { HNSWIndex } from '#memory/vector.index'
import type { VectorRecord } from '#memory/vector.types'

function makeRecord( id: string, vector: number[] ): VectorRecord {
  return {
    id,
    vector,
    embeddingModel: 'test',
    createdAt: 0,
    metadata: { tick: 0, sourceType: 'test', emotionalValence: 0, tags: [] },
  }
}

describe('HNSWIndex — multi-hop graph traversal (FN4)', () => {
  it('reaches a vector many hops from the entry point', async () => {
    // Points on a 1D line embedded in 2D. The first inserted point (id "0")
    // is the entry point; its level-0 neighbourhood holds only the M nearest
    // ids near 0. The far endpoint is well outside that neighbourhood, so a
    // single-hop scan from the entry could never return it.
    const index = new HNSWIndex({ dimensions: 2, similarityMetric: 'euclidean' })
    const n = 80
    for( let i = 0; i < n; i++ )
      await index.insert( makeRecord( String( i ), [ i, 0 ] ) )

    const far = String( n - 1 )
    const results = await index.search( [ n - 1, 0 ], 1, { minSimilarity: 0 } )

    expect( results ).toHaveLength( 1 )
    expect( results[0]!.episodeId ).toBe( far )
  })

  it('achieves high recall@1 over a dataset far larger than M', async () => {
    const index = new HNSWIndex({
      dimensions: 2,
      similarityMetric: 'euclidean',
      hnswM: 16,
    })
    const n = 80
    for( let i = 0; i < n; i++ )
      await index.insert( makeRecord( String( i ), [ i, 0 ] ) )

    // Each point queried by its own vector must come back as the top hit.
    // With the single-hop bug only the entry's ~M neighbours + entry were
    // ever returned, capping recall near (M+1)/n ≈ 0.2.
    let found = 0
    for( let i = 0; i < n; i++ ){
      const results = await index.search( [ i, 0 ], 1, { minSimilarity: 0 } )
      if( results[0]?.episodeId === String( i ) ) found++
    }

    expect( found / n ).toBeGreaterThanOrEqual( 0.95 )
  })

  it('returns k nearest neighbours in ascending-distance order', async () => {
    const index = new HNSWIndex({ dimensions: 2, similarityMetric: 'euclidean' })
    const n = 60
    for( let i = 0; i < n; i++ )
      await index.insert( makeRecord( String( i ), [ i, 0 ] ) )

    // Query near id 40 — its true nearest neighbours are 40, 41, 39, 42, 38.
    const results = await index.search( [ 40, 0 ], 5, { minSimilarity: 0 } )
    const ids = results.map( r => r.episodeId )

    expect( ids ).toContain('40')
    // Similarities must be monotonically non-increasing (sorted by distance).
    for( let i = 1; i < results.length; i++ )
      expect( results[i]!.similarity ).toBeLessThanOrEqual( results[i - 1]!.similarity )
  })
})

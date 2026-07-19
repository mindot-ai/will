// ─────────────────────────────────────────────────────────────
// tests/unit/hnsw.pruning.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for HNSW neighbour pruning + level-aware entry reselection (FN6).
 *
 * Regression targets:
 *  1. On insert, neighbours got `neighbor.connections.get(l).add(id)` with no
 *     shrink back to M — node degree grew without bound, bloating memory and
 *     slowing _searchLayer forever. Canonical HNSW prunes each touched
 *     neighbour back to Mmax (M for upper layers, M*2 at the base layer).
 *  2. On deleting the entry point, the replacement was an arbitrary
 *     `keys().next()` node that may live only at level 0 while _maxLevel stayed
 *     high — the top-down descent then started from a node with no high-level
 *     connections. The fix promotes the highest-level remaining node and
 *     resyncs _maxLevel.
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

// Tightly-clustered vectors so many nodes contend for the same neighbours and
// repeatedly trigger the degree cap — exactly the back-link accumulation FN6 hit.
function clustered( n: number ): VectorRecord[] {
  const recs: VectorRecord[] = []
  for( let i = 0; i < n; i++ )
    recs.push( makeRecord( String( i ), [ Math.sin( i ) * 0.01, Math.cos( i ) * 0.01, ( i % 5 ) * 0.01 ] ) )
  return recs
}

interface SerializedGraph {
  entryPoint: string | null
  maxLevel: number
  nodes: Array<{
    id: string
    level: number
    connections: Array<{ level: number; neighbors: string[] }>
  }>
}

function graphOf( index: HNSWIndex ): SerializedGraph {
  return JSON.parse( new TextDecoder().decode( index.serialize() ) ) as SerializedGraph
}

async function build( recs: VectorRecord[], m: number ): Promise<HNSWIndex> {
  const index = new HNSWIndex({ dimensions: 3, similarityMetric: 'euclidean', hnswM: m, seed: 7 })
  for( const r of recs ) await index.insert( r )
  return index
}

describe('HNSWIndex — neighbour pruning (FN6)', () => {
  it('caps every node degree at Mmax (M*2 at level 0, M above)', async () => {
    const M = 4
    const index = await build( clustered( 250 ), M )
    const graph = graphOf( index )

    let maxLevel0 = 0
    let maxUpper  = 0
    for( const node of graph.nodes )
      for( const conn of node.connections ){
        const cap = conn.level === 0 ? M * 2 : M
        expect( conn.neighbors.length ).toBeLessThanOrEqual( cap )
        if( conn.level === 0 ) maxLevel0 = Math.max( maxLevel0, conn.neighbors.length )
        else                   maxUpper  = Math.max( maxUpper,  conn.neighbors.length )
      }

    // Sanity: with 250 clustered nodes the cap must actually bite at level 0,
    // otherwise the test isn't exercising the prune path.
    expect( maxLevel0 ).toBeGreaterThan( M )
    expect( maxUpper ).toBeLessThanOrEqual( M )
  })

  it('keeps the graph searchable after heavy pruning', async () => {
    const index = await build( clustered( 250 ), 4 )
    // Query near node "10" — a real neighbour must come back, proving pruning
    // didn't sever the graph.
    const hits = await index.search( [ Math.sin( 10 ) * 0.01, Math.cos( 10 ) * 0.01, 0 ], 5, { minSimilarity: 0 } )
    expect( hits.length ).toBeGreaterThan( 0 )
  })

  it('no node lists a stale id after pruning (all neighbours resolve)', async () => {
    const graph = graphOf( await build( clustered( 200 ), 4 ) )
    const ids = new Set( graph.nodes.map( n => n.id ) )
    for( const node of graph.nodes )
      for( const conn of node.connections )
        for( const nb of conn.neighbors )
          expect( ids.has( nb ) ).toBe( true )
  })
})

describe('HNSWIndex — entry-point reselection (FN6)', () => {
  it('promotes the highest-level remaining node and resyncs maxLevel', async () => {
    const index = await build( clustered( 120 ), 8 )
    const before = graphOf( index )

    // Delete the current entry point.
    expect( before.entryPoint ).not.toBeNull()
    const ok = await index.delete( before.entryPoint! )
    expect( ok ).toBe( true )

    const after = graphOf( index )
    const remainingMax = Math.max( ...after.nodes.map( n => n.level ) )

    // _maxLevel must equal the true max remaining level (not a stale high value).
    expect( after.maxLevel ).toBe( remainingMax )
    // The new entry point must actually live at that level.
    const entry = after.nodes.find( n => n.id === after.entryPoint )
    expect( entry ).toBeDefined()
    expect( entry!.level ).toBe( remainingMax )
  })

  it('nulls the entry point and maxLevel when the last node is deleted', async () => {
    const index = await build( clustered( 1 ), 8 )
    const only = graphOf( index ).entryPoint!
    await index.delete( only )

    const after = graphOf( index )
    expect( after.entryPoint ).toBeNull()
    expect( after.maxLevel ).toBe( 0 )
    expect( after.nodes ).toHaveLength( 0 )
  })
})

// ─────────────────────────────────────────────────────────────
// tests/unit/hnsw.determinism.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for HNSWIndex deterministic level assignment (FN5).
 *
 * Regression target: _randomLevel() called the global, unseeded Math.random(),
 * so the graph topology (and therefore search results) differed run to run.
 * That silently broke the index's documented determinism guarantee and any
 * replay/snapshot-rebuild that relies on it. The fix seeds a Mulberry32 PRNG
 * from config.seed, resets it on clear() (so rebuildFromStore reproduces the
 * graph), and persists/restores its state through serialize()/deserialize().
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

// Deterministic pseudo-spread vectors so topology depends only on the PRNG seed.
function dataset( n: number ): VectorRecord[] {
  const recs: VectorRecord[] = []
  for( let i = 0; i < n; i++ )
    recs.push( makeRecord( String( i ), [ Math.sin( i ), Math.cos( i * 0.5 ), i % 7 ] ) )
  return recs
}

async function build( seed: number, recs: VectorRecord[] ): Promise<HNSWIndex> {
  const index = new HNSWIndex({ dimensions: 3, similarityMetric: 'cosine', seed } )
  for( const r of recs ) await index.insert( r )
  return index
}

const decode = ( bytes: Uint8Array ) => new TextDecoder().decode( bytes )

describe( 'HNSWIndex — deterministic topology (FN5)', () => {
  it( 'produces a byte-identical graph for the same seed and insertion order', async () => {
    const recs = dataset( 120 )
    const a = await build( 7, recs )
    const b = await build( 7, recs )

    expect( decode( a.serialize() ) ).toBe( decode( b.serialize() ) )
  })

  it( 'produces a different graph for a different seed', async () => {
    const recs = dataset( 120 )
    const a = await build( 7, recs )
    const b = await build( 99999, recs )

    // 120 nodes with M=16 level draws — identical topology across two distinct
    // seeds is astronomically improbable, so this reliably distinguishes seeds.
    expect( decode( a.serialize() ) ).not.toBe( decode( b.serialize() ) )
  })

  it( 'reproduces the graph after clear() + rebuild from the same order', async () => {
    const recs = dataset( 80 )
    const index = await build( 7, recs )
    const before = decode( index.serialize() )

    await index.clear()
    for( const r of recs ) await index.insert( r )
    const after = decode( index.serialize() )

    expect( after ).toBe( before )
  })

  it( 'continues the same PRNG sequence across serialize/deserialize', async () => {
    const recs = dataset( 40 )
    const more = dataset( 40 ).map( r => makeRecord( `x${r.id}`, r.vector ) )

    // Reference: one index that inserts the full sequence in a single lifetime.
    const reference = await build( 7, recs )
    for( const r of more ) await reference.insert( r )

    // Round-tripped: build half, persist, restore into a fresh index, finish.
    const half = await build( 7, recs )
    const restored = new HNSWIndex()
    await restored.deserialize( half.serialize() )
    for( const r of more ) await restored.insert( r )

    // If prngState were not persisted, restored would restart its level draws
    // from the seed and diverge from the reference.
    expect( decode( restored.serialize() ) ).toBe( decode( reference.serialize() ) )
  })
})

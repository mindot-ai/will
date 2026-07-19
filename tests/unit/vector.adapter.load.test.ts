// ─────────────────────────────────────────────────────────────
// tests/unit/vector.adapter.load.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression tests for DefaultVectorMemoryAdapter.load().
 *
 *  #2  _indexedIds desync — load()/deserialize repopulated the HNSW nodes but
 *      NOT the adapter's `_indexedIds` set. After a restore the set stayed empty
 *      while the index was full, so `_evictOldest` (which iterates `_indexedIds`)
 *      became a no-op and the `indexBatch` eviction loop spun forever once the
 *      loaded index sat at its cap. Fix: rebuild `_indexedIds` from the index on
 *      load via the new VectorIndex.keys().
 *
 *  #7  embedding-model / dimension drift — a persisted index holds vectors in the
 *      build-time model's space. Loading it under a different model (or dimension
 *      count) silently corrupts similarity. Fix: stamp `{model,dimensions}` beside
 *      the index and discard the stale index on mismatch so the caller rebuilds.
 */

import { describe, it, expect } from 'vitest'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder } from '#memory/vector.embedder'
import type { EmbeddingProvider } from '#memory/vector.embedder'
import type { EpisodicMemory } from '#faculties/episodic.consolidator'
import type { StorageAdapter } from '#core/abstracts'

/** In-memory StorageAdapter so persist→load round-trips without touching disk. */
class MemStorage implements StorageAdapter {
  private _files = new Map<string, string | Uint8Array>()
  async write( path: string, content: string | Uint8Array ): Promise<void> { this._files.set( path, content ) }
  async read( path: string ): Promise<string> {
    const v = this._files.get( path )
    if( v == null ) throw new Error(`not found: ${path}`)
    return typeof v === 'string' ? v : new TextDecoder().decode( v )
  }
  async readBytes( path: string ): Promise<Uint8Array> {
    const v = this._files.get( path )
    if( v == null ) throw new Error(`not found: ${path}`)
    return typeof v === 'string' ? new TextEncoder().encode( v ) : v
  }
  async exists( path: string ): Promise<boolean> { return this._files.has( path ) }
}

/** Minimal embedder with a configurable model name / dimension, for the drift test. */
class TaggedEmbedder implements EmbeddingProvider {
  constructor( readonly modelName: string, readonly dimensions: number ){}
  async embed(): Promise<number[]> { return new Array( this.dimensions ).fill( 0 ) }
  async embedBatch( contents: unknown[] ): Promise<number[][]> { return contents.map( () => new Array( this.dimensions ).fill( 0 ) ) }
  areEquivalent(): boolean { return true }
}

function makeEpisode( id: string, tick: number ): EpisodicMemory {
  return {
    id, timestamp: tick, content: `episode-content-${id}`,
    emotionalTags: {}, affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength: 1, retrievalCount: 0, lastRetrievedAt: null,
    tags: [], sourceType: 'test', createdAt: tick,
  }
}

const baseCfg = { dimensions: 128, minSimilarity: -1, seed: 42, persistPath: 'idx' }

describe('DefaultVectorMemoryAdapter — load() (#2 / #7)', () => {
  it('rebuilds the eviction id-set on load so a loaded-at-cap index still evicts (no hang)', async () => {
    const storage = new MemStorage()
    const cfg = { ...baseCfg, maxIndexedEpisodes: 5 }

    const a1 = new DefaultVectorMemoryAdapter( new MockEmbedder( 42 ), cfg, storage )
    for( let i = 0; i < 5; i++ )
      await a1.index( makeEpisode(`ep-${i}`, i ), `content-${i}`)
    await a1.persist()
    expect( a1.size ).toBe( 5 )

    // Fresh adapter on the same storage — simulates a process restart.
    const a2 = new DefaultVectorMemoryAdapter( new MockEmbedder( 42 ), cfg, storage )
    await a2.load()
    expect( a2.size ).toBe( 5 )

    // Overflowing batch on a loaded-at-cap index. Pre-fix this hung (the explicit
    // timeout below turns a regression into a failing test, not a frozen suite).
    await a2.indexBatch(
      Array.from( { length: 3 }, ( _, i ) => ( {
        episode: makeEpisode(`new-${i}`, 100 + i ),
        content: `new-content-${i}`,
      } ) ),
    )
    expect( a2.size ).toBeLessThanOrEqual( 5 )
  }, 5000 )

  it('discards a persisted index built with a different embedding model', async () => {
    const storage = new MemStorage()
    const cfg = { ...baseCfg, maxIndexedEpisodes: 100 }

    const a1 = new DefaultVectorMemoryAdapter( new MockEmbedder( 42 ), cfg, storage )  // model 'mock', 128d
    for( let i = 0; i < 3; i++ )
      await a1.index( makeEpisode(`ep-${i}`, i ), `content-${i}`)
    await a1.persist()

    // Different model → mismatch → stale index discarded (size stays 0, caller rebuilds).
    const a2 = new DefaultVectorMemoryAdapter( new TaggedEmbedder('other-model', 128 ), cfg, storage )
    await a2.load()
    expect( a2.size ).toBe( 0 )

    // Same model + dims → loads normally.
    const a3 = new DefaultVectorMemoryAdapter( new MockEmbedder( 42 ), cfg, storage )
    await a3.load()
    expect( a3.size ).toBe( 3 )
  } )

  it('discards a persisted index built with a different dimension count', async () => {
    const storage = new MemStorage()
    const cfg = { ...baseCfg, maxIndexedEpisodes: 100 }

    const a1 = new DefaultVectorMemoryAdapter( new TaggedEmbedder('m', 128 ), cfg, storage )
    for( let i = 0; i < 3; i++ )
      await a1.index( makeEpisode(`ep-${i}`, i ), `content-${i}`)
    await a1.persist()

    // Same model name, different dimensions → still a mismatch → discard.
    const a2 = new DefaultVectorMemoryAdapter( new TaggedEmbedder('m', 256 ), { ...cfg, dimensions: 256 }, storage )
    await a2.load()
    expect( a2.size ).toBe( 0 )
  } )
} )

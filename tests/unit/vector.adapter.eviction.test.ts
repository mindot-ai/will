// ─────────────────────────────────────────────────────────────
// tests/unit/vector.adapter.eviction.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression tests for DefaultVectorMemoryAdapter eviction (R6-a).
 *
 * Bug: `_evictOldest` was a no-op, so the indexBatch eviction loop
 *   `while( size + newEpisodes.length > maxIndexedEpisodes ) await _evictOldest()`
 * could never reduce `size` and span forever once the index neared its cap.
 *
 * Fix: `_evictOldest` now drops the oldest ~10%-of-cap (≥1) entries by
 * insertion order, and the loop carries a `size > 0` guard so a batch that
 * alone exceeds the cap drains the index and then stops instead of spinning.
 *
 * These tests assert the index stays bounded, evicts oldest-first, and — most
 * importantly — that every code path terminates (a hang trips vitest's
 * per-test timeout and fails the suite).
 */

import { describe, it, expect } from 'vitest'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder } from '#memory/vector.embedder'
import type { EpisodicMemory } from '#faculties/episodic.consolidator'

function makeEpisode( id: string, tick: number ): EpisodicMemory {
  return {
    id,
    timestamp: tick,
    content: `episode-content-${id}`,
    emotionalTags: {},
    affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
    activationStrength: 1,
    retrievalCount: 0,
    lastRetrievedAt: null,
    tags: [],
    sourceType: 'test',
    createdAt: tick,
  }
}

function makeAdapter( maxIndexedEpisodes: number ): DefaultVectorMemoryAdapter {
  // dimensions match MockEmbedder (128); seed pins deterministic vectors.
  return new DefaultVectorMemoryAdapter(
    new MockEmbedder( 42 ),
    { dimensions: 128, maxIndexedEpisodes, minSimilarity: 0, seed: 42 },
  )
}

/** Dump every reachable episodeId via a similarity-floor-free search. */
async function indexedIds( adapter: DefaultVectorMemoryAdapter ): Promise<Set<string>> {
  const results = await adapter.searchWithVector(
    await new MockEmbedder( 42 ).embed('probe'),
    { minSimilarity: -1, maxResults: 1000 },
  )
  return new Set( results.map( r => r.episodeId ) )
}

describe('DefaultVectorMemoryAdapter — eviction (R6-a)', () => {
  it('keeps the index bounded when indexing one-by-one past the cap', async () => {
    const cap = 5
    const adapter = makeAdapter( cap )

    for( let i = 0; i < 12; i++ )
      await adapter.index( makeEpisode(`ep-${i}`, i ), `episode-content-ep-${i}`)

    expect( adapter.size ).toBeLessThanOrEqual( cap )
  } )

  it('evicts oldest-first, dropping the earliest-inserted episode', async () => {
    const cap = 3
    const adapter = makeAdapter( cap )

    // Fill to cap, then push one more to trigger a single eviction.
    for( let i = 0; i < 4; i++ )
      await adapter.index( makeEpisode(`ep-${i}`, i ), `episode-content-ep-${i}`)

    expect( adapter.size ).toBeLessThanOrEqual( cap )

    const ids = await indexedIds( adapter )
    // ep-0 was inserted first → it is the eviction victim.
    expect( ids.has('ep-0') ).toBe( false )
    // The most recent insert must survive.
    expect( ids.has('ep-3') ).toBe( true )
  } )

  it('terminates when a single batch alone exceeds the cap (loop-guard)', async () => {
    const cap = 5
    const adapter = makeAdapter( cap )

    // The pre-fix infinite loop: a batch bigger than the cap with a no-op
    // evict. The `size > 0` guard lets this complete instead of hanging.
    const batch = Array.from( { length: 20 }, ( _, i ) => ( {
      episode: makeEpisode(`ep-${i}`, i ),
      content: `episode-content-ep-${i}`,
    } ) )

    await adapter.indexBatch( batch )

    // All 20 land (eviction can't help a batch that alone exceeds the cap),
    // but the call returned — that is the regression guard.
    expect( adapter.size ).toBe( 20 )
  } )

  it('evicts to make room when a batch overflows an already-populated index', async () => {
    const cap = 5
    const adapter = makeAdapter( cap )

    await adapter.indexBatch(
      Array.from( { length: 4 }, ( _, i ) => ( {
        episode: makeEpisode(`a-${i}`, i ),
        content: `episode-content-a-${i}`,
      } ) ),
    )
    expect( adapter.size ).toBe( 4 )

    // Second batch of 4 forces eviction of existing entries before insert.
    await adapter.indexBatch(
      Array.from( { length: 4 }, ( _, i ) => ( {
        episode: makeEpisode(`b-${i}`, 100 + i ),
        content: `episode-content-b-${i}`,
      } ) ),
    )

    expect( adapter.size ).toBeLessThanOrEqual( cap )
  } )
} )

describe('DefaultVectorMemoryAdapter — LRU eviction (#6)', () => {
  it('keeps a recalled (warm) memory and evicts the coldest instead of the oldest', async () => {
    const cap = 5
    const adapter = makeAdapter( cap )

    for( let i = 0; i < 5; i++ )
      await adapter.index( makeEpisode(`ep-${i}`, i ), `episode-content-ep-${i}`)

    // Recall the OLDEST entry → warms it (access recency bumped above the rest).
    const hits = await adapter.search('episode-content-ep-0', { maxResults: 1 } )
    expect( hits[0]?.episodeId ).toBe('ep-0')

    // A 6th insert overflows the cap → exactly one (the coldest) is evicted.
    await adapter.index( makeEpisode('ep-5', 5 ), 'episode-content-ep-5')
    expect( adapter.size ).toBeLessThanOrEqual( cap )

    const ids = await indexedIds( adapter )
    expect( ids.has('ep-0') ).toBe( true )   // warmed by recall → survives despite being oldest
    expect( ids.has('ep-1') ).toBe( false )  // coldest untouched entry → evicted
    expect( ids.has('ep-5') ).toBe( true )   // newest insert → survives
  } )

  it('degrades to oldest-first when nothing has been recalled (no warm entries)', async () => {
    const cap = 3
    const adapter = makeAdapter( cap )

    for( let i = 0; i < 4; i++ )
      await adapter.index( makeEpisode(`ep-${i}`, i ), `episode-content-ep-${i}`)

    const ids = await indexedIds( adapter )
    expect( ids.has('ep-0') ).toBe( false )  // no recalls → coldest == oldest
    expect( ids.has('ep-3') ).toBe( true )
  } )
} )

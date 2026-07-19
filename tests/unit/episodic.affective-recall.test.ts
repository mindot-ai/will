// ─────────────────────────────────────────────────────────────
// tests/unit/episodic.affective-recall.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Mood-congruent recall. semanticQuery's optional affectiveBias re-ranks results
 * by blending embedding similarity with affective congruence between the current
 * mood and each episode's encoded valence — so a memory encoded in a mood like
 * the present one surfaces more readily, without filtering the rest out.
 *
 * Two episodes share identical content (→ identical embeddings → tied similarity)
 * but opposite valence, so the affective term alone decides the order.
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder } from '#memory/vector.embedder'
import type { StorageAdapter } from '#core/abstracts'

class MemStorage implements StorageAdapter {
  private _f = new Map<string, string | Uint8Array>()
  async write( p: string, c: string | Uint8Array ){ this._f.set( p, c ) }
  async read( p: string ){ const v = this._f.get( p ); if( v == null ) throw new Error( p ); return typeof v === 'string' ? v : new TextDecoder().decode( v ) }
  async readBytes( p: string ){ const v = this._f.get( p ); if( v == null ) throw new Error( p ); return typeof v === 'string' ? new TextEncoder().encode( v ) : v }
  async exists( p: string ){ return this._f.has( p ) }
}

function episodicEntity( id: string, valence: number ){
  return {
    id, type: 'episodic_memory', createdAt: 0,
    metadata: {
      content: 'lakeside morning', tick: 1,
      affectiveContext: { valence, arousal: 0.3, dominance: 0.5 },
      activationStrength: 0.7, emotionalTags: {}, retrievalCount: 0,
      lastRetrievedAt: null, tags: [], sourceType: 'percept', createdAt: 0,
    },
  }
}

async function makeConsolidator(){
  const adapter = new DefaultVectorMemoryAdapter(
    new MockEmbedder( 42 ),
    { dimensions: 128, minSimilarity: -1, seed: 42 },
    new MemStorage(),
  )
  const consolidator = new EpisodicConsolidator( { vectorMemory: adapter } )

  const entities = new Map<string, unknown>()
  entities.set('ep-pos', episodicEntity('ep-pos', 0.8 ) )
  entities.set('ep-neg', episodicEntity('ep-neg', -0.8 ) )
  const state = { tick: 1, time: 0, metrics: new Map(), entities } as never

  // First react restores episodes into the store + builds the vector index.
  await consolidator.react( 0 as never, 1 as never, state, {} as never )
  return consolidator
}

describe('EpisodicConsolidator.semanticQuery — mood-congruent recall', () => {
  it('surfaces the positively-encoded memory first in a positive mood', async () => {
    const c = await makeConsolidator()
    const out = await c.semanticQuery('lakeside morning', { limit: 2, affectiveBias: { valence: 0.9, weight: 0.5 } } )
    expect( out[0]?.id ).toBe('ep-pos')
    expect( out.map( e => e.id ).sort() ).toEqual( [ 'ep-neg', 'ep-pos' ] )  // re-ranks, does not filter
  } )

  it('surfaces the negatively-encoded memory first in a negative mood', async () => {
    const c = await makeConsolidator()
    const out = await c.semanticQuery('lakeside morning', { limit: 2, affectiveBias: { valence: -0.9, weight: 0.5 } } )
    expect( out[0]?.id ).toBe('ep-neg')
  } )

  it('weight 0 (or no bias) leaves similarity ordering untouched', async () => {
    const c = await makeConsolidator()
    const biased   = await c.semanticQuery('lakeside morning', { limit: 2, affectiveBias: { valence: 0.9, weight: 0 } } )
    const unbiased = await c.semanticQuery('lakeside morning', { limit: 2 } )
    expect( biased.map( e => e.id ) ).toEqual( unbiased.map( e => e.id ) )
  } )
} )

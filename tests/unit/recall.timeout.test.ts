// ─────────────────────────────────────────────────────────────
// tests/unit/recall.timeout.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * semanticQuery timeout guard — recall is best-effort. The vector search embeds
 * the query (potentially a real network call); a hanging embedder must degrade
 * to "no recall" instead of blocking the reasoning chain that awaits it inside
 * prompt building. WILL_RECALL_TIMEOUT_MS bounds the wait (read lazily).
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { VectorMemoryAdapter } from '#cognition/memory/index'

function consolidatorWith( search: VectorMemoryAdapter['search'] ): EpisodicConsolidator {
  return new EpisodicConsolidator( {
    vectorMemory: {
      search,
      index:  async () => {},
      remove: async () => {},
    } as unknown as VectorMemoryAdapter,
  } )
}

describe('semanticQuery — timeout guard', () => {
  it('returns [] when the vector search hangs past WILL_RECALL_TIMEOUT_MS', async () => {
    const saved = process.env.WILL_RECALL_TIMEOUT_MS
    process.env.WILL_RECALL_TIMEOUT_MS = '50'
    try {
      const hanging = consolidatorWith( () => new Promise( () => {} ) )   // never resolves

      const started = Date.now()
      const result  = await hanging.semanticQuery('anything')

      expect( result ).toEqual( [] )
      expect( Date.now() - started ).toBeLessThan( 2_000 )   // bounded, not hung
    }
    finally {
      if( saved === undefined ) delete process.env.WILL_RECALL_TIMEOUT_MS
      else process.env.WILL_RECALL_TIMEOUT_MS = saved
    }
  } )

  it('a fast search is unaffected by the guard', async () => {
    const fast = consolidatorWith( async () => [] )
    await expect( fast.semanticQuery('anything') ).resolves.toEqual( [] )
  } )
} )

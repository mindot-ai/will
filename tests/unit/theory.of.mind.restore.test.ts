// ─────────────────────────────────────────────────────────────
// tests/unit/theory.of.mind.restore.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 0 — theory-of-mind persistence parity. ToM previously wrote
 * tom-<id> entities but never read them back, so a snapshot/PMA restore kept the Will's
 * bonds + trust while silently losing its effector to *model* those same minds. It now
 * rehydrates from the persisted gist on the first tick — like attachment/reputation —
 * recovering a coherent sense of the mind (confidence + dominant intention + emotion),
 * not the full belief trail (that fades, soul-true).
 */

import { describe, it, expect } from 'vitest'
import { TheoryOfMind } from '#faculties/theory.of.mind'

const tomEntity = ( keid: string, modelConfidence: number, dominantIntention: string | null, estimatedEmotion = 'neutral') => ( {
  id: `tom-${keid}`, type: 'theory_of_mind',
  metadata: { keid, modelConfidence, dominantIntention, estimatedEmotion },
} )

const stateWith = ( ...entities: any[] ) => {
  const map = new Map<string, any>()
  for( const e of entities ) map.set( e.id, e )
  return { tick: 100, entities: map, metrics: new Map<string, number>() } as any
}

describe('TheoryOfMind — restores its model gist on first tick (Phase 0 parity)', () => {
  it('rehydrates a persisted tom-<id> into a queryable model', async () => {
    const tom = new TheoryOfMind()
    expect( tom.getModel('alex') ).toBeUndefined()              // cold

    await tom.react( 1000 as any, 100 as any, stateWith( tomEntity('alex', 0.7, 'collaborate', 'satisfaction') ), {} as any )

    const m = tom.getModel('alex')
    expect( m ).toBeDefined()
    expect( m!.modelConfidence ).toBe( 0.7 )
    expect( m!.intentions[0]?.goal ).toBe('collaborate')         // dominant intention recovered
    expect( m!.emotionalState.dominantEmotion ).toBe('satisfaction')
  } )

  it('restores only once and never clobbers a live model', async () => {
    const tom = new TheoryOfMind()
    const s   = stateWith( tomEntity('alex', 0.7, 'collaborate') )
    await tom.react( 1000 as any, 100 as any, s, {} as any )       // first tick: restore
    // Mark the live model; a second restore pass would reset it to the entity gist (empty
    // observations), wiping the sentinel. The _restored flag + the has()-guard must prevent that.
    tom.getModel('alex')!.knownObservations.push( { entityId: 'sentinel', tick: 100 as any, confidence: 1 } )
    await tom.react( 1000 as any, 101 as any, s, {} as any )       // second tick: no re-restore
    expect( tom.getModel('alex')!.knownObservations.some( o => o.entityId === 'sentinel') ).toBe( true )
  } )

  it('an intention-less gist restores a coherent (empty-intention) model', async () => {
    const tom = new TheoryOfMind()
    await tom.react( 1000 as any, 100 as any, stateWith( tomEntity('sam', 0.4, null ) ), {} as any )
    const m = tom.getModel('sam')
    expect( m ).toBeDefined()
    expect( m!.intentions ).toHaveLength( 0 )
    expect( m!.modelConfidence ).toBe( 0.4 )
  } )
} )

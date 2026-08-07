// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.recognition.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 5 — recognition / referent merge. Two referents the Will has resolved
 * to the *same name* are recognised as one someone and fused into a canonical keid, with an
 * alias record. Human-mind-like: provisional (a shared name can be wrong) and reversible
 * (drop the alias entity); deterministic (normalised-name match, most-familiar is canonical).
 * Reads of the triple/beliefs under the old keid resolve to the canonical — no re-keying.
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'
import { extractKnownEntities } from '#faculties/executive.engine/context'

const dossier = ( keid: string, name: string, familiarity: number, encounterCount: number, lastSeenTick = 10 ) =>
  ( { id: `ke-${keid}`, type: 'known-entity',
      metadata: { keid, kind: 'sentient', name, familiarity, valence: 0, reliability: 0.5, encounterCount, lastSeenTick, resolutionConfidence: 0.5 } } )

const percept = ( keid: string ) => ( {
  type: 'senses.audition.percept', salience: 0.6,
  payload: { domain: 'audition', sourceEntityId: keid, timestamp: 0, salience: 0.6, raw: {} },
} as any )

describe('KnownEntityTracker — recognition (referent merge)', () => {
  it('fuses two same-name referents into the more-familiar canonical + an alias', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    // a thin, non-concurrent handle (web:42, last seen long ago) recognised as the known Mara.
    entities.set('ke-web:42',   dossier('web:42',   'Mara', 0.3, 2, 10 ) )
    entities.set('ke-slack:U7', dossier('slack:U7', 'Mara', 0.6, 4, 95 ) )
    const r = await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )

    // Looking up the fused handle now yields the SOMEONE, not nothing. That is the
    // point of an alias: a caller has no business knowing which of two handles the
    // merge happened to pick as canonical. (This asserted `undefined` when a
    // dossier lookup was raw — so a reference to the absorbed handle found a
    // stranger, which is how willing a reach-out to a merged person resolved to
    // nothing and the intention evaporated.)
    const canon = t.getDossier('slack:U7')!
    expect( t.getDossier('web:42') ).toBe( canon )
    expect( canon ).toBeDefined()                                       // more familiar → canonical
    expect( canon.encounterCount ).toBe( 6 )                            // 4 + 2 combined
    expect( r.commands?.delete ?? [] ).toContain('ke-web:42')
    const aliasEntity = ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === 'kea-web:42')
    expect( aliasEntity?.type ).toBe('known-entity-alias')
    expect( aliasEntity?.metadata?.canonicalKeid ).toBe('slack:U7')
  } )

  it('does NOT fuse two same-name people active at the same time (distinct interlocutors)', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-web:42',   dossier('web:42',   'Alice', 0.3, 2, 99 ) )   // both
    entities.set('ke-slack:U7', dossier('slack:U7', 'Alice', 0.4, 3, 100 ) )  // concurrent
    const r = await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )
    expect( t.getDossier('web:42') ).toBeDefined()                    // kept distinct
    expect( t.getDossier('slack:U7') ).toBeDefined()
    expect( r.commands?.delete ?? [] ).not.toContain('ke-web:42')
  } )

  it('does NOT fuse two well-established same-name relationships', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-web:42',   dossier('web:42',   'Alice', 0.7, 12, 10 ) )  // both rich, distinct histories
    entities.set('ke-slack:U7', dossier('slack:U7', 'Alice', 0.8, 15, 95 ) )
    await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )
    expect( t.getDossier('web:42') ).toBeDefined()
    expect( t.getDossier('slack:U7') ).toBeDefined()
  } )

  it('redirects a later encounter of the aliased keid onto the canonical (no re-forming)', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-web:42',   dossier('web:42',   'Mara', 0.3, 2, 10 ) )
    entities.set('ke-slack:U7', dossier('slack:U7', 'Mara', 0.6, 4, 95 ) )
    await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )

    t.onCognitiveEvent( percept('web:42') )                           // the aliased handle, seen again
    await t.react( 1000 as any, 101 as any, { tick: 101, entities: new Map(), metrics: new Map() } as any, {} as any )
    // Never re-forms as a SEPARATE someone: the aliased handle lands on the
    // canonical dossier rather than minting a rival one beside it.
    expect( t.getDossier('web:42') ).toBe( t.getDossier('slack:U7') )
    expect( t.getDossier('slack:U7')!.encounterCount ).toBe( 7 )      // the encounter landed on the canonical
  } )
} )

describe('extractKnownEntities — resolves aliases to the canonical referent', () => {
  it('aggregates the triple under the alias keid into the one someone', () => {
    const entities = new Map<string, any>()
    entities.set('kea-web:42', { id: 'kea-web:42', type: 'known-entity-alias', metadata: { aliasKeid: 'web:42', canonicalKeid: 'slack:U7' } } )
    entities.set('tom-web:42', { id: 'tom-web:42', type: 'theory_of_mind', metadata: { keid: 'web:42', dominantIntention: 'collaborate', estimatedEmotion: 'warm', modelConfidence: 0.7 } } )
    entities.set('ke-slack:U7', dossier('slack:U7', 'Mara', 0.6, 4 ) )

    const models = extractKnownEntities( { tick: 100, entities, metrics: new Map() } as any )!
    expect( models ).toHaveLength( 1 )                                  // one someone, not two
    expect( models[0]!.keid ).toBe('slack:U7')
    expect( models[0]!.name ).toBe('Mara')
    expect( models[0]!.intention ).toBe('collaborate')               // the alias's ToM folded in
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.tracker.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 2.1 — the cross-modal binder. KnownEntityTracker subscribes to
 * senses.*.percept and accretes a dossier per sourceEntityId: familiarity (mere-exposure,
 * rises per encounter / decays in absence), a channel-supplied name, kind, and a
 * resolution confidence. Identity is provisional — the keid (the perception referent)
 * exists before any name. Deterministic: accretion/decay are pure functions of percepts
 * + sim-tick.
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'

const percept = ( keid: string, opts: { domain?: string; name?: string; salience?: number } = {} ) => ( {
  type:     `senses.${opts.domain ?? 'audition'}.percept`,
  salience: opts.salience ?? 0.6,
  payload:  { domain: opts.domain ?? 'audition', sourceEntityId: keid, timestamp: 0, salience: opts.salience ?? 0.6,
              raw: opts.name ? { speakerName: opts.name } : {} },
} as any )

const emptyState = ( tick = 100 ) => ( { tick, entities: new Map(), metrics: new Map() } as any )

describe('KnownEntityTracker — perceptual dossier accretion', () => {
  it('creates a dossier on first encounter, with the channel-supplied name + kind', async () => {
    const t = new KnownEntityTracker()
    expect( t.getDossier('alex') ).toBeUndefined()

    t.onCognitiveEvent( percept('alex', { name: 'Alex' } ) )
    await t.react( 1000 as any, 100 as any, emptyState(), {} as any )

    const d = t.getDossier('alex')!
    expect( d ).toBeDefined()
    expect( d.name ).toBe('Alex')
    expect( d.kind ).toBe('sentient')            // audition → a mind
    expect( d.encounterCount ).toBe( 1 )
    expect( d.familiarity ).toBeCloseTo( 0.15, 5 ) // 0 + 0.15·(1−0)
    expect( d.resolutionConfidence ).toBeCloseTo( 0.45, 5 ) // name 0.4 + 1·0.05
  } )

  it('familiarity rises with repeated encounters and fades in absence', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( percept('alex') )
    await t.react( 1000 as any, 100 as any, emptyState(), {} as any )
    const f1 = t.getDossier('alex')!.familiarity

    t.onCognitiveEvent( percept('alex') )
    await t.react( 1000 as any, 101 as any, emptyState(), {} as any )
    const f2 = t.getDossier('alex')!.familiarity
    expect( f2 ).toBeGreaterThan( f1 )             // another exposure warms it

    await t.react( 1000 as any, 102 as any, emptyState(), {} as any )  // no encounter
    expect( t.getDossier('alex')!.familiarity ).toBeLessThan( f2 )   // absence dims it
  } )

  it('knows *someone* before a name — keid referent exists, name stays empty', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( percept('web:42') )      // no speakerName
    await t.react( 1000 as any, 100 as any, emptyState(), {} as any )
    const d = t.getDossier('web:42')!
    expect( d.name ).toBeUndefined()
    expect( d.encounterCount ).toBe( 1 )
  } )

  it('ignores the self (agent-self) and persists a ke-<keid> dossier entity', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( percept('agent-self') )
    t.onCognitiveEvent( percept('alex', { name: 'Alex' } ) )
    const r = await t.react( 1000 as any, 100 as any, emptyState(), {} as any )

    expect( t.getDossier('agent-self') ).toBeUndefined()
    // The dossier is keyed by the ANCHOR now, not by the address it was met at, so
    // the entity id is no longer predictable from the percept. What matters is
    // that a dossier was persisted carrying the learned name — and that the
    // address still resolves to it.
    const ke = ( r.commands?.set ?? [] ).find( ( e: any ) => e.type === 'known-entity')
    expect( ke?.metadata?.name ).toBe('Alex')
    expect( t.getDossier('alex')?.name ).toBe('Alex')

    // …and the address was recorded as an alias of that anchor, or the mind would
    // mint a SECOND anchor for the same person on the next boot and fork them.
    const alias = ( r.commands?.set ?? [] ).find( ( e: any ) => e.type === 'known-entity-alias')
    expect( alias?.metadata?.aliasKeid ).toBe('alex')
    expect( alias?.metadata?.canonicalKeid ).toBe( ke?.metadata?.keid )
  } )

  it('applies a conscious known.entity.learned update — name, eased feeling, resolution (2.2)', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( { type: 'known.entity.learned', salience: 0.5, payload: { keid: 'web:42', name: 'Mara', feeling: 0.6 } } as any )
    await t.react( 1000 as any, 100 as any, emptyState(), {} as any )
    const d = t.getDossier('web:42')!
    expect( d.name ).toBe('Mara')
    expect( d.valence ).toBeCloseTo( 0.3, 5 )              // eased 0 → 0.6 by 0.5
    expect( d.resolutionConfidence ).toBeGreaterThan( 0 )  // a name identifies a referent
  } )

  it('persists a named-but-unseen someone (conscious-only, no perceptual encounter)', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( { type: 'known.entity.learned', salience: 0.5, payload: { keid: 'rumored', name: 'Quinn' } } as any )
    const r = await t.react( 1000 as any, 100 as any, emptyState(), {} as any )
    // Keyed by the anchor, so the entity id is no longer derivable from the name
    // the mind heard them called. What must hold is that the dossier exists, and
    // that the handle it was heard under still finds them.
    const ke = ( r.commands?.set ?? [] ).find( ( e: any ) => e.type === 'known-entity')
    expect( ke?.metadata?.name ).toBe('Quinn')
    expect( t.getDossier('rumored')?.name ).toBe('Quinn')
  } )

  it('rehydrates dossiers from persisted state on first tick (restore parity)', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-sam', { id: 'ke-sam', type: 'known-entity',
      metadata: { keid: 'sam', kind: 'sentient', name: 'Sam', familiarity: 0.5, valence: 0, encounterCount: 3, lastSeenTick: 40, resolutionConfidence: 0.55 } } )
    await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )

    const d = t.getDossier('sam')!
    expect( d ).toBeDefined()
    expect( d.name ).toBe('Sam')
    expect( d.encounterCount ).toBe( 3 )
    // Restored 0.5, minus one tick of decay — at the rate for a KNOWN someone.
    // Sam has a name, so he fades over days rather than minutes: the single old
    // rate (0.005/tick) spent the whole scale in under four minutes at a 1s tick,
    // which is why familiarity measured 0.00 on a live mind after 71 encounters.
    // An unresolved blip still decays at the old speed — see BLIP_DECAY_RATE.
    expect( d.familiarity ).toBeCloseTo( 0.49998, 5 )
  } )
} )

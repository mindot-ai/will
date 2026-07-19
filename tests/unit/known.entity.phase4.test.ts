// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.phase4.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 4 — generalise to `thing`. The dossier mechanism is kind-agnostic:
 * a non-audition percept binds a `thing`; reliability is a track-record earned from action
 * outcomes targeting the entity (general — a tool/place/person); and a faded, unidentified
 * blip is forgotten (familiarity floor → the dossier is dropped + its entity deleted).
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'

const percept = ( keid: string, domain: string ) => ( {
  type: `senses.${domain}.percept`, salience: 0.6,
  payload: { domain, sourceEntityId: keid, timestamp: 0, salience: 0.6, raw: {} },
} as any )

const outcome = ( keid: string, success: boolean ) => ( {
  type: 'action.outcome', salience: 0.5, payload: { targetEntityId: keid, success, outcomeQuality: success ? 0.9 : 0.1 },
} as any )

const empty = ( tick = 100 ) => ( { tick, entities: new Map(), metrics: new Map() } as any )

describe('KnownEntityTracker — Phase 4 (things, reliability, forgetting)', () => {
  it('binds a non-audition percept as a thing', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( percept('door-3', 'vision') )
    await t.react( 1000 as any, 100 as any, empty(), {} as any )
    expect( t.getDossier('door-3')!.kind ).toBe('thing')
  } )

  it('earns reliability from action outcomes targeting a known entity', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( percept('tool-7', 'vision') )            // it exists (perceived)
    await t.react( 1000 as any, 100 as any, empty(), {} as any )
    expect( t.getDossier('tool-7')!.reliability ).toBe( 0.5 )    // unknown

    t.onCognitiveEvent( outcome('tool-7', true ) )
    await t.react( 1000 as any, 101 as any, empty( 101 ), {} as any )
    expect( t.getDossier('tool-7')!.reliability ).toBeCloseTo( 0.6, 5 )   // 0.5 + 0.2·(1−0.5)

    t.onCognitiveEvent( outcome('tool-7', false ) )
    await t.react( 1000 as any, 102 as any, empty( 102 ), {} as any )
    expect( t.getDossier('tool-7')!.reliability ).toBeLessThan( 0.6 )     // a failure dents it
  } )

  it('does not conjure a dossier from an outcome alone (must be known first)', async () => {
    const t = new KnownEntityTracker()
    t.onCognitiveEvent( outcome('never-seen', true ) )
    await t.react( 1000 as any, 100 as any, empty(), {} as any )
    expect( t.getDossier('never-seen') ).toBeUndefined()
  } )

  it('forgets a faded, unidentified blip (familiarity floor → dropped + deleted)', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-blip', { id: 'ke-blip', type: 'known-entity',
      metadata: { keid: 'blip', kind: 'thing', familiarity: 0.022, valence: 0, reliability: 0.5, encounterCount: 1, lastSeenTick: 10, resolutionConfidence: 0.1 } } )
    const r = await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )

    expect( t.getDossier('blip') ).toBeUndefined()              // decayed below the floor → forgotten
    expect( r.commands?.delete ?? [] ).toContain('ke-blip')
  } )

  it('keeps a named entity even when faded (identity-constitutive, never forgotten)', async () => {
    const t = new KnownEntityTracker()
    const entities = new Map<string, any>()
    entities.set('ke-mara', { id: 'ke-mara', type: 'known-entity',
      metadata: { keid: 'mara', kind: 'sentient', name: 'Mara', familiarity: 0.01, valence: 0, reliability: 0.5, encounterCount: 4, lastSeenTick: 5, resolutionConfidence: 0.6 } } )
    await t.react( 1000 as any, 100 as any, { tick: 100, entities, metrics: new Map() } as any, {} as any )
    expect( t.getDossier('mara') ).toBeDefined()               // a known someone is not forgotten
  } )
} )

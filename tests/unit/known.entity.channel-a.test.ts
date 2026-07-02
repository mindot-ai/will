// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.channel-a.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Channel A read-path for the known-entity tracker. The tracker reads its dispositions as
 * effective (base engine-config-known-entity ⊕ persona-prior) each tick, so a developed
 * trait actually changes behaviour: curiosityGain scales the pull-to-know; reliabilityRate
 * sets how fast a track-record judgment moves; familiarityGrowthRate how fast a sense forms.
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'

const cfg = ( params: Record<string, number> ) =>
  ( { id: 'engine-config-known-entity', type: 'engine-config', metadata: { params } } )

const dossier = ( keid: string, familiarity: number, resolution: number, reliability = 0.5 ) =>
  ( { id: `ke-${keid}`, type: 'known-entity',
      metadata: { keid, kind: 'sentient', familiarity, valence: 0, reliability, encounterCount: 3, lastSeenTick: 10, resolutionConfidence: resolution } } )

const stateWith = ( params: Record<string, number>, ...extra: any[] ) => {
  const entities = new Map<string, any>()
  entities.set( 'engine-config-known-entity', cfg( params ) )
  for( const e of extra ) entities.set( e.id, e )
  return { tick: 100, entities, metrics: new Map() } as any
}

const drive = ( r: any ) => ( r.commands?.metrics ?? [] ).find( ( [ k ]: [string, number] ) => k === 'drive.curiosity_resolve' )?.[1]

describe( 'KnownEntityTracker — Channel A (effective config drives the dispositions)', () => {
  it( 'a higher effective curiosityGain scales the curiosity drive up', async () => {
    const lo = await new KnownEntityTracker().react( 1000 as any, 100 as any, stateWith( { curiosityGain: 1.0 }, dossier( 'x', 0.5, 0.2 ) ), {} as any )
    const hi = await new KnownEntityTracker().react( 1000 as any, 100 as any, stateWith( { curiosityGain: 2.0 }, dossier( 'x', 0.5, 0.2 ) ), {} as any )
    expect( drive( hi ) ).toBeGreaterThan( drive( lo )! )
  } )

  it( 'a higher effective reliabilityRate revises the track-record faster', async () => {
    const slow = new KnownEntityTracker()
    slow.onCognitiveEvent( { type: 'action.outcome', salience: 0.5, payload: { targetEntityId: 'x', success: true } } as any )
    await slow.react( 1000 as any, 100 as any, stateWith( { reliabilityRate: 0.1 }, dossier( 'x', 0.5, 0.2 ) ), {} as any )

    const fast = new KnownEntityTracker()
    fast.onCognitiveEvent( { type: 'action.outcome', salience: 0.5, payload: { targetEntityId: 'x', success: true } } as any )
    await fast.react( 1000 as any, 100 as any, stateWith( { reliabilityRate: 0.5 }, dossier( 'x', 0.5, 0.2 ) ), {} as any )

    expect( fast.getDossier( 'x' )!.reliability ).toBeGreaterThan( slow.getDossier( 'x' )!.reliability )
  } )
} )

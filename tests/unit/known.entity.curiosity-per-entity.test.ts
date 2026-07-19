// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.curiosity-per-entity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 3.b — per-entity curiosity ("who *was* that?"). For a familiar-yet-
 * unresolved referent the tracker raises a specific attention.demand; GoalManager turns it
 * into a per-keid goal "get to know <name|someone>" that completes on *that* referent's
 * resolution. The pull subsides once resolved. (keids may contain ':', so the per-keid
 * metric name is sanitised to satisfy the [\w.] completion-condition parser.)
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'
import { GoalManager } from '#faculties/goal.manager'

const setOf = ( r: any, id: string ) => ( r.commands?.set ?? [] ).find( ( e: any ) => e.id === id )
const metricOf = ( r: any, key: string ) => ( r.commands?.metrics ?? [] ).find( ( [ k ]: [string, number] ) => k === key )?.[1]

const stateWithDossier = ( keid: string, familiarity: number, resolution: number, extra: any[] = [] ) => {
  const entities = new Map<string, any>()
  entities.set(`ke-${keid}`, { id: `ke-${keid}`, type: 'known-entity',
    metadata: { keid, kind: 'sentient', name: 'Mara', familiarity, valence: 0, encounterCount: 5, lastSeenTick: 10, resolutionConfidence: resolution } } )
  for( const e of extra ) entities.set( e.id, e )
  return { tick: 100, entities, metrics: new Map() } as any
}

describe('KnownEntityTracker — per-entity curiosity demand', () => {
  it('raises a curiosity attention.demand for a familiar-yet-unresolved referent', async () => {
    const t = new KnownEntityTracker()
    const r = await t.react( 1000 as any, 100 as any, stateWithDossier('web:42', 0.6, 0.2 ), {} as any )

    const demand = setOf( r, 'curiosity-web:42')
    expect( demand?.type ).toBe('attention.demand')
    expect( demand?.metadata?.goalTags ).toContain('keid:web:42')
    expect( demand?.metadata?.goalCompletionType ).toBe('metric')
    expect( demand?.metadata?.goalCompletionCondition ).toBe('known_entity.web_42.resolution >= 0.6')
    expect( metricOf( r, 'known_entity.web_42.resolution') ).toBeCloseTo( 0.2, 5 )
  } )

  it('clears the demand once the referent is resolved', async () => {
    const t = new KnownEntityTracker()
    const existingDemand = { id: 'curiosity-web:42', type: 'attention.demand', metadata: {} }
    const r = await t.react( 1000 as any, 100 as any, stateWithDossier('web:42', 0.8, 0.7, [ existingDemand ] ), {} as any )
    expect( r.commands?.delete ?? [] ).toContain('curiosity-web:42')
    expect( setOf( r, 'curiosity-web:42') ).toBeUndefined()
  } )

  it('raises no demand for an unfamiliar referent', async () => {
    const t = new KnownEntityTracker()
    const r = await t.react( 1000 as any, 100 as any, stateWithDossier('web:42', 0.2, 0.1 ), {} as any )
    expect( setOf( r, 'curiosity-web:42') ).toBeUndefined()
  } )
} )

describe('GoalManager — per-entity curiosity goal from the demand', () => {
  const demandEntity = () => ( {
    id: 'curiosity-web:42', type: 'attention.demand',
    metadata: {
      generatesGoal: true, goalDescription: 'Get to know Mara', goalPriority: 0.45,
      goalTags: [ 'curiosity', 'known-entity', 'keid:web:42' ],
      goalCompletionType: 'metric', goalCompletionCondition: 'known_entity.web_42.resolution >= 0.6',
    },
  } )
  const stateWith = ( tick: number, resolution: number ) => {
    const entities = new Map<string, any>(); entities.set('curiosity-web:42', demandEntity() )
    return { tick, entities, metrics: new Map( [ [ 'known_entity.web_42.resolution', resolution ] ] ) } as any
  }
  const keidGoals = ( gm: GoalManager ) => gm.getActiveGoals().filter( g => g.tags.includes('keid:web:42') )

  it('creates a per-keid metric goal keyed to that referent', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as any, 100 as any, stateWith( 100, 0.2 ), {} as any )
    const goals = keidGoals( gm )
    expect( goals ).toHaveLength( 1 )
    expect( goals[0]!.description ).toBe('Get to know Mara')
    expect( goals[0]!.completionType ).toBe('metric')
    expect( goals[0]!.status ).toBe('active')
  } )

  it('dedups by referent and never spawns one already resolved', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as any, 100 as any, stateWith( 100, 0.2 ), {} as any )
    await gm.react( 1000 as any, 101 as any, stateWith( 101, 0.2 ), {} as any )
    expect( keidGoals( gm ) ).toHaveLength( 1 )                  // deduped by keid: tag

    const gm2 = new GoalManager()
    await gm2.react( 1000 as any, 100 as any, stateWith( 100, 0.8 ), {} as any )   // already resolved
    expect( keidGoals( gm2 ) ).toHaveLength( 0 )                 // born-done guard
  } )
} )

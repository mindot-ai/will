// ─────────────────────────────────────────────────────────────
// tests/unit/known.entity.curiosity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity Phase 3.a — curiosity-to-resolve (the aggregate drive). A familiar-yet-
 * unknown someone the Will keeps meeting generates an epistemic pull: the tracker emits a
 * `drive.curiosity_resolve` metric (peaks at high familiarity × low resolution), and the
 * GoalManager turns a sustained drive into an epistemic "get to know them" goal that
 * resolves as the Will learns (belief formation). Deterministic; safe under the
 * born-done / age-0 guards (the goal has no completionCondition, so it's never born done).
 */

import { describe, it, expect } from 'vitest'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'
import { GoalManager } from '#faculties/goal.manager'

const metricOf = ( r: any, key: string ): number | undefined =>
  ( r.commands?.metrics ?? [] ).find( ( [ k ]: [string, number] ) => k === key )?.[1]

const dossierState = ( keid: string, familiarity: number, resolutionConfidence: number ) => {
  const entities = new Map<string, any>()
  entities.set( `ke-${keid}`, { id: `ke-${keid}`, type: 'known-entity',
    metadata: { keid, kind: 'sentient', familiarity, valence: 0, encounterCount: 5, lastSeenTick: 10, resolutionConfidence } } )
  return { tick: 100, entities, metrics: new Map() } as any
}

describe( 'KnownEntityTracker — curiosity-to-resolve drive', () => {
  it( 'peaks for a familiar-yet-unresolved entity', async () => {
    const t = new KnownEntityTracker()
    const r = await t.react( 1000 as any, 100 as any, dossierState( 'x', 0.8, 0.1 ), {} as any )
    expect( metricOf( r, 'drive.curiosity_resolve' ) ).toBeGreaterThan( 0.5 )   // ≈0.795·0.9
  } )

  it( 'stays near zero for a well-resolved entity', async () => {
    const t = new KnownEntityTracker()
    const r = await t.react( 1000 as any, 100 as any, dossierState( 'y', 0.8, 0.9 ), {} as any )
    expect( metricOf( r, 'drive.curiosity_resolve' ) ).toBeLessThan( 0.2 )       // ≈0.795·0.1
  } )

  it( 'is zero when the Will knows no one', async () => {
    const t = new KnownEntityTracker()
    const r = await t.react( 1000 as any, 100 as any, { tick: 100, entities: new Map(), metrics: new Map() } as any, {} as any )
    expect( metricOf( r, 'drive.curiosity_resolve' ) ).toBe( 0 )
  } )
} )

describe( 'GoalManager — curiosity drive spawns an epistemic goal', () => {
  const stateWith = ( tick: number, metrics: Record<string, number> ) =>
    ( { tick, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) } as any )
  const curiosityGoals = ( gm: GoalManager ) => gm.getActiveGoals().filter( g => g.tags.includes( 'curiosity' ) )

  it( 'creates a "get to know them" epistemic goal when the drive is sustained', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as any, 100 as any, stateWith( 100, { 'drive.curiosity_resolve': 0.6 } ), {} as any )
    const goals = curiosityGoals( gm )
    expect( goals ).toHaveLength( 1 )
    expect( goals[0]!.completionType ).toBe( 'epistemic' )
    expect( goals[0]!.status ).toBe( 'active' )          // never born done (no completionCondition)
  } )

  it( 'does not spawn when the curiosity drive is low', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as any, 100 as any, stateWith( 100, { 'drive.curiosity_resolve': 0.2 } ), {} as any )
    expect( curiosityGoals( gm ) ).toHaveLength( 0 )
  } )

  it( 'does not duplicate while one is already active', async () => {
    const gm = new GoalManager()
    await gm.react( 1000 as any, 100 as any, stateWith( 100, { 'drive.curiosity_resolve': 0.6 } ), {} as any )
    await gm.react( 1000 as any, 101 as any, stateWith( 101, { 'drive.curiosity_resolve': 0.6 } ), {} as any )
    expect( curiosityGoals( gm ) ).toHaveLength( 1 )
  } )
} )

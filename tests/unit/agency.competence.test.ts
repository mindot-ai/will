// ─────────────────────────────────────────────────────────────
// tests/unit/agency.competence.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 6 — portable competence. Proves a grown Will's learned skills and
// composites survive re-embodiment: distill from one repertoire, load into a
// fresh one, and the habits/templates come back. Fleeting skills fade.

import { describe, it, expect } from 'vitest'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { distillCompetence, loadCompetence, COMPETENCE_SCHEMA_VERSION } from '#agency/competence.codec'
import type { MotorSchema } from '#agency/types'

const COMPOSITE: MotorSchema = {
  id: 'settle-self', kind: 'composite', source: 'repertoire', binds: 'none', cost: 0.1,
  composedOf: [ 'withdraw', 'rest', 'reflect' ], tags: [ 'self-care' ],
}

/** Grow a habit by feeding confident, predictable successes. */
function grow( rep: SchemaRepertoire, schema: string, n: number ): void {
  for( let i = 0; i < n; i++ )
    rep.recordOutcome({ schema, success: true, outcomeQuality: 0.9, predictedReward: 0.9, tick: i })
}

describe( 'competence codec — distill', () => {
  it( 'carries strong skills and their composite templates, drops fleeting ones', () => {
    const rep = new SchemaRepertoire()
    rep.registerComposite( COMPOSITE )
    grow( rep, 'rest', 12 )          // strong innate habit
    grow( rep, 'settle-self', 12 )   // strong learned composite
    grow( rep, 'wait', 1 )           // barely practiced → below floor

    const snap = distillCompetence( rep )

    expect( snap.schemaVersion ).toBe( COMPETENCE_SCHEMA_VERSION )
    const carried = new Set( snap.skills.map( s => s.schema ) )
    expect( carried.has( 'rest' ) ).toBe( true )
    expect( carried.has( 'settle-self' ) ).toBe( true )
    expect( carried.has( 'wait' ) ).toBe( false )                       // fleeting → faded
    expect( snap.composites.map( c => c.id ) ).toContain( 'settle-self' ) // template rides along
  })
})

describe( 'competence codec — round-trip across re-embodiment', () => {
  it( 'a fresh repertoire reloads the learned habits and composite, ready to run', () => {
    const lived = new SchemaRepertoire()
    lived.registerComposite( COMPOSITE )
    grow( lived, 'rest', 12 )
    grow( lived, 'settle-self', 12 )

    const snap = distillCompetence( lived )

    // New embodiment: a fresh repertoire knows nothing yet.
    const reborn = new SchemaRepertoire()
    expect( reborn.getSkill( 'rest' ) ).toBeUndefined()
    expect( reborn.getSchema( 'settle-self' ) ).toBeUndefined()

    loadCompetence( snap, reborn )

    // …and now it acts like itself.
    expect( reborn.getSkill( 'rest' )!.habitStrength ).toBeGreaterThanOrEqual( 0.6 )
    expect( reborn.getSchema( 'settle-self' ) ).toBeDefined()           // composite runnable again
    const composite = reborn.getSkill( 'settle-self' )!
    expect( composite.habitStrength ).toBeCloseTo( lived.getSkill( 'settle-self' )!.habitStrength, 5 )
  })

  it( 'ignores a snapshot from an incompatible schema version', () => {
    const rep = new SchemaRepertoire()
    loadCompetence( { schemaVersion: 999, composites: [], skills: [] }, rep )
    expect( rep.skills().size ).toBe( 0 )
  })
})

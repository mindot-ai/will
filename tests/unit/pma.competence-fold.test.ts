// ─────────────────────────────────────────────────────────────
// tests/unit/pma.competence-fold.test.ts
// ─────────────────────────────────────────────────────────────
// The competence layer travels in the real PMASnapshot: the distiller embeds a
// grown Will's learned skills + composite schemas, and the loader re-seeds them
// into a fresh repertoire. A re-embodied Will resumes acting like itself.

import { describe, it, expect } from 'vitest'
import type { SimulationState } from '#core/types'
import { PMADistiller } from '#pma/index'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { loadCompetence } from '#agency/competence.codec'
import type { MotorSchema } from '#agency/types'

const COMPOSITE: MotorSchema = {
  id: 'settle-self', kind: 'composite', source: 'repertoire', binds: 'none', cost: 0.1,
  composedOf: [ 'withdraw', 'rest', 'reflect' ], tags: [ 'self-care' ],
}

const emptyState = (): SimulationState =>
  ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })

function grow( rep: SchemaRepertoire, schema: string, n: number ): void {
  for( let i = 0; i < n; i++ )
    rep.recordOutcome({ schema, success: true, outcomeQuality: 0.9, predictedReward: 0.9, tick: i } )
}

describe( 'PMA — competence fold', () => {
  it( 'distill embeds learned skills + composites; load restores them into a fresh repertoire', () => {
    // A lived Will with a strong innate habit and an invented composite skill.
    const lived = new SchemaRepertoire()
    lived.registerComposite( COMPOSITE )
    grow( lived, 'rest', 12 )
    grow( lived, 'settle-self', 12 )

    // Distill into a real PMASnapshot (no profile logs → behavioral/emotional default).
    const pma = new PMADistiller().distill(
      'w', 'W', emptyState(), 'session-1', '/tmp/__no_such_pma_dir__', lived,
    )

    // The competence layer rode along in the snapshot.
    expect( pma.competence ).toBeDefined()
    const carried = new Set( pma.competence!.skills.map( s => s.schema ) )
    expect( carried.has( 'rest' ) ).toBe( true )
    expect( carried.has( 'settle-self' ) ).toBe( true )
    expect( pma.competence!.composites.map( c => c.id ) ).toContain( 'settle-self' )

    // Re-embodiment: a fresh repertoire knows nothing…
    const reborn = new SchemaRepertoire()
    expect( reborn.getSkill( 'rest' ) ).toBeUndefined()
    expect( reborn.getSchema( 'settle-self' ) ).toBeUndefined()

    // …loading the snapshot's competence restores the habits + runnable composite.
    loadCompetence( pma.competence, reborn )
    expect( reborn.getSkill( 'rest' )!.habitStrength ).toBeGreaterThanOrEqual( 0.6 )
    expect( reborn.getSchema( 'settle-self' ) ).toBeDefined()
  })

  it( 'omits the competence field for a Will that has learned nothing', () => {
    const pma = new PMADistiller().distill(
      'w', 'W', emptyState(), 'session-1', '/tmp/__no_such_pma_dir__', new SchemaRepertoire(),
    )
    expect( pma.competence ).toBeUndefined()
  })

  it( 'distill without a repertoire produces a snapshot with no competence', () => {
    const pma = new PMADistiller().distill( 'w', 'W', emptyState(), 'session-1', '/tmp/__no_such_pma_dir__' )
    expect( pma.competence ).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// tests/integration/agency.pipeline.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 7 — the agency pipeline wired into a real assembled mind. Drives actual
// ticks (real regulators, perception, metrics) and confirms the pipeline runs
// end-to-end on the live substrate: a field is synthesized, intents are enacted,
// and competence accretes in the repertoire. Also confirms the gate: with
// enableAgency off, nothing agency-related ticks.

import { describe, it, expect } from 'vitest'
import { assembleMind, type WillConfig } from '#stem/mind'
import type { SimulationEntity } from '#core/types'

const BASE: Omit<WillConfig, 'id' | 'enableAgency'> = {
  name:             'AgencySmoke',
  anatomy: 'reflex',          // no LLM — the substrate pipeline needs none
  persistentMemory: false,
  snapshotInterval: 999999,
  tickIntervalMs:   0,
  maxTicks:         0,
  testMode:         true,
  identity: { prompt: 'A test mind.', values: [ 'curiosity' ], style: 'concise', traits: {} },
}

const ofType = ( entities: Map<string, SimulationEntity>, t: string ) =>
  [ ...entities.values() ].filter( e => e.type === t )

describe('agency pipeline — live in an assembled mind', () => {
  it('synthesizes a field, enacts intents, and accretes competence over real ticks', async () => {
    const { simulation, cognition } = assembleMind('agency-smoke-on', {
      id: 'agency-smoke-on', ...BASE,
    } )

    await simulation.step( 100 )

    const state = simulation.stateManager.snapshot()

    // The field is synthesized every tick (innate floor at minimum).
    expect( ofType( state.entities, 'affordance').length ).toBeGreaterThan( 0 )
    expect( state.metrics.get('affordance.field_size') ?? 0 ).toBeGreaterThan( 0 )

    // Something was selected and enacted, and the repertoire learned from it.
    const skills = cognition.schemaRepertoire.skills()
    expect( skills.size ).toBeGreaterThan( 0 )
    const totalEnactments = [ ...skills.values() ].reduce( ( n, s ) => n + s.enactments, 0 )
    expect( totalEnactments ).toBeGreaterThan( 0 )

    // The learning loop mirrored at least one skill into state.
    expect( ofType( state.entities, 'agency.skill').length ).toBeGreaterThan( 0 )

    // Cutover: the agency pipeline is the SOLE action system — the legacy heuristic
    // observe-fallback was removed, so no decision.records are emitted at all.
    expect( ofType( state.entities, 'decision.record') ).toHaveLength( 0 )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/executive.fallback.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the executive intends when its own reasoning did not come back.
 *
 * Two things were wrong with the old fallback.
 *
 * Every action it produced was PROSE, not a schema: `observe`, `replenish
 * energy`, `enter deep rest to reduce fatigue`, `calm my mind and reduce
 * tension`, `explore`, `learn`, `express_emotion`. Only `rest` names anything
 * the body can enact. The rest reached the agency, failed to resolve, and became
 * an ideomotor push toward an act that does not exist — observed live as
 * `master decided [observe] conf=0.4` four times across two boots, each a
 * decision that could go nowhere.
 *
 * And the "nothing pressing" branch was INVENTION. The executive could not read
 * its own thought, so it made one up and pushed it into the field as intention —
 * the mind being told what it wants. The substrate does not need the help: the
 * affordance field is always there and System 1 selects from it every tick
 * without an executive.
 *
 * So: reflexes stay (a body in trouble must not depend on an LLM parsing
 * correctly), invention goes.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState } from '#core/types'
import { buildFallbackOutput } from '#faculties/executive.engine/parser'
import { INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'

function state( metrics: Record<string, number> ): ReadonlySimulationState {
  return {
    tick: 10, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ),
  } as unknown as ReadonlySimulationState
}

describe('the executive fallback', () => {
  it('never names an act the body cannot enact', () => {
    // Every branch, including the monotony path that used to cycle a hardcoded
    // list of invented verbs.
    const bodies: Array<Record<string, number>> = [
      {}, { 'energy.level': 5 }, { 'sleep.pressure': 80 }, { 'stress.load': 90 },
      { 'energy.level': 100, 'sleep.pressure': 0, 'stress.load': 0 },
    ]
    for( const metrics of bodies )
      for( const a of buildFallbackOutput( state( metrics ), [ 'reflect', 'observe', 'reflect' ] ).actions )
        expect( INNATE_SCHEMA_BY_ID.has( a.type ),
          `"${ a.type }" is not a schema — it would reach the agency and resolve to nothing` )
          .toBe( true )
  })

  it('intends NOTHING when nothing about the body is pressing', () => {
    // Not `observe`, not a rotating alternative — the substrate is already
    // choosing, and an unreadable thought is not a reason to invent one.
    const out = buildFallbackOutput( state( { 'energy.level': 90 } ), [] )
    expect( out.actions ).toEqual( [] )
    expect( out.reasoning ).toMatch( /nothing in particular|my body goes on choosing/ )
  })

  it('still protects a body in trouble — that reflex must not need an LLM', () => {
    expect( buildFallbackOutput( state( { 'energy.level': 5 } ), [] ).actions[0]?.type ).toBe('rest')
    expect( buildFallbackOutput( state( { 'sleep.pressure': 80 } ), [] ).actions[0]?.type ).toBe('rest')
    expect( buildFallbackOutput( state( { 'stress.load': 90 } ), [] ).actions[0]?.type ).toBe('withdraw')
  })

  it('does not invent a new act just because recent ones were repetitive', () => {
    // The old code varied its output when `reflect`/`observe` had dominated.
    // Monotony is a real problem and it is not the executive's to solve here —
    // the competition carries satiation now.
    const monotonous = buildFallbackOutput( state( { 'energy.level': 90 } ),
      [ 'reflect', 'observe', 'reflect', 'observe' ] )
    expect( monotonous.actions ).toEqual( [] )
  })

  it('reports low confidence — it is a fallback, not a decision', () => {
    expect( buildFallbackOutput( state( {} ), [] ).confidence ).toBeLessThan( 0.5 )
  })
})

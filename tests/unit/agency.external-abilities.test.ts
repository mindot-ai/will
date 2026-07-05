// ─────────────────────────────────────────────────────────────
// tests/unit/agency.external-effectors.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Custom domain effectors a host declares (a profile's move/attack/trade, or
 * allowedGenericEffectors) must reach the agency field as enactable schemas and
 * route to the world via the `external` enaction mode. Before this fix the
 * repertoire/synthesizer were seeded innate-only, so a Will could never choose a
 * host-owned effector. See CUSTOM_EFFECTOR_WIRING_TODO.md.
 */

import { describe, it, expect } from 'vitest'
import { externalSchemas, INNATE_SCHEMAS, SchemaRepertoire } from '#agency/index'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { modeOf } from '#agency/execution.primitives'

const CTX = {} as any
const emptyState = () => ( { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as any )

describe( 'agency — host-owned custom effectors reach the field', () => {
  it( 'builds external schemas, excluding comms + innate-shadowing names + dups', () => {
    const schemas = externalSchemas( [ 'move', 'attack', 'talk', 'rest', 'move' ] )
    expect( schemas.map( s => s.id ) ).toEqual( [ 'move', 'attack' ] )  // talk=comms, rest=innate, dup dropped
    expect( schemas.every( s => s.source === 'external' && s.binds === 'none' && !!s.tags?.includes( 'external' ) ) ).toBe( true )
  } )

  it( 'routes an external schema to the host via the external enaction mode', () => {
    const attack = externalSchemas( [ 'attack' ] )[0]!
    expect( modeOf( attack ) ).toBe( 'external' )
  } )

  it( 'the synthesizer surfaces a declared custom effector as an available affordance', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [ 'attack', 'talk' ] ) ] )
    const synth = new AffordanceSynthesizer()
    synth.attachRepertoire( repertoire )

    const res   = await synth.react( 0, 1, emptyState(), CTX )
    const field = ( res.commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance' )
    const bySchema = new Map( field.map( ( e: any ) => [ e.metadata?.schema, e.metadata ] ) )

    expect( bySchema.has( 'attack' ) ).toBe( true )            // custom effector now in the field
    expect( ( bySchema.get( 'attack' ) as any )?.available ).toBe( true )
    expect( bySchema.has( 'talk' ) ).toBe( false )             // comms are not external floor affordances
  } )
} )

describe( 'agency — rich effector declarations (Phase 2)', () => {
  it( 'seeds cost / valence / preconditions / description onto the schema', () => {
    const [ give ] = externalSchemas( [ {
      name: 'give', description: 'Offer an item to someone present',
      cost: 0.4, valence: 0.3,
      preconditions: [ { metric: 'energy.level', op: 'gte', value: 20 } ],
    } ] )
    expect( give ).toMatchObject( {
      id: 'give', source: 'external', binds: 'none',
      cost: 0.4, baseValence: 0.3,
      description: 'Offer an item to someone present',
      preconditions: [ { metric: 'energy.level', op: 'gte', value: 20 } ],
    } )
  } )

  it( 'a bare name keeps the flat defaults (back-compat)', () => {
    const [ move ] = externalSchemas( [ 'move' ] )
    expect( move ).toMatchObject( { id: 'move', cost: 0.15, baseValence: 0 } )
    expect( move!.description ).toBeUndefined()
    expect( move!.preconditions ).toBeUndefined()
  } )

  it( 'mixes bare names and rich objects, and clamps out-of-range cost/valence', () => {
    const schemas = externalSchemas( [ 'move', { name: 'lunge', cost: 5, valence: -9 } ] )
    expect( schemas.map( s => s.id ) ).toEqual( [ 'move', 'lunge' ] )
    expect( schemas[1] ).toMatchObject( { cost: 1, baseValence: -1 } )   // clamped
  } )

  it( 'a failing precondition makes the affordance unavailable; a passing one keeps it available', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [
      { name: 'sprint', preconditions: [ { metric: 'energy.level', op: 'gte', value: 50 } ] },
    ] ) ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire )
    const avail = async ( energy: number ): Promise<boolean> => {
      const state = { tick: 1, time: 0, entities: new Map(), metrics: new Map( [ [ 'energy.level', energy ] ] ) } as any
      const field = ( ( await synth.react( 0, 1, state, CTX ) ).commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance' )
      return ( new Map( field.map( ( e: any ) => [ e.metadata?.schema, e.metadata ] ) ).get( 'sprint' ) as any )?.available
    }
    expect( await avail( 10 ) ).toBe( false )   // below the gate
    expect( await avail( 80 ) ).toBe( true )    // above the gate
  } )
} )

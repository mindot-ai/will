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

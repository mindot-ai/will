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

describe('agency — host-owned custom effectors reach the field', () => {
  it('builds external schemas, excluding comms + innate-shadowing names + dups', () => {
    const schemas = externalSchemas( [ 'move', 'attack', 'talk', 'rest', 'move' ] )
    expect( schemas.map( s => s.id ) ).toEqual( [ 'move', 'attack' ] )  // talk=comms, rest=innate, dup dropped
    expect( schemas.every( s => s.source === 'external' && s.binds === 'none' && !!s.tags?.includes('external') ) ).toBe( true )
  } )

  it('routes an external schema to the host via the external enaction mode', () => {
    const attack = externalSchemas( [ 'attack' ] )[0]!
    expect( modeOf( attack ) ).toBe('external')
  } )

  it('the synthesizer surfaces a declared custom effector as an available affordance', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [ 'attack', 'talk' ] ) ] )
    const synth = new AffordanceSynthesizer()
    synth.attachRepertoire( repertoire )

    const res   = await synth.react( 0, 1, emptyState(), CTX )
    const field = ( res.commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance')
    const bySchema = new Map( field.map( ( e: any ) => [ e.metadata?.schema, e.metadata ] ) )

    expect( bySchema.has('attack') ).toBe( true )            // custom effector now in the field
    expect( ( bySchema.get('attack') as any )?.available ).toBe( true )
    expect( bySchema.has('talk') ).toBe( false )             // comms are not external floor affordances
  } )
} )

describe('agency — rich effector declarations (Phase 2)', () => {
  it('seeds cost / valence / preconditions / description onto the schema', () => {
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

  it('a bare name keeps the flat defaults (back-compat)', () => {
    const [ move ] = externalSchemas( [ 'move' ] )
    expect( move ).toMatchObject( { id: 'move', cost: 0.15, baseValence: 0 } )
    expect( move!.description ).toBeUndefined()
    expect( move!.preconditions ).toBeUndefined()
  } )

  it('mixes bare names and rich objects, and clamps out-of-range cost/valence', () => {
    const schemas = externalSchemas( [ 'move', { name: 'lunge', cost: 5, valence: -9 } ] )
    expect( schemas.map( s => s.id ) ).toEqual( [ 'move', 'lunge' ] )
    expect( schemas[1] ).toMatchObject( { cost: 1, baseValence: -1 } )   // clamped
  } )

  it('a failing precondition makes the affordance unavailable; a passing one keeps it available', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [
      { name: 'sprint', preconditions: [ { metric: 'energy.level', op: 'gte', value: 50 } ] },
    ] ) ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire )
    const avail = async ( energy: number ): Promise<boolean> => {
      const state = { tick: 1, time: 0, entities: new Map(), metrics: new Map( [ [ 'energy.level', energy ] ] ) } as any
      const field = ( ( await synth.react( 0, 1, state, CTX ) ).commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance')
      return ( new Map( field.map( ( e: any ) => [ e.metadata?.schema, e.metadata ] ) ).get('sprint') as any )?.available
    }
    expect( await avail( 10 ) ).toBe( false )   // below the gate
    expect( await avail( 80 ) ).toBe( true )    // above the gate
  } )
} )

describe('agency — entity-bound effectors', () => {
  const personState = () => ( {
    tick: 1, time: 0,
    entities: new Map( [ [ 'ke-ada', { type: 'known-entity', metadata: {
      keid: 'ada', kind: 'sentient', name: 'Ada',
      familiarity: 0.8, valence: 0.5, resolutionConfidence: 0.9,
    } } ] ] ),
    metrics: new Map(),
  } as any )

  it('declares binds:entity on the schema (default stays none)', () => {
    expect( externalSchemas( [ { name: 'give', binds: 'entity' } ] )[0]!.binds ).toBe('entity')
    expect( externalSchemas( [ { name: 'ponder' } ] )[0]!.binds ).toBe('none')
    expect( externalSchemas( [ 'move' ] )[0]!.binds ).toBe('none')
  } )

  it('binds an entity-effector to each perceived sentient entity, alongside innate reach-out', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [ { name: 'give', binds: 'entity' } ] ) ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire )
    const field = ( ( await synth.react( 0, 1, personState(), CTX ) ).commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance')

    const give = field.find( ( e: any ) => e.metadata?.schema === 'give')
    expect( give?.metadata?.targetEntityId ).toBe('ada')                    // bound to the person
    expect( ( give?.metadata?.parameters as any )?.targetEntityName ).toBe('Ada')
    // additive, not a replacement: the innate entity schema still binds too
    expect( field.some( ( e: any ) => e.metadata?.schema === 'reach-out' && e.metadata?.targetEntityId === 'ada') ).toBe( true )
  } )

  it('leaves an objectless (binds:none) effector unbound — floor affordance, no target', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [ { name: 'wander' } ] ) ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire )
    const field = ( ( await synth.react( 0, 1, personState(), CTX ) ).commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance')
    const wander = field.filter( ( e: any ) => e.metadata?.schema === 'wander')
    expect( wander.length ).toBe( 1 )                          // one floor affordance
    expect( wander[0]?.metadata?.targetEntityId ).toBeUndefined()   // never targeted at the person
  } )
} )

describe('agency — object-binding + routing tags', () => {
  const mixedState = () => ( {
    tick: 1, time: 0,
    entities: new Map( [
      [ 'ke-ada', { type: 'known-entity', metadata: { keid: 'ada', kind: 'sentient', name: 'Ada', familiarity: 0.8 } } ],
      [ 'ke-axe', { type: 'known-entity', metadata: { keid: 'axe', kind: 'thing',    name: 'Axe', familiarity: 0.5 } } ],
    ] ),
    metrics: new Map(),
  } as any )

  it('merges declared tags with external/host (deduped)', () => {
    const [ s ] = externalSchemas( [ { name: 'forage', tags: [ 'nourishment', 'external' ] } ] )
    expect( s!.tags ).toEqual( expect.arrayContaining( [ 'nourishment', 'external', 'host' ] ) )
    expect( s!.tags!.filter( t => t === 'external').length ).toBe( 1 )   // deduped
  } )

  it('declares binds:object on the schema', () => {
    expect( externalSchemas( [ { name: 'use', binds: 'object' } ] )[0]!.binds ).toBe('object')
  } )

  it('binds an object-effector to a thing and a person-effector to a person — never crossed', async () => {
    const repertoire = new SchemaRepertoire( [ ...INNATE_SCHEMAS, ...externalSchemas( [
      { name: 'use',   binds: 'object' },
      { name: 'greet', binds: 'entity' },
    ] ) ] )
    const synth = new AffordanceSynthesizer(); synth.attachRepertoire( repertoire )
    const field = ( ( await synth.react( 0, 1, mixedState(), CTX ) ).commands?.set ?? [] ).filter( ( e: any ) => e.type === 'affordance')
    const targetsOf = ( schema: string ) => field.filter( ( e: any ) => e.metadata?.schema === schema ).map( ( e: any ) => e.metadata?.targetEntityId )

    expect( targetsOf('use') ).toEqual( [ 'axe' ] )     // object-effector → the thing only
    expect( targetsOf('greet') ).toEqual( [ 'ada' ] )   // person-effector → the person only
  } )
} )

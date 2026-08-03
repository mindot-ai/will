// ─────────────────────────────────────────────────────────────
// tests/unit/identity.writer.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * `identity-self` may only be written by `cognition/identity.entity`, and the
 * container may never lend the tenant its name.
 *
 * `identity-self` had four writers and `StateManager.setEntity` REPLACES, so any
 * field a writer did not happen to mention was deleted. Two of them dropped
 * `name`:
 *
 *   • `PMALoader.load` — before the first tick, on every wake.
 *   • `SelfModelUpdater` — on every self-model evaluation, even on a fresh boot.
 *
 * `buildFreshContext` then fell back to the literal string 'Will' — the platform's
 * own name — and rendered it into the mind's system prompt beside a persona that
 * said something else. Measured in production: a Will named Lora read
 *
 *     I am Lora, COO of Mindot...            ← her persona, from her artifact
 *     ## My Role
 *     I am a focused facet of Will ...       ← the container, from the fallback
 *
 * spent 2,773 ticks trying to resolve it, concluded "I am Will. Not Lora.", and
 * told her operator so on a live channel.
 *
 * These tests hold both halves: one writer by construction, and no default name.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  mergeIdentity, identityCommand, readIdentityName, IDENTITY_ENTITY_ID,
} from '#cognition/identity.entity'
import type { StateManager } from '#core/state.manager'
import type { ReadonlySimulationState } from '#core/types'

// ── the guard ─────────────────────────────────────────────────

const SRC = join( process.cwd(), 'src')
/** The writer itself is the one place allowed to name the entity. */
const ALLOWED = join('cognition', 'identity.entity.ts')

function tsFiles( dir: string, out: string[] = [] ): string[] {
  for( const name of readdirSync( dir ) ){
    const full = join( dir, name )
    if( statSync( full ).isDirectory() ) tsFiles( full, out )
    else if( name.endsWith('.ts') ) out.push( full )
  }
  return out
}

/** Comments first — prose about the bug legitimately names the id and the string. */
function code( file: string ): string {
  return readFileSync( file, 'utf8')
    .replace( /\/\*[\s\S]*?\*\//g, '')
    .replace( /(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('identity-self has exactly one writer', () => {
  it('no module outside the writer constructs an identity-self entity', () => {
    // A *read* is fine (`state.entities.get('identity-self')`); what must not
    // exist elsewhere is a write, which is always `id:` in an entity literal.
    const offenders = tsFiles( SRC )
      .filter( f => !f.endsWith( ALLOWED ) )
      .filter( f => /id:\s*'identity-self'/.test( code( f ) ) )
      .map( f => f.slice( SRC.length + 1 ) )

    // If this fails: route the write through `identityCommand` (on-tick, returns a
    // StateCommand) or `mergeIdentity` (off-tick, writes directly). Neither can
    // drop a field the caller did not mention — which is the entire point.
    expect( offenders ).toEqual( [] )
  } )

  it('nothing anywhere substitutes a default name for a nameless mind', () => {
    // The specific regression: `?? 'Will'` in context.ts. Any literal default here
    // is the container naming the tenant.
    const offenders = tsFiles( SRC )
      .filter( f => /metadata\??\.\[?['"]?name/.test( code( f ) ) && /\?\?\s*['"]\w/.test( code( f ) ) )
      .map( f => f.slice( SRC.length + 1 ) )

    expect( offenders ).toEqual( [] )
  } )
} )

// ── the writer's contract ─────────────────────────────────────

function store(): StateManager & { entities: Map<string, { id: string; type: string; metadata: Record<string, unknown> }> } {
  const entities = new Map<string, { id: string; type: string; metadata: Record<string, unknown> }>()
  return {
    entities,
    getEntity: ( id: string ) => entities.get( id ),
    setEntity: ( e: { id: string; type: string; metadata?: Record<string, unknown> } ) =>
      { entities.set( e.id, { id: e.id, type: e.type, metadata: e.metadata ?? {} } ) },
  } as unknown as StateManager & { entities: typeof entities }
}

const metaOf = ( s: ReturnType<typeof store> ) => s.entities.get( IDENTITY_ENTITY_ID )!.metadata

/** A state whose only entity is identity-self, for the command-shaped writer. */
const stateWith = ( metadata: Record<string, unknown> ): ReadonlySimulationState =>
  ( { entities: new Map( [ [ IDENTITY_ENTITY_ID, { metadata } ] ] ) } as unknown as ReadonlySimulationState )

describe('mergeIdentity — a writer cannot erase what it does not mention', () => {
  it('seeds an identity that does not exist yet', () => {
    const s = store()
    mergeIdentity( s, { name: 'Lora', prompt: 'p', version: 1 } )
    expect( metaOf( s ) ).toEqual( { name: 'Lora', prompt: 'p', version: 1 } )
  } )

  it('reproduces the exact loss it exists to prevent — the PMA wake', () => {
    // _seedIdentity writes the name at boot; loadPMA then applies the artifact.
    // The artifact carries what the mind LEARNED about itself and no name at all,
    // because the name belongs to whoever is renting the container.
    const s = store()
    mergeIdentity( s, { name: 'Lora', prompt: 'seeded', values: [ 'candour' ], version: 1 } )
    mergeIdentity( s, { prompt: 'I am Lora, COO of Mindot...', traits: { openness: 0.7 }, version: 4 } )

    expect( metaOf( s ).name ).toBe('Lora')
    expect( metaOf( s ).prompt ).toBe('I am Lora, COO of Mindot...')
    expect( metaOf( s ).traits ).toEqual( { openness: 0.7 } )
    expect( metaOf( s ).values ).toEqual( [ 'candour' ] )   // untouched, not deleted
  } )

  it('survives a self-model evaluation, which mentions no name either', () => {
    const s = store()
    mergeIdentity( s, { name: 'Lora', traits: { openness: 0.5 }, version: 1 } )
    // Ten evaluations: the old code lost the name on the first one.
    for( let i = 0; i < 10; i++ )
      mergeIdentity( s, { traits: { openness: 0.5 + i / 100 }, version: i + 2 } )

    expect( metaOf( s ).name ).toBe('Lora')
  } )

  it('lets a name be changed on purpose — merging is not freezing', () => {
    const s = store()
    mergeIdentity( s, { name: 'Lora' } )
    mergeIdentity( s, { name: 'Ada' } )
    expect( metaOf( s ).name ).toBe('Ada')
  } )

  it('treats an explicit undefined as "not mentioned", never as "clear it"', () => {
    const s = store()
    mergeIdentity( s, { name: 'Lora', style: 'terse' } )
    mergeIdentity( s, { name: undefined, style: 'warm' } )
    expect( metaOf( s ).name ).toBe('Lora')
    expect( metaOf( s ).style ).toBe('warm')
  } )

  it('reports what it changed, and is a no-op when nothing would', () => {
    const s = store()
    mergeIdentity( s, { name: 'Lora' } )
    expect( mergeIdentity( s, { style: 'terse' } ) ).toEqual( [ 'style' ] )
    expect( mergeIdentity( s, { style: 'terse' } ) ).toEqual( [] )
  } )

  it("stamps no timestamps of its own — that is StateManager's job, from the sim clock", () => {
    const seen: Record<string, unknown>[] = []
    const probe = {
      getEntity: () => undefined,
      setEntity: ( e: Record<string, unknown> ) => { seen.push( e ) },
    } as unknown as StateManager

    mergeIdentity( probe, { name: 'Lora' } )
    expect( 'createdAt' in seen[0]! ).toBe( false )
    expect( 'updatedAt' in seen[0]! ).toBe( false )
  } )
} )

describe('identityCommand — the on-tick shape merges the same way', () => {
  it('inherits the current metadata for anything it does not mention', () => {
    const cmd = identityCommand( stateWith({ name: 'Lora', values: [ 'candour' ] }), { traits: { openness: 1 } } )
    expect( cmd.metadata ).toEqual( { name: 'Lora', values: [ 'candour' ], traits: { openness: 1 } } )
  } )

  it('works on a mind that has no identity entity yet', () => {
    const empty = { entities: new Map() } as unknown as ReadonlySimulationState
    expect( identityCommand( empty, { name: 'Ada' } ).metadata ).toEqual( { name: 'Ada' } )
  } )
} )

describe('readIdentityName — no name is no name', () => {
  it('returns the name when the mind has one', () => {
    expect( readIdentityName( stateWith({ name: 'Lora' }) ) ).toBe('Lora')
  } )

  it('returns empty for a nameless mind rather than borrowing the platform\'s', () => {
    // The whole defect in one assertion. Anything other than '' here is a name the
    // mind never chose being rendered into its own self-description.
    expect( readIdentityName( stateWith({ prompt: 'p' }) ) ).toBe('')
    expect( readIdentityName( { entities: new Map() } as unknown as ReadonlySimulationState ) ).toBe('')
  } )
} )

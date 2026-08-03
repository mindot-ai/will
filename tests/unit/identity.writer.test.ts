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
  composeIdentityPrompt, readPersona, WILL_CORE_PREAMBLE,
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

// ── the writer is necessary but not sufficient ────────────────

describe('snapshot restore may not eat the name', () => {
  it('is guarded in the restore block, not only at the writers', () => {
    // Making every WRITER merge did not fix this, and only booting a real Will
    // found out. Restore is not a writer — it is the entire entity map arriving
    // at once, landing between `_seedIdentity` (which writes the name) and
    // `loadPMA`. So a mind hibernated before the merging writer existed came back
    // nameless from a fully repaired build, and told its operator "my self-model
    // says I'm Will" on a live channel.
    //
    // The sibling case was already known and already handled three lines above:
    // `backfillEngineConfigs` exists because restore ate the engine-config mirror
    // the same way. Identity had no equivalent.
    const stem = readFileSync( join( SRC, 'stem', 'index.ts'), 'utf8')
    const block = stem.slice(
      stem.indexOf('stateManager.restore('),
      stem.indexOf('Restored snapshot for'),
    )

    expect( block, 'the restore block must re-assert the name' ).toContain('mergeIdentity(')
    expect( block ).toContain('config.name')
  } )

  it('re-asserts ONLY the name, never the mind\'s own self-knowledge', () => {
    // prompt / values / traits / traitStats / style are what the mind has LEARNED
    // about itself. Re-seeding those from boot config on every wake would erase a
    // life's worth of self-model development every time the process restarted.
    const stem = readFileSync( join( SRC, 'stem', 'index.ts'), 'utf8')
    const call = stem.slice( stem.indexOf('mergeIdentity( simulation.stateManager') )
      .slice( 0, 200 )

    expect( call ).toContain('name: config.name')
    for( const learned of [ 'prompt', 'values', 'traits', 'style' ] )
      expect( call, `restore must not re-seed ${learned}` ).not.toContain(`${learned}:`)
  } )
} )

// ── the container's preamble is not the tenant's to carry ─────

describe('identity prompt is two layers, stored apart', () => {
  it('composes the current build\'s preamble over the persona', () => {
    const p = composeIdentityPrompt('I am Lora, COO of Mindot.', 'A Discord workspace.')
    expect( p.startsWith( WILL_CORE_PREAMBLE ) ).toBe( true )
    expect( p ).toContain('## Who I Am\nI am Lora, COO of Mindot.')
    expect( p ).toContain('## My Environment\nA Discord workspace.')
  } )

  it('omits an empty layer rather than emitting a bare header', () => {
    expect( composeIdentityPrompt('') ).toBe( WILL_CORE_PREAMBLE )
    expect( composeIdentityPrompt('I am Ada.') ).not.toContain('## My Environment')
  } )

  it('reads the persona back without the preamble riding along', () => {
    expect( readPersona({ persona: 'I am Lora.' }) ).toBe('I am Lora.')
  } )

  it('recovers the persona from a pre-split composed prompt', () => {
    // The whole reason `readPersona` has a fallback: artifacts already on disk
    // stored the COMPOSED string, so distilling one naively would carry the old
    // preamble forward forever.
    const composed = composeIdentityPrompt('I am Lora, COO of Mindot.')
    const back = readPersona({ prompt: composed })
    expect( back ).toBe('I am Lora, COO of Mindot.')
    expect( back ).not.toContain('I am NOT a language model')
  } )

  it('returns nothing for a prompt that is preamble only', () => {
    expect( readPersona({ prompt: WILL_CORE_PREAMBLE }) ).toBe('')
    expect( readPersona( undefined ) ).toBe('')
  } )

  it('the distiller captures the persona layer, the loader recomposes', () => {
    // A woken mind must get TODAY's preamble. Storing the composed string meant a
    // fix to that text could never reach a mind that already existed — each one
    // kept reciting the version it was distilled under.
    const pma = readFileSync( join( SRC, 'pma', 'index.ts'), 'utf8')
    expect( pma ).toContain('prompt:  readPersona( m )')
    expect( pma ).toContain('composeIdentityPrompt( pma.identity.prompt')
    expect( pma ).toContain('persona: pma.identity.prompt')
  } )

  it('_seedIdentity stores both the composed view and the persona alone', () => {
    const mind = readFileSync( join( SRC, 'stem', 'mind.ts'), 'utf8')
    expect( mind ).toContain('composeIdentityPrompt( fullPersonaText, profileContext )')
    expect( mind ).toContain('persona: fullPersonaText')
  } )
} )

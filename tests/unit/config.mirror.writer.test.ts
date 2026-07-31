// ─────────────────────────────────────────────────────────────
// tests/unit/config.mirror.writer.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * `engine.config` entities may only be written by `mergeEngineConfig`.
 *
 * Every whole-entity write to one has silently dropped params — three times in a
 * single day, each in a different place, each invisible until a Will was booted
 * and its state read:
 *
 *   • PMALoader replaced `engine-config-executive` with the three behavioural
 *     params a PMA carries, dropping `deliberateThreshold`. `readBaseParams`
 *     then returned nothing for it and `consolidatePrior` skips an adjustment
 *     whose base is absent — so the analytical and decisiveness edges that
 *     develop how readily a mind stops to think had no base to move, for every
 *     Will ever restored from an artifact.
 *   • The same loader dropped `emitBlendEvents` from the blender and three
 *     params from forgetting.
 *   • Snapshot restore replaced the whole mirror, so a Will woke with the config
 *     it FIRST hibernated under and could never receive a param added later.
 *     `maxFacets` and `deliberateThreshold` were inert on a live Will for its
 *     entire life.
 *
 * The rule held in three places by convention. This makes it one place by
 * construction, and fails if a fourth writer appears.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mergeEngineConfig, type EngineConfigEntity } from '#cognition/config.mirror.entities'
import type { StateManager } from '#core/state.manager'

// ── the guard ─────────────────────────────────────────────────

const SRC = join( process.cwd(), 'src')
/** The writer itself is the one place allowed to name the type. */
const ALLOWED = join('cognition', 'config.mirror.entities.ts')

function tsFiles( dir: string, out: string[] = [] ): string[] {
  for( const name of readdirSync( dir ) ){
    const full = join( dir, name )
    if( statSync( full ).isDirectory() ) tsFiles( full, out )
    else if( name.endsWith('.ts') ) out.push( full )
  }
  return out
}

describe('engine.config has exactly one writer', () => {
  it('no module outside the writer constructs an engine.config entity', () => {
    const offenders = tsFiles( SRC )
      .filter( f => !f.endsWith( ALLOWED ) )
      .filter( f => /type:\s*'engine\.config'/.test( readFileSync( f, 'utf8') ) )
      .map( f => f.slice( SRC.length + 1 ) )

    // If this fails: route the write through `mergeEngineConfig` instead. It
    // never drops a key, and `precedence` chooses which side wins on a collision.
    expect( offenders ).toEqual( [] )
  } )
} )

// ── the writer's contract ─────────────────────────────────────

/** A state manager just real enough to observe what the writer does. */
function store(): StateManager & { entities: Map<string, { id: string; type: string; createdAt: number; metadata: unknown }> } {
  const entities = new Map<string, { id: string; type: string; createdAt: number; metadata: unknown }>()
  return {
    entities,
    getEntity: ( id: string ) => entities.get( id ),
    setEntity: ( e: { id: string; type: string; createdAt?: number; metadata?: unknown } ) =>
      { entities.set( e.id, { ...e, createdAt: e.createdAt ?? 0, metadata: e.metadata } as never ) },
  } as unknown as StateManager & { entities: typeof entities }
}

const paramsOf = ( s: ReturnType<typeof store>, id: string ) =>
  ( s.entities.get( id )?.metadata as { params: Record<string, unknown> } ).params

const cfg = ( params: Record<string, unknown> ): EngineConfigEntity =>
  ( { id: 'engine-config-x', engine: 'x', params } )

describe('mergeEngineConfig — never drops a key', () => {
  it('writes a config that does not exist yet', () => {
    const s = store()
    mergeEngineConfig( s, cfg({ a: 1, b: 2 }) )
    expect( paramsOf( s, 'engine-config-x') ).toEqual( { a: 1, b: 2 } )
  } )

  it("'incoming' wins collisions but keeps every key it does not mention", () => {
    // The PMA case: it is the authority on the dispositions it carries, and
    // everything the mirror seeded has to survive alongside them.
    const s = store()
    mergeEngineConfig( s, cfg({ seeded: 'keep', shared: 'old' }) )
    mergeEngineConfig( s, cfg({ shared: 'new' }), 'incoming')

    expect( paramsOf( s, 'engine-config-x') ).toEqual( { seeded: 'keep', shared: 'new' } )
  } )

  it("'existing' fills only what is missing, never overwriting", () => {
    // The post-restore backfill: state carries PMA seeding and whatever the
    // persona has learned, so a newly-shipped default must not clobber it.
    const s = store()
    mergeEngineConfig( s, cfg({ learned: 0.9 }) )
    mergeEngineConfig( s, cfg({ learned: 0.3, freshlyShipped: 60 }), 'existing')

    expect( paramsOf( s, 'engine-config-x') ).toEqual( { learned: 0.9, freshlyShipped: 60 } )
  } )

  it('reports which keys it added, so a caller can say what a tenant gained', () => {
    const s = store()
    mergeEngineConfig( s, cfg({ old: 1 }) )
    expect( mergeEngineConfig( s, cfg({ old: 1, added: 2 }), 'existing') ).toEqual( [ 'added' ] )
  } )

  it('is a no-op when nothing would change', () => {
    const s = store()
    mergeEngineConfig( s, cfg({ a: 1 }) )
    expect( mergeEngineConfig( s, cfg({ a: 1 }), 'existing') ).toEqual( [] )
  } )

  it('stamps no timestamps of its own — that is StateManager\'s job, from the sim clock', () => {
    // Every site this replaced passed `Date.now()`. That was redundant
    // (setEntity stamps createdAt/updatedAt itself, and preserves an existing
    // createdAt) and a real determinism hole: entity times have to come from the
    // SIM clock to replay identically (R2). The determinism guard caught it the
    // moment this code moved into `cognition/`.
    const seen: Record<string, unknown>[] = []
    const probe = {
      getEntity: () => undefined,
      setEntity: ( e: Record<string, unknown> ) => { seen.push( e ) },
    } as unknown as StateManager

    mergeEngineConfig( probe, cfg({ a: 1 }) )

    expect( seen[0] ).toBeDefined()
    expect( 'createdAt' in seen[0]! ).toBe( false )
    expect( 'updatedAt' in seen[0]! ).toBe( false )
  } )

  it('reproduces the exact loss it exists to prevent', () => {
    // engine-config-executive as the mirror seeds it, then the PMA's three
    // behavioural params on top. deliberateThreshold and maxFacets must survive.
    const s = store()
    mergeEngineConfig( s, {
      id: 'engine-config-executive', engine: 'executive',
      params: { executiveInterval: 60, cooldownTicks: 5, deliberateThreshold: 0.5, maxFacets: 10 },
    } )
    mergeEngineConfig( s, {
      id: 'engine-config-executive', engine: 'executive',
      params: { riskTolerance: 0.557, explorationRate: 0, impulsivity: 0 },
    }, 'incoming')

    const p = paramsOf( s, 'engine-config-executive')
    expect( p.deliberateThreshold ).toBe( 0.5 )
    expect( p.maxFacets ).toBe( 10 )
    expect( p.riskTolerance ).toBe( 0.557 )
  } )
} )

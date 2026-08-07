// ─────────────────────────────────────────────────────────────
// tests/unit/test.hygiene.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * One test file must not be able to change what another one imports.
 *
 * `bun test` runs every file in ONE process, and `mock.module` (which `vi.mock`
 * compiles to) rewrites the module registry for that process permanently — there
 * is no per-file teardown. So a mock declared here is still in force for every
 * file loaded after it.
 *
 * This is not hypothetical. `facet.supervisor.keying.test.ts` mocked
 * `#faculties/executive.engine/facet` to avoid paying for an LLM director; every
 * later file therefore got a facet whose `pump()` did nothing, and the audition
 * reply tests sat waiting on a mind that could not think until they timed out at
 * 30 seconds. Nine tests failed in CI and five locally — a DIFFERENT five, because
 * the blast radius follows file order. That divergence is what makes it expensive:
 * it reads as flake, and flake gets re-run rather than bisected.
 *
 * The alternative is always the same and always better: take an injection seam on
 * the unit under test (`FacetSupervisor`'s `createFacet`), which reaches exactly
 * the one object that asked for it.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TESTS_ROOT = new URL('..', import.meta.url ).pathname

function testFiles( dir: string ): string[] {
  const out: string[] = []
  for( const name of readdirSync( dir ) ){
    const path = join( dir, name )
    if( statSync( path ).isDirectory() ){ out.push( ...testFiles( path ) ); continue }
    if( /\.(test|spec)\.ts$/.test( name ) ) out.push( path )
  }
  return out
}

describe('no test file rewrites a module for the whole process', () => {
  it('never calls vi.mock / mock.module — use an injection seam instead', () => {
    const offenders = testFiles( TESTS_ROOT )
      .filter( path => {
        const src = readFileSync( path, 'utf8' )
        // Anchored to the start of a line because these are always statements,
        // and because the prose that explains the rule — here, and in the seam's
        // own docs — names both calls verbatim inside ` * ` comment bodies.
        return /^[ \t]*(?:await\s+)?(?:vi\.mock|mock\.module)\s*\(/m.test( src )
      } )
      .map( p => p.slice( TESTS_ROOT.length ) )

    expect( offenders, `these files mock a module process-wide; every test file loaded after them gets the fake:\n  ${offenders.join('\n  ')}` )
      .toEqual( [] )
  } )
} )

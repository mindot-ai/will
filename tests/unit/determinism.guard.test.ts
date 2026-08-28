// ─────────────────────────────────────────────────────────────
// tests/unit/determinism.guard.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Determinism guard (R2). Replay/snapshot is only meaningful if the
 * deterministic layers contain no hidden sources of non-determinism. This
 * dependency-free source scan enforces that ban so a stray `Math.random()`
 * can never silently re-enter `src/core` or `src/cognition`.
 *
 * Why a scan test rather than ESLint: the project is Bun-only with no ESLint
 * toolchain, so a vitest scan runs inside the existing `bun run test` with zero
 * new dependencies. It strips comments before matching (so JSDoc that merely
 * *mentions* the banned API is ignored) and preserves physical line numbers so
 * failures point at the exact offending line.
 *
 * Escape hatch: a genuinely non-deterministic, non-replay-affecting site may
 * opt out by putting `determinism-ok` in a comment on the same line, e.g.
 *   const k = Math.random() // determinism-ok: transient cache key, never in state
 *
 * R2 scope note: `Math.random()` is banned across both deterministic layers
 * (R2-a). The wall-clock ban (`Date.now` / `new Date`) was phased in — `src/core`
 * first (R2-b1), then `src/cognition` (R2-b2) — and now applies to both layers
 * with no `dirs` restriction. The one sanctioned `Date.now()` lives in
 * `src/core/wall.clock.ts` behind the `determinism-ok` marker. `randomUUID()`
 * (event ids) is banned too (R2-c): event ids land in the replay stream, so they
 * use a monotonic counter; genuinely non-replay ids (run identity in
 * `simulation.ts`, cross-shard coordination in `distributed.ts`) opt out with a
 * `determinism-ok` marker.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..')
const SCAN_DIRS = [ 'src/core', 'src/cognition' ]   // src/cognition recurses into agency
const ALLOW_MARKER = 'determinism-ok'

/**
 * `dirs`, when present, restricts a pattern to those SCAN_DIRS. Omitted means
 * the pattern applies everywhere. The field is currently unused (all patterns
 * are global) but is retained as the mechanism for any future phased rollout.
 */
interface BannedPattern { name: string; re: RegExp; hint: string; dirs?: string[] }

const BANNED: BannedPattern[] = [
  {
    name: 'Math.random()',
    re:   /Math\s*\.\s*random\s*\(/,
    hint: 'draw from context.prng (SeededPRNG: next/nextInt/nextBool) for genuine '
        + 'randomness, or use a monotonic counter for unique ids',
  },
  {
    name: 'Date.now()',
    re:   /Date\s*\.\s*now\s*\(/,
    hint: 'route replay-affecting time through the sim clock (SimulationState.time / tick); '
        + 'for genuinely non-replay-affecting telemetry call wallClock() from #core/wall.clock',
  },
  {
    name: 'new Date',
    re:   /new\s+Date\b/,
    hint: 'same policy as Date.now() — sim clock for replay state, wallClock() for telemetry; '
        + 'date *deserialization* (reviving a stored Date) may opt out with a determinism-ok marker',
  },
  {
    name: 'randomUUID()',
    re:   /randomUUID\s*\(/,
    hint: 'replay-affecting ids (e.g. event ids) must be deterministic — use a monotonic counter '
        + '(unique-id policy) or draw from context.prng; genuinely non-replay ids (run identity, '
        + 'cross-node coordination) may opt out with a determinism-ok marker',
  },
]

/** Recursively collect every .ts file under a directory (excludes .test.ts). */
function collectTsFiles( absDir: string ): string[] {
  const out: string[] = []
  for( const entry of readdirSync( absDir, { withFileTypes: true } ) ){
    const full = join( absDir, entry.name )
    if( entry.isDirectory() ) out.push( ...collectTsFiles( full ) )
    else if( entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') )
      out.push( full )
  }
  return out
}

/**
 * Strip // and /* *​/ comments while preserving line count (one output line per
 * input line) so reported line numbers match the file. Does not understand `//`
 * or `/*` inside string literals — acceptable for a guard (worst case is a
 * missed violation on a contrived line, never a false positive).
 */
function stripComments( src: string ): string[] {
  const out: string[] = []
  let inBlock = false
  for( const line of src.split('\n') ){
    let result = ''
    let i = 0
    while( i < line.length ){
      if( inBlock ){
        const end = line.indexOf('*/', i )
        if( end === -1 ){ i = line.length }
        else { inBlock = false; i = end + 2 }
      } else {
        const blockStart = line.indexOf('/*', i )
        const lineStart  = line.indexOf('//', i )
        if( lineStart !== -1 && ( blockStart === -1 || lineStart < blockStart ) ){
          result += line.slice( i, lineStart )
          i = line.length
        } else if( blockStart !== -1 ){
          result += line.slice( i, blockStart )
          i = blockStart + 2
          inBlock = true
        } else {
          result += line.slice( i )
          i = line.length
        }
      }
    }
    out.push( result )
  }
  return out
}

interface Violation { file: string; line: number; pattern: string; text: string }

function scan( dirs: string[] = SCAN_DIRS, root: string = REPO_ROOT ): Violation[] {
  const violations: Violation[] = []
  for( const dir of dirs ){
    // Apply only the patterns scoped to this dir (or unscoped patterns).
    const active = BANNED.filter( p => !p.dirs || p.dirs.includes( dir ) )
    for( const file of collectTsFiles( join( root, dir ) ) ){
      const raw     = readFileSync( file, 'utf8')
      const rawLines = raw.split('\n')
      const code    = stripComments( raw )
      code.forEach( ( codeLine, idx ) => {
        const original = rawLines[ idx ] ?? ''
        if( original.includes( ALLOW_MARKER ) ) return
        for( const pat of active )
          if( pat.re.test( codeLine ) )
            violations.push({
              file:    file.slice( root.length + 1 ),
              line:    idx + 1,
              pattern: pat.name,
              text:    original.trim(),
            })
      } )
    }
  }
  return violations
}

describe('determinism guard — banned non-deterministic APIs (R2)', () => {
  it('finds source files to scan (sanity)', () => {
    const count = SCAN_DIRS.reduce(
      ( n, d ) => n + collectTsFiles( join( REPO_ROOT, d ) ).length, 0,
    )
    expect( count ).toBeGreaterThan( 0 )
  })

  it('has no banned non-deterministic calls in src/core or src/cognition (incl. agency)', () => {
    const violations = scan()
    const report = violations
      .map( v => `  ${v.file}:${v.line} — ${v.pattern}\n      ${v.text}`)
      .join('\n')
    expect(
      violations,
      violations.length === 0 ? '' :
        `Found ${violations.length} banned non-deterministic call(s):\n${report}\n\n`
        + `Fix: ${BANNED.map( b => `${b.name} → ${b.hint}`).join('; ')}.\n`
        + `If a site is genuinely non-replay-affecting, add a "${ALLOW_MARKER}" comment.`,
    ).toHaveLength( 0 )
  })

  it('detects real unmarked banned calls through the full scan() pipeline (positive fixture)', () => {
    // Isolated fixture tree OUTSIDE the repo — src/core and src/cognition are never touched.
    const root = mkdtempSync( join( tmpdir(), 'determinism-guard-' ) )
    try {
      const dir = 'fixture'
      mkdirSync( join( root, dir ), { recursive: true } )
      writeFileSync( join( root, dir, 'sample.ts' ),
        [
          'export const a = Math.random()',                        // 1: must flag
          '// Math.random() only in a comment',                    // 2: stripped → no flag
          'export const b = Date.now() // determinism-ok: telem',  // 3: marker → suppressed
          'export const c = crypto.randomUUID()',                  // 4: must flag
        ].join('\n'),
      )

      const violations = scan( [ dir ], root )

      // Exactly the two unmarked, non-comment calls, at the right lines and patterns.
      expect( violations.map( v => `${v.line}:${v.pattern}` ).sort() )
        .toEqual( [ '1:Math.random()', '4:randomUUID()' ] )
      // Paths are reported fixture-relative, proving the slice logic runs on the given root.
      expect( violations.every( v => v.file === join( dir, 'sample.ts' ) ) ).toBe( true )
    } finally {
      rmSync( root, { recursive: true, force: true } )
    }
  })

  it('comment-only mentions of a banned API do not trigger a violation', () => {
    // The scanner strips comments; e.g. types.ts JSDoc says "Math.random()" in prose.
    const stripped = stripComments('/** use Math.random() sparingly */\nconst x = 1 // Math.random()')
    expect( stripped.some( l => /Math\s*\.\s*random\s*\(/.test( l ) ) ).toBe( false )
  })

  it('the allow-marker escape hatch suppresses a flagged line', () => {
    // Sanity-check the marker logic against a synthetic offending line.
    const line = 'const k = Math.random() // determinism-ok: transient, not in state'
    const flagged = !line.includes( ALLOW_MARKER ) && /Math\s*\.\s*random\s*\(/.test( line )
    expect( flagged ).toBe( false )
  })

  it('the wall-clock patterns match Date.now() and new Date forms', () => {
    const dateNow = BANNED.find( b => b.name === 'Date.now()')!.re
    const newDate = BANNED.find( b => b.name === 'new Date')!.re

    expect( dateNow.test('const t = Date.now()') ).toBe( true )
    expect( dateNow.test('const t = Date . now ()') ).toBe( true )
    expect( newDate.test('const d = new Date( x )') ).toBe( true )
    expect( newDate.test('const d = new Date()') ).toBe( true )
    // Must not flag unrelated identifiers that merely start with "Date".
    expect( newDate.test('const r = new DateRange()') ).toBe( false )
  })

  it('the randomUUID pattern matches both bare and crypto-qualified forms (R2-c)', () => {
    const re = BANNED.find( b => b.name === 'randomUUID()')!.re
    expect( re.test('id: randomUUID()') ).toBe( true )
    expect( re.test('id: crypto.randomUUID()') ).toBe( true )
    expect( re.test('const id = randomUUID ()') ).toBe( true )
    // The determinism-ok marker still suppresses a flagged line (handled by scan()).
    const marked = 'id: crypto.randomUUID(), // determinism-ok: run identity'
    expect( !marked.includes( ALLOW_MARKER ) && re.test( marked ) ).toBe( false )
    // Must not flag unrelated identifiers.
    expect( re.test('const u = makeUUID()') ).toBe( false )
  })

  it('applies the wall-clock ban to every scan dir (R2-b2 dropped the src/core scoping)', () => {
    for( const name of [ 'Date.now()', 'new Date' ] )
      expect( BANNED.find( b => b.name === name )!.dirs ).toBeUndefined()
  })
})

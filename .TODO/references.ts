#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────
// .TODO/references.ts  —  the record cannot point at what is not there
// ─────────────────────────────────────────────────────────────
//
// `index.ts` keeps document HEADERS honest by generating INDEX.md from them.
// It never looked at source comments, contributor invitations or README claims,
// which is where four of the five defects fixed in the preceding commit lived:
// a header citing `CUSTOM_EFFECTOR_WIRING_TODO.md` (no such file), an invitation
// naming `src/cognition/senses/vision.ts` (it is `vision.engine.ts`) and one
// naming the type `EffectorSchema` (never existed).
//
// WHAT THIS CAN AND CANNOT DO. "Is this prose true?" is undecidable, and a lint
// that guesses gets switched off. So this checks exactly two things that are
// mechanical, and deliberately nothing else:
//
//   A. DEAD PATHS   — a file path mentioned anywhere (comment, prose, fence)
//                     that does not resolve on disk.
//   B. DEAD SYMBOLS — a PascalCase type/class name or a `fn()` call, written in
//                     backticks outside a code fence, that appears nowhere in
//                     src/ once comments are stripped. A name only ever spoken
//                     about in comments is a name that does not exist.
//
// The two defects it CANNOT catch are recorded so nobody assumes otherwise:
// a Standing line that contradicts its own document's body (defect 2), and a
// claim that is well-formed but false — `'nourishment'` as a recognised drive
// tag (defect 3). The second is pinned by a test instead, because the invariant
// is specific: tests/unit/record.drive-tags.test.ts.
//
// EXTERNAL is the allowlist, and it is the honesty check on this whole file: if
// it has to grow much past prose nouns and third-party names, rule B is wrong
// and should be deleted rather than nursed.
// ─────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const ROOT = resolve( import.meta.dir, '..' )

// Not ours to declare. Kept deliberately tiny — the humped-name rule below does
// the real work, and a growing list here is the signal that rule B is wrong.
const EXTERNAL = new Set( [
  'TypeError',                                                      // JS builtin
  'WorkstationDecisionRequest', 'WorkstationPolicyDecisionReceipt',  // HELM's wire types
] )

const walk = ( dir: string, keep: ( f: string ) => boolean, out: string[] = [] ): string[] => {
  for( const e of readdirSync( join( ROOT, dir ), { withFileTypes: true } ) ){
    const rel = join( dir, e.name )
    if( e.isDirectory() ){
      if( e.name === 'node_modules' || e.name === '.git' ) continue
      walk( rel, keep, out )
    } else if( keep( e.name ) ) out.push( rel )
  }
  return out
}

/** Source with comments removed — the universe of names that actually exist. */
const codeOnly = ( src: string ): string =>
  src.replace( /\/\*[\s\S]*?\*\//g, ' ' ).replace( /(^|[^:"'`\\])\/\/.*$/gm, '$1 ' )

const SRC = walk( 'src', f => f.endsWith('.ts') )
// Tests and examples DECLARE too: a harness class is a name that exists.
const ALSO = [ ...walk( 'tests', f => f.endsWith('.ts') ), ...walk( 'examples', f => f.endsWith('.ts') ) ]
const PROSE = [ 'README.md', ...walk( '.TODO', f => f.endsWith('.md') ) ]

// ── the universe of declared names ───────────────────────────
const declared = new Set<string>()
for( const f of [ ...SRC, ...ALSO ] )
  for( const w of codeOnly( readFileSync( join( ROOT, f ), 'utf8' ) ).match( /[A-Za-z_$][\w$]*/g ) ?? [] )
    declared.add( w )

type Finding = { file: string; line: number; token: string; rule: 'path' | 'symbol' }
const findings: Finding[] = []

// ── A. dead paths ────────────────────────────────────────────
const PATH_RE = /(?<![\w/.*<>-])((?:[\w.@-]+\/)*[\w.-]+\.(?:ts|tsx|md|svg|json|yml|yaml))(?![\w/-])/g
const EXT_OK  = /^(?:https?:|node_modules|@[\w-]+\/)/

// A glob (`*.engine.ts`) and a placeholder (`<domain>.engine.ts`) are not
// references, and the lookbehind is where that has to be said — not the
// resolver. `*` and `<` cannot occur INSIDE a captured token, so a resolver
// guard for them never runs: the match simply starts after the star and
// `.engine.ts` is reported as a missing file. That is how `*.engine.ts` got
// through a check that appeared to allow globs. The two guards are deleted
// rather than kept as reassurance.
//
// The cost, measured rather than assumed: a dead path written flush against a
// blockquote marker — `>src/nope.ts`, no space — is no longer seen. Markdown
// puts a space after `>`, so this has never occurred here, and it is the right
// trade against reporting every glob in the repo as missing.

// Every tracked file, plus every path SUFFIX of it. This codebase cites paths
// shorn of their prefix — `agency/types.ts` for src/cognition/agency/types.ts —
// and did so before the cognition/ restructure moved them, so a cited path is
// correct if any real file's path ends at a segment boundary with it.
const ALL_PATHS = new Set<string>()
for( const f of [ ...walk( 'src', () => true ), ...walk( '.TODO', () => true ),
                  ...walk( 'tests', () => true ), ...walk( 'docs', () => true ),
                  ...walk( 'examples', () => true ), ...walk( '.github', () => true ) ] ){
  const parts = f.split('/')
  for( let i = 0; i < parts.length; i++ ) ALL_PATHS.add( parts.slice( i ).join('/') )
}
for( const f of readdirSync( ROOT, { withFileTypes: true } ) ) if( f.isFile() ) ALL_PATHS.add( f.name )

const resolvesPath = ( token: string, from: string ): boolean => {
  if( EXT_OK.test( token ) ) return true
  // A bare basename is only a repo path if it is source or a document. Without
  // this, `res.json` — a method call — and runtime artifacts like `latest.json`
  // read as missing files.
  if( !token.includes('/') && !/\.(?:ts|tsx|md)$/.test( token ) ) return true
  if( ALL_PATHS.has( token ) ) return true
  const p = join( ROOT, dirname( from ), token )
  return existsSync( p ) && statSync( p ).isFile()
}

// ── B. dead symbols (backticked, outside fences) ─────────────
// PascalCase with an INTERNAL capital. The hump is what separates a code name
// from a capitalised English word: `EffectorSchema` and `EffortGate` have one,
// `Alice`, `Standing`, `Collection` and `Clock` do not — and those were every
// prose false positive in the first run. Cheaper and more honest than a list.
const TYPE_RE = /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/
const CALL_RE = /^([a-z][a-zA-Z0-9]*)\(\)$/              // camelCase call

for( const file of [ ...SRC, ...PROSE ] ){
  const text = readFileSync( join( ROOT, file ), 'utf8' )
  const isMd = file.endsWith('.md')
  let fenced = false

  text.split('\n').forEach( ( line, i ) => {
    if( isMd && /^\s*```/.test( line ) ){ fenced = !fenced; return }
    const n = i + 1

    for( const m of line.matchAll( PATH_RE ) )
      if( !resolvesPath( m[ 1 ]!, file ) )
        findings.push({ file, line: n, token: m[ 1 ]!, rule: 'path' })

    if( fenced ) return
    for( const m of line.matchAll( /`([^`\n]{2,60})`/g ) ){
      const t = m[ 1 ]!.trim()
      const call = CALL_RE.exec( t )
      // All-caps tokens are constants, log levels and error codes (WARN, STAKES,
      // TS2304) — never the type names rule B is for.
      const name = call ? call[ 1 ]! : ( TYPE_RE.test( t ) && /[a-z]/.test( t ) ) ? t : null
      if( !name || EXTERNAL.has( name ) || declared.has( name ) ) continue
      findings.push({ file, line: n, token: t, rule: 'symbol' })
    }
  })
}

// ── the baseline, and why there is one ───────────────────────
//
// This check was retrofitted onto a repository with years of prose in it, and
// the first clean run found 386 references that no longer resolve — nearly all
// in historical documents that cite a file by the name it had at the time, which
// is not a defect. Failing on all of them would mean rewriting the archive, so
// the accepted set is checked in and the gate is a RATCHET:
//
//   • a finding NOT in the baseline fails — that is a newly written reference to
//     something that does not exist, which is what each of the five defects was
//     on the day it was introduced;
//   • a baseline entry that NO LONGER OCCURS also fails, so the list can only
//     shrink. Fix a reference, re-run with --update, commit — the same contract
//     INDEX.md already has.
//
// Keyed by file + token, never by line, so moving prose around does not churn it.
const BASELINE = join( ROOT, '.TODO/references.baseline.json' )
const key = ( f: Finding ): string => `${ f.file }|${ f.rule }|${ f.token }`

const accepted: Set<string> = existsSync( BASELINE )
  ? new Set( JSON.parse( readFileSync( BASELINE, 'utf8' ) ) as string[] )
  : new Set()

const seen = new Set( findings.map( key ) )
const fresh = findings.filter( f => !accepted.has( key( f ) ) )
const gone  = [ ...accepted ].filter( k => !seen.has( k ) )

if( process.argv.includes('--update') ){
  writeFileSync( BASELINE, `${ JSON.stringify( [ ...seen ].sort(), null, 2 ) }\n` )
  console.log( `baseline — ${ seen.size } accepted (${ findings.filter( f => f.rule === 'path').length } paths, ${ findings.filter( f => f.rule === 'symbol').length } symbols)` )
  process.exit( 0 )
}

for( const f of fresh )
  console.log( `${ f.rule === 'path' ? 'DEAD PATH  ' : 'DEAD SYMBOL' }  ${ f.file }:${ f.line }  ${ f.token }` )
for( const k of gone )
  console.log( `FIXED (drop from baseline)  ${ k.split('|').join('  ') }` )

console.log( `\n${ SRC.length } source files, ${ PROSE.length } prose, ${ declared.size } declared names · ${ seen.size } known` )

if( fresh.length ){
  console.log( `\n${ fresh.length } reference(s) point at something that does not exist.` )
  console.log( 'Fix the reference. If it is deliberately forward-looking, run `bun run refs:update`.' )
  process.exit( 1 )
}
if( gone.length ){
  console.log( `\n${ gone.length } baseline entr(y/ies) no longer occur — run \`bun run refs:update\` and commit.` )
  process.exit( 1 )
}
console.log( 'references ok' )

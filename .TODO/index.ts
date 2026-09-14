// ─────────────────────────────────────────────────────────────
// .TODO/index.ts — the development record, in order
// ─────────────────────────────────────────────────────────────
//
//   bun .TODO/index.ts        → re-emits .TODO/INDEX.md
//
// Reads the `> **Standing:**` line off every document in this folder and the
// release headers out of CHANGELOG.md, and merges them into one timeline from
// day zero. Generated, never hand-edited — the same discipline as the graphs:
// a picture that compiles from its source cannot drift from it.
//
// The line it parses is defined in STANDING.md:
//
//   > **Standing:** LEVEL · YYYY-MM-DD · what backs it
// ─────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname( fileURLToPath( import.meta.url ) )
const SKIP = new Set([ 'INDEX.md', 'STANDING.md' ])

const LEVELS = [ 'SHIPPED', 'OBSERVED', 'DESIGNED', 'SPECULATIVE' ] as const
type Level = typeof LEVELS[ number ]

const GLOSS: Record<Level, string> = {
  SHIPPED:     'in the engine, gated by CI, carried by a release',
  OBSERVED:    'true of the real system at a moment, established by looking',
  DESIGNED:    'reasoned to a plan of record — intent, not capability',
  SPECULATIVE: 'a hypothesis the project is holding'
}

type Entry = { date: string, level: Level, title: string, file: string, prose: string }
type Release = { date: string, version: string, theme: string }

// ─── read the documents ──────────────────────────────────────

const STANDING = /^> \*\*Standing:\*\* (\w+) · (\d{4}-\d{2}-\d{2}) · (.+)$/

const entries: Entry[] = []
const unmarked: string[] = []

for( const file of readdirSync( HERE ).filter( f => f.endsWith( '.md' ) && !SKIP.has( f ) ).sort() ){
  const lines = readFileSync( join( HERE, file ), 'utf8' ).split( '\n' )
  const title = lines[ 0 ].replace( /^#\s*/, '' )
  const hit   = lines.slice( 0, 6 ).map( l => l.match( STANDING ) ).find( Boolean )

  if( !hit ){ unmarked.push( file ); continue }

  const [ , level, date, prose ] = hit
  if( !LEVELS.includes( level as Level ) ) throw new Error( `${file}: unknown standing level "${level}"` )

  entries.push({ date, level: level as Level, title, file, prose })
}

if( unmarked.length )
  throw new Error( `no Standing line (see STANDING.md): ${unmarked.join( ', ' )}` )

// ─── read the releases ───────────────────────────────────────

const releases: Release[] = readFileSync( join( HERE, '..', 'CHANGELOG.md' ), 'utf8' )
  .split( '\n' )
  .map( l => l.match( /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2}) · (.+)$/ ) )
  .filter( ( m ): m is RegExpMatchArray => Boolean( m ) )
  .map( m => ({ version: m[ 1 ], date: m[ 2 ], theme: m[ 3 ] }) )

// ─── merge into one timeline ─────────────────────────────────

type Row = { date: string } & ( { kind: 'doc', entry: Entry } | { kind: 'release', release: Release } )

const rows: Row[] = [
  ...entries.map( e => ({ date: e.date, kind: 'doc'     as const, entry:   e }) ),
  ...releases.map( r => ({ date: r.date, kind: 'release' as const, release: r }) )
].sort( ( a, b ) =>
  a.date.localeCompare( b.date )
  // a release closes the day it lands on
  || Number( a.kind === 'release' ) - Number( b.kind === 'release' )
  || ( a.kind === 'doc' && b.kind === 'doc'
       ? LEVELS.indexOf( a.entry.level ) - LEVELS.indexOf( b.entry.level ) || a.entry.file.localeCompare( b.entry.file )
       : 0 ) )

const MONTH = [ 'January','February','March','April','May','June','July','August','September','October','November','December' ]
const month = ( d: string ): string => `${MONTH[ Number( d.slice( 5, 7 ) ) - 1 ]} ${d.slice( 0, 4 )}`

// ─── emit ────────────────────────────────────────────────────

const count = ( l: Level ): number => entries.filter( e => e.level === l ).length
const out: string[] = [
  '# INDEX — the development record, in order',
  '',
  '> **Generated** by `bun .TODO/index.ts` from the `Standing` line of every',
  '> document in this folder and the release headers in `CHANGELOG.md`.',
  '> Do not edit by hand — edit the document, then re-emit.',
  '',
  `Day zero is **${rows[ 0 ].date}**. ${entries.length} documents, ${releases.length} releases.`,
  'What each level means, and what it may be cited for, is [STANDING.md](STANDING.md).',
  '',
  ...LEVELS.map( l => `- **${l}** · ${count( l )} — ${GLOSS[ l ]}` ),
  '',
  '> Dates before 2026-07-02 predate this repository — `will` was split out and',
  '> squashed on that date. These come from the documents, not from `git log`.',
  ''
]

// The split squashed the history, so every document carried across landed on one
// date. Say so once, where it happens, rather than repeating it sixteen times.
const SPLIT = '2026-07-02'

let seen = ''
let split = false
for( const row of rows ){
  const m = month( row.date )
  if( m !== seen ){ out.push( '', `## ${m}`, '' ); seen = m }

  if( row.date === SPLIT && !split ){
    split = true
    const n = rows.filter( r => r.date === SPLIT && r.kind === 'doc' ).length
    out.push(
      `### ${SPLIT} — the public split`, '',
      `\`will\` became its own public repository on this date and the history was`,
      `squashed into it. The ${n} documents below were written across the weeks before`,
      'it, in an order this record no longer holds — they share a date because the',
      'split gave them one, not because they happened together.', ''
    )
  }

  if( row.kind === 'release' ){
    out.push( `**${row.date} · RELEASE v${row.release.version}** — *${row.release.theme}*`, '' )
    continue
  }

  const { date, level, title, file } = row.entry
  // The split section says this once; sixteen repetitions of it say nothing.
  const prose = date === SPLIT
    ? row.entry.prose
        .replace( /\.?\s*Pre-public: exact date not recorded,\s*and its/, '. Its' )
        .replace( /\.?\s*Pre-public: exact date not recorded\.?/, '' )
        .trim()
    : row.entry.prose

  out.push( `**${date} · ${level}** · [${title}](${file})`, '', prose, '' )
}

writeFileSync( join( HERE, 'INDEX.md' ), out.join( '\n' ).replace( /\n{3,}/g, '\n\n' ).trimStart() + '\n' )
console.log( `INDEX.md — ${entries.length} documents, ${releases.length} releases, from ${rows[ 0 ].date}` )

// ─────────────────────────────────────────────────────────────
// tests/unit/bus.wiring.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Every declared subscription has something that actually publishes it.
 *
 * `assembly.audit.ts` catches a dependency that was never injected. This catches
 * the same silence one layer over: an engine LISTENING for something nobody says.
 * Both halves of that class have shipped and stayed invisible for the life of
 * every Will —
 *
 *   • `agency.composite.proposed` was subscribed by ReafferenceEngine, whose
 *     handler is the only caller of `registerComposite()` anywhere, and published
 *     by nothing. No Will could ever learn a composite skill.
 *   • `attention.focus.changed` was subscribed as the "preferred" focus source
 *     and never published; a state-entity fallback quietly carried it, so the
 *     subscription read as a live wire while doing nothing.
 *
 * A starved consumer looks exactly like a quiet one, so this has to be pinned
 * rather than eyeballed — same principle as `EXPECTED_UNWIRED` in
 * assembly.order.test.ts.
 *
 * WHY STATIC. The obvious implementation — compare `subscribes()` against
 * `publishes()` on the live engine list — does not work: `publishes()` is not a
 * reliable declaration. Many engines return `[]` while publishing plenty
 * (ExecutiveEngine among them), so that version reported ~25 false dangling
 * subscriptions, including `energy.state.changed` with ten subscribers and two
 * real publishers. A guard that cries wolf teaches people to ignore it. The
 * publish SITES in source are the ground truth, so that is what this reads.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join( process.cwd(), 'src')

function tsFiles( dir: string, out: string[] = [] ): string[] {
  for( const name of readdirSync( dir ) ){
    const full = join( dir, name )
    if( statSync( full ).isDirectory() ) tsFiles( full, out )
    else if( name.endsWith('.ts') ) out.push( full )
  }
  return out
}

const SOURCES = tsFiles( SRC ).map( f => ({ file: f.slice( SRC.length + 1 ), text: readFileSync( f, 'utf8') }) )
const ALL_TEXT = SOURCES.map( s => s.text ).join('\n')

/** Topics named in a `subscribes()` return, across every engine in the tree. */
function declaredSubscriptions(): Map<string, string[]> {
  const out = new Map<string, string[]>()

  for( const { file, text } of SOURCES ){
    // `subscribes(): string[] { return [ 'a', 'b' ] }` — single- or multi-line.
    for( const m of text.matchAll( /subscribes\s*\(\s*\)\s*:\s*string\[\]\s*\{[^}]*?return\s*\[([\s\S]*?)\]/g ) ){
      // Strip line comments first: several of these arrays are annotated, and an
      // apostrophe in prose ("a goal that's already done") otherwise opens a bogus
      // string and swallows the rest of the block as a topic name.
      const body = m[1]!.replace( /\/\/[^\n]*/g, '')

      for( const t of body.matchAll( /'([^'\n]+)'/g ) ){
        const topic = t[1]!.trim()
        if( !topic ) continue
        out.set( topic, [ ...( out.get( topic ) ?? [] ), file ] )
      }
    }
  }

  return out
}

/** A topic is published if any source names it as an event `type`. */
const hasPublisher = ( topic: string ): boolean =>
  new RegExp( `type:\\s*'${ topic.replace( /[.*+?^${}()|[\]\\]/g, '\\$&') }'` ).test( ALL_TEXT )

/** Wildcards match by prefix — they can neither dangle nor vouch for a topic. */
const isWildcard = ( topic: string ): boolean => topic === '*' || topic.endsWith('.*')

/**
 * Subscriptions with no publisher that are DELIBERATE. Each is a host seam: a
 * Will is a container something else rents, and a host embedding one in its own
 * world publishes these under its own vocabulary. Empty means nobody is speaking,
 * not that nothing is wired.
 *
 * Adding to this list should be a conscious act with a reason, exactly like
 * EXPECTED_UNWIRED. If a topic here gains a real publisher, remove it.
 */
const EXPECTED_DANGLING: Record<string, string> = {}

describe('bus wiring — nothing listens for what nobody says', () => {
  it('every declared subscription has a publisher, or is a pinned host seam', () => {
    const dangling = [ ...declaredSubscriptions().entries() ]
      .filter( ( [ topic ] ) => !isWildcard( topic ) )
      .filter( ( [ topic ] ) => !hasPublisher( topic ) )
      .filter( ( [ topic ] ) => !( topic in EXPECTED_DANGLING ) )
      .map( ( [ topic, files ] ) => `${ topic } ← ${ files.join(', ') }` )

    // If this fails, one of two things is true and they have different fixes:
    //   • the capability has no producer — wire one (see #114's composite seam);
    //   • it is a host seam — add it to EXPECTED_DANGLING with the reason.
    expect( dangling ).toEqual( [] )
  } )

  it('finds the subscriptions it is meant to be scanning', () => {
    // Guards the regex itself: a parser that silently matches nothing would make
    // the test above pass forever. These are stable, load-bearing topics.
    const subs = declaredSubscriptions()
    expect( subs.size ).toBeGreaterThan( 30 )
    expect( subs.has('executive.prediction.formed') ).toBe( true )
    expect( subs.has('agency.composite.proposed') ).toBe( true )
  } )

  it('recognises a real publisher when there is one', () => {
    // Guards the other half: a `hasPublisher` that always returned true would
    // equally make the main test vacuous.
    expect( hasPublisher('energy.state.changed') ).toBe( true )
    expect( hasPublisher('agency.composite.proposed') ).toBe( true )
    expect( hasPublisher('this.topic.does.not.exist') ).toBe( false )
  } )
} )

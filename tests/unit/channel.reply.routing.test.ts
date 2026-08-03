// ─────────────────────────────────────────────────────────────
// tests/unit/channel.reply.routing.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A reply goes back to the room the question was asked in.
 *
 * Observed on a live Will, and the most expensive failure of the lot because it
 * is invisible from both ends: her operator DM'd her "Hi Lora". She perceived it
 * on thread `discord:1532693953671860484`, answered in 26 seconds, and four
 * bubbles went out — to `1531261362838441996`, the shared server channel, because
 * that was the last room the roster had seen him in.
 *
 * From his side she had ignored him. From the trace she had answered promptly.
 * Nothing logged an error: `deliver()` found A channel, sent successfully, and
 * returned. The only thing wrong was WHICH.
 *
 * The cause was a projection gap, not a routing bug. `OutboxMessage.threadId`
 * carried the room the whole way down, and `WillMessage` dropped it — so a
 * channel adapter had nothing to answer INTO and could only guess from a roster
 * of where people usually are. Both shipped bridges guessed the same way.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join( process.cwd(), 'src')
const read = ( p: string ): string => readFileSync( join( SRC, p ), 'utf8')

/** Comments stripped — the prose above each fix quotes the old ordering. */
const code = ( p: string ): string => read( p )
  .replace( /\/\*[\s\S]*?\*\//g, '')
  .replace( /(^|[^:])\/\/[^\n]*/g, '$1')

describe('the thread survives the projection boundary', () => {
  it('WillMessage carries the thread it is answering', () => {
    expect( code('sdk/will.ts') ).toMatch( /interface WillMessage[\s\S]*?thread\?: string/ )
  } )

  it('the tick listener forwards the outbox message\'s threadId onto it', () => {
    // The engine always knew this; only the projection dropped it.
    const emit = code('sdk/will.ts')
    expect( emit ).toMatch( /thread: msg\.threadId/ )
  } )
} )

describe('every bridge answers into the room it was addressed in', () => {
  const bridges = [
    { file: 'channels/discord.ts',  prefix: 'discord:',  list: 'channelIds' },
    { file: 'channels/whatsapp.ts', prefix: 'whatsapp:', list: 'targets' },
  ]

  for( const b of bridges ){
    it(`${b.file} derives a reply target from m.thread`, () => {
      const src = code( b.file )
      expect( src ).toContain('m.thread?.startsWith(')
      expect( src ).toContain( b.prefix )
    } )

    it(`${b.file} tries that target FIRST, ahead of every roster guess`, () => {
      // Ordering is the whole fix. `lastChannelId` first is what sent a DM reply
      // to a public channel — it is not wrong data, it is the wrong question.
      const src  = code( b.file )
      const line = src.split('\n').find( l => l.includes(`const ${b.list} = [`) ) ?? ''
      expect( line, `${b.file}: could not find the ${b.list} array` ).not.toBe('')

      const order = line.slice( line.indexOf('[') ).split(',').map( s => s.trim() )
      expect( order[0] ).toContain('replyTo')
      expect( order.findIndex( s => s.includes('lastChannelId') ) ).toBeGreaterThan( 0 )
    } )
  }
} )

describe('an unprompted utterance still falls through to the roster', () => {
  it('keeps the roster candidates after the thread, never instead of them', () => {
    // A self-initiated message answers nothing, so it genuinely has no thread.
    // Dropping the roster fallbacks would have made the Will unable to speak
    // first at all — a worse failure than the one being fixed.
    for( const f of [ 'channels/discord.ts', 'channels/whatsapp.ts' ] ){
      const src = code( f )
      expect( src ).toMatch( /peer\?\.lastChannelId/ )
      expect( src ).toMatch( /peer\?\.dmChannelId/ )
    }
  } )
} )

describe('a woken mind is not warned about the placeholder it was built with', () => {
  it('Will.wake declares its identity deferred to the artifact', () => {
    expect( code('sdk/will.ts') ).toContain('config.identityFromArtifact = true')
  } )

  it('assembleMind suppresses only the WARNINGS, never the errors', () => {
    // Three alarms per wake — values empty, style generic, identity shallow —
    // all about a `{ prompt: '' }` placeholder that PMALoader replaces seconds
    // later. Noise that trains an operator to ignore a guard that may one day
    // be right. Errors still throw: a malformed prompt is a hard failure
    // whenever it appears.
    const mind = code('stem/mind.ts')
    const block = mind.slice( mind.indexOf('if( !idGuard.ok )'), mind.indexOf('idGuard.sanitized.identity') )
    expect( block ).toContain('throw new Error')
    expect( block ).toContain('config.identityFromArtifact')
  } )

  it('the artifact\'s OWN identity is still fully guarded, where it is knowable', () => {
    // "Is this persona thin?" is only answerable once the artifact has loaded.
    const pma = code('stem/tracts/pma.controller.ts')
    expect( pma ).toContain('validateWillIdentity(')
    expect( pma ).toContain('guard.warnings')
  } )
} )

// ── conversation records must outlive the process that wrote them ──

describe('a restart does not erase what the mind said last time', () => {
  const audition = code('cognition/senses/audition.engine/engine.ts')

  it('keys conversation records on the SIM tick, not a process counter', () => {
    // `conv-sent-reply-<entity>-<N>` with N a per-process counter restarted at 1
    // on every boot, so each session overwrote the previous session's records of
    // the same person. Found by diffing a live snapshot against the Discord
    // transcript it came from: one id held that morning's greeting and every
    // earlier conversation keyed to it was simply gone.
    expect( audition ).not.toMatch( /_sentSeq|_receivedSeq/ )
    expect( audition ).toContain('_lastDecisionTick')
    expect( audition ).toMatch( /_sentKey\([\s\S]{0,80}\)/ )
  } )

  it('takes that tick from the facet decision, never from the wall clock', () => {
    // These ids live in state; a wall-clock id makes recorded and replayed runs
    // diverge (R2) — observed once as a replay consuming 17 of 18 completions.
    expect( audition ).toContain('decision.tick')
    const key = audition.slice( audition.indexOf('private _sentKey'), audition.indexOf('private _writeReceived') )
    expect( key ).not.toContain('wallClock')
    expect( key ).toContain('this._lastDecisionTick')
  } )

  it('distinguishes two utterances to one person on one tick', () => {
    // Tick alone is not enough — a reply and an outreach can land on the same one.
    const key = audition.slice( audition.indexOf('private _sentKey'), audition.indexOf('private _writeReceived') )
    expect( key ).toContain('fnv1a(')
  } )

  it('carries the tick on FacetDecision so a subscriber has a clock at all', () => {
    const facet = code('cognition/faculties/executive.engine/facet.ts')
    expect( facet ).toMatch( /interface FacetDecision[\s\S]*?tick: number/ )
    expect( facet ).toContain('tick: currentState.tick')
  } )
} )

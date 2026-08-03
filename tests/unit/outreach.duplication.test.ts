// ─────────────────────────────────────────────────────────────
// tests/unit/outreach.duplication.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * One person, one message at a time — and silence when there is nothing to say.
 *
 * Two independent paths put the same words in front of the same human twice, and
 * both were observed in production inside four minutes:
 *
 *   • `authorOutreach` was unguarded. The agency can hold more than one intent
 *     toward the same target (two undertakings, or an undertaking plus a
 *     self-initiated reach); each spawned its own transient facet, each composed
 *     independently, and both were delivered. The executor's idempotence is keyed
 *     by INTENT id, which cannot see that two intents mean one conversation.
 *     Live result: "What's currently in flight at Mindot?" — four times, reworded.
 *
 *   • The reply format presented [REPLY_TEXT] as a required step with no stated
 *     way to stay silent, so a mind that had decided NOT to speak wrote its
 *     decision into the block. Its operator received, verbatim:
 *         "[No outbound message this cycle — waiting for response to prior inquiry]"
 *     The delivery path already treats an empty block as silence. Only the
 *     contract was missing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuditionEngine } from '#senses/audition.engine/engine'

// ── 1. one authoring pass per person ──────────────────────────

/**
 * A mock executive whose facets never settle until released.
 *
 * `open` pre-registers a facet under a supervisor key, so `facetFor` finds it —
 * that is how the engine models "already in conversation with this person".
 */
function heldExecutive( open: Record<string, string> = {} ){
  let spawns = 0
  const release: Array<( bubbles: string[], type?: string ) => void> = []
  const destroyed: string[] = []
  const reports: Array<{ facetId: string; type: string; focusTitle?: string; standingFocus?: string }> = []

  const makeFacet = ( facetId: string ) => {
    const subscribers = new Set<( d: unknown ) => void>()
    let standing: { title?: string } | undefined
    return {
      facetId,
      report( r: { type: string; focus?: { title?: string } } ){
        reports.push( { facetId, type: r.type, focusTitle: r.focus?.title, standingFocus: standing?.title } )
        release.push( ( bubbles, type = r.type ) => {
          for( const fn of subscribers ) fn({
            facetId, respondingToType: type,
            decision: { reply: bubbles.join('\n'), replyBubbles: bubbles, targetEntityId: 'fabrice', requiresMasterAttention: false },
            reasoning: '', confidence: 0.9,
          })
        } )
      },
      subscribe( fn: ( d: unknown ) => void ){ subscribers.add( fn ); return () => { subscribers.delete( fn ) } },
      setFocus( f: { title?: string } ){ standing = f },
      setStateRef(){}, onChunk(){}, onReaped(){},
      destroy(){ destroyed.push( facetId ) },
    }
  }

  const keyed = new Map( Object.entries( open ).map( ( [ k, id ] ) => [ k, makeFacet( id ) ] ) )

  const engine = {
    facetFor( key: string ){ return keyed.get( key ) },
    spawnFacet(){
      spawns++
      return { attention: 'available' as const, handle: makeFacet(`facet-${spawns}`) }
    },
  }
  return { engine, get spawns(){ return spawns }, release, destroyed, reports }
}

const settle = () => new Promise( r => setTimeout( r, 0 ) )

describe('authorOutreach — two intents toward one person are one message', () => {
  it('refuses a second concurrent pass for the same target', async () => {
    const ctrl   = heldExecutive()
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const first  = engine.authorOutreach('fabrice', 'Fabrice', 'ask what is in flight')
    await settle()
    // A second intent toward Fabrice lands while the first is still composing.
    const second = await engine.authorOutreach('fabrice', 'Fabrice', 'ask what is stalled')

    expect( second, 'the duplicate must not produce words of its own').toEqual( [] )
    expect( ctrl.spawns, 'and must not open a second authoring facet').toBe( 1 )

    ctrl.release[0]!( [ "What's currently in flight at Mindot?" ] )
    expect( await first ).toEqual( [ "What's currently in flight at Mindot?" ] )
  } )

  it('releases the guard once the pass lands, so the next one can proceed', async () => {
    const ctrl   = heldExecutive()
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const first = engine.authorOutreach('fabrice', 'Fabrice')
    await settle()
    ctrl.release[0]!( [ 'first' ] )
    await first

    const second = engine.authorOutreach('fabrice', 'Fabrice')
    await settle()
    ctrl.release[1]!( [ 'second' ] )
    expect( await second ).toEqual( [ 'second' ] )
    expect( ctrl.spawns ).toBe( 2 )
  } )

  it('never blocks a DIFFERENT person — the guard is per target, not global', async () => {
    const ctrl   = heldExecutive()
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const toFabrice = engine.authorOutreach('fabrice', 'Fabrice')
    await settle()
    const toAda     = engine.authorOutreach('ada', 'Ada')
    await settle()

    expect( ctrl.spawns ).toBe( 2 )
    ctrl.release[0]!( [ 'f' ] ); ctrl.release[1]!( [ 'a' ] )
    expect( await toFabrice ).toEqual( [ 'f' ] )
    expect( await toAda ).toEqual( [ 'a' ] )
  } )

  it('clears the guard even when the facet throws, so nobody becomes unreachable', async () => {
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( {
      facetFor: () => undefined,
      spawnFacet: () => ( { attention: 'available' as const, handle: {
        facetId: 'f', report(){ throw new Error('boom') },
        subscribe(){ return () => {} },
        setFocus(){}, setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      } } ),
    } as never )

    expect( await engine.authorOutreach('fabrice', 'Fabrice') ).toEqual( [] )
    // Second attempt must not be refused by a guard the failure left set.
    expect( await engine.authorOutreach('fabrice', 'Fabrice') ).toEqual( [] )
  } )
} )

// ── 2. silence is a stated option ─────────────────────────────

describe('the reply contract gives the mind a way to say nothing', () => {
  // Bounded by hand: the constant embeds escaped backticks (a ```json fence), so
  // a lazy match to the next ` stops inside it.
  const src    = readFileSync( join( process.cwd(), 'src/cognition/senses/audition.engine/engine.ts'), 'utf8')
  const start  = src.indexOf('const CONVERSATION_OUTPUT_FORMAT')
  const format = src.slice( start, src.indexOf('do NOT escalate. Just reply.', start ) )

  it('exists at all', () => {
    expect( start ).toBeGreaterThan( -1 )
    expect( format.length ).toBeGreaterThan( 500 )
  } )

  it('names no architecture — this text IS a facet\'s contract with itself', () => {
    // Same defect as the system prompt, second location: "my master consciousness",
    // "the task description the master sees", "the master's domain". Every one of
    // them hands a conversation facet a second party it can address.
    expect( format.toLowerCase() ).not.toContain('master')
  } )

  it('says omitting or emptying the block sends nothing', () => {
    expect( format ).toMatch( /omit the \[REPLY_TEXT\] block/i )
    expect( format ).toMatch( /Silence is a real choice/i )
  } )

  it('warns that narrating the silence INSIDE the block delivers that sentence', () => {
    // This is the part that actually failed: the mind knew it should not speak and
    // said so in the one place that is transmitted.
    expect( format ).toMatch( /anything I put between\s+those markers IS SENT/i )
  } )
} )

// ── 3. speaking inside a conversation already open ────────────

describe('an unprompted message to someone I am already talking to', () => {
  it('is said BY that conversation, not by a stranger composing in parallel', async () => {
    // The transient facet could not see the live thread — not the digest, not what
    // was said two minutes ago, not the thinking the open facet had been doing. So
    // the mind asked a question it had already asked while the answer sat in a
    // thread it was not reading.
    const ctrl   = heldExecutive({ 'conversation:fabrice': 'facet-live' })
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const words = engine.authorOutreach('fabrice', 'Fabrice', 'the RFC is still unanswered')
    await settle()

    expect( ctrl.spawns, 'no second facet is opened for a person already being talked to').toBe( 0 )
    expect( ctrl.reports[0]!.facetId ).toBe('facet-live')

    ctrl.release[0]!( [ 'Still nothing back from MindBurn.' ] )
    expect( await words ).toEqual( [ 'Still nothing back from MindBurn.' ] )
  } )

  it('rides on the REPORT, leaving the conversation\'s standing focus untouched', async () => {
    // A setFocus() here would clobber whatever the live turn was set up for, and
    // race with any report already queued behind it.
    const ctrl   = heldExecutive({ 'conversation:fabrice': 'facet-live' })
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    void engine.authorOutreach('fabrice', 'Fabrice')
    await settle()

    expect( ctrl.reports[0]!.focusTitle, 'the outreach focus comes in on the report').toBe('Reaching out')
    expect( ctrl.reports[0]!.standingFocus, 'and the facet\'s own focus was never set from here').toBeUndefined()
  } )

  it('never destroys the conversation it borrowed', async () => {
    const ctrl   = heldExecutive({ 'conversation:fabrice': 'facet-live' })
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const words = engine.authorOutreach('fabrice', 'Fabrice')
    await settle()
    ctrl.release[0]!( [ 'hi' ] )
    await words

    expect( ctrl.destroyed, 'destroying it would end the conversation as a side effect of speaking in it').toEqual( [] )
  } )

  it('still destroys a transient it opened itself', async () => {
    const ctrl   = heldExecutive()   // nobody open
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    const words = engine.authorOutreach('fabrice', 'Fabrice')
    await settle()
    ctrl.release[0]!( [ 'hi' ] )
    await words

    expect( ctrl.destroyed ).toEqual( [ 'facet-1' ] )
  } )

  it('does not resolve on the conversation\'s ordinary replies', async () => {
    // Sharing a facet means its reply decisions arrive on the same subscription.
    // Resolving on one would hand the human's reply back as words the mind had
    // composed unprompted — and deliver it a second time.
    const ctrl   = heldExecutive({ 'conversation:fabrice': 'facet-live' })
    const engine = new AuditionEngine()
    engine.attachExecutiveEngine( ctrl.engine as never )

    let settled = false
    const words = engine.authorOutreach('fabrice', 'Fabrice').then( w => { settled = true; return w } )
    await settle()

    ctrl.release[0]!( [ 'an ordinary reply to something he asked' ], 'language_percept')
    await settle()
    expect( settled, 'a reply decision must not settle the outreach').toBe( false )

    ctrl.release[0]!( [ 'the unprompted thing' ], 'outreach')
    expect( await words ).toEqual( [ 'the unprompted thing' ] )
  } )
} )

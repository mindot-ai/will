// ─────────────────────────────────────────────────────────────
// tests/unit/audition.memory.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Section 5 — conversation → working memory → consolidator → vector.
 *
 *   - Each completed exchange is persisted as a `working_memory.item` state
 *     entity (wmType: 'conversation.exchange') via the injected memory sink,
 *     so the EpisodicConsolidator consolidates it on its next tick.
 *   - The facet focus is primed with vector-recalled prior memories.
 *   - Recall failure is non-fatal.
 */

import { describe, it, expect } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import { createTestBus }  from '#cognition/bus'
import type { TextMessage } from '#senses/index'

/** Executive whose facet fires a canned decision synchronously on report(). */
function syncExecutive( opts: { reply?: string; confidence?: number; onFocus?: ( f: any ) => void } = {} ){
  const { reply = 'Mock reply', confidence = 0.9, onFocus } = opts
  return {
    spawnFacet(){
      let sub: (( d: any ) => void) | null = null
      const handle = {
        facetId: 'f1',
        report(){
          sub?.({
            decision: { reply, replyBubbles: reply ? [reply] : [], targetEntityId: 'alice', requiresMasterAttention: false },
            reasoning: '',
            confidence,
          })
        },
        subscribe( fn: any ){ sub = fn; return () => { sub = null } },
        setFocus( f: any ){ onFocus?.( f ) },
        setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }
}

const text = ( content: string, entityId = 'alice'): TextMessage =>
  ({ kind: 'text', entityId, threadId: 't1', content, provenance: 'exafferent' })

describe('AuditionEngine — conversation memory (Section 5)', () => {
  it('persists a conversation.exchange WM item after a completed exchange', async () => {
    const entities: any[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    engine.attachMemorySink( e => entities.push( e ) )

    await engine.sense( text('hello there') )

    // The sink is a general state writer — it also carries the inbound social
    // signal (conversation.received) now, so select the exchange rather than
    // assuming the sink saw exactly one thing.
    const exchanges = entities.filter( x => x.type === 'working_memory.item')
    expect( exchanges ).toHaveLength( 1 )
    const e = exchanges[0]
    expect( e.type ).toBe('working_memory.item')
    expect( e.metadata.wmType ).toBe('conversation.exchange')
    expect( e.metadata.summary ).toContain('hello there')
    expect( e.metadata.summary ).toContain('Mock reply')
    expect( e.metadata.tags ).toContain('entity:alice')
    expect( e.metadata.tags ).toContain('conversation')
    expect( e.metadata.activation ).toBeGreaterThanOrEqual( 0.6 )
    expect( e.metadata.activation ).toBeLessThanOrEqual( 1 )
    // setEntity stamps the sim-clock timestamps — the engine must not supply them.
    expect( e ).not.toHaveProperty('createdAt')
  } )

  it('still records the inbound even when the reply is empty', async () => {
    const entities: any[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive({ reply: '' }) as any )
    engine.attachMemorySink( e => entities.push( e ) )

    await engine.sense( text('remember this') )

    const exchanges = entities.filter( x => x.type === 'working_memory.item')
    expect( exchanges ).toHaveLength( 1 )
    expect( exchanges[0].metadata.summary ).toContain('remember this')
  } )

  // §5 — recall is unified: the facet sets focus.recallQuery (the live message),
  // which drives the single "## Relevant Memories" section in buildExecutiveContext.
  // The AuditionEngine no longer injects a separate recall block into the focus.
  it('drives unified recall via focus.recallQuery = the live message', async () => {
    const focuses: any[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive({ onFocus: f => focuses.push( f ) }) as any )

    await engine.sense( text('what about tomorrow?') )

    expect( focuses.length ).toBeGreaterThanOrEqual( 1 )
    expect( focuses[0].recallQuery ).toBe('what about tomorrow?')
  } )

  it('does NOT inject a separate recall block into the focus content', async () => {
    const focuses: any[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive({ onFocus: f => focuses.push( f ) }) as any )

    await engine.sense( text('hi') )

    expect( focuses[0].content ).not.toContain('Relevant memories')
    expect( focuses[0].content ).not.toContain('recalled')
  } )

  it('no memory sink attached → ingest still succeeds (no throw)', async () => {
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    await expect( engine.sense( text('hi') ) ).resolves.toBeUndefined()
  } )
} )

describe('AuditionEngine — reply fast-path callback (Section 2.1)', () => {
  it('fires the reply callback with bubbles when talk is allowed', async () => {
    const replies: Array<{ entityId: string; threadId: string; bubbles: string[] }> = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive({ reply: 'Hi there' }) as any )
    engine.attachGrants({ isAllowed: () => true } as any )   // listen + talk allowed
    engine.attachReplyCallback( ( entityId, threadId, bubbles ) => replies.push({ entityId, threadId, bubbles }) )

    await engine.sense( text('hello') )

    expect( replies ).toHaveLength( 1 )
    expect( replies[0] ).toEqual({ entityId: 'alice', threadId: 't1', bubbles: ['Hi there'] })
  } )

  it('does NOT fire the reply callback when talk is denied', async () => {
    const replies: unknown[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive({ reply: 'Hi' }) as any )
    engine.attachGrants({ isAllowed: ( a: string ) => a === 'listen' } as any )   // talk denied
    engine.attachReplyCallback( ( e, t, b ) => replies.push({ e, t, b }) )

    await engine.sense( text('hello') )

    expect( replies ).toHaveLength( 0 )
  } )
} )

describe('AuditionEngine — salience inputs (§3) + thread keying (§2)', () => {
  it('consults the attachment + active-goal accessors for salience', async () => {
    const attachCalls: string[] = []
    let goalCalls = 0
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    engine.attachAttachmentScore( id => { attachCalls.push( id ); return 0.9 } )
    engine.attachActiveGoalText( () => { goalCalls++; return ['ship it'] } )

    await engine.sense( text('hello') )

    expect( attachCalls ).toEqual( ['alice'] )
    expect( goalCalls ).toBeGreaterThanOrEqual( 1 )
  } )

  it('replies on the CURRENT thread when an entity spans multiple threads (§2)', async () => {
    const threads: string[] = []
    const engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( syncExecutive() as any )
    engine.attachGrants({ isAllowed: () => true } as any )
    engine.attachReplyCallback( ( _e, threadId ) => threads.push( threadId ) )

    await engine.sense({ kind: 'text', entityId: 'alice', threadId: 't1', content: 'hi', provenance: 'exafferent' })
    await engine.sense({ kind: 'text', entityId: 'alice', threadId: 't2', content: 'hi again', provenance: 'exafferent' })

    // Same facet (reused), but the reply follows the current turn's thread —
    // not the spawn-time thread 't1'.
    expect( threads ).toEqual( ['t1', 't2'] )
  } )
} )

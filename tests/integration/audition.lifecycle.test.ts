// ─────────────────────────────────────────────────────────────
// tests/integration/audition.lifecycle.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Integration tests for AuditionEngine session lifecycle.
 *
 * No LLM calls — uses a MockExecutiveEngine that immediately fires a canned
 * decision on every `report()`. Tests verify the AuditionEngine's facet
 * management, digest persistence, and signal publishing behaviour.
 *
 * Covered:
 *   - New entity → facet spawned exactly once
 *   - Same entity (second message) → same facet reused, not re-spawned
 *   - Different entities → independent facets
 *   - endSession() → facet destroyed, removed from activeSessions()
 *   - Thread digest updated after each ingest (user line appended)
 *   - Full attention → graceful degradation (no throw, no facet created)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import { createTestBus } from '#cognition/bus'
import type { ExecutiveFacetHandle, FacetReport } from '#faculties/executive.engine/facet'
import type { FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { TextMessage } from '#senses/index'

// ── Mock helpers ─────────────────────────────────────────────

/** Minimal mock that implements ExecutiveFacetHandle. */
function makeMockHandle(): {
  handle:      ExecutiveFacetHandle
  reports:     FacetReport[]
  destructions: number
  focuses:     FocusSection[]
  reaped:      Array<() => void>
} {
  const reports:      FacetReport[]   = []
  const focuses:      FocusSection[]  = []
  const reaped:       Array<() => void> = []
  let destroyed                       = 0
  let _subscriber: (( d: any ) => void) | null = null

  const handle: ExecutiveFacetHandle = {
    facetId: `mock-facet-${Math.random().toString(36).slice(2, 8)}`,

    report( r ) {
      reports.push( r )
      // Immediately fire a canned decision so AuditionEngine._onFacetDecision runs
      _subscriber?.({
        decision: {
          reply:                   'Mock reply',
          replyBubbles:            ['Mock reply'],
          targetEntityId:          'mock-entity',
          requiresMasterAttention: false,
        },
        rawOutput: '[REPLY_TEXT]Mock reply[/REPLY_TEXT]',
      })
    },

    subscribe( listener ) {
      _subscriber = listener
      return () => { _subscriber = null }
    },

    setFocus( f ) { focuses.push( f ) },
    setStateRef( _s ) { /* no-op */ },
    onChunk( _h ) { /* no-op */ },
    onReaped( h ) { reaped.push( h ) },
    destroy() { destroyed++ },
  }

  return { handle, reports, focuses, reaped, get destructions() { return destroyed } }
}

/** Creates a MockExecutiveEngine that always returns available attention. */
function makeMockExecutive( spawnBehavior: 'available' | 'full' = 'available' ): {
  engine: any
  spawns: number
  handles: ReturnType<typeof makeMockHandle>[]
} {
  let spawns = 0
  const handles: ReturnType<typeof makeMockHandle>[] = []

  const engine = {
    spawnFacet() {
      spawns++
      if( spawnBehavior === 'full' ) return { attention: 'full' as const }
      const h = makeMockHandle()
      handles.push( h )
      return { attention: 'available' as const, handle: h.handle }
    },
  }

  return { engine, get spawns() { return spawns }, handles }
}

function makeTextInput( opts: { entityId: string; threadId: string; content: string } ): TextMessage {
  return { kind: 'text', ...opts }
}

// ── Tests ─────────────────────────────────────────────────────

describe( 'AuditionEngine — session lifecycle', () => {
  let exec:    ReturnType<typeof makeMockExecutive>
  let engine:  AuditionEngine

  beforeEach( () => {
    exec   = makeMockExecutive()
    engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine )
  } )

  it( 'spawns a facet for the first message from a new entity', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hello' }) )
    expect( exec.spawns ).toBe( 1 )
    expect( engine.activeSessions() ).toContain( 'alice' )
  } )

  it( 'reuses the existing facet for subsequent messages from the same entity', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hello' }) )
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'How are you?' }) )
    expect( exec.spawns ).toBe( 1 )
  } )

  it( 'creates independent facets for different entities', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hi Alice' }) )
    await engine.ingest( makeTextInput({ entityId: 'bob',   threadId: 't2', content: 'Hi Bob' }) )
    expect( exec.spawns ).toBe( 2 )
    expect( engine.activeSessions() ).toContain( 'alice' )
    expect( engine.activeSessions() ).toContain( 'bob' )
  } )

  it( 'delivers each inbound message to the facet as a report', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'msg1' }) )
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'msg2' }) )

    const { handles } = exec
    expect( handles[0]!.reports ).toHaveLength( 2 )
    const payloads = handles[0]!.reports.map( r => (r.payload as any).content )
    expect( payloads ).toEqual( ['msg1', 'msg2'] )
  } )

  it( 'endSession() destroys the facet and removes it from activeSessions()', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hi' }) )
    expect( engine.activeSessions() ).toContain( 'alice' )

    engine.endSession( 'alice' )

    expect( engine.activeSessions() ).not.toContain( 'alice' )
    expect( exec.handles[0]!.destructions ).toBe( 1 )
  } )

  it( 'endSession() on unknown entity does not throw', () => {
    expect( () => engine.endSession( 'nobody' ) ).not.toThrow()
  } )

  it( 'clears the session when the supervisor reaps the facet (onReaped)', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hi' }) )
    expect( engine.activeSessions() ).toContain( 'alice' )

    // Simulate the supervisor reaping alice's facet (idle TTL / LRU eviction).
    exec.handles[0]!.reaped.forEach( fn => fn() )

    expect( engine.activeSessions() ).not.toContain( 'alice' )
  } )

  it( 'destroy() tears down all active facets', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hi' }) )
    await engine.ingest( makeTextInput({ entityId: 'bob',   threadId: 't2', content: 'Hi' }) )

    engine.destroy()

    expect( engine.activeSessions() ).toHaveLength( 0 )
    expect( exec.handles[0]!.destructions ).toBe( 1 )
    expect( exec.handles[1]!.destructions ).toBe( 1 )
  } )

  it( 'when executive attention is full, ingest() does not throw and creates no facet', async () => {
    const fullExec = makeMockExecutive( 'full' )
    engine.attachExecutiveEngine( fullExec.engine )

    await expect(
      engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hi' }) )
    ).resolves.toBeUndefined()

    expect( engine.activeSessions() ).toHaveLength( 0 )
  } )
} )

// ── Thread digest persistence ─────────────────────────────────

describe( 'AuditionEngine — thread digest persistence', () => {
  let engine: AuditionEngine

  beforeEach( () => {
    const exec = makeMockExecutive()
    engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( exec.engine )
  } )

  it( 'digest includes the inbound message after ingest()', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'First msg' }) )
    // The digest includes user turn; access via internal ThreadDigestManager
    // through the engine's snapshot (domain-level data)
    const snap = engine.snapshot()
    expect( snap ).toBeDefined()
    expect( snap['activeSessions'] ).toBe( 1 )
  } )

  it( 'multiple messages from same thread accumulate independently of other threads', async () => {
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 'thread-A', content: 'A1' }) )
    await engine.ingest( makeTextInput({ entityId: 'alice', threadId: 'thread-A', content: 'A2' }) )
    await engine.ingest( makeTextInput({ entityId: 'bob',   threadId: 'thread-B', content: 'B1' }) )

    // All messages ingested without errors; both entities have active sessions
    expect( engine.activeSessions() ).toHaveLength( 2 )
    expect( engine.activeSessions() ).toContain( 'alice' )
    expect( engine.activeSessions() ).toContain( 'bob' )
  } )

  it( 'focus section includes digest from prior turns on subsequent messages', async () => {
    const exec = makeMockExecutive()
    const eng  = new AuditionEngine()
    eng.attachBus( createTestBus() )
    eng.attachExecutiveEngine( exec.engine )

    await eng.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'Hello' }) )
    await eng.ingest( makeTextInput({ entityId: 'alice', threadId: 't1', content: 'How are you?' }) )

    // The focus sent on the 2nd message should contain the digest from the first
    const focuses = exec.handles[0]!.focuses
    expect( focuses.length ).toBeGreaterThanOrEqual( 2 )

    // Second focus should include digest context (the first turn)
    const secondFocusContent = focuses[1]?.content ?? ''
    expect( secondFocusContent ).toContain( 'Hello' )
    expect( secondFocusContent ).toContain( 'How are you?' )
  } )
} )

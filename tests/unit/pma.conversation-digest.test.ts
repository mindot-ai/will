// ─────────────────────────────────────────────────────────────
// tests/unit/pma.conversation-digest.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §8 — PMA conversation-context transfer (replaces ConversationManager).
 *
 *   - distill(): the per-relationship `lastConversationDigest` is derived from
 *     the most recent consolidated `conversation.exchange` episode (was: read
 *     from a `conversation.session` entity seeded by ConversationManager).
 *   - load(): the digest is re-seeded as a `conversation.exchange` working-memory
 *     item (tagged `pma-restored`) so it flows through the normal memory pipeline
 *     on restart (was: ConversationManager.seedFromDigest).
 */

import { describe, it, expect } from 'vitest'
import { PMADistiller, PMALoader, type PMASnapshot, PMA_SCHEMA_VERSION } from '#pma/index'
import { assembleMind, type WillConfig } from '#stem/mind'
import type { SimulationState, SimulationEntity } from '#core/types'

// ── Helpers ────────────────────────────────────────────────────

const episode = ( keid: string, name: string, summary: string, tick: number ): SimulationEntity => ({
  id:        `episodic-${tick}`,
  type:      'episodic_memory',
  createdAt: tick,
  updatedAt: tick,
  metadata: {
    sourceType: 'conversation.exchange',
    tags:       [ 'conversation', 'exchange', `entity:${keid}` ],
    tick,
    content: {
      summary,
      entityId:   keid,
      entityName: name,
      tick,
    },
  },
} as any)

const reputation = ( keid: string, name: string ): SimulationEntity => ({
  id:        `reputation-${keid}`,
  type:      'reputation',
  createdAt: 0,
  updatedAt: 0,
  metadata: { keid, name, interactionCount: 3 },
} as any)

const stateOf = ( entities: SimulationEntity[] ): SimulationState => ({
  tick:     0,
  time:     0,
  metrics:  new Map<string, number>(),
  entities: new Map( entities.map( e => [ e.id, e ] ) ),
})

const BASE_CONFIG: Omit<WillConfig, 'id'> = {
  name:             'TestWill',
  anatomy: 'reflex',
  persistentMemory: false,
  snapshotInterval: 999999,
  tickIntervalMs:   0,
  maxTicks:         0,
  identity: { prompt: 'Test.', values: [ 'x' ], style: 'concise', traits: {} },
}

// ── Tests ──────────────────────────────────────────────────────

describe( 'PMA — conversation digest derivation (§8 distill)', () => {
  it( 'derives lastConversationDigest from the most recent conversation.exchange episode', () => {
    const state = stateOf([
      reputation( 'alice', 'Alice' ),
      episode( 'alice', 'Alice', 'EARLIER summary', 3 ),
      episode( 'alice', 'Alice', 'LATEST summary',  9 ),
    ])

    const pma = new PMADistiller().distill( 'w', 'W', state, 's' )
    const alice = pma.relationships.find( r => r.keid === 'alice' )

    expect( alice ).toBeDefined()
    expect( alice!.lastConversationDigest ).toBe( 'LATEST summary' )
  } )

  it( 'leaves the digest unset when there is no conversation episode', () => {
    const pma = new PMADistiller().distill( 'w', 'W', stateOf([ reputation( 'bob', 'Bob' ) ]), 's' )
    const bob = pma.relationships.find( r => r.keid === 'bob' )
    expect( bob?.lastConversationDigest ).toBeUndefined()
  } )
} )

describe( 'PMA — conversation digest restore (§8 load)', () => {
  it( 're-seeds the digest as a conversation.exchange working-memory item', () => {
    const { simulation, cognition } = assembleMind( 'pma-digest-restore', { id: 'pma-digest-restore', ...BASE_CONFIG } )

    const pma: PMASnapshot = {
      schemaVersion:   PMA_SCHEMA_VERSION,
      willId:          'w',
      willName:        'W',
      distilledAt:     Date.now(),
      sourceSessionId: 's',
      identity: { prompt: 'I am.', values: [ 'x' ], traits: {}, style: 'concise', version: 1 },
      beliefs: [],
      goals:   [],
      emotionalBaseline: {} as any,
      behavioral:        {} as any,
      relationships: [
        { keid: 'alice', agentName: 'Alice', lastConversationDigest: 'we agreed to meet Friday' },
      ],
      episodicCount: 0,
      meta: { beliefCount: 0, goalCount: 0, relationshipCount: 1, sessionSummaryCount: 0 },
    }

    new PMALoader().load( pma, simulation, cognition )

    const restored = simulation.stateManager.getEntity( 'wm-exchange-restored-alice' )
    expect( restored ).toBeDefined()
    expect( restored!.type ).toBe( 'working_memory.item' )
    const md = ( restored!.metadata ?? {} ) as Record<string, unknown>
    expect( md.wmType ).toBe( 'conversation.exchange' )
    expect( md.summary ).toBe( 'we agreed to meet Friday' )
    expect( md.tags ).toContain( 'pma-restored' )
    expect( md.tags ).toContain( 'entity:alice' )
    expect( md.entityId ).toBe( 'alice' )
  } )
} )

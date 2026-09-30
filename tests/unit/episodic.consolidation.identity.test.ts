// ─────────────────────────────────────────────────────────────
// tests/unit/episodic.consolidation.identity.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * One working-memory item becomes one episode — and two different ones become two.
 *
 * The consolidator deduplicated on the first 100 characters of an item's JSON.
 * For a conversation that prefix is boilerplate:
 *
 *   {"wmType":"conversation.exchange","activation":0.85,"attendedCount":3,"tags":["conversation","exchan
 *
 * identical for every exchange with every person. Reproduced against a live
 * engine: Ada's message consolidated, Bo's — a different person saying a
 * different thing — never did, because it was "already remembered". A mind whose
 * snapshots held zero episodes on every one of 2,095 ticks was not forgetting fast;
 * it was never remembering the second thing at all (LOSSLESS P0).
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { buildConversationExchange } from '#cognition/conversation.memory'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState, SimulationEntity, StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )

function stateOf( tick: number, entities: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> ): ReadonlySimulationState {
  return {
    tick, time: tick * 1000, metrics: new Map(),
    entities: new Map( entities.map( e => [ e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity ] ) ),
  } as unknown as ReadonlySimulationState
}

const ada = buildConversationExchange({ entityId: 'discord:111', entityName: 'Ada', idSeed: 1, tick: 10,
  userMessage: 'The release is blocked on the payments PR.', willReply: 'Noted.' })
const bo  = buildConversationExchange({ entityId: 'discord:222', entityName: 'Bo',  idSeed: 2, tick: 12,
  userMessage: 'The demo moved to Thursday 3pm.', willReply: 'Got it.' })

const said = ( c: EpisodicConsolidator ): string[] =>
  c.getAllEpisodes().map( e => ( e.content as { userMessage: string } ).userMessage )

describe('episodic consolidation — identity, not a text prefix', () => {
  it('the two exchanges really do share the old dedup key', () => {
    // The premise, pinned: if this ever stops being true the test below stops
    // proving anything about the bug it was written for.
    const key = ( m: unknown ) => JSON.stringify( m ).slice( 0, 100 )
    expect( key( ada.metadata ) ).toBe( key( bo.metadata ) )
  } )

  it('remembers two different conversations as two episodes', async () => {
    const c = new EpisodicConsolidator({ autoIndex: false })
    await c.react( 1000, 10, stateOf( 10, [ ada ] ), ctx )
    await c.react( 1000, 12, stateOf( 12, [ ada, bo ] ), ctx )
    expect( said( c ) ).toEqual([
      'The release is blocked on the payments PR.',
      'The demo moved to Thursday 3pm.',
    ])
  } )

  it('does not remember the same item twice while it lingers in working memory', async () => {
    const c = new EpisodicConsolidator({ autoIndex: false })
    for( let t = 10; t < 15; t++ ) await c.react( 1000, t, stateOf( t, [ ada ] ), ctx )
    expect( c.getAllEpisodes() ).toHaveLength( 1 )
    expect( c.getAllEpisodes()[0]!.sourceId ).toBe( ada.id )
  } )

  it('carries the identity through a snapshot, so a restart does not remember it again', async () => {
    const first = new EpisodicConsolidator({ autoIndex: false })
    const out   = ( await first.react( 1000, 10, stateOf( 10, [ ada ] ), ctx ) ).commands as StateCommands
    const persisted = ( out.set ?? [] ).filter( e => e.type === 'episodic_memory')
    expect( persisted[0]!.metadata!['sourceId'] ).toBe( ada.id )

    // A woken mind: the episode comes back from state, and the WM item is still there.
    const woken = new EpisodicConsolidator({ autoIndex: false })
    await woken.react( 1000, 11, stateOf( 11, [ ...persisted as never[], ada ] ), ctx )
    expect( woken.getAllEpisodes() ).toHaveLength( 1 )
  } )

  it('stays one memory while what it holds drifts', async () => {
    // WorkingMemory names a goal's item for the goal (`wm-goal-<id>`) and rewrites
    // its priority every tick. Keyed on content, each drift was a new "memory":
    // 1,334 episodes of a handful of goals in a 10K-tick soak once forgetting ran
    // in days. The id names the thing; the thing is remembered once.
    const c = new EpisodicConsolidator({ autoIndex: false })
    const goal = ( tick: number, priority: number ) => ({ id: 'wm-item-wm-goal-goal-4', type: 'working_memory.item',
      metadata: { wmType: 'goal', content: { description: 'Find rest opportunity', priority }, activation: 0.9, attendedCount: 4, tags: [ 'goal' ], tick } })
    for( let t = 5; t < 12; t++ ) await c.react( 1000, t, stateOf( t, [ goal( t, 0.8 + t * 0.0004 ) ] ), ctx )
    expect( c.getAllEpisodes() ).toHaveLength( 1 )
  } )

  it('stays the same item while WorkingMemory rewrites its bookkeeping', async () => {
    // activation decays, attendedCount grows, and WorkingMemory re-stamps `tick`
    // every time it persists — none of that makes it a new memory.
    const c = new EpisodicConsolidator({ autoIndex: false })
    const at = ( tick: number, activation: number, attendedCount: number ) => ({ id: 'wm-item-wm-7', type: 'working_memory.item',
      metadata: { wmType: 'thought', content: 'hold the release', activation, attendedCount, tags: [], tick } })
    await c.react( 1000, 5, stateOf( 5, [ at( 5, 0.9, 3 ) ] ), ctx )
    await c.react( 1000, 6, stateOf( 6, [ at( 6, 0.8, 4 ) ] ), ctx )
    await c.react( 1000, 7, stateOf( 7, [ at( 7, 0.7, 5 ) ] ), ctx )
    expect( c.getAllEpisodes() ).toHaveLength( 1 )
  } )
} )

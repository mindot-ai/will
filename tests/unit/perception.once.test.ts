// ─────────────────────────────────────────────────────────────
// tests/unit/perception.once.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Perception — a change is perceived once, and what is perceived is remembered
 * whatever the tick's length.
 *
 *   - Whether a percept became an episode depended on the tick's length: working
 *     memory decays an item in the same pass that admits it, and the consolidator
 *     weighed what was left — 0.75 → 0.67 × 0.4 = 0.268 against 0.25 at one tick a
 *     second, 0.236 at two. A goal (0.65) was never remembered at all.
 *   - Exteroception perceived every WRITE as a change, so a host's heartbeat
 *     entity was a percept, and an episode, every tick.
 *   - Social perception had no memory of what it had perceived: a host's signal
 *     was an interaction every tick it stayed in state, and only one that carried
 *     a tick was ever swept (`communication` waited on a flag nothing sets).
 *
 * Every test drives the real engines through a real state manager.
 */

import { describe, it, expect } from 'vitest'
import { Exteroception } from '#faculties/exteroception'
import { SocialPerception } from '#faculties/social.perception'
import { WorkingMemory } from '#faculties/working.memory'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import type { StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )

type Engine = { react( d: number, t: number, s: unknown, c: unknown ): Promise<{ commands?: StateCommands }> }

function world( tickMs = 1000 ){
  const sm = new DefaultStateManager()
  const at = ( tick: number ) => sm.updateClock( tick as never, tick * tickMs as never )
  const put = ( set: StateCommands['set'] ) => sm.applyCommands( { set } )
  const step = async ( tick: number, ...engines: Engine[] ) => {
    at( tick )
    const out: StateCommands[] = []
    for( const e of engines ){
      const r = await e.react( tickMs, tick, sm.snapshot(), ctx )
      if( r.commands ){ sm.applyCommands( r.commands ); out.push( r.commands ) }
    }
    return out
  }
  const all = ( type: string ) => [ ...sm.snapshot().entities.values() ].filter( e => e.type === type )
  at( 1 )
  return { sm, at, put, step, all }
}

// ── remembered whatever the tick's length ────────────────────

describe('what is perceived is remembered whatever the tick\'s length', () => {
  for( const tickMs of [ 1000, 2000, 5000 ] )
    it(`a change in the world becomes an episode at ${ tickMs / 1000 } s a tick`, async () => {
      const w = world( tickMs )
      w.put( [ { id: 'pr-412', type: 'pull_request', metadata: { description: 'PR #412 payments migration was merged', salience: 0.9 } } ] )
      const ext = new Exteroception(), wm = new WorkingMemory(), ep = new EpisodicConsolidator( { autoIndex: false } )
      for( let t = 1; t <= 3; t++ ) await w.step( t, ext, wm, ep )
      expect( ep.getAllEpisodes().map( e => ( e.content as { content: { summary: string } } ).content.summary ) )
        .toEqual( [ 'PR #412 payments migration was merged' ] )
    } )

  it('a goal held in mind is remembered, once', async () => {
    const w = world()
    w.put( [ { id: 'goal-1', type: 'goal', metadata: { status: 'active', description: 'Ship the Q4 roadmap', priority: 0.8 } } ] )
    const wm = new WorkingMemory(), ep = new EpisodicConsolidator( { autoIndex: false } )
    for( let t = 1; t <= 6; t++ ) await w.step( t, wm, ep )
    const goals = ep.getAllEpisodes().filter( e => e.sourceType === 'goal')
    expect( goals ).toHaveLength( 1 )
    expect( ( goals[0]!.content as { content: { description: string } } ).content.description ).toBe('Ship the Q4 roadmap')
  } )
} )

// ── a write is not a change ──────────────────────────────────

describe('exteroception perceives a change of what something says, not a write', () => {
  const modified = ( w: ReturnType<typeof world> ) =>
    w.all('percept').filter( p => p.metadata!['changeType'] === 'modified')

  it('a heartbeat re-set every tick is perceived once, when it appears', async () => {
    const w = world()
    const beat = { id: 'host-heartbeat', type: 'heartbeat', metadata: { description: 'host is up' } }
    const ext = new Exteroception()
    w.put( [ beat ] )
    await w.step( 1, ext )
    let changes = 0
    for( let t = 2; t <= 6; t++ ){
      w.at( t ); w.put( [ beat ] )                     // re-set: a new updatedAt, the same words
      await w.step( t, ext )
      changes += modified( w ).length
    }
    expect( changes ).toBe( 0 )
  } )

  it('a re-set that says something new is perceived', async () => {
    const w = world()
    const ext = new Exteroception()
    w.put( [ { id: 'deploy', type: 'deployment', metadata: { description: 'deploy 41 running' } } ] )
    await w.step( 1, ext )
    w.at( 2 ); w.put( [ { id: 'deploy', type: 'deployment', metadata: { description: 'deploy 41 failed' } } ] )
    await w.step( 2, ext )
    expect( modified( w ).map( p => p.metadata!['summary'] ) ).toEqual( [ 'deploy 41 failed' ] )
  } )
} )

// ── a signal is an act, perceived once ───────────────────────

describe('social perception takes each signal once', () => {
  const signal = ( id: string, action: string, extra: Record<string, unknown> = {} ) =>
    ( { id, type: 'message', metadata: { sourceKeid: 'ke:ada', recipientId: 'agent-self', action, ...extra } } )
  const perceivedAt = ( out: StateCommands[] ) =>
    out.flatMap( c => c.metrics ?? [] ).find( ( [ k ] ) => k === 'social.percepts_this_tick')?.[1]

  it('a host\'s signal that stays in state is one interaction, not one a tick', async () => {
    const w = world()
    const social = new SocialPerception()
    w.put( [ signal('msg-1', 'greet') ] )
    const counts: number[] = []
    for( let t = 1; t <= 5; t++ ) counts.push( perceivedAt( await w.step( t, social ) )! )
    expect( counts ).toEqual( [ 1, 0, 0, 0, 0 ] )
  } )

  it('re-set, it is a new act', async () => {
    const w = world()
    const social = new SocialPerception()
    w.put( [ signal('msg-1', 'greet') ] )
    await w.step( 1, social )
    w.at( 2 ); w.put( [ signal('msg-1', 'praise') ] )
    expect( perceivedAt( await w.step( 2, social ) ) ).toBe( 1 )
  } )

  it('a communication signal is swept once perceived, like every other', async () => {
    const w = world()
    w.put( [ { id: 'comm-1', type: 'communication', metadata: { sourceKeid: 'ke:ada', recipientId: 'agent-self', tick: 1 } } ] )
    const social = new SocialPerception()
    for( let t = 1; t <= 3; t++ ) await w.step( t, social )
    expect( w.sm.snapshot().entities.has('comm-1') ).toBe( false )
  } )
} )

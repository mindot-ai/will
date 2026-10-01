// ─────────────────────────────────────────────────────────────
// tests/integration/executive.remembers-what-it-did.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * She remembers what she did — not only the last six things.
 *
 * `ACTION_RECORD_KEEP` holds six acts: a working record, rendered as `## What
 * Became Of What I Did`, and that is right. But nothing else held them. An act
 * that brings something back is remembered through its answer (a percept, then
 * an episode); an act known only by its FATE — "unban ran.", a failure, a reach-out
 * she held back — fed calibration, goals and the self-model as signals and was
 * kept by none of them. Past the sixth, she had no memory she had done it
 * (LOSSLESS P5c, found asking whether `ACTION_RECORD_KEEP` was MIND).
 *
 * Now each act is offered to memory as a spoken turn is, as strongly as it
 * matters, and the consolidator decides. These run the real engines: the
 * executive records and offers, the consolidator remembers, working memory sweeps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ExecutiveEngine } from '#faculties/executive.engine/engine'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { WorkingMemory } from '#faculties/working.memory'
import { buildExecutiveContext, resolveRecall } from '#faculties/executive.engine/context'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { createTestBus } from '#cognition/bus'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import { ACTION_RECORD_KEEP } from '#faculties/executive.engine/action.record'
import type { StateCommands } from '#core/types'
import { setLogger, resetLogger } from '#core/logger'

beforeEach( () => setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never ) )
afterEach( () => resetLogger() )

const ctx = createContext('sim', 'run', 42 )

function mind(){
  const bus = createTestBus()
  const sm  = new DefaultStateManager()
  const executive = new ExecutiveEngine()
  const memory    = new EpisodicConsolidator()
  const wm        = new WorkingMemory()
  executive.attachBus( bus )
  bus.subscribe( executive.name, executive.subscribes(), ev => {
    const c = executive.onCognitiveEvent( ev ) as StateCommands | void
    if( c ) sm.applyCommands( c )
  } )
  sm.setEntity( { id: 'identity-self', type: 'will.identity', metadata: { name: 'Lora', values: [], traits: {}, style: 'plain', version: 1 } } )
  sm.setEntity( { id: 'ke-fkem', type: 'known-entity', metadata: { keid: 'ke:fkem', name: 'FKEM', kind: 'sentient' } } )
  sm.setEntity( { id: 'ke-ada',  type: 'known-entity', metadata: { keid: 'ke:ada',  name: 'Ada',  kind: 'sentient' } } )

  let t = 0
  const act = ( actionType: string, over: Record<string, unknown> = {} ) => {
    bus.publish( { type: over['withheld'] ? 'action.withheld' : 'action.outcome', version: 1, sourceEngine: 'motor', salience: 0.5,
      payload: { actionType, success: over['success'] ?? true, tick: t + 1, ...over } } )
    bus.flush()
  }
  /** One tick of the three engines, against one frozen state — as the orchestrator runs them. */
  const tick = async () => {
    t++
    sm.updateClock( t as never, t * 1000 as never )
    const results = await Promise.all( [ executive, memory, wm ].map( e => e.react( 1000 as never, t as never, sm.snapshot(), ctx ) ) )
    for( const r of results ) if( r.commands ) sm.applyCommands( r.commands )
    bus.flush()
  }
  const remembered = () => memory.getAllEpisodes().map( ep => ( ep.content as { summary?: string } ).summary )
  return { act, tick, remembered, memory, sm }
}

describe('what she did becomes something she remembers', () => {
  it('an act toward someone, a failure, and one she held back — each a memory, in her words', async () => {
    const m = mind()
    m.act('unban', { description: 'unban ran.', targetEntityId: 'ke:fkem' })
    m.act('list_issues', { success: false, description: 'list_issues failed: 401 Bad credentials' })
    m.act('reach-out', { withheld: true, targetEntityId: 'ke:ada' })
    await m.tick()   // the executive offers each act
    await m.tick()   // the consolidator remembers; working memory sweeps
    expect( m.remembered() ).toEqual( expect.arrayContaining( [
      'I did unban toward FKEM — unban ran.',
      'I tried list_issues, and it failed — list_issues failed: 401 Bad credentials',
      'I held back from reach-out toward Ada',
    ] ) )
    const failed = m.memory.getAllEpisodes().find( ep => ( ep.content as { actionType?: string } ).actionType === 'list_issues')!
    expect( failed.outcomeStatus ).toBe('failed')
  } )

  it('a stance — no one, no host — goes in faintly, words and all, and the consolidator lets it go', async () => {
    // Every stance carries a sentence, as the motor executor publishes it. Encoded
    // as speech is, a quiet mind remembered one every two ticks (the soak).
    const m = mind()
    m.act('rest',     { description: 'I let myself recover; the pace eases.' })
    m.act('withdraw', { description: 'I pull back from the press of things.' })
    m.act('orient',   { description: 'My awareness sweeps the scene.' })
    // A skill she learned out of stances is a stance too — known by its mirror.
    m.sm.setEntity( { id: 'agency-schema-settle', type: 'agency.schema',
      metadata: { id: 'settle', kind: 'composite', source: 'repertoire', binds: 'none', composedOf: [ 'rest', 'wait' ] } } )
    m.act('settle',   { description: 'I settle.' })
    await m.tick(); await m.tick()
    expect( m.remembered() ).toEqual( [] )
  } )

  it('a host ability with no one to it is remembered — it acted on the world', async () => {
    const m = mind()
    m.sm.setEntity( { id: 'agency-schema-add_label', type: 'agency.schema',
      metadata: { id: 'add_label', kind: 'primitive', source: 'external', binds: 'none' } } )
    m.act('add_label', { description: 'add_label ran.' })
    await m.tick(); await m.tick()
    expect( m.remembered() ).toEqual( [ 'I did add_label — add_label ran.' ] )
  } )

  it('each act once — not again every tick, and the offer is swept like any other one-tick item', async () => {
    const m = mind()
    m.act('unban', { description: 'unban ran.', targetEntityId: 'ke:fkem' })
    for( let i = 0; i < 5; i++ ) await m.tick()
    expect( m.remembered().filter( s => s?.startsWith('I did unban') ) ).toHaveLength( 1 )
    expect( [ ...m.sm.snapshot().entities.values() ].filter( e => e.id.startsWith('wm-act-') ) ).toHaveLength( 0 )
  } )

  it('past the six the record keeps, the act is still hers — a memories search finds it', async () => {
    const m = mind()
    m.act('unban', { description: 'unban ran.', targetEntityId: 'ke:fkem' })
    await m.tick()
    for( let i = 0; i < ACTION_RECORD_KEEP + 2; i++ ){ m.act('add_label', { description: `label ${ i } added.` }); await m.tick() }
    await m.tick()
    const state = m.sm.snapshot()
    expect( [ ...state.entities.values() ].some( e => e.type === 'action.record' && e.metadata?.['type'] === 'unban') ).toBe( false )

    const deps = { workingMemory: null, goalManager: null, episodicConsolidator: m.memory, semanticIntegrator: null }
    const context = await buildExecutiveContext( state, deps )
    const prompt = buildUserMessage( { context, state, qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master',
      broughtBack: await resolveRecall( [ { section: 'memories', page: 1, query: 'unban FKEM' } ], state, deps, context ) } as never )
    expect( prompt ).toMatch( /- Memories about "unban FKEM" — \d+ found:\n- I did unban toward FKEM — unban ran\./ )
  } )
} )

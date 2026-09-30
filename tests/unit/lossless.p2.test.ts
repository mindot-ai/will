// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p2.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P2 — what she takes in is whole, and what she takes in is kept.
 *
 * At the door: exteroception dropped every change past the fiftieth in a tick
 * and social perception every signal past the twentieth — and each records what
 * it scanned as seen (a received turn is swept the same tick), so what a cap
 * dropped was never perceived at all.
 *
 * Behind it, three things decided what survived, and none by what mattered:
 *   - working memory admitted each newcomer by evicting the FIRST least-active
 *     item, so of twenty percepts arriving together it kept the seven LEAST
 *     salient;
 *   - the consolidator skipped every item tagged `percept` as a "meta-percept",
 *     so nothing perceived — an act's own answer included — became an episode;
 *   - and it took five candidates a tick, so a woken mind handed its last
 *     conversation with twelve people remembered five.
 *
 * And what the mind made of its memories read their JSON: `wmtype`, `content`,
 * `activation` were the words its clustering matched on and named clusters by.
 *
 * Every test drives the real engines through a real state manager.
 */

import { describe, it, expect, vi } from 'vitest'
import { Exteroception } from '#faculties/exteroception'
import { SocialPerception } from '#faculties/social.perception'
import { WorkingMemory } from '#faculties/working.memory'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { SemanticClustering } from '#faculties/semantic.engine/clustering'
import { SomatosensationEngine } from '#senses/somatosensation.engine'
import { episodeContentToText } from '#memory/vector.content'
import { InProcessCognitiveTransport, type CognitiveEvent } from '#cognition/bus'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import { setLogger, resetLogger } from '#core/logger'
import type { StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )

type Engine = { react( d: number, t: number, s: unknown, c: unknown ): Promise<{ commands?: StateCommands }> }

function world(){
  const sm = new DefaultStateManager()
  const at = ( tick: number ) => sm.updateClock( tick as never, tick * 1000 as never )
  const put = ( set: StateCommands['set'] ) => sm.applyCommands( { set } )
  const step = async ( tick: number, ...engines: Engine[] ) => {
    at( tick )
    for( const e of engines ){
      const r = await e.react( 1000, tick, sm.snapshot(), ctx )
      if( r.commands ) sm.applyCommands( r.commands )
    }
  }
  const all = ( type: string ) => [ ...sm.snapshot().entities.values() ].filter( e => e.type === type )
  at( 1 )
  return { sm, at, put, step, all }
}

// ── at the door ──────────────────────────────────────────────

describe('nothing is dropped at the door', () => {
  it('perceives every change in the world, not the first fifty', async () => {
    const w = world()
    w.put( Array.from( { length: 80 }, ( _, i ) => ( { id: `report-${ i }`, type: 'report', metadata: { description: `report ${ i }` } } ) ) )
    await w.step( 1, new Exteroception() )
    expect( w.all('percept') ).toHaveLength( 80 )
    expect( w.sm.snapshot().metrics.get('perception.percepts_this_tick') ).toBe( 80 )
  } )

  it('carries what the world says about a thing whole', async () => {
    const w = world()
    const said = 'The payments migration is blocked on the schema review; '.repeat( 6 ) + 'owner: FKEM.'
    w.put( [ { id: 'pr-412', type: 'pull_request', metadata: { description: said } } ] )
    await w.step( 1, new Exteroception() )
    expect( w.all('percept')[0]!.metadata!['summary'] ).toBe( said )
  } )

  it('hears every turn that arrives in a tick, not the first twenty', async () => {
    // A received turn is swept on the tick it is scanned — the twenty-first
    // was swept without ever having been perceived.
    const w = world()
    w.put( Array.from( { length: 25 }, ( _, i ) => ( { id: `rx-${ i }`, type: 'conversation.received',
      metadata: { sourceKeid: `ke:${ i }`, action: 'communication', directedAtSelf: true } } ) ) )
    await w.step( 1, new SocialPerception() )
    expect( w.all('percept.social') ).toHaveLength( 25 )
    expect( w.all('conversation.received') ).toHaveLength( 0 )
  } )
} )

// ── working memory keeps what matters ────────────────────────

describe('working memory keeps the most salient of what arrives together', () => {
  // Salience stated by the world (0.01 … 0.39), lifted 0.2 for recency: never clamped.
  const burst = ( w: ReturnType<typeof world> ) =>
    w.put( Array.from( { length: 20 }, ( _, i ) => ( { id: `r-${ i }`, type: 'report',
      metadata: { description: `salience ${ ( 0.01 + i * 0.02 ).toFixed( 2 ) }`, salience: 0.01 + i * 0.02 } } ) ) )
  const held = ( wm: WorkingMemory ) =>
    wm.getItems().map( i => ( i.content as { summary: string } ).summary ).sort()

  it('keeps the seven most salient of twenty — it kept the seven least', async () => {
    const w = world(); burst( w )
    const wm = new WorkingMemory()
    await w.step( 1, new Exteroception(), wm )
    expect( held( wm ) ).toEqual( [ 0.27, 0.29, 0.31, 0.33, 0.35, 0.37, 0.39 ].map( s => `salience ${ s.toFixed( 2 ) }` ) )
  } )

  it('does not let what lost come back while the winners fade', async () => {
    // The losers stay in state two more ticks; they were re-admitted each tick
    // against items that had decayed since, and displaced them.
    const w = world(); burst( w )
    const ext = new Exteroception(), wm = new WorkingMemory()
    await w.step( 1, ext, wm )
    const first = held( wm )
    // Every tick: re-admitted, they took all seven slots on the second and gave
    // them back on the third — an oscillation a two-point check misses.
    for( const t of [ 2, 3 ] ){
      await w.step( t, ext, wm )
      expect( held( wm ) ).toEqual( first )
    }
  } )
} )

// ── what she perceives is remembered ─────────────────────────

describe('what she perceives becomes memory', () => {
  it('remembers the answer an act of her own brought back, with its data', async () => {
    const w = world()
    const sense = new SomatosensationEngine()
    sense.attachBus( { publish: () => {}, subscribe: () => {} } as never )
    sense.attachPerceptTrace( e => w.sm.setEntity( e ), () => 1 )
    const data = { pulls: Array.from( { length: 30 }, ( _, i ) => ( { number: 400 + i, title: `PR ${ 400 + i }`, state: 'open' } ) ) }
    await sense.sense( { kind: 'system', signal: 'list_pull_requests', provenance: 'reafferent', sourceIntentId: 'intent-7', data } )

    const wm = new WorkingMemory(), ep = new EpisodicConsolidator( { autoIndex: false } )
    await w.step( 1, wm )
    await w.step( 2, ep )
    const episodes = ep.getAllEpisodes()
    expect( episodes ).toHaveLength( 1 )
    expect( episodes[0]!.sourceType ).toBe('percept')
    expect( ( episodes[0]!.content as { content: { data: unknown } } ).content.data ).toEqual( data )
  } )

  it('remembers something that changed in the world', async () => {
    const w = world()
    w.put( [ { id: 'pr-412', type: 'pull_request', metadata: { description: 'PR #412 payments migration was merged', salience: 0.9 } } ] )
    const ext = new Exteroception(), wm = new WorkingMemory(), ep = new EpisodicConsolidator( { autoIndex: false } )
    for( let t = 1; t <= 3; t++ ) await w.step( t, ext, wm, ep )
    expect( ep.getAllEpisodes().map( e => ( e.content as { content: { summary: string } } ).content.summary ) )
      .toEqual( [ 'PR #412 payments migration was merged' ] )
  } )

  const restored = ( n: number ) => Array.from( { length: n }, ( _, i ) => ( {
    id: `wm-exchange-restored-ke${ i }`, type: 'working_memory.item',
    metadata: { wmType: 'conversation.exchange', activation: 0.7, attendedCount: 2,
      tags: [ 'conversation', 'exchange', 'pma-restored' ], summary: `my last talk with person ${ i }`, entityId: `ke${ i }`, tick: 0 },
  } ) )

  it('remembers every conversation a woken mind is handed, not five of them', async () => {
    // pma/index.ts §8 re-seeds the last conversation with each person as a working-
    // memory item that lives one tick. Five a tick were taken; the rest were reaped.
    const w = world()
    w.put( restored( 12 ) )
    const ep = new EpisodicConsolidator( { autoIndex: false } ), wm = new WorkingMemory()
    for( let t = 1; t <= 3; t++ ) await w.step( t, ep, wm )
    expect( ep.getAllEpisodes() ).toHaveLength( 12 )
  } )

  it('ignores a per-tick limit a woken mind carries in its saved config', async () => {
    const w = world()
    w.put( [ { id: 'engine-config-episodic', type: 'engine.config',
      metadata: { engine: 'episodic', params: { consolidationThreshold: 0.25, emotionBoost: 2.0, maxPerTick: 5 } } }, ...restored( 12 ) ] )
    const ep = new EpisodicConsolidator( { autoIndex: false } ), wm = new WorkingMemory()
    for( let t = 1; t <= 3; t++ ) await w.step( t, ep, wm )
    expect( ep.getAllEpisodes() ).toHaveLength( 12 )
  } )
} )

// ── what she makes of her memories reads what they were about ─

const wmEpisode = ( i: number, summary: string ): EpisodicMemory => ( {
  id: `episodic-${ i }-0`, timestamp: i, sourceType: 'percept', sourceId: `wm-item-wm-percept-p${ i }`,
  content: { wmType: 'percept', content: { summary, entityId: `p${ i }` }, activation: 0.75, attendedCount: 0, tags: [ 'percept' ], tick: i },
  emotionalTags: {}, affectiveContext: { valence: 0, arousal: 0.3, dominance: 0.5 }, activationStrength: 0.3,
  retrievalCount: 0, lastRetrievedAt: null, tags: [ 'percept' ], createdAt: i * 1000, outcomeStatus: 'attempted',
} as unknown as EpisodicMemory )

const clustering = () => {
  const c = new SemanticClustering()
  c.attachConsolidator( new EpisodicConsolidator( { autoIndex: false } ) )
  return c
}

describe('what she makes of her memories is about them', () => {
  it('does not group unrelated memories on the words of their envelope', async () => {
    const unrelated = [ 'the payments migration was merged', 'FKEM asked for the quarterly numbers',
      'the staging cluster ran out of disk', 'a new hire starts on Monday', 'the demo moved to Thursday',
      'Ripplix shipped its onboarding flow' ].map( ( s, i ) => wmEpisode( i, s ) )
    const beliefs = await clustering().discoverClusters( 10, unrelated )
    expect( beliefs ).toEqual( [] )
  } )

  const statement = ( episodes: EpisodicMemory[] ) =>
    ( clustering() as unknown as { _generatePrototypeStatement( e: EpisodicMemory[], d: [], t: [], v: number ): string } )
      ._generatePrototypeStatement( episodes, [], [], 0 )

  it('reads a goal held in mind as what it was, the text its vector is built from', async () => {
    // An episode's content IS the working-memory item's metadata (the consolidator
    // copies it), so this is the exact shape the index embeds and clustering reads.
    const w = world()
    w.put( [ { id: 'goal-4', type: 'goal', metadata: { status: 'active', description: 'Unblock the payments migration', priority: 0.8 } } ] )
    await w.step( 1, new WorkingMemory() )
    const item = w.all('working_memory.item').find( e => e.metadata?.['wmType'] === 'goal')!
    expect( episodeContentToText( item.metadata ) ).toBe('Unblock the payments migration')
  } )

  it('names a cluster from every one of its memories, not the first twenty', () => {
    const episodes = [
      ...Array.from( { length: 20 }, ( _, i ) => wmEpisode( i, `unique${ i }a unique${ i }b` ) ),
      ...Array.from( { length: 5 },  ( _, i ) => wmEpisode( 20 + i, 'payments migration blocked' ) ),
    ]
    expect( statement( episodes ) ).toMatch( /payments|migration|blocked/ )
  } )

  it('names it from all of each memory, not its first ten words', () => {
    const filler = ( i: number ) => Array.from( { length: 10 }, ( _, j ) => `word${ i }x${ j }` ).join(' ')
    const episodes = Array.from( { length: 6 }, ( _, i ) => wmEpisode( i, `${ filler( i ) } payments migration` ) )
    const s = statement( episodes )
    expect( s ).toContain('payments')
    expect( s ).not.toMatch( /wmtype|activation|attendedcount/ )
  } )
} )

// ── the bus ──────────────────────────────────────────────────

const ev = ( type: string, n = 0 ) => ( { id: `e-${ n }`, type, version: 1, sourceEngine: 't', sequenceNumber: n,
  logicalTime: n, wallTime: 0, salience: 0.5, payload: {} } as CognitiveEvent )

describe('the bus never drops what the senses took in', () => {
  it('delivers a sense percept however full the metric queue is', () => {
    const t = new InProcessCognitiveTransport()
    const got: string[] = []
    t.subscribe( 'tracker', [ 'senses.*', 'stress.*' ], e => { got.push( e.type ) } )
    t.deliver( ev('senses.audition.percept'), [ 'tracker' ] )
    for( let i = 0; i < 600; i++ ) t.deliver( ev('stress.state.changed', i ), [ 'tracker' ] )
    t.flush()
    expect( got ).toContain('senses.audition.percept')
  } )

  it('reports every drop, by type, on the flush it happened', () => {
    const warned: string[] = []
    setLogger( { debug(){}, info(){}, error(){}, warn: ( m: string ) => { warned.push( m ) } } )
    try {
      const t = new InProcessCognitiveTransport()
      for( let i = 0; i < 503; i++ ) t.deliver( ev( i % 2 ? 'stress.state.changed' : 'affect.state.changed', i ), [] )
      t.flush()
      expect( warned ).toHaveLength( 1 )
      expect( warned[0] ).toContain('dropped 3 events this flush')
      expect( warned[0] ).toContain('affect.state.changed ×2')
      expect( warned[0] ).toContain('stress.state.changed ×1')
      t.flush()
      expect( warned ).toHaveLength( 1 )
    } finally { resetLogger() }
  } )
} )

vi.spyOn( console, 'info').mockImplementation( () => {} )

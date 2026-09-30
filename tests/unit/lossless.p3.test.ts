// ─────────────────────────────────────────────────────────────
// tests/unit/lossless.p3.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * LOSSLESS P3 — what she keeps is what she has, and what she let go of stays gone.
 *
 * The stores capped by count — beliefs at 500, people at 50, reputations at 20,
 * theory-of-mind models at 10 — and every one of those caps dropped from memory
 * and NOT from state. So the cut was a lie twice: forgotten in-session, restored
 * on the next boot. Beliefs had the inverse too: the one prune that is the mind's
 * own (decay to 0.12) left the entity behind, so the PMA and every engine reading
 * `belief` entities kept reading what the mind had let go, and a restart restored
 * it. And the semantic index evicted at 10,000 while vectors for memories already
 * forgotten — banked by a race — took recall's slots from the living.
 */

import { describe, it, expect } from 'vitest'
import { SemanticIntegrator, type Belief } from '#faculties/semantic.engine/integrator'
import { KnownEntityTracker } from '#faculties/known.entity.tracker'
import { ReputationTracker } from '#faculties/reputation.tracker'
import { TheoryOfMind } from '#faculties/theory.of.mind'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { DefaultVectorMemoryAdapter } from '#memory/vector.adapter'
import { MockEmbedder, type EmbeddingProvider } from '#memory/vector.embedder'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import type { StorageAdapter } from '#core/abstracts'
import type { StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )

const belief = ( i: number, confidence: number, over: Partial<Belief> = {} ): Belief => ( {
  id: `b-${ i }`, statement: `fact number ${ i }`, category: 'world_fact', confidence,
  supportingEpisodes: 20, lastUpdatedAt: 0, tags: [ `topic-${ i }` ], history: [], ...over,
} )

/** A state manager holding ten one-tick conversation items, and a consolidator that remembers them. */
async function withEpisodes(){
  const sm = new DefaultStateManager()
  sm.updateClock( 1 as never, 1000 as never )
  sm.applyCommands( { set: Array.from( { length: 10 }, ( _, i ) => ( { id: `wm-exchange-x${ i }`, type: 'working_memory.item',
    metadata: { wmType: 'conversation.exchange', activation: 0.85, attendedCount: 3, tags: [ 'conversation' ], summary: `talk ${ i }`, tick: 1 } } ) ) } )
  const ep = new EpisodicConsolidator( { autoIndex: false } )
  await ep.react( 1000 as never, 1 as never, sm.snapshot(), ctx )
  return { sm, ep }
}

// ── beliefs ──────────────────────────────────────────────────

describe('beliefs', () => {
  it('keeps every belief past 500, the weak ones included', () => {
    const integ = new SemanticIntegrator()
    integ.restoreBeliefs( Array.from( { length: 600 }, ( _, i ) => belief( i, i % 2 ? 0.8 : 0.2 ) ) )
    integ.integrateExecutiveBelief( belief( 600, 0.2 ), 1 )
    // Past 500 this deleted EVERY belief under 0.3 — 301 of them, the new one too.
    expect( integ.getBeliefs() ).toHaveLength( 601 )
    expect( integ.getBeliefs().some( b => b.id === 'b-600' ) ).toBe( true )
  } )

  it('lets go of a belief that decayed away — from state too, so a restart cannot restore it', async () => {
    const { sm, ep } = await withEpisodes()
    // A fast fade (0.001/s), so a pass or two reaches the prune: this is about
    // what the prune does, not how long a belief lasts (beliefs.fade.test.ts).
    const integ = new SemanticIntegrator( { beliefDecayPerSecond: 0.001 } )
    integ.attachConsolidator( ep )
    integ.restoreBeliefs( [ belief( 1, 0.1205 ), belief( 2, 0.9 ) ] )

    sm.updateClock( 400 as never, 400_000 as never )
    const out = ( await integ.react( 1000 as never, 400 as never, sm.snapshot(), ctx ) ).commands as StateCommands
    expect( out.delete ).toContain('b-1')
    sm.applyCommands( out )

    const woken = new SemanticIntegrator()
    await woken.react( 1000 as never, 401 as never, sm.snapshot(), ctx )
    const ids = woken.getBeliefs().map( b => b.id )
    expect( ids ).toContain('b-2')
    expect( ids ).not.toContain('b-1')
  } )

  it('keeps a belief\'s whole history — a run of decay as one entry, and past twenty', async () => {
    const { sm, ep } = await withEpisodes()
    const integ = new SemanticIntegrator( { beliefDecayPerSecond: 0.001 } )
    integ.attachConsolidator( ep )
    integ.restoreBeliefs( [ belief( 1, 0.9, { history: [ { tick: 0, confidence: 0.9, delta: 0.9, cause: 'created' } ] } ) ] )
    for( let t = 400; t < 460; t++ ){
      sm.updateClock( t as never, t * 1000 as never )
      await integ.react( 1000 as never, t as never, sm.snapshot(), ctx )
    }
    const decayed = integ.getBeliefs()[0]!.history!.filter( h => h.cause === 'decayed')
    expect( decayed ).toHaveLength( 1 )
    expect( decayed[0] ).toMatchObject( { since: 400, tick: 459, steps: 60 } )
    expect( decayed[0]!.delta ).toBeCloseTo( -0.06, 6 )

    // Twenty-five reinforcements, each its own event: all kept (it kept the last 20).
    for( let t = 0; t < 25; t++ ) integ.integrateExecutiveBelief( belief( 1, 0.9, { lastUpdatedAt: 500 + t } ), 500 + t )
    expect( integ.getBeliefs()[0]!.history!.length ).toBe( 2 + 25 )
  } )
} )

// ── people ───────────────────────────────────────────────────

const heard = ( keid: string, name: string ) => ( {
  type: 'senses.audition.percept', salience: 0.6,
  payload: { domain: 'audition', sourceEntityId: keid, timestamp: 0, salience: 0.6, raw: { speakerName: name } },
} as never )

const interaction = ( keid: string ) => ( {
  type: 'interaction.occurred', salience: 0.6,
  payload: { keid, valence: 0.4, intensity: 0.6, directedAtSelf: true, interactionType: 'communication' },
} as never )

const empty = ( tick: number ) => ( { tick, time: tick * 1000, entities: new Map(), metrics: new Map() } as never )

describe('the people she knows', () => {
  it('knows sixty named people, not fifty — in memory and in state', async () => {
    const t = new KnownEntityTracker()
    for( let i = 0; i < 60; i++ ) t.onCognitiveEvent( heard( `p${ i }`, `Person ${ i }` ) )
    const out = ( await t.react( 1000 as never, 100 as never, empty( 100 ), ctx ) ).commands as StateCommands
    for( let i = 0; i < 60; i++ ) expect( t.getDossier( `p${ i }` ), `p${ i }` ).toBeDefined()
    expect( ( out.set ?? [] ).filter( e => e.type === 'known-entity') ).toHaveLength( 60 )
  } )

  it('keeps a reputation for everyone it has dealt with, not the busiest twenty', async () => {
    const r = new ReputationTracker()
    for( let i = 0; i < 30; i++ ) r.onCognitiveEvent( interaction( `p${ i }` ) )
    await r.react( 1000 as never, 10 as never, empty( 10 ), ctx )
    for( let i = 0; i < 30; i++ ) expect( r.getReputation( `p${ i }` ), `p${ i }` ).toBeDefined()
  } )

  it('keeps a model of every mind it has met, not the ten it is surest of', async () => {
    const tom = new TheoryOfMind()
    for( let i = 0; i < 15; i++ ) tom.onCognitiveEvent( interaction( `p${ i }` ) )
    await tom.react( 1000 as never, 10 as never, empty( 10 ), ctx )
    for( let i = 0; i < 15; i++ ) expect( tom.getModel( `p${ i }` ), `p${ i }` ).toBeDefined()
  } )
} )

// ── recall by meaning ────────────────────────────────────────

class MemStorage implements StorageAdapter {
  private _f = new Map<string, string | Uint8Array>()
  async write( p: string, c: string | Uint8Array ){ this._f.set( p, c ) }
  async read( p: string ){ const v = this._f.get( p ); if( v == null ) throw new Error( p ); return typeof v === 'string' ? v : new TextDecoder().decode( v ) }
  async readBytes( p: string ){ const v = this._f.get( p ); if( v == null ) throw new Error( p ); return typeof v === 'string' ? new TextEncoder().encode( v ) : v }
  async exists( p: string ){ return this._f.has( p ) }
}

const episode = ( id: string ): EpisodicMemory => ( {
  id, timestamp: 1, content: `memory ${ id }`, emotionalTags: {}, affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
  activationStrength: 1, retrievalCount: 0, lastRetrievedAt: null, tags: [], sourceType: 'test', createdAt: 1,
} as unknown as EpisodicMemory )

/** An embedder that answers only when told to — the network round-trip, held open. */
class HeldEmbedder implements EmbeddingProvider {
  readonly modelName = 'mock'; readonly dimensions = 128
  private _inner = new MockEmbedder( 42 )
  release: () => void = () => {}
  private _gate = new Promise<void>( r => { this.release = r } )
  async embed( c: unknown, k?: never ){ await this._gate; return this._inner.embed( c, k ) }
  async embedBatch( c: unknown[], k?: never ){ await this._gate; return this._inner.embedBatch( c, k ) }
  areEquivalent(){ return true }
}

describe('recall by meaning', () => {
  it('never indexes a memory forgotten while its vector was on the way', async () => {
    const embedder = new HeldEmbedder()
    const a = new DefaultVectorMemoryAdapter( embedder as never, { dimensions: 128 }, new MemStorage() )
    const one   = a.index( episode('e1'), 'one' )
    const batch = a.indexBatch( [ { episode: episode('e2'), content: 'two' }, { episode: episode('e3'), content: 'three' } ] )
    await a.delete('e1'); await a.delete('e2')        // forgotten before the embedder answered
    embedder.release()
    await one; await batch
    expect( a.size ).toBe( 1 )                        // e3 only
  } )

  it('does not evict what it remembers by default', async () => {
    // Two dimensions: the claim is about how many it keeps, not what they mean.
    const flat = { modelName: 'flat', dimensions: 2, areEquivalent: () => true,
      embed: async () => [ 1, 0 ], embedBatch: async ( c: unknown[] ) => c.map( ( _, i ) => [ Math.cos( i ), Math.sin( i ) ] ) }
    const a = new DefaultVectorMemoryAdapter( flat as never, { dimensions: 2, seed: 1 }, new MemStorage() )
    const batch = ( from: number, n: number ) => Array.from( { length: n }, ( _, i ) => ( { episode: episode( `e${ from + i }` ), content: `m${ from + i }` } ) )
    // Two batches: the second arrives at a full index, which is where eviction ran.
    await a.indexBatch( batch( 0, 10_000 ) )
    await a.indexBatch( batch( 10_000, 50 ) )
    expect( a.size ).toBe( 10_050 )
  }, 60_000 )

  it('lets go of a vector whose memory is gone, the first time recall meets it', async () => {
    const embedder = new MockEmbedder( 42 )
    const a  = new DefaultVectorMemoryAdapter( embedder as never, { dimensions: 128, minSimilarity: -1 }, new MemStorage() )
    const ep = new EpisodicConsolidator( { autoIndex: false, vectorMemory: a, embedder: embedder as never } )
    await a.index( episode('ghost'), 'a memory already forgotten' )
    expect( await ep.semanticQuery('anything', { limit: 5 } ) ).toEqual( [] )
    await new Promise( r => setTimeout( r, 0 ) )
    expect( a.size ).toBe( 0 )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/beliefs.fade.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A belief nobody reaffirms fades over days of running time — and nothing makes a
 * belief certain just for existing, and nothing overwrites one on disk.
 *
 * Three things were wrong at once, each hiding another:
 *   - decay was 0.001 per TICK: at ~1 tick/s a fact nobody repeated was gone in
 *     about 16 minutes (measured on the real engines: four beliefs, all gone inside
 *     an hour);
 *   - spaced repetition's automatic review "assumed successful recall" — +0.05 and
 *     a fresh last-update for every belief on its schedule. Decay in minutes lost
 *     that race; decay in days would lose to it: every belief at 1.00 within 12
 *     hours, forever;
 *   - and its review record was persisted under the BELIEF's id, so the later of
 *     the two writes won each tick: the belief entity became a review record, and
 *     a woken mind restored none of its beliefs.
 */

import { describe, it, expect } from 'vitest'
import { SemanticIntegrator, type Belief } from '#faculties/semantic.engine/integrator'
import { DEFAULT_BELIEF_DECAY_PER_SECOND } from '#faculties/semantic.engine/types'
import { SpacedRepetition, reviewRecordId } from '#faculties/spaced.repetition'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import type { StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )
const DAY = 86_400

const belief = ( id: string, confidence: number ): Belief => ( {
  id, statement: `${ id }: the demo is on Thursday`, category: 'world_fact', confidence,
  supportingEpisodes: 3, lastUpdatedAt: 0, tags: [ id ], history: [],
} )

/**
 * A mind with a steady trickle of experience (so integration passes run and a
 * stale belief has "had its opportunity"), stepped double-buffered: every engine
 * reads the same pre-tick snapshot, then all commands commit — as the
 * orchestrator does.
 */
async function mind( opts: { integrator?: SemanticIntegrator; withReview?: boolean } = {} ){
  const sm = new DefaultStateManager()
  const ep = new EpisodicConsolidator( { autoIndex: false } )
  const integ = opts.integrator ?? new SemanticIntegrator()
  integ.attachConsolidator( ep )
  const sr = new SpacedRepetition()
  sr.attachSemanticIntegrator( integ as never )
  const engines = [ ep, integ, ...( opts.withReview ? [ sr ] : [] ) ] as Array<{ react( d: number, t: number, s: unknown, c: unknown ): Promise<{ commands?: StateCommands }> }>
  let tick = 0
  const run = async ( ticks: number, deltaMs = 1000 ) => {
    for( let i = 0; i < ticks; i++ ){
      tick++
      sm.updateClock( tick as never, tick * 1000 as never )
      if( tick % 30 === 0 ) sm.applyCommands( { set: [ { id: `wm-exchange-${ tick }`, type: 'working_memory.item',
        metadata: { wmType: 'conversation.exchange', activation: 0.85, attendedCount: 3, tags: [ 'conversation' ], summary: `talk ${ tick }`, tick } } ] } )
      const snap = sm.snapshot()
      for( const r of await Promise.all( engines.map( e => e.react( deltaMs, tick, snap, ctx ) ) ) )
        if( r.commands ) sm.applyCommands( r.commands )
    }
  }
  const confidence = ( id: string ) => integ.getBeliefs().find( b => b.id === id )?.confidence
  return { sm, integ, sr, run, confidence }
}

describe('a belief fades over days, not minutes', () => {
  it('is calibrated so a weak belief (0.3) reaches the prune in three days of running time', () => {
    expect( DEFAULT_BELIEF_DECAY_PER_SECOND * 3 * DAY ).toBeCloseTo( 0.18, 6 )
  } )

  it('is still there, barely changed, after an hour nobody mentioned it', async () => {
    const m = await mind()
    m.integ.restoreBeliefs( [ belief('b-1', 0.5 ) ] )
    await m.run( 3600 )
    // At 0.001 a tick it was gone in ~6 minutes of this hour.
    expect( m.confidence('b-1') ).toBeGreaterThan( 0.49 )
  } )

  it('is gone after days, the weak before the firm', async () => {
    const m = await mind()
    m.integ.restoreBeliefs( [ belief('weak', 0.3 ), belief('firm', 0.9 ) ] )
    await m.run( 600 )                              // stale, and an integration pass has run
    await m.run( 7, 12 * 3600 * 1000 )              // then three and a half days in half-day steps
    expect( m.confidence('weak') ).toBeUndefined()
    expect( m.confidence('firm') ).toBeCloseTo( 0.9 - 3.5 * DAY * DEFAULT_BELIEF_DECAY_PER_SECOND, 2 )
  } )

  it('ignores the per-tick rate a woken mind saved under the old name', async () => {
    const m = await mind()
    m.sm.applyCommands( { set: [ { id: 'engine-config-semantic', type: 'engine.config',
      metadata: { engine: 'semantic', params: { beliefStalenessThreshold: 300, beliefDecayRate: 0.001 } } } ] } )
    m.integ.restoreBeliefs( [ belief('b-1', 0.5 ) ] )
    await m.run( 3600 )
    expect( m.confidence('b-1') ).toBeGreaterThan( 0.49 )
  } )
} )

describe('spaced repetition does not make a belief certain', () => {
  it('leaves an unsupported belief where it was, rather than raising it to 1.0', async () => {
    const m = await mind( { withReview: true } )
    m.integ.restoreBeliefs( [ belief('b-1', 0.3 ) ] )
    await m.run( 2000 )                             // forty review cycles
    expect( m.confidence('b-1') ).toBeLessThanOrEqual( 0.3 )
  } )
} )

describe('a review record never overwrites its belief', () => {
  it('persists under its own id, so the belief entity stays a belief and a woken mind restores it', async () => {
    const m = await mind( { withReview: true } )
    m.integ.integrateExecutiveBelief( belief('b-1', 0.7 ), 1 )
    await m.run( 60 )
    const entities = m.sm.snapshot().entities
    expect( entities.get('b-1')?.type ).toBe('belief')
    expect( entities.get( reviewRecordId('b-1') )?.metadata?.['beliefId'] ).toBe('b-1')

    const woken = new SemanticIntegrator()
    await woken.react( 1000 as never, 61 as never, m.sm.snapshot(), ctx )
    expect( woken.getBeliefs().map( b => b.id ) ).toContain('b-1')
  } )

  it('still restores a record written the old way, and lets the belief take its id back', async () => {
    const sm = new DefaultStateManager()
    sm.applyCommands( { set: [ { id: 'b-7', type: 'spaced_repetition_record', metadata: { interval: 125, lastReviewedAt: 40, consecutiveSuccesses: 3, easinessFactor: 2.8 } } ] } )
    const integ = new SemanticIntegrator(), sr = new SpacedRepetition()
    sr.attachSemanticIntegrator( integ as never )
    integ.restoreBeliefs( [ belief('b-7', 0.6 ) ] )   // carried by the artifact
    const snap = sm.snapshot()
    for( const r of await Promise.all( [ integ, sr ].map( e => e.react( 1000 as never, 41 as never, snap, ctx ) ) ) )
      if( r.commands ) sm.applyCommands( r.commands as StateCommands )
    expect( sr.getReviewStatus('b-7')?.interval ).toBe( 125 )
    expect( sm.snapshot().entities.get('b-7')?.type ).toBe('belief')
    expect( sm.snapshot().entities.get( reviewRecordId('b-7') ) ).toBeDefined()
  } )

  it('lets a record go with its belief — but not on a first tick before the beliefs are restored', async () => {
    const sm = new DefaultStateManager()
    sm.applyCommands( { set: [
      { id: reviewRecordId('gone'), type: 'spaced_repetition_record', metadata: { beliefId: 'gone', interval: 10, lastReviewedAt: 0 } },
      { id: reviewRecordId('b-5'),  type: 'spaced_repetition_record', metadata: { beliefId: 'b-5',  interval: 10, lastReviewedAt: 0 } },
      { id: 'b-5', type: 'belief', metadata: { statement: 'kept', confidence: 0.6 } },
    ] } )
    const sr = new SpacedRepetition()
    sr.attachSemanticIntegrator( new SemanticIntegrator() as never )   // has not restored yet
    const out = ( await sr.react( 1000 as never, 1 as never, sm.snapshot(), ctx ) ).commands as StateCommands
    expect( out.delete ).toContain( reviewRecordId('gone') )
    expect( sr.getReviewStatus('gone') ).toBeUndefined()
    expect( sr.getReviewStatus('b-5') ).toBeDefined()
  } )
} )

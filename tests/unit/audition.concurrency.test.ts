// ─────────────────────────────────────────────────────────────
// tests/unit/audition.concurrency.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Tier 2 + §6 — per-entity turn serialization with rapid-fire coalescing.
 *
 * Two ordering guarantees per entity:
 *   - Coalescing (§6): messages that pile up before a turn STARTS fold into that
 *     single turn (one report, one reply) — so a burst isn't answered N times.
 *   - Serialization: once a turn has started, a later message forms the NEXT turn
 *     and may not begin until the in-flight turn's decision lands.
 * Messages from DIFFERENT entities still run concurrently.
 *
 * Uses a controllable mock executive whose facet defers its decision, so the
 * ordering of report()/decision events is observable.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { AuditionEngine } from '#senses/audition.engine/engine'
import { createTestBus }  from '#cognition/bus'
import type { TextMessage } from '#senses/index'

const tick = () => new Promise( r => setTimeout( r, 0 ) )

function text( entityId: string, content: string ): TextMessage {
  return { kind: 'text', entityId, threadId: `t-${entityId}`, content }
}

/**
 * Mock executive whose facet records report() calls and DEFERS the decision.
 * `flushOne()` fires the next pending decision; `flushAll()` fires every one.
 */
function makeControllableExecutive(){
  const log: string[] = []
  const pending: Array<() => void> = []
  let spawns = 0

  const engine = {
    spawnFacet(){
      spawns++
      let subscriber: (( d: any ) => void) | null = null
      const handle = {
        facetId: `facet-${spawns}`,
        report( r: any ){
          const content = ( r.payload as any ).content
          log.push( `report:${content}` )
          pending.push( () => {
            log.push( `decision:${content}` )
            subscriber?.({
              decision: { reply: 'ok', replyBubbles: ['ok'], targetEntityId: 'x', requiresMasterAttention: false },
              reasoning: '',
              confidence: 0.9,
            })
          } )
        },
        subscribe( fn: any ){ subscriber = fn; return () => { subscriber = null } },
        setFocus(){}, setStateRef(){}, onChunk(){}, onReaped(){}, destroy(){},
      }
      return { attention: 'available' as const, handle }
    },
  }

  return {
    engine,
    log,
    get spawns(){ return spawns },
    flushOne(){ pending.shift()?.() },
    flushAll(){ while( pending.length ) pending.shift()!() },
  }
}

describe( 'AuditionEngine — coalescing + per-entity serialization', () => {
  let ctrl:   ReturnType<typeof makeControllableExecutive>
  let engine: AuditionEngine

  beforeEach( () => {
    ctrl   = makeControllableExecutive()
    engine = new AuditionEngine()
    engine.attachBus( createTestBus() )
    engine.attachExecutiveEngine( ctrl.engine as any )
  } )

  it( 'coalesces a burst that piles up before the turn starts into ONE turn (§6)', async () => {
    const ps = [
      engine.ingest( text( 'alice', 'A' ) ),
      engine.ingest( text( 'alice', 'B' ) ),
      engine.ingest( text( 'alice', 'C' ) ),
    ]

    await tick()
    // All three arrived before the window's turn started → a single coalesced report.
    expect( ctrl.log ).toEqual( [ 'report:A\nB\nC' ] )

    ctrl.flushOne()
    await Promise.all( ps )
    expect( ctrl.log ).toEqual( [ 'report:A\nB\nC', 'decision:A\nB\nC' ] )

    // One facet, one turn — the burst was not answered three times.
    expect( ctrl.spawns ).toBe( 1 )
  } )

  it( 'does not begin the next turn until the in-flight turn resolves', async () => {
    const p1 = engine.ingest( text( 'alice', 'A' ) )

    await tick()
    // A's window started immediately — its turn is in flight.
    expect( ctrl.log ).toEqual( [ 'report:A' ] )

    // B arrives AFTER A started → it opens a fresh window queued behind A.
    const p2 = engine.ingest( text( 'alice', 'B' ) )
    await tick()
    expect( ctrl.log ).toEqual( [ 'report:A' ] )      // B blocked on A's decision

    ctrl.flushOne()       // resolve A → chain advances to B
    await tick()
    expect( ctrl.log ).toEqual( [ 'report:A', 'decision:A', 'report:B' ] )

    ctrl.flushOne()       // resolve B
    await Promise.all( [ p1, p2 ] )
    expect( ctrl.log ).toEqual( [ 'report:A', 'decision:A', 'report:B', 'decision:B' ] )

    expect( ctrl.spawns ).toBe( 1 )   // one facet reused across both turns
  } )

  it( 'coalesces messages that arrive DURING an in-flight turn into the next turn (§6)', async () => {
    const p1 = engine.ingest( text( 'alice', 'A' ) )
    await tick()
    expect( ctrl.log ).toEqual( [ 'report:A' ] )      // A in flight

    // B and C arrive while A is still reasoning → they fold into one next turn.
    const p2 = engine.ingest( text( 'alice', 'B' ) )
    const p3 = engine.ingest( text( 'alice', 'C' ) )
    await tick()
    expect( ctrl.log ).toEqual( [ 'report:A' ] )      // both wait behind A

    ctrl.flushOne()       // resolve A → the coalesced B+C turn runs
    await tick()
    expect( ctrl.log ).toEqual( [ 'report:A', 'decision:A', 'report:B\nC' ] )

    ctrl.flushOne()
    await Promise.all( [ p1, p2, p3 ] )
    expect( ctrl.log ).toEqual( [ 'report:A', 'decision:A', 'report:B\nC', 'decision:B\nC' ] )
  } )

  it( 'processes different entities concurrently (no cross-entity blocking)', async () => {
    const p1 = engine.ingest( text( 'alice', 'A' ) )
    const p2 = engine.ingest( text( 'bob',   'B' ) )

    await tick()
    // Both reported without waiting on each other.
    expect( ctrl.log.filter( l => l.startsWith( 'report:' ) ).sort() )
      .toEqual( [ 'report:A', 'report:B' ] )

    ctrl.flushAll()
    await Promise.all( [ p1, p2 ] )
    expect( ctrl.spawns ).toBe( 2 )   // independent facets
  } )
} )

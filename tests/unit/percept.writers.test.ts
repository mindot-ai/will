// ─────────────────────────────────────────────────────────────
// tests/unit/percept.writers.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P0 step 2 — the four writers that were not exteroception.
 *
 * Two forgot `tick` and were therefore IMMORTAL: `exteroception` is the only
 * sweeper of `type: 'percept'` and collects only entities whose `metadata.tick`
 * is a number. Three forgot `provenance` and were therefore UNRUPTURABLE:
 * `action.selector`'s gate counts only `'exafferent'` percepts.
 *
 * These pin what changed, because the whole suite passed before and after the
 * retrofit — which meant nothing covered either fault. A green suite over a
 * behaviour change is a statement about the tests, not the change.
 */

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, SimulationEntity } from '#core/types'
import { Exteroception } from '#faculties/exteroception'
import { PERCEPT_STALE_AFTER_TICKS } from '#cognition/percept.entity'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const frozen = ( s: MutState ) => s as unknown as ReadonlySimulationState

function stateWith( entities: SimulationEntity[] ): MutState {
  const m = new Map<string, SimulationEntity>()
  for( const e of entities ) m.set( e.id, e )
  return { tick: 0, time: 0, entities: m, metrics: new Map() }
}

/** Run one Exteroception tick and return the ids it asked to delete. */
async function swept( entities: SimulationEntity[], tick: number ): Promise<string[]> {
  const eng = new Exteroception()
  const r = await eng.react( 0, tick, frozen( stateWith( entities ) ), CTX )
  return r.commands?.delete ?? []
}

const percept = ( id: string, metadata: Record<string, unknown> ): SimulationEntity =>
  ( { id, type: 'percept', createdAt: 0, updatedAt: 0, metadata } as SimulationEntity )

describe('the sweeper only ever saw percepts that carried a tick', () => {
  it('a ticked percept is collected once it is stale', async () => {
    const stale = percept('p-ticked', { tick: 0, salience: 0.3, category: 'c', summary: 's', provenance: 'exafferent' } )
    expect( await swept( [ stale ], PERCEPT_STALE_AFTER_TICKS + 1 ) ).toContain('p-ticked')
  } )

  it('a TICKLESS percept is never collected, at any age — the shape of the old leak', async () => {
    // This is what `msg-delivered-<id>` and `percept-wake-event` used to be.
    // Not a slow leak: an entity that can never be collected, one per message
    // the mind ever successfully sent.
    const immortal = percept('p-tickless', { salience: 0.6, category: 'message-delivery', summary: 's', provenance: 'reafferent' } )
    expect( await swept( [ immortal ], 10_000 ) ).not.toContain('p-tickless')
  } )
} )

describe('the retrofitted writers produce sweepable, tagged percepts', () => {
  // Shape assertions against the real writers, reached through their public
  // entry points, so a future hand-rolled literal that skips perceptEntity()
  // fails here rather than silently rejoining the leak.

  it('a delivery percept carries a numeric tick, so it expires', async () => {
    const { OutboxController } = await import('#stem/tracts/outbox.controller')
    const written: SimulationEntity[] = []
    const instance = {
      tickCount: 12,
      config: { id: 'w' },
      simulation: { stateManager: {
        setEntity: ( e: SimulationEntity ) => written.push( e ),
        getEntitiesByType: () => [],
      } },
      outbox: { messages: [] },
    } as never

    new OutboxController().confirmDelivery( instance, 'm-1', true )

    const p = written.find( e => e.type === 'percept')
    expect( p ).toBeDefined()
    expect( typeof p!.metadata!['tick'] ).toBe('number')
    expect( p!.metadata!['tick'] ).toBe( 12 )
    expect( p!.metadata!['provenance'] ).toBe('reafferent')
    expect( p!.metadata!['messageId'] ).toBe('m-1')
  } )

  it('a delivery percept written at tick N is swept by tick N+3', async () => {
    // End to end: the leak is closed, not merely annotated.
    const delivered = percept('msg-delivered-m-1', {
      tick: 12, salience: 0.35, category: 'message-delivery',
      summary: 'My message was delivered successfully.', provenance: 'reafferent', messageId: 'm-1',
    } )
    expect( await swept( [ delivered ], 12 + PERCEPT_STALE_AFTER_TICKS + 1 ) ).toContain('msg-delivered-m-1')
  } )
} )

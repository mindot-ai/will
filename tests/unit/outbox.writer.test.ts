// ─────────────────────────────────────────────────────────────
// tests/unit/outbox.writer.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * OutboxWriter — the shared outbox producer. `enqueueReply` (formerly
 * ProactiveCommunicator.deliverReply, used by AuditionEngine) and `enqueue` (the
 * canonical row push used by ProactiveCommunicator's effector handlers).
 *
 * `pushToOutbox` controls only whether a copy is queued. When an ExternalTransport
 * already delivered the reply via the fast-path, the bubbles are NOT pushed (avoids
 * double delivery) — but the message ids are still generated and returned. There is
 * no channel gate here: emission is governed upstream by the `talk` agency grant.
 */

import { describe, it, expect } from 'vitest'
import { OutboxWriter } from '#stem/tracts/outbox.writer'
import type { OutboxMessage } from '#types'

function make(){
  const outbox: OutboxMessage[] = []
  const writer = new OutboxWriter({ outbox, willId: 'w' })
  return { writer, outbox }
}

describe('OutboxWriter.enqueueReply — pushToOutbox', () => {
  it('pushes bubbles to the outbox by default', () => {
    const { writer, outbox } = make()
    const ids = writer.enqueueReply({ entityId: 'a', entityName: 'A', bubbles: ['hi', 'yo'] })
    expect( ids ).toHaveLength( 2 )
    expect( outbox ).toHaveLength( 2 )
    expect( outbox.map( m => m.content ) ).toEqual( ['hi', 'yo'] )
    expect( outbox.every( m => m.effectorName === 'text') ).toBe( true )
  } )

  it('pushToOutbox=false returns ids but does NOT push to the outbox', () => {
    const { writer, outbox } = make()
    const ids = writer.enqueueReply({ entityId: 'a', entityName: 'A', bubbles: ['hi'], pushToOutbox: false })
    expect( ids ).toHaveLength( 1 )      // ids still generated (for correlation)
    expect( outbox ).toHaveLength( 0 )   // but nothing queued — transport already delivered
  } )

  it('returns an empty array when there are no bubbles', () => {
    const { writer, outbox } = make()
    const ids = writer.enqueueReply({ entityId: 'a', entityName: 'A', bubbles: [] })
    expect( ids ).toEqual( [] )
    expect( outbox ).toHaveLength( 0 )
  } )
} )

describe('OutboxWriter.enqueue — canonical row', () => {
  it('stamps id + defaults and returns the generated id', () => {
    const { writer, outbox } = make()
    const id = writer.enqueue({ targetEntityId: 'bob', content: 'wave', effectorName: 'gesture', gestureType: 'wave' })
    expect( outbox ).toHaveLength( 1 )
    const row = outbox[0]!
    expect( row.id ).toBe( id )
    expect( row.effectorName ).toBe('gesture')
    expect( row.gestureType ).toBe('wave')
    expect( row.deliveryStatus ).toBe('pending')
    expect( row.createdAtTick ).toBe( 0 )
  } )

  it('omits optional fields that are not provided', () => {
    const { writer, outbox } = make()
    writer.enqueue({ targetEntityId: '*', content: 'all hands', effectorName: 'broadcast' })
    const row = outbox[0]!
    expect( row.targetEntityName ).toBeUndefined()
    expect( row.threadId ).toBeUndefined()
    expect( row.gestureType ).toBeUndefined()
  } )
} )

describe('OutboxWriter — deterministic ids (replay fidelity)', () => {
  it('mints monotonic per-Will ids, identical across two equal runs', () => {
    const run = () => {
      const w = new OutboxWriter({ outbox: [], willId: 'w' })
      return [
        w.enqueue({ targetEntityId: 'a', content: '1', effectorName: 'text' }),
        w.enqueue({ targetEntityId: 'a', content: '2', effectorName: 'text' }),
      ]
    }
    expect( run() ).toEqual( ['outbox-w-1', 'outbox-w-2'] )
    expect( run() ).toEqual( run() )   // no Date.now()/Math.random() drift
  } )
} )

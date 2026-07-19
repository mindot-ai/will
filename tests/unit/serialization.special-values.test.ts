// ─────────────────────────────────────────────────────────────
// tests/unit/serialization.special-values.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for lossless metadata/components serialization (FN15).
 *
 * Regression target: entity `metadata`/`components` are free-form
 * `Record<string, unknown>` serialized via `JSON.stringify`. Any `Map`, `Set`,
 * `Date`, or `undefined`-valued key stored there was silently flattened/dropped
 * on round-trip — and `_computeChecksum` deliberately *excluded*
 * metadata/components, so the loss passed the integrity check undetected.
 *
 * The fix tags Map/Set/Date/undefined on serialize and revives them on
 * deserialize, and folds the (encoded) metadata/components into the checksum so
 * any future round-trip loss or tampering is caught.
 */

import { describe, it, expect } from 'vitest'
import { DefaultSerializer } from '#core/serialization'
import type { SimulationState, SimulationEntity } from '#core/types'

function stateWith( metadata: Record<string, unknown>, components: Record<string, unknown> = {} ): SimulationState {
  const entity: SimulationEntity = {
    id: 'e1', type: 'rich',
    createdAt: 1000, updatedAt: 2000,
    metadata: { ...metadata, components },
  }
  return {
    tick: 5,
    time: 80,
    entities: new Map( [ [ entity.id, entity ] ] ),
    metrics: new Map<string, number>( [ [ 'm', 1 ] ] ),
  } as unknown as SimulationState
}

describe('DefaultSerializer — lossless special values in metadata/components (FN15)', () => {
  const ser = new DefaultSerializer({ includeChecksum: true, prettyPrint: false })

  it('round-trips Map / Set / Date / undefined that plain JSON would drop', () => {
    const map = new Map<string, number>( [ [ 'a', 1 ], [ 'b', 2 ] ] )
    const set = new Set<string>( [ 'x', 'y' ] )
    const date = new Date('2026-05-29T00:00:00.000Z')

    const state = stateWith({
      tags: set,
      lastSeen: date,
      counts: map,
      missing: undefined,           // a key whose value is undefined
      plain: { nested: [ 1, 'two', true ] },
    })

    const restored = ser.deserialize( ser.serialize( state, 'json') as string )
    const meta = restored.entities.get('e1')!.metadata!

    expect( meta.tags ).toBeInstanceOf( Set )
    expect( [ ...( meta.tags as Set<string> ) ] ).toEqual( [ 'x', 'y' ] )

    expect( meta.lastSeen ).toBeInstanceOf( Date )
    expect( ( meta.lastSeen as Date ).toISOString() ).toBe('2026-05-29T00:00:00.000Z')

    expect( meta.counts ).toBeInstanceOf( Map )
    expect( [ ...( meta.counts as Map<string, number> ) ] ).toEqual( [ [ 'a', 1 ], [ 'b', 2 ] ] )

    // The `undefined` key survives (present with an undefined value), where
    // plain JSON would have dropped the key entirely.
    expect('missing' in meta ).toBe( true )
    expect( meta.missing ).toBeUndefined()

    // Plain JSON values are untouched.
    expect( meta.plain ).toEqual( { nested: [ 1, 'two', true ] } )
  })

  it('round-trips special values nested inside components and inside containers', () => {
    const state = stateWith(
      {},
      {
        // Map whose values are themselves Sets/Dates, plus an array of Maps.
        index: new Map<string, Set<number>>( [ [ 'g', new Set( [ 1, 2 ] ) ] ] ),
        history: [ new Date('2020-01-01T00:00:00.000Z'), { when: new Date('2021-01-01T00:00:00.000Z') } ],
      },
    )

    const restored = ser.deserialize( ser.serialize( state, 'json') as string )
    const comp = restored.entities.get('e1')!.metadata!.components as Record<string, unknown>

    const index = comp.index as Map<string, Set<number>>
    expect( index ).toBeInstanceOf( Map )
    expect( index.get('g') ).toBeInstanceOf( Set )
    expect( [ ...index.get('g')! ] ).toEqual( [ 1, 2 ] )

    const history = comp.history as unknown[]
    expect( history[0] ).toBeInstanceOf( Date )
    expect( ( ( history[1] as Record<string, unknown> ).when ) ).toBeInstanceOf( Date )
  })

  it('plain-JSON-only metadata still round-trips unchanged (no regression)', () => {
    const state = stateWith({ score: 0.5, label: 'ok', flags: [ true, false ], obj: { a: 1 } })
    const restored = ser.deserialize( ser.serialize( state, 'json') as string )
    const meta = restored.entities.get('e1')!.metadata!

    expect( meta.score ).toBe( 0.5 )
    expect( meta.label ).toBe('ok')
    expect( meta.flags ).toEqual( [ true, false ] )
    expect( meta.obj ).toEqual( { a: 1 } )
  })

  it('the checksum now covers metadata — tampering is detected (FN15)', () => {
    const state = stateWith({ secret: 'original' })
    const serialized = ser.serialize( state, 'json') as string

    // Tamper with metadata only, leaving id/type/updatedAt and the stored
    // checksum untouched — exactly the case the old (metadata-excluded)
    // checksum let slip through.
    const parsed = JSON.parse( serialized )
    parsed.entities[0].metadata.secret = { __ser: 'undefined' }  // simulate a dropped value

    expect( () => ser.deserialize( JSON.stringify( parsed ) ) ).toThrow( /Checksum mismatch/ )
  })

  it('an untampered round-trip passes the checksum even with special values present', () => {
    const state = stateWith({ when: new Date('2026-05-29T00:00:00.000Z'), set: new Set( [ 1 ] ) })
    // Should not throw — the checksum is computed over the encoded form and
    // verified against that same encoded form before decoding.
    expect( () => ser.deserialize( ser.serialize( state, 'json') as string ) ).not.toThrow()
  })
})

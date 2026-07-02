// ─────────────────────────────────────────────────────────────
// tests/unit/serialization.updated-at-tick.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Regression: entity.updatedAtTick must survive a serialize round-trip.
 *
 * updatedAtTick is the sim tick of the last write (stamped by
 * StateManager.setEntity) and is read by ConflictDetector to compare a write's
 * tick against a footprint's tickObserved. It used to be dropped on
 * (de)serialization, so after a snapshot restore every entity reported
 * updatedAtTick === undefined and the AsyncEngine optimistic-concurrency check
 * silently mis-behaved until each entity was next written.
 */

import { describe, it, expect } from 'vitest'
import { DefaultSerializer } from '#core/serialization'
import type { SimulationState, SimulationEntity } from '#core/types'

function stateWith( entity: SimulationEntity ): SimulationState {
  return {
    tick: 9,
    time: 144,
    entities: new Map( [ [ entity.id, entity ] ] ),
    metrics: new Map<string, number>(),
  } as unknown as SimulationState
}

describe( 'DefaultSerializer — updatedAtTick round-trip', () => {
  const ser = new DefaultSerializer({ includeChecksum: true, prettyPrint: false })

  it( 'preserves updatedAtTick through serialize/deserialize', () => {
    const entity: SimulationEntity = {
      id: 'e1', type: 't',
      createdAt: 1000, updatedAt: 2000,
      updatedAtTick: 7,
      metadata: { components: {} },
    }

    const restored = ser.deserialize( ser.serialize( stateWith( entity ), 'json' ) as string )
    expect( restored.entities.get( 'e1' )!.updatedAtTick ).toBe( 7 )
  })

  it( 'tampering with updatedAtTick alone is caught by the checksum', () => {
    const entity: SimulationEntity = {
      id: 'e1', type: 't', createdAt: 0, updatedAt: 5, updatedAtTick: 5, metadata: { components: {} },
    }
    const serialized = ser.serialize( stateWith( entity ), 'json' ) as string

    const parsed = JSON.parse( serialized )
    parsed.entities[0].updatedAtTick = 999  // leave id/type/updatedAt/checksum untouched

    expect( () => ser.deserialize( JSON.stringify( parsed ) ) ).toThrow( /Checksum mismatch/ )
  })

  it( 'an entity without updatedAtTick round-trips as undefined (no fabricated value)', () => {
    const entity: SimulationEntity = {
      id: 'e1', type: 't', createdAt: 0, updatedAt: 1, metadata: { components: {} },
    }
    const restored = ser.deserialize( ser.serialize( stateWith( entity ), 'json' ) as string )
    expect( restored.entities.get( 'e1' )!.updatedAtTick ).toBeUndefined()
  })
})

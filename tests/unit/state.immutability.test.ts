// ─────────────────────────────────────────────────────────────
// tests/unit/state.immutability.test.ts
// ─────────────────────────────────────────────────────────────

/**
 * State-immutability guarantee — the runtime half of the double-buffer
 * contract (REORIENT R3).
 *
 * The type system marks the per-tick snapshot `ReadonlyDeep<SimulationState>`,
 * but that is erased at runtime: before R3, "read-only snapshot" and "atomic
 * double-buffer commit" were conventions, not guarantees. A single careless
 * `entity.foo = x` on a value an engine *read* would silently corrupt the
 * shared live state and break determinism invisibly (FIX F1).
 *
 * The strategy chosen is (a): deep-`Object.freeze` every entity at the
 * StateManager write boundary (dev/test-gated; off only in production). These
 * tests prove the three properties that make the guarantee real:
 *
 *   1. Entities read back from the manager are deeply frozen — any mutation
 *      throws loudly instead of corrupting state silently.
 *   2. A snapshot is a genuine point-in-time view: later commits never reach
 *      back and mutate it (rollback / replay correctness inherits from this).
 *   3. The freeze is gated — `WILL_FREEZE_STATE=0` opts production out of the
 *      per-write cost without changing any other behavior.
 */

import { describe, it, expect } from 'vitest'
import { DefaultStateManager } from '#core/state.manager'
import { deepFreeze } from '#core/utils'

/**
 * Build a manager with the freeze gate forced to a known value, independent of
 * the ambient NODE_ENV the suite happens to run under. The flag is captured at
 * construction (a field initializer), so restoring the env immediately after is
 * safe and keeps the singleFork process clean.
 */
function makeManager( freeze: boolean ): DefaultStateManager {
  const saved = process.env.WILL_FREEZE_STATE
  process.env.WILL_FREEZE_STATE = freeze ? '1' : '0'
  try { return new DefaultStateManager() }
  finally {
    if( saved === undefined ) delete process.env.WILL_FREEZE_STATE
    else process.env.WILL_FREEZE_STATE = saved
  }
}

describe('State immutability — frozen entities (R3)', () => {
  it('deep-freezes entities on write so direct mutation throws', () => {
    const sm = makeManager( true )
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { score: 1, nested: { deep: true } } })

    const e = sm.getEntity('e1')!
    expect( Object.isFrozen( e ) ).toBe( true )
    expect( Object.isFrozen( e.metadata ) ).toBe( true )
    expect( Object.isFrozen( ( e.metadata as { nested: object } ).nested ) ).toBe( true )

    // Strict mode (all ESM) → assignment to a frozen property throws.
    expect( () => { ( e as { type: string } ).type = 'goal' } ).toThrow()
    expect( () => { ( e.metadata as { score: number } ).score = 99 } ).toThrow()
    expect( () => { ( e.metadata as { nested: { deep: boolean } } ).nested.deep = false } ).toThrow()

    // State is intact — nothing got through.
    expect( sm.getEntity('e1')!.type ).toBe('belief')
    expect( sm.getEntity('e1')!.metadata!.score ).toBe( 1 )
  })

  it('freezes entities applied via applyCommands (the commit path)', () => {
    const sm = makeManager( true )
    sm.applyCommands({ set: [ { id: 'g1', type: 'goal', metadata: { priority: 5 } } ] })

    const g = sm.getEntity('g1')!
    expect( Object.isFrozen( g ) ).toBe( true )
    expect( () => { ( g.metadata as { priority: number } ).priority = 1 } ).toThrow()
  })

  it('hands engines a frozen read-view via snapshot()', () => {
    const sm = makeManager( true )
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { score: 1 } })

    const snap = sm.snapshot()
    const view = snap.entities.get('e1')!
    expect( Object.isFrozen( view ) ).toBe( true )
    expect( () => { ( view as { type: string } ).type = 'mutated' } ).toThrow()
  })

  it('snapshot is a point-in-time view — later commits never mutate it', () => {
    const sm = makeManager( true )

    // tick 0: write v1
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 1 } })
    const snap = sm.snapshot()

    // tick 1: overwrite the same id with v2 (slot replacement, fresh object)
    sm.updateClock( 1, 100 )
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { count: 2 } })

    // The snapshot still sees v1; the live manager sees v2. This isolation is
    // what makes rollback/replay correct — the captured state cannot drift.
    expect( snap.entities.get('e1')!.metadata!.count ).toBe( 1 )
    expect( sm.getEntity('e1')!.metadata!.count ).toBe( 2 )
  })

  it('re-establishes the freeze guarantee across restore()', () => {
    const sm = makeManager( true )

    // A snapshot whose entity is a plain (unfrozen) object, as if just
    // deserialized from disk.
    const fresh = { id: 'e1', type: 'belief', createdAt: 0, updatedAt: 0, metadata: { v: 1 } }
    expect( Object.isFrozen( fresh ) ).toBe( false )

    sm.restore({ tick: 5, time: 250, entities: new Map([ [ 'e1', fresh ] ]), metrics: new Map() })

    const e = sm.getEntity('e1')!
    expect( Object.isFrozen( e ) ).toBe( true )
    expect( () => { ( e.metadata as { v: number } ).v = 2 } ).toThrow()
  })

  it('leaves entities mutable when the gate is off (WILL_FREEZE_STATE=0)', () => {
    const sm = makeManager( false )
    sm.setEntity({ id: 'e1', type: 'belief', metadata: { score: 1 } })

    const e = sm.getEntity('e1')!
    expect( Object.isFrozen( e ) ).toBe( false )

    // No throw, and the mutation is observable — the production opt-out path.
    expect( () => { ( e.metadata as { score: number } ).score = 42 } ).not.toThrow()
    expect( sm.getEntity('e1')!.metadata!.score ).toBe( 42 )
  })
})

describe('deepFreeze utility', () => {
  it('passes primitives and null through unchanged', () => {
    expect( deepFreeze( 5 ) ).toBe( 5 )
    expect( deepFreeze('x') ).toBe('x')
    expect( deepFreeze( null ) ).toBe( null )
    expect( deepFreeze( undefined ) ).toBe( undefined )
  })

  it('freezes nested objects and arrays', () => {
    const obj = { a: { b: [ { c: 1 } ] } }
    deepFreeze( obj )
    expect( Object.isFrozen( obj ) ).toBe( true )
    expect( Object.isFrozen( obj.a ) ).toBe( true )
    expect( Object.isFrozen( obj.a.b ) ).toBe( true )
    expect( Object.isFrozen( obj.a.b[ 0 ] ) ).toBe( true )
    expect( () => { obj.a.b.push( { c: 2 } ) } ).toThrow()
  })

  it('is cycle-safe — does not recurse forever on a self-reference', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect( () => deepFreeze( a ) ).not.toThrow()
    expect( Object.isFrozen( a ) ).toBe( true )
  })
})

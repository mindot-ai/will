// ─────────────────────────────────────────────────────────────
// tests/unit/ack.reconciler.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * AckReconciler (Section 3) — idempotent dedup across the dual ack paths.
 */

import { describe, it, expect } from 'vitest'
import { AckReconciler } from '#stem/tracts/ack.reconciler'

describe( 'AckReconciler', () => {
  it( 'applies the first ack for a correlationId and drops the rest', () => {
    const r = new AckReconciler()
    expect( r.shouldApply( 'c1' ) ).toBe( true )
    expect( r.shouldApply( 'c1' ) ).toBe( false )
    expect( r.shouldApply( 'c1' ) ).toBe( false )
  } )

  it( 'treats distinct correlationIds independently', () => {
    const r = new AckReconciler()
    expect( r.shouldApply( 'a' ) ).toBe( true )
    expect( r.shouldApply( 'b' ) ).toBe( true )
    expect( r.shouldApply( 'a' ) ).toBe( false )
  } )

  it( 'has() reports membership without recording', () => {
    const r = new AckReconciler()
    expect( r.has( 'x' ) ).toBe( false )
    r.shouldApply( 'x' )
    expect( r.has( 'x' ) ).toBe( true )
  } )

  it( 'evicts oldest entries past the bound (FIFO) and re-applies an evicted id', () => {
    const r = new AckReconciler( 2 )
    r.shouldApply( 'a' )       // [a]
    r.shouldApply( 'b' )       // [a,b]
    r.shouldApply( 'c' )       // evicts a → [b,c]
    expect( r.size ).toBe( 2 )
    expect( r.has( 'a' ) ).toBe( false )   // evicted
    expect( r.has( 'b' ) ).toBe( true )
    expect( r.has( 'c' ) ).toBe( true )
    // 'a' was evicted, so it is treated as new again
    expect( r.shouldApply( 'a' ) ).toBe( true )
    expect( r.shouldApply( 'c' ) ).toBe( false )   // 'c' still tracked
  } )

  it( 'clear() forgets everything', () => {
    const r = new AckReconciler()
    r.shouldApply( 'a' )
    r.clear()
    expect( r.size ).toBe( 0 )
    expect( r.shouldApply( 'a' ) ).toBe( true )
  } )
} )

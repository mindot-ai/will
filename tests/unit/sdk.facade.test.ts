// ─────────────────────────────────────────────────────────────
// tests/unit/sdk.facade.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The Will SDK facade — its deterministic contract. (Conversation replies are
 * salience/timing-dependent under the mock and covered by the examples, not
 * here; this pins the plumbing that is reliable: create, state summary shape,
 * effector registration, and the hibernate → wake PMA roundtrip.)
 */

import { describe, it, expect, afterAll } from 'vitest'
import { Will } from '#sdk/will'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
afterAll( () => resetLogger() )

const base = { llm: 'mock' as const, engineTier: 'standard' as const, tickMs: 10, seed: 3 }

describe( 'Will facade', () => {
  it( 'create() returns a running Will with a well-formed state summary', async () => {
    const will = await Will.create( { ...base, name: 'Aria', identity: { prompt: 'I am Aria.' } } )
    try {
      expect( will.name ).toBe( 'Aria' )
      expect( will.id ).toMatch( /^aria-/ )
      expect( will.stem ).toBeDefined()

      // Let the tick loop advance, then read the summary.
      await new Promise( r => setTimeout( r, 400 ) )
      const s = will.state()

      expect( s.tick ).toBeGreaterThan( 0 )
      expect( s.metrics.energy ).toBeGreaterThan( 0 )
      expect( s.metrics.energy ).toBeLessThanOrEqual( 100 )
      expect( typeof s.metrics.valence ).toBe( 'number' )
      expect( Array.isArray( s.goals ) ).toBe( true )
      expect( Array.isArray( s.beliefs ) ).toBe( true )
      expect( typeof s.narrative ).toBe( 'string' )
    }
    finally { await will.stop() }
  }, 30_000 )

  it( 'effector() registers a handler and is chainable, without disrupting the tick loop', async () => {
    const will = await Will.create( { ...base, name: 'Tool', identity: { prompt: 'I use tools.' } } )
    try {
      const ret = will
        .effector( 'search', async () => 'ok' )
        .effector( 'fetch', async () => ( { success: true, description: 'done' } ) )
      expect( ret ).toBe( will )               // chainable
      await new Promise( r => setTimeout( r, 200 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )   // still ticking
    }
    finally { await will.stop() }
  }, 30_000 )

  it( 'hibernate() → wake() preserves identity + a formed relationship across the boundary', async () => {
    const will = await Will.create( { ...base, name: 'Memo', identity: { prompt: 'I remember people.' } } )

    // Meeting someone forms a relationship bond that the PMA must carry.
    await will.tell( 'ada', 'Ada', 'Hi, I am Ada.' )
    await new Promise( r => setTimeout( r, 500 ) )

    const pma = await will.hibernate()               // distils + archives
    expect( pma.willName ).toBe( 'Memo' )
    expect( Array.isArray( pma.relationships ) ).toBe( true )
    expect( ( pma.relationships as unknown[] ).length ).toBeGreaterThan( 0 )   // Ada survived

    // Wake a brand-new mind from the artifact.
    const revived = await Will.wake( pma, { ...base, name: 'Memo' } )
    try {
      await new Promise( r => setTimeout( r, 200 ) )
      const pma2 = revived.stem.distillPMA( revived.id )
      expect( ( pma2.relationships as unknown[] ).length ).toBeGreaterThan( 0 )   // still remembers Ada
    }
    finally { await revived.stop() }
  }, 30_000 )
} )

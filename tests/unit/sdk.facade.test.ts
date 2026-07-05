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

describe( 'Will facade — subject surface', () => {
  it( 'nextUtterance() resolves null when the Will stays silent (silence is valid)', async () => {
    const will = await Will.create( { ...base, name: 'Quiet', identity: { prompt: 'I am reserved.' } } )
    try {
      // Nobody ever addressed "ghost" — the Will has no reason to speak to it.
      const reply = await will.nextUtterance( { to: 'ghost', within: 200 } )
      expect( reply ).toBeNull()
    }
    finally { await will.stop() }
  }, 30_000 )

  it( 'nextUtterance() resolves (never rejects) null when the Will is stopped mid-wait', async () => {
    const will = await Will.create( { ...base, name: 'Interrupt', identity: { prompt: 'brief' } } )
    const pending = will.nextUtterance( { within: 10_000 } )
    await new Promise( r => setTimeout( r, 100 ) )
    await will.stop()
    await expect( pending ).resolves.toBeNull()
  }, 30_000 )

  it( 'save() checkpoints the mind without stopping it (non-destructive)', async () => {
    const will = await Will.create( { ...base, name: 'Saver', identity: { prompt: 'I persist.' } } )
    try {
      await new Promise( r => setTimeout( r, 200 ) )
      const t0  = will.state().tick
      const pma = await will.save()
      expect( pma.willName ).toBe( 'Saver' )

      // Still alive after the checkpoint: it keeps ticking and state() resolves.
      await new Promise( r => setTimeout( r, 200 ) )
      expect( will.state().tick ).toBeGreaterThan( t0 )
    }
    finally { await will.stop() }
  }, 30_000 )

  it( 'on() is chainable across every projection channel without disrupting the tick loop', async () => {
    const will = await Will.create( { ...base, name: 'Obs', identity: { prompt: 'I am observed.' } } )
    try {
      const ret = will
        .on( 'message',  () => {} )
        .on( 'effector', () => {} )
        .on( 'emotion',  () => {} )
        .on( 'state',    () => {} )
        .on( 'error',    () => {} )
      expect( ret ).toBe( will )                          // chainable
      await new Promise( r => setTimeout( r, 150 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )    // still ticking
    }
    finally { await will.stop() }
  }, 30_000 )

  it( 'perceive() is the intake say/tell route through, and does not stall ticking', async () => {
    const will = await Will.create( { ...base, name: 'Ears', identity: { prompt: 'I listen.' } } )
    try {
      await will.perceive( { from: 'ada', speaker: 'Ada', text: 'Hello there.' } )
      await will.say( 'noted' )
      await will.tell( 'bob', 'Bob', 'and hello from Bob' )
      await new Promise( r => setTimeout( r, 150 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

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

const base = { llm: 'mock' as const, anatomy: 'mind' as const, tickMs: 10, seed: 3 }

describe('Will facade', () => {
  it('create() returns a running Will with a well-formed state summary', async () => {
    const will = await Will.create( { ...base, name: 'Aria', identity: { prompt: 'I am Aria.' } } )
    try {
      expect( will.name ).toBe('Aria')
      expect( will.id ).toMatch( /^aria-/ )
      expect( will.stem ).toBeDefined()

      // Let the tick loop advance, then read the summary.
      await new Promise( r => setTimeout( r, 400 ) )
      const s = will.state()

      expect( s.tick ).toBeGreaterThan( 0 )
      expect( s.metrics.energy ).toBeGreaterThan( 0 )
      expect( s.metrics.energy ).toBeLessThanOrEqual( 100 )
      expect( typeof s.metrics.valence ).toBe('number')
      expect( Array.isArray( s.goals ) ).toBe( true )
      expect( Array.isArray( s.beliefs ) ).toBe( true )
      expect( typeof s.narrative ).toBe('string')
    }
    finally { await will.stop() }
  }, 30_000 )

  it('effector() registers a handler and is chainable, without disrupting the tick loop', async () => {
    const will = await Will.create( { ...base, name: 'Tool', identity: { prompt: 'I use tools.' } } )
    try {
      const ret = will
        .effector('search', async () => 'ok')
        .effector('fetch', async () => ( { success: true, description: 'done' } ) )
      expect( ret ).toBe( will )               // chainable
      await new Promise( r => setTimeout( r, 200 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )   // still ticking
    }
    finally { await will.stop() }
  }, 30_000 )

  it('hibernate() → wake() preserves identity + a formed relationship across the boundary', async () => {
    const will = await Will.create( { ...base, name: 'Memo', identity: { prompt: 'I remember people.' } } )

    // Meeting someone forms a relationship bond that the PMA must carry.
    await will.tell('ada', 'Ada', 'Hi, I am Ada.')
    await new Promise( r => setTimeout( r, 500 ) )

    const pma = await will.hibernate()               // distils + archives
    expect( pma.willName ).toBe('Memo')
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

  it('wake() keeps the artifact\'s willId — the path key for the vector store', async () => {
    // The id is the path key for everything durable that lives OUTSIDE the artifact:
    // data/wills/<id>/vector_index, snapshots, session logs. Minting a fresh random id
    // on wake pointed a woken mind at an empty vector store every boot — identity and
    // beliefs returned (artifact-carried) while episodic recall was permanently empty.
    const will = await Will.create( { ...base, name: 'Keeper', identity: { prompt: 'I persist.' } } )
    const originalId = will.id
    const pma = await will.hibernate()
    expect( pma.willId ).toBe( originalId )

    const revived = await Will.wake( pma, { ...base, name: 'Keeper' } )
    try { expect( revived.id ).toBe( originalId ) }
    finally { await revived.stop() }
  }, 30_000 )

  it('an explicit opts.id still overrides the artifact', async () => {
    const will = await Will.create( { ...base, name: 'Fork', identity: { prompt: 'I fork.' } } )
    const pma = await will.hibernate()

    const revived = await Will.wake( pma, { ...base, name: 'Fork', id: 'fork-explicit' } )
    try { expect( revived.id ).toBe('fork-explicit') }
    finally { await revived.stop() }
  }, 30_000 )
} )

describe('Will facade — subject surface', () => {
  it('nextUtterance() resolves null when the Will stays silent (silence is valid)', async () => {
    const will = await Will.create( { ...base, name: 'Quiet', identity: { prompt: 'I am reserved.' } } )
    try {
      // Nobody ever addressed "ghost" — the Will has no reason to speak to it.
      const reply = await will.nextUtterance( { to: 'ghost', within: 200 } )
      expect( reply ).toBeNull()
    }
    finally { await will.stop() }
  }, 30_000 )

  it('nextUtterance() resolves (never rejects) null when the Will is stopped mid-wait', async () => {
    const will = await Will.create( { ...base, name: 'Interrupt', identity: { prompt: 'brief' } } )
    const pending = will.nextUtterance( { within: 10_000 } )
    await new Promise( r => setTimeout( r, 100 ) )
    await will.stop()
    await expect( pending ).resolves.toBeNull()
  }, 30_000 )

  it('save() checkpoints the mind without stopping it (non-destructive)', async () => {
    const will = await Will.create( { ...base, name: 'Saver', identity: { prompt: 'I persist.' } } )
    try {
      await new Promise( r => setTimeout( r, 200 ) )
      const t0  = will.state().tick
      const pma = await will.save()
      expect( pma.willName ).toBe('Saver')

      // Still alive after the checkpoint: it keeps ticking and state() resolves.
      await new Promise( r => setTimeout( r, 200 ) )
      expect( will.state().tick ).toBeGreaterThan( t0 )
    }
    finally { await will.stop() }
  }, 30_000 )

  it('on() is chainable across every projection channel without disrupting the tick loop', async () => {
    const will = await Will.create( { ...base, name: 'Obs', identity: { prompt: 'I am observed.' } } )
    try {
      const ret = will
        .on('message',  () => {} )
        .on('effector', () => {} )
        .on('emotion',  () => {} )
        .on('state',    () => {} )
        .on('error',    () => {} )
      expect( ret ).toBe( will )                          // chainable
      await new Promise( r => setTimeout( r, 150 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )    // still ticking
    }
    finally { await will.stop() }
  }, 30_000 )

  it('a rich effector declaration seeds the affordance repertoire with meaning + priors', async () => {
    const will = await Will.create( { ...base, name: 'Rich', identity: { prompt: 'I act.' },
      effectors: {
        forage: {
          handler:       async () => 'ok',
          description:   'Search the area for food',
          cost:          0.35,
          valence:       0.4,
          preconditions: [ { metric: 'energy.level', op: 'gte', value: 15 } ],
        },
        wave: async () => 'ok',   // bare handler — back-compat, flat defaults
      },
    } )
    try {
      const repertoire = ( will.stem.getWillCognition( will.id ) as unknown as { schemaRepertoire: { getSchema( id: string ): any } } ).schemaRepertoire
      const forage = repertoire.getSchema('forage')
      expect( forage ).toMatchObject( { cost: 0.35, baseValence: 0.4, description: 'Search the area for food' } )
      expect( forage.preconditions?.[0] ).toMatchObject( { metric: 'energy.level', op: 'gte', value: 15 } )

      const wave = repertoire.getSchema('wave')
      expect( wave ).toMatchObject( { cost: 0.15, baseValence: 0 } )   // flat defaults
      expect( wave.description ).toBeUndefined()
    }
    finally { await will.stop() }
  }, 30_000 )

  it('a post-create effector() registers its schema into the live repertoire (affordable, not just granted)', async () => {
    const will = await Will.create( { ...base, name: 'Late', identity: { prompt: 'I learn tools.' } } )
    try {
      const repertoire = ( will.stem.getWillCognition( will.id ) as unknown as { schemaRepertoire: { getSchema( id: string ): any } } ).schemaRepertoire
      expect( repertoire.getSchema('forage') ).toBeUndefined()   // not declared at create

      const ret = will.effector('forage', { handler: async () => 'ok', description: 'Search for food', cost: 0.3, binds: 'object' } )
      expect( ret ).toBe( will )                                   // still chainable

      const forage = repertoire.getSchema('forage')
      expect( forage ).toMatchObject( { cost: 0.3, binds: 'object', description: 'Search for food' } )

      // Bare-handler form still works (flat defaults).
      will.effector('wave', async () => 'ok')
      expect( repertoire.getSchema('wave') ).toMatchObject( { cost: 0.15, binds: 'none' } )
    }
    finally { await will.stop() }
  }, 30_000 )

  it('a binds:entity effector reaches the repertoire as an entity-bound schema', async () => {
    const will = await Will.create( { ...base, name: 'Greeter', identity: { prompt: 'I greet.' },
      effectors: { greet: { handler: async () => 'ok', binds: 'entity', description: 'Greet someone by name' } },
    } )
    try {
      const repertoire = ( will.stem.getWillCognition( will.id ) as unknown as { schemaRepertoire: { getSchema( id: string ): any } } ).schemaRepertoire
      expect( repertoire.getSchema('greet') ).toMatchObject( { binds: 'entity', description: 'Greet someone by name' } )
    }
    finally { await will.stop() }
  }, 30_000 )

  it('perceive() is the intake say/tell route through, and does not stall ticking', async () => {
    const will = await Will.create( { ...base, name: 'Ears', identity: { prompt: 'I listen.' } } )
    try {
      await will.perceive( { from: 'ada', speaker: 'Ada', text: 'Hello there.' } )
      await will.say('noted')
      await will.tell('bob', 'Bob', 'and hello from Bob')
      await new Promise( r => setTimeout( r, 150 ) )
      expect( will.state().tick ).toBeGreaterThan( 0 )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

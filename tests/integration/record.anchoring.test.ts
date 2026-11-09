// ─────────────────────────────────────────────────────────────
// tests/integration/record.anchoring.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING steps 1–3, through a real stem and the real SDK: every
// capture site reaches the chain, a decision is chained before its verdict,
// digests are heads of the chain on the simulation tick, a chain continues
// across a wake, anchoring leaves the mind's state byte-identical, and a host
// whose hooks fail never stops the mind.
//
// Each crossing is driven from its real producer, never by calling the tap: a
// seam whose ends are unit-tested and whose crossing is not is how
// `agency.invocation` once reached no host at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WillStem } from '#stem/index'
import { assembleMind, type WillConfig } from '#stem/mind'
import { Will } from '#surface/sdk/will'
import { LoopbackTransport } from '#stem/tracts/transport/loopback.transport'
import { setLogger, resetLogger } from '#core/logger'
import { canonical, GENESIS_HASH, RECORD_CHAIN, verifyChain, type ChainEntry } from '#core/record.chain'
import { clearRecordTap, setRecordTap } from '#core/record.tap'
import { setCompletionRecorder, clearCompletionRecorder, type LLMCompletionRecord } from '#core/completion.recorder'
import { checkAnchoring, type AnchoringOptions, type RecordDigest } from '#stem/tracts/anchor.controller'
import type { PolicyArbiter } from '#stem/policy/arbiter'
import type { SimulationEntity, SimulationState } from '#core/types'

const ENV_OVERRIDES: Record<string, string | undefined> = {
  WILL_SEMANTIC_RECALL:   'false',
  WILL_EMBEDDING_MODEL:   'none',
  WILL_VECTOR_MEMORY:     '',
  WILL_SUMMARY_INTERVAL:  '100000',
  WILL_EMBEDDING_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  WILL_LLM_API_KEY:       undefined,
  ANTHROPIC_API_KEY:      undefined,
}
const _saved: Record<string, string | undefined> = {}
const errors: unknown[] = []

beforeAll( () => {
  setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: ( ...a: unknown[] ) => { errors.push( a ) } } )
  for( const k of Object.keys( ENV_OVERRIDES ) ){
    _saved[ k ] = process.env[ k ]
    const v = ENV_OVERRIDES[ k ]
    if( v === undefined ) delete process.env[ k ]
    else process.env[ k ] = v
  }
})
afterAll( () => {
  resetLogger()
  for( const k of Object.keys( ENV_OVERRIDES ) ){
    const v = _saved[ k ]
    if( v === undefined ) delete process.env[ k ]
    else process.env[ k ] = v
  }
})

/** What a host keeps: every entry and every digest, in the order handed over. */
function host( every = 10, more: Partial<AnchoringOptions> = {} ){
  const entries: ChainEntry[] = []
  const digests: Array<{ digest: RecordDigest; signature?: string }> = []
  const anchoring: AnchoringOptions = {
    every,
    record: e => { entries.push( e ) },
    anchor: ( digest, signature ) => { digests.push( { digest, ...( signature === undefined ? {} : { signature } ) } ) },
    ...more,
  }
  return { entries, digests, anchoring }
}

async function until( cond: () => boolean, ms = 60_000 ): Promise<void> {
  const end = Date.now() + ms
  while( !cond() ){
    if( Date.now() > end ) throw new Error('timed out waiting')
    await new Promise( r => setTimeout( r, 5 ) )
  }
}

function stemConfig( id: string, extra: Partial<WillConfig> = {} ): WillConfig {
  return {
    id, name: 'ActingWill', profile: null,
    identity: { prompt: 'I am a mind with a hand.', values: [ 'curiosity' ], traits: {}, style: 'quiet' },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 11, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
    ...extra,
  }
}

/** A heard message in a named room: what makes this mind reach for `inspect`. */
const heardInGeneral = {
  type: 'senses.audition.percept', version: 1,
  sourceEngine: 'audition-engine', salience: 0.7,
  payload: {
    domain: 'audition', sourceEntityId: 'discord:U1',
    raw: { speakerName: 'Ada', threadId: 'discord:c1', direct: false, threadName: '#general in Mindot' },
  },
}

const deny: PolicyArbiter = { name: 'test', evaluate: () => ( { decision: 'deny', reasonCode: 'NOT_HERE', finality: 'context' } ) }

type Rec = Record<string, unknown>
const rec = ( e: ChainEntry ) => e.record as Rec

describe('record anchoring — a live mind through the stem', () => {
  it('chains every capture site, a decision before its verdict, and digests heads of the chain', async () => {
    const { entries, digests, anchoring } = host( 10 )
    const transport = new LoopbackTransport()
    const stem = new WillStem()
    stem.setArbiter( deny )
    const id = 'anchored'
    await stem.createWill( stemConfig( id, { anchoring, transport, maxTicks: 400 } ) )
    const instance = ( stem as never as { _wills: Map<string, { simulation: { orchestrator: unknown } }> } )._wills.get( id )!
    const bus = ( instance.simulation.orchestrator as { _bus: { publish( e: unknown ): void } } )._bus
    // Driven from the tick listener, on the loop itself: with `tickIntervalMs: 0`
    // the loop never sleeps, so nothing on a timer runs until `maxTicks` pauses it.
    let ticks = 0
    stem.addTickListener( id, () => {
      if( ++ticks % 20 === 5 ) bus.publish( heardInGeneral )
      if( ticks === 3 ) transport.injectInbound( {
        channel: 'inbound_message', kind: 'text', entityId: 'ada', threadId: 't', content: 'hello',
        willId: id, correlationId: 'm1', seq: 1, wallTime: 0,
      } as never )
    } )

    try {
      await until( () => entries.some( e => e.stream === 'verdicts' ) && entries.some( e => e.stream === 'completions' ) )
    }
    finally { await stem.archiveWill( id ) }

    // It begins at genesis, with what the chain is.
    const [ first ] = entries
    expect( first ).toMatchObject( { stream: 'chain', seq: 1, prev: GENESIS_HASH } )
    expect( first!.record ).toEqual( { chain: RECORD_CHAIN, willId: id, seed: 11, startTick: 0 } )

    // Every stream a capture site produces reached it.
    const streams = new Set( entries.map( e => e.stream ) )
    for( const s of [ 'session', 'completions', 'inbound', 'verdicts' ] ) expect( streams, s ).toContain( s )
    expect( rec( entries.find( e => e.stream === 'inbound' )! ).envelope ).toMatchObject( { correlationId: 'm1', content: 'hello' } )

    // It verifies, and its entries are in order.
    expect( verifyChain( entries ) ).toMatchObject( { valid: true, head: { seq: entries.length } } )

    // The decision is chained before the verdict on it.
    const verdict  = entries.find( e => e.stream === 'verdicts' )!
    const intentId = rec( verdict ).intentId
    expect( rec( verdict ) ).toMatchObject( { decision: 'deny', reasonCode: 'NOT_HERE', arbiter: 'test' } )
    const decision = entries.find( e =>
      e.stream === 'session' && rec( e ).evtType === 'agency.invocation' && ( rec( e ).payload as Rec )?.intentId === intentId )
    expect( decision, 'the decision is not in the session log' ).toBeDefined()
    expect( decision!.seq ).toBeLessThan( verdict.seq )

    // Every digest names an entry of the chain, at or after its tick; the
    // first is at the first tick, then every `every`, and the last is the end.
    const bySeq = new Map( entries.map( e => [ e.seq, e ] ) )
    for( const { digest } of digests ){
      const head = bySeq.get( digest.meta.seq )!
      expect( digest.streamHeads.records ).toBe( head.hash )
      expect( digest.meta.chain ).toBe( RECORD_CHAIN )
      expect( digest.willId ).toBe( id )
      expect( head.tick ).toBeLessThanOrEqual( digest.tick )
    }
    const ticksOf = digests.map( d => d.digest.tick )
    expect( ticksOf[ 0 ] ).toBe( 1 )
    for( let i = 1; i < ticksOf.length - 1; i++ ) expect( ticksOf[ i ]! - ticksOf[ i - 1 ]! ).toBe( 10 )
    const last = digests.at( -1 )!.digest
    expect( last.streamHeads.records ).toBe( entries.at( -1 )!.hash )
    expect( rec( entries.at( -1 )! ) ).toMatchObject( { type: 'session.end' } )
  }, 120_000 )

  it('digests are on the simulation tick, not the process-local tick count', async () => {
    const { digests, anchoring } = host( 5 )
    const stem = new WillStem()
    const id = 'axis'
    // A tick interval the loop sleeps out, so this test's timers run between ticks.
    await stem.createWill( stemConfig( id, { anchoring, tickIntervalMs: 20 } ), true )
    const instance = ( stem as never as { _wills: Map<string, { simulation: { clock: { setTick( t: number ): void } }; tickCount: number }> } )._wills.get( id )!
    instance.simulation.clock.setTick( 9_000 )
    stem.resumeWill( id )
    try { await until( () => digests.length >= 2 ) }
    finally { await stem.archiveWill( id ) }
    expect( instance.tickCount ).toBeLessThan( 1_000 )
    expect( digests[ 0 ]!.digest.tick ).toBe( 9_001 )
    expect( digests[ 1 ]!.digest.tick ).toBe( 9_006 )
  }, 60_000 )

  it('a pause seals the session in a digest; resuming continues the same chain', async () => {
    const { entries, digests, anchoring } = host( 1_000 )
    const stem = new WillStem()
    const id = 'paused'
    await stem.createWill( stemConfig( id, { anchoring, tickIntervalMs: 20 } ) )
    try {
      await until( () => digests.length >= 1 && entries.length > 5 )
      const before = digests.length
      stem.pauseWill( id )
      // `anchor` is called off the loop, so the seal arrives a moment later.
      await until( () => digests.length > before )
      const sealed = digests.at( -1 )!.digest
      const head   = entries.find( e => e.seq === sealed.meta.seq )!
      expect( sealed.streamHeads.records ).toBe( head.hash )
      expect( rec( head ) ).toMatchObject( { type: 'session.end' } )
      stem.resumeWill( id )
      await until( () => entries.length > sealed.meta.seq + 3 )
    }
    finally { await stem.archiveWill( id ) }
    expect( entries.filter( e => e.stream === 'chain' ) ).toHaveLength( 1 )
    expect( verifyChain( entries ).valid ).toBe( true )
    /** The resumed session's log reaches the chain too: both places a logger opens share one bridge. */
    expect( entries.some( e => e.stream === 'session' && rec( e ).type === 'session.start' && 'resumedAt' in rec( e ) ) ).toBe( true )
  }, 60_000 )
})

/**
 * A host on the stem itself, as the backend is. The SDK wraps the hooks and
 * checks the options on its own, so only this host leans on the stem's.
 */
describe('record anchoring — a host on the stem', () => {
  const logged = ( text: string ) => errors.some( a => String( ( a as unknown[] )[ 0 ] ).includes( text ) )

  it('refuses options that would anchor nothing before the mind boots', async () => {
    const stem = new WillStem()
    await expect( stem.createWill( stemConfig('refused', { anchoring: { ...host().anchoring, every: 0 } } ) ) ).rejects.toThrow( /every/ )
  })

  it('a record that always throws and an anchor that always fails are logged, and the mind goes on', async () => {
    const stem = new WillStem()
    const id = 'failing-host'
    let anchorCalls = 0
    await stem.createWill( stemConfig( id, { tickIntervalMs: 20, anchoring: {
      every: 2,
      record: () => { throw new Error('disk full') },
      anchor: async () => { anchorCalls++; throw new Error('network down') },
    } } ) )
    let ticks = 0
    stem.addTickListener( id, () => { ticks++ } )
    try { await until( () => ticks > 10 && anchorCalls > 3 ) }
    finally { await stem.archiveWill( id ) }
    await until( () => logged(`anchor() failed for ${id}`) )
    expect( logged(`record() threw for ${id}`) ).toBe( true )
  }, 60_000 )

  /** Taps are process-wide, keyed by id, and outlive the stem that set them. */
  it('an archived Will\'s chain is closed: the same id, re-created without anchoring, reaches none of it', async () => {
    const { entries, anchoring } = host( 5 )
    const stem = new WillStem()
    const id = 'reborn'
    await stem.createWill( stemConfig( id, { anchoring, tickIntervalMs: 20 } ) )
    try { await until( () => entries.length > 3 ) }
    finally { await stem.archiveWill( id ) }
    const closed = entries.length

    const next = new WillStem()
    await next.createWill( stemConfig( id, { tickIntervalMs: 20 } ) )
    let ticks = 0
    next.addTickListener( id, () => { ticks++ } )
    try { await until( () => ticks > 5 ) }
    finally { await next.archiveWill( id ) }
    expect( entries ).toHaveLength( closed )
  }, 60_000 )
})

describe('record anchoring — the SDK', () => {
  const base = { llm: 'mock' as const, anatomy: 'mind' as const, tickMs: 10, seed: 3 }

  it('anchors from the first tick, seals at hibernate, and continues the chain across a wake', async () => {
    const life1 = host( 25 )
    const will = await Will.create( { ...base, name: 'Ana', identity: { prompt: 'I am Ana.' }, anchoring: life1.anchoring } )
    await until( () => life1.digests.length >= 2 )
    const pma = await will.hibernate()
    const end = life1.digests.at( -1 )!.digest
    expect( end.streamHeads.records ).toBe( life1.entries.at( -1 )!.hash )

    const resume = { seq: end.meta.seq, hash: end.streamHeads.records }
    const life2 = host( 25 )
    const woken = await Will.wake( pma, { ...base, name: 'Ana', anchoring: { ...life2.anchoring, resume } } )
    try { await until( () => life2.digests.length >= 1 ) }
    finally { await woken.stop() }

    const [ start ] = life2.entries
    expect( start ).toMatchObject( { stream: 'chain', seq: resume.seq + 1, prev: resume.hash } )
    expect( start!.record ).toMatchObject( { resumed: true, willId: will.id } )
    expect( verifyChain( [ ...life1.entries, ...life2.entries ] ).valid ).toBe( true )
    expect( verifyChain( life2.entries, resume ).valid ).toBe( true )
  }, 60_000 )

  it('signs canonical(digest) with the host\'s function; the engine holds no key', async () => {
    const signed: string[] = []
    const h = host( 1_000, { sign: material => { signed.push( material ); return `sig(${material.length})` } } )
    const will = await Will.create( { ...base, name: 'Sig', identity: { prompt: 'I sign.' }, anchoring: h.anchoring } )
    try { await until( () => h.digests.length >= 1 ) }
    finally { await will.stop() }
    const [ first ] = h.digests
    expect( signed[ 0 ] ).toBe( canonical( first!.digest ) )
    expect( first!.signature ).toBe(`sig(${signed[ 0 ]!.length})`)
  }, 30_000 )

  it('a host whose hooks fail is told on `error`, and the mind and later digests go on', async () => {
    let anchorCalls = 0
    let recordCalls = 0
    const kept: RecordDigest[] = []
    const reported: Error[] = []
    const will = await Will.create( { ...base, name: 'Err', identity: { prompt: 'I go on.' }, anchoring: {
      every: 5,
      record: () => { if( ++recordCalls === 2 ) throw new Error('disk full') },
      anchor: async d => { if( ++anchorCalls === 1 ) throw new Error('network down'); kept.push( d ) },
    } } )
    will.on('error', ( e: Error ) => { reported.push( e ) } )
    try { await until( () => kept.length >= 2 ) }
    finally { await will.stop() }
    expect( reported.map( e => e.message ) ).toEqual( expect.arrayContaining( [
      expect.stringMatching( /anchoring\.anchor failed: network down/ ),
    ] ) )
    expect( will.state().tick ).toBeGreaterThan( 10 )
    /** The entry that failed to persist did not stop the ones after it. */
    expect( recordCalls ).toBeGreaterThan( 2 )
  }, 30_000 )

  it('options that would anchor nothing, or nothing verifiable, are refused before the mind boots', async () => {
    const ok = host().anchoring
    const bad: Array<[ Partial<AnchoringOptions>, RegExp ]> = [
      [ { every: 0 }, /every is a positive whole number/ ],
      [ { every: 1.5 }, /every is a positive whole number/ ],
      [ { record: undefined as never }, /record persists every entry/ ],
      [ { anchor: undefined as never }, /anchor publishes the digests/ ],
      [ { sign: 'key' as never }, /sign is a function/ ],
      [ { resume: { seq: -1, hash: GENESIS_HASH } }, /resume is the head/ ],
      [ { resume: { seq: 3, hash: 'not-a-hash' } }, /resume is the head/ ],
    ]
    for( const [ o, why ] of bad ) expect( () => checkAnchoring( { ...ok, ...o } ) ).toThrow( why )
    await expect( Will.create( { ...base, name: 'No', identity: { prompt: 'x' }, anchoring: { ...ok, every: 0 } } ) ).rejects.toThrow( /every/ )
    /** The SDK checks before it wraps: a wrapped `record` is always a function. */
    await expect( Will.create( { ...base, name: 'No', identity: { prompt: 'x' }, anchoring: { ...ok, record: undefined as never } } ) ).rejects.toThrow( /record persists/ )
  })
})

describe('record anchoring — off the mind\'s path', () => {
  /** Drop the lone wall-clock provenance field, as replay.equivalence does. */
  const comparable = ( s: SimulationState ) => ( {
    tick: s.tick,
    metrics: [ ...s.metrics.entries() ],
    entities: [ ...s.entities.values() ].map( ( { createdAt: _c, ...rest }: SimulationEntity ) => rest ),
  } )
  const config = ( id: string ): WillConfig => stemConfig( id, { executiveInterval: 5, clock: { fixedDeltaMs: 50, startTime: 0 } } )

  async function run( id: string, tapped: boolean ){
    const { simulation } = assembleMind( id, config( id ) )
    const seen: string[] = []
    if( tapped ) setRecordTap( id, stream => { seen.push( stream ) } )
    try { for( let i = 0; i < 40; i++ ) await simulation.step( 1 ) }
    finally { clearRecordTap( id ) }
    return { state: comparable( simulation.stateManager.snapshot() ), seen }
  }

  it('a tapped mind reaches exactly the state an untapped one does', async () => {
    const plain  = await run('same-mind', false )
    const tapped = await run('same-mind', true )
    expect( tapped.seen ).toContain('completions')
    expect( JSON.stringify( tapped.state ) ).toBe( JSON.stringify( plain.state ) )
  }, 60_000 )

  it('a replay recording and the record chain each receive every completion', async () => {
    const id = 'both-sinks'
    const { simulation } = assembleMind( id, config( id ) )
    const recorded: LLMCompletionRecord[] = []
    const chained: unknown[] = []
    setCompletionRecorder( id, { recordCompletion: r => { recorded.push( r ) } } )
    setRecordTap( id, ( stream, r ) => { if( stream === 'completions' ) chained.push( r ) } )
    try { for( let i = 0; i < 40; i++ ) await simulation.step( 1 ) }
    finally { clearCompletionRecorder( id ); clearRecordTap( id ) }
    expect( recorded.length ).toBeGreaterThan( 0 )
    expect( chained ).toEqual( recorded )
  }, 60_000 )
})

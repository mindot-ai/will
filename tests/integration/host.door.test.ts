// ─────────────────────────────────────────────────────────────
// tests/integration/host.door.test.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING step 4b: every input a host hands the stem directly reaches
// the mind through the transport's door — enqueued, applied at the next tick,
// recorded and chained there, on the simulation tick. Driven one tick at a time
// (`manual`), so each test can show an input waiting for its tick.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WillStem } from '#stem/index'
import type { WillConfig } from '#stem/mind'
import { setLogger, resetLogger } from '#core/logger'
import type { ChainEntry } from '#core/record.chain'
import type { PolicyArbiter, Verdict } from '#stem/policy/arbiter'

const warnings: string[] = []
beforeAll( () => {
  process.env.WILL_SEMANTIC_RECALL = 'false'
  setLogger( { debug: () => {}, info: () => {}, warn: ( m: unknown ) => { warnings.push( String( m ) ) }, error: () => {} } )
})
afterAll( () => { resetLogger(); delete process.env.WILL_SEMANTIC_RECALL } )

const sleep = ( ms: number ) => new Promise<void>( r => setTimeout( r, ms ) )
type Rec = Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

async function manualWill( id: string, extra: Partial<WillConfig> = {} ){
  const entries: ChainEntry[] = []
  const stem = new WillStem()
  await stem.createWill( {
    id, name: 'Door', profile: null,
    identity: { prompt: 'I am a mind with one door.', values: [], traits: {}, style: 'plain' },
    anatomy: 'mind', persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 10,
    randomSeed: 3, testMode: true, stopTimeoutMs: 300,
    clock: { fixedDeltaMs: 1000, startTime: 0, startTick: 500 },
    anchoring: { every: 1_000, record: e => { entries.push( e ) }, anchor: () => {} },
    ...extra,
  }, false, { manual: true } )
  const instance = ( stem as never as { _wills: Map<string, Rec> } )._wills.get( id )!
  const inbound = () => entries.filter( e => e.stream === 'inbound').map( e => e.record as Rec )
  return { stem, instance, entries, inbound }
}

describe('host inputs come through the door', () => {
  it('a sense waits for the next tick, is chained there on the simulation tick, and resolves when its turn does', async () => {
    const { stem, instance, inbound } = await manualWill('door-sense')
    const sensed: unknown[] = []
    const audition = instance.cognition.auditionEngine
    const real = audition.sense.bind( audition )
    let finish!: () => void
    audition.sense = ( input: unknown ) => { sensed.push( input ); return real( input ).then( () => new Promise<void>( r => { finish = r } ) ) }

    let resolved = false
    const said = stem.senseText('door-sense', { kind: 'text', entityId: 'ada', threadId: 'ada', content: 'hello', provenance: 'exafferent' } )
      .then( () => { resolved = true } )
    await sleep( 30 )
    expect( sensed ).toEqual( [] )
    expect( inbound() ).toEqual( [] )

    await stem.runTick('door-sense')
    expect( sensed ).toHaveLength( 1 )
    const [ r ] = inbound()
    expect( r ).toMatchObject( { tick: 500, envelope: { channel: 'sense', domain: 'audition', input: { content: 'hello' } } } )
    await sleep( 30 )
    expect( resolved, 'resolved before the sense finished' ).toBe( false )
    finish()
    await said
    expect( resolved ).toBe( true )
    await stem.archiveWill('door-sense')
  }, 30_000 )

  it('an effector ack keeps its observation; a delivery ack, an event and an escalation answer are each chained', async () => {
    const { stem, instance, inbound } = await manualWill('door-acks')
    stem.confirmEffectorExecution('door-acks', 'intent-1', { success: true, description: 'looked', observation: { found: 2 } } )
    stem.confirmMessageDelivery('door-acks', 'msg-1', false )
    stem.injectEvent('door-acks', { type: 'world.door', payload: { open: true } } )
    stem.resolveEscalation('door-acks', 'intent-2', false, 'class')
    const event = () => [ ...instance.simulation.stateManager.snapshot().entities.values() ].find( ( e: Rec ) => e.type === 'world.door')
    expect( event() ).toBeUndefined()

    await stem.runTick('door-acks')
    expect( inbound().map( r => r.envelope ) ).toMatchObject( [
      { channel: 'ack', ackKind: 'result', correlationId: 'intent-1', result: { success: true, observation: { found: 2 } } },
      { channel: 'ack', ackKind: 'delivery', correlationId: 'msg-1', delivered: false },
      { channel: 'event', type: 'world.door', payload: { open: true } },
      { channel: 'escalation', intentId: 'intent-2', approved: false, finality: 'class' },
    ] )
    expect( event() ).toMatchObject( { metadata: { open: true } } )
    await stem.archiveWill('door-acks')
  }, 30_000 )

  it('an unknown sense is refused at the door; a sense to a stopped Will, or still queued when it stops, resolves', async () => {
    const { stem } = await manualWill('door-stop')
    await expect( stem.senseSignal('door-stop', 'telepathy', { kind: 'text' } as never ) ).rejects.toThrow('Unknown sense domain: telepathy')
    const queued = stem.senseText('door-stop', { kind: 'text', entityId: 'a', threadId: 'a', content: 'x', provenance: 'exafferent' } )
    await stem.archiveWill('door-stop')
    await queued
    await stem.senseText('door-stop', { kind: 'text', entityId: 'a', threadId: 'a', content: 'y', provenance: 'exafferent' } )
  }, 30_000 )

  it('waking after a pause is sensed through the door, with how long it was away', async () => {
    const { stem, inbound } = await manualWill('door-wake')
    await stem.runTick('door-wake')
    stem.pauseWill('door-wake')
    await sleep( 20 )
    stem.resumeWill('door-wake')
    await stem.runTick('door-wake')
    const wake = inbound().find( r => r.envelope.domain === 'somatosensation')
    expect( wake?.envelope ).toMatchObject( { channel: 'sense', input: { kind: 'system', signal: 'WAKE', provenance: 'exafferent' } } )
    expect( wake!.envelope.input.data.offlineMs ).toBeGreaterThanOrEqual( 15 )
    await stem.archiveWill('door-wake')
  }, 30_000 )

  it('runTick drives only a manual Will that is not archived; the loop never ticks one', async () => {
    const { stem, entries } = await manualWill('door-manual')
    await sleep( 80 )
    expect( entries.filter( e => e.stream === 'clock') ).toHaveLength( 0 )
    await stem.runTick('door-manual')
    expect( entries.filter( e => e.stream === 'clock') ).toHaveLength( 1 )
    await stem.archiveWill('door-manual')
    await expect( stem.runTick('door-manual') ).rejects.toThrow( /archived/ )

    const looped = new WillStem()
    await looped.createWill( { id: 'looped', name: 'L', profile: null, identity: { prompt: 'I loop.', values: [], traits: {}, style: '' },
      persistentMemory: false, snapshotInterval: 999_999, testMode: true } as WillConfig, true )
    await expect( looped.runTick('looped') ).rejects.toThrow( /its own loop/ )
    await looped.archiveWill('looped')
  }, 30_000 )
})

describe('a verdict an async arbiter still owes', () => {
  const lateBy = ( ms: number ): PolicyArbiter => ( {
    name: 'late', evaluate: () => new Promise<Verdict>( r => setTimeout( () => r( { decision: 'allow' } ), ms ) ),
  } )
  const ask = ( stem: WillStem, instance: Rec, intentId: string ) =>
    ( stem as never as { _effector: { bufferInvocation( i: unknown, p: unknown ): void } } )._effector
      .bufferInvocation( instance, { intentId, schema: 'inspect', parameters: {}, tick: 501 } )

  it('lands before the session ends when it comes while the Will is stopping', async () => {
    const { stem, instance, entries } = await manualWill('verdict-soon')
    stem.setArbiter( lateBy( 120 ) )
    ask( stem, instance, 'i-soon')
    await stem.archiveWill('verdict-soon')
    const verdict = entries.find( e => e.stream === 'verdicts')
    const end     = entries.find( e => ( e.record as Rec ).type === 'session.end')!
    expect( verdict, 'archive did not wait for the verdict').toBeDefined()
    expect( verdict!.seq ).toBeLessThan( end.seq )
  }, 30_000 )

  it('is given up, never applied or chained, when it comes after', async () => {
    const { stem, instance, entries } = await manualWill('verdict-late')
    stem.setArbiter( lateBy( 700 ) )
    ask( stem, instance, 'i-late')
    await stem.archiveWill('verdict-late')
    const ended = entries.length
    await sleep( 800 )
    expect( entries.length ).toBe( ended )
    expect( entries.some( e => e.stream === 'verdicts') ).toBe( false )
    expect( warnings.some( w => w.includes('arrived after verdict-late stopped') ) ).toBe( true )
  }, 30_000 )
})

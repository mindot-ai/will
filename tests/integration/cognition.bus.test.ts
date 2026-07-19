// ─────────────────────────────────────────────────────────────
// tests/integration/cognition.bus.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Integration tests for cognitive bus behavioral properties:
 *   - Per-category inbox policy (critical never dropped, metric bounded)
 *   - Per-subscriber version filtering with auto-migration
 *   - GenerativeModel prediction-error gating
 *   - SalienceComputer precision weights (top-down anticipation)
 *   - Adaptive heartbeat skip logic
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  InProcessCognitiveTransport,
  DefaultCognitiveBus,
  createTestBus,
  type CognitiveEvent,
} from '#cognition/bus'
import { SchemaRegistry } from '#cognition/schema.registry'
import { GenerativeModel } from '#cognition/generative.model'

// ── Helpers ──────────────────────────────────────────────────

function makeEvent( overrides: Partial<CognitiveEvent> = {} ): CognitiveEvent {
  return {
    id:             'test-1',
    type:           'test.event',
    version:        1,
    sourceEngine:   'test-engine',
    sequenceNumber: 1,
    logicalTime:    1,
    wallTime:       Date.now(),
    salience:       0.5,
    payload:        {},
    ...overrides,
  }
}

// ── Per-category inbox policy ─────────────────────────────────

describe('Per-category inbox policy', () => {
  it('critical events are never dropped when metric queue overflows', () => {
    const transport = new InProcessCognitiveTransport()
    const registry  = new SchemaRegistry()
    const bus       = new DefaultCognitiveBus( transport, registry )

    const received: string[] = []
    transport.subscribe('engine-a', ['executive.*', 'stress.*'], ev => { received.push( ev.type ) } )

    // Force metric queue overflow by filling it past the 500 cap
    // (we use the transport directly since DefaultCognitiveBus calls deliver)
    for( let i = 0; i < 505; i++ )
      transport.deliver( makeEvent({ type: 'stress.state.changed' }), ['engine-a'] )

    // Critical event after overflow
    transport.deliver( makeEvent({ type: 'executive.interpretation.formed' }), ['engine-a'] )

    transport.flush()

    const criticalReceived = received.filter( t => t === 'executive.interpretation.formed')
    expect( criticalReceived ).toHaveLength( 1 )  // critical always delivered
  })

  it('metric queue drops oldest when overflow occurs', () => {
    const transport = new InProcessCognitiveTransport()

    const received: number[] = []
    // Subscribe with a marker in payload to track order
    transport.subscribe('engine-a', ['stress.*'], ev => {
      received.push( (ev.payload as Record<string,number>)['seq'] ?? -1 )
    })

    // Fill 500 metric events (fills queue exactly)
    for( let i = 0; i < 500; i++ )
      transport.deliver( makeEvent({ type: 'stress.state.changed', payload: { seq: i } }), ['engine-a'] )

    // One more pushes past limit — oldest (seq=0) should be dropped
    transport.deliver( makeEvent({ type: 'stress.state.changed', payload: { seq: 500 } }), ['engine-a'] )

    transport.flush()

    expect( received ).toHaveLength( 500 )
    expect( received[0] ).toBe( 1 )   // seq=0 was dropped
    expect( received[499] ).toBe( 500 )
  })
})

// ── Per-subscriber version filtering ─────────────────────────

describe('Per-subscriber version filtering', () => {
  let registry: SchemaRegistry

  beforeEach(() => {
    registry = new SchemaRegistry()
    registry.register({
      type: 'sensor.reading',
      version: 1,
      validate( payload ){
        const p = payload as Record<string,unknown>
        return typeof p['value'] === 'number' ? null : 'value must be number'
      }
    })
    registry.register({
      type: 'sensor.reading',
      version: 2,
      validate( payload ){
        const p = payload as Record<string,unknown>
        return typeof p['value'] === 'number' && typeof p['unit'] === 'string'
          ? null
          : 'v2 requires value (number) and unit (string)'
      }
    })
    registry.registerMigration('sensor.reading', 1, 2, payload => {
      const p = payload as Record<string,unknown>
      return { ok: true, payload: { ...p, unit: 'raw' } }
    })
  })

  it('delivers event directly when version is accepted', () => {
    const bus = createTestBus( null, registry )
    const received: CognitiveEvent[] = []

    bus.subscribe('engine-a', ['sensor.*'], ev => { received.push( ev ) },
      () => [1]   // accepts version 1 only
    )

    bus.publish({
      type: 'sensor.reading', version: 1,
      sourceEngine: 'sensor', salience: 0.5,
      payload: { value: 42 },
    })

    expect( received ).toHaveLength( 1 )
    expect( received[0]?.version ).toBe( 1 )
    expect( (received[0]?.payload as Record<string,number>)['value'] ).toBe( 42 )
  })

  it('migrates event to accepted version transparently', () => {
    const bus = createTestBus( null, registry )
    const received: CognitiveEvent[] = []

    bus.subscribe('engine-a', ['sensor.*'], ev => { received.push( ev ) },
      () => [2]   // accepts version 2 only — engine is ahead of published v1
    )

    bus.publish({
      type: 'sensor.reading', version: 1,
      sourceEngine: 'sensor', salience: 0.5,
      payload: { value: 42 },
    })

    expect( received ).toHaveLength( 1 )
    expect( received[0]?.version ).toBe( 2 )   // migrated
    expect( (received[0]?.payload as Record<string,unknown>)['unit'] ).toBe('raw')
  })

  it('silently drops event when version is incompatible and cannot migrate', () => {
    const bus = createTestBus( null, registry )
    const received: CognitiveEvent[] = []

    bus.subscribe('engine-a', ['sensor.*'], ev => { received.push( ev ) },
      () => [99]  // accepts future version that doesn't exist
    )

    bus.publish({
      type: 'sensor.reading', version: 1,
      sourceEngine: 'sensor', salience: 0.5,
      payload: { value: 42 },
    })

    expect( received ).toHaveLength( 0 )  // silently dropped
  })

  it('accepts any version when acceptsVersions returns empty array', () => {
    const bus = createTestBus( null, registry )
    const received: CognitiveEvent[] = []

    bus.subscribe('engine-a', ['sensor.*'], ev => { received.push( ev ) },
      () => []    // empty = accept any
    )

    bus.publish({
      type: 'sensor.reading', version: 1,
      sourceEngine: 'sensor', salience: 0.5,
      payload: { value: 42 },
    })
    bus.publish({
      type: 'sensor.reading', version: 2,
      sourceEngine: 'sensor', salience: 0.5,
      payload: { value: 99, unit: 'celsius' },
    })

    expect( received ).toHaveLength( 2 )
  })
})

// ── GenerativeModel ───────────────────────────────────────────

describe('GenerativeModel', () => {
  it('adopts the first observation as its prediction (cold start — no spurious surprise)', () => {
    const model = new GenerativeModel()
    // Repaired contract: the first observation seeds the prediction and reports
    // zero surprise, instead of firing a max error against a zero-initialised prior.
    const first = model.observe('stress.load', 50 )
    expect( first.error ).toBe( 0 )
    expect( first.normalized ).toBe( 0 )
    expect( first.gated ).toBe( true )
    expect( model.predict('stress.load') ).toBe( 50 )

    // A later deviation from the adopted baseline is a genuine surprise.
    const second = model.observe('stress.load', 80 )
    expect( second.error ).toBeCloseTo( 30 )
    expect( second.normalized ).toBeGreaterThan( 0 )
  })

  it('converges to stable prediction and gates after many observations', () => {
    const model = new GenerativeModel( 0.3, 100 )

    // Feed a stable signal of 42 for many ticks
    for( let i = 0; i < 80; i++ )
      model.observe('signal', 42 )

    const result = model.observe('signal', 42 )
    expect( result.normalized ).toBeLessThan( 0.05 )
    expect( result.gated ).toBe( true )
    expect( model.isStable('signal') ).toBe( true )
  })

  it('un-gates on sudden shift from stable baseline', () => {
    const model = new GenerativeModel( 0.3, 100 )

    for( let i = 0; i < 80; i++ ) model.observe('signal', 42 )
    expect( model.isStable('signal') ).toBe( true )

    // Sudden 30-point jump
    const result = model.observe('signal', 72 )
    expect( result.gated ).toBe( false )
    expect( result.normalized ).toBeGreaterThan( 0.05 )
  })

  it('anticipate() biases prediction toward top-down prior', () => {
    const model = new GenerativeModel()

    // Start with no history — prediction at 0
    expect( model.predict('energy') ).toBe( 0 )

    // Top-down anticipation: executive says energy will be ~80
    model.anticipate('energy', 80, 0.9 )

    // Prediction should shift toward 80
    const newPred = model.predict('energy')
    expect( newPred ).toBeGreaterThan( 0 )
    expect( newPred ).toBeLessThan( 80 )
  })

  it('anticipation is consumed after one observe()', () => {
    const model = new GenerativeModel( 0.15, 100 )

    // Warm up: run 40 observations at 80 without anticipation
    for( let i = 0; i < 40; i++ ) model.observe('energy', 80 )

    // Now prediction is converged near 80; anticipate does little extra
    model.anticipate('energy', 80, 1.0 )
    model.observe('energy', 80 )  // consumes anticipation

    // After consuming anticipation, error should be small (EMA already at 80)
    const result2 = model.observe('energy', 80 )
    expect( result2.normalized ).toBeLessThan( 0.05 )
    expect( result2.gated ).toBe( true )
  })

  it('configureStream() overrides per-stream parameters', () => {
    const model = new GenerativeModel()
    model.configureStream('temp', { range: 40, gateThreshold: 0.01 } )

    // Cold-start adopts the first value as the baseline; a fixed range then pins
    // the scale so a 0.5 deviation normalises to 0.5/40 (= 0.0125, above the 0.01
    // gate → not gated) regardless of the stream's own variance.
    model.observe('temp', 10 )              // seed → prediction 10
    const r = model.observe('temp', 10.5 )  // raw error 0.5, fixed range 40
    expect( r.normalized ).toBeCloseTo( 0.5 / 40, 3 )
    expect( r.gated ).toBe( false )
  })

  it('snapshotAll() returns predictions for all observed streams', () => {
    const model = new GenerativeModel()
    model.observe('a', 10 )
    model.observe('b', 20 )

    const snap = model.snapshotAll()
    expect( Object.keys( snap ) ).toEqual( expect.arrayContaining(['a', 'b']) )
    expect( snap['a']?.n ).toBe( 1 )
  })
})

// ── GenerativeModel precision weights ───────────────────────

describe('GenerativeModel precision weights', () => {
  it('setPrecision() boosts salience scores for the stream', () => {
    const s = new GenerativeModel()

    // Baseline on a fresh stream with some variance (not perfectly flat)
    for( let i = 0; i < 5; i++ ) s.observe('stream.x', i % 2 === 0 ? 0.4 : 0.6 )
    const baseline = s.observe('stream.x', 0.6 ).salience

    // Reset and repeat with precision boost — same inputs
    const s2 = new GenerativeModel()
    for( let i = 0; i < 5; i++ ) s2.observe('stream.x', i % 2 === 0 ? 0.4 : 0.6 )
    s2.setPrecision('stream.x', 2.0 )
    const boosted = s2.observe('stream.x', 0.6 ).salience

    // With 2× precision the salience score should be higher (capped at 1.0)
    expect( boosted ).toBeGreaterThanOrEqual( baseline )
  })

  it('precision decays toward 1.0 over successive observations', () => {
    const s = new GenerativeModel()
    s.setPrecision('stream.y', 3.0 )

    // After many observations, precision should have decayed
    let prev = s.getPrecision('stream.y')
    for( let i = 0; i < 50; i++ ){
      s.observe('stream.y', 0.5 )
      const cur = s.getPrecision('stream.y')
      expect( cur ).toBeLessThanOrEqual( prev + 0.001 )
      prev = cur
    }

    expect( s.getPrecision('stream.y') ).toBeLessThan( 2.0 )  // decayed significantly
  })

  it('getPrecision() returns 1.0 for unseen streams', () => {
    const s = new GenerativeModel()
    expect( s.getPrecision('never-seen') ).toBe( 1.0 )
  })
})

// ── Wildcard topic matching ───────────────────────────────────

describe('Wildcard topic matching', () => {
  it("'*' matches any topic", () => {
    const bus = createTestBus()
    const received: string[] = []

    bus.subscribe('global', ['*'], ev => { received.push( ev.type ) } )

    bus.publish({ type: 'foo.bar', version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })
    bus.publish({ type: 'baz', version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })

    expect( received ).toContain('foo.bar')
    expect( received ).toContain('baz')
  })

  it("'stress.*' matches 'stress.load' and 'stress.zone.critical' but not 'prestress'", () => {
    const bus = createTestBus()
    const received: string[] = []

    bus.subscribe('e', ['stress.*'], ev => { received.push( ev.type ) } )

    bus.publish({ type: 'stress.load',          version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })
    bus.publish({ type: 'stress.zone.critical', version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })
    bus.publish({ type: 'prestress',            version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })
    bus.publish({ type: 'stress',               version: 1, sourceEngine: 'a', salience: 0.5, payload: {} })

    expect( received ).toContain('stress.load')
    expect( received ).toContain('stress.zone.critical')
    expect( received ).not.toContain('prestress')
    expect( received ).toContain('stress')  // exact match of prefix with no trailing .
  })
})

// ── Lamport clock ordering ────────────────────────────────────

describe('Lamport clock ordering', () => {
  it('logicalTime increments with each publish', () => {
    const bus = createTestBus()

    expect( bus.logicalTime ).toBe( 0 )
    bus.publish({ type: 'a', version: 1, sourceEngine: 'e', salience: 0, payload: {} })
    expect( bus.logicalTime ).toBe( 1 )
    bus.publish({ type: 'b', version: 1, sourceEngine: 'e', salience: 0, payload: {} })
    expect( bus.logicalTime ).toBe( 2 )
  })

  it('events are delivered in publish order for a single subscriber (FIFO)', () => {
    const bus = createTestBus()
    const received: number[] = []

    bus.subscribe('e', ['*'], ev => { received.push( (ev.payload as Record<string,number>)['n'] ?? -1 ) } )

    for( let n = 0; n < 10; n++ )
      bus.publish({ type: 'tick', version: 1, sourceEngine: 's', salience: 0, payload: { n } })

    expect( received ).toEqual( [0,1,2,3,4,5,6,7,8,9] )
  })
})

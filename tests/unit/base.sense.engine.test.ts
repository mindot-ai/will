// ─────────────────────────────────────────────────────────────
// tests/unit/base.sense.engine.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §6 — BaseSenseEngine: the shared perceptual pipeline.
 *
 * Proves a *new* sense engine reuses the base flow with ~no orchestration code
 * (just `name`, `domain`, `acceptedKinds`, optional `gateEffector`, `_perceive`),
 * and that the base correctly applies:
 *   - the effector gate (gateEffector + effectorRegistry)
 *   - the kind filter (acceptedKinds)
 *   - the percept publish chokepoint (publishPercept → senses.<domain>.percept)
 *   - the CognitiveEngine boilerplate defaults (publishes/subscribes/snapshot)
 * and that ShellSenseEngine advertises shell status + warns only for accepted kinds.
 */

import { describe, it, expect, vi } from 'vitest'
import { BaseSenseEngine, ShellSenseEngine } from '#senses/base.sense.engine'
import { provenanceOf } from '#senses/index'
import type { SensoryInput, Percept } from '#senses/index'

// ── A minimal concrete sense engine — the whole point of §6 ────
class TestSense extends BaseSenseEngine {
  readonly name   = 'test-sense'
  readonly domain = 'vision' as const           // reuse an existing SenseDomain literal
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'image' ] )
  protected readonly gateEffector   = 'see'

  perceived: SensoryInput[] = []
  protected async _perceive( input: SensoryInput ): Promise<void> {
    this.perceived.push( input )
    this.publishPercept( {
      domain:         this.domain,
      sourceEntityId: ( input as any ).entityId ?? 'x',
      timestamp:      0,
      salience:       0.42,
      raw:            input,
    }, input )
  }
}

class TestShell extends ShellSenseEngine {
  readonly name   = 'test-shell'
  readonly domain = 'olfaction' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'ambient' ] )
}

const IMAGE: SensoryInput = { kind: 'image', entityId: 'e1', data: Buffer.from(''), mimeType: 'image/png' }
const TEXT:  SensoryInput = { kind: 'text', entityId: 'e1', threadId: 't1', content: 'hi' }

function busSpy(){
  const events: any[] = []
  return { bus: { publish: ( e: any ) => events.push( e ) } as any, events }
}

describe('BaseSenseEngine — shared pipeline (§6)', () => {
  it('publishes() / subscribes() / snapshot() come from the base by default', () => {
    const e = new TestSense()
    expect( e.publishes() ).toEqual( [ { type: 'senses.vision.percept', version: 1, validate: expect.any( Function ) } ] )
    expect( e.subscribes() ).toEqual( [] )
    expect( e.snapshot() ).toEqual( { domain: 'vision' } )
  } )

  it('_perceive runs for an accepted kind and publishPercept emits on senses.<domain>.percept', async () => {
    const e = new TestSense()
    const { bus, events } = busSpy()
    e.attachBus( bus )

    await e.ingest( IMAGE )

    expect( e.perceived ).toHaveLength( 1 )
    expect( events ).toHaveLength( 1 )
    expect( events[0] ).toMatchObject( {
      type:         'senses.vision.percept',
      version:      1,
      sourceEngine: 'test-sense',
      salience:     0.42,
    } )
    expect( events[0].payload.raw ).toBe( IMAGE )
  } )

  it('ignores a non-accepted kind silently (no _perceive, no publish)', async () => {
    const e = new TestSense()
    const { bus, events } = busSpy()
    e.attachBus( bus )

    await e.ingest( TEXT )

    expect( e.perceived ).toHaveLength( 0 )
    expect( events ).toHaveLength( 0 )
  } )

  it('gateEffector blocks ingestion when the effectorRegistry denies it', async () => {
    const e = new TestSense()
    e.attachGrants( { isAllowed: () => false } as any )

    await e.ingest( IMAGE )

    expect( e.perceived ).toHaveLength( 0 )
  } )

  it('gateEffector allows ingestion when the effectorRegistry permits it', async () => {
    const e = new TestSense()
    e.attachGrants( { isAllowed: ( a: string ) => a === 'see' } as any )

    await e.ingest( IMAGE )

    expect( e.perceived ).toHaveLength( 1 )
  } )

  it('with no effectorRegistry attached the gate is skipped (engine active)', async () => {
    const e = new TestSense()
    await e.ingest( IMAGE )
    expect( e.perceived ).toHaveLength( 1 )
  } )
} )

// ── Provenance stamping (SIGNAL_BOUNDARY P0a) ──────────────────
//
// The emit chokepoint is where a signal stops being the host's and becomes the
// mind's, so it is the one place that can guarantee every percept says whose
// doing it was. These pin the guarantee AND its direction: a host that says
// nothing must land on 'exafferent', never 'reafferent' — a percept wrongly
// marked as mine is attenuated and can never rupture a commitment, so the
// silent default has to be the one that errs toward noticing.
describe('BaseSenseEngine — provenance stamping (P0a)', () => {
  async function stampOf( input: SensoryInput ){
    const e = new TestSense()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await e.ingest( input )
    return events[0].payload as Percept
  }

  it('an unstamped signal is exafferent — the world did it, not me', async () => {
    expect( ( await stampOf( IMAGE ) ).provenance ).toBe('exafferent')
  } )

  it("never silently defaults to 'reafferent'", async () => {
    // The failure that matters: a mind that mislabels the world as its own doing
    // goes quiet about real events. Stated separately from the positive
    // assertion above so a future default change trips a test that NAMES the risk.
    expect( ( await stampOf( IMAGE ) ).provenance ).not.toBe('reafferent')
  } )

  it("carries an asserted 'reafferent' stamp and its sourceIntentId across transduction", async () => {
    const p = await stampOf( { ...IMAGE, provenance: 'reafferent', sourceIntentId: 'intent-77' } )
    expect( p.provenance ).toBe('reafferent')
    expect( p.sourceIntentId ).toBe('intent-77')
  } )

  it("carries an asserted 'unknown' — a host that cannot tell says so out loud", async () => {
    expect( ( await stampOf( { ...IMAGE, provenance: 'unknown' } ) ).provenance ).toBe('unknown')
  } )

  it('omits sourceIntentId entirely when the host supplied none (absent, not undefined)', async () => {
    const p = await stampOf( IMAGE )
    expect('sourceIntentId' in p ).toBe( false )
  } )

  it('the stamp overrides whatever the sense engine put on the percept itself', async () => {
    // A sense engine must not be able to launder provenance: the host's assertion
    // is the only authority, so publishPercept() stamps last.
    class Liar extends TestSense {
      protected async _perceive( input: SensoryInput ): Promise<void> {
        this.publishPercept( {
          domain: this.domain, sourceEntityId: 'x', timestamp: 0, salience: 0.1,
          raw: input, provenance: 'reafferent', sourceIntentId: 'fabricated',
        }, input )
      }
    }
    const e = new Liar()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await e.ingest( IMAGE )

    expect( events[0].payload.provenance ).toBe('exafferent')
    expect( events[0].payload.sourceIntentId ).toBeUndefined()
  } )

  it('provenanceOf is the single place the default lives', () => {
    expect( provenanceOf( {} ) ).toBe('exafferent')
    expect( provenanceOf( { provenance: 'reafferent' } ) ).toBe('reafferent')
    expect( provenanceOf( { provenance: 'unknown' } ) ).toBe('unknown')
  } )
} )

describe('ShellSenseEngine — stub contract (§6)', () => {
  it('snapshot() advertises shell status', () => {
    expect( new TestShell().snapshot() ).toEqual( { domain: 'olfaction', status: 'shell' } )
  } )

  it('warns for an accepted kind but never throws', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( new TestShell().ingest( { kind: 'ambient', metricKey: 'cpu', value: 1, trend: 'rising' } ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining('test-shell') )
    warn.mockRestore()
  } )

  it('is silent (no warning) for a non-accepted kind', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await new TestShell().ingest( TEXT )
    expect( warn ).not.toHaveBeenCalled()
    warn.mockRestore()
  } )
} )

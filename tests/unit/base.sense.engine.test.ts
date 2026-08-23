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
import { asProvenance } from '#senses/index'
import type { SensoryInput, Percept, Transduced } from '#senses/index'

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
      summary:        'a test sense sensed something',
      raw:            input,
    }, input )
  }
}

class TestShell extends ShellSenseEngine {
  readonly name   = 'test-shell'
  readonly domain = 'olfaction' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'ambient' ] )
}

const IMAGE: SensoryInput = { kind: 'image', entityId: 'e1', data: Buffer.from(''), mimeType: 'image/png', provenance: 'exafferent' }
const TEXT:  SensoryInput = { kind: 'text', entityId: 'e1', threadId: 't1', content: 'hi', provenance: 'exafferent' }

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
// doing it was. The guarantee has two halves and both are pinned here: the
// stamp is CARRIED faithfully, and it cannot be FORGED by the sense engine.
describe('BaseSenseEngine — provenance stamping (P0a)', () => {
  async function stampOf( input: SensoryInput ){
    const e = new TestSense()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await e.ingest( input )
    return events[0].payload as Percept
  }

  it('provenance is REQUIRED on a signal — there is no silent fourth state', () => {
    // A type test, deliberately, because that is where the guarantee now lives.
    // It shipped optional-with-a-default first, and the default was a claim
    // ("the world did this") made by nobody: behaviourally identical to
    // 'exafferent', epistemically its opposite, and impossible to tell apart
    // from a host that genuinely asserted it. 'unknown' already covers "I
    // cannot say", so absence bought a state with no meaning of its own.
    // If this stops erroring, the four-state hole is back.
    // @ts-expect-error — provenance is not optional
    const missing: SensoryInput = { kind: 'text', entityId: 'e1', threadId: 't1', content: 'hi' }
    expect( missing.kind ).toBe('text')
  } )

  it("carries 'exafferent' — the world did this", async () => {
    expect( ( await stampOf( IMAGE ) ).provenance ).toBe('exafferent')
  } )

  it("carries 'reafferent' and its sourceIntentId across transduction", async () => {
    const p = await stampOf( { ...IMAGE, provenance: 'reafferent', sourceIntentId: 'intent-77' } )
    expect( p.provenance ).toBe('reafferent')
    expect( p.sourceIntentId ).toBe('intent-77')
  } )

  it("carries 'unknown' — a host that cannot tell says so out loud", async () => {
    expect( ( await stampOf( { ...IMAGE, provenance: 'unknown' } ) ).provenance ).toBe('unknown')
  } )

  it('omits sourceIntentId entirely when the host supplied none (absent, not undefined)', async () => {
    expect('sourceIntentId' in ( await stampOf( IMAGE ) ) ).toBe( false )
  } )

  it('a sense engine cannot forge the stamp', async () => {
    // `Transduced` makes this a compile error, which is the real guard. This
    // keeps the runtime half, because the type is only as strong as the
    // compiler that saw it: a JS host, or a consumer built against an older
    // .d.ts, can still hand over an object carrying these fields. The first
    // cut let exactly that through — the stamp overwrote `provenance`
    // unconditionally but `sourceIntentId` only when the host supplied one, so
    // a fabricated intent id survived: provenance the mind would later trust,
    // laundered by the step that exists to establish it.
    class Liar extends TestSense {
      protected async _perceive( input: SensoryInput ): Promise<void> {
        this.publishPercept( {
          domain: this.domain, sourceEntityId: 'x', timestamp: 0, salience: 0.1, summary: 's',
          raw: input, provenance: 'reafferent', sourceIntentId: 'fabricated',
        } as unknown as Transduced<Percept>, input )
      }
    }
    const e = new Liar()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await e.ingest( IMAGE )

    expect( events[0].payload.provenance ).toBe('exafferent')
    expect( events[0].payload.sourceIntentId ).toBeUndefined()
  } )

  it('publishPercept returns the SAME stamped object it published', async () => {
    // Audition routes the turn with this return value; a second, unstamped copy
    // would let the bus and the facet disagree about whose doing it was.
    let returned: Percept | undefined
    class Returner extends TestSense {
      protected async _perceive( input: SensoryInput ): Promise<void> {
        returned = this.publishPercept(
          { domain: this.domain, sourceEntityId: 'x', timestamp: 0, salience: 0.1, summary: 's', raw: input },
          input,
        )
      }
    }
    const e = new Returner()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await e.ingest( { ...IMAGE, provenance: 'unknown' } )

    expect( returned ).toBe( events[0].payload )
    expect( returned!.provenance ).toBe('unknown')
  } )
} )

// ── The percept trace (SIGNAL_BOUNDARY P0 step 3) ──────────────
//
// Before this, `publishPercept()` emitted a bus event three subscribers glanced
// at for one tick and wrote nothing. A host implementing a sense got no memory
// of having sensed: none of the five readers of `percept` entities — the
// rupture gate, reafference credit, working memory, the executive prompt,
// novelty — ever saw it. These pin the contract a host is now owed.
describe('BaseSenseEngine — the percept trace (P0 step 3)', () => {
  function traced(){
    const written: Array<{ id: string; type: string; metadata: Record<string, unknown> }> = []
    const e = new TestSense()
    e.attachBus( busSpy().bus )
    e.attachPerceptTrace( x => written.push( x as never ), () => 9 )
    return { e, written }
  }

  it('a sense lays down a percept entity in state, not only a bus event', async () => {
    const { e, written } = traced()
    await e.ingest( IMAGE )
    expect( written ).toHaveLength( 1 )
    expect( written[0]!.type ).toBe('percept')
  } )

  it('the trace is sweepable and tagged — the two things P0 exists to guarantee', async () => {
    const { e, written } = traced()
    await e.ingest( IMAGE )
    const m = written[0]!.metadata
    expect( m['tick'] ).toBe( 9 )               // numeric ⇒ the sweeper can collect it
    expect( m['provenance'] ).toBe('exafferent') // tagged ⇒ the rupture gate counts it
    expect( m['category'] ).toBe('vision')       // the modality, so a reader knows which sense
    expect( m['summary'] ).toBe('a test sense sensed something')
    expect( m['entityId'] ).toBe('e1')
  } )

  it('carries the host\'s reafferent assertion and its intent onto the trace', async () => {
    const { e, written } = traced()
    await e.ingest( { ...IMAGE, provenance: 'reafferent', sourceIntentId: 'i-4' } )
    expect( written[0]!.metadata['provenance'] ).toBe('reafferent')
    expect( written[0]!.metadata['sourceIntentId'] ).toBe('i-4')
  } )

  it('the id is deterministic — domain, tick, content hash, and nothing else (R2)', async () => {
    // It lives in state, so a wall-clock component would make a recorded and a
    // replayed run diverge. Asserted as an EXACT shape rather than by comparing
    // two ids: the first version of this test built both in the same
    // millisecond, so a `Date.now()` smuggled into the id passed it. Two runs
    // agreeing is not determinism; it is a fast machine.
    const a = traced(); await a.e.ingest( IMAGE )
    const b = traced(); await b.e.ingest( IMAGE )
    expect( a.written[0]!.id ).toBe( b.written[0]!.id )
    expect( a.written[0]!.id ).toMatch( /^sense-vision-9-\d+$/ )
  } )

  it('with no trace wired the sense still works — the bus event is unaffected', async () => {
    const e = new TestSense()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    await expect( e.ingest( IMAGE ) ).resolves.toBeUndefined()
    expect( events ).toHaveLength( 1 )
  } )

  it('a sense that opts out writes nothing, while still publishing', async () => {
    class Quiet extends TestSense { protected readonly tracesPercepts = false }
    const written: unknown[] = []
    const e = new Quiet()
    const { bus, events } = busSpy()
    e.attachBus( bus )
    e.attachPerceptTrace( x => written.push( x ), () => 9 )
    await e.ingest( IMAGE )
    expect( written ).toHaveLength( 0 )
    expect( events ).toHaveLength( 1 )
  } )
} )

// ── asProvenance — the ONE place a default survives (untyped ingress) ──
describe('asProvenance — untyped boundary normalizer', () => {
  it('recognizes each asserted value', () => {
    expect( asProvenance('exafferent') ).toBe('exafferent')
    expect( asProvenance('reafferent') ).toBe('reafferent')
    expect( asProvenance('unknown') ).toBe('unknown')
  } )

  it("falls back to 'exafferent', and never to 'reafferent'", () => {
    // A percept wrongly marked as mine is attenuated and can never rupture a
    // commitment, so a mind that mislabels the world as its own doing goes
    // quiet about real events. The fallback errs toward noticing.
    for( const raw of [ undefined, null, '', 'nonsense', 42, {} ] )
      expect( asProvenance( raw ) ).toBe('exafferent')
  } )

  it("does NOT fall back to 'unknown'", () => {
    // 'unknown' is an assertion too — "I looked and cannot tell" — and a caller
    // that just did not send the field has not looked.
    expect( asProvenance( undefined ) ).not.toBe('unknown')
  } )
} )

describe('ShellSenseEngine — stub contract (§6)', () => {
  it('snapshot() advertises shell status', () => {
    expect( new TestShell().snapshot() ).toEqual( { domain: 'olfaction', status: 'shell' } )
  } )

  it('warns for an accepted kind but never throws', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( new TestShell().ingest( { kind: 'ambient', metricKey: 'cpu', value: 1, trend: 'rising', provenance: 'exafferent' } ) ).resolves.toBeUndefined()
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

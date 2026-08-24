// ─────────────────────────────────────────────────────────────
// tests/unit/temporal.orientation.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What a Will is told about the time.
 *
 * Every prompt a Will had ever rendered carried this line:
 *
 *     Time: 12.0h (night, circadian: 3.00)
 *
 * Noon and night, in one sentence, permanently. Three separate faults:
 *
 *   1. the HOUR never arrived — `context.ts` read `time.of_day`, the oscillator
 *      writes `circadian.time_of_day`, so the `?? 12` fallback fired every tick;
 *   2. the LABEL read the oscillator's phase CODE (0 morning · 1 afternoon ·
 *      2 evening · 3 night) as if it were a 0–1 fraction, so morning rendered
 *      "deep night" and everything else rendered "night" — a Will was never once
 *      told it was daytime;
 *   3. even wired correctly the hour is derived from the TICK, which after a
 *      snapshot restore counts from an arbitrary point in a previous life.
 *
 * She reasoned from it — "It is 3am", "It is midnight, my circadian cycle is at
 * its trough" — and decided to rest on that basis.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { labelForHour, temporalLine, perceptLine } from '#faculties/executive.engine/prompt.factory'
import { CircadianOscillator } from '#faculties/circadian.oscillator'
import { SomatosensationEngine } from '#senses/somatosensation.engine'
import { Will } from '#surface/sdk/will'
import { setLogger, resetLogger } from '#core/logger'
import type { Percept } from '#senses/index'
import type { EffectorAck } from '#stem/tracts/effector/types'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )
afterAll( () => resetLogger() )

const base = { llm: 'mock' as const, anatomy: 'mind' as const, tickMs: 10, seed: 3 }

/** Capture what the host's dispatch layer acks back, instead of the stem doing it. */
function ackRecorder( will: Will ): EffectorAck[] {
  const acks: EffectorAck[] = []
  ;( will.stem as unknown as Record<string, unknown> )['confirmEffectorExecution'] =
    ( _willId: string, _intentId: string, r: EffectorAck ) => { acks.push( r ) }
  return acks
}

/** Drive the SDK's real dispatch for one invocation — the path a decided act takes. */
function runEffector( will: Will, effectorName: string ): Promise<void> {
  return ( will as unknown as { _runEffector( inv: unknown ): Promise<void> } )._runEffector({
    effectorName, decisionRecordId: 'i-clock', parameters: {},
  })
}

describe('the label and the hour cannot disagree', () => {
  it('noon is not night — the exact sentence a Will used to be handed', () => {
    expect( labelForHour( 12 ) ).toBe('midday')
    expect( labelForHour( 12 ) ).not.toContain('night')
  } )

  it('the rendered line reports the BODY, and never states the hour', () => {
    // The line as the prompt emits it, not its pieces. Testing `labelForHour`
    // alone let a mutation reverting the CALL SITE to read `circadian.phase`
    // pass — the helper stayed correct while the prompt went back to lying.
    //
    // And the hour itself is gone. It is a fact about the world, and a fact
    // about the world is something a mind goes and gets (`check-time`). What
    // remains is what a body can honestly report about itself.
    const line = temporalLine( 12, 3 )
    expect( line ).toContain('it feels like midday to me')
    expect( line ).toContain('check-time')
    expect( line ).toContain('Circadian phase: 3.00')
    expect( line ).not.toMatch( /\b12\.0h\b/ )   // no clock reading, ever

    expect( temporalLine( 3.5, 3 ) ).toContain('it feels like late night to me')
    expect( temporalLine( 15, 0 ) ).toContain('it feels like afternoon to me')
  } )

  it('the label still tracks the hour it is given — a body that drifts still reports itself', () => {
    // The subjective phase is allowed to be WRONG about the world (a jet-lagged
    // body says night at noon). What it may not be is inconsistent with the
    // oscillator it came from.
    for( const h of [ 0, 6, 12, 18, 23 ] )
      expect( temporalLine( h, 0 ) ).toContain( labelForHour( h ) )
  } )

  it('names every hour of the clock, and daytime exists', () => {
    const labels = new Set( Array.from( { length: 24 }, ( _, h ) => labelForHour( h ) ) )
    // The old mapping could produce only 'deep night' and 'night'. A mind that is
    // never told it is daytime cannot reason about when anyone else is awake.
    expect( labels.size ).toBeGreaterThan( 4 )
    expect( [ ...labels ].some( l => l.includes('morning') ) ).toBe( true )
    expect( [ ...labels ].some( l => l === 'afternoon') ).toBe( true )
  } )

  it('the phase CODES the oscillator writes no longer render as hours', () => {
    // 0/1/2/3 are codes, not hours. Reading them as hours is the old bug's
    // shape; they now land on early-morning labels, which is at least honest
    // about what a 0–3 reading means on a 24-hour clock.
    expect( labelForHour( 0 ) ).toBe('deep night')
    expect( labelForHour( 3 ) ).toBe('late night')
    // and critically, the label for the REAL hour is what the prompt now uses.
  } )

  it('wraps rather than breaking on a hostile hour', () => {
    expect( labelForHour( 25 ) ).toBe( labelForHour( 1 ) )
    expect( labelForHour( -1 ) ).toBe( labelForHour( 23 ) )
  } )
} )

describe('the oscillator reads a host clock, because a body rhythm is not a clock', () => {
  const CTX = {} as unknown as SimulationContext
  const state = ( metrics: Record<string, number> = {} ): ReadonlySimulationState =>
    ( { tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) } as never )

  async function hourAfterTick( osc: CircadianOscillator, tick: number ): Promise<number> {
    const r = await osc.react( 0, tick as never, state(), CTX )
    const m = new Map( ( r.commands?.metrics ?? [] ) as Array<[ string, number ]> )
    return m.get('circadian.time_of_day')!
  }

  it('a live clock is re-read every tick — a host clock moves', async () => {
    let hour = 9
    const osc = new CircadianOscillator( { timeOfDayHours: () => hour } )
    expect( await hourAfterTick( osc, 1 ) ).toBe( 9 )
    hour = 17
    expect( await hourAfterTick( osc, 2 ) ).toBe( 17 )
  } )

  it('a fixed number stays fixed — that is what a config value means', async () => {
    const osc = new CircadianOscillator( { timeOfDayHours: 9 } )
    expect( await hourAfterTick( osc, 1 ) ).toBe( 9 )
    expect( await hourAfterTick( osc, 5_000 ) ).toBe( 9 )
  } )

  it('a hostile clock cannot poison the rhythm', async () => {
    for( const [ given, expected ] of [ [ 25, 1 ], [ -1, 23 ], [ Number.NaN, 12 ] ] as const ){
      const osc = new CircadianOscillator( { timeOfDayHours: () => given } )
      expect( await hourAfterTick( osc, 1 ) ).toBe( expected )
    }
  } )

  it('with no clock at all it falls back to the tick — and says so', async () => {
    // Not a bug, but not the world's time either: hours since tick zero, mod 24.
    // Kept so a Will with no host clock still has a rhythm.
    const osc = new CircadianOscillator()
    const a = await hourAfterTick( osc, 3600 )     // +1h of ticks
    const b = await hourAfterTick( osc, 7200 )     // +2h
    expect( b ).not.toBe( a )
  } )
} )

describe('the hour reaches the prompt at all', () => {
  it('the executive context reads the metric the oscillator actually writes', async () => {
    // THE fault. `context.ts` read `time.of_day`; nothing has ever written that
    // key. The oscillator writes `circadian.time_of_day`. So the `?? 12`
    // fallback fired on every tick of every Will ever run, and the prompt said
    // noon for its entire life.
    const { buildExecutiveContext } = await import('#faculties/executive.engine/context')
    const state = {
      tick: 1, time: 0, entities: new Map(),
      metrics: new Map<string, number>( [ [ 'circadian.time_of_day', 3.5 ] ] ),
    } as never

    const ctx = await buildExecutiveContext( state, {} as never )
    expect( ctx.worldState.timeOfDay ).toBe( 3.5 )
  } )

  it('falls back to noon only when the oscillator has written nothing yet', async () => {
    const { buildExecutiveContext } = await import('#faculties/executive.engine/context')
    const state = { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as never
    const ctx = await buildExecutiveContext( state, {} as never )
    expect( ctx.worldState.timeOfDay ).toBe( 12 )
  } )
} )

describe('the time is something a mind seeks, not something it is given', () => {
  it('check-time is on the innate floor — every mind can ask, none is handed it', async () => {
    const { INNATE_SCHEMAS } = await import('#agency/schemas/innate')
    const t = INNATE_SCHEMAS.find( s => s.id === 'check-time')
    expect( t ).toBeDefined()

    // `external` is what dispatches it to the host and holds the intent awaiting.
    // Without it the act would resolve instantly against nothing — a mind
    // "checking the time" and being told it went well, having learnt nothing.
    expect( t!.tags ).toContain('external')

    // Nothing to point at: the time is not a referent.
    expect( t!.binds ).toBe('none')

    // Floor, not percept-evoked — the synthesizer caps the latter at attention
    // capacity, and a glance at a clock should not compete for a percept slot.
    expect( t!.source ).toBe('innate')
  } )

  it('costs less than an examination — a glance at a clock, not a study of something', async () => {
    const { INNATE_SCHEMAS } = await import('#agency/schemas/innate')
    const t       = INNATE_SCHEMAS.find( s => s.id === 'check-time')!
    const inspect = INNATE_SCHEMAS.find( s => s.id === 'inspect')!
    expect( t.cost ).toBeLessThan( inspect.cost )
  } )

  // The two worlds this schema has to behave honestly in, driven through the
  // real dispatch path rather than asserted about. The FIRST of them was the
  // claim the doc comment made and nothing tested: "No handler registered" had
  // zero coverage in the suite while two schema comments rested their whole
  // degradation story on it.
  it('a world with no clock refuses honestly, inside the tick, and reveals nothing', async () => {
    const will = await Will.create( { ...base, name: 'Clockless', identity: { prompt: 'I ask the time.' } } )
    try {
      const acks = ackRecorder( will )
      await runEffector( will, 'check-time')

      expect( acks ).toHaveLength( 1 )
      expect( acks[0]!.success ).toBe( false )
      // It says WHICH act found nothing — a mind that is told only "it failed"
      // cannot tell a missing clock from a clock that is broken.
      expect( acks[0]!.description ).toContain('check-time')
      // And nothing was revealed. An unanswered look must not produce a percept:
      // that is the difference between learning time is unavailable here and
      // being handed a fiction about what time it is.
      expect( acks[0]!.observation ).toBeUndefined()
    }
    finally { await will.stop() }
  }, 30_000 )

  it('a world with a clock answers on the ACK, and the hour reaches the prompt whole', async () => {
    const will = await Will.create( { ...base, name: 'Clocked', identity: { prompt: 'I ask the time.' } } )
    try {
      // A host answers in the shape it keeps time. It is NOT asked to phrase it
      // (SIGNAL_BOUNDARY P2) — no host should have to write "it is a quarter to
      // four in the afternoon" for a mind to know the hour.
      // Deliberately longer than PERCEPT_SUMMARY_CAP renders: the engine's label
      // is bounded (its own words, its own business), so a reading this size
      // CANNOT survive in the label. If the mind can still read the whole thing,
      // it read it from `data` — which is the entire claim being made here.
      const reading = {
        iso: '2026-08-24T15:42:00Z', hour: 15, minute: 42, second: 7,
        zone: 'Europe/Paris', offsetMinutes: 120,
        dayOfWeek: 'Monday', dayOfYear: 236, epochMs: 1787672520000,
      }
      will.effector('check-time', {
        description: 'Look at a clock.',
        handler: async () => ( { success: true, description: 'Looked at the clock.', observation: reading } ),
      } )

      const acks = ackRecorder( will )
      await runEffector( will, 'check-time')

      expect( acks[0]!.success ).toBe( true )
      // The fate and the facts say different things, and the facts are the
      // host's own object — not a sentence about it.
      expect( acks[0]!.description ).toBe('Looked at the clock.')
      expect( acks[0]!.observation ).toEqual( reading )

      // …and that is what the mind reads. The same routing `confirmExecution`
      // performs: observation → somatosensation, REAFFERENT, tied to the act
      // that sought it. Rendered as the prompt renders it, because a percept
      // that reaches state but not the page is a percept the mind never had.
      const seen: Percept[] = []
      const sense = new SomatosensationEngine()
      sense.attachBus( { publish: ( ev: { payload: unknown } ) => seen.push( ev.payload as Percept ),
                         subscribe: () => {} } as never )
      await sense.ingest( { kind: 'system', signal: 'check-time', provenance: 'reafferent',
                            sourceIntentId: 'i-clock', data: acks[0]!.observation } )

      expect( seen[0]!.provenance ).toBe('reafferent')
      expect( seen[0]!.sourceIntentId ).toBe('i-clock')
      expect( seen[0]!.data ).toEqual( reading )   // whole, in the shape the host had it

      // Rendered exactly as the prompt renders one: `extractPercepts` reads the
      // percept ENTITY, whose `category` is the sense's domain.
      //
      // Asserted as the LABEL LINE and the EVIDENCE LINE separately, and the
      // evidence parsed back to an object rather than string-matched. A first
      // draft of this test asserted `line.toContain('15:42')` and passed with
      // BOTH the data-carrying and the data-rendering link deleted — the sense
      // composes its label out of a compact rendering of the same payload, so
      // every substring it looked for was already in the label. Fourth time
      // this shape of vacuous assertion has appeared in this epoch.
      const line = perceptLine( { category: seen[0]!.domain, summary: seen[0]!.summary,
                                  salience: seen[0]!.salience, data: seen[0]!.data } )
      const [ label, evidence ] = line.split('\n')

      expect( label ).toContain('[somatosensation]')
      expect( evidence ).toBeDefined()                        // the data reaches the page at all
      expect( JSON.parse( evidence!.trim() ) ).toEqual( reading )   // …and reaches it whole

      // The label alone could not have carried it — that is why the line needs
      // two parts, and why a host is never asked to summarise its own answer.
      expect( label!.length ).toBeLessThan( JSON.stringify( reading ).length )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

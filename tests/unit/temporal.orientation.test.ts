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

import { describe, it, expect } from 'vitest'
import { labelForHour, temporalLine } from '#faculties/executive.engine/prompt.factory'
import { CircadianOscillator } from '#faculties/circadian.oscillator'
import type { ReadonlySimulationState, SimulationContext } from '#core/types'

describe('the label and the hour cannot disagree', () => {
  it('noon is not night — the exact sentence a Will used to be handed', () => {
    expect( labelForHour( 12 ) ).toBe('midday')
    expect( labelForHour( 12 ) ).not.toContain('night')
  } )

  it('the rendered line agrees with itself', () => {
    // The line as the prompt emits it, not its pieces. Testing `labelForHour`
    // alone let a mutation reverting the CALL SITE to read `circadian.phase`
    // pass — the helper stayed correct while the prompt went back to lying.
    // `circadian` is passed here as the rhythm value (3.00, a phase code) that
    // used to drive the label; the line must ignore it for that purpose.
    expect( temporalLine( 12, 3 ) ).toBe('Time: 12.0h (midday, circadian: 3.00)')
    expect( temporalLine( 3.5, 3 ) ).toBe('Time: 3.5h (late night, circadian: 3.00)')
    expect( temporalLine( 15, 0 ) ).toBe('Time: 15.0h (afternoon, circadian: 0.00)')
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

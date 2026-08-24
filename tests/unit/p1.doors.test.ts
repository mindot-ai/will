// ─────────────────────────────────────────────────────────────
// tests/unit/p1.doors.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P1 — the two bypasses that now go through doors.
 *
 * Written because mutation testing caught them uncovered. Flipping the wake
 * signal's provenance to `'reafferent'`, and blanking the intent id handed to an
 * effector handler, BOTH passed the entire suite. Two changes with no test
 * behind them is two changes that can be silently undone, and the wake one is
 * the exact bug P0 step 2 had to fix by hand.
 */

import { describe, it, expect, vi } from 'vitest'
import { WillStem } from '#stem/index'
import type { WillConfig } from '#stem/mind'
import type { SensoryInput } from '#senses/index'

function config( id: string ): WillConfig {
  return {
    id, name: 'DoorWill', profile: null,
    identity: { prompt: 'I am a test mind.', values: [], traits: {}, style: 'quiet' },
    anatomy: 'reflex', llm: { provider: 'mock' },
  } as unknown as WillConfig
}

describe('the wake event arrives through the sense door', () => {
  it('resuming a paused Will ingests a WAKE SystemSignal, tagged exafferent', async () => {
    const stem = new WillStem()
    await stem.createWill( config('wake-1'), true )
    const instance = ( stem as unknown as { _get( id: string ): {
      cognition: { somatosensationEngine: { ingest( i: SensoryInput ): Promise<void> } }
      pausedAt: Date | null
    } } )._get('wake-1')

    const seen: SensoryInput[] = []
    const real = instance.cognition.somatosensationEngine.ingest.bind( instance.cognition.somatosensationEngine )
    instance.cognition.somatosensationEngine.ingest = async ( i: SensoryInput ) => { seen.push( i ); return real( i ) }

    // Pretend it slept: `resumeWill` only wakes what was actually paused.
    instance.pausedAt = new Date( Date.now() - 3 * 60 * 60 * 1000 )
    stem.resumeWill('wake-1')

    expect( seen ).toHaveLength( 1 )
    const signal = seen[0] as SensoryInput & { signal: string; data: Record<string, unknown> }
    expect( signal.kind ).toBe('system')
    expect( signal.signal ).toBe('WAKE')

    // THE assertion. Untagged, or tagged as the mind's own doing, a wake can
    // never rupture a commitment — `action.selector`'s gate counts only
    // exafferent percepts. Time passing while the mind was away is the world's
    // doing, not its own, and that has to be stated rather than assumed.
    expect( signal.provenance ).toBe('exafferent')

    expect( String( signal.data['summary'] ) ).toContain('3 hours')
    stem.pauseWill('wake-1')
  }, 20_000 )

  it('a Will that was never paused is not told it woke', async () => {
    const stem = new WillStem()
    await stem.createWill( config('wake-2'), true )
    const instance = ( stem as unknown as { _get( id: string ): {
      cognition: { somatosensationEngine: { ingest: unknown } }
    } } )._get('wake-2')
    const spy = vi.fn()
    instance.cognition.somatosensationEngine.ingest = spy

    stem.resumeWill('wake-2')

    expect( spy ).not.toHaveBeenCalled()
    stem.pauseWill('wake-2')
  }, 20_000 )
} )

describe('an effector handler knows which act it is running', () => {
  it('ctx.intentId is the correlation handle the ack is matched on', async () => {
    // Without this a handler that feeds its own result back through `perceive`
    // can say the result is reafferent but not WHICH act caused it — which is
    // how `inspect` ended up declaring it in English, in a bracketed sentence
    // only the LLM could read. The id was always in scope at the call site; it
    // simply was not passed on.
    const { Will } = await import('#surface/sdk/will')
    const seen: Array<{ intentId: string }> = []
    const will = await Will.create( {
      llm: 'mock', anatomy: 'reflex', tickMs: 10, seed: 5, name: 'Handy',
      identity: { prompt: 'I act.' },
      effectors: { poke: async ( _a: unknown, ctx: { intentId: string } ) => {
        seen.push( { intentId: ctx.intentId } ); return 'poked'
      } },
    } as never )

    try {
      // Reach the same private path a chosen act takes, with the invocation the
      // motor executor would have produced.
      await ( will as unknown as {
        _runEffector( inv: Record<string, unknown> ): Promise<void>
      } )._runEffector( {
        id: 'agency-intent-77', decisionRecordId: 'agency-intent-77',
        effectorName: 'poke', parameters: {}, reasoning: '', tick: 1, timestamp: 0,
      } )

      expect( seen ).toHaveLength( 1 )
      expect( seen[0]!.intentId ).toBe('agency-intent-77')
    }
    finally { await will.stop() }
  }, 30_000 )
} )

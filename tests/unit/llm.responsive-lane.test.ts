// ─────────────────────────────────────────────────────────────
// tests/unit/llm.responsive-lane.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A person waiting for an answer does not queue behind rumination.
 *
 * `WILL_LLM_CONCURRENCY` has always shipped with the comment "the minimum is 3:
 * orbital, conversation, summary". That allocation was the intent and one
 * shared semaphore never enforced it — three slots means any three callers, and
 * a mind deliberating at ~1,100 output tokens a call keeps all three warm.
 *
 * Measured on a live COO over 7 hours: 29 of 45 replies started with the gate
 * already at or past its limit. The worst took 130.9s to produce 545 tokens —
 * 4.2 tok/s against a provider that does ~39 — so roughly 117 of those 131
 * seconds were spent waiting for a slot. From the other side of the channel
 * that is indistinguishable from a mind that read the message and said nothing.
 *
 * The one lane that DID exist was the embedder's, which is a different problem
 * (fan-out, the 10.7s tail) solved the same way.
 */

import { describe, it, expect } from 'vitest'
import { LLMSemaphore, withGate, gateFor, isAwaitedOutside, llmGate, responsiveGate } from '#llm/gate'

const deferred = () => {
  let release!: () => void
  const done = new Promise<void>( r => { release = r } )
  return { done, release }
}

describe('the responsive lane', () => {
  it('sends a reply somewhere the mind\'s own thinking cannot reach', () => {
    expect( gateFor('conversation') ).toBe( responsiveGate )

    for( const fn of [ 'deliberation', 'planning', 'supervision', 'consolidation' ] as const )
      expect( gateFor( fn ), `${ fn } must not hold a reserved slot`).toBe( llmGate )
  })

  it('leaves outreach in the general lane — nobody is waiting on it', () => {
    // She started that one. Reserving capacity for unprompted messages would
    // defeat the reservation, since outreach is the most frequent call she makes
    // (155 of 491 on the measured run).
    expect( isAwaitedOutside('outreach') ).toBe( false )
    expect( gateFor('outreach') ).toBe( llmGate )
  })

  it('admits a reply while the general lane is saturated', async () => {
    // The actual failure: three slots held by internal cognition, a person
    // waiting, and no way through.
    const general   = new LLMSemaphore( 3 )
    const reserved  = new LLMSemaphore( 1 )
    const held      = [ deferred(), deferred(), deferred() ]

    for( const h of held ) void withGate( () => h.done, 'deliberation', general )
    await Promise.resolve()

    expect( general.running ).toBe( 3 )

    let replied = false
    const reply = withGate( async () => { replied = true }, 'conversation', reserved )
    await reply

    expect( replied, 'the reply waited on thinking that had not finished').toBe( true )
    expect( general.running, 'and it did not steal a slot from the mind').toBe( 3 )

    held.forEach( h => h.release() )
  })

  it('still bounds itself — two replies at once do not both go through', async () => {
    // The reservation is a lane, not an exemption: a burst of messages must not
    // become a burst of simultaneous calls.
    const reserved = new LLMSemaphore( 1 )
    const first    = deferred()

    void withGate( () => first.done, 'conversation', reserved )
    await Promise.resolve()

    let second = false
    void withGate( async () => { second = true }, 'conversation', reserved )
    await Promise.resolve()

    expect( second, 'the second reply must queue behind the first').toBe( false )
    expect( reserved.queued ).toBe( 1 )

    first.release()
    await new Promise( r => setTimeout( r, 0 ) )
    expect( second ).toBe( true )
  })
})

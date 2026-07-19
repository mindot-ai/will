// ─────────────────────────────────────────────────────────────
// tests/unit/audition.salience.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * computeLanguageSalience — relationship-aware, deterministic message salience (§3).
 */

import { describe, it, expect } from 'vitest'
import { computeLanguageSalience } from '#senses/audition.engine/salience'

const score = ( over: Partial<Parameters<typeof computeLanguageSalience>[0]> = {} ) =>
  computeLanguageSalience({ content: 'hello', attachmentScore: 0, activeGoalText: [], ...over })

describe('computeLanguageSalience (§3)', () => {
  it('a high-attachment sender with an urgency keyword is highly salient (> 0.7)', () => {
    expect( score({ content: 'I need help now, this is urgent', attachmentScore: 1 }) ).toBeGreaterThan( 0.7 )
  } )

  it('a stranger with a neutral message sits near the floor', () => {
    const s = score({ content: 'hey', attachmentScore: 0 })
    expect( s ).toBeGreaterThan( 0 )
    expect( s ).toBeLessThan( 0.35 )
  } )

  it('attachment raises salience monotonically', () => {
    const stranger = score({ content: 'hey there', attachmentScore: 0 } )
    const close     = score({ content: 'hey there', attachmentScore: 1 } )
    expect( close ).toBeGreaterThan( stranger )
  } )

  it('urgency keywords raise salience', () => {
    expect( score({ content: 'this is urgent' }) ).toBeGreaterThan( score({ content: 'this is fine' }) )
  } )

  it('topic overlap with an active goal adds a bonus', () => {
    const withGoal = score({ content: 'how is the deployment going?', activeGoalText: ['ship the deployment'] })
    const noGoal    = score({ content: 'how is the deployment going?', activeGoalText: ['water the plants'] })
    expect( withGoal ).toBeGreaterThan( noGoal )
  } )

  it('ignores short/common tokens for goal overlap (no false positive on "the")', () => {
    const a = score({ content: 'the the the', activeGoalText: ['the plan'] })
    const b = score({ content: 'the the the', activeGoalText: [] })
    expect( a ).toBe( b )   // "the" is too short (≤3) to count as overlap
  } )

  it('is clamped to [0, 1]', () => {
    const s = score({ content: 'URGENT help now critical emergency '.repeat( 50 ), attachmentScore: 1, activeGoalText: ['help'] })
    expect( s ).toBeGreaterThanOrEqual( 0 )
    expect( s ).toBeLessThanOrEqual( 1 )
  } )

  it('is pure/deterministic — same inputs, same output', () => {
    const args = { content: 'urgent help', attachmentScore: 0.6, activeGoalText: ['help me'] }
    expect( computeLanguageSalience( args ) ).toBe( computeLanguageSalience( args ) )
  } )
} )

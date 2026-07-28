// ─────────────────────────────────────────────────────────────
// tests/unit/policy.arbiter.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P0 — the policy seam (dark: null arbiter by default).
// Proves the enforcement point refuses to hand a denied invocation to the
// host, that an unconfigured Will is untouched (the byte-identical
// guarantee), that arbiter faults fail CLOSED rather than open, and that the
// local rule table returns the counterfactual it computes instead of
// discarding it.
//
// Harness: effectorController only touches `config.id` and
// `pendingEffectorInvocations`, so a stub instance is enough — no simulation.

import { describe, it, expect } from 'vitest'
import { effectorController } from '#stem/tracts/effector.controller'
import { NULL_ARBITER, isNullArbiter, finalityOf } from '#stem/policy/arbiter'
import type { PolicyArbiter, PolicyInvocation, Verdict } from '#stem/policy/arbiter'
import { RuleTableArbiter } from '#stem/policy/rule.table'
import type { PolicyRule } from '#stem/policy/rule.table'
import type { WillInstance } from '#stem/index'
import type { effectorInvocation } from '#types'

interface StubInstance { config: { id: string }; pendingEffectorInvocations: effectorInvocation[] }

function stub(): StubInstance {
  return { config: { id: 'will-1' }, pendingEffectorInvocations: [] }
}

const asInstance = ( s: StubInstance ): WillInstance => s as unknown as WillInstance

function payload( over: Record<string, unknown> = {} ): Record<string, unknown> {
  return { intentId: 'agency-intent-1', schema: 'trade', parameters: {}, tick: 7, ...over }
}

/** Let a fire-and-forget promise chain settle. */
const flush = (): Promise<void> => new Promise( r => setTimeout( r, 0 ) )

/** An arbiter returning a fixed verdict, sync or async. */
function fixed( verdict: Verdict, async = false ): PolicyArbiter {
  return { name: 'fixed', evaluate: () => ( async ? Promise.resolve( verdict ) : verdict ) }
}

// ── the seam ────────────────────────────────────────────────────────────────

describe('policy seam — enforcement point', () => {
  it('buffers everything when no arbiter is configured (byte-identical default)', () => {
    const s = stub()
    const c = new effectorController()
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
    expect( s.pendingEffectorInvocations[0]!.effectorName ).toBe('trade')
  })

  it('treats an explicitly-installed NULL_ARBITER as the same fast path', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( NULL_ARBITER )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('restores the no-op default when the arbiter is cleared', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny' }) )
    c.setArbiter( null )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('buffers on allow', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'allow' }) )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('does NOT hand a denied invocation to the host', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny', reasonCode: 'NOPE', finality: 'class' }) )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('does NOT hand an escalated invocation to the host', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'escalate' }) )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('passes only the act across the boundary — no state handle, no internals', () => {
    const s = stub()
    const seen: PolicyInvocation[] = []
    const c = new effectorController()
    c.setArbiter({ name: 'spy', evaluate: ( inv ) => { seen.push( inv ); return { decision: 'allow' } } })
    c.bufferInvocation( asInstance( s ), payload({ targetEntityId: 'e-9', description: 'barter goods' }) )

    expect( seen ).toHaveLength( 1 )
    expect( seen[0] ).toEqual({
      willId: 'will-1', intentId: 'agency-intent-1', schema: 'trade',
      parameters: {}, targetEntityId: 'e-9', description: 'barter goods', tick: 7,
    })
  })
})

describe('policy seam — failure posture', () => {
  it('fails CLOSED when a sync arbiter throws', () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter({ name: 'boom', evaluate: () => { throw new Error('pdp down') } })
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('fails CLOSED when an async arbiter rejects', async () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter({ name: 'boom', evaluate: () => Promise.reject( new Error('timeout') ) })
    c.bufferInvocation( asInstance( s ), payload() )
    await flush()
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })

  it('delivers an async allow once it resolves (out of tick, still delivered)', async () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'allow' }, true ) )
    c.bufferInvocation( asInstance( s ), payload() )
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )   // not yet — resolves later
    await flush()
    expect( s.pendingEffectorInvocations ).toHaveLength( 1 )
  })

  it('withholds an async deny', async () => {
    const s = stub()
    const c = new effectorController()
    c.setArbiter( fixed({ decision: 'deny' }, true ) )
    c.bufferInvocation( asInstance( s ), payload() )
    await flush()
    expect( s.pendingEffectorInvocations ).toHaveLength( 0 )
  })
})

// ── the local rule table ────────────────────────────────────────────────────

const inv = ( over: Partial<PolicyInvocation> = {} ): PolicyInvocation => ({
  willId: 'will-1', intentId: 'i-1', schema: 'trade', parameters: {}, tick: 1, ...over,
})

describe('RuleTableArbiter', () => {
  it('is first-match-wins, so rule order is policy', () => {
    const rules: PolicyRule[] = [
      { schema: 'trade', decision: 'deny', reasonCode: 'FIRST' },
      { schema: 'trade', decision: 'allow' },
    ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'allow' })
    expect( a.evaluate( inv() ) ).toMatchObject({ decision: 'deny', reasonCode: 'FIRST' })
  })

  it('applies the fallthrough posture when nothing matches', () => {
    const a = new RuleTableArbiter({ rules: [ { schema: 'move', decision: 'allow' } ], fallthrough: 'deny' })
    expect( a.evaluate( inv() ) ).toMatchObject({
      decision: 'deny', reasonCode: 'NO_MATCHING_RULE', finality: 'class',
    })
  })

  it('scopes by target entity', () => {
    const rules: PolicyRule[] = [ { schema: 'trade', target: 'e-9', decision: 'deny', reasonCode: 'BANNED_PEER' } ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'allow' })
    expect( a.evaluate( inv({ targetEntityId: 'e-9' }) ).decision ).toBe('deny')
    expect( a.evaluate( inv({ targetEntityId: 'e-1' }) ).decision ).toBe('allow')
  })

  it('allows when every requirement holds', () => {
    const rules: PolicyRule[] = [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } } } ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    expect( a.evaluate( inv({ parameters: { amount: 50 } }) ) ).toEqual({ decision: 'allow' })
  })

  it('returns the counterfactual it computed instead of discarding it', () => {
    const rules: PolicyRule[] = [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } } } ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    expect( a.evaluate( inv({ parameters: { amount: 500 } }) ) ).toEqual({
      decision:       'deny',
      reasonCode:     'PARAM_ABOVE_MAX',
      finality:       'parameter',
      counterfactual: { field: 'amount', requested: 500, allowed: 100 },
    })
  })

  it('distinguishes a class ban from an instance violation', () => {
    const banned  = new RuleTableArbiter({ rules: [ { schema: 'trade', decision: 'deny' } ], fallthrough: 'allow' })
    const bounded = new RuleTableArbiter({
      rules: [ { schema: 'trade', decision: 'allow', require: { amount: { max: 10 } } } ], fallthrough: 'deny',
    })
    expect( banned.evaluate( inv() ).finality ).toBe('class')
    expect( bounded.evaluate( inv({ parameters: { amount: 99 } }) ).finality ).toBe('parameter')
  })

  it('treats an absent required parameter as a violation', () => {
    const rules: PolicyRule[] = [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } } } ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    expect( a.evaluate( inv({ parameters: {} }) ) ).toMatchObject({
      decision: 'deny', reasonCode: 'PARAM_MISSING', counterfactual: { field: 'amount', allowed: { max: 100 } },
    })
  })

  it('carries the permitted set on a oneOf violation', () => {
    const rules: PolicyRule[] = [
      { schema: 'trade', decision: 'allow', require: { currency: { oneOf: [ 'EUR', 'USD' ] } } },
    ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    expect( a.evaluate( inv({ parameters: { currency: 'XRP' } }) ) ).toMatchObject({
      reasonCode: 'PARAM_NOT_IN_SET', counterfactual: { field: 'currency', requested: 'XRP', allowed: [ 'EUR', 'USD' ] },
    })
  })

  it('reports the FIRST declared violation, so the counterfactual is stable', () => {
    const rules: PolicyRule[] = [
      { schema: 'trade', decision: 'allow', require: { amount: { max: 10 }, currency: { oneOf: [ 'EUR' ] } } },
    ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    const v = a.evaluate( inv({ parameters: { amount: 99, currency: 'XRP' } }) )
    expect( v.counterfactual?.field ).toBe('amount')
  })

  it('is deterministic — identical input yields an identical verdict', () => {
    const rules: PolicyRule[] = [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } } } ]
    const a = new RuleTableArbiter({ rules, fallthrough: 'deny' })
    const one = a.evaluate( inv({ parameters: { amount: 500 } }) )
    const two = a.evaluate( inv({ parameters: { amount: 500 } }) )
    expect( one ).toEqual( two )
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

describe('arbiter helpers', () => {
  it('isNullArbiter recognizes the default and absence', () => {
    expect( isNullArbiter( NULL_ARBITER ) ).toBe( true )
    expect( isNullArbiter( null ) ).toBe( true )
    expect( isNullArbiter( undefined ) ).toBe( true )
    expect( isNullArbiter( fixed({ decision: 'allow' }) ) ).toBe( false )
  })

  it('finalityOf defaults an unlabelled denial to the conservative reading', () => {
    expect( finalityOf({ decision: 'deny' }) ).toBe('parameter')
    expect( finalityOf({ decision: 'deny', finality: 'class' }) ).toBe('class')
  })
})

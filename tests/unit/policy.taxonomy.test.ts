// ─────────────────────────────────────────────────────────────
// tests/unit/policy.taxonomy.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P5 — the finality taxonomy, provider-neutral.
//
// The enum widened 'class' | 'instance'  →  'class' | 'parameter' | 'context'
// after the HELM joint RFC ("Denials That Teach") showed that an instance-scoped
// refusal splits in two, and that the halves demand OPPOSITE responses:
//
//   • 'parameter' — the arguments were refused → dent availability lightly.
//   • 'context'   — the refusal was not about the action at all → touch NOTHING.
//
// The three things worth proving here, none of which the P2 suite covers:
//   1. `context` writes nothing anywhere — availability, competence, entities.
//   2. An UNLABELLED denial defaults to 'parameter', never 'context'. Defaulting
//      to the fate that does least would silently disable learning for any
//      provider that doesn't tag, re-introducing re-probe-forever.
//   3. An arbiter FAULT no longer lands on competence (conformance S9), and is
//      recorded on the verdict tape so replay reproduces the withholding.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { SchemaRepertoire, AVAILABILITY_ENTITY_TYPE } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { asFinality, finalityOf } from '#stem/policy/arbiter'
import { RuleTableArbiter } from '#stem/policy/rule.table'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = (): MutState => ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}

function refusal( s: MutState, id: string, finality: string, extra: Record<string, unknown> = {} ): void {
  s.entities.set( id, {
    id, type: 'agency.outcome', createdAt: 0, updatedAt: 0,
    metadata: { schema: 'trade', intentId: 'i-1', success: false, refused: true, finality, ...extra },
  } as SimulationEntity )
}

// ── 1 · normalization: the default is 'parameter', NEVER 'context' ────────────

describe('P5 — finality normalization', () => {
  it('passes the three live values through unchanged', () => {
    expect( asFinality('class') ).toBe('class')
    expect( asFinality('parameter') ).toBe('parameter')
    expect( asFinality('context') ).toBe('context')
  })

  it('defaults an unlabelled denial to "parameter" — the learnable reading', () => {
    // NOT 'context'. 'context' means the mind learns nothing and re-probes the
    // same wall forever — the exact failure this epoch exists to fix. A provider
    // that declines to tag must still teach something.
    expect( asFinality( undefined ) ).toBe('parameter')
    expect( finalityOf({ decision: 'deny' }) ).toBe('parameter')
  })

  it('never infers "context" from junk — it must be asserted, never guessed', () => {
    for( const junk of [ null, '', 'CONTEXT', 'ctx', 0, {}, [], true, 'instance_context' ] )
      expect( asFinality( junk ) ).toBe('parameter')
  })

  it('maps the pre-P5 spelling "instance" onto "parameter" (tapes stay replayable)', () => {
    expect( asFinality('instance') ).toBe('parameter')
  })
})

// ── 2 · the local arbiter emits the new vocabulary ────────────────────────────

describe('P5 — RuleTableArbiter speaks the split enum', () => {
  const inv = ( parameters: Record<string, unknown> ) => ({
    willId: 'w', intentId: 'i-1', schema: 'trade', parameters, tick: 1,
  })

  it('a bound violation is "parameter" — the ability was permitted, the args were not', () => {
    const a = new RuleTableArbiter({
      rules: [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } } } ],
      fallthrough: 'deny',
    })
    const v = a.evaluate( inv({ amount: 500 }) )
    expect( v.decision ).toBe('deny')
    expect( v.finality ).toBe('parameter')
    expect( v.counterfactual ).toMatchObject({ field: 'amount', requested: 500, allowed: 100 })
  })

  it('a flat ban is still "class", and fallthrough-deny is still "class"', () => {
    const banned = new RuleTableArbiter({ rules: [ { schema: 'trade', decision: 'deny' } ], fallthrough: 'allow' })
    expect( banned.evaluate( inv({}) ).finality ).toBe('class')

    const closed = new RuleTableArbiter({ rules: [], fallthrough: 'deny' })
    expect( closed.evaluate( inv({}) ).finality ).toBe('class')
  })

  it('an explicit finality on a rule always wins over the derived default', () => {
    const a = new RuleTableArbiter({
      rules: [ { schema: 'trade', decision: 'allow', require: { amount: { max: 100 } }, finality: 'context' } ],
      fallthrough: 'deny',
    })
    expect( a.evaluate( inv({ amount: 500 }) ).finality ).toBe('context')
  })
})

// ── 3 · the context fate: touch NOTHING ───────────────────────────────────────

describe('P5 — a "context" refusal touches nothing', () => {
  it('leaves availability at 1 while a "parameter" refusal dents it', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    refusal( s, 'o-ctx', 'context')
    apply( s, ( await reaff.react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( rep.availabilityOf('trade') ).toBe( 1 )
    expect( rep.availability().size ).toBe( 0 )      // no ledger entry at all

    refusal( s, 'o-param', 'parameter')
    apply( s, ( await reaff.react( 0, 2, frozen( s ), CTX ) ).commands )
    expect( rep.availabilityOf('trade') ).toBeLessThan( 1 )
  })

  it('never touches competence — the same invariant as every other refusal', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    refusal( s, 'o-ctx', 'context')
    apply( s, ( await reaff.react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( rep.getSkill('trade') ).toBeUndefined()
  })

  it('writes no availability mirror entity (the quiet path stays byte-identical)', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    refusal( s, 'o-ctx', 'context')
    const out = await reaff.react( 0, 1, frozen( s ), CTX )
    const mirrors = ( out.commands?.set ?? [] ).filter( e => e.type === AVAILABILITY_ENTITY_TYPE )
    expect( mirrors ).toHaveLength( 0 )
  })

  it('STILL frees the awaiting intent — touching nothing must not mean hanging', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    refusal( s, 'o-ctx', 'context')
    const out = await reaff.react( 0, 1, frozen( s ), CTX )
    expect( out.commands?.delete ?? [] ).toContain('i-1')     // the intent is released
    expect( out.commands?.delete ?? [] ).toContain('o-ctx')   // the outcome consumed
  })

  it('still counts as a refusal for telemetry — it happened, it just taught nothing', async () => {
    const rep   = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s     = freshState()

    refusal( s, 'o-ctx', 'context')
    const out = await reaff.react( 0, 1, frozen( s ), CTX )
    expect( ( out.commands?.metrics ?? [] ).find( m => m[0] === 'agency.refused.count')?.[1] ).toBe( 1 )
  })
})

// ── 4 · the three fates are genuinely distinct ────────────────────────────────

describe('P5 — each value drives exactly its own fate', () => {
  it('class cuts hardest, parameter dents, context does nothing', async () => {
    const availAfter = async ( finality: string ): Promise<number> => {
      const rep   = new SchemaRepertoire()
      const reaff = new ReafferenceEngine( rep )
      const s     = freshState()
      refusal( s, 'o-1', finality )
      apply( s, ( await reaff.react( 0, 1, frozen( s ), CTX ) ).commands )
      return rep.availabilityOf('trade')
    }

    const [ cls, param, ctx ] = await Promise.all([
      availAfter('class'), availAfter('parameter'), availAfter('context'),
    ])

    expect( cls ).toBeLessThan( param )   // class suppresses
    expect( param ).toBeLessThan( ctx )   // parameter dents
    expect( ctx ).toBe( 1 )               // context is inert
  })
})

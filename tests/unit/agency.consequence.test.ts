// ─────────────────────────────────────────────────────────────
// tests/unit/agency.consequence.test.ts
// ─────────────────────────────────────────────────────────────
// EXAFFERENCE P1 — expected-consequence descriptors (dark: no consumer yet).
// Proves the executor registers a descriptor at each world-facing enaction
// moment (delivered communicate → textHash; async hold → paramsHash), that
// sync innate enactions register none, that the TTL sweep expires them on
// schedule, and that the hash/canonicalization primitives are deterministic.
//
// Harness mirrors agency.execution.test.ts: apply StateCommands to a mutable
// state the way the orchestrator does.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'
import {
  CONSEQUENCE_TYPE, CONSEQUENCE_TTL_TICKS,
  fnv1a, paramsKey, readConsequence,
} from '#agency/consequence'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }

function freshState( metrics: Record<string, number> = {} ): MutState {
  return { tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) }
}

function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] )
    s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}

const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState

function seedIntent( s: MutState, meta: Record<string, unknown> ): void {
  s.entities.set('agency-intent-1', {
    id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
    metadata: { status: 'selected', parameters: {}, expectedReward: 0.5, expectedValence: 0, ...meta },
  } )
}

const descriptors = ( s: MutState ) =>
  [ ...s.entities.values() ].filter( e => e.type === CONSEQUENCE_TYPE )

function fakeComms( success = true ): { comms: unknown } {
  return {
    comms: { executeAction: async () => ({
      success, description: 'sent', commands: { set: [] },
      feedback: { outcomeQuality: success ? 0.85 : 0, surprise: 0, lessons: [] },
    }) },
  }
}
const grant = ( ok: boolean ) => ({ isAllowed: () => ok } as never )

describe('consequence primitives — deterministic keys', () => {
  it('fnv1a is stable and content-sensitive', () => {
    expect( fnv1a('hi Alice') ).toBe( fnv1a('hi Alice') )
    expect( fnv1a('hi Alice') ).not.toBe( fnv1a('hi alice') )
    expect( fnv1a('') ).toBe( 0x811c9dc5 )
  })

  it('paramsKey canonicalizes key order (and nests)', () => {
    expect( paramsKey({ a: 1, b: { d: 2, c: [ 1, 'x' ] } }) )
      .toBe( paramsKey({ b: { c: [ 1, 'x' ], d: 2 }, a: 1 }) )
    expect( paramsKey({ a: 1 }) ).not.toBe( paramsKey({ a: 2 }) )
  })
})

describe('MotorSchemaExecutor — descriptor registration (EXAFFERENCE P1)', () => {
  it('delivered communicate registers a textHash descriptor with the TTL', async () => {
    const exec = new MotorSchemaExecutor()
    const fc = fakeComms( true )
    exec.attachProactiveCommunicator( fc.comms as never ); exec.attachGrants( grant( true ) )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { content: 'hi Alice' } } )

    const r = await exec.react( 0, 5, frozen( s ), CTX )
    apply( s, r.commands )

    const d = descriptors( s )
    expect( d ).toHaveLength( 1 )
    const c = readConsequence( d[0]!.metadata )
    expect( c ).not.toBeNull()
    expect( c!.intentId ).toBe('agency-intent-1')
    expect( c!.mode ).toBe('communicate')
    expect( c!.effector ).toBe('text')                       // reach-out → text
    expect( c!.targetEntityId ).toBe('alice')
    expect( c!.textHash ).toBe( fnv1a('hi Alice') )
    expect( c!.expiresAt ).toBe( 5 + CONSEQUENCE_TTL_TICKS )
  })

  it('async external hold registers a paramsHash descriptor (and no textHash)', async () => {
    const exec = new MotorSchemaExecutor()                    // unknown schema → external route
    const s = freshState()
    seedIntent( s, { schema: 'wave-hands', targetEntityId: 'bob', parameters: { intensity: 0.7 } } )

    const r = await exec.react( 0, 3, frozen( s ), CTX )
    apply( s, r.commands )

    // Intent held awaiting + descriptor registered.
    const intent = s.entities.get('agency-intent-1')
    expect( intent?.metadata?.['status'] ).toBe('awaiting')
    const d = descriptors( s )
    expect( d ).toHaveLength( 1 )
    const c = readConsequence( d[0]!.metadata )
    expect( c!.mode ).toBe('external')
    expect( c!.effector ).toBeUndefined()
    expect( c!.textHash ).toBeUndefined()
    expect( c!.paramsHash ).toBe( fnv1a( paramsKey({ intensity: 0.7 }) ) )
    expect( c!.expiresAt ).toBe( 3 + CONSEQUENCE_TTL_TICKS )
  })

  it('awaiting communicate with authored content carries text (P5 echo-matchable)', async () => {
    const exec = new MotorSchemaExecutor()   // no comms attached → communicate falls to awaiting hold
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { content: 'are you free later' } } )

    const r = await exec.react( 0, 3, frozen( s ), CTX )
    apply( s, r.commands )

    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')
    const c = readConsequence( descriptors( s )[0]!.metadata )
    expect( c!.mode ).toBe('communicate')
    expect( c!.text ).toBe('are you free later')
    expect( c!.textHash ).toBe( fnv1a('are you free later') )
  })

  it('sync innate enaction registers NO descriptor (internal effects only)', async () => {
    const exec = new MotorSchemaExecutor()
    const s = freshState({ 'energy.level': 30 })
    seedIntent( s, { schema: 'rest' } )

    const r = await exec.react( 0, 2, frozen( s ), CTX )
    apply( s, r.commands )

    expect( descriptors( s ) ).toHaveLength( 0 )
    expect( s.entities.get('agency-intent-1') ).toBeUndefined()   // sync resolved
  })

  it('blocked communicate (grant denied) registers NO descriptor', async () => {
    const exec = new MotorSchemaExecutor()
    const fc = fakeComms( true )
    exec.attachProactiveCommunicator( fc.comms as never ); exec.attachGrants( grant( false ) )
    const s = freshState()
    seedIntent( s, { schema: 'reach-out', targetEntityId: 'alice', parameters: { content: 'hey' } } )

    const r = await exec.react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    expect( descriptors( s ) ).toHaveLength( 0 )
  })
})

describe('MotorSchemaExecutor — descriptor TTL sweep', () => {
  it('expires a descriptor at its TTL and keeps a live one', async () => {
    const exec = new MotorSchemaExecutor()
    const s = freshState()
    s.entities.set('agency-consequence-old', {
      id: 'agency-consequence-old', type: CONSEQUENCE_TYPE, createdAt: 0, updatedAt: 0,
      metadata: { intentId: 'old', schema: 'talk', mode: 'communicate', expiresAt: 10, tick: 0 },
    })
    s.entities.set('agency-consequence-live', {
      id: 'agency-consequence-live', type: CONSEQUENCE_TYPE, createdAt: 0, updatedAt: 0,
      metadata: { intentId: 'live', schema: 'talk', mode: 'communicate', expiresAt: 40, tick: 9 },
    })

    const r = await exec.react( 0, 10, frozen( s ), CTX )   // tick 10 ≥ expiresAt 10 → expire
    apply( s, r.commands )

    expect( s.entities.get('agency-consequence-old') ).toBeUndefined()
    expect( s.entities.get('agency-consequence-live') ).toBeDefined()
  })

  it('descriptor outlives its intent resolution (P0 amendment: echo after ack)', async () => {
    const exec = new MotorSchemaExecutor()
    const s = freshState()
    seedIntent( s, { schema: 'wave-hands', parameters: {} } )

    // Dispatch (tick 1): held awaiting + descriptor registered.
    apply( s, ( await exec.react( 0, 1, frozen( s ), CTX ) ).commands )
    expect( descriptors( s ) ).toHaveLength( 1 )

    // Await times out (tick 1 + 15): the intent resolves as a failed outcome…
    apply( s, ( await exec.react( 0, 16, frozen( s ), CTX ) ).commands )
    expect( s.entities.get('agency-intent-1') ).toBeUndefined()
    // …but the descriptor lives on until its own TTL (1 + 30).
    expect( descriptors( s ) ).toHaveLength( 1 )

    apply( s, ( await exec.react( 0, 31, frozen( s ), CTX ) ).commands )
    expect( descriptors( s ) ).toHaveLength( 0 )
  })

  it('registration + sweep are replay-deterministic (same seed state → same commands)', async () => {
    const run = async (): Promise<string> => {
      const exec = new MotorSchemaExecutor()
      const s = freshState()
      seedIntent( s, { schema: 'wave-hands', targetEntityId: 'bob', parameters: { b: 2, a: 1 } } )
      const out: string[] = []
      for( const tick of [ 1, 16, 31 ] ){
        const r = await exec.react( 0, tick, frozen( s ), CTX )
        apply( s, r.commands )
        out.push( JSON.stringify( [ ...s.entities.keys() ].sort() ) )
      }
      return out.join('|')
    }
    expect( await run() ).toBe( await run() )
  })
})

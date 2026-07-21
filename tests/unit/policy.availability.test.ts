// ─────────────────────────────────────────────────────────────
// tests/unit/policy.availability.test.ts
// ─────────────────────────────────────────────────────────────
// POLICY_REAFFERENCE P2 — refusal teaches availability, not competence.
// Proves the availability layer in the repertoire (class cuts hard, instance
// dents lightly, floors above zero, recovers with disuse, mirrors + restores),
// that the ReafferenceEngine routes a `refused` outcome to availability while
// leaving LearnedSkill untouched — and that a real failure still moves
// competence normally — and that availability damps competitive activation
// without ever removing the affordance from the field (re-probe survives).

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { SchemaRepertoire, AVAILABILITY_ENTITY_TYPE, availabilityEntityId } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { scoreAffordance, DEFAULT_WEIGHTS } from '#agency/selection.scoring'
import type { Affordance } from '#agency/types'

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

function outcome( s: MutState, id: string, meta: Record<string, unknown> ): void {
  s.entities.set( id, { id, type: 'agency.outcome', createdAt: 0, updatedAt: 0, metadata: meta } as SimulationEntity )
}

// ── the availability layer (repertoire) ───────────────────────────────────────

describe('P2 — availability layer', () => {
  it('is fully available (1) for a schema that was never refused', () => {
    const rep = new SchemaRepertoire()
    expect( rep.availabilityOf('trade') ).toBe( 1 )
    expect( rep.availability().size ).toBe( 0 )       // quiet path writes nothing
  })

  it('cuts availability HARD on a class refusal, LIGHTLY on an instance refusal', () => {
    const rep = new SchemaRepertoire()
    rep.recordRefusal('trade', 'class', 1 )
    rep.recordRefusal('move',  'instance', 1 )
    expect( rep.availabilityOf('trade') ).toBeLessThan( rep.availabilityOf('move') )
    expect( rep.availabilityOf('move') ).toBeGreaterThan( 0.8 )   // barely dented
  })

  it('compounds repeated refusals toward — but never to — zero', () => {
    const rep = new SchemaRepertoire()
    for( let i = 0; i < 20; i++ ) rep.recordRefusal('trade', 'class', i )
    const v = rep.availabilityOf('trade')
    expect( v ).toBeGreaterThan( 0 )         // re-probe always possible
    expect( v ).toBeLessThan( 0.1 )
  })

  it('recovers slowly with disuse and drops the entry once fully recovered', () => {
    const rep = new SchemaRepertoire()
    rep.recordRefusal('trade', 'class', 1 )
    const dented = rep.availabilityOf('trade')

    let climbed = dented
    for( let t = 2; t < 400; t++ ){
      const dropped = rep.decay( t )
      const now = rep.availabilityOf('trade')
      expect( now ).toBeGreaterThanOrEqual( climbed )   // monotone recovery
      climbed = now
      if( dropped.availability.includes('trade') ) break
    }
    expect( rep.availabilityOf('trade') ).toBe( 1 )     // fully recovered ⇒ absent ⇒ 1
    expect( rep.availability().size ).toBe( 0 )
  })

  it('mirrors to state entities and restores from them', () => {
    const rep = new SchemaRepertoire()
    rep.recordRefusal('trade', 'class', 5 )
    const entities = rep.availabilityEntities()
    expect( entities ).toHaveLength( 1 )
    expect( entities[0]!.id ).toBe( availabilityEntityId('trade') )
    expect( entities[0]!.type ).toBe( AVAILABILITY_ENTITY_TYPE )

    const restored = new SchemaRepertoire()
    const map = new Map( entities.map( e => [ e.id, { ...e, createdAt: 0, updatedAt: 0 } as SimulationEntity ] ) )
    restored.restoreAvailability( map as ReadonlySimulationState['entities'] )
    expect( restored.availabilityOf('trade') ).toBeCloseTo( rep.availabilityOf('trade'), 10 )
  })
})

// ── the reafference routing ───────────────────────────────────────────────────

describe('P2 — refusal routes to availability, not competence', () => {
  it('a refused outcome dents availability and leaves LearnedSkill untouched', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    outcome( s, 'o-1', { schema: 'trade', intentId: 'i-1', success: false, refused: true, finality: 'class' } )

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    expect( rep.availabilityOf('trade') ).toBeLessThan( 1 )   // availability moved
    expect( rep.getSkill('trade') ).toBeUndefined()           // competence untouched — no skill created
    expect( s.entities.has('i-1') ).toBe( false )             // awaiting intent still freed
    expect( s.entities.has('o-1') ).toBe( false )             // outcome consumed
  })

  it('a genuine failure (not refused) still moves competence normally', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()
    outcome( s, 'o-1', { schema: 'trade', intentId: 'i-1', success: false, outcomeQuality: 0.1, predictedReward: 0.5 } )

    const r = await reaff.react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    expect( rep.getSkill('trade') ).toBeDefined()             // competence recorded
    expect( rep.getSkill('trade')!.enactments ).toBe( 1 )
    expect( rep.availabilityOf('trade') ).toBe( 1 )           // availability untouched
  })

  it('emits the refusal metric only when a refusal fired (quiet path stays silent)', async () => {
    const rep = new SchemaRepertoire()
    const reaff = new ReafferenceEngine( rep )
    const s = freshState()

    const quiet = await reaff.react( 0, 1, frozen( s ), CTX )
    expect( ( quiet.commands?.metrics ?? [] ).find( m => m[0] === 'agency.refused.count') ).toBeUndefined()

    outcome( s, 'o-1', { schema: 'trade', intentId: 'i-1', success: false, refused: true, finality: 'instance' } )
    const loud = await reaff.react( 0, 2, frozen( s ), CTX )
    expect( ( loud.commands?.metrics ?? [] ).find( m => m[0] === 'agency.refused.count')?.[1] ).toBe( 1 )
  })
})

// ── the competition damping ───────────────────────────────────────────────────

function affordance( over: Partial<Affordance> = {} ): Affordance {
  return {
    id: 'a-1', schema: 'trade', source: 'external', parameters: {},
    expectedValence: 0, expectedReward: 0.8, cost: 0.1, habitStrength: 0,
    available: true, tags: [], tick: 1, ...over,
  }
}
const bias = {
  goalTargets:     new Set<string>(),
  maxGoalPriority: 0,
  drives:          { energy: 0, sleep: 0, stress: 0, social: 0 },
  threat:          0,
  inhibition:      0,
}

describe('P2 — availability damps activation, never removes the field entry', () => {
  it('a low-availability affordance scores strictly below its available twin', () => {
    const open      = scoreAffordance( affordance(), bias, DEFAULT_WEIGHTS )
    const suppressed = scoreAffordance( affordance({ availability: 0.1 }), bias, DEFAULT_WEIGHTS )
    expect( open ).toBeGreaterThan( 0 )
    expect( suppressed ).toBeLessThan( open )
    expect( suppressed ).toBeGreaterThan( 0 )   // still positive ⇒ still winnable ⇒ re-probe survives
  })

  it('is byte-identical when availability is absent (the quiet path)', () => {
    const withField = scoreAffordance( affordance({ availability: 1 }), bias, DEFAULT_WEIGHTS )
    const noField   = scoreAffordance( affordance(), bias, DEFAULT_WEIGHTS )
    expect( withField ).toBe( noField )
  })

  it('recovered availability restores full competitive weight', () => {
    const base = scoreAffordance( affordance(), bias, DEFAULT_WEIGHTS )
    const dented = scoreAffordance( affordance({ availability: 0.3 }), bias, DEFAULT_WEIGHTS )
    const recovered = scoreAffordance( affordance({ availability: 0.99 }), bias, DEFAULT_WEIGHTS )
    expect( dented ).toBeLessThan( recovered )
    expect( recovered ).toBeCloseTo( base, 1 )
  })
})

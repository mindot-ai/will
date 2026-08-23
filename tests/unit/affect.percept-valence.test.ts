// ─────────────────────────────────────────────────────────────
// tests/unit/affect.percept-valence.test.ts
// ─────────────────────────────────────────────────────────────
// Registry #5 — the affect→percept valence seam, and the P5 consumer it
// unblocks. Exteroception stamps each percept with how the mind FEELS about
// what the percept is OF: the KnownEntityTracker's per-entity felt valence
// when there is one ('entity'), else the ambient mood ('ambient'). The
// ReafferenceEngine then grades a sensory confirmation by that valence within
// a bounded band — wide for real per-entity appraisal, narrow for mere mood,
// and exactly the pre-seam 0.6 when neutral or absent.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { Exteroception } from '#faculties/exteroception'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { SchemaRepertoire } from '#agency/schemas/repertoire'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = ( metrics: Record<string, number> = {} ): MutState =>
  ({ tick: 0, time: 0, entities: new Map(), metrics: new Map( Object.entries( metrics ) ) })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState
function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const id of c.delete ?? [] ) s.entities.delete( id )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}
const put = ( s: MutState, id: string, type: string, metadata: Record<string, unknown> ) =>
  s.entities.set( id, { id, type, createdAt: 0, updatedAt: 0, metadata } as SimulationEntity )

/** Run one Exteroception tick and return the percept about `entityId`. */
async function perceive( s: MutState, entityId: string, tick = 1 ) {
  const r = await new Exteroception().react( 0, tick, frozen( s ), CTX )
  return ( r.commands?.set ?? [] ).find( e =>
    e.type === 'percept' && ( e.metadata as Record<string, unknown> )['entityId'] === entityId )!
}

describe('Exteroception — the affect→percept valence seam', () => {
  it('prefers the known-entity dossier\'s felt valence (real per-entity appraisal)', async () => {
    const s = freshState({ 'affect.valence': -0.8 })          // sour mood…
    put( s, 'bob', 'creature', { salience: 0.5 } )
    put( s, 'ke-bob', 'known-entity', { keid: 'bob', valence: 0.6 } )   // …but I like Bob
    const p = await perceive( s, 'bob')
    expect( p.metadata?.['valence'] ).toBe( 0.6 )
    expect( p.metadata?.['valenceSource'] ).toBe('entity')
  })

  it('falls back to ambient mood when the thing is unknown', async () => {
    const s = freshState({ 'affect.valence': -0.4 })
    put( s, 'stranger', 'creature', { salience: 0.5 } )
    const p = await perceive( s, 'stranger')
    expect( p.metadata?.['valence'] ).toBe( -0.4 )
    expect( p.metadata?.['valenceSource'] ).toBe('ambient')
  })

  it('stamps nothing when the mind has no affect state yet (pre-seam behaviour)', async () => {
    const s = freshState()
    put( s, 'thing', 'object', { salience: 0.5 } )
    const p = await perceive( s, 'thing')
    expect( p.metadata ).not.toHaveProperty('valence')
    expect( p.metadata ).not.toHaveProperty('valenceSource')
  })
})

// ── the P5 consumer ──────────────────────────────────────────────────────────

function awaitingIntent( s: MutState, id: string, schema: string ): void {
  put( s, id, 'agency.intent', { status: 'awaiting', schema, parameters: {},
    predictedReward: 0.5, predictedValence: 0, dispatchedAt: 1 } )
}
function echoPercept( s: MutState, id: string, intentId: string,
  valence?: number, valenceSource?: string ): void {
  put( s, id, 'percept', { provenance: 'reafferent', sourceIntentId: intentId,
    salience: 0.2, category: 'message', tick: 3,
    ...( valence !== undefined ? { valence, valenceSource } : {} ) } )
}
/** Score one sensory confirmation and return the skill's recorded value signal. */
async function confirm( valence?: number, valenceSource?: string ) {
  const s = freshState()
  awaitingIntent( s, 'intent-1', 'wave-hands')
  echoPercept( s, 'percept-echo', 'intent-1', valence, valenceSource )
  const rep = new SchemaRepertoire()
  const r = await new ReafferenceEngine( rep ).react( 0, 4, frozen( s ), CTX )
  apply( s, r.commands )
  return rep.skills().get('wave-hands')!
}

describe('ReafferenceEngine — sensory confirmation graded by felt valence (registry #5)', () => {
  it('neutral or absent valence reproduces the pre-seam quality exactly', async () => {
    const none    = await confirm()
    const neutral = await confirm( 0, 'entity')
    expect( neutral.valueEstimate ).toBeCloseTo( none.valueEstimate, 10 )
    expect( none.successes ).toBe( 1 )
  })

  it('a positively-felt echo scores better than a negatively-felt one', async () => {
    const good = await confirm(  0.8, 'entity')
    const bad  = await confirm( -0.8, 'entity')
    expect( good.valueEstimate ).toBeGreaterThan( bad.valueEstimate )
    expect( good.successes ).toBe( 1 )
    expect( bad.successes ).toBe( 0 )     // it manifested, but it landed badly
  })

  it('mood moves the score LESS than real per-entity appraisal (bounded spans)', async () => {
    const base    = await confirm()
    const entity  = await confirm( -1, 'entity')
    const ambient = await confirm( -1, 'ambient')
    const entityDrop  = base.valueEstimate - entity.valueEstimate
    const ambientDrop  = base.valueEstimate - ambient.valueEstimate
    expect( ambientDrop ).toBeGreaterThan( 0 )              // mood is felt…
    expect( ambientDrop ).toBeLessThan( entityDrop )        // …but never as loudly
  })

  it('a bad mood alone cannot teach the Will that a working skill failed', async () => {
    const worstMood = await confirm( -1, 'ambient')
    expect( worstMood.successes ).toBe( 1 )   // still a success — mood is context, not judgement
  })
})

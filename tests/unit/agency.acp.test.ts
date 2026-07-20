// ─────────────────────────────────────────────────────────────
// tests/unit/agency.acp.test.ts
// ─────────────────────────────────────────────────────────────
// ACTION_CONDITIONED_PREDICTION §2 + §2b.
//  • Entity correspondence: a live external descriptor is a standing
//    prediction its target is about to change because of us — a `modified`
//    percept on exactly that entity is claimed as reafference at gentler
//    attenuation (×0.5), lighting up P5 sensory confirmation for external
//    effectors (previously text-only).
//  • Sense-channel rupture coverage: `senses.*.percept` bus events (never
//    entities) now feed rupture through the selector's FN9-snapshotted
//    buffer — with the echo guard extended to the bus path.

import { describe, it, expect } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { Exteroception } from '#faculties/exteroception'
import { ActionSelector } from '#agency/engines/action.selector'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import {
  consequenceEntity, matchConsequenceEntity, CORRESPONDENCE_ATTENUATION,
  fnv1a, type ConsequenceDescriptor,
} from '#agency/consequence'

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
const metricVal = ( c: StateCommands | undefined, k: string ) => ( c?.metrics ?? [] ).find( m => m[0] === k )?.[1]

const extDesc = ( intentId: string, target: string, expiresAt = 30 ): ConsequenceDescriptor => ({
  intentId, schema: 'wave-hands', mode: 'external', targetEntityId: target,
  paramsHash: 1, expiresAt, tick: 0,
})
function seedDescriptor( s: MutState, d: ConsequenceDescriptor ): void {
  const ent = consequenceEntity( d )
  s.entities.set( ent.id, { ...ent, createdAt: 0, updatedAt: 0 } as SimulationEntity )
}

// ── the pure matcher ─────────────────────────────────────────────────────────

describe('matchConsequenceEntity — narrow by design', () => {
  const d = [ extDesc('i1', 'bob') ]
  it('claims a modified percept on the exact target', () =>
    expect( matchConsequenceEntity( d, 'bob', 'modified') ).toBe( d[0] ) )
  it('never claims an appeared entity (new information, not our footprint)', () =>
    expect( matchConsequenceEntity( d, 'bob', 'appeared') ).toBeNull() )
  it('never claims a different entity', () =>
    expect( matchConsequenceEntity( d, 'alice', 'modified') ).toBeNull() )
  it('communicate descriptors do not entity-match (the text path owns them)', () => {
    const comm: ConsequenceDescriptor = { ...extDesc('i2', 'bob'), mode: 'communicate' }
    expect( matchConsequenceEntity( [ comm ], 'bob', 'modified') ).toBeNull()
  })
})

// ── Exteroception applies it ─────────────────────────────────────────────────

/** Two ticks: register the entity (appeared), then bump updatedAt (modified). */
async function perceiveModified( withDescriptor: boolean, expiresAt = 30 ) {
  const s = freshState()
  const eng = new Exteroception({ emitPerceptEvents: false })
  s.entities.set('bob', { id: 'bob', type: 'creature', createdAt: 0, updatedAt: 0,
    metadata: { salience: 0.8 } } as SimulationEntity )
  if( withDescriptor ) seedDescriptor( s, extDesc('intent-wave', 'bob', expiresAt ) )
  apply( s, ( await eng.react( 0, 1, frozen( s ), CTX ) ).commands )       // appeared
  s.entities.get('bob')!.updatedAt = 5
  const r = await eng.react( 0, 2, frozen( s ), CTX )                        // modified
  return ( r.commands?.set ?? [] ).find( e =>
    e.type === 'percept' && ( e.metadata as Record<string, unknown> )['entityId'] === 'bob'
    && ( e.metadata as Record<string, unknown> )['changeType'] === 'modified')!
}

describe('Exteroception — correspondence tagging (ACP §2)', () => {
  it('tags the target-entity change reafferent at ×0.5 with sourceIntentId', async () => {
    const ctrl = await perceiveModified( false )
    const hit  = await perceiveModified( true )
    expect( ctrl.metadata?.['provenance'] ).toBe('exafferent')
    expect( hit.metadata?.['provenance'] ).toBe('reafferent')
    expect( hit.metadata?.['sourceIntentId'] ).toBe('intent-wave')
    expect( hit.metadata?.['salience'] ).toBeCloseTo(
      ( ctrl.metadata?.['salience'] as number ) * CORRESPONDENCE_ATTENUATION, 10 )
  })

  it('an expired descriptor is inert', async () => {
    const p = await perceiveModified( true, /* expiresAt */ 1 )   // dead by tick 2
    expect( p.metadata?.['provenance'] ).toBe('exafferent')
  })
})

// ── P5 end-to-end for external effectors ─────────────────────────────────────

describe('P5 sensory confirmation now covers external effectors', () => {
  it('an un-acked external intent is freed by its target-entity change', async () => {
    const s = freshState()
    s.entities.set('intent-wave', { id: 'intent-wave', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'awaiting', schema: 'wave-hands', parameters: {},
        predictedReward: 0.5, predictedValence: 0, dispatchedAt: 1 } } as SimulationEntity )
    seedDescriptor( s, extDesc('intent-wave', 'bob') )
    s.entities.set('bob', { id: 'bob', type: 'creature', createdAt: 0, updatedAt: 0,
      metadata: { salience: 0.8 } } as SimulationEntity )

    const extero = new Exteroception({ emitPerceptEvents: false })
    apply( s, ( await extero.react( 0, 2, frozen( s ), CTX ) ).commands )   // appeared
    s.entities.get('bob')!.updatedAt = 5
    apply( s, ( await extero.react( 0, 3, frozen( s ), CTX ) ).commands )   // modified → reafferent

    const rep = new SchemaRepertoire()
    const r = await new ReafferenceEngine( rep ).react( 0, 4, frozen( s ), CTX )
    apply( s, r.commands )

    expect( metricVal( r.commands, 'agency.sensory.confirmed') ).toBe( 1 )
    expect( rep.skills().get('wave-hands')?.successes ).toBe( 1 )
    expect( s.entities.get('intent-wave') ).toBeUndefined()   // freed, not timed out
  })
})

// ── §2b: sense-channel rupture coverage ──────────────────────────────────────

const senseEvent = ( salience: number, content?: string ) => ({
  type: 'senses.audition.percept', version: 1, sourceEngine: 'audition', salience,
  payload: { domain: 'audition', sourceEntityId: 'x', salience, raw: {}, ...( content ? { content } : {} ) },
}) as never

describe('ActionSelector — sense percepts can rupture (ACP §2b)', () => {
  const deliberating = { id: 'd', type: 'agency.intent', metadata: { status: 'deliberating', schema: 'ponder' } }

  it('a high-salience sense percept ruptures (stability written)', async () => {
    const sel = new ActionSelector()
    sel.onCognitiveEvent( senseEvent( 0.9 ) )
    const s = freshState(); s.tick = 5
    s.entities.set('d', { createdAt: 0, updatedAt: 0, ...deliberating } as SimulationEntity )
    const r = await sel.react( 0, 5, frozen( s ), CTX )
    expect( metricVal( r.commands, 'situation.stability')! ).toBeLessThan( 1 )
  })

  it('the echo guard extends to the bus: our own words cannot rupture', async () => {
    const text = 'these are the words I sent out into the world'
    const sel = new ActionSelector()
    sel.onCognitiveEvent( senseEvent( 0.9, `Alice said: ${ text }` ) )
    const s = freshState(); s.tick = 5
    s.entities.set('d', { createdAt: 0, updatedAt: 0, ...deliberating } as SimulationEntity )
    seedDescriptor( s, { intentId: 'i-say', schema: 'reach-out', mode: 'communicate',
      textHash: fnv1a( text ), text, expiresAt: 30, tick: 0 } )
    const r = await sel.react( 0, 5, frozen( s ), CTX )
    expect( metricVal( r.commands, 'situation.stability') ).toBeUndefined()   // no rupture
  })

  it('the buffer is consumed exactly once', async () => {
    const sel = new ActionSelector()
    sel.onCognitiveEvent( senseEvent( 0.9 ) )
    const s = freshState(); s.tick = 5
    await sel.react( 0, 5, frozen( s ), CTX )
    const r2 = await sel.react( 0, 6, frozen( s ), CTX )                     // buffer now empty
    expect( metricVal( r2.commands, 'situation.stability') ).toBeUndefined()
  })

  it('a model-error state-change event ruptures (registry #6)', async () => {
    const sel = new ActionSelector()
    sel.onCognitiveEvent({ type: 'stress.state.changed', version: 1, sourceEngine: 'stress-regulator',
      salience: 0.9, payload: { load: 85, zoneCode: 2 } } as never )
    const s = freshState(); s.tick = 5
    s.entities.set('d', { createdAt: 0, updatedAt: 0, id: 'd', type: 'agency.intent',
      metadata: { status: 'deliberating', schema: 'ponder' } } as SimulationEntity )
    const r = await sel.react( 0, 5, frozen( s ), CTX )
    expect( metricVal( r.commands, 'situation.stability')! ).toBeLessThan( 1 )
  })

  it('a self-caused model-error event (ACP-attenuated at source) cannot rupture', async () => {
    const sel = new ActionSelector()
    // ACP-P2 consumers emit self-caused swings at ≤ ACP_SELF_PRECISION (0.35),
    // below RUPTURE_SALIENCE_GATE (0.4) — the echo guard composes end to end.
    sel.onCognitiveEvent({ type: 'affect.state.changed', version: 1, sourceEngine: 'affective-blender',
      salience: 0.35, payload: { arousal: 0.6 } } as never )
    const s = freshState(); s.tick = 5
    s.entities.set('d', { createdAt: 0, updatedAt: 0, id: 'd', type: 'agency.intent',
      metadata: { status: 'deliberating', schema: 'ponder' } } as SimulationEntity )
    const r = await sel.react( 0, 5, frozen( s ), CTX )
    expect( metricVal( r.commands, 'situation.stability') ).toBeUndefined()
  })

  it('the buffer survives a snapshot/restore boundary (FN9)', async () => {
    const sel = new ActionSelector()
    sel.onCognitiveEvent( senseEvent( 0.9 ) )
    const restored = new ActionSelector()
    restored.restore( sel.snapshot() )
    const s = freshState(); s.tick = 5
    const r = await restored.react( 0, 5, frozen( s ), CTX )
    expect( metricVal( r.commands, 'situation.stability')! ).toBeLessThan( 1 )
  })
})

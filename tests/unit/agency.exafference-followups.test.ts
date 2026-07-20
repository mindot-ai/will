// ─────────────────────────────────────────────────────────────
// tests/unit/agency.exafference-followups.test.ts
// ─────────────────────────────────────────────────────────────
// Two small follow-ups on the shipped exafference arc:
//  • Channel-B revocation hint (P4): a deliberation formed in the wake of a
//    rupture-driven revocation carries `revokedBy`, and the Deliberation engine
//    voices it in-character. Consumed once.
//  • TaskSwitcher reads `situation.stability` (P3): the second owner of switch
//    resistance loosens focus under a destabilized world, exactly as the
//    ActionSelector does — absent stability (=1) is byte-identical to before.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput, SimulationEntity } from '#core/types'
import { ActionSelector } from '#agency/engines/action.selector'
import { DeliberationEngine, type DeliberationFacetProvider } from '#agency/engines/deliberation.engine'
import { TaskSwitcher } from '#faculties/task.switcher'

const CTX = {} as unknown as SimulationContext

interface Ent { id: string; type: string; metadata?: Record<string, unknown> }
function makeState( tick: number, entities: Ent[], metrics: Record<string, number> = {} ): ReadonlySimulationState {
  const em = new Map<string, unknown>()
  for( const e of entities ) em.set( e.id, { id: e.id, type: e.type, createdAt: 0, updatedAt: 0, metadata: e.metadata } )
  return { tick, time: 0, entities: em, metrics: new Map( Object.entries( metrics ) ) } as unknown as ReadonlySimulationState
}
const setOf = ( r: { commands?: { set?: EntityInput[] } } ) => r.commands?.set ?? []
const intentOf = ( r: { commands?: { set?: EntityInput[] } } ) =>
  setOf( r ).find( e => e.type === 'agency.intent')

const deliberatingIntent = ( id: string, schema: string ): Ent =>
  ({ id, type: 'agency.intent', metadata: { status: 'deliberating', schema } })
const exafferent = ( id: string, salience: number, tick: number ): Ent =>
  ({ id, type: 'percept', metadata: { salience, provenance: 'exafferent', tick, entityId: 'w', category: 'threat' } })
/** Two identical affordances ⇒ zero margin ⇒ the selector marks the choice `deliberate`. */
const twinAffordances = (): Ent[] => [ 'x', 'y' ].map( s => ({
  id: `aff-${ s }`, type: 'affordance', metadata: {
    schema: s, source: 'innate', parameters: {}, expectedValence: 0, expectedReward: 0.5,
    cost: 0.05, habitStrength: 0, available: true, tags: [], tick: 1,
  } }) )

describe('Channel-B revocation hint (P4 follow-up)', () => {
  it('the selector stamps revokedBy on the next deliberation, then forgets it (consumed once)', async () => {
    const sel = new ActionSelector()

    // Tick 5 — a hard rupture revokes a deliberating commitment ("ponder").
    await sel.react( 0, 5, makeState( 5, [ deliberatingIntent('d', 'ponder'), exafferent('p', 0.95, 5 ) ] ), CTX )

    // Tick 6 — the field re-forms into a fresh (ambiguous) deliberation.
    const r6 = await sel.react( 0, 6, makeState( 6, twinAffordances() ), CTX )
    const i6 = intentOf( r6 )!
    expect( i6.metadata?.['status'] ).toBe('deliberating')
    expect( i6.metadata?.['revokedBy'] ).toBe('ponder')

    // Tick 7 — same field, but the hint was consumed: no longer stamped.
    const r7 = await sel.react( 0, 7, makeState( 7, twinAffordances() ), CTX )
    expect( intentOf( r7 )!.metadata?.['revokedBy'] ).toBeUndefined()
  })

  it('a revocation older than the hint window is not stamped', async () => {
    const sel = new ActionSelector()
    await sel.react( 0, 5, makeState( 5, [ deliberatingIntent('d', 'ponder'), exafferent('p', 0.95, 5 ) ], ), CTX )
    // Tick 20 (> REVOKE_HINT_WINDOW of 8 past tick 5) — stale, forgotten.
    const r = await sel.react( 0, 20, makeState( 20, twinAffordances() ), CTX )
    expect( intentOf( r )!.metadata?.['revokedBy'] ).toBeUndefined()
  })

  it('the Deliberation engine voices the revocation in-character', async () => {
    let captured = ''
    const provider: DeliberationFacetProvider = {
      spawnFacet() {
        let listener: ( ( d: { decision: unknown } ) => void ) | null = null
        return { attention: 'available', handle: {
          setFocus( f ) { captured = f.content },
          subscribe( l ) { listener = l; return () => { listener = null } },
          async report() { listener?.({ decision: { actions: [ { type: 'x' } ] } }) },
          destroy() {},
        } }
      },
    }
    const eng = new DeliberationEngine(); eng.attachExecutive( provider )
    const s = makeState( 6, [ { id: 'd', type: 'agency.intent', metadata: {
      status: 'deliberating', schema: 'x', revokedBy: 'ponder',
      candidates: [ { schema: 'x' }, { schema: 'y' } ],
    } } ] )
    await eng.react( 0, 6, s, CTX )
    expect( captured ).toContain('let go of what I was weighing')
    expect( captured ).toContain('ponder')
  })
})

describe('TaskSwitcher reads situation.stability (P3 follow-up)', () => {
  const goal = ( id: string, priority: number ): Ent =>
    ({ id, type: 'goal', metadata: { status: 'active', priority, description: id } })

  /** Drive the switcher to build focus on g1, then offer a higher-priority g2 on
   *  the final tick under the given stability; returns the focus goal afterwards. */
  async function focusThenTempt( stability: number | null ): Promise<string | null> {
    const sw = new TaskSwitcher()
    for( let t = 1; t <= 60; t++ )
      await sw.react( 0, t, makeState( t, [ goal('g1', 0.4 ) ] ), CTX )   // long, stable focus
    const metrics = stability === null ? {} : { 'situation.stability': stability }
    await sw.react( 0, 61, makeState( 61, [ goal('g1', 0.4 ), goal('g2', 1.0 ) ], metrics ), CTX )
    return sw.getCurrentFocus()
  }

  it('a stable world (metric absent ⇒ 1) keeps a long-held focus — no switch', async () => {
    expect( await focusThenTempt( null ) ).toBe('g1')
  })

  it('a destabilized world loosens the same focus — the switch now clears', async () => {
    expect( await focusThenTempt( 0.2 ) ).toBe('g2')
  })
})

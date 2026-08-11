// ─────────────────────────────────────────────────────────────
// tests/unit/agency.deliberation.test.ts
// ─────────────────────────────────────────────────────────────
// Phase 5 — the System-2 seam. Proves the Deliberator resolves a 'deliberating'
// intent by choosing among the substrate's candidates THROUGH a unified facet
// (no bespoke prompt), and degrades gracefully (confirm the substrate winner)
// when no executive is attached or the facet budget is full.

import { describe, it, expect } from 'vitest'
import type { ReadonlySimulationState, SimulationContext, EntityInput } from '#core/types'
import { DeliberationEngine, type DeliberationFacetProvider } from '#agency/engines/deliberation.engine'

const CTX = {} as unknown as SimulationContext

function makeState( intentMeta: Record<string, unknown> ): ReadonlySimulationState {
  const entities = new Map<string, unknown>([
    [ 'agency-intent-1', { id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0, metadata: intentMeta } ],
  ])
  return { tick: 1, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
}

const intentOf = ( set: EntityInput[] | undefined ) =>
  ( set ?? [] ).find( e => e.type === 'agency.intent')

/** A fake unified-facet provider: its facet "chooses" `choice` (as an action.type). */
function fakeProvider( choice: string | undefined, attention: 'available' | 'full' = 'available'): DeliberationFacetProvider {
  return {
    spawnFacet() {
      if( attention === 'full') return { attention: 'full' }
      let listener: ( ( d: { decision: unknown } ) => void ) | null = null
      return {
        attention: 'available',
        handle: {
          setFocus() { /* unified PromptFactory builds the real prompt in production */ },
          subscribe( l ) { listener = l; return () => { listener = null } },
          async report() { listener?.({ decision: { actions: choice ? [ { type: choice } ] : [] } }) },
          destroy() {},
        },
      }
    },
  }
}

const CANDIDATES = [
  { schema: 'reach-out', targetEntityId: 'alice', parameters: { targetEntityName: 'Alice' } },
  { schema: 'reflect' },
]

const deliberating = ( extra: Record<string, unknown> = {} ) =>
  makeState({ status: 'deliberating', schema: 'reflect', parameters: {}, candidates: CANDIDATES, ...extra } )

describe('DeliberationEngine — unified-facet choice', () => {
  it('resolves a deliberating intent to the facet-chosen action (status → selected)', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( fakeProvider('reach-out') )

    const res    = await eng.react( 0, 1, deliberating(), CTX )
    const intent = intentOf( res.commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('reach-out')
    expect( intent?.metadata?.['status'] ).toBe('selected')
    expect( intent?.metadata?.['deliberatedVia'] ).toBe('facet')
    expect( intent?.metadata?.['targetEntityId'] ).toBe('alice')   // bound from the chosen candidate
  })

  it('clamps an off-list facet choice back to the provisional winner', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( fakeProvider('launch_missiles') )   // not a candidate

    const intent = intentOf( ( await eng.react( 0, 1, deliberating(), CTX ) ).commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('reflect')    // provisional winner held
    expect( intent?.metadata?.['status'] ).toBe('selected')
  })
})

/** Like fakeProvider, but records the focus content the engine sets on the facet. */
function capturingProvider( choice: string ): { provider: DeliberationFacetProvider; focus: () => string } {
  let captured = ''
  const provider: DeliberationFacetProvider = {
    spawnFacet() {
      let listener: ( ( d: { decision: unknown } ) => void ) | null = null
      return {
        attention: 'available',
        handle: {
          setFocus( f ) { captured = f.content },
          subscribe( l ) { listener = l; return () => { listener = null } },
          async report() { listener?.({ decision: { actions: [ { type: choice } ] } }) },
          destroy() {},
        },
      }
    },
  }
  return { provider, focus: () => captured }
}

describe('DeliberationEngine — Channel B: owns a preemption in-character', () => {
  it('surfaces the interrupted action into the facet focus when the choice preempted one', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('reflect')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating({ preemptedFrom: 'reach-out' }), CTX )
    expect( cap.focus() ).toContain('reach-out')            // names what it broke off
    expect( cap.focus().toLowerCase() ).toContain('broke off')
  })

  it('uses the neutral framing when no preemption occurred', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('reflect')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating(), CTX )
    expect( cap.focus() ).toContain('uncertain')
    expect( cap.focus().toLowerCase() ).not.toContain('broke off')
  })

  it('names a plan-step candidate so the facet chooses as the self pursuing the plan', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('reflect')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating({
      candidates: [ { schema: 'reflect', fromPlan: true }, { schema: 'rest' } ],
    }), CTX )
    expect( cap.focus().toLowerCase() ).toContain( "plan's next step" )
  })

  it( "surfaces each candidate's MEANING so the facet weighs what it's for, not bare labels", async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('give')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating({
      candidates: [
        { schema: 'give',  targetEntityId: 'ada', description: 'Offer an item to someone present' },
        { schema: 'shove', targetEntityId: 'ada', description: 'Push someone away from you' },
      ],
    }), CTX )
    expect( cap.focus() ).toContain('give toward ada — Offer an item to someone present')
    expect( cap.focus() ).toContain('shove toward ada — Push someone away from you')
  })
})

describe('DeliberationEngine — graceful System-1 degradation', () => {
  it('confirms the substrate winner when no executive is attached', async () => {
    const eng    = new DeliberationEngine()                     // no attachExecutive
    const intent = intentOf( ( await eng.react( 0, 1, deliberating(), CTX ) ).commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('reflect')
    expect( intent?.metadata?.['status'] ).toBe('selected')
    expect( intent?.metadata?.['deliberatedVia'] ).toBe('no-executive')
  })

  it('confirms the substrate winner when the facet budget is full', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( fakeProvider('reach-out', 'full') )
    const intent = intentOf( ( await eng.react( 0, 1, deliberating(), CTX ) ).commands?.set )
    expect( intent?.metadata?.['schema'] ).toBe('reflect')
    expect( intent?.metadata?.['status'] ).toBe('selected')
  })

  it('ignores ticks with no deliberating intent', async () => {
    const eng = new DeliberationEngine()
    eng.attachExecutive( fakeProvider('reach-out') )
    const res = await eng.react( 0, 1, makeState({ status: 'selected', schema: 'wait' }), CTX )
    expect( intentOf( res.commands?.set ) ).toBeUndefined()
  })
})

// ── a choice the mind can actually read ──────────────────────────────────────

/**
 * Live, a fresh Will was asked to choose between "inspect toward
 * agency-intent-30", "inspect toward affordance-1-orient-orient" and "inspect
 * toward facet-attending-facet-1" — and said so itself:
 *
 *   "the content of all three is opaque — I don't know what agency-intent-30
 *    actually is or what the affordance-32 nodes contain"
 *
 * It chose anyway, at 0.3 confidence, because the instructions forbid inventing
 * an action outside the list. A choice between labels a mind cannot read is not a
 * decision. The prompt factory already holds this line for "## People I Know";
 * the deliberation focus was the one place that did not.
 */
describe('DeliberationEngine — the candidate list is legible', () => {
  /** A deliberating intent plus whatever dossiers the lookup should find. */
  const withDossier = ( meta: Record<string, unknown>, dossier?: Record<string, unknown> ): ReadonlySimulationState => {
    const st = deliberating( meta )
    if( dossier ) ( st.entities as Map<string, unknown> ).set( dossier['id'] as string, dossier )
    return st
  }

  it('names a referent target instead of printing its anchor', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('reach-out')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, withDossier(
      { candidates: [ { schema: 'reach-out', targetEntityId: 'ke:1sqlkux' } ] },
      { id: 'ke-ke:1sqlkux', type: 'known-entity', createdAt: 0, updatedAt: 0,
        metadata: { keid: 'ke:1sqlkux', kind: 'sentient', name: 'Fabrice' } },
    ), CTX )
    expect( cap.focus() ).toContain('reach-out toward Fabrice')
    expect( cap.focus(), 'an anchor is opaque by design').not.toContain('ke:1sqlkux')
  } )

  it('drops engine bookkeeping rather than offering it as a thing to choose', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('inspect')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating({
      candidates: [
        { schema: 'inspect', targetEntityId: 'agency-intent-30' },
        { schema: 'inspect', targetEntityId: 'affordance-1-orient-orient' },
        { schema: 'inspect', targetEntityId: 'facet-attending-facet-1' },
      ],
    }), CTX )
    for( const id of [ 'agency-intent-30', 'affordance-1-orient-orient', 'facet-attending-facet-1' ] )
      expect( cap.focus(), `${ id } is the engine talking to itself`).not.toContain( id )
  } )

  it('keeps a host-supplied target — that one means something', async () => {
    const eng = new DeliberationEngine()
    const cap = capturingProvider('give')
    eng.attachExecutive( cap.provider )
    await eng.react( 0, 1, deliberating({
      candidates: [ { schema: 'give', targetEntityId: 'ada' } ],
    }), CTX )
    expect( cap.focus() ).toContain('give toward ada')
  } )
} )

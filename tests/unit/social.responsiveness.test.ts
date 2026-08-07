// ─────────────────────────────────────────────────────────────
// tests/unit/social.responsiveness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the mind LEARNS from being answered, or not.
 *
 * `socialStanding` — the term by which a person's standing reaches the action
 * competition — carries this comment, written long before anything could satisfy
 * it: "This is the path by which 'they never answer me' reaches the competition."
 * It reads `reputation`, which learns from `interaction.occurred`, which fires
 * when somebody DOES something toward us. A silence is nobody doing anything, so
 * it produced no event, so nothing downstream could ever learn from it.
 *
 * Measured on the live Will this was found on, after 43 interactions with her
 * operator:
 *
 *     trustworthiness 0.5 · positiveInteractions 0 · negativeInteractions 0
 *
 * Dead centre. `socialStanding` = (0.5 − 0.5) × 2 × confidence = exactly zero,
 * so one of the eleven terms in the competition contributed nothing at all while
 * she messaged him eleven times.
 *
 * The goal side failed the same way from the other direction: `action.outcome`
 * for a message fires when the OUTBOX accepts it, and crediting a goal for that
 * would complete "get a clear answer" after nine unanswered messages.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { GoalManager } from '#faculties/goal.manager'
import { ReputationTracker } from '#faculties/reputation.tracker'
import type { CognitiveEvent } from '#cognition/bus'

const CTX = {} as unknown as SimulationContext

interface MutState { tick: number; time: number; entities: Map<string, SimulationEntity>; metrics: Map<string, number> }
const freshState = (): MutState => ({ tick: 0, time: 0, entities: new Map(), metrics: new Map() })
const frozen = ( s: MutState ): ReadonlySimulationState => s as unknown as ReadonlySimulationState
function apply( s: MutState, c: StateCommands | undefined ): void {
  if( !c ) return
  for( const e of c.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } as SimulationEntity )
  for( const [ k, v ] of c.metrics ?? [] ) s.metrics.set( k, v )
}

const responsiveness = ( keid: string, answered: boolean ): CognitiveEvent => ({
  type: 'social.responsiveness', version: 1, sourceEngine: 'reafference',
  salience: 0.4, payload: { keid, answered, waitedTicks: 100, tick: 1 },
} as unknown as CognitiveEvent)

const KEID = 'discord:1019376031150379101'

function reputationOf( s: MutState, keid: string ): Record<string, unknown> | undefined {
  for( const e of s.entities.values() ){
    if( e.type !== 'reputation') continue
    const m = e.metadata as Record<string, unknown>
    if( m['keid'] === keid ) return m
  }
  return undefined
}

// ── the reputation layer finally has something to learn from ──

describe('a silence is evidence about a person', () => {
  let rt: ReputationTracker
  let s:  MutState
  beforeEach( () => { rt = new ReputationTracker(); s = freshState() } )

  async function feed( events: CognitiveEvent[], tick = 10 ): Promise<void> {
    for( const e of events ) rt.onCognitiveEvent( e )
    apply( s, ( await rt.react( 0, tick, frozen( s ), CTX ) ).commands )
  }

  it('being answered raises how reliable the mind finds them', async () => {
    await feed([ responsiveness( KEID, true ) ])
    expect( Number( reputationOf( s, KEID )!['reliability'] ) ).toBeGreaterThan( 0.5 )
  } )

  it('being ignored lowers it', async () => {
    await feed([ responsiveness( KEID, false ) ])
    expect( Number( reputationOf( s, KEID )!['reliability'] ) ).toBeLessThan( 0.5 )
  } )

  it('settles where two answers in three hold steady — a calibration, not a guess', async () => {
    // +0.03 answered, −0.06 ignored ⇒ equilibrium at 2·a = b. Someone who
    // replies to two messages in three neither gains nor loses standing; better
    // than that and the mind's read on them improves, worse and it falls.
    await feed([
      responsiveness( KEID, true ), responsiveness( KEID, true ), responsiveness( KEID, false ),
    ])
    expect( Number( reputationOf( s, KEID )!['reliability'] ) ).toBeCloseTo( 0.5, 5 )
  } )

  it('never books a silence as an interaction — nobody interacted', async () => {
    // `interactionCount` counts ACTS. An answer already arrives as an inbound
    // percept and is booked by `interaction.occurred`; counting it again here
    // would count one reply twice, and counting a silence at all would have the
    // mind remember conversations that never happened.
    await feed([ responsiveness( KEID, false ), responsiveness( KEID, true ) ])
    expect( reputationOf( s, KEID )!['interactionCount'] ).toBe( 0 )
  } )

  it('treats being ignored as fresh news, so its read on them does not rot', async () => {
    // Confidence decays after 200 quiet ticks, flooring at 0.05 — which zeroes
    // `socialStanding` outright. A mind actively being ignored is not a mind with
    // no news about that person.
    await feed([ responsiveness( KEID, false ) ], 900 )
    expect( reputationOf( s, KEID )!['lastInteractionTick'] ).toBe( 900 )
  } )

  it('keeps reliability inside its bounds under a long silence', async () => {
    await feed( Array.from({ length: 60 }, () => responsiveness( KEID, false ) ) )
    expect( Number( reputationOf( s, KEID )!['reliability'] ) ).toBe( 0 )
    expect( Number( reputationOf( s, KEID )!['trustworthiness'] ) ).toBeGreaterThanOrEqual( 0 )
  } )

  it('reaches trustworthiness, which is what the competition actually reads', async () => {
    // socialStanding() reads `trustworthiness` and nothing else. Moving
    // reliability without recomposing it would have been a no-op in practice.
    await feed([ responsiveness( KEID, false ) ])
    expect( Number( reputationOf( s, KEID )!['trustworthiness'] ) ).toBeLessThan( 0.5 )
  } )
} )

// ── goals advance on the answer, never on the send ───────────

describe('a message makes progress by being answered, not by being sent', () => {
  let gm: GoalManager
  beforeEach( () => { gm = new GoalManager() } )

  const outcome = ( actionType: string ): CognitiveEvent => ({
    type: 'action.outcome', version: 1, sourceEngine: 'motor', salience: 0.5,
    payload: { actionType, domain: actionType, outcomeQuality: 1, success: true },
  } as unknown as CognitiveEvent)

  it('sending advances nothing, however well the delivery went', () => {
    // Nine of these at full quality used to complete the goal outright.
    const id = gm.addGoal('Get a clear answer from Fabrice', 0.9, [ 'communication', `keid:${ KEID }` ],
      undefined, undefined, 'action')
    for( let i = 0; i < 12; i++ ) gm.onCognitiveEvent( outcome('reach-out') )
    expect( gm.getGoal( id )!.progress ).toBe( 0 )
  } )

  it('holds for every spelling a communicative act arrives under', () => {
    // `actionType` is the SCHEMA id on one path (`reach-out`) and the EFFECTOR
    // name on another (`text`). The old test looked only for 'talk'/'text', so a
    // reach-out reached no goal at all — 8 goals, 28 outreaches, and
    // `lastActionAttemptTick` unset on every one of them.
    const id = gm.addGoal('Reach Fabrice', 0.9, [ 'text', 'talk', 'reach-out', 'communicate' ],
      undefined, undefined, 'action')
    for( const t of [ 'reach-out', 'reach_out', 'text', 'talk', 'broadcast', 'gesture', 'communicate' ] )
      gm.onCognitiveEvent( outcome( t ) )
    expect( gm.getGoal( id )!.progress ).toBe( 0 )
  } )

  it('a non-communicative action still advances a matching goal', () => {
    // The gate must be narrow: this is the pre-existing 4.1 behaviour and the
    // only reason action goals move at all.
    const id = gm.addGoal('Learn the codebase', 0.7, [ 'learn' ], undefined, undefined, 'action')
    gm.onCognitiveEvent( outcome('learn') )
    expect( gm.getGoal( id )!.progress ).toBeGreaterThan( 0 )
  } )

  it('being answered advances the goal that was about that person', () => {
    const id = gm.addGoal('Get a clear answer from Fabrice', 0.9, [ `keid:${ KEID }` ],
      undefined, undefined, 'action')
    gm.onCognitiveEvent( responsiveness( KEID, true ) )
    const g = gm.getGoal( id )!
    expect( g.progress ).toBeGreaterThan( 0 )
    expect( g.lastActionType ).toBe('answered')
  } )

  it('links through requestingEntityId too — how a conversation-born goal is tied to its asker', () => {
    const id = gm.addGoal('Answer what he asked', 0.9, [], undefined, undefined, 'action',
      undefined, undefined, KEID )
    gm.onCognitiveEvent( responsiveness( KEID, true ) )
    expect( gm.getGoal( id )!.progress ).toBeGreaterThan( 0 )
  } )

  it('being answered by one person is NOT progress on wanting to talk to another', () => {
    const id = gm.addGoal('Get hold of FKEM', 0.9, [ 'communication', 'keid:discord:999' ],
      undefined, undefined, 'action')
    gm.onCognitiveEvent( responsiveness( KEID, true ) )
    expect( gm.getGoal( id )!.progress ).toBe( 0 )
  } )

  it('a silence advances nothing at all', () => {
    const id = gm.addGoal('Get a clear answer from Fabrice', 0.9, [ `keid:${ KEID }` ],
      undefined, undefined, 'action')
    gm.onCognitiveEvent( responsiveness( KEID, false ) )
    expect( gm.getGoal( id )!.progress ).toBe( 0 )
  } )
} )

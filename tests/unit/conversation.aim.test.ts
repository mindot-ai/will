// ─────────────────────────────────────────────────────────────
// tests/unit/conversation.aim.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A communicative act has an AIM that is not its EXECUTION.
 *
 * Observed on a live Will running as an operations lead in Discord: one inbound
 * message, then the same question to the same person ELEVEN times in two and a
 * half minutes. Her `agency.skill` record read:
 *
 *     reach-out | enactments 28 | successes 28
 *
 * A hundred per cent success rate, because the outbox accepted every one. Habit
 * (0.78) and expected value (0.5) therefore CLIMBED with each repetition, while
 * the only opposing term — satiation, `w.repeat × justEnacted` — is bounded at
 * 0.30 and decays with elapsed time. Positive feedback against a capped brake.
 *
 * And the goal that drove it could never be satisfied, because nothing connected
 * being answered to making progress. Across 3300 ticks and 28 outreaches, all
 * eight goals in her mind carried `lastActionAttemptTick: None`.
 *
 * Three separate surfaces, one missing fact: nothing in the mind represented
 * "I spoke and nobody answered". These tests pin that fact down, and pin down
 * what it is NOT — it is not a rule against repeating.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ReadonlySimulationState, SimulationContext, StateCommands, SimulationEntity,
} from '#core/types'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { buildExecutiveContext } from '#faculties/executive.engine/context'
import { PromptFactory } from '#faculties/executive.engine/prompt.factory'
import {
  readSpokenTurns, lastHeardByEntity, resolveReplyExpectations, openTurns, isOpen,
  DEFAULT_REPLY_WINDOW_TICKS,
} from '#agency/conversation.aim'
import { spokenAtByEntity } from '#agency/consequence'

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

function sent(
  s: MutState, id: string, target: string, tick: number,
  extra: Record<string, unknown> = {},
): void {
  s.entities.set( id, { id, type: 'conversation.sent', createdAt: 0, updatedAt: 0, tick, metadata: {
    targetEntityId: target, targetEntityName: 'Fabrice', preview: 'Quick question about Q3', tick, ...extra,
  } } as unknown as SimulationEntity )
}
function received( s: MutState, id: string, source: string, tick: number ): void {
  s.entities.set( id, { id, type: 'conversation.received', createdAt: 0, updatedAt: 0, tick, metadata: {
    sourceKeid: source, directedAtSelf: true, preview: 'sure, one sec',
  } } as unknown as SimulationEntity )
}

const SRC  = join( process.cwd(), 'src')
const code = ( p: string ): string => readFileSync( join( SRC, p ), 'utf8')
  .replace( /\/\*[\s\S]*?\*\//g, '')
  .replace( /(^|[^:])\/\/[^\n]*/g, '$1')

// ── the fact itself ──────────────────────────────────────────

describe('reading what the mind has said', () => {
  it('takes the tick from metadata, or the entity, whichever the writer filled', () => {
    // The two writers disagree: ProactiveCommunicator stamps `metadata.tick`,
    // AuditionEngine relies on setEntity stamping the entity. Defaulting to 0
    // made every record of the second kind look infinitely old — the same bug
    // `spokenAtByEntity` had to grow a fallback for.
    const s = freshState()
    sent( s, 'a', 'discord:1', 40 )
    s.entities.set('b', { id: 'b', type: 'conversation.sent', createdAt: 0, updatedAt: 0, tick: 55,
      metadata: { targetEntityId: 'discord:1', preview: 'hi' } } as unknown as SimulationEntity )

    const turns = readSpokenTurns( s.entities )
    expect( turns.map( t => t.tick ) ).toEqual([ 40, 55 ])
  } )

  it('orders oldest-first with ties broken by id, so a replay cannot reorder them', () => {
    const s = freshState()
    sent( s, 'zzz', 'discord:1', 10 )
    sent( s, 'aaa', 'discord:1', 10 )
    expect( readSpokenTurns( s.entities ).map( t => t.entityId ) ).toEqual([ 'aaa', 'zzz' ])
  } )

  it('ignores a record with no addressee — there is nobody it could be open with', () => {
    const s = freshState()
    s.entities.set('x', { id: 'x', type: 'conversation.sent', createdAt: 0, updatedAt: 0,
      metadata: { preview: 'to nobody' } } as unknown as SimulationEntity )
    expect( readSpokenTurns( s.entities ) ).toHaveLength( 0 )
  } )

  it('an acknowledgement is never open — it closes a turn rather than opening one', () => {
    const s = freshState()
    sent( s, 'ack', 'discord:1', 10, { isAck: true } )
    expect( readSpokenTurns( s.entities ).every( isOpen ) ).toBe( false )
  } )

  it('reads the tick field state actually stamps — updatedAtTick, not tick', () => {
    // `SimulationEntity` has NO `tick`; it is `updatedAtTick`. Reading the former
    // yields undefined on every real entity, silently.
    //
    // This shipped broken and a live run caught it: an inbound turn is written
    // OFF-tick, so its writer has no clock to quote and it carries no
    // `metadata.tick` — its only tick is the one setEntity stamps. Reading
    // `e.tick` made lastHeard 0 for everybody, `0 > sentTick` never true, and no
    // turn could EVER be marked answered. The engine announced "no answer from
    // Fabrice" about a message he had already replied to, and her read on his
    // reliability fell to 0.26 on silences that were not silences — the exact
    // over-attribution `lastHeardByEntity` is commented to avoid.
    const s = freshState()
    s.entities.set('r', { id: 'r', type: 'conversation.received', createdAt: 0, updatedAt: 0,
      updatedAtTick: 77, metadata: { sourceKeid: 'discord:1' } } as unknown as SimulationEntity )
    expect( lastHeardByEntity( s.entities ).get('discord:1') ).toBe( 77 )
  } )

  it('an inbound with only a stamped tick still answers an open turn', () => {
    const s = freshState()
    s.entities.set('s1', { id: 's1', type: 'conversation.sent', createdAt: 0, updatedAt: 0,
      updatedAtTick: 20, metadata: { targetEntityId: 'discord:1', tick: 10, preview: 'ask' } } as unknown as SimulationEntity )
    s.entities.set('r1', { id: 'r1', type: 'conversation.received', createdAt: 0, updatedAt: 0,
      updatedAtTick: 14, metadata: { sourceKeid: 'discord:1' } } as unknown as SimulationEntity )

    const { answered, unanswered } = resolveReplyExpectations( s.entities, 999, 240 )
    expect( answered ).toHaveLength( 1 )
    expect( unanswered ).toHaveLength( 0 )
  } )

  it('the satiation path reads the same field — it had the identical dead fallback', () => {
    // `spokenAtByEntity` carries a comment explaining why its `e.tick` fallback
    // matters. It never fired, so any writer that omitted `metadata.tick` looked
    // infinitely old and satiated nothing at all.
    const s = freshState()
    s.entities.set('s1', { id: 's1', type: 'conversation.sent', createdAt: 0, updatedAt: 0,
      updatedAtTick: 91, metadata: { targetEntityId: 'discord:1' } } as unknown as SimulationEntity )
    expect( spokenAtByEntity( s.entities ).get('discord:1') ).toBe( 91 )
  } )

  it('hears when each person last spoke to us', () => {
    const s = freshState()
    received( s, 'r1', 'discord:1', 12 )
    received( s, 'r2', 'discord:1', 30 )
    received( s, 'r3', 'discord:2', 5 )
    const heard = lastHeardByEntity( s.entities )
    expect( heard.get('discord:1') ).toBe( 30 )
    expect( heard.get('discord:2') ).toBe( 5 )
  } )
} )

describe('resolving what became of it', () => {
  it('any turn from them AFTER we spoke counts as an answer', () => {
    // Deliberately not topic-matched. Deciding whether their reply was *about*
    // what we said is a guess dressed as a fact, and erring strict would teach
    // the mind it is ignored by someone actively talking to it.
    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )
    received( s, 'r1', 'discord:1', 14 )

    const { answered, unanswered } = resolveReplyExpectations( s.entities, 20, 240 )
    expect( answered ).toHaveLength( 1 )
    expect( answered[0]!.at ).toBe( 14 )
    expect( unanswered ).toHaveLength( 0 )
  } )

  it('a turn they spoke BEFORE we did is not an answer to it', () => {
    const s = freshState()
    received( s, 'r1', 'discord:1', 5 )
    sent( s, 's1', 'discord:1', 10 )
    expect( resolveReplyExpectations( s.entities, 20, 240 ).answered ).toHaveLength( 0 )
  } )

  it('says nothing at all while the turn is merely young', () => {
    // Not-yet-answered is a THIRD state and the honest one. Collapsing it into
    // ignored would have the mind feel snubbed one tick after speaking.
    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )
    const r = resolveReplyExpectations( s.entities, 100, 240 )
    expect( r.answered ).toHaveLength( 0 )
    expect( r.unanswered ).toHaveLength( 0 )
  } )

  it('reports the silence once the window has fully elapsed', () => {
    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )
    expect( resolveReplyExpectations( s.entities, 250, 240 ).unanswered ).toHaveLength( 1 )
  } )

  it('reports each silence exactly once, however long it lasts', () => {
    // Without the latch this fires every tick forever: one silence would land
    // thousands of reputation hits against one person.
    const s = freshState()
    sent( s, 's1', 'discord:1', 10, { unansweredAt: 250 } )
    expect( resolveReplyExpectations( s.entities, 600, 240 ).unanswered ).toHaveLength( 0 )
  } )

  it('an already-answered turn is never re-resolved', () => {
    const s = freshState()
    sent( s, 's1', 'discord:1', 10, { answeredAt: 14 } )
    received( s, 'r1', 'discord:1', 99 )
    expect( resolveReplyExpectations( s.entities, 600, 240 ).answered ).toHaveLength( 0 )
  } )

  it('an acknowledgement is never reported as ignored', () => {
    const s = freshState()
    sent( s, 'ack', 'discord:1', 10, { isAck: true } )
    expect( resolveReplyExpectations( s.entities, 999, 240 ).unanswered ).toHaveLength( 0 )
  } )

  it('a turn restored from a snapshot ahead of the clock is not instantly ignored', () => {
    // Consequence descriptors had exactly this bug: restored stamps read as
    // freshly live, and a Will spent a whole session believing it had just
    // messaged someone moments ago. Here the failure would invert — a turn
    // stamped 3300 against a clock at 1 must not fire.
    const s = freshState()
    sent( s, 's1', 'discord:1', 3300 )
    expect( resolveReplyExpectations( s.entities, 1, 240 ).unanswered ).toHaveLength( 0 )
  } )

  it('waits a good deal longer than the mind waits for its own body', () => {
    // AWAIT_TIMEOUT is 15 ticks and the echo TTL is 30 — those ask "did my act
    // leave the building?". This asks "did a person get back to me?", and people
    // take their time.
    expect( DEFAULT_REPLY_WINDOW_TICKS ).toBeGreaterThan( 30 * 4 )
  } )
} )

// ── folded into state by the engine that owns "did the world confirm it?" ──

describe('ReafferenceEngine folds the answer onto the record', () => {
  it('marks an answered turn and says so on the bus', async () => {
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    reaff.attachBus({ publish: ( e: never ) => { published.push( e ) } } as never )

    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )
    received( s, 'r1', 'discord:1', 14 )

    apply( s, ( await reaff.react( 0, 20, frozen( s ), CTX ) ).commands )

    expect( s.entities.get('s1')!.metadata!['answeredAt'] ).toBe( 14 )
    const ev = published.find( p => p.type === 'social.responsiveness')
    expect( ev?.payload ).toMatchObject({ keid: 'discord:1', answered: true })
  } )

  it('marks a silence and says THAT on the bus', async () => {
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    reaff.attachBus({ publish: ( e: never ) => { published.push( e ) } } as never )

    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )

    apply( s, ( await reaff.react( 0, 300, frozen( s ), CTX ) ).commands )

    expect( s.entities.get('s1')!.metadata!['unansweredAt'] ).toBe( 300 )
    const ev = published.find( p => p.type === 'social.responsiveness')
    expect( ev?.payload ).toMatchObject({ keid: 'discord:1', answered: false })
    expect( ev!.payload['waitedTicks'] ).toBe( 290 )
  } )

  it('MERGES — it must not sever the delivery ack\'s only correlation key', async () => {
    // `OutboxController.confirmDelivery` finds a sent record through
    // `outboxMessageIds` and has no other key. `setEntity` REPLACES the whole
    // entity, so writing back only the fields this engine cares about would drop
    // them silently, for every turn that got an answer.
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    const s = freshState()
    sent( s, 's1', 'discord:1', 10, { outboxMessageIds: [ 'ob-1', 'ob-2' ], delivered: true, isAck: false } )
    received( s, 'r1', 'discord:1', 14 )

    apply( s, ( await reaff.react( 0, 20, frozen( s ), CTX ) ).commands )

    const m = s.entities.get('s1')!.metadata as Record<string, unknown>
    expect( m['outboxMessageIds'] ).toEqual([ 'ob-1', 'ob-2' ])
    expect( m['delivered'] ).toBe( true )
    expect( m['preview'] ).toBe('Quick question about Q3')
    expect( m['answeredAt'] ).toBe( 14 )
  } )

  it('a Will that has spoken to nobody writes nothing at all', async () => {
    // The quiet path stays byte-identical — same discipline as EXAFFERENCE P3.
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    const r = await reaff.react( 0, 500, frozen( freshState() ), CTX )
    const keys = ( r.commands?.metrics ?? [] ).map( m => m[0] )
    expect( keys ).not.toContain('social.unanswered.count')
    expect( keys ).not.toContain('social.answered.count')
  } )

  it('resolves once, then leaves the record alone', async () => {
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    const published: Array<{ type: string }> = []
    reaff.attachBus({ publish: ( e: never ) => { published.push( e ) } } as never )

    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )

    apply( s, ( await reaff.react( 0, 300, frozen( s ), CTX ) ).commands )
    apply( s, ( await reaff.react( 0, 301, frozen( s ), CTX ) ).commands )
    apply( s, ( await reaff.react( 0, 302, frozen( s ), CTX ) ).commands )

    expect( published.filter( p => p.type === 'social.responsiveness') ).toHaveLength( 1 )
  } )
} )

// ── what the mind can finally see ────────────────────────────

describe('the mind can see that it already said this', () => {
  it('surfaces its own open turns, newest first', () => {
    const s = freshState()
    sent( s, 's1', 'discord:1', 10 )
    sent( s, 's2', 'discord:1', 40 )
    sent( s, 's3', 'discord:1', 70, { answeredAt: 72 } )

    const open = openTurns( s.entities )
    expect( open.map( t => t.entityId ) ).toEqual([ 's2', 's1' ])
  } )

  it('renders a block the executive actually reads', () => {
    // `conversation.sent` reached NO prompt at all — 57 records in state and the
    // mind's only view of having spoken was a `✓ reach-out` tick mark with no
    // words, no person, and an assertion that it had worked.
    const factory = code('cognition/faculties/executive.engine/prompt.factory.ts')
    expect( factory ).toContain("## What I've Said Lately")
    expect( factory ).toContain('_buildSpokenTurnsSection')
    expect( code('cognition/faculties/executive.engine/context.ts') ).toContain('readSpokenTurns')
  } )

  it('states the fact and NOTHING about what to do with it', () => {
    // The point of the whole change. The mind is allowed to say a thing twice;
    // someone ignored about something urgent SHOULD say it a third time. What it
    // lacked was the ability to tell a first asking from an eleventh — so this is
    // a percept, and any imperative here would make it a rule instead.
    const factory = code('cognition/faculties/executive.engine/prompt.factory.ts')
    const start   = factory.indexOf("## What I've Said Lately")
    const block   = factory.slice( start - 900, start + 700 )
    for( const directive of [
      'do not repeat', "don't repeat", 'avoid repeating', 'stop asking',
      'wait for', 'do not send again', 'should not ask again',
    ] )
      expect( block.toLowerCase() ).not.toContain( directive )
  } )

  it('carries real state all the way into a rendered prompt', async () => {
    // The three code-shape checks above prove the block EXISTS. This proves it is
    // reachable — the failure mode that shipped a complete, tested deliberation
    // cache whose `enableCache()` had zero callers.
    const s = freshState()
    s.tick = 300
    sent( s, 's-open',   'discord:1', 240 )
    sent( s, 's-closed', 'discord:1', 100, { answeredAt: 120, preview: 'Thanks — got it' } )

    const ctx = await buildExecutiveContext(
      { tick: 300, metrics: new Map(), entities: s.entities } as never,
      { workingMemory: null, goalManager: null, semanticIntegrator: null, episodicConsolidator: null } as never,
    )

    expect( ctx.spokenTurns ).toHaveLength( 2 )
    expect( ctx.spokenTurns[0] ).toMatchObject({ target: 'Fabrice', age: 60, answered: false })
    expect( ctx.spokenTurns[1] ).toMatchObject({ answered: true })

    const rendered = PromptFactory.buildUserMessage({
      context:              ctx,
      state:                { tick: 300, metrics: new Map(), entities: s.entities } as never,
      qualityModulation:    1,
      epistemicUncertainty: 0.3,
      deps:                 { summarizer: null } as never,
      focus:                { title: 'T', content: 'focus body' } as never,
      mode:                 'master',
    } as never )
    expect( rendered ).toContain("## What I've Said Lately")
    expect( rendered ).toContain('no answer yet')
    expect( rendered ).toContain('they answered')
    expect( rendered ).toContain('Quick question about Q3')
  } )

  it('admits it cannot tell WHY nobody answered', () => {
    // Asked once what was wrong with her, a live Will invented three attention
    // demands with salience 0.71 apiece. Where a gap is left, it gets filled.
    const factory = code('cognition/faculties/executive.engine/prompt.factory.ts')
    expect( factory ).toContain('It does not tell me why')
  } )
} )

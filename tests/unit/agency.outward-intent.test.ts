// ─────────────────────────────────────────────────────────────
// tests/unit/agency.outward-intent.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * An intention toward a third party must survive the machinery.
 *
 * Observed in a live run (Lora, tick 328): a conversation facet talking to Fabrice
 * emitted TWO reach-out actions in one decision —
 *
 *   { type: 'reach-out', target: 'discord:1019…', args: { content: "Got it. I'll
 *     reach out to FKEM now and set that up." } }
 *   { type: 'reach-out', target: 'FKEM', args: { content: 'Fabrice wants to set up
 *     a full demo… Can you coordinate a meeting for that?' } }
 *
 * The mind did everything right: it named the person, wrote the message, and told
 * Fabrice it was handling it. Only the first bubble was delivered. The second
 * action was discarded — `extractDecision` read `output.actions` solely to test for
 * 'escalate' and dropped the rest — so it reached nobody, became no intent,
 * competed in nothing, and left no reafference. From the inside the mind had made
 * contact; FKEM never heard from it.
 *
 * Two independent leaks are pinned here, either of which alone loses the message:
 *   1. the facet dropping a third-party action (partitionOutwardIntents), and
 *   2. the master silently skipping an addressee it cannot resolve
 *      (buildIdeomotorIntents' `continue` on an unknown name).
 */

import { describe, it, expect } from 'vitest'
import { buildStateCommands } from '#faculties/executive.engine/commands'
import type { CommandDependencies } from '#faculties/executive.engine/commands'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import { GenerativeModel } from '#cognition/generative.model'
import { EscalationBuffer, validateFacetHandoff } from '#faculties/executive.engine/escalation.buffer'
import { partitionOutwardIntents } from '#senses/audition.engine/engine'
import { ExecutiveEngine } from '#faculties/executive.engine'
import type { ReadonlySimulationState, ReasoningFootprint, EntityInput } from '#core/types'

// ── harness ───────────────────────────────────────────────────

/** State carrying known-entity dossiers for the people named. */
function stateKnowing( ...people: { keid: string; name?: string }[] ): ReadonlySimulationState {
  const entities = new Map<string, unknown>()
  for( const p of people )
    entities.set( `ke-${p.keid}`, {
      id: `ke-${p.keid}`, type: 'known-entity',
      metadata: { keid: p.keid, kind: 'sentient', ...( p.name ? { name: p.name } : {} ) },
    } )
  return { tick: 1, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
}

const footprint = ( tick: number ) => ( {
  tickObserved: tick, entitiesRead: new Set(), metricsRead: new Set(),
  entitiesModified: new Set(), intendedCommands: {}, source: 'executive-engine',
} as unknown as ReasoningFootprint )

const deps = (): CommandDependencies => ( {
  summarizer: null, goalManager: null, semanticIntegrator: null,
  bus: null, salience: new GenerativeModel(),
} as unknown as CommandDependencies )

/** Reach-out actions with the master's confidence, as the executive emits them. */
function reachOut( ...targets: { target: string; content?: string }[] ): ExecutiveOutputFull {
  return {
    actions: targets.map( t => ( {
      type: 'reach-out', target: t.target,
      ...( t.content ? { args: { content: t.content } } : {} ),
      reasoning: 'r', expectedOutcome: 'o',
    } ) ),
    reasoning: 'thinking', confidence: 0.8,
  } as ExecutiveOutputFull
}

const find = ( set: EntityInput[] | undefined, id: string ) => set?.find( e => e.id === id )
const meta = ( e: EntityInput | undefined ) => ( e?.metadata ?? {} ) as Record<string, unknown>

// ── 1. the master: an addressee it cannot resolve ─────────────

describe('buildIdeomotorIntents — an addressee that resolves to nobody', () => {
  it('creates the intent when the name IS bound to someone it knows', () => {
    const { commands } = buildStateCommands(
      reachOut( { target: 'FKEM', content: 'can you coordinate the demo?' } ),
      footprint( 5 ),
      stateKnowing( { keid: 'discord:1525573163482742907', name: 'FKEM' } ),
      deps(), [],
    )

    const intent = find( commands.set, 'ideomotor-reach-out-discord:1525573163482742907')
    expect( intent ).toBeDefined()
    expect( meta( intent ).targetEntityId ).toBe('discord:1525573163482742907')
    // The master's words are DIRECTION for the outreach facet, never the message
    // itself — carrying them as `content` would put the master in a second,
    // parallel conversation with someone a facet may already be talking to.
    expect( ( meta( intent ).parameters as Record<string, unknown> ).gist )
      .toBe('can you coordinate the demo?')
    // No complaint when the name resolved.
    expect( find( commands.set, 'action.unaddressed') ).toBeUndefined()
  } )

  it('reports the unreachable name instead of dropping the reach-out in silence', () => {
    // The exact live shape: the mind has heard "FKEM" in conversation but the name
    // was never bound to a dossier, so nothing it says can reach him.
    const { commands } = buildStateCommands(
      reachOut( { target: 'FKEM', content: 'can you coordinate the demo?' } ),
      footprint( 5 ),
      stateKnowing( { keid: 'discord:1019376031150379101', name: 'Fabrice' } ),
      deps(), [],
    )

    expect( find( commands.set, 'ideomotor-reach-out-FKEM') ).toBeUndefined()

    const report = find( commands.set, 'action.unaddressed')
    expect( report ).toBeDefined()
    expect( meta( report ).names ).toEqual( [ 'FKEM' ] )
    // Says what happened and what would fix it — an unopposed no-op is
    // indistinguishable from a message that went out and was ignored.
    expect( meta( report ).summary ).toMatch( /no message went out/ )
    expect( meta( report ).summary ).toMatch( /introduce/ )
  } )

  it('does not confuse an unreachable addressee with an unreal action name', () => {
    const { commands } = buildStateCommands(
      reachOut( { target: 'FKEM' } ), footprint( 5 ),
      stateKnowing( { keid: 'discord:1019376031150379101', name: 'Fabrice' } ),
      deps(), [],
    )

    // 'reach-out' is a real stance; only the PERSON was unresolvable.
    expect( find( commands.set, 'action.unresolved') ).toBeUndefined()
    expect( find( commands.set, 'action.unaddressed') ).toBeDefined()
  } )

  it('clears the report once it names someone reachable again', () => {
    const state = stateKnowing( { keid: 'discord:1019376031150379101', name: 'Fabrice' } )
    ;( state.entities as Map<string, unknown> ).set('action.unaddressed', {
      id: 'action.unaddressed', type: 'action.unaddressed', metadata: { names: [ 'FKEM' ] },
    } )

    const { commands } = buildStateCommands(
      reachOut( { target: 'Fabrice', content: 'morning' } ), footprint( 6 ), state, deps(), [],
    )

    // It should read as "that last attempt did not land", not as a standing defect.
    expect( commands.delete ).toContain('action.unaddressed')
  } )

  it('still reports when the mind names an addressee it half-knows but never named', () => {
    // A dossier exists (they have spoken) but no name was ever learned, so the mind
    // has no handle to address them by — the state FKEM was actually in.
    const { commands } = buildStateCommands(
      reachOut( { target: 'FKEM' } ), footprint( 5 ),
      stateKnowing( { keid: 'discord:1525573163482742907' } ),
      deps(), [],
    )

    expect( meta( find( commands.set, 'action.unaddressed') ).names ).toEqual( [ 'FKEM' ] )
  } )
} )

// ── 2. the facet: whose action is this? ──────────────────────

describe('partitionOutwardIntents — a facet action aimed at someone else', () => {
  const BOUND = 'discord:1019376031150379101'
  const NAME  = 'Fabrice'
  const split = ( actions: unknown ) =>
    partitionOutwardIntents( actions as ExecutiveOutputFull['actions'], BOUND, NAME )

  it('carries the third-party action out of the tick-328 decision, verbatim', () => {
    const out = split( [
      { type: 'reach-out', target: BOUND, args: { content: "Got it. I'll reach out to FKEM now and set that up." } },
      { type: 'reach-out', target: 'FKEM', args: { content: 'Fabrice wants to set up a full demo for the new product. Can you coordinate a meeting for that?' } },
    ] )

    expect( out ).toHaveLength( 1 )
    expect( out[0]!.target ).toBe('FKEM')
    expect( out[0]!.gist ).toMatch( /coordinate a meeting/ )
  } )

  it('treats the bound keid and the bound name as the same person', () => {
    // A mind writes whichever it is looking at; the live trace used both forms
    // within a single decision. Either must count as "the person in front of me".
    expect( split( [ { type: 'reach-out', target: BOUND } ] ) ).toEqual( [] )
    expect( split( [ { type: 'reach-out', target: NAME } ] ) ).toEqual( [] )
    expect( split( [ { type: 'reach-out', target: 'fabrice' } ] ) ).toEqual( [] )
  } )

  it('leaves an unaddressed reach-out alone — that is the reply it is already writing', () => {
    expect( split( [ { type: 'reach-out', args: { content: 'sure, on it' } } ] ) ).toEqual( [] )
  } )

  it('ignores actions that are not about saying something to someone', () => {
    expect( split( [
      { type: 'inspect', target: 'FKEM' },
      { type: 'escalate', target: 'FKEM' },
    ] ) ).toEqual( [] )
  } )

  it('reads the addressee from args when the mind puts it there', () => {
    // The output guidelines tell it to put specifics in `args`, so `args.to` is
    // precisely what a well-behaved mind produces.
    expect( split( [ { type: 'message', args: { to: 'Ada', content: 'ping' } } ] )[0]?.target ).toBe('Ada')
    expect( split( [ { type: 'talk', args: { recipient: 'Ada' } } ] )[0]?.target ).toBe('Ada')
  } )

  it('carries a name it cannot resolve rather than pre-filtering it', () => {
    // Whether the mind has any way to reach this person is the master's to notice
    // (action.unaddressed). Dropping it here would restore the original silence.
    const out = split( [ { type: 'reach-out', target: 'somebody-it-never-met' } ] )
    expect( out ).toHaveLength( 1 )
  } )

  it('survives an output with no actions at all', () => {
    expect( split( undefined ) ).toEqual( [] )
    expect( split( [] ) ).toEqual( [] )
  } )
} )

// ── 3. the escalation: an undertaking reaches the master ──────

describe('EscalationBuffer — an undertaking made inside a conversation', () => {
  it('tells the master what it promised, to whom, and that nothing has gone out', () => {
    const buf = new EscalationBuffer()
    buf.push( {
      subjectEntityId: 'discord:1019376031150379101', threadId: 't', tick: 328,
      body: { kind: 'undertaking', reasoning: '', target: 'FKEM', gist: 'Fabrice wants a full demo — can you coordinate a meeting?' },
    } )

    const { percepts } = buf.drainToPercepts()
    expect( percepts ).toHaveLength( 1 )

    const m = percepts[0]!.metadata as Record<string, unknown>
    expect( m.category ).toBe('undertaking')
    // Everything actionable must be in `summary`: extractPercepts renders only
    // summary/content, so a sibling `directive` field would never reach the mind.
    const summary = m.summary as string
    expect( summary ).toMatch( /I said I would reach FKEM/ )
    expect( summary ).toMatch( /coordinate a meeting/ )
    expect( summary ).toMatch( /Nothing has gone to them yet/ )
    expect( m.directive ).toBeUndefined()
  } )

  it('keeps two undertakings from one conversation distinct rather than collapsing them', () => {
    // Same entity, same tick: keying on (entity, tick) alone silently kept only the
    // last, losing one of two things the mind decided to do.
    const buf = new EscalationBuffer()
    const base = { subjectEntityId: 'discord:1019', threadId: 't', tick: 42 }
    buf.push( { ...base, body: { kind: 'undertaking' as const, reasoning: '', target: 'FKEM' } } )
    buf.push( { ...base, body: { kind: 'undertaking' as const, reasoning: '', target: 'Ada' } } )

    const { percepts } = buf.drainToPercepts()
    expect( new Set( percepts.map( p => p.id ) ).size ).toBe( 2 )
    expect( percepts.map( p => ( p.metadata as Record<string, unknown> ).summary ) )
      .toEqual( [ expect.stringMatching( /reach FKEM/ ), expect.stringMatching( /reach Ada/ ) ] )
  } )

  it('gives a plain task escalation its steer IN the summary, where it is read', () => {
    // The steer used to live in a sibling `directive` field. `extractPercepts`
    // renders summary/content and nothing else, so it never once reached the
    // master in the whole life of that field.
    const buf = new EscalationBuffer()
    buf.push( { subjectEntityId: 'e', threadId: 't', tick: 9, body: { kind: 'escalation', reasoning: 'they want the repo set up' } } )

    const m = buf.drainToPercepts().percepts[0]!.metadata as Record<string, unknown>
    expect( m.category ).toBe('task-escalation')
    expect( m.summary ).toMatch( /they want the repo set up/ )
    expect( m.summary ).toMatch( /mine to plan or re-goal/ )
    expect( m.directive ).toBeUndefined()
  } )
} )

// ── 4. an undertaking has to be able to end ──────────────────

/**
 * The percept that stops a promise being forgotten made it impossible to believe
 * one had been kept.
 *
 * Measured on a live Will: SEVEN undertaking percepts accumulated in state, every
 * one still asserting "Nothing has gone to them yet", while a `conversation.sent`
 * to that person sat beside them. She re-read seven standing unfulfilled promises
 * every cycle and re-sent the same relay five times in five minutes, then again in
 * the following session. Nothing retired them and nothing deduplicated them.
 *
 * Discharge is by EVIDENCE — a `conversation.sent` to that target no older than
 * the promise. That record snapshots with the state, so a kept promise stays kept
 * across a restart, which tick-scoped satiation cannot manage.
 */
describe('undertakings are discharged by having made the contact', () => {
  const FKEM    = 'discord:1525573163482742907'
  const FABRICE = 'discord:1019376031150379101'

  /** The engine's private reconciler — internals on purpose; the wiring is what matters. */
  const reconcile = ( engine: ExecutiveEngine, incoming: EntityInput[], state: ReadonlySimulationState ) =>
    ( engine as unknown as {
      _reconcileUndertakings( i: EntityInput[], s: ReadonlySimulationState ): { keep: EntityInput[]; discharge: string[] }
    } )._reconcileUndertakings( incoming, state )

  const undertaking = ( id: string, target: string, madeAt: number ): EntityInput => ({
    id, type: 'percept',
    metadata: { category: 'undertaking', undertakingTarget: target, tick: madeAt, summary: 'I said I would reach them' },
  })

  const sentTo = ( target: string, at: number ) => ({
    id: `conv-sent-${ target }-${ at }`, type: 'conversation.sent',
    metadata: { targetEntityId: target, tick: at },
  })

  const stateOf = ( ...entities: { id: string; type: string; metadata?: unknown }[] ) =>
    ({ tick: 300, entities: new Map( entities.map( e => [ e.id, e ] ) ) } as unknown as ReadonlySimulationState )

  it('retires a promise once the contact has been made', () => {
    const state = stateOf( undertaking('u1', FKEM, 100 ), sentTo( FKEM, 120 ) )
    const { discharge } = reconcile( new ExecutiveEngine(), [], state )
    expect( discharge ).toEqual( [ 'u1' ] )
  } )

  it('keeps one whose contact has NOT been made', () => {
    const state = stateOf( undertaking('u1', FKEM, 100 ) )
    expect( reconcile( new ExecutiveEngine(), [], state ).discharge ).toEqual( [] )
  } )

  it('does not count a message sent BEFORE the promise as keeping it', () => {
    // Having messaged someone yesterday is not having relayed what you promised today.
    const state = stateOf( undertaking('u1', FKEM, 200 ), sentTo( FKEM, 120 ) )
    expect( reconcile( new ExecutiveEngine(), [], state ).discharge ).toEqual( [] )
  } )

  it('does not let a message to one person discharge a promise to another', () => {
    const state = stateOf( undertaking('u1', FKEM, 100 ), sentTo( FABRICE, 150 ) )
    expect( reconcile( new ExecutiveEngine(), [], state ).discharge ).toEqual( [] )
  } )

  it('refuses to restate a promise it is already carrying', () => {
    // How seven piled up: every master cycle drained a fresh copy of a promise
    // that could never be marked kept.
    const state = stateOf( undertaking('u1', FKEM, 100 ) )
    const { keep } = reconcile( new ExecutiveEngine(), [ undertaking('u2', FKEM, 180 ) ], state )
    expect( keep ).toEqual( [] )
  } )

  it('refuses an incoming promise that is already honoured on arrival', () => {
    const state = stateOf( sentTo( FKEM, 150 ) )
    const { keep } = reconcile( new ExecutiveEngine(), [ undertaking('u1', FKEM, 100 ) ], state )
    expect( keep ).toEqual( [] )
  } )

  it('admits a genuinely new promise toward someone else', () => {
    const state = stateOf( undertaking('u1', FKEM, 100 ) )
    const { keep } = reconcile( new ExecutiveEngine(), [ undertaking('u2', FABRICE, 180 ) ], state )
    expect( keep.map( k => k.id ) ).toEqual( [ 'u2' ] )
  } )

  it('retires an undertaking that predates the target field — it can never be matched', () => {
    // Seven of these sat in a live snapshot, each asserting "nothing has gone to
    // them yet" on every cycle with no way to ever be discharged.
    const legacy: EntityInput = {
      id: 'old-u', type: 'percept',
      metadata: { category: 'undertaking', summary: 'I said I would reach them' },
    }
    const state = stateOf( { ...legacy, metadata: legacy.metadata } as never )
    expect( reconcile( new ExecutiveEngine(), [], state ).discharge ).toEqual( [ 'old-u' ] )
  } )

  it('leaves ordinary task escalations alone', () => {
    const task: EntityInput = {
      id: 'esc1', type: 'percept',
      metadata: { category: 'task-escalation', summary: 'they want the repo set up' },
    }
    const { keep, discharge } = reconcile( new ExecutiveEngine(), [ task ], stateOf() )
    expect( keep.map( k => k.id ) ).toEqual( [ 'esc1' ] )
    expect( discharge ).toEqual( [] )
  } )
} )

// ── 5. the handoff channel belongs to every facet, not to audition ───

describe('executive.facet.handoff — one channel, any facet type', () => {
  it('renders a handoff from a facet with no person in its focus', () => {
    // The whole reason the topic was generalised. A planning or supervision facet
    // has no `entityId`/`threadId` — the old conversation-shaped payload could not
    // express one, so those facets had no way to hand anything to the master at all.
    const buf = new EscalationBuffer()
    buf.push( { facetId: 'facet-3', tick: 12, body: { kind: 'escalation', reasoning: 'the deploy step keeps failing' } } )

    const m = buf.drainToPercepts().percepts[0]!.metadata as Record<string, unknown>
    expect( m.category ).toBe('task-escalation')
    expect( m.summary ).toMatch( /the deploy step keeps failing/ )
    // Degrades to a truthful phrasing rather than inventing a conversation.
    expect( m.summary ).toMatch( /my own focused work/ )
    expect( m.entityId ).toBeUndefined()
  } )

  it('prefers the person\'s NAME over their id when it has one', () => {
    const buf = new EscalationBuffer()
    buf.push( {
      subjectEntityId: 'discord:1019', subjectName: 'Fabrice', tick: 5,
      body: { kind: 'undertaking', reasoning: '', target: 'FKEM' },
    } )
    expect( ( buf.drainToPercepts().percepts[0]!.metadata as Record<string, unknown> ).summary )
      .toMatch( /In my conversation with Fabrice/ )
  } )

  it('takes its requester context from a handoff that actually had one', () => {
    // A keyless handoff drained alongside a conversation one must not blank the
    // requester used to tag the goals the master creates in response.
    const buf = new EscalationBuffer()
    buf.push( { facetId: 'facet-3', tick: 1, body: { kind: 'escalation', reasoning: 'a' } } )
    buf.push( { subjectEntityId: 'discord:1019', threadId: 't', tick: 2, body: { kind: 'escalation', reasoning: 'b' } } )

    expect( buf.drainToPercepts().requester ).toEqual( { entityId: 'discord:1019', threadId: 't' } )
  } )
} )

describe('validateFacetHandoff — the bus checks the shape, not each caller', () => {
  it('accepts both kinds', () => {
    expect( validateFacetHandoff({ body: { kind: 'escalation', reasoning: 'r' } }) ).toBeNull()
    expect( validateFacetHandoff({ body: { kind: 'undertaking', target: 'FKEM' } }) ).toBeNull()
  } )

  it('rejects an undertaking with nobody to reach — it could never be discharged', () => {
    // A target-less undertaking asserts "nothing has gone to them yet" forever:
    // _reconcileUndertakings keys discharge on the target, so it can never be
    // matched against a contact. Seven of these were found in one live snapshot.
    expect( validateFacetHandoff({ body: { kind: 'undertaking' } }) ).toMatch( /target/ )
    expect( validateFacetHandoff({ body: { kind: 'undertaking', target: '  ' } }) ).toMatch( /target/ )
  } )

  it('rejects a body it does not know, rather than dropping it silently', () => {
    expect( validateFacetHandoff({ body: { kind: 'telepathy' } }) ).toMatch( /unknown handoff kind/ )
    expect( validateFacetHandoff({}) ).toMatch( /body is required/ )
  } )
} )

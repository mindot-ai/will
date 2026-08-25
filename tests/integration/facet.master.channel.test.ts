// ─────────────────────────────────────────────────────────────
// tests/integration/facet.master.channel.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The facet → master channel, over the real bus wiring.
 *
 * This channel was dead in production for its entire life, and nothing caught it
 * because every test exercised the handlers directly rather than through the bus.
 *
 * `CognitiveBus.subscribe` stores ONE subscription per engineId —
 * `this._subscriptions.set( engineId, { engineId, topics, handler } )` — so a
 * second `subscribe( this.name, … )` silently replaces the first. The executive
 * registered two dedicated handlers in `attachBus` (facet.sync, then
 * executive.facet.handoff — the second already clobbering the first), and
 * `CognitiveOrchestrator.addEngine` then called
 * `subscribe( engine.name, engine.subscribes(), ev => engine.onCognitiveEvent( ev ) )`
 * immediately afterwards, replacing that one too.
 *
 * Net effect: a conversation facet could escalate work to the master, the audition
 * engine published the handoff, and NOBODY was listening. `_escalations`
 * was never fed, so `drainToPercepts()` never had anything to drain and the master
 * never learned what its own facets had surfaced.
 *
 * Both legs are now dispatched from `onCognitiveEvent` — the engine's only live
 * subscription. These tests publish on a real bus with the real registration order
 * so a future dedicated `subscribe()` cannot quietly re-break it.
 */

import { describe, it, expect, vi } from 'vitest'
import { createTestBus } from '#cognition/bus'
import { ExecutiveEngine } from '#faculties/executive.engine'

vi.spyOn( console, 'info').mockImplementation( () => {} )

/**
 * Wire the engine exactly as CognitiveOrchestrator.addEngine does — attachBus
 * first, THEN the declared-topics subscription. The order is the hazard.
 */
function wired(){
  const bus    = createTestBus()
  const engine = new ExecutiveEngine()

  engine.attachBus( bus )
  bus.subscribe( engine.name, engine.subscribes(), ev => { engine.onCognitiveEvent( ev ) } )

  return { bus, engine }
}

/**
 * Private state, read directly. These are internals on purpose: widening the
 * engine's public API so a test can look at it would be a worse trade than the
 * cast, and what is under test is the WIRING, not an interface.
 */
const priv = ( e: ExecutiveEngine ) => e as unknown as {
  _escalations: { drainToPercepts(): { percepts: { metadata: unknown }[]; intents: { metadata: Record<string, unknown> }[] } }
  _facetSubjects: Map<string, { entityId: string; name?: string; tick: number }>
}

const publish = ( bus: ReturnType<typeof createTestBus>, type: string, payload: unknown, sourceEngine: string ) => {
  bus.publish( { type, version: 1, sourceEngine, salience: 0.9, payload } as never )
  bus.flush()
}

describe('facet → master channel survives the orchestrator\'s subscription', () => {
  it('delivers a facet escalation to the master as a percept it can actually read', () => {
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.handoff', {
      subjectEntityId: 'discord:1019', threadId: 't', confidence: 0.8,
      body: { kind: 'escalation', reasoning: 'they want the repo set up' },
    }, 'audition-engine')

    const { percepts } = priv( engine )._escalations.drainToPercepts()
    expect( percepts ).toHaveLength( 1 )
    expect( ( percepts[0]!.metadata as Record<string, unknown> ).summary )
      .toMatch( /they want the repo set up/ )
  } )

  it('delivers an undertaking toward a third party — the FKEM case, end to end', () => {
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.handoff', {
      subjectEntityId: 'discord:1019', threadId: 't', confidence: 0.85,
      body: { kind: 'undertaking', reasoning: '', target: 'FKEM', gist: 'can you coordinate the demo meeting?' },
    }, 'audition-engine')

    const drained = priv( engine )._escalations.drainToPercepts()
    const m = drained.percepts[0]!.metadata as Record<string, unknown>
    expect( m.category ).toBe('undertaking')
    expect( m.summary ).toMatch( /I said I would reach FKEM/ )
    expect( m.summary ).toMatch( /Nothing has gone to them since/ )
    // The notice arrives with the pull beside it, as a competing candidate
    // rather than as a sentence telling the master to enact `reach-out`.
    expect( drained.intents[0]!.metadata!['targetEntityId'] ).toBe('FKEM')
  } )

  it('learns who each facet is with from the sync, not just that one reported', () => {
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.sync', {
      facetId: 'facet-1', reasoning: 'r', confidence: 0.8, tick: 12,
      subjectEntityId: 'discord:1019', subjectName: 'Fabrice',
    }, 'executive-facet-facet-1')

    expect( [ ...priv( engine )._facetSubjects.entries() ] )
      .toEqual( [ [ 'facet-1', { entityId: 'discord:1019', name: 'Fabrice', tick: 12 } ] ] )
  } )

  it('ignores the engine\'s own events without swallowing its facets\'', () => {
    const { bus, engine } = wired()

    // A facet publishes as `executive-facet-<id>`, never as the engine itself —
    // the self-echo guard in onCognitiveEvent must not filter it out.
    publish( bus, 'executive.facet.sync', {
      facetId: 'facet-2', confidence: 0.7, tick: 3,
      subjectEntityId: 'discord:1525', subjectName: 'FKEM',
    }, 'executive-engine')
    expect( priv( engine )._facetSubjects.size ).toBe( 0 )

    publish( bus, 'executive.facet.sync', {
      facetId: 'facet-2', confidence: 0.7, tick: 3,
      subjectEntityId: 'discord:1525', subjectName: 'FKEM',
    }, 'executive-facet-facet-2')
    expect( priv( engine )._facetSubjects.size ).toBe( 1 )
  } )
} )

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
  _escalations: { drainToPercepts(): { percepts: { metadata: unknown }[] } }
  _facetSubjects: Map<string, { entityId: string; name?: string; tick: number
                              concluded?: string; promised?: Array<{ target: string; gist?: string; tick: number }> }>
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

  it('files an undertaking with the thread it was made in — the FKEM case, end to end', () => {
    // It produces no percept and no standing intent now. A promise crosses on the
    // same tract as everything else the facet worked out, and the master reads it
    // at its next cycle.
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.sync', {
      facetId: 'facet-1', reasoning: 'He wants a demo; FKEM has to be in it.', confidence: 0.85, tick: 12,
      subjectEntityId: 'discord:1019', subjectName: 'Fabrice',
    }, 'executive-facet-facet-1')

    publish( bus, 'executive.facet.handoff', {
      facetId: 'facet-1', subjectEntityId: 'discord:1019', threadId: 't', confidence: 0.85, tick: 13,
      body: { kind: 'undertaking', reasoning: '', what: 'reach FKEM', target: 'FKEM', gist: 'can you coordinate the demo meeting?' },
    }, 'audition-engine')

    // Nothing queued as work for the master — an undertaking is not a task.
    expect( priv( engine )._escalations.drainToPercepts().percepts ).toHaveLength( 0 )

    const at = priv( engine )._facetSubjects.get('facet-1')!
    expect( at.promised ).toEqual( [ { what: 'reach FKEM', target: 'FKEM', gist: 'can you coordinate the demo meeting?', tick: 13 } ] )
  } )

  it('files a promise even when it arrives before the first sync', () => {
    // A facet can hand something up before it syncs. Requiring the entry to exist
    // first made that promise vanish with nothing saying it ever existed.
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.handoff', {
      facetId: 'facet-9', subjectEntityId: 'discord:1019', threadId: 't', confidence: 0.8, tick: 5,
      body: { kind: 'undertaking', reasoning: '', what: 'reach FKEM', target: 'FKEM' },
    }, 'audition-engine')

    expect( priv( engine )._facetSubjects.get('facet-9')?.promised )
      .toEqual( [ { what: 'reach FKEM', target: 'FKEM', tick: 5 } ] )
  } )

  it('learns who each facet is with AND what it worked out there', () => {
    // The return leg. `reasoning` has always been on this payload; the master read
    // it into a local and dropped it, so its own thinking came back as a name.
    const { bus, engine } = wired()

    publish( bus, 'executive.facet.sync', {
      facetId: 'facet-1', reasoning: 'He is asking for a demo and I think it is worth doing.',
      confidence: 0.8, tick: 12,
      subjectEntityId: 'discord:1019', subjectName: 'Fabrice',
    }, 'executive-facet-facet-1')

    expect( [ ...priv( engine )._facetSubjects.entries() ] ).toEqual( [ [ 'facet-1', {
      entityId: 'discord:1019', name: 'Fabrice', tick: 12,
      concluded: 'He is asking for a demo and I think it is worth doing.',
    } ] ] )
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

describe('and the master actually reads it', () => {
  it('renders what I worked out elsewhere, and what I promised there', async () => {
    // The delivery half. Routing this through a percept could not have worked: a
    // percept is swept at +2 ticks and decays out of working memory at about +9,
    // while the master's own interval is 15 — so the notice was usually gone
    // before the seat it was addressed to next ran. Held on the engine and
    // rendered, it survives to that cycle by construction.
    const { PromptFactory }      = await import('#faculties/executive.engine/prompt.factory')
    const { buildExecutiveContext } = await import('#faculties/executive.engine/context')

    const state = { tick: 120, time: 0, entities: new Map(),
                    metrics: new Map([ [ 'energy.level', 70 ] ]) } as never
    const deps  = { workingMemory:      { getItems: () => [] },
                    goalManager:        { getActiveGoals: () => [] },
                    semanticIntegrator: { getBeliefs: () => [] } } as never
    const context = await buildExecutiveContext( state, deps )

    const prompt = PromptFactory.buildUserMessage({
      state, context, deps, focus: { title: '', content: '' },
      activeConversations: [ {
        entityId: 'discord:1019', name: 'Fabrice', sinceTick: 12,
        concluded: 'He is asking for a demo and I think it is worth doing.',
        promised:  [ { what: 'reach FKEM', target: 'FKEM', gist: 'coordinate the demo meeting', tick: 13 },
                     { what: 'have the scoping doc ready by Friday', tick: 14 } ],
      } ],
    } as never )

    expect( prompt ).toContain('## In Conversation Now')
    expect( prompt ).toContain('What I worked out there: He is asking for a demo')
    expect( prompt ).toContain('I said there that I would reach FKEM')
    expect( prompt ).toContain('Saying it in that thread did not send it.')

    // A promise that is not a contact carries no such clause — only a CONTACT
    // can be mistaken for already done by having been said.
    expect( prompt ).toContain('I said there that I would have the scoping doc ready by Friday')
    const workLine = prompt.split('\n').find( l => l.includes('scoping doc ready by Friday') )!
    expect( workLine ).not.toContain('did not send it')

    // Stated as a fact and left there. What to do about it — keep it, drop it,
    // make a goal of it — is the mind's, and it has a faculty for that.
    expect( prompt ).not.toMatch( /If I still mean it/ )
    expect( prompt ).not.toMatch( /I reach out with target/ )
  } )
} )

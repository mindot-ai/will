// ─────────────────────────────────────────────────────────────
// tests/unit/settle.holders.test.ts
// ─────────────────────────────────────────────────────────────
//
// Every place a mind starts work outside a tick says when that work is done
// (`awaitPending`), so archiving can wait for all of it: the executive (its own
// call, its facets', the summariser's), each facet, audition's per-person turn
// queue, and motor's outreach authoring. Each is driven with work that is still
// running when it is asked, and must not settle before that work has.

import { describe, it, expect } from 'vitest'
import { assembleMind, type WillConfig } from '#stem/mind'
import { ExecutiveSummarizer } from '#llm/summarizer'
import { ExecutiveFacet } from '#cognition/faculties/executive.engine/facet'
import { FacetSupervisor } from '#cognition/faculties/executive.engine/facet.supervisor'

const sleep = ( ms: number ) => new Promise<void>( r => setTimeout( r, ms ) )
type Any = Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

const config = ( id: string ): WillConfig => ( {
  id, name: 'Holder', profile: null,
  identity: { prompt: 'I hold work.', values: [], traits: {}, style: 'plain' },
  anatomy: 'mind', persistentMemory: false, snapshotInterval: 999_999,
  randomSeed: 2, testMode: true, disableVectorMemory: true,
} as WillConfig )

describe('awaitPending — each holder of work in flight', () => {
  it('the summariser settles after the summary it was computing', async () => {
    const s = new ExecutiveSummarizer( { summaryInterval: 1 } )
    s.attachLLMDirector( { call: () => sleep( 150 ).then( () => ( { text: 'what happened', inputTok: 0, outputTok: 0 } ) ) } as never )
    s.record('a cycle')
    expect( s.isBusy ).toBe( true )
    await s.awaitPending()
    expect( s.current ).toBe('what happened')
    await new ExecutiveSummarizer().awaitPending()   // nothing ever ran: settles at once
  })

  it('a facet settles after every reasoning it launched', async () => {
    let done = 0
    const facet = Object.create( ExecutiveFacet.prototype ) as Any
    Object.assign( facet, {
      facetId: 'f', _inflight: 0, _running: new Set(), _pendingReports: [], _lastActiveTick: 0, _currentStateRef: null,
      _reason: () => sleep( 120 ).then( () => { done++ } ),
    } )
    facet._launchReason( { type: 'a' } )
    facet._launchReason( { type: 'b' } )
    await facet.awaitPending()
    expect( done ).toBe( 2 )
    expect( facet.busy ).toBe( false )
    expect( facet._running.size ).toBe( 0 )
  })

  it('the supervisor settles after every live facet', async () => {
    const sup = new FacetSupervisor() as never as Any
    const finished: string[] = []
    for( const id of [ 'f1', 'f2' ] )
      sup._facets.set( id, { awaitPending: () => sleep( 100 ).then( () => { finished.push( id ) } ) } )
    await sup.awaitPending()
    expect( finished.sort() ).toEqual( [ 'f1', 'f2' ] )
  })

  it('the executive settles after its own call, then its facets\' and the summariser\'s', async () => {
    const { cognition } = assembleMind('exec-holder', config('exec-holder') )
    const exec = cognition.executiveEngine as never as Any
    const order: string[] = []
    exec._facetSupervisor = { awaitPending: () => sleep( 80 ).then( () => { order.push('facets') } ) }
    exec._summarizer      = { awaitPending: () => sleep( 40 ).then( () => { order.push('summary') } ) }
    // Its own call in flight, as AsyncEngine.react() leaves one.
    exec._pending.set('executive-1-tick1', { promise: sleep( 200 ).then( () => { order.push('own') } ) } )
    await exec.awaitPending()
    expect( order ).toEqual( [ 'own', 'facets', 'summary' ] )
  })

  it('audition settles after every queued turn, including one a running turn queues behind itself', async () => {
    const { cognition } = assembleMind('audition-holder', config('audition-holder') )
    const audition = cognition.auditionEngine as never as Any
    const turns: string[] = []
    audition._enqueue('ada', () => sleep( 80 ).then( () => {
      turns.push('first')
      audition._enqueue('ada', () => sleep( 80 ).then( () => { turns.push('behind it') } ) )
    } ) )
    audition._enqueue('bo', () => sleep( 40 ).then( () => { turns.push('another person') } ) )
    await audition.awaitPending()
    expect( turns.sort() ).toEqual( [ 'another person', 'behind it', 'first' ] )
  })

  it('audition, detached, releases a turn waiting on the mind and starts no queued one', async () => {
    const { cognition } = assembleMind('audition-detach', config('audition-detach') )
    const audition = cognition.auditionEngine as never as Any
    const seen: string[] = []
    // A turn that has routed to the facet and waits for its decision.
    audition._enqueue('ada', async () => { seen.push('waiting'); await audition._beginTurn('ada'); seen.push('released') } )
    // A message behind it: coalesced, so it would run a whole turn.
    const queued = { base: { kind: 'text', entityId: 'ada', content: 'and another thing' }, parts: [ 'and another thing' ], started: false, done: null, resolve: () => { seen.push('queued settled') } }
    audition._enqueue('ada', () => { seen.push('queued began'); return audition._runCoalesced('ada', queued ) } )
    // A turn that runs would process the message: recall, route, wait again.
    audition._processMessage = async () => { seen.push('processed') }
    await sleep( 20 )
    expect( seen ).toEqual( [ 'waiting' ] )

    // Promptly — not at the turn's 60-second safety timeout.
    const started = Date.now()
    await audition.onDetach()
    await audition.awaitPending()
    expect( seen ).toEqual( [ 'waiting', 'released', 'queued began', 'queued settled' ] )
    expect( audition.isSpeakingTo('ada') ).toBe( false )
    // And after detaching, a turn does not wait at all.
    await audition._beginTurn('bo')
    expect( Date.now() - started ).toBeLessThan( 1_000 )
  }, 10_000 )

  it('audition, detached, releases outreach being authored — its facet will not now decide — and opens no more', async () => {
    const { cognition } = assembleMind('outreach-detach', config('outreach-detach') )
    const audition = cognition.auditionEngine as never as Any
    let spawned = 0
    // A facet that takes the report and never decides: what a stopped mind is.
    const facet = { facetId: 'o', subscribe: () => () => {}, report: async () => {}, destroy: () => {} }
    audition._executiveEngine = { facetFor: () => null, spawnFacet: () => { spawned++; return { attention: 'free', handle: facet } } }

    const authoring = audition.authorOutreach('ada', 'Ada', 'the plan')
    await sleep( 20 )
    expect( spawned ).toBe( 1 )

    const started = Date.now()
    await audition.onDetach()
    expect( await authoring ).toEqual( { bubbles: [] } )
    expect( Date.now() - started ).toBeLessThan( 1_000 )   // not its 60-second timeout
    expect( audition._outreachWaits.size ).toBe( 0 )
    expect( await audition.authorOutreach('bo', 'Bo') ).toEqual( { bubbles: [] } )
    expect( spawned ).toBe( 1 )
  }, 10_000 )

  it('motor settles after the outreach it asked to be authored', async () => {
    const { cognition } = assembleMind('motor-holder', config('motor-holder') )
    const motor = cognition.motorSchemaExecutor as never as Any
    motor.attachOutreachAuthor( { authorOutreach: () => sleep( 120 ).then( () => [ 'hello again' ] ) } )
    motor._requestAuthoring('i1', { schema: 'reach_out', parameters: {}, targetEntityId: 'ada' }, 1 )
    await motor.awaitPending()
    expect( motor._authored.get('i1') ).toEqual( [ 'hello again' ] )
    expect( motor._authorRuns.size ).toBe( 0 )
  })
})

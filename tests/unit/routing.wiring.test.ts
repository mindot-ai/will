// ─────────────────────────────────────────────────────────────
// tests/unit/routing.wiring.test.ts — MODEL_ROUTING W6
//
// The seam existed but was unreachable: `router` lived on the internal
// LLMDirectorConfig and nothing threaded it from WillConfig, so a host using
// the SDK could not route at all. These tests assert the whole path —
// WillConfig.llm.router → the stem → every director the executive builds.
//
// The completion tape is the probe: it records the provider+model that actually
// served each call, which is also the property replay depends on.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { assembleMind } from '#stem/mind'
import type { WillConfig } from '#stem/mind'
import { TableRouter, NULL_ROUTER } from '#llm/routing'
import {
  setCompletionRecorder, clearCompletionRecorder,
  type LLMCompletionRecord,
} from '#core/completion.recorder'

function config( id: string, llm?: WillConfig['llm'] ): WillConfig {
  return {
    id, name: 'R', profile: null,
    identity: { prompt: 'routing probe', values: [ 'x' ], traits: {}, style: 'x' },
    anatomy: 'mind',
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 1, executiveInterval: 1, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
    ...( llm ? { llm } : {} ),
  }
}

/** Drive enough ticks for the executive to make at least one call. */
async function tickUntilCall(
  simulation: ReturnType<typeof assembleMind>['simulation'],
  recorded: LLMCompletionRecord[],
  max = 12,
): Promise<void> {
  for( let i = 0; i < max && recorded.length === 0; i++ ){
    await simulation.step( 1 )
  }
}

/**
 * Spawn a conversation facet off a live mind and make it reason once.
 *
 * The master's call is tagged `{ category:'executive', attribute:'master',
 * function:'decision' }` — which is precisely the tagging no compiled role rule
 * claims, since the executive role *is* the default. So any assertion about a
 * role model has to come from a facet.
 */
async function driveConversationFacet(
  cognition: ReturnType<typeof assembleMind>['cognition'],
  simulation: ReturnType<typeof assembleMind>['simulation'],
): Promise<void> {
  const { handle } = cognition.executiveEngine.spawnFacet('conversation')
  if( !handle ) throw new Error('facet budget full — cannot drive the probe')

  handle.setFocus( {
    title:    'Active Conversation',
    function: 'conversation',
    content:  'Someone said hello.',
  } )
  await handle.report( { type: 'message', payload: { content: 'hello' } } as never )
  // The facet reasons off the tick pump, not the report itself.
  await simulation.step( 1 )
  handle.destroy()
}

describe('router reaches the engine from WillConfig (W6)', () => {

  let recorded: LLMCompletionRecord[] = []
  const WILL = 'routing-wiring'
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach( () => {
    recorded = []
    // `bun test` auto-loads .env (vitest does not), and WILL_LLM_MODEL pins
    // every thinking role by design — which would mask whatever this test
    // configures. Neutralise both pins so the assertions are about config,
    // not about whoever's .env is on disk.
    for( const k of [ 'WILL_LLM_MODEL', 'WILL_LLM_PROVIDER' ] ){
      savedEnv[ k ] = process.env[ k ]
      delete process.env[ k ]
    }
    setCompletionRecorder( WILL, { recordCompletion: r => { recorded.push( r ) } } )
  })
  afterEach( () => {
    clearCompletionRecorder( WILL )
    for( const [ k, v ] of Object.entries( savedEnv ) ){
      if( v === undefined ) delete process.env[ k ]
      else process.env[ k ] = v
    }
  })

  it('uses the configured default model when no router is set', async () => {
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k', model: 'default-model',
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.length ).toBeGreaterThan( 0 )
    expect( recorded.every( r => r.model === 'default-model' ) ).toBe( true )
  })

  it('NULL_ROUTER is indistinguishable from no router', async () => {
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k', model: 'default-model',
      router: NULL_ROUTER,
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.every( r => r.model === 'default-model' ) ).toBe( true )
  })

  it('follows a configured route — the seam is reachable from WillConfig', async () => {
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k', model: 'default-model',
      providers: { glm: { apiKey: 'glm-key' } },
      router: new TableRouter( [
        { category: 'executive', route: { provider: 'glm', model: 'routed-model' } },
      ] ),
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.length ).toBeGreaterThan( 0 )
    const exec = recorded.filter( r => r.model === 'routed-model')
    expect(
      exec.length,
      `no call routed — the router did not reach the director (models seen: ${
        [ ...new Set( recorded.map( r => r.model ) ) ].join(', ')})`
    ).toBeGreaterThan( 0 )
    expect( exec[0]!.provider ).toBe('glm')
  })

  it('falls back to the default when the routed provider has no credential', async () => {
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k', model: 'default-model',
      // no `providers` entry for google
      router: new TableRouter( [ { route: { provider: 'google', model: 'gemini-x' } } ] ),
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.length ).toBeGreaterThan( 0 )
    expect( recorded.every( r => r.model === 'default-model' ) ).toBe( true )
  })

  it('routes role-configured facets too — a role model cannot bypass the router', async () => {
    // Regression guard: role models used to be served by a separate cached
    // director. Before W6 that cache was built without a router, so a Will
    // configuring `model.summarizer` silently opted that work out of routing.
    // W7 removed the cache outright, which is the permanent fix.
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k',
      model: { executive: 'exec-model', summarizer: 'sum-model' },
      providers: { glm: { apiKey: 'glm-key' } },
      router: new TableRouter( [
        { category: 'executive', route: { provider: 'glm', model: 'routed-model' } },
      ] ),
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.some( r => r.model === 'routed-model' ) ).toBe( true )
  })

  it('serves a role map with no router at all — the map compiles into one (W7)', async () => {
    // The whole point of W7: a host that only ever set `model.summarizer` still
    // gets that model, through the same mechanism as everyone else. Executive
    // work keeps the executive model — a compiled rule must not over-claim.
    const { simulation } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k',
      model: { executive: 'exec-model', summarizer: 'sum-model' },
      // no `router`
    } ) )
    await tickUntilCall( simulation, recorded )

    expect( recorded.length ).toBeGreaterThan( 0 )
    expect( recorded.every( r => r.model === 'exec-model' ),
      `executive work left its model (models seen: ${[ ...new Set( recorded.map( r => r.model ) ) ].join(', ')})`
    ).toBe( true )
    // Every call carries the Will's own provider — a provider-less compiled
    // route must never fall through to some other vendor.
    expect( recorded.every( r => r.provider === 'anthropic' ) ).toBe( true )
  })

  it('gives a conversation facet the role model — the path that lost its director', async () => {
    // A conversation facet used to be handed a *separate* director built for the
    // conversation model. That director is gone; the facet shares the Will's one
    // director and reaches its model through the compiled rule instead. Driving
    // a real facet is the only way to assert that, because the master's own call
    // is the one call no compiled rule ever claims.
    const { simulation, cognition } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k',
      model: { executive: 'exec-model', conversation: 'chatty-model' },
    } ) )
    await tickUntilCall( simulation, recorded )
    recorded.length = 0

    await driveConversationFacet( cognition, simulation )

    expect( recorded.length, 'no facet call was made — the probe itself is broken').toBeGreaterThan( 0 )
    expect( recorded.every( r => r.model === 'chatty-model' ),
      `facet did not take the conversation model (models seen: ${[ ...new Set( recorded.map( r => r.model ) ) ].join(', ')})`
    ).toBe( true )
  })

  it('the host router outranks the role map on a call both claim', async () => {
    // Precedence is inherited, not invented: a router already overrode the
    // role-cached director per call, because the director only supplied the
    // *default* endpoint that the router then got to replace.
    const { simulation, cognition } = assembleMind( WILL, config( WILL, {
      provider: 'anthropic', apiKey: 'k',
      model: { executive: 'exec-model', conversation: 'role-model' },
      router: new TableRouter( [
        { function: 'conversation', route: { model: 'host-model' } },
      ] ),
    } ) )
    await tickUntilCall( simulation, recorded )
    recorded.length = 0

    await driveConversationFacet( cognition, simulation )

    expect( recorded.length ).toBeGreaterThan( 0 )
    expect( recorded.every( r => r.model === 'host-model' ),
      `role map beat the host router (models seen: ${[ ...new Set( recorded.map( r => r.model ) ) ].join(', ')})`
    ).toBe( true )
  })
})

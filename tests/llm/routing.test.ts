// ─────────────────────────────────────────────────────────────
// tests/llm/routing.test.ts — MODEL_ROUTING W2/W4
//
// The seam's invariants, in the order they matter:
//   1. absent router ⇒ byte-identical to the pre-seam engine (it ships dark)
//   2. `demand` absent means UNKNOWN, never zero
//   3. a routing problem degrades to the default — it never kills a call
//   4. the completion tape records the endpoint that ACTUALLY served the call,
//      which is what makes replay survive routing
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  LLMDirector, BACKGROUND_DEMAND, ESCALATION_DEMAND,
  type LLMCallMeta, type LLMDirectorConfig,
} from '#llm/index'
import {
  NULL_ROUTER, TableRouter, isNullRouter, chainRouters,
  type ModelRouter, type ModelRoute,
} from '#llm/routing'
import { compileRoleRouter } from '#stem/mind'
import {
  setCompletionRecorder, clearCompletionRecorder,
  type LLMCompletionRecord,
} from '#core/completion.recorder'

const meta = ( over: Partial<LLMCallMeta> = {} ): LLMCallMeta => ( {
  category: 'executive', attribute: 'master', process: 'decision', function: '-', ...over,
} )

// ── TableRouter matching ──────────────────────────────────────

describe('TableRouter', () => {

  const cheap: ModelRoute = { provider: 'glm',       model: 'cheap-model' }
  const rich:  ModelRoute = { provider: 'anthropic', model: 'rich-model'  }

  it('returns null when nothing matches — "no opinion", not a guess', () => {
    const r = new TableRouter( [ { category: 'summarizer', route: cheap } ] )
    expect( r.route( meta({ category: 'executive' }) ) ).toBeNull()
  })

  it('matches on the attribution axes, first rule winning', () => {
    const r = new TableRouter( [
      { category: 'executive', attribute: 'facet', route: cheap },
      { category: 'executive',                     route: rich  },
    ] )
    expect( r.route( meta({ attribute: 'facet'  }) ) ).toEqual( cheap )
    expect( r.route( meta({ attribute: 'master' }) ) ).toEqual( rich  )
  })

  it('treats every present condition as AND', () => {
    const r = new TableRouter( [
      { category: 'executive', attribute: 'master', process: 'ideation', function: '-', route: cheap },
    ] )
    expect( r.route( meta({ process: 'ideation' }) ) ).toEqual( cheap )
    expect( r.route( meta({ process: 'decision' }) ) ).toBeNull()
  })

  describe('demand bounds', () => {

    const r = new TableRouter( [
      { maxDemand: 0.5, route: cheap },
      { minDemand: 0.5, route: rich  },
    ] )

    it('routes low demand cheap and high demand rich', () => {
      expect( r.route( meta({ demand: 0.1 }) ) ).toEqual( cheap )
      expect( r.route( meta({ demand: 0.9 }) ) ).toEqual( rich  )
    })

    it('treats maxDemand as exclusive and minDemand as inclusive at the boundary', () => {
      expect( r.route( meta({ demand: 0.5 }) ) ).toEqual( rich )
    })

    it('ABSENT demand is unknown, not zero — no demand-bounded rule may claim it', () => {
      // The trap this guards: treating a missing measure as 0 silently routes
      // every untagged call to the cheapest model.
      expect( r.route( meta() ) ).toBeNull()
    })

    it('NaN demand is treated as unknown too', () => {
      expect( r.route( meta({ demand: Number.NaN }) ) ).toBeNull()
    })
  })
})

// ── The null default ──────────────────────────────────────────

describe('NULL_ROUTER', () => {
  it('has no opinion about anything', () => {
    expect( NULL_ROUTER.route( meta() ) ).toBeNull()
    expect( NULL_ROUTER.route( meta({ demand: 1 }) ) ).toBeNull()
  })

  it('is recognised as the no-op, as are null/undefined', () => {
    expect( isNullRouter( NULL_ROUTER ) ).toBe( true )
    expect( isNullRouter( null ) ).toBe( true )
    expect( isNullRouter( undefined ) ).toBe( true )
    expect( isNullRouter( new TableRouter( [] ) ) ).toBe( false )
  })
})

// ── Demand constants ──────────────────────────────────────────

describe('demand constants', () => {
  it('are ordered and inside 0..1', () => {
    expect( BACKGROUND_DEMAND ).toBeGreaterThan( 0 )
    expect( BACKGROUND_DEMAND ).toBeLessThan( ESCALATION_DEMAND )
    expect( ESCALATION_DEMAND ).toBeLessThanOrEqual( 1 )
  })
})

// ── Endpoint resolution through a real director ───────────────
//
// Resolution is private, but the completion tape observes it: every call
// records the provider+model that served it. That makes the tape the natural
// (and honest) probe — and asserts the property replay actually depends on.

describe('LLMDirector endpoint resolution', () => {

  const WILL = 'routing-test-will'
  let recorded: LLMCompletionRecord[] = []

  const director = ( over: Partial<LLMDirectorConfig> = {} ) =>
    new LLMDirector({
      willId: WILL,
      model: 'default-model',
      maxOutputTokens: 256,
      apiKey: 'default-key',
      provider: 'anthropic',
      sessionLogger: null,
      mock: true,              // no network; the tape still records the endpoint
      ...over,
    })

  beforeEach( () => {
    recorded = []
    setCompletionRecorder( WILL, { recordCompletion: r => { recorded.push( r ) } } )
  })
  afterEach( () => clearCompletionRecorder( WILL ) )

  it('uses the default endpoint when no router is configured (ships dark)', async () => {
    await director().call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.provider ).toBe('anthropic')
    expect( recorded[0]!.model ).toBe('default-model')
  })

  it('uses the default endpoint under NULL_ROUTER — byte-identical to no router', async () => {
    await director({ router: NULL_ROUTER }).call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.model ).toBe('default-model')
  })

  it('follows a route when a credential for that provider exists', async () => {
    const d = director({
      router: new TableRouter( [ { category: 'summarizer', route: { provider: 'glm', model: 'routed-model' } } ] ),
      credentials: { glm: { apiKey: 'glm-key' } },
    })
    await d.call('sys', 'msg', 1, undefined, meta({ category: 'summarizer' }) )
    expect( recorded[0]!.provider ).toBe('glm')
    expect( recorded[0]!.model ).toBe('routed-model')
  })

  it('reuses the default credential when a route names the default provider', async () => {
    const d = director({
      router: new TableRouter( [ { route: { provider: 'anthropic', model: 'other-claude' } } ] ),
      // no `credentials` map at all
    })
    await d.call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.model ).toBe('other-claude')
  })

  it('falls back to the default when the routed provider has no credential', async () => {
    const d = director({
      router: new TableRouter( [ { route: { provider: 'google', model: 'gemini-x' } } ] ),
      credentials: {},   // nothing for google
    })
    await d.call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.provider ).toBe('anthropic')
    expect( recorded[0]!.model ).toBe('default-model')
  })

  it('falls back to the default when the router throws — a bad router never kills a call', async () => {
    const exploding: ModelRouter = {
      name: 'exploding',
      route(){ throw new Error('boom') },
    }
    const d = director({ router: exploding })
    await expect( d.call('sys', 'msg', 1, undefined, meta() ) ).resolves.toBeDefined()
    expect( recorded[0]!.model ).toBe('default-model')
  })

  it('honours a per-route maxOutputTokens override on the tape', async () => {
    const d = director({
      router: new TableRouter( [ { route: { provider: 'glm', model: 'm', maxOutputTokens: 42 } } ] ),
      credentials: { glm: { apiKey: 'k' } },
    })
    await d.call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.maxOutputTokens ).toBe( 42 )
  })

  it('routes each call independently — concurrent calls do not bleed into each other', async () => {
    // The reason the endpoint is threaded rather than stashed on the instance:
    // the concurrency gate allows several in-flight calls on one director.
    const d = director({
      router: new TableRouter( [
        { category: 'summarizer', route: { provider: 'glm', model: 'cheap' } },
        { category: 'executive',  route: { provider: 'anthropic', model: 'rich' } },
      ] ),
      credentials: { glm: { apiKey: 'k' } },
    })

    await Promise.all( [
      d.call('sys', 'a', 1, undefined, meta({ category: 'summarizer' }) ),
      d.call('sys', 'b', 1, undefined, meta({ category: 'executive'  }) ),
      d.call('sys', 'c', 1, undefined, meta({ category: 'summarizer' }) ),
    ] )

    const models = recorded.map( r => r.model ).sort()
    expect( models ).toEqual( [ 'cheap', 'cheap', 'rich' ] )
  })

  // ── Provider-less routes (W7) ───────────────────────────────

  it('keeps the default provider when a route names only a model', async () => {
    // What a per-role model map means: same vendor, different model. Before W7
    // a route had to repeat the provider, which a role map has no way to know.
    const d = director({
      router: new TableRouter( [ { category: 'summarizer', route: { model: 'small-model' } } ] ),
    })
    await d.call('sys', 'msg', 1, undefined, meta({ category: 'summarizer' }) )
    expect( recorded[0]!.provider ).toBe('anthropic')
    expect( recorded[0]!.model ).toBe('small-model')
  })

  it('a provider-less route needs no credentials map', async () => {
    // It reuses the default provider's credential — otherwise every role-mapped
    // Will would have to declare `providers` for a vendor it already configured.
    const d = director({
      provider: 'glm', apiKey: 'zai-key',
      router: new TableRouter( [ { route: { model: 'glm-5' } } ] ),
    })
    await d.call('sys', 'msg', 1, undefined, meta() )
    expect( recorded[0]!.provider ).toBe('glm')
    expect( recorded[0]!.model ).toBe('glm-5')
  })
})

// ── chainRouters (W7) ─────────────────────────────────────────

describe('chainRouters', () => {

  const routerNaming = ( name: string, model: string ): ModelRouter => ( {
    name, route: () => ( { model } ),
  } )

  it('collapses to NULL_ROUTER when every link is empty', () => {
    expect( isNullRouter( chainRouters() ) ).toBe( true )
    expect( isNullRouter( chainRouters( null, undefined, NULL_ROUTER ) ) ).toBe( true )
  })

  it('returns the single link unwrapped — no chain where there is nothing to chain', () => {
    const only = routerNaming('only', 'm')
    expect( chainRouters( null, only, NULL_ROUTER ) ).toBe( only )
  })

  it('gives the first link with an opinion the last word', () => {
    const chain = chainRouters( routerNaming('first', 'first-model'), routerNaming('second', 'second-model') )
    expect( chain.route( meta() )?.model ).toBe('first-model')
  })

  it('falls through to the next link when the first abstains', () => {
    const abstains: ModelRouter = { name: 'abstains', route: () => null }
    const chain = chainRouters( abstains, routerNaming('second', 'second-model') )
    expect( chain.route( meta() )?.model ).toBe('second-model')
  })

  it('skips a throwing link instead of losing the whole chain', () => {
    // The links are independent decisions. If a broken host router took the
    // compiled role map down with it, every role-mapped call would silently
    // demote to the default model — the failure would look like nothing.
    const exploding: ModelRouter = { name: 'exploding', route(){ throw new Error('boom') } }
    const chain = chainRouters( exploding, routerNaming('roles', 'role-model') )
    expect( chain.route( meta() )?.model ).toBe('role-model')
  })
})

// ── compileRoleRouter (W7) ────────────────────────────────────
//
// The per-role model map is sugar over the router. These pin the desugaring to
// the axes the call sites actually tag themselves with — if a call site ever
// stops matching, a configured role silently stops applying, and that is the
// one failure this compiler can have.

describe('compileRoleRouter', () => {

  it('emits nothing when every role shares the executive model', () => {
    // The single-model case must stay byte-identical to a Will built before the
    // seam existed — no router, no chain, no rules.
    expect( compileRoleRouter( {
      executive: 'one-model', summarizer: 'one-model', deliberation: 'one-model', conversation: 'one-model',
    } ) ).toBeNull()
    expect( compileRoleRouter( {
      executive: null, summarizer: null, deliberation: null, conversation: null,
    } ) ).toBeNull()
  })

  it('routes the summariser by category — the axis its call site tags', () => {
    const r = compileRoleRouter( {
      executive: 'big', summarizer: 'small', deliberation: 'big', conversation: 'big',
    } )!
    expect( r.route( { category: 'summarizer', attribute: 'memory', process: 'cog', function: 'consolidation' } )?.model ).toBe('small')
    expect( r.route( meta() ) ).toBeNull()     // master keeps the default
  })

  it('routes deliberation by function, including its propose pass', () => {
    const r = compileRoleRouter( {
      executive: 'big', summarizer: 'big', deliberation: 'thinky', conversation: 'big',
    } )!
    expect( r.route( meta({ attribute: 'facet', function: 'deliberation' }) )?.model ).toBe('thinky')
    // The master's own deliberate pass is tagged 'ideation', not 'deliberation',
    // so it stays on the executive model — as it did with per-role directors.
    expect( r.route( meta({ process: 'ideation' }) ) ).toBeNull()
  })

  it('gives outreach the conversation voice', () => {
    const r = compileRoleRouter( {
      executive: 'big', summarizer: 'big', deliberation: 'big', conversation: 'chatty',
    } )!
    expect( r.route( meta({ attribute: 'facet', function: 'conversation' }) )?.model ).toBe('chatty')
    expect( r.route( meta({ attribute: 'facet', function: 'outreach'     }) )?.model ).toBe('chatty')
  })

  it('names no provider — a role inherits the Will\'s vendor', () => {
    const r = compileRoleRouter( {
      executive: 'big', summarizer: 'small', deliberation: 'big', conversation: 'big',
    } )!
    expect( r.route( { category: 'summarizer', attribute: 'memory', process: 'cog', function: 'consolidation' } )?.provider ).toBeUndefined()
  })
})

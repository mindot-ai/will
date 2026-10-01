// ─────────────────────────────────────────────────────────────
// tests/integration/live.findings.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What running Lora's pipeline live found (2026-10-01) — real engines, her real
 * read-only GitHub tools over MCP, real Jina embeddings; only the LLM scripted.
 *
 *   1. A host act outside a plan left no trace. `action.outcome` for a host-acked
 *      act was emitted only for plan steps, and on timeout likewise — so not one
 *      of her GitHub reads reached `action.record`: "What Became Of What I Did"
 *      never showed it, and she could not remember having done it.
 *   2. An answer that arrived late was dropped with the fate. A 220 KB listing
 *      took longer than the await; the act was written off as "the world never
 *      answered" and the answer — which had arrived — went nowhere.
 *   3. Her GitHub tools sat on the always-offered floor, so the field picked them
 *      spontaneously with no arguments; the bridge refused each ("needs owner,
 *      repo"), and the refusals were learned as failures, round after round.
 *      The synthesizer's own invariant: an affordance never arrives at execution
 *      with empty arguments.
 *   4. The mind perceived its own `persona.prior` as the world: "New
 *      persona.prior: persona-prior" filled 367 of the lines working memory held.
 *   5. A message arriving while a GitHub read was in flight preempted it — and
 *      preemption DELETED the awaiting intent, as if the read could be unsent.
 *      The host answered an act that no longer existed: no record, nothing
 *      learned, and (before 2) the answer itself dropped.
 *   6. Recall by meaning missed page 10 of a listing she had read. Background
 *      indexing kept one promise, overwritten per batch, so draining it waited
 *      for the latest batch only — and closing wrote the index while the
 *      listing's pages were still embedding.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Will } from '#surface/sdk/will'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { externalSchemas } from '#agency/schemas/external'
import { connectMcpEffectors } from '#surface/mcp/effectors'
import { MIND_OWN_ENTITY_TYPES } from '#cognition/sense.boundary'
import { setLogger, resetLogger } from '#core/logger'

afterEach( () => resetLogger() )
const quiet = () => setLogger( { debug(){}, info(){}, warn(){}, error(){} } as never )

describe('1 — every host act leaves its record', () => {
  it('a reconciled outcome outside any plan is reported, with its words and whom it was toward', async () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    reaff.attachBus( { publish: ( e: never ) => published.push( e ), subscribe: () => {} } as never )
    const s = { tick: 0, time: 0, metrics: new Map(), entities: new Map( [ [ 'out-1', { id: 'out-1', type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: { schema: 'list_pull_requests', intentId: 'i-1', success: true, outcomeQuality: 0.8, predictedReward: 0.5, surprise: 0.3,
        description: 'list_pull_requests ran.', mode: 'external', reconciled: true, targetEntityId: 'ke:ada' } } ] ] ) }
    await reaff.react( 0 as never, 5 as never, s as never, {} as never )
    const outcome = published.find( e => e.type === 'action.outcome')
    expect( outcome?.payload ).toMatchObject( { actionType: 'list_pull_requests', success: true, description: 'list_pull_requests ran.', targetEntityId: 'ke:ada' } )
    expect( outcome?.payload ).not.toHaveProperty('planId')
  } )

  it('end to end: a host act she willed reaches her record of what she did', async () => {
    quiet()
    const will = await Will.create( { name: 'Rec', identity: { prompt: 'I read.' }, llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 2,
      effectors: { list_pull_requests: { description: 'List PRs.', handler: async () => ( { success: true, description: 'list_pull_requests ran.', observation: '[{"number":1}]' } ) } } } )
    try {
      const inst = ( will.stem as unknown as { _get( id: string ): { simulation: { stateManager: { snapshot(): { entities: Map<string, { type: string; metadata?: Record<string, unknown> }> }; setEntity( e: unknown ): void } } } } )._get( will.id )
      // An act she willed: the intent awaiting, the invocation dispatched.
      inst.simulation.stateManager.setEntity( { id: 'agency-intent-7', type: 'agency.intent', metadata: { schema: 'list_pull_requests', status: 'awaiting', dispatchedAt: 1, targetEntityId: 'ke:ada' } } )
      will.stem.confirmEffectorExecution( will.id, 'agency-intent-7', { success: true, description: 'list_pull_requests ran.', observation: '[{"number":1}]' } )
      const recorded = () => [ ...inst.simulation.stateManager.snapshot().entities.values() ]
        .find( e => e.type === 'action.record' && e.metadata?.['type'] === 'list_pull_requests')
      for( let i = 0; i < 100 && !recorded(); i++ ) await new Promise( r => setTimeout( r, 20 ) )
      expect( recorded()?.metadata ).toMatchObject( { status: 'completed', outcome: 'list_pull_requests ran.', targetEntityId: 'ke:ada' } )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

describe('2 — an answer that arrives late is still taken in', () => {
  it('the act was given up on; what the world said comes in anyway — reafferent, tied to the act', async () => {
    quiet()
    const will = await Will.create( { name: 'Late', identity: { prompt: 'I wait.' }, llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 3 } )
    try {
      const stem = will.stem as unknown as { _effector: { bufferInvocation( i: unknown, p: Record<string, unknown> ): void }; _get( id: string ): { simulation: { stateManager: { snapshot(): { entities: Map<string, { type: string; metadata?: Record<string, unknown> }> } } } } }
      const inst = stem._get( will.id )
      stem._effector.bufferInvocation( inst, { schema: 'list_pull_requests', intentId: 'agency-intent-16', parameters: {}, tick: 1 } )
      // No awaiting intent any more: the executor timed it out.
      will.stem.confirmEffectorExecution( will.id, 'agency-intent-16', { success: true, description: 'list_pull_requests ran.', observation: '[{"number":198}]' } )
      // Laid down at once — read before the sweep (two ticks) takes it to working memory.
      const percept = [ ...inst.simulation.stateManager.snapshot().entities.values() ].find( e => e.type === 'percept' && e.metadata?.['data'] === '[{"number":198}]')
      expect( percept?.metadata ).toMatchObject( { provenance: 'reafferent', sourceIntentId: 'agency-intent-16' } )
    }
    finally { await will.stop() }
  }, 30_000 )
} )

describe('3 — an ability that needs specifics is not offered without them', () => {
  const declared = [ { name: 'list_issues', description: 'List issues.', requires: [ 'owner', 'repo' ] }, { name: 'ping', description: 'Ping.' } ]

  it('the floor offers what binds nothing and needs nothing — not what needs args', async () => {
    const repertoire = new SchemaRepertoire()
    for( const s of externalSchemas( declared ) ) repertoire.registerExternal( s )
    const synth = new AffordanceSynthesizer( repertoire.schemas() )
    synth.attachRepertoire( repertoire )
    const s = { tick: 1, time: 0, metrics: new Map( [ [ 'energy.level', 80 ] ] ), entities: new Map() }
    const field = ( await synth.react( 0 as never, 1 as never, s as never, {} as never ) ).commands!.set!.filter( e => e.type === 'affordance')
    expect( field.some( e => e.metadata!['schema'] === 'ping') ).toBe( true )
    expect( field.some( e => e.metadata!['schema'] === 'list_issues') ).toBe( false )
  } )

  it('willed with its args, it enters the field and competes', async () => {
    const repertoire = new SchemaRepertoire()
    for( const s of externalSchemas( declared ) ) repertoire.registerExternal( s )
    const synth = new AffordanceSynthesizer( repertoire.schemas() )
    synth.attachRepertoire( repertoire )
    const s = { tick: 1, time: 0, metrics: new Map( [ [ 'energy.level', 80 ] ] ), entities: new Map( [ [ 'ideomotor-list_issues', {
      id: 'ideomotor-list_issues', type: 'ideomotor.intent', metadata: { schema: 'list_issues', priority: 0.8, parameters: { owner: 'mindot-ai', repo: 'will' } } } ] ] ) }
    const field = ( await synth.react( 0 as never, 1 as never, s as never, {} as never ) ).commands!.set!.filter( e => e.type === 'affordance')
    const willed = field.find( e => e.metadata!['schema'] === 'list_issues')
    expect( willed?.metadata!['parameters'] ).toEqual( { owner: 'mindot-ai', repo: 'will' } )
  } )

  it('an MCP tool declares what it requires', async () => {
    quiet()
    const will = await Will.create( { name: 'Tools', identity: { prompt: 'I use tools.' }, llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 4 } )
    try {
      const client = {
        listTools: async () => ( { tools: [ { name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object', properties: { owner: {}, repo: {} }, required: [ 'owner', 'repo' ] } },
                                           { name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} } } ] } ),
        callTool: async () => ( { content: [ { type: 'text', text: 'ok' } ] } ),
        close: async () => {},
      }
      await connectMcpEffectors( will, { client: client as never } )
      const repertoire = ( will.stem.getWillCognition( will.id ) as unknown as { schemaRepertoire: { getSchema( id: string ): { requires?: string[] } | undefined } } ).schemaRepertoire
      expect( repertoire.getSchema('list_issues')?.requires ).toEqual( [ 'owner', 'repo' ] )
      expect( repertoire.getSchema('ping')?.requires ).toBeUndefined()
    }
    finally { await will.stop() }
  }, 30_000 )
} )

describe('4 — the mind does not perceive its own machinery', () => {
  it('every entity type a running mind writes is declared its own — a census, not a list', async () => {
    quiet()
    const will = await Will.create( { name: 'Census', identity: { prompt: 'I count what I write.' }, llm: 'mock', anatomy: 'mind', tickMs: 1, seed: 11 } )
    try {
      const inst = ( will.stem as unknown as { _get( id: string ): { simulation: { stateManager: { snapshot(): { entities: Map<string, { type: string }> } } } } } )._get( will.id )
      await will.sense( { text: 'hello there', from: 'discord:U1', speaker: 'Ada', provenance: 'exafferent' } )
      const seen = new Set<string>()
      for( let i = 0; i < 400 && !seen.has('persona.prior'); i++ ){
        for( const e of inst.simulation.stateManager.snapshot().entities.values() ) seen.add( e.type )
        await new Promise( r => setTimeout( r, 25 ) )
      }
      expect( seen.has('persona.prior') ).toBe( true )   // it ran long enough to tune itself
      expect( [ ...seen ].filter( t => !MIND_OWN_ENTITY_TYPES.has( t ) ) ).toEqual( [] )
    }
    finally { await will.stop() }
  }, 60_000 )
} )

describe('5 — an act already out in the world is let go of, not unsent', () => {
  type Ent = { id: string; type: string; createdAt: number; updatedAt: number; metadata: Record<string, unknown> }
  const world = () => ( { tick: 0, time: 0, entities: new Map<string, Ent>(), metrics: new Map<string, number>() } )
  const apply = ( s: ReturnType<typeof world>, c: { set?: Array<{ id: string; type: string; metadata?: Record<string, unknown> }>; delete?: string[] } | undefined ) => {
    for( const e of c?.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, metadata: {}, ...e } as Ent )
    for( const id of c?.delete ?? [] ) s.entities.delete( id )
  }
  const affordance = ( id: string, schema: string, expectedReward: number ) => ( { id, type: 'affordance', createdAt: 0, updatedAt: 0, metadata: {
    schema, source: 'innate', parameters: {}, expectedValence: 0, expectedReward, cost: 0, habitStrength: 0, available: true, tags: [ 'regulatory' ], tick: 1 } } )
  const preempted = ( r: { commands?: { metrics?: Array<[ string, unknown ]> } } ) => r.commands?.metrics?.find( m => m[0] === 'agency.selection.preempted')?.[1]

  it('a host act held awaiting is marked sent; words not yet written are not', async () => {
    const { MotorSchemaExecutor } = await import('#agency/engines/motor.schema.executor')
    const s = world()
    s.entities.set('agency-intent-1', { id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'selected', schema: 'list_pull_requests', parameters: { owner: 'mindot-ai' }, expectedReward: 0.5, expectedValence: 0 } } )
    s.entities.set('agency-intent-2', { id: 'agency-intent-2', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'selected', schema: 'reach-out', targetEntityId: 'ke:ada', parameters: {}, expectedReward: 0.5, expectedValence: 0 } } )
    const exec = new MotorSchemaExecutor()
    exec.attachGrants( { isAllowed: () => true } as never )
    apply( s, ( await exec.react( 0 as never, 3 as never, s as never, {} as never ) ).commands )
    expect( s.entities.get('agency-intent-1')?.metadata ).toMatchObject( { status: 'awaiting', sent: true } )
    expect( s.entities.get('agency-intent-2')?.metadata ).toMatchObject( { status: 'awaiting' } )
    expect( s.entities.get('agency-intent-2')?.metadata ).not.toHaveProperty('sent')
  } )

  it('preempted, a sent act keeps its intent for its answer — and no longer holds the body', async () => {
    const { ActionSelector } = await import('#agency/engines/action.selector')
    const sel = new ActionSelector()
    const s = world()
    s.entities.set('agency-intent-1', { id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'awaiting', sent: true, activation: 0.2, schema: 'list_pull_requests', dispatchedAt: 1 } } )
    s.entities.set('a-rest', affordance('a-rest', 'rest', 0.9 ) )

    const r1 = await sel.react( 0 as never, 2 as never, s as never, {} as never )
    expect( preempted( r1 ) ).toBe( 1 )
    expect( r1.commands?.delete ?? [] ).not.toContain('agency-intent-1')   // still awaiting its answer
    apply( s, r1.commands )
    expect( s.entities.get('agency-intent-1')?.metadata?.['status'] ).toBe('awaiting')

    // The challenger done; a want too weak to preempt anything is now free to act.
    s.entities.delete( [ ...s.entities.keys() ].find( k => k.startsWith('agency-intent-') && k !== 'agency-intent-1')! )
    s.entities.delete('a-rest')
    s.entities.set('a-wait', affordance('a-wait', 'wait', 0.05 ) )
    const r2 = await sel.react( 0 as never, 3 as never, s as never, {} as never )
    expect( r2.commands?.set?.find( e => e.type === 'agency.intent')?.metadata?.['schema'] ).toBe('wait')
    expect( preempted( r2 ) ).toBe( 0 )

    // Answered (or timed out): no longer out, no longer held.
    s.entities.delete('agency-intent-1')
    await sel.react( 0 as never, 4 as never, s as never, {} as never )
    expect( sel.snapshot()['released'] ).toEqual( [] )
  } )

  it('words never written are still simply dropped', async () => {
    const { ActionSelector } = await import('#agency/engines/action.selector')
    const s = world()
    s.entities.set('agency-intent-1', { id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'awaiting', activation: 0.2, schema: 'reach-out', targetEntityId: 'ke:ada', dispatchedAt: 1 } } )
    s.entities.set('a-rest', affordance('a-rest', 'rest', 0.9 ) )
    const r = await new ActionSelector().react( 0 as never, 2 as never, s as never, {} as never )
    expect( r.commands?.delete ).toContain('agency-intent-1')
  } )

  it('a released act survives a snapshot of the mind', async () => {
    const { ActionSelector } = await import('#agency/engines/action.selector')
    const a = new ActionSelector()
    const s = world()
    s.entities.set('agency-intent-1', { id: 'agency-intent-1', type: 'agency.intent', createdAt: 0, updatedAt: 0,
      metadata: { status: 'awaiting', sent: true, activation: 0.2, schema: 'list_pull_requests', dispatchedAt: 1 } } )
    s.entities.set('a-rest', affordance('a-rest', 'rest', 0.9 ) )
    await a.react( 0 as never, 2 as never, s as never, {} as never )
    const b = new ActionSelector()
    b.restore( a.snapshot() )
    expect( b.snapshot()['released'] ).toEqual( [ 'agency-intent-1' ] )
  } )
} )

describe('6 — closing waits for every page still being embedded', () => {
  it('not only the latest batch: an earlier, slower one is drained before the index is written', async () => {
    const { EpisodicConsolidator } = await import('#faculties/episodic.consolidator')
    const { actMemoryEntity } = await import('#faculties/executive.engine/action.record')
    const gates: Array<() => void> = []
    const vectors = { size: 0, load: async () => {}, indexBatch: () => new Promise<void>( r => { gates.push( r ) } ) }
    const memory = new EpisodicConsolidator( { vectorMemory: vectors as never } )
    const remember = async ( tick: number, type: string ) => {
      const item = actMemoryEntity(`action-record-${ tick }-${ type }`, { type, status: 'completed', tick, outcome: `${ type } ran.` }, undefined, undefined )
      await memory.react( 0 as never, tick as never, { tick, time: tick * 1000, metrics: new Map(), entities: new Map( [ [ item.id, { ...item, createdAt: 0, updatedAt: 0 } ] ] ) } as never, {} as never )
    }
    await remember( 1, 'list_pull_requests' )   // a long listing's pages, still embedding
    await remember( 2, 'list_commits' )         // a short one
    expect( gates ).toHaveLength( 2 )

    let drained = false
    const flushing = memory.flushIndexing().then( () => { drained = true } )
    gates[1]!()                                  // the short one lands first
    await new Promise( r => setTimeout( r, 20 ) )
    expect( drained ).toBe( false )              // the listing is still embedding
    gates[0]!()
    await flushing
    expect( drained ).toBe( true )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/abilities.whole.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A Will sees every ability it holds, whole — and can reach for any of them.
 *
 * `## Abilities Available Now` read the affordance field and kept the first 8 by
 * iteration order. The field is attention-capped, and an ability bound to someone
 * enters it only when its target wins a place — so what the mind could see it
 * could do changed tick to tick, and willing one that was not in the field that
 * moment was reported back as "not a thing I can do". A COO escalated an unban,
 * then said she did not have the unban action. And each MCP tool's meaning was cut
 * at 300 characters, taking the required args that come last.
 *
 * What she holds is now in state (`agency.schema`, mirrored each tick like learned
 * composites), in view whole, and willable. Willing still only ENTERS the
 * competition: the synthesizer admits the intent and the selector decides.
 */

import { describe, it, expect } from 'vitest'
import { SchemaRepertoire } from '#agency/schemas/repertoire'
import { externalSchemas } from '#agency/schemas/external'
import { ReafferenceEngine } from '#agency/engines/reafference.engine'
import { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'
import { extractAbilities } from '#faculties/executive.engine/context'
import { buildStateCommands, type CommandDependencies } from '#faculties/executive.engine/commands'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import { GenerativeModel } from '#cognition/generative.model'
import type { ExecutiveContext, ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { ReadonlySimulationState, StateCommands } from '#core/types'

const CTX = {} as never
type Mut = { tick: number; time: number; entities: Map<string, any>; metrics: Map<string, number> }
const fresh = (): Mut => ( { tick: 1, time: 1000, entities: new Map(), metrics: new Map( [ [ 'energy.level', 80 ] ] ) } )
const apply = ( s: Mut, c?: StateCommands ) => {
  for( const e of c?.set ?? [] ) s.entities.set( e.id, { createdAt: 0, updatedAt: 0, ...e } )
  for( const id of c?.delete ?? [] ) s.entities.delete( id )
}

// Twelve host abilities — more than the 8 the prompt used to show. Two bind a person.
const DECLARED = [
  ...Array.from( { length: 10 }, ( _, i ) => ( { name: `gh_tool_${ String( i ).padStart( 2, '0') }`,
    description: `Read something from GitHub, number ${ i }. `.repeat( 12 ) + '(args — owner; repo; path)' } ) ),
  { name: 'unban', binds: 'entity' as const, description: 'Lift a ban on someone in the server.' },
  { name: 'warn',  binds: 'entity' as const, description: 'Warn someone about their conduct.' },
]

function holding(){
  const repertoire = new SchemaRepertoire()
  for( const s of externalSchemas( DECLARED ) ) repertoire.registerExternal( s )
  return repertoire
}

/** One tick of the reafference engine — the mirror's writer. */
async function mirrored( repertoire: SchemaRepertoire, s = fresh() ){
  apply( s, ( await new ReafferenceEngine( repertoire ).react( 0 as never, 1 as never, s as never, CTX ) ).commands )
  return s
}

describe('she sees every ability she holds, whole', () => {
  it('all twelve, not the first eight — each with its whole meaning', async () => {
    const s = await mirrored( holding() )
    const abilities = extractAbilities( s as unknown as ReadonlySimulationState )!
    expect( abilities.map( a => a.name ) ).toEqual( DECLARED.map( d => d.name ).sort() )
    expect( abilities.find( a => a.name === 'gh_tool_03')!.description ).toBe( DECLARED[3]!.description )
  } )

  it('a person-bound ability is in view when no target won a place in the field this tick', async () => {
    const s = await mirrored( holding() )
    const prompt = buildUserMessage( { context: { ...context(), abilities: extractAbilities( s as never ) },
      state: s as never, qualityModulation: 1, epistemicUncertainty: 0.3, deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master' } as never )
    expect( prompt ).toContain('- **unban** — Lift a ban on someone in the server.')
  } )

  it('says who the field offers one toward, and when one is offered but not available', () => {
    const s = fresh()
    s.entities.set('agency-schema-warn', { id: 'agency-schema-warn', type: 'agency.schema', metadata: { id: 'warn', kind: 'primitive', source: 'external', description: 'Warn someone.' } } )
    s.entities.set('aff-warn-ada', { id: 'aff-warn-ada', type: 'affordance', metadata: { schema: 'warn', source: 'external', available: true,
      targetEntityId: 'ke:ada', parameters: { targetEntityName: 'Ada' } } } )
    s.entities.set('aff-warn-bo', { id: 'aff-warn-bo', type: 'affordance', metadata: { schema: 'warn', source: 'external', available: true,
      targetEntityId: 'ke:bo', parameters: { targetEntityName: 'Bo' } } } )
    s.entities.set('aff-sprint', { id: 'aff-sprint', type: 'affordance', metadata: { schema: 'sprint', source: 'external', available: false } } )
    const abilities = extractAbilities( s as never )!
    expect( abilities.find( a => a.name === 'warn') ).toEqual( { name: 'warn', description: 'Warn someone.', targets: [ 'Ada', 'Bo' ] } )
    expect( abilities.find( a => a.name === 'sprint')!.unavailable ).toBe( true )
    const prompt = buildUserMessage( { context: { ...context(), abilities }, state: s as never, qualityModulation: 1,
      epistemicUncertainty: 0.3, deps: { summarizer: null }, focus: { title: 'T', content: 'c' }, mode: 'master' } as never )
    expect( prompt ).toContain('- **warn** (toward Ada, Bo) — Warn someone.')
    expect( prompt ).toContain('- **sprint** (not available to me right now)')
  } )
} )

describe('she can reach for any ability she holds — and it still competes', () => {
  it('willing one the field did not offer becomes an intent, not "not a thing I can do"', async () => {
    const s = await mirrored( holding() )
    s.entities.set('ke-fkem', { id: 'ke-fkem', type: 'known-entity', metadata: { keid: 'ke:fkem', name: 'FKEM', kind: 'sentient' } } )
    const out = decide( s, { type: 'unban', target: 'FKEM', reasoning: 'r', expectedOutcome: 'FKEM can post again' } )
    expect( out.set!.find( e => e.id === 'ideomotor-unban-ke:fkem') ).toBeDefined()
    expect( out.set!.some( e => e.type === 'action.unresolved') ).toBe( false )
  } )

  it('a name she does not hold is still reported, not swallowed', async () => {
    const s = await mirrored( holding() )
    const out = decide( s, { type: 'ban', reasoning: 'r', expectedOutcome: '' } )
    expect( out.set!.find( e => e.type === 'action.unresolved')!.metadata!['names'] ).toEqual( [ 'ban' ] )
  } )

  it('the willed act enters the field through the synthesizer', async () => {
    const repertoire = holding()
    const s = await mirrored( repertoire )
    s.entities.set('ke-fkem', { id: 'ke-fkem', type: 'known-entity', metadata: { keid: 'ke:fkem', name: 'FKEM', kind: 'sentient' } } )
    apply( s, decide( s, { type: 'unban', target: 'FKEM', reasoning: 'r', expectedOutcome: '' } ) )
    const synth = new AffordanceSynthesizer( repertoire.schemas() )
    synth.attachRepertoire( repertoire )
    const field = ( await synth.react( 0 as never, 2 as never, s as never, CTX ) ).commands!.set!
      .filter( e => e.type === 'affordance')
    expect( field.some( e => e.metadata!['schema'] === 'unban' && e.metadata!['targetEntityId'] === 'ke:fkem') ).toBe( true )
  } )
} )

describe('a restore does not turn a held ability into a learned one', () => {
  it('only composites are restored from the mirror — abilities are the host\'s to grant each boot', async () => {
    const s = await mirrored( holding() )
    const woken = new SchemaRepertoire()                       // the host no longer declares them
    woken.restoreComposites( s.entities as never )
    expect( woken.schemas().some( x => x.id === 'unban') ).toBe( false )
    expect( woken.export().composites ).toEqual( [] )
  } )
} )

// ── helpers ──────────────────────────────────────────────────

function decide( s: Mut, action: ExecutiveOutputFull['actions'][number] ){
  const deps = { summarizer: null, goalManager: null, semanticIntegrator: null, bus: null,
    salience: new GenerativeModel() } as unknown as CommandDependencies
  const footprint = { tickObserved: 1, entitiesRead: new Set(), metricsRead: new Set(), entitiesModified: new Set(),
    intendedCommands: {}, source: 'executive-engine' }
  return buildStateCommands( { actions: [ action ], reasoning: 'r', confidence: 0.8 } as ExecutiveOutputFull,
    footprint as never, s as never, deps, [] ).commands
}

function context(): ExecutiveContext {
  return { identity: { name: 'Lora', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [] } as unknown as ExecutiveContext
}

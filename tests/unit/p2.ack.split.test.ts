// ─────────────────────────────────────────────────────────────
// tests/unit/p2.ack.split.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * SIGNAL_BOUNDARY P2 — an ack is split by WHAT IT CARRIES, and what a host
 * sends is consumed whole.
 *
 * §3c settles the shape: `agency.outcome` carries **the fate of my act** and
 * goes to learning; a reafferent percept carries **what I found out by acting**
 * and goes to perception, memory and recall. `kick` produces only the first.
 * `lookup` produces both. Two contents, not a payload and a label.
 *
 * What made it urgent is narrower than the doc assumed: the string never
 * arrived at all. `reafference.engine` hardcoded "The world confirmed the
 * action." and `motor.schema.executor` published no description, so the
 * prompt\'s `## Recent Action Outcomes` showed action NAMES and nothing else.
 * Verified on a live Will before the fix.
 *
 * And nothing on the way in truncates a host\'s words any more. 700 at the MCP
 * boundary, 300 at the session log, 120 at `action.record` were three
 * unexamined numbers deciding how much of an answer a mind was allowed.
 */

import { describe, it, expect } from 'vitest'
import { SomatosensationEngine } from '#senses/somatosensation.engine'
import type { Percept } from '#senses/index'
import type { EffectorAck } from '#stem/tracts/effector/types'

function wired(){
  const seen: Percept[] = []
  const e = new SomatosensationEngine()
  e.attachBus( { publish: ( ev: { payload: unknown } ) => seen.push( ev.payload as Percept ),
                 subscribe: () => {} } as never )
  return { e, seen }
}

describe('the two contents are different things, not container and label', () => {
  it('a fate-only ack carries no observation — nothing was revealed', () => {
    const kick: EffectorAck = { success: true, description: 'Removed Ada from the server.' }
    expect( kick.observation ).toBeUndefined()
  } )

  it('a fact-carrying ack carries both, saying different things', () => {
    const lookup: EffectorAck = {
      success:     true,
      description: 'Looked up Ada.',
      observation: 'Ada joined 3 months ago, holds @moderator, 2 warnings on record.',
    }
    expect( lookup.description ).not.toBe( lookup.observation )
  } )
} )

describe('an observation reaches the mind whole, in any shape', () => {
  it('a long answer is not cut — this is its only copy', async () => {
    const answer = 'Ada joined 2026-04-02. '.repeat( 60 )   // ~1380 chars
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'discord_lookup_member',
                      provenance: 'reafferent', sourceIntentId: 'i-1', data: answer } )
    // `data` is the host's and is never bounded. `summary` is the ENGINE'S label
    // for it and may be — bounding its own words destroys nobody's only copy.
    expect( seen[0]!.data ).toBe( answer )
    expect( String( seen[0]!.data ).length ).toBeGreaterThan( 700 )   // past every old cap
  } )

  it('a RECORD keeps its structure — flattening to prose is its own cutting', async () => {
    // Deliberately past every cap that used to exist (100 / 120 / 300 / 700):
    // a small record would pass this test even with truncation still in place.
    const record = {
      joined: '2026-04-02', roles: [ 'moderator', 'contributor', 'early-access' ],
      warnings: 2, timedOut: false,
      notes: Array.from( { length: 40 }, ( _, i ) => `note ${ i }: something worth keeping` ),
    }
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'discord_lookup_member',
                      provenance: 'reafferent', sourceIntentId: 'i-2', data: record } )
    // The object itself, not a rendering of it. Nothing was chosen for the mind.
    expect( seen[0]!.data ).toEqual( record )
  } )

  it('a host is NEVER required to write prose — the signal name is the label', async () => {
    // The point of the split. A robot's control layer reports what it measured;
    // asking it to also say what the measurement MEANS puts the mind's own work
    // on the wrong side of the integration boundary.
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'lidar.scan', provenance: 'reafferent',
                      data: { ranges: [ 1.2, 1.4, 0.9 ], frame: 'base_link' } } )
    expect( seen[0]!.summary ).toContain('lidar.scan')          // the name is the hint
    expect( seen[0]!.data ).toEqual( { ranges: [ 1.2, 1.4, 0.9 ], frame: 'base_link' } )
  } )

  it("a host's own words are used when it happens to have them — an option, not a duty", async () => {
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'x', provenance: 'reafferent',
                      data: { summary: 'Ada has been here three months.', roles: [ 'moderator' ] } } )
    expect( seen[0]!.summary ).toBe('Ada has been here three months.')
    // …and the data is still there underneath it. The summary is a reading aid,
    // never a replacement: a mind told "a few people" can never recover 47.
    expect( seen[0]!.data ).toEqual( { summary: 'Ada has been here three months.', roles: [ 'moderator' ] } )
  } )

  it('is reafferent and tied to the act that caused it', async () => {
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'discord_lookup_member',
                      provenance: 'reafferent', sourceIntentId: 'agency-intent-9', data: 'found' } )
    expect( seen[0]!.provenance ).toBe('reafferent')
    expect( seen[0]!.sourceIntentId ).toBe('agency-intent-9')
  } )

  it('survives a circular payload without throwing', async () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular['self'] = circular
    const { e, seen } = wired()
    await expect( e.ingest( { kind: 'system', signal: 'x', provenance: 'reafferent',
                              data: circular } ) ).resolves.toBeUndefined()
    expect( seen[0]!.summary ).toContain('x')   // falls back to the signal's name
  } )
} )

describe('nothing on the way in truncates a host', () => {
  it('the MCP boundary no longer caps a tool result', async () => {
    const mcp = await import('#surface/mcp/effectors')
    expect( 'RESULT_DESCRIPTION_CAP' in mcp ).toBe( false )
  } )
} )

// ── the fate reaches the prompt at all ────────────────────────
//
// Written because mutation testing said nothing covered it. Reverting BOTH
// publish sites — `reafference.engine` back to its hardcoded sentence, and
// `motor.schema.executor` back to publishing no description — passed the entire
// 1850-test suite. Those two lines are the whole 65-lookups bug: `action.record`
// is built from this payload, and the prompt renders it as
// `## Recent Action Outcomes`.

describe('a host\'s own words reach action.record, not a stock sentence', () => {
  it('the async path carries the description off the agency.outcome it read', async () => {
    const { ReafferenceEngine } = await import('#agency/engines/reafference.engine')
    const { SchemaRepertoire }  = await import('#agency/schemas/repertoire')

    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    const reaff = new ReafferenceEngine( new SchemaRepertoire() )
    reaff.attachBus( { publish: ( e: never ) => published.push( e ),
                       subscribe: () => {} } as never )

    const s = { tick: 0, time: 0, entities: new Map(), metrics: new Map() }
    s.entities.set('out-1', { id: 'out-1', type: 'agency.outcome', createdAt: 0, updatedAt: 0,
      metadata: {
        schema: 'discord_lookup_member', intentId: 'i-1', success: true,
        outcomeQuality: 0.8, predictedReward: 0.5, surprise: 0.1,
        planId: 'plan-1', stepId: 'step-1',
        description: 'Looked up Ada.',
      } } as never )

    await reaff.react( 0, 5 as never, s as never, {} as never )

    const outcome = published.find( e => e.type === 'action.outcome')
    expect( outcome ).toBeDefined()
    expect( outcome!.payload['description'] ).toBe('Looked up Ada.')
    // and NOT the phrase that used to be hardcoded here for every act alike
    expect( outcome!.payload['description'] ).not.toBe('The world confirmed the action.')
  } )
} )

// ── the data survives to where the mind can use it ────────────
//
// Carrying it onto the percept is not enough on its own. A percept entity is
// swept after 2 ticks, so if working memory keeps only the label, the evidence
// is gone from anything the mind can recall — and it would be gone silently.

describe('the evidence reaches state, memory and the prompt', () => {
  it('the percept entity carries the data, not only the label', async () => {
    const traced: Array<{ metadata: Record<string, unknown> }> = []
    const e = new SomatosensationEngine()
    e.attachBus( { publish: () => {}, subscribe: () => {} } as never )
    e.attachPerceptTrace( x => traced.push( x as never ), () => 7 )

    const record = { name: 'Mindot HQ', memberCount: 3, channels: [ 'general', 'watch' ] }
    await e.ingest( { kind: 'system', signal: 'discord_server_snapshot',
                      provenance: 'reafferent', sourceIntentId: 'i-3', data: record } )

    expect( traced[0]!.metadata['data'] ).toEqual( record )
    expect( typeof traced[0]!.metadata['summary'] ).toBe('string')
  } )

  it('working memory keeps the data, so it outlives the 2-tick sweep', async () => {
    const { WorkingMemory } = await import('#faculties/working.memory')
    const wm = new WorkingMemory()
    const record = { memberCount: 47 }
    const state = {
      tick: 1, time: 0, metrics: new Map(),
      entities: new Map( [ [ 'p-1', { id: 'p-1', type: 'percept', createdAt: 0, updatedAt: 0,
        metadata: { tick: 1, salience: 0.7, category: 'somatosensation',
                    summary: 'discord_lookup_member', provenance: 'reafferent', data: record } } ] ] ),
    } as never

    await wm.react( 0, 1 as never, state, {} as never )
    const items = ( wm as unknown as { _items: Array<{ content: Record<string, unknown> }> } )._items
    const percept = items.find( i => ( i.content as Record<string, unknown> )['entityId'] === 'p-1')

    expect( percept ).toBeDefined()
    // The evidence, not a sentence about it. A mind that remembers only the
    // label cannot answer a question it already had the answer to.
    expect( percept!.content['data'] ).toEqual( record )
  } )
} )

describe('the prompt shows the evidence, not only the label', () => {
  it('renders the data beneath the label', async () => {
    const { perceptLine } = await import('#faculties/executive.engine/prompt.factory')
    const line = perceptLine( {
      category: 'somatosensation',
      summary:  'discord_server_snapshot',
      salience: 0.75,
      data:     { name: 'Mindot HQ', memberCount: 3, channels: [ 'general', 'watch' ] },
    } )
    expect( line ).toContain('[somatosensation] discord_server_snapshot')
    // The numbers themselves, which no summary could have preserved.
    expect( line ).toContain('"memberCount":3')
    expect( line ).toContain('Mindot HQ')
  } )

  it('renders a label alone when there is no data', async () => {
    const { perceptLine } = await import('#faculties/executive.engine/prompt.factory')
    const line = perceptLine( { category: 'audition', summary: 'Ada said something', salience: 0.4 } )
    expect( line ).toBe('- [audition] Ada said something (salience: 0.40)')
  } )
} )

describe('memory shows the evidence too', () => {
  it('a rumination renders its data beneath its label', async () => {
    // Where a mind usually meets an observation: percepts are swept after 2
    // ticks and the executive fires on its own schedule, so the copy that
    // reaches it is often the one in memory.
    const { ruminationLine } = await import('#faculties/executive.engine/prompt.factory')
    const line = ruminationLine( {
      type: 'percept', summary: 'discord_lookup_member', activation: 0.74,
      data: { displayName: 'Fabrice', activeWarnings: 0, isOwner: true },
    } )
    expect( line ).toContain('[percept] discord_lookup_member')
    expect( line ).toContain('"activeWarnings":0')
    expect( line ).toContain('Fabrice')
  } )
} )

describe('the label is never printed twice', () => {
  it('a host summary used as the label is not repeated in the data', async () => {
    // Observed live: the wake percept rendered
    //   - [somatosensation] I was offline for 29 minutes…
    //       {"summary":"I was offline for 29 minutes…","offlineMs":1751649}
    // Noise, and a percept's noise is read on every tick it is alive.
    const { perceptLine } = await import('#faculties/executive.engine/prompt.factory')
    const line = perceptLine( {
      category: 'somatosensation', summary: 'I was offline for 29 minutes.', salience: 0.75,
      data: { summary: 'I was offline for 29 minutes.', offlineMs: 1751649 },
    } )
    expect( line.match( /I was offline for 29 minutes\./g ) ).toHaveLength( 1 )
    // …and the field beside it still shows. Declining to print a duplicate is
    // not reshaping — the stored data keeps every field.
    expect( line ).toContain('1751649')
  } )

  it('a data object that is ONLY a summary renders nothing underneath', async () => {
    const { perceptLine } = await import('#faculties/executive.engine/prompt.factory')
    const line = perceptLine( {
      category: 'somatosensation', summary: 'Done.', salience: 0.5, data: { summary: 'Done.' },
    } )
    expect( line ).toBe('- [somatosensation] Done. (salience: 0.50)')
  } )
} )

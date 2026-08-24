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
    expect( seen[0]!.summary ).toBe( answer )
    expect( seen[0]!.summary.length ).toBeGreaterThan( 700 )   // past every old cap
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
    // Complete and round-trippable: nothing was chosen for the mind.
    expect( JSON.parse( seen[0]!.summary ) ).toEqual( record )
  } )

  it("a host's own words win over rendering its shape", async () => {
    const { e, seen } = wired()
    await e.ingest( { kind: 'system', signal: 'x', provenance: 'reafferent',
                      data: { summary: 'Ada has been here three months.', roles: [ 'moderator' ] } } )
    expect( seen[0]!.summary ).toBe('Ada has been here three months.')
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
    expect( seen[0]!.summary ).toContain('Something happened')
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

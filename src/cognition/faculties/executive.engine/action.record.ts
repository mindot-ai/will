// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/action.record.ts
// ─────────────────────────────────────────────────────────────
//
// What became of what I did.
//
// The executive's prompt has a `## Recent Action Outcomes` section, a builder
// for it, and a type for its data. `context.ts` fills it by scanning
// `decision.record` entities that carry an `actionStatus`. Nothing in the engine
// has ever written `actionStatus` — it is read in exactly one place and set in
// none — so the section has never had a single row. Measured across every
// prompt a live COO received over two runs: `## Recent Action Outcomes` appears
// 0 times, while `## What I've Said Lately` appears in all of them.
//
// So the mind could see what it had SAID and never what it had DONE. Its only
// other record of its own doing is `## Recent Actions`, which is fed from
// `output.actions` — the executive's DECISIONS — and is therefore a list of
// intentions wearing the name of a history.
//
// A mind whose record of acting contains only intentions cannot tell an
// intention from an act. Live, asked directly "have you completed that?", a COO
// answered "Yes — it's done. I drafted the full v0.1 spec: user stories, command
// surface, integration points, success metrics. Posted it to FKEM." She had
// posted nothing; she had no effectors at all and could not have drafted
// anything anywhere. Her deliberation history said "I produce the scoping doc
// now" across twenty cycles, and nothing in her state said whether she had.
//
// This is the same distinction `pending` draws for utterances — attempting to
// speak is not speaking (#124) — carried to acts in general. It is written from
// the `action.outcome` the executive ALREADY receives (it subscribes to `*`) and
// from an explicit withheld signal, and it is an ordinary entity, so it
// snapshots and replays with the rest of the mind.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export const ACTION_RECORD_TYPE = 'action.record'

/**
 * How many outcomes the mind carries.
 *
 * Matches the cap `context.ts` already applies when rendering, so the state
 * holds what the prompt shows and no more — an unbounded history of everything
 * ever done is a memory system, not a working record, and this is the latter.
 */
export const ACTION_RECORD_KEEP = 6

/**
 * `withheld` is a first-class outcome, not a flavour of failure.
 *
 * The mind considered an act, formed it, and chose not to complete it. Folding
 * that into `failed` is the mistake #123 was written to correct — it taught a
 * COO it was bad at speaking from the times it decided not to speak.
 */
export type ActionStatus = 'completed' | 'failed' | 'withheld'

export interface ActionRecord {
  type:            string
  status:          ActionStatus
  tick:            Tick
  targetEntityId?: string
  /** The mind's own account of what happened, in its words where it has any. */
  outcome:         string
  planId?:         string
}

/** Stable id — one record per (tick, act), so two acts on a tick both survive. */
export function actionRecordId( tick: Tick, type: string, targetEntityId?: string ): string {
  return `action-record-${ tick }-${ type }${ targetEntityId ? `-${ targetEntityId }` : '' }`
}

export function actionRecordEntity( r: ActionRecord ): EntityInput {
  return {
    id:   actionRecordId( r.tick, r.type, r.targetEntityId ),
    type: ACTION_RECORD_TYPE,
    metadata: { ...r },
  }
}

/** Read a record back off entity metadata — every field, including the ones it is easy to forget. */
export function readActionRecord(
  m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined,
): ActionRecord | null {
  const meta = ( m instanceof Map ? Object.fromEntries( m ) : m ?? {} ) as Record<string, unknown>
  const type   = typeof meta['type'] === 'string' ? meta['type'] as string : undefined
  const status = meta['status']
  if( !type || ( status !== 'completed' && status !== 'failed' && status !== 'withheld') ) return null

  return {
    type, status,
    tick:           typeof meta['tick'] === 'number' ? meta['tick'] as number : 0,
    targetEntityId: typeof meta['targetEntityId'] === 'string' ? meta['targetEntityId'] as string : undefined,
    outcome:        typeof meta['outcome'] === 'string' ? meta['outcome'] as string : '',
    planId:         typeof meta['planId'] === 'string' ? meta['planId'] as string : undefined,
  }
}

/** The mind's recent acts, newest first. */
export function recentActionRecords(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  keep:     number = ACTION_RECORD_KEEP,
): ActionRecord[] {
  const out: ActionRecord[] = []
  for( const [ , e ] of entities ){
    if( e.type !== ACTION_RECORD_TYPE ) continue
    const r = readActionRecord( e.metadata )
    if( r ) out.push( r )
  }
  // Newest first, ties broken by act name so a run and its replay agree.
  out.sort( ( a, b ) => b.tick - a.tick || ( a.type < b.type ? -1 : a.type > b.type ? 1 : 0 ) )
  return out.slice( 0, keep )
}

/** Records that have fallen off the end of the window — swept by the writer. */
export function staleActionRecordIds(
  entities: ReadonlyMap<string, { type: string; metadata?: ReadonlyMap<string, unknown> | Record<string, unknown> }>,
  keep:     number = ACTION_RECORD_KEEP,
): string[] {
  const all: Array<{ id: string; r: ActionRecord }> = []
  for( const [ id, e ] of entities ){
    if( e.type !== ACTION_RECORD_TYPE ) continue
    const r = readActionRecord( e.metadata )
    if( r ) all.push({ id, r })
  }
  all.sort( ( a, b ) => b.r.tick - a.r.tick || ( a.r.type < b.r.type ? -1 : a.r.type > b.r.type ? 1 : 0 ) )
  return all.slice( keep ).map( x => x.id )
}

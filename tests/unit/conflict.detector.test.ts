// ─────────────────────────────────────────────────────────────
// tests/unit/conflict.detector.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for ConflictDetector.detect() tick-vs-tick comparison.
 *
 * Regression target (FN1): detect() used to compare `entity.updatedAt`
 * (wall-clock epoch ms) against `footprint.tickObserved` (a small sim-tick
 * integer). Any persisted entity therefore had `updatedAt` (~1.7e12) far
 * above any tick → every footprint was reported as conflicted, which is why
 * both call sites silently fell back to FORCE. The fix stamps a sim-tick
 * (`updatedAtTick`) on each write and compares tick-vs-tick.
 */

import { describe, it, expect } from 'vitest'
import { ConflictDetector } from '#core/conflict.detector'
import type {
  ReasoningFootprint,
  ReadonlySimulationState,
  SimulationEntity,
  StateCommands,
} from '#core/types'

function makeEntity( id: string, updatedAtTick: number | undefined ): SimulationEntity {
  return {
    id,
    type:          'test',
    createdAt:     1_700_000_000_000,
    updatedAt:     1_700_000_000_000,  // realistic epoch ms — must NOT be used as a tick
    updatedAtTick,
  }
}

function makeState( entities: SimulationEntity[], tick = 100 ): ReadonlySimulationState {
  const map = new Map( entities.map( e => [ e.id, e ] ) )
  return {
    tick,
    time:     1_700_000_000_000,
    entities: map,
    metrics:  new Map<string, number>(),
  } as unknown as ReadonlySimulationState
}

function makeFootprint( opts: {
  tickObserved: number
  read?: string[]
  modified?: string[]
  commands?: StateCommands
} ): ReasoningFootprint {
  return {
    tickObserved:     opts.tickObserved,
    entitiesRead:     new Set( opts.read     ?? [] ),
    metricsRead:      new Set<string>(),
    entitiesModified: new Set( opts.modified ?? [] ),
    intendedCommands: opts.commands ?? {},
    source:           'unit-test',
  }
}

describe('ConflictDetector.detect — tick-vs-tick (FN1 regression)', () => {
  const detector = new ConflictDetector()

  it('does NOT flag an entity whose epoch-ms updatedAt dwarfs the tick (the bug)', () => {
    // updatedAtTick (10) <= tickObserved (50) → up to date, no conflict.
    // The realistic epoch-ms updatedAt (1.7e12) must never be compared here.
    const state  = makeState([ makeEntity('a', 10 ) ])
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, read: ['a'], modified: ['a'] }),
      state
    )
    expect( report.hasConflicts ).toBe( false )
    expect( report.readConflicts ).toHaveLength( 0 )
    expect( report.writeConflicts ).toHaveLength( 0 )
  })

  it('flags a read conflict when the entity was written after observation', () => {
    const state  = makeState([ makeEntity('a', 60 ) ])
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, read: ['a'] }),
      state
    )
    expect( report.hasConflicts ).toBe( true )
    expect( report.readConflicts ).toHaveLength( 1 )
    expect( report.readConflicts[0] ).toContain('tick 60')
  })

  it('flags a write conflict when the entity was written after observation', () => {
    const state  = makeState([ makeEntity('a', 60 ) ])
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, modified: ['a'] }),
      state
    )
    expect( report.hasConflicts ).toBe( true )
    expect( report.writeConflicts ).toHaveLength( 1 )
  })

  it('uses strict > : a write on the observed tick is not a conflict', () => {
    const state  = makeState([ makeEntity('a', 50 ) ])
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, read: ['a'], modified: ['a'] }),
      state
    )
    expect( report.hasConflicts ).toBe( false )
  })

  it('treats a missing updatedAtTick (e.g. restored entity) as non-conflicting', () => {
    const state  = makeState([ makeEntity('a', undefined ) ])
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, read: ['a'], modified: ['a'] }),
      state
    )
    expect( report.hasConflicts ).toBe( false )
  })

  it('ignores entities that are no longer present', () => {
    const report = detector.detect(
      makeFootprint({ tickObserved: 50, read: ['gone'], modified: ['gone'] }),
      makeState([])
    )
    expect( report.hasConflicts ).toBe( false )
  })
})

describe('ConflictDetector.resolve — strategies', () => {
  const detector = new ConflictDetector()
  const conflictedReport = detector.detect(
    makeFootprint({
      tickObserved: 50,
      modified:     ['a'],
      commands:     { set: [ makeEntity('a', 60 ), makeEntity('b', 10 ) ], metrics: [ ['m', 1] ] },
    }),
    makeState([ makeEntity('a', 60 ) ])
  )

  it('FORCE applies intended commands despite conflicts', () => {
    const res = detector.resolve( conflictedReport, 'FORCE')
    expect( res.strategy ).toBe('FORCE')
    expect( res.shouldRerun ).toBe( false )
    expect( res.resolvedCommands ).toBe( conflictedReport.footprint.intendedCommands )
  })

  it('REJECT drops commands and requests a rerun', () => {
    const res = detector.resolve( conflictedReport, 'REJECT')
    expect( res.strategy ).toBe('REJECT')
    expect( res.resolvedCommands ).toBeNull()
    expect( res.shouldRerun ).toBe( true )
  })

  it('MERGE keeps non-conflicted sets/metrics and drops conflicted ones', () => {
    const res = detector.resolve( conflictedReport, 'MERGE')
    expect( res.strategy ).toBe('MERGE')
    const ids = ( res.resolvedCommands?.set ?? [] ).map( e => e.id )
    expect( ids ).toContain('b')
    expect( ids ).not.toContain('a')
    expect( res.resolvedCommands?.metrics ).toEqual( [ ['m', 1] ] )
  })
})

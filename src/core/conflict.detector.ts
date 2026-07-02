// ─────────────────────────────────────────────────────────────
// src/core/conflict.detector.ts
// ─────────────────────────────────────────────────────────────

/**
 * Validates async engine reasoning footprints against current state.
 * Detects read-after-write and write-after-write conflicts that occur
 * when an engine reasons on a stale snapshot while the world advances.
 */

import type {
  ReasoningFootprint,
  ConflictReport,
  ConflictResolution,
  ConflictStrategy,
  ReadonlySimulationState,
  StateCommands,
} from '#core/types'

export class ConflictDetector {
  /**
   * Check a reasoning footprint against the current state snapshot.
   * Returns a detailed conflict report.
   */
  detect(
    footprint: ReasoningFootprint,
    currentState: ReadonlySimulationState
  ): ConflictReport {
    const
    readConflicts:  string[] = [],
    writeConflicts: string[] = []

    // Read conflicts: entities the engine observed have been modified
    // since the footprint was taken. Compare the entity's last-write tick
    // against `tickObserved` (both are sim ticks). Entities without a tick
    // stamp (e.g. restored from a snapshot) cannot be proven stale → skip.
    for( const id of footprint.entitiesRead ){
      const entity = currentState.entities.get( id )
      const modifiedAtTick = entity?.updatedAtTick
      if( entity && modifiedAtTick !== undefined && modifiedAtTick > footprint.tickObserved )
        readConflicts.push(`Entity '${id}' modified at tick ${modifiedAtTick} (observed at tick ${footprint.tickObserved})`)
    }

    // Write conflicts: entities the engine wants to modify were modified by others
    for( const id of footprint.entitiesModified ){
      const entity = currentState.entities.get( id )
      const modifiedAtTick = entity?.updatedAtTick
      if( entity && modifiedAtTick !== undefined && modifiedAtTick > footprint.tickObserved )
        writeConflicts.push(`Write conflict on '${id}': modified at tick ${modifiedAtTick} (observed at tick ${footprint.tickObserved})`)
    }

    return {
      hasConflicts: readConflicts.length > 0 || writeConflicts.length > 0,
      readConflicts,
      writeConflicts,
      detectedAtTick: currentState.tick,
      footprint,
    }
  }

  /**
   * Resolve conflicts using the specified strategy.
   */
  resolve(
    report: ConflictReport,
    strategy: ConflictStrategy = 'REJECT'
  ): ConflictResolution {
    switch( strategy ){
      case 'FORCE':
        return {
          strategy: 'FORCE',
          resolvedCommands: report.footprint.intendedCommands,
          shouldRerun: false,
          reason: 'FORCE: applied despite conflicts',
        }

      case 'MERGE':
        return this._merge( report )

      case 'REJECT':
      default:
        return {
          strategy: 'REJECT',
          resolvedCommands: null,
          shouldRerun: true,
          reason: `REJECT: ${report.readConflicts.length} read conflicts, ${report.writeConflicts.length} write conflicts`,
        }
    }
  }

  /**
   * Attempt to apply a non-conflicting subset of commands.
   * Only includes entity sets and metric sets that don't touch conflicted entities.
   */
  private _merge( report: ConflictReport ): ConflictResolution {
    if( !report.hasConflicts )
      return {
        strategy: 'MERGE',
        resolvedCommands: report.footprint.intendedCommands,
        shouldRerun: false,
        reason: 'MERGE: no conflicts detected, full commit',
      }

    const
    footprint = report.footprint,
    original   = footprint.intendedCommands,
    conflictedIds = new Set<string>()

    // Collect all conflicted entity IDs from write conflict messages
    for( const msg of report.writeConflicts ){
      const match = msg.match( /Write conflict on '([^']+)'/ )
      match && conflictedIds.add( match[1]! )
    }

    const merged: StateCommands = {}

    // Only include entity sets that don't touch conflicted entities
    if( original.set )
      merged.set = original.set.filter( e => !conflictedIds.has( e.id ) )

    // Only include deletes that don't touch conflicted entities
    if( original.delete )
      merged.delete = original.delete.filter( id => !conflictedIds.has( id ) )

    // Metrics are always safe to apply (no entity-level conflicts)
    if( original.metrics )
      merged.metrics = [ ...original.metrics ]

    const
    appliedCount   = ( merged.set?.length ?? 0 ) + ( merged.delete?.length ?? 0 ),
    rejectedCount  = conflictedIds.size

    return {
      strategy: 'MERGE',
      resolvedCommands: merged,
      shouldRerun: rejectedCount > 0,
      reason: `MERGE: applied ${appliedCount} operations, rejected ${rejectedCount} conflicts`,
    }
  }
}
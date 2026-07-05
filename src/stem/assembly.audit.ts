// ─────────────────────────────────────────────────────────────
// src/stem/assembly.audit.ts — assembly wiring audit
// ─────────────────────────────────────────────────────────────
//
// The engine graph is wired by hand in assembleMind(): ~40 engines, dozens of
// pairwise `attachX()` calls, tier-gated. The documented failure class is a
// FORGOTTEN attachment — the PlanningEngine once shipped without attachBus(),
// so plan-lifecycle events silently never published (see the comment on
// PlanningEngine.attachBus). Silence is the problem: an unwired dependency
// no-ops instead of failing.
//
// This audit makes the wiring OBSERVABLE by convention: every injector method
// `attachFooBar(x)` in this codebase stores its dependency in a private field
// `_fooBar`. After assembly, we reflect each registered engine's `attach*`
// methods and check the matching field:
//
//   wired        — the field exists and is non-null
//   UNWIRED      — the field exists and is null/undefined (the bug class!)
//   unverifiable — no matching field (the method doesn't follow the naming
//                  convention); listed so drift is visible, never asserted
//
// Deliberately three-state and non-throwing: some unwired attachments are
// INTENTIONAL tier gating (basic tier leaves the executive off the planning
// engine), so assembleMind only logs, and the assembly-order snapshot test
// pins the per-tier expected-unwired set — a NEW unwired attachment then
// shows up as a red test diff, i.e. a conscious decision.
// ─────────────────────────────────────────────────────────────

import type { SimulationEngine } from '#core/orchestrator'

export interface WiringRecord {
  engine: string
  method: string
  status: 'wired' | 'unwired' | 'unverifiable'
}

/** `attachFooBar` → `_fooBar` (the codebase-wide injector/field convention). */
function fieldForAttach( method: string ): string {
  const stem = method.slice( 'attach'.length )
  return '_' + stem.charAt( 0 ).toLowerCase() + stem.slice( 1 )
}

/** All `attach*` methods reachable on the instance (own + prototype chain). */
function attachMethods( engine: object ): string[] {
  const seen = new Set<string>()
  let proto: object | null = engine
  while( proto && proto !== Object.prototype ){
    for( const name of Object.getOwnPropertyNames( proto ) )
      if( /^attach[A-Z]/.test( name ) && typeof ( engine as Record<string, unknown> )[ name ] === 'function' )
        seen.add( name )
    proto = Object.getPrototypeOf( proto )
  }
  return [ ...seen ].sort()
}

/**
 * Audit every registered engine's attach-point wiring. Pure inspection —
 * no mutation, deterministic, safe to run at assembly time.
 */
export function auditAssemblyWiring( engines: readonly SimulationEngine[] ): WiringRecord[] {
  const records: WiringRecord[] = []

  for( const engine of engines ){
    for( const method of attachMethods( engine ) ){
      const field = fieldForAttach( method )
      const bag   = engine as unknown as Record<string, unknown>

      if( !( field in bag ) ){
        records.push( { engine: engine.name, method, status: 'unverifiable' } )
        continue
      }

      const value = bag[ field ]
      records.push( {
        engine: engine.name,
        method,
        status: value === null || value === undefined ? 'unwired' : 'wired',
      } )
    }
  }

  return records
}

/** Compact `engine.attachMethod` keys for the given status (test snapshots). */
export function wiringKeys( records: WiringRecord[], status: WiringRecord['status'] ): string[] {
  return records.filter( r => r.status === status ).map( r => `${r.engine}.${r.method}` ).sort()
}

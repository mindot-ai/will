// ─────────────────────────────────────────────────────────────
// src/core/scenario.ts
// ─────────────────────────────────────────────────────────────

import type { SimulationState, SimulationContext, SimulationEntity } from '#core/types'
import type { StateManager } from '#core/state.manager'

export interface Scenario {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version: string
  readonly tags: string[]

  /**
   * Populate the live StateManager with initial entities and metrics.
   * Receives the actual StateManager so writes propagate — unlike a
   * snapshot copy which would be silently discarded.
   */
  initialize( state: StateManager, context: SimulationContext ): Promise<void>

  /**
   * Returns a plain SimulationState snapshot for inspection or seeding
   * before a SimulationContext is available.
   */
  getInitialState(): SimulationState

  validate(): ScenarioValidationResult
}

export interface ScenarioValidationResult {
  isValid:  boolean
  errors:   string[]
  warnings: string[]
}

export interface ScenarioConfig {
  id: string
  name: string
  version?: string
  tags?: string[]
  initialEntities?: SimulationEntity[]
  initialMetrics?: Record<string, number>
  parameters?: Record<string, unknown>
}

export class DefaultScenario implements Scenario {
  readonly id:          string
  readonly name:        string
  readonly description?: string
  readonly version:     string
  readonly tags:        string[]
  readonly parameters:  Record<string, unknown>

  private _initialEntities: SimulationEntity[]
  private _initialMetrics:  Map<string, number>

  constructor( config: ScenarioConfig ){
    this.id          = config.id
    this.name        = config.name
    this.version     = config.version ?? '1.0.0'
    this.tags        = config.tags ?? []
    this.parameters  = config.parameters ?? {}
    this._initialEntities = config.initialEntities ?? []
    this._initialMetrics  = new Map( Object.entries( config.initialMetrics ?? {} ) )
  }

  async initialize( state: StateManager, _context: SimulationContext ): Promise<void> {
    state.clear()

    // Initial entities are stamped from the sim clock, not wall time, so a
    // scenario loaded under a fixed clock yields identical entity timestamps on
    // replay (R2). After clear() the StateManager sits at sim-time 0, and
    // setEntity re-stamps createdAt/updatedAt from that sim time.
    const now = state.currentTime
    for( const entity of this._initialEntities )
      state.setEntity({ ...entity, createdAt: now, updatedAt: now })

    for( const [ key, value ] of this._initialMetrics )
      state.setMetric( key, value )

    state.updateClock( 0, now )
  }

  getInitialState(): SimulationState {
    const entities = new Map<string, SimulationEntity>()
    for( const entity of this._initialEntities )
      entities.set( entity.id, { ...entity })

    return {
      tick:     0,
      // Deterministic sim-time 0 to match tick 0 — never wall time (R2).
      time:     0,
      entities,
      metrics:  new Map( this._initialMetrics ),
    }
  }

  validate(): ScenarioValidationResult {
    const
    errors:   string[] = [],
    warnings: string[] = []

    if( !this.id )   errors.push('Scenario id is required')
    if( !this.name ) errors.push('Scenario name is required')

    const ids = new Set<string>()
    for( const entity of this._initialEntities ){
      if( ids.has( entity.id ) ){
        errors.push(`Duplicate entity id: ${entity.id}`)
        continue
      }

      ids.add( entity.id )
      !entity.type && warnings.push(`Entity ${entity.id} has no type`)
    }

    return { isValid: errors.length === 0, errors, warnings }
  }
}
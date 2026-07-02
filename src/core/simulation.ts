// ─────────────────────────────────────────────────────────────
// src/core/simulation.ts
// ─────────────────────────────────────────────────────────────

import type { Scenario } from '#core/scenario'
import type { SimulationContext, SimulationState, SeededPRNG, RestoreOptions } from '#core/types'

import { DefaultStateManager, type StateManager } from '#core/state.manager'
import { DefaultMetricCollector, type MetricCollector } from '#core/metrics'
import { SnapshotManager, type SnapshotManagerConfig } from '#core/snapshot.manager'
import { DefaultEventBus, type EventBus, type EventBusConfig } from '#core/event.bus'
import { DefaultSimulationClock, type SimulationClock, type ClockConfig } from '#core/clock'
import { DefaultOrchestrator, type TickMiddleware, type Orchestrator, type OrchestratorConfig, type SimulationEngine } from '#core/orchestrator'
import { createPRNG } from '#core/utils'
import { wallClock } from '#core/wall.clock'

export interface Simulation {
  readonly clock: SimulationClock
  readonly eventBus: EventBus
  readonly stateManager: StateManager
  readonly orchestrator: Orchestrator
  readonly metrics: MetricCollector
  readonly context: SimulationContext
  readonly randomSeed: number

  addEngine( engine: SimulationEngine ): void
  loadScenario( scenario: Scenario ): Promise<void>
  run(): Promise<void>
  stop(): void
  pause(): void
  resume(): void
  step( count?: number ): Promise<void>

  /** Takes a snapshot of current state and returns its unique ID. */
  snapshot(): string
  /**
   * Use { entities: false, metrics: true } to keep current entities
   * while rolling back only metrics.
   */
  restore( snapshotId: string, options?: RestoreOptions ): Promise<boolean>
}

export interface SimulationConfig {
  clock?: ClockConfig
  eventBus?: EventBusConfig
  orchestrator?: OrchestratorConfig
  metricsAutoFlushMs?: number
  snapshot?: SnapshotManagerConfig
  context?: Partial<Omit<SimulationContext, 'prng'>>
  /** Seed for the PRNG. Defaults to wallClock() — record it to replay. */
  randomSeed?: number
  /**
   * Optional factory that replaces DefaultOrchestrator with a custom implementation.
   *
   * The simulation constructs clock, eventBus, and stateManager first, then
   * passes them — along with the resolved OrchestratorConfig (including the
   * merged onAfterTick handlers) — into this factory.
   *
   * The cognitive layer uses this to inject CognitiveOrchestrator without
   * creating any import dependency from core → cognition.
   *
   * @example
   * ```ts
   * orchestratorFactory: (clock, eventBus, stateManager, cfg) =>
   *   new CognitiveOrchestrator(clock, eventBus, stateManager, cfg)
   * ```
   */
  orchestratorFactory?: (
    clock:        SimulationClock,
    eventBus:     EventBus,
    stateManager: StateManager,
    config:       OrchestratorConfig,
  ) => Orchestrator
}

export class DefaultSimulation implements Simulation {
  readonly clock: SimulationClock
  readonly eventBus: EventBus
  readonly stateManager: StateManager
  readonly snapshotManager: SnapshotManager
  readonly orchestrator: Orchestrator
  readonly metrics: DefaultMetricCollector
  readonly context: SimulationContext
  readonly randomSeed: number

  private _scenario: Scenario | null = null
  private _snapshots: Map<string, SimulationState> = new Map()

  constructor( config: SimulationConfig = {} ){
    const
    seed: number = config.randomSeed ?? wallClock(),
    prng: SeededPRNG = createPRNG( seed )

    this.randomSeed = seed
    this.clock = new DefaultSimulationClock( config.clock )
    // Stamp event timestamps from the sim clock (not wall time) so the event
    // log is reproducible on replay (R2). Caller-supplied `now` wins if set.
    this.eventBus = new DefaultEventBus( { now: () => this.clock.now, ...config.eventBus } )
    this.stateManager = new DefaultStateManager()
    this.snapshotManager = new SnapshotManager( config.snapshot )
    this.metrics = new DefaultMetricCollector( config.metricsAutoFlushMs ?? 5000 )

    /**
     * Both metrics and snapshots are core concerns — registered as
     * onAfterTick handlers in the orchestrator config.
     * 
     * The orchestrator calls them in registration order:
     *   1. metrics.onTick  — captures metric points
     *   2. snapshotManager.onTick — serializes state, feeds replay
     *   3. User-provided onAfterTick handlers (if any)
     */
    const coreAfterTick: TickMiddleware[] = [
      this.metrics.onTick,
      this.snapshotManager.onTick,
    ]

    // Merge user-provided onAfterTick handlers
    if( config.orchestrator?.onAfterTick ){
      const userHandlers = Array.isArray( config.orchestrator.onAfterTick )
        ? config.orchestrator.onAfterTick
        : [ config.orchestrator.onAfterTick ]
      
      coreAfterTick.push( ...userHandlers )
    }

    const orchestratorConfig: OrchestratorConfig = {
      ...config.orchestrator,
      onAfterTick: coreAfterTick,
    }

    this.orchestrator = config.orchestratorFactory
      ? config.orchestratorFactory( this.clock, this.eventBus, this.stateManager, orchestratorConfig )
      : new DefaultOrchestrator( this.clock, this.eventBus, this.stateManager, orchestratorConfig )

    this.context = {
      // Run-identity metadata, not replay/snapshot state: a brand-new run with no
      // caller-supplied id needs a unique handle; replay passes ids in via config.
      simulationId: config.context?.simulationId ?? crypto.randomUUID(), // determinism-ok: run-identity metadata
      runId: config.context?.runId ?? crypto.randomUUID(), // determinism-ok: run-identity metadata
      tags: config.context?.tags ?? {},
      prng
    }
  }

  addEngine( engine: SimulationEngine ): void {
    this.orchestrator.addEngine( engine )
  }

  async loadScenario( scenario: Scenario ): Promise<void> {
    const validation = scenario.validate()
    if( !validation.isValid )
      throw new Error(`Invalid scenario: ${validation.errors.join(', ')}`)

    this._scenario = scenario

    await scenario.initialize( this.stateManager, this.context )
  }

  async run(): Promise<void> {
    if( !this._scenario )
      throw new Error('No scenario loaded. Call loadScenario() first.')

    await this.orchestrator.start( this.context )
  }

  stop(): void { this.orchestrator.stop() }
  pause(): void { this.orchestrator.pause() }
  resume(): void { this.orchestrator.resume() }

  async step( count: number = 1 ): Promise<void> {
    await this.orchestrator.step( count, {
      simulationId: this.context.simulationId,
      runId: this.context.runId
    })
  }

  snapshot(): string {
    const
    state = this.stateManager.snapshot(),
    snapshotId = `snapshot_${this.context.runId}_${this.clock.currentTick}_${wallClock()}`

    this._snapshots.set( snapshotId, state )
    return snapshotId
  }

  /**
   * Forwards RestoreOptions to StateManager
   * for partial restore capability.
   */
  async restore( snapshotId: string, options?: RestoreOptions ): Promise<boolean> {
    const snapshot = this._snapshots.get( snapshotId )
    if( !snapshot ) return false

    this.stateManager.restore( snapshot, options )
    return true
  }
}
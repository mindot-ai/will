// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/task.switcher.ts
// ─────────────────────────────────────────────────────────────

/**
 * TaskSwitcher — manages attention shifts between competing goals.
 *
 * When multiple goals compete for attention, the TaskSwitcher:
 *   1. Compares active goal priorities
 *   2. Applies switching costs (attention residue from previous focus)
 *   3. Decides whether to maintain current focus or switch
 *   4. Signals the AttentionAllocator to reallocate
 *
 * Switching is costly — frequent switching degrades performance.
 * The TaskSwitcher balances exploitation (stay on current goal) vs.
 * exploration (switch to potentially higher-value goal).
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface TaskSwitcherConfig {
  /** Base switching cost (0-1, fraction of attention lost on switch) */
  baseSwitchCost?: number
  /** How much priority advantage a new goal needs to justify switching */
  switchThreshold?: number
  /** Minimum ticks on a goal before switching is considered */
  minFocusTicks?: number
  bus?: CognitiveBus
}

interface CurrentFocus {
  goalId: string | null
  focusTicks: number
  startedAt: Tick
}

export class TaskSwitcher implements SimulationEngine, CognitiveEngine {
  readonly name     = 'task-switcher'
  
  private _baseSwitchCost: number
  private _switchThreshold: number
  private _minFocusTicks: number

  private _currentFocus: CurrentFocus = {
    goalId: null,
    focusTicks: 0,
    startedAt: 0,
  }

  private _totalSwitches = 0

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: TaskSwitcherConfig = {} ){
    this._bus = config.bus ?? null
    this._baseSwitchCost  = config.baseSwitchCost  ?? 0.3
    this._switchThreshold = config.switchThreshold ?? 0.2
    this._minFocusTicks   = config.minFocusTicks   ?? 3
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-task-switcher ⊕ persona-prior. Channel A: a
    // conscientious Will develops a higher baseSwitchCost and so is less distractible.
    const p = readEffectiveParams( state, 'engine-config-task-switcher' )
    if( p.baseSwitchCost != null ) this._baseSwitchCost = p.baseSwitchCost
    if( p.switchThreshold != null ) this._switchThreshold = p.switchThreshold
    if( p.minFocusTicks != null ) this._minFocusTicks = p.minFocusTicks
  }


  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('executive') )
        this._model.setPrecision( 'task.focus_ticks', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )
    
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // 1. Get active goals sorted by priority
    const activeGoals = this._getActiveGoals( state )

    // 2. Increment focus counter
    this._currentFocus.focusTicks++

    // 3. Evaluate whether to switch
    let switched = false
    let switchReason = ''

    if( activeGoals.length > 0 ){
      const topGoal = activeGoals[0]!

      if( this._currentFocus.goalId === null ){
        // First focus — adopt the top goal
        this._currentFocus = {
          goalId: topGoal.id,
          focusTicks: 0,
          startedAt: tick,
        }
        switched = true
        switchReason = 'initial_focus'
      }
      else if( topGoal.id !== this._currentFocus.goalId ){
        // Potential switch — evaluate
        const currentGoal = activeGoals.find( g => g.id === this._currentFocus.goalId )
        const currentPriority = currentGoal?.priority ?? 0
        const switchAdvantage = topGoal.priority - currentPriority

        // Account for switching cost
        const switchCost = this._baseSwitchCost * ( 1 + this._currentFocus.focusTicks * 0.01 )
        const netBenefit = switchAdvantage - switchCost

        if( netBenefit > this._switchThreshold
            && this._currentFocus.focusTicks >= this._minFocusTicks ){
          // Switch
          this._currentFocus = {
            goalId: topGoal.id,
            focusTicks: 0,
            startedAt: tick,
          }
          this._totalSwitches++
          switched = true
          switchReason = `switched_from_${currentGoal?.description ?? 'unknown'}_to_${topGoal.description}`
        }
      }
    }
    else if( this._currentFocus.goalId !== null ){
      // No active goals — release focus
      this._currentFocus = { goalId: null, focusTicks: 0, startedAt: 0 }
      switched = true
      switchReason = 'no_active_goals'
    }

    // 4. Update metrics
    commands.metrics!.push(
      [ 'task_switch.current_focus_ticks', this._currentFocus.focusTicks ],
      [ 'task_switch.total_switches', this._totalSwitches ],
      [ 'task_switch.switch_cost', this._baseSwitchCost ],
    )

    // 5. Persist current focus
    if( this._currentFocus.goalId ){
      commands.set = [{
        id: 'task-switch-focus',
        type: 'task.focus',
        createdAt: this._currentFocus.startedAt,
        metadata: {
          goalId: this._currentFocus.goalId,
          focusTicks: this._currentFocus.focusTicks,
          startedAt: this._currentFocus.startedAt,
        },
      }]
    }

    if( switched )
      events.push({
        type: 'task_switch.executed',
        source: this.name,
        payload: {
          newGoalId: this._currentFocus.goalId,
          reason: switchReason,
          totalSwitches: this._totalSwitches,
        },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus ){
      const predErr = this._model.observe( 'task.focus_ticks', this._currentFocus.focusTicks )
      if( !predErr.gated )
        _bus.publish({ type: 'task.focus.changed', version: 1, sourceEngine: this.name, salience: Math.max( 0.3, predErr.salience ), payload: { focusTicks: this._currentFocus.focusTicks } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  private _getActiveGoals( state: ReadonlySimulationState ): Array<{ id: string; priority: number; description: string }> {
    const goals: Array<{ id: string; priority: number; description: string }> = []

    for( const entity of state.entities.values() ){
      if( entity.type === 'goal' && entity.metadata?.status === 'active'){
        goals.push({
          id: entity.id,
          priority: ( entity.metadata.priority as number ) ?? 0,
          description: ( entity.metadata.description as string ) ?? entity.id,
        })
      }
    }

    goals.sort( ( a, b ) => b.priority - a.priority )
    return goals
  }

  /**
   * Get the current focus goal ID.
   */
  getCurrentFocus(): string | null {
    return this._currentFocus.goalId
  }
}
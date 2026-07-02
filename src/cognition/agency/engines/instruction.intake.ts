// ─────────────────────────────────────────────────────────────
// src/agency/instruction.intake.ts  —  instruction → goal
// ─────────────────────────────────────────────────────────────
//
// External instructions (developer/host directives injected into state) become
// the Will's own goals here. This role used to live inside the legacy
// ActionExecutor; on the agency cutover it moves to a small dedicated intake so
// the legacy executor can be retired. Behaviour is preserved verbatim: each tick
// it drains pending instructions and converts them to goals via the same
// InstructionHandler + GoalManager.
// ─────────────────────────────────────────────────────────────

import type {
  Duration, Tick, SimulationContext, ReadonlySimulationState,
} from '#core/types'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { InstructionHandler } from '#cognition/instruction.handler'
import type { GoalManager } from '#faculties/goal.manager'

export class InstructionIntake implements CognitiveEngine {
  readonly name = 'instruction-intake'

  private _instructionHandler: InstructionHandler | null = null
  private _goalManager:        GoalManager | null = null

  attachInstructionHandler( h: InstructionHandler ): void { this._instructionHandler = h }
  attachGoalManager( gm: GoalManager ): void { this._goalManager = gm }

  publishes(): CognitiveEventSchema[] { return [] }
  subscribes(): string[] { return [] }
  onCognitiveEvent(): void { /* pull model — reads pending instructions from state */ }
  snapshot(): Record<string, unknown> {
    return { pending: this._instructionHandler?.getPending().length ?? 0 }
  }

  async react(
    _delta:   Duration,
    _tick:    Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    const handler = this._instructionHandler
    const goals   = this._goalManager
    if( !handler || !goals ) return { commands: {} }

    for( const instruction of handler.evaluatePending( state, [] ) ){
      const g = handler.convertToGoal( instruction )
      goals.addGoal( g.description, g.priority, g.tags, undefined, undefined, g.completionType, g.completionCondition )
    }

    return { commands: {} }
  }
}

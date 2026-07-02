// ─────────────────────────────────────────────────────────────
// src/cognition/instruction.handler.ts
// ─────────────────────────────────────────────────────────────

import type { ReadonlySimulationState } from '#core/types'
import { wallClock } from '#core/wall.clock'

export interface Instruction {
  /** Unique ID */
  id: string
  /** Who gave the instruction */
  source: string
  /** What to do */
  directive: string
  /** Priority override (0-1, higher = more important) */
  priority: number
  /** Deadline in ticks (if any) */
  deadline?: number
  /** Constraints on how to execute */
  constraints?: string[]
  /** Context/provenance — why this instruction was given */
  context: string
  /** Whether the Will can refuse */
  isOverridable: boolean
  /** Status */
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'refused' | 'failed'
  /** When it was received */
  receivedAt: number
}

export class InstructionHandler {
  private _pending: Instruction[] = []
  private _history: Instruction[] = []

  /**
   * Receive an instruction from an external source.
   * Converts it to a goal in the GoalManager if accepted.
   */
  receive( instruction: Omit<Instruction, 'status' | 'receivedAt'> ): Instruction {
    const full: Instruction = {
      ...instruction,
      status: 'pending',
      // External arrival timestamp — bookkeeping only, never persisted to entity
      // state, the event log, or a snapshot (convertToGoal drops it), so this is
      // a legitimate wall-clock boundary rather than replay-affecting state.
      receivedAt: wallClock(),
    }
    this._pending.push( full )
    return full
  }

  /**
   * Evaluate pending instructions against current state.
   * Called each tick before decision-making.
   * Returns instructions that should be converted to goals.
   */
  evaluatePending(
    state: ReadonlySimulationState,
    currentValues: string[]
  ): Instruction[] {
    const actionable: Instruction[] = []

    for( const instruction of this._pending ){
      if( instruction.status !== 'pending') continue

      // Check if the Will should refuse based on values
      if( this._shouldRefuse( instruction, state, currentValues ) ){
        instruction.status = 'refused'
        this._history.push( instruction )
        continue
      }

      instruction.status = 'accepted'
      actionable.push( instruction )
    }

    // Clean up processed instructions
    this._pending = this._pending.filter( i => i.status === 'pending')
    return actionable
  }

  /**
   * Convert accepted instructions into goals.
   */
  convertToGoal( instruction: Instruction ): {
    description: string
    priority: number
    tags: string[]
    completionType: 'action'
    completionCondition?: string
  } {
    return {
      description: instruction.directive,
      priority: instruction.priority,
      tags: [ 'instruction', `source:${instruction.source}` ],
      completionType: 'action',
      completionCondition: instruction.constraints?.join(' AND '),
    }
  }

  markCompleted( instructionId: string ): void {
    const instruction = this._history.find( i => i.id === instructionId )
    if( instruction ) instruction.status = 'completed'
  }

  markFailed( instructionId: string, reason: string ): void {
    const instruction = this._history.find( i => i.id === instructionId )
    if( instruction ){
      instruction.status = 'failed'
      instruction.context += ` | Failed: ${reason}`
    }
  }

  getPending(): ReadonlyArray<Instruction> {
    return this._pending
  }

  getHistory(): ReadonlyArray<Instruction> {
    return this._history
  }

  private _shouldRefuse(
    instruction: Instruction,
    _state: ReadonlySimulationState,
    values: string[]
  ): boolean {
    // Can't refuse non-overridable instructions
    if( !instruction.isOverridable ) return false

    // Check against core values
    if( values.includes('self-preservation') ){
      // Check if instruction seems dangerous
      const dangerous = [ 'attack', 'destroy', 'harm', 'kill', 'steal' ]
      if( dangerous.some( d => instruction.directive.toLowerCase().includes( d ) ) )
        return true
    }

    if( values.includes('honesty') ){
      const deceptive = [ 'lie', 'deceive', 'trick', 'manipulate' ]
      if( deceptive.some( d => instruction.directive.toLowerCase().includes( d ) ) )
        return true
    }

    return false
  }
}
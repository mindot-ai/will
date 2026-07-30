// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/messages.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { Tick, ReadonlySimulationState } from '#core/types'
import type { PendingMessage } from '#faculties/executive.engine/types'

/**
 * Message queue state — tracks incoming communication entities,
 * pending messages during in-flight LLM calls, and reply deduplication.
 */
export class MessageQueue {
  /** Messages buffered while an LLM call is in-flight. */
  pendingMessages: PendingMessage[] = []

  /** Tick when the current (or most recent) LLM call started. */
  pendingCallStartTick: number = -1

  /** Entity IDs of communication entities that have been replied to this session. */
  private _repliedEntityIds = new Set<string>()


  /**
   * Clear messages that were included in the most recent LLM call.
   * Any that arrived after the call started remain for the next cycle.
   */
  clearProcessedMessages(): void {
    this.pendingMessages = this.pendingMessages.filter( m => m.tick > this.pendingCallStartTick )
  }

  /**
   * Check if we've already replied to a specific communication entity this session.
   */
  hasRepliedTo( entityId: string ): boolean {
    return this._repliedEntityIds.has( entityId )
  }

  /**
   * Mark a communication entity as replied to.
   */
  markReplied( entityId: string ): void {
    this._repliedEntityIds.add( entityId )
  }


}
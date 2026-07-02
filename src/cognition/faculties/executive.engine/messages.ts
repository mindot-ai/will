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
   * Scan the simulation state for unprocessed communication entities
   * and queue them into pendingMessages. Call every tick.
   */
  scanState( state: ReadonlySimulationState, tick: Tick ): void {
    const seenIds = new Set( this.pendingMessages.map( m => m.id ) )

    for( const [ id, entity ] of state.entities ){
      if( entity.type !== 'communication' ) continue
      if( entity.metadata?.processedByExecutive ) continue
      if( seenIds.has( id ) ) continue

      const msgTick = ( entity.metadata?.tick as number ) ?? 0
      this.pendingMessages.push({
        id,
        content: (entity.metadata?.content as string) ?? '',
        sender: (entity.metadata?.agentName as string) ?? 'unknown',
        senderId: (entity.metadata?.keid as string) ?? 'unknown',
        tick: msgTick
      })

      logger.info(`[executive] queued message from ${(entity.metadata?.agentName as string) ?? 'unknown'} (tick=${msgTick})`)
    }
  }

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

  /**
   * Build the set of communication entity IDs visible in state within the
   * 30-tick window, plus any pending messages. Used to mark them as processed.
   */
  getVisibleMessageIds( state: ReadonlySimulationState, tick: Tick ): Set<string> {
    const ids = new Set<string>( this.pendingMessages.map( m => m.id ) )
    for( const [ id, entity ] of state.entities ){
      if( entity.type !== 'communication' ) continue

      const msgTick = (entity.metadata?.tick as number) ?? 0
      if( tick - msgTick > 30 ) continue

      ids.add( id )
    }

    return ids
  }

  /**
   * Get stale communication entity IDs (>50 ticks old) for cleanup.
   */
  getStaleMessageIds( state: ReadonlySimulationState, tick: Tick ): string[] {
    const stale: string[] = []
    for( const [ id, entity ] of state.entities ){
      if( entity.type !== 'communication' ) continue

      const msgTick = (entity.metadata?.tick as number) ?? 0
      tick - msgTick > 50 && stale.push( id )
    }

    return stale
  }
}
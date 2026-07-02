// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/escalation.buffer.ts
// ─────────────────────────────────────────────────────────────
//
// EscalationBuffer — pending audition→executive escalations (R5-g-2).
//
// The AuditionEngine publishes `audition.task.signal` events when a facet
// conversation surfaces work the master should own. Those events arrive
// between tick boundaries, while state is read-only, so they can't be written
// as percepts directly. This buffer holds them until the next
// onReasoningComplete(), where they are drained into high-salience percept
// entities (StateCommands.set) so Exteroception surfaces them as
// "## Percepts (What You Notice)" on the following master cycle.
//
// The master reads these as environmental signals — NEVER as incoming
// messages — and responds by creating plans/goals, never by emitting [REPLY];
// the facet handles the actual communication.
//
// Extracted verbatim from ExecutiveEngine (R5-g-2) as a pure collaborator.
// The salience-spike that wakes the master after a push stays in the engine
// (it touches gating state, not this buffer).
// ─────────────────────────────────────────────────────────────

import type { EntityInput } from '#core/types'

export interface PendingEscalation {
  entityId:  string
  threadId:  string
  reasoning: string
  tick:      number
}

/** Requester context captured from the first buffered escalation, used to tag new goals. */
export interface EscalationRequester {
  entityId: string
  threadId: string
}

export interface DrainedEscalations {
  /** High-salience percept entities to merge into StateCommands.set. */
  percepts: EntityInput[]
  /** First escalation's requester context, or undefined when the buffer was empty. */
  requester?: EscalationRequester
}

export class EscalationBuffer {
  private _pending: PendingEscalation[] = []

  /** Buffer one escalation for injection on the next master cycle. */
  push( escalation: PendingEscalation ): void {
    this._pending.push( escalation )
  }

  get size(): number    { return this._pending.length }
  get isEmpty(): boolean { return this._pending.length === 0 }

  /**
   * Convert every buffered escalation into a high-salience percept entity and
   * clear the buffer. Returns the percepts plus the first escalation's
   * requester context (used to tag goals the master creates in response).
   */
  drainToPercepts(): DrainedEscalations {
    const percepts: EntityInput[] = []
    for( const esc of this._pending ){
      percepts.push({
        id:        `escalation-percept-${esc.entityId}-${esc.tick}`,
        type:      'percept',
        metadata: {
          category:   'task-escalation',
          summary:    `[Task from conversation with ${esc.entityId}] ${esc.reasoning}`,
          salience:   0.85,
          source:     'audition-facet',
          entityId:   esc.entityId,
          threadId:   esc.threadId,
          // Guides the master's response: plan, don't reply
          directive:  'Create a plan or update goals. Do not emit [REPLY] — the facet handles communication.',
        }
      })
    }

    // Capture requester context before clearing — used to tag new goals.
    const first = this._pending[0]
    const requester: EscalationRequester | undefined =
      first ? { entityId: first.entityId, threadId: first.threadId } : undefined

    this._pending = []

    return { percepts, requester }
  }
}

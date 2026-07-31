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
// "## Percepts (What I Notice)" on the following master cycle.
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
  /**
   * Present when the conversation produced an intention toward a THIRD party
   * ("I'll reach out to FKEM now") rather than work for the master to plan. The
   * facet never opens that channel itself, so this is the only thing standing
   * between having decided to make contact and having made it.
   */
  undertaking?: { target: string; gist?: string }
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
    let seq = 0
    for( const esc of this._pending ){
      // Distinct ids per drain: two undertakings from one conversation on one tick
      // are two separate things the mind decided to do, and keying on (entity, tick)
      // alone would silently collapse them into whichever came last.
      const id = `escalation-percept-${esc.entityId}-${esc.tick}-${seq++}`

      percepts.push( esc.undertaking
        ? {
          id,
          type: 'percept',
          metadata: {
            category: 'undertaking',
            // First person: this is the mind noticing what IT said it would do, not
            // a report handed to it. What makes it act is that the words are still
            // unsent — an undertaking it has already honoured reads the same until
            // it checks, which is exactly the check we want it making.
            // Everything actionable goes in `summary`: that is the only field the
            // executive context actually renders (context.ts extractPercepts reads
            // summary/content and nothing else).
            //
            // The closing clause is the whole point. A mind that has SAID it will make
            // contact remembers deciding, and cannot tell from the inside whether the
            // words went out — so it follows up on a message it never sent. Naming the
            // gap is what lets it check. It stays a decision either way: it may have
            // changed its mind, or judge this the wrong moment, and a reach-out
            // competes with everything else like any other action.
            summary: `In my conversation with ${esc.entityId} I said I would reach ${esc.undertaking.target}`
              + ( esc.undertaking.gist ? ` — what I meant to say: "${esc.undertaking.gist.slice( 0, 220 )}"` : '')
              + `. Nothing has gone to them yet; saying it in that conversation did not send it.`
              + ` If I still mean it, I reach out with target '${esc.undertaking.target}'.`
              + ` If I no longer do, I let it go — but I do not leave it half-done while telling them it is handled.`,
            salience: 0.85,
            source:   'audition-facet',
            entityId: esc.entityId,
            threadId: esc.threadId,
            // Who was promised, and when the promise was made. The executive
            // reconciles against these (see _reconcileUndertakings): once the mind
            // has actually reached this target since `tick`, the percept is retired
            // rather than left standing as a claim the words are still unsent.
            undertakingTarget: esc.undertaking.target,
            tick:              esc.tick,
          },
        }
        : {
          id,
          type: 'percept',
          metadata: {
            category:   'task-escalation',
            // The steer lives IN the summary because that is the only field the
            // executive context renders (context.ts extractPercepts reads
            // summary/content and nothing else). It sat in a sibling `directive`
            // field for its whole life and never once reached the master.
            summary:    `[Task from conversation with ${esc.entityId}] ${esc.reasoning}`
              + ' — this is mine to plan or re-goal; the facet handles the talking.',
            salience:   0.85,
            source:     'audition-facet',
            entityId:   esc.entityId,
            threadId:   esc.threadId,
          },
        } )
    }

    // Capture requester context before clearing — used to tag new goals.
    const first = this._pending[0]
    const requester: EscalationRequester | undefined =
      first ? { entityId: first.entityId, threadId: first.threadId } : undefined

    this._pending = []

    return { percepts, requester }
  }
}

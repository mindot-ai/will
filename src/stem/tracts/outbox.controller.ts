// ─────────────────────────────────────────────────────────────
// src/stem/tracts/outbox.controller.ts  —  per-Will messaging / outbox subsystem
// ─────────────────────────────────────────────────────────────
//
// OutboxController owns the outbound-message machinery extracted from
// WillStem (R5-c): draining / peeking / re-queuing the per-Will outbox,
// the message-delivery receipt (reafference percept), and TTL expiry of
// stale messages. WillStem delegates drainOutbox/peekOutbox/
// requeueToOutbox/confirmMessageDelivery here and calls expireStale()
// from its tick loop, so the god-object no longer owns this concern.
//
// The outbox ops touch only WillInstance fields (no Will id needed), so
// these methods take the resolved instance directly. WillStem still
// validates existence via _get(id) before delegating.
//
// OUTBOX_TTL_TICKS lives here (source of truth) and is re-exported from
// #stem/index for backward-compatible public-API consumers.
//
// Behaviour is preserved verbatim from the original WillStem methods;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import type { OutboxMessage } from '#types'
import { perceptEntity } from '#cognition/percept.entity'
import type { WillInstance } from '#stem/index'

/**
 * Number of ticks an undelivered outbox message survives before it is
 * expired. Override via WILL_OUTBOX_TTL_TICKS. Default: 100 ticks.
 */
export const OUTBOX_TTL_TICKS = parseInt( process.env.WILL_OUTBOX_TTL_TICKS ?? '100')

export class OutboxController {
  /**
   * Drain all queued outbound messages from the Will's outbox.
   * Called by the SSE/webhook delivery layer to retrieve messages.
   * Stamps each message with the current tick if createdAtTick is 0.
   */
  drain( instance: WillInstance ): OutboxMessage[] {
    const messages = instance.outbox.splice( 0 )

    for( const msg of messages )
      if( msg.createdAtTick === 0 ) msg.createdAtTick = instance.tickCount

    return messages
  }

  /** Peek at outbox without draining it. */
  peek( instance: WillInstance ): readonly OutboxMessage[] {
    return instance.outbox
  }

  /**
   * Re-queue messages that were drained but not successfully delivered.
   * Prepends them so they are the first to be drained on the next tick.
   */
  requeue( instance: WillInstance, messages: OutboxMessage[] ): void {
    if( messages.length === 0 ) return
    instance.outbox.unshift( ...messages )
  }

  /**
   * Called by the delivery layer (SSE consumer or webhook) after a message
   * has been confirmed received by the target entity.
   *
   * Writes a message.delivery percept so the mind perceives its own words
   * landing — the "ear hears the word you spoke" reafference signal.
   */
  confirmDelivery( instance: WillInstance, messageId: string, delivered: boolean ): void {
    const tick = instance.tickCount

    // 1. Update the conversation.sent entity that tracks this outbox message.
    //    ProactiveCommunicator stores outboxMessageIds in the entity metadata (11.3)
    //    so we can correlate messageId → sent entity without extra bookkeeping.
    //    Use the O(1) type index rather than scanning every entity.
    for( const entity of instance.simulation.stateManager.getEntitiesByType('conversation.sent') ){
      const ids = entity.metadata?.outboxMessageIds as string[] | undefined
      if( !ids?.includes( messageId ) ) continue

      instance.simulation.stateManager.setEntity({
        id:        entity.id,
        type:      'conversation.sent',
        createdAt: entity.createdAt,
        updatedAt: Date.now(),
        metadata: {
          ...entity.metadata,
          delivered,
          deliveredAt: tick,
        },
      })

      break
    }

    // 2. Write a percept so Exteroception perceives delivery ("ear hears the word")
    //
    // The `tick` is what stops this leaking, and it was missing since the day
    // this was written. `exteroception._collectStalePerceptIds` is the only
    // sweeper of this type and collects only entities whose `metadata.tick` is
    // a number, so this one was IMMORTAL — one permanent entity per message the
    // mind ever successfully sent. Worse than memory: `extractPercepts` ranks
    // percepts by salience with NO recency filter, so a failed delivery at 0.6
    // held an executive percept slot for the rest of the mind's life, offering
    // a months-old failure as something just noticed.
    //
    // Sweeping loses nothing. `working.memory._ingestPercepts` copies every
    // percept into WM on the next tick, deduped by source id — state is the
    // staging area, WM is where it is remembered.
    instance.simulation.stateManager.setEntity( perceptEntity( {
      id:         `msg-delivered-${messageId}`,
      tick,
      category:   'message-delivery',
      summary:    delivered
        ? `My message was delivered successfully.`
        : `My message failed to reach the recipient.`,
      salience:   delivered ? 0.35 : 0.6,
      changeType: delivered ? 'delivered' : 'failed',
      // Reafference by construction — this percept describes our own action's
      // outcome ("ear hears the word"). Tagged, not attenuated: it is the ack
      // surface, not a content echo (EXAFFERENCE P2).
      provenance: 'reafferent',
    }, { messageId } ) )

    instance.sessionLogger?.write({
      type:      'conversation.delivery',
      tick,
      messageId,
      delivered,
    } as any)
  }

  /**
   * Expire stale outbox messages. Called from the Will tick loop each tick.
   *
   * Messages created with createdAtTick=0 (OutboxWriter default) have not yet been
   * stamped with a real tick — stamp them now so the TTL clock starts here rather
   * than instantly expiring them (age = tickCount - 0 would be >> TTL).
   * Mutate in-place (splice, not filter) so the shared outbox array (held by
   * OutboxWriter) continues to reference the same object after TTL cleanup.
   * Array.filter() would create a new array and silently detach the shared ref.
   */
  expireStale( instance: WillInstance ): void {
    const expiredMessages: OutboxMessage[] = []

    for( let i = instance.outbox.length - 1; i >= 0; i-- ){
      const msg = instance.outbox[ i ]!
      if( msg.createdAtTick === 0 ) msg.createdAtTick = instance.tickCount

      const age = instance.tickCount - msg.createdAtTick
      if( age > OUTBOX_TTL_TICKS ){
        expiredMessages.push( msg )
        instance.outbox.splice( i, 1 )
      }
    }

    for( const msg of expiredMessages ){
      instance.sessionLogger?.write({
        type:           'outbox.expire',
        tick:           instance.tickCount,
        messageId:      msg.id,
        targetEntityId: msg.targetEntityId,
        effectorName:    msg.effectorName,
        ageAtExpiry:    instance.tickCount - msg.createdAtTick,
      })

      try {
        instance.simulation.eventBus.publish(
          {
            type:    'communication.outbound.undelivered',
            source:  'will-manager',
            payload: { messageId: msg.id, targetEntityId: msg.targetEntityId, effectorName: msg.effectorName },
          },
          instance.simulation.context,
          instance.tickCount as any,
        )
      }
      catch { /* event bus may not be flushing — non-critical */ }
    }
  }
}

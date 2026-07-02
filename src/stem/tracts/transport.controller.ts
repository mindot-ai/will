// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport.controller.ts
// ─────────────────────────────────────────────────────────────
//
// TransportController — owns the ExternalTransport ↔ tick-loop boundary.
//
//   - attach()       wires the transport's inbound stream into the instance's
//                    tick-stamped InboundQueue (NEVER applies inline)
//   - applyInbound() drains the queue and applies every envelope at a fixed
//                    point in the tick (called by WillStem before step())
//   - detach()       tears the transport down
//
// DETERMINISM (see EXTERNAL_TRANSPORT_TODO.md § guardrails):
//   - Inbound arrival (onInbound) only enqueues — application is deferred to the
//     tick so timing is decoupled from the non-deterministic socket.
//   - Result-acks cross into simulation state via confirmExecution(), applied
//     synchronously before step() so the step sees them.
//   - Messages/percepts are fire-and-forget: their async reasoning is recorded
//     and replayed by the LLM layer, not the deterministic core, so the tick
//     must not block on them.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { wallClock } from '#core/wall.clock'
import { getInboundRecorder, getInboundSource } from '#core/inbound.recorder'
import type { SensoryInput } from '#senses/index'
import type { effectorInvocation, OutboxMessage } from '#types'
import type { WillInstance } from '#stem/index'
import type { InboundEnvelope, OutboundEnvelope } from './transport/types'
import type { effectorController } from './effector.controller'
import type { OutboxController } from './outbox.controller'
import type { SensoryController } from './sensory.controller'
import { AckReconciler } from './ack.reconciler'

/**
 * Cap on un-acked outbound envelopes buffered per Will for reconnect re-emit.
 * A peer that never acks would otherwise grow `_pending` without bound; past the
 * cap the oldest un-acked envelope is dropped (FIFO), matching the outbox TTL's
 * "stale outbound eventually gives up" stance.
 */
const MAX_PENDING_PER_WILL = 1_000

/** Collaborators applyInbound() needs to route each inbound channel. */
export interface InboundApplyDeps {
  effector: effectorController
  outbox:  OutboxController
  sensory: SensoryController
}

export class TransportController {
  /** Monotonic outbound sequence number per Will — for peer ordering / dedup. */
  private readonly _seq = new Map<string, number>()
  /** Unsubscribe for the engine chunk-stream subscription, per Will. */
  private readonly _chunkUnsub = new Map<string, () => void>()
  /** Per-Will ack deduper for the dual (callback + discrete-event) ack paths. */
  private readonly _reconcilers = new Map<string, AckReconciler>()
  /** Activity-listener + status-listener unsubscribes, per Will. */
  private readonly _activityUnsub = new Map<string, () => void>()
  private readonly _statusUnsub   = new Map<string, () => void>()
  /**
   * Un-acked outbound envelopes per Will (correlationId → envelope), for
   * messages/invocations only — re-emitted when the transport reconnects.
   * Replies/chunks/activity are ephemeral ('none') and not buffered.
   */
  private readonly _pending = new Map<string, Map<string, OutboundEnvelope>>()

  private _pendingFor( id: string ): Map<string, OutboundEnvelope> {
    let m = this._pending.get( id )
    if( !m ){ m = new Map(); this._pending.set( id, m ) }
    return m
  }

  private _nextSeq( id: string ): number {
    const n = ( this._seq.get( id ) ?? 0 ) + 1
    this._seq.set( id, n )
    return n
  }

  private _reconciler( id: string ): AckReconciler {
    let r = this._reconcilers.get( id )
    if( !r ){ r = new AckReconciler(); this._reconcilers.set( id, r ) }
    return r
  }

  /**
   * Emit an outbound envelope. When `reconcileAs` is set, the socket.io emit-callback
   * ack is marshaled back onto the tick-stamped InboundQueue as an `ack` envelope —
   * the SAME path discrete ack events take — so applyInbound() reconciles both
   * idempotently. 'none' = fire-and-forget (chunks, replies: no outbox entry to mark).
   */
  private _emit( instance: WillInstance, env: OutboundEnvelope, reconcileAs: 'delivery' | 'result' | 'none' ): void {
    const transport = instance.transport
    if( !transport ) return

    // Buffer state-affecting outbound until acked, so a reconnect can re-emit it.
    if( reconcileAs !== 'none' ){
      const pending = this._pendingFor( instance.config.id )
      pending.set( env.correlationId, env )
      // Bound the buffer — drop the oldest un-acked envelope past the cap (FIFO).
      while( pending.size > MAX_PENDING_PER_WILL ){
        const oldest = pending.keys().next().value
        if( oldest === undefined ) break
        pending.delete( oldest )
      }
    }

    const pending = transport.emit( env )
    if( reconcileAs === 'none' ){ void pending; return }

    void pending.then( ack => {
      if( !ack.acked ) return
      const result = reconcileAs === 'result' ? this._asResult( ack.payload ) : null
      instance.inbound.enqueue(
        result
          ? { channel: 'ack', ackKind: 'result',   result,          willId: instance.config.id, correlationId: env.correlationId, seq: 0, wallTime: wallClock() }
          : { channel: 'ack', ackKind: 'delivery', delivered: true, willId: instance.config.id, correlationId: env.correlationId, seq: 0, wallTime: wallClock() }
      )
    } ).catch( () => {} )
  }

  /** Coerce an emit-callback ack payload into a confirmExecution result, or null. */
  private _asResult( payload: unknown ): { success: boolean; description: string; metrics?: Record<string, number> } | null {
    if( payload && typeof payload === 'object' && typeof ( payload as { success?: unknown } ).success === 'boolean' ){
      const p = payload as { success: boolean; description?: unknown; metrics?: Record<string, number> }
      return { success: p.success, description: String( p.description ?? '' ), ...( p.metrics ? { metrics: p.metrics } : {} ) }
    }
    return null
  }

  /**
   * Emit a SessionLogger entry as a `session_log` observability envelope.
   * Fire-and-forget — the consumer's transport owns persistence. No-op without a
   * transport (dev file logging still happens inside SessionLogger).
   */
  emitSessionLog( instance: WillInstance, entry: Record<string, unknown> ): void {
    if( !instance.transport ) return
    const seq = this._nextSeq( instance.config.id )
    this._emit( instance, {
      channel:       'session_log',
      willId:        instance.config.id,
      correlationId: `session_log-${seq}`,
      seq,
      wallTime:      wallClock(),
      entry,
    }, 'none' )
  }

  /**
   * Emit an attributed token/cost ledger record as a `token_report` envelope so
   * the consumer can meter/re-bill from the stream. Fire-and-forget.
   */
  emitTokenReport( instance: WillInstance, report: Record<string, unknown> ): void {
    if( !instance.transport ) return
    const seq = this._nextSeq( instance.config.id )
    this._emit( instance, {
      channel:       'token_report',
      willId:        instance.config.id,
      correlationId: `token_report-${seq}`,
      seq,
      wallTime:      wallClock(),
      report,
    }, 'none' )
  }

  /**
   * Wire the transport's inbound stream into the instance's tick-stamped queue,
   * and the engines' outbound fast-paths (reply) into transport emits.
   */
  attach( instance: WillInstance ): void {
    const transport = instance.transport
    if( !transport ) return

    instance._transportUnsub = transport.onInbound( env => instance.inbound.enqueue( env ) )

    // Outbound reply fast-path (2.1): emit the instant the facet decides — off-tick.
    // 'none': the reply bubbles aren't in the outbox when a transport is present
    // (AuditionEngine skips the outbox push), so there's no delivery-ack to apply.
    instance.cognition.auditionEngine.attachReplyCallback( ( entityId, threadId, bubbles ) => {
      this._emit( instance, {
        channel:       'reply',
        willId:        instance.config.id,
        correlationId: `reply-${entityId}-${wallClock()}`,
        seq:           this._nextSeq( instance.config.id ),
        wallTime:      wallClock(),
        entityId,
        threadId,
        bubbles,
      }, 'none' )
    } )

    // Outbound chunk fast-path (2.2): stream each filtered reply token off-tick.
    // Multi-subscriber chunk callback — coexists with the SSE fan-out.
    const chunkUnsub = instance.cognition.auditionEngine.addChunkCallback( ( entityId, threadId, content ) => {
      this._emit( instance, {
        channel:       'chunk',
        willId:        instance.config.id,
        correlationId: `chunk-${entityId}`,
        seq:           this._nextSeq( instance.config.id ),
        wallTime:      wallClock(),
        entityId,
        threadId,
        content,
      }, 'none' )
    } )
    this._chunkUnsub.set( instance.config.id, chunkUnsub )

    // Outbound activity projection (2.5): forward all plan/activity events
    // ('*' wildcard = no entity filter). Observability only — fire-and-forget.
    const activityUnsub = instance.cognition.planningEngine.addActivityListener( '*', event => {
      this._emit( instance, {
        channel:       'activity',
        willId:        instance.config.id,
        correlationId: `activity-${event.planId}-${event.type}-${wallClock()}`,
        seq:           this._nextSeq( instance.config.id ),
        wallTime:      wallClock(),
        entityId:      event.requestingEntityId ?? '',
        eventType:     event.type,
        payload:       { ...event },
      }, 'none' )
    } )
    this._activityUnsub.set( instance.config.id, activityUnsub )

    // Reconnect: re-emit un-acked messages/invocations when the link returns.
    const statusUnsub = transport.onStatus( status => {
      if( status === 'connected' ) this._reemitPending( instance )
    } )
    this._statusUnsub.set( instance.config.id, statusUnsub )

    logger.info(`[transport] attached inbound + outbound streams for ${instance.config.id}`)
  }

  /** Re-emit un-acked outbound envelopes after the transport reconnects. */
  private _reemitPending( instance: WillInstance ): void {
    const pending = this._pending.get( instance.config.id )
    if( !pending || pending.size === 0 ) return

    logger.info(`[transport] reconnect — re-emitting ${pending.size} un-acked envelope(s) for ${instance.config.id}`)
    for( const env of [ ...pending.values() ] )
      this._emit( instance, env, env.channel === 'effector_invocation' ? 'result' : 'delivery' )
  }

  /**
   * Emit drained external effector invocations over the transport (2.4). Called
   * by the tick loop after `pendingEffectorInvocations` is spliced. The peer
   * executes each and returns a result-ack (correlationId = decisionRecordId),
   * which inbound dispatch routes to `confirmExecution`.
   */
  emitInvocations( instance: WillInstance, invocations: effectorInvocation[] ): void {
    if( !instance.transport || invocations.length === 0 ) return

    for( const invocation of invocations )
      // 'result': the peer's ack (callback or discrete event) carries the execution
      // result → reconciled once → confirmExecution.
      this._emit( instance, {
        channel:       'effector_invocation',
        willId:        instance.config.id,
        correlationId: invocation.decisionRecordId,
        seq:           this._nextSeq( instance.config.id ),
        wallTime:      wallClock(),
        invocation,
      }, 'result' )
  }

  /**
   * Emit drained outbox messages over the transport (2.3). Called by the tick loop
   * after the outbox is spliced. Facet replies are NOT here — they go via the 2.1
   * fast-path and skip the outbox when a transport is present, so this carries only
   * master/action messages (talk/broadcast/gesture). correlationId = message id, so
   * a delivery-ack marks the right outbox row via confirmDelivery.
   */
  emitOutbox( instance: WillInstance, messages: OutboxMessage[] ): void {
    if( !instance.transport || messages.length === 0 ) return

    for( const message of messages )
      this._emit( instance, {
        channel:       'message',
        willId:        instance.config.id,
        correlationId: message.id,
        seq:           this._nextSeq( instance.config.id ),
        wallTime:      wallClock(),
        message,
      }, 'delivery' )
  }

  /** Tear down the transport and discard any un-applied inbound. */
  detach( instance: WillInstance ): void {
    instance._transportUnsub?.()
    instance._transportUnsub = null
    this._chunkUnsub.get( instance.config.id )?.()
    this._chunkUnsub.delete( instance.config.id )
    this._activityUnsub.get( instance.config.id )?.()
    this._activityUnsub.delete( instance.config.id )
    this._statusUnsub.get( instance.config.id )?.()
    this._statusUnsub.delete( instance.config.id )
    instance.transport?.close()
    // Null the handle so any engine callback that still holds this instance (e.g.
    // the AuditionEngine single-slot reply callback, which has no unsubscribe) sees
    // no transport and its _emit() becomes a no-op instead of emitting on a closed link.
    instance.transport = null
    instance.inbound.clear()
    this._seq.delete( instance.config.id )
    this._reconcilers.delete( instance.config.id )
    this._pending.delete( instance.config.id )
  }

  /**
   * Drain the inbound queue and apply every envelope deterministically at `tick`.
   * Called once per tick BEFORE simulation.step().
   */
  applyInbound( instance: WillInstance, tick: number, deps: InboundApplyDeps ): void {
    const willId = instance.config.id
    const source = getInboundSource( willId )

    // Replay re-feed (1.3): when a source is registered, pull the recorded
    // envelopes for this tick instead of draining the live socket queue — the
    // transport analog of the LLM completion re-feed. A live run drains the queue.
    const envelopes: InboundEnvelope[] = source
      ? ( source.envelopesAt( tick ) as InboundEnvelope[] )
      : instance.inbound.drain( tick ).map( s => s.envelope )

    if( envelopes.length === 0 ) return

    // Record the batch (live runs only — a source means we are replaying). The
    // transport is a non-deterministic input; capturing each envelope at its
    // applied tick lets a deterministic re-execution re-inject them.
    if( !source ){
      const recorder = getInboundRecorder( willId )
      if( recorder )
        for( const envelope of envelopes )
          recorder.recordInbound({ tick, willId, envelope, timestamp: wallClock() })
    }

    for( const envelope of envelopes ){
      try { this._dispatch( instance, envelope, deps ) }
      catch( err ){ logger.error(`[transport] inbound dispatch failed (${envelope.channel}):`, err ) }
    }
  }

  private _dispatch( instance: WillInstance, env: InboundEnvelope, deps: InboundApplyDeps ): void {
    switch( env.channel ){
      case 'inbound_message': {
        // Fire-and-forget: AuditionEngine.ingest() serializes per-entity
        // internally; the tick must not block on the LLM reply.
        const input: SensoryInput = env.kind === 'voice'
          ? { kind: 'voice', entityId: env.entityId, threadId: env.threadId, transcription: env.content }
          : {
              kind:     'text',
              entityId: env.entityId,
              threadId: env.threadId,
              content:  env.content,
              ...( env.speakerName ? { speakerName: env.speakerName } : {} ),
            }
        void instance.cognition.auditionEngine.ingest( input )
        break
      }

      case 'inbound_percept':
        // Materialize as an external event entity; perceptual engines pick it up next tick.
        deps.sensory.injectEvent( instance, { type: `senses.${env.domain}`, payload: env.payload } )
        break

      case 'ack': {
        // Idempotent across the dual paths: the emit-callback ack and the discrete
        // ack event share a correlationId — apply only the first.
        if( !this._reconciler( instance.config.id ).shouldApply( env.correlationId ) ) break

        // Acked — drop it from the reconnect re-emit buffer.
        this._pending.get( instance.config.id )?.delete( env.correlationId )

        if( env.ackKind === 'result' && env.result )
          // Reafference — crosses into deterministic state via confirmExecution().
          deps.effector.confirmExecution( instance, env.correlationId, env.result )
        else
          // Delivery receipt — outbox status update.
          deps.outbox.confirmDelivery( instance, env.correlationId, env.delivered ?? true )
        break
      }
    }
  }
}

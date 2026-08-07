// ─────────────────────────────────────────────────────────────
// src/stem/tracts/outbox.writer.ts  —  the outbox PRODUCER primitive
// ─────────────────────────────────────────────────────────────
//
// OutboxWriter is the producer half of the outbox, paired with OutboxController
// (the consumer half: drain / expire / confirm). It owns the ONE canonical
// outbox-row shape (id format, default fields) and the `conversation.out`
// session-audit log for facet replies. Everything that wants to put words on the
// wire goes through here, so the row shape lives in exactly one place.
//
// It is a leaf primitive — constructed with the shared `outbox` array (no
// WillInstance) and injected into both producers:
//   - ProactiveCommunicator  → enqueue()      (effector-dispatch path)
//   - AuditionEngine         → enqueueReply()  (facet-reply fast-path)
//
// There is NO gating here. Emission is authorized upstream by AccessGrants
// (the `talk`/`text`/… grants), checked by the calling engine.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { OutboxMessage } from '#types'
import type { SessionLogger } from './session.logger'

/**
 * Referent → a deliverable address, and the room to use when none was chosen.
 *
 * Returns null when the referent is already an address (nothing to translate) or
 * when the mind holds no route at all — in which case the row goes out as-is and
 * the bridge's own roster fallback still applies, so a message is never silently
 * dropped for want of a handle.
 */
export type OutboxRouting = (
  targetEntityId: string,
  chosenThread:   string | undefined,
) => { targetEntityId: string; threadId?: string } | null

/** The caller-supplied fields of an outbox row; the writer stamps id + defaults. */
export interface OutboxRow {
  targetEntityId:    string
  content:           string
  effectorName:       OutboxMessage[ 'effectorName' ]
  targetEntityName?: string
  gestureType?:      string
  replyToMessageId?: string
  threadId?:         string
}

export class OutboxWriter {
  private _outbox:        OutboxMessage[]
  private _willId:        string
  private _sessionLogger: SessionLogger | null = null
  /**
   * Per-Will monotonic id counter. Deterministic for replay: the writer is
   * created once per Will and `enqueue` is called in the same order on a
   * re-execution, so the ids reproduce exactly (vs the old Date.now()+random,
   * which made the embedded ids in `conversation.sent` diverge every run).
   */
  private _seq = 0
  private _routing: OutboxRouting | null = null

  constructor( opts: { outbox?: OutboxMessage[]; willId?: string } = {} ){
    this._outbox = opts.outbox ?? []
    this._willId = opts.willId ?? 'will'
  }

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  /**
   * Turn a referent into somewhere the world can actually be spoken to.
   *
   * Injected rather than read here, because this writer is deliberately dumb —
   * it holds no state and must stay replay-safe. Assembly closes over the state
   * manager (the same shape as `attachMemorySink`).
   *
   * This is the ONE seam both send paths cross: ProactiveCommunicator's
   * `enqueue()` and AuditionEngine's `enqueueReply()`. Translating anywhere else
   * would mean doing it twice and getting it wrong once.
   */
  attachRouting( resolve: OutboxRouting | null ): void {
    this._routing = resolve
  }

  private _genId( suffix = ''): string {
    return `outbox-${ this._willId }-${ ++this._seq }${ suffix }`
  }

  /**
   * Push one canonical outbox row and return its generated id. The single point
   * where the row shape is materialized — all producers funnel through here.
   */
  enqueue( row: OutboxRow, idSuffix = ''): string {
    const id = this._genId( idSuffix )
    // A `ke:` anchor is who, never where. Resolve it to an address the bridge can
    // deliver to and a room to say it in — and where a room was already chosen
    // (a reply answers into the thread it was asked in), that choice WINS. The
    // mind picking a room is a decision; this is only the fallback for when it
    // made none, and the alternative to the fallback is dropping the message.
    const routed = this._routing?.( row.targetEntityId, row.threadId ) ?? null
    const target = routed?.targetEntityId ?? row.targetEntityId
    const thread = row.threadId ?? routed?.threadId

    this._outbox.push({
      id,
      targetEntityId:   target,
      ...( row.targetEntityName !== undefined ? { targetEntityName: row.targetEntityName } : {} ),
      content:          row.content,
      effectorName:      row.effectorName,
      ...( row.gestureType      ? { gestureType:      row.gestureType }      : {} ),
      ...( row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {} ),
      ...( thread               ? { threadId:         thread }               : {} ),
      deliveryStatus:   'pending',
      createdAtTick:    0,
      createdAt:        Date.now(),
    })
    return id
  }

  /**
   * Reply convenience for AuditionEngine (formerly ProactiveCommunicator.deliverReply).
   *
   * Pushes the facet's reply bubbles as `text` outbox rows and writes the
   * `conversation.out` audit entry. Returns the generated message ids (always
   * generated, for delivery correlation), or an empty array when there are no
   * bubbles.
   *
   * `pushToOutbox` (default true) controls only whether a copy is queued: set
   * false when an ExternalTransport already delivered the reply via the fast-path
   * (avoids double delivery) — the ids are still generated and returned.
   */
  enqueueReply( opts: {
    entityId:      string
    entityName:    string
    bubbles:       string[]
    threadId?:     string
    tick?:         number
    pushToOutbox?: boolean
  } ): string[] {
    const { entityId, entityName, bubbles, threadId, tick = 0, pushToOutbox = true } = opts

    if( bubbles.length === 0 ) return []

    const ids: string[] = []
    bubbles.forEach( ( bubble, i ) => {
      if( !pushToOutbox ){ ids.push( this._genId(`-${ i }`) ); return }
      logger.info(`[outbox-writer] reply → ${ entityId } bubble[${ i }] "${ bubble.slice( 0, 80 ) }"`)
      ids.push( this.enqueue({
        targetEntityId:   entityId,
        targetEntityName: entityName,
        content:          bubble,
        effectorName:      'text',
        threadId,
      }, `-${ i }`) )
    } )

    this._sessionLogger?.write({
      type:             'conversation.out',
      tick,
      targetEntityId:   entityId,
      targetEntityName: entityName,
      messageCount:     bubbles.length,
      messages:         bubbles.map( b => b.slice( 0, 300 ) ),
      preview:          bubbles[0]?.slice( 0, 100 ) ?? '',
      threadId,
      source:           'audition-facet',
    })

    return ids
  }
}

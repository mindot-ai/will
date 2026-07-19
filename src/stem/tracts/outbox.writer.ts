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

  constructor( opts: { outbox?: OutboxMessage[]; willId?: string } = {} ){
    this._outbox = opts.outbox ?? []
    this._willId = opts.willId ?? 'will'
  }

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
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
    this._outbox.push({
      id,
      targetEntityId:   row.targetEntityId,
      ...( row.targetEntityName !== undefined ? { targetEntityName: row.targetEntityName } : {} ),
      content:          row.content,
      effectorName:      row.effectorName,
      ...( row.gestureType      ? { gestureType:      row.gestureType }      : {} ),
      ...( row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {} ),
      ...( row.threadId         ? { threadId:         row.threadId }         : {} ),
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

// ─────────────────────────────────────────────────────────────
// src/agency/proactive.communication.ts
// ─────────────────────────────────────────────────────────────

/**
 * ProactiveCommunicator — the agency pipeline's communicate-enaction handler.
 *
 * Owned privately by the MotorSchemaExecutor (its only caller): when a `communicate`
 * motor schema wins the action competition, this turns the decided intent into
 * delivery + memory. It validates the request, emits the memory/state side-effects
 * (`conversation.sent` + the shared `conversation.exchange`), and hands the actual
 * outbox row(s) to the shared OutboxWriter. It does NOT own the row shape (the
 * writer does) and does NOT gate (AccessGrants does, upstream in the executor).
 *
 * Effectors handled: listen, talk, text, gesture, broadcast
 *
 * Outbound flow:
 *   agency MotorSchemaExecutor → ProactiveCommunicator → OutboxWriter.enqueue
 *   → OutboxController drains per tick → TransportController emits (or SSE)
 */

import { logger } from '#core/logger'
import { wallClock } from '#core/wall.clock'
import type { ActionRequest, ActionResult } from '#types'
import type { ReadonlySimulationState, StateCommands } from '#core/types'
import type { OutboxWriter } from '#stem/tracts/outbox.writer'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { buildConversationExchange } from '#cognition/conversation.memory'

export interface ProactiveCommunicatorOptions {
  /** Shared outbox producer — owns the row shape; the executor delegates pushes. */
  writer:  OutboxWriter
  willId?: string
}

export class ProactiveCommunicator {
  private _writer:        OutboxWriter
  private _willId:        string
  private _sessionLogger: SessionLogger | null = null

  constructor( options: ProactiveCommunicatorOptions ){
    this._writer = options.writer
    this._willId = options.willId ?? 'will'
  }

  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  async executeAction(
    request: ActionRequest,
    _state:  ReadonlySimulationState,
  ): Promise<ActionResult> {
    const commands: StateCommands = { metrics: [] }

    switch( request.effector ){
      case 'listen':    return this._handleListen( request, commands )
      case 'talk':      return this._handleOutboundMessage('talk',      request, commands )
      case 'text':      return this._handleOutboundMessage('text',      request, commands )
      case 'gesture':   return this._handleGesture(         request, commands )
      case 'broadcast': return this._handleBroadcast(       request, commands )
      default:
        return {
          success: false,
          description: `ProactiveCommunicator does not handle: ${request.effector}`,
          commands,
          feedback: { outcomeQuality: 0, surprise: 0, lessons: [] },
        }
    }
  }

  // ── Handlers ─────────────────────────────────────────────────

  private async _handleListen(
    _request: ActionRequest,
    commands: StateCommands,
  ): Promise<ActionResult> {
    return {
      success: true,
      description: `I open myself to incoming communication. Others may now reach me through available channels.`,
      commands,
      feedback: {
        outcomeQuality: 1.0,
        surprise: 0.05,
        lessons: [ 'Being reachable allows others to connect with me.' ],
      },
    }
  }

  private async _handleGesture(
    request:  ActionRequest,
    commands: StateCommands,
  ): Promise<ActionResult> {
    const targetEntityId = request.targetEntityId
                        ?? ( request.parameters?.targetEntityId as string )
                        ?? 'unknown'
    const gestureType    = ( request.parameters?.gestureType as string ) ?? 'gesture'

    this._writer.enqueue({
      targetEntityId,
      content:     gestureType,
      effectorName: 'gesture',
      gestureType,
    })

    return {
      success: true,
      description: `I ${gestureType} toward ${targetEntityId}. The gesture is directed and sincere.`,
      commands,
      feedback: {
        outcomeQuality: 0.8,
        surprise: 0.1,
        lessons: [ 'Non-verbal communication carries its own weight.' ],
      },
    }
  }

  private async _handleBroadcast(
    request:  ActionRequest,
    commands: StateCommands,
  ): Promise<ActionResult> {
    const rawMessages     = request.parameters?.messages
    const contentParam    = ( request.parameters?.content as string ) ?? ''
    const targetEntityIds = ( request.parameters?.targetEntityIds as string[] ) ?? []

    const bubbles: string[] = Array.isArray( rawMessages )
      ? ( rawMessages as string[] ).filter( Boolean )
      : [ contentParam || ( request.parameters?.message as string ) || '' ].filter( Boolean )

    const finalContent = bubbles.join(' ')
    const target = targetEntityIds.length > 0 ? targetEntityIds.join(',') : '*'
    this._writer.enqueue({
      targetEntityId: target,
      content:        finalContent,
      effectorName:    'broadcast',
    })

    return {
      success: true,
      description: `I broadcast: "${finalContent.slice( 0, 80 )}${finalContent.length > 80 ? '…' : ''}"`,
      commands,
      feedback: {
        outcomeQuality: 0.75,
        surprise: 0.2,
        lessons: [ 'Broadcasts reach multiple entities simultaneously.' ],
      },
    }
  }

  private async _handleOutboundMessage(
    effectorName: 'talk' | 'text',
    request:     ActionRequest,
    commands:    StateCommands,
  ): Promise<ActionResult> {
    const targetEntityId   = request.targetEntityId
                          ?? ( request.parameters?.targetEntityId as string )
    const targetEntityName = ( request.parameters?.targetEntityName as string ) ?? targetEntityId ?? 'them'

    // The executive always writes the actual words — no composition step.
    // Accept `messages` (array), or legacy `message`/`content` (single string).
    const rawMessages = request.parameters?.messages
    const bubbles: string[] = Array.isArray( rawMessages )
      ? ( rawMessages as string[] ).filter( Boolean )
      : [ ( request.parameters?.message as string )
          || ( request.parameters?.content as string )
          || '' ].filter( Boolean )

    if( !targetEntityId ){
      return {
        success: false,
        description: `I want to ${effectorName} but there is no one specific to reach out to.`,
        commands,
        feedback: {
          outcomeQuality: 0,
          surprise: 0.2,
          lessons: [ 'Specify a targetEntityId to send a message.' ],
        },
      }
    }

    if( bubbles.length === 0 ){
      return {
        success: false,
        description: `I wanted to ${effectorName} ${targetEntityName} but didn't write anything.`,
        commands,
        feedback: { outcomeQuality: 0, surprise: 0.1, lessons: [ 'Provide a messages array with the actual words.' ] },
      }
    }

    // Generate outbox message IDs first so we can embed them in conversation.sent
    // and correlate deliveries back to this intent (TODO 11.3).
    const originalMessage  = ( request.parameters?.originalMessage as string ) ?? ''
    const deliveryTick     = ( request.parameters?.tick as number ) ?? 0
    const replyToMessageId = ( request.parameters?.replyToMessageId as string ) ?? undefined
    const isAck            = ( request.parameters?.isAck as boolean ) ?? false

    const outboxMessageIds: string[] = []
    bubbles.forEach( ( bubble, i ) => {
      logger.info(`[communication] pushing to outbox: ${effectorName} → ${targetEntityId} "${bubble.slice( 0, 80 )}"`)
      outboxMessageIds.push( this._writer.enqueue({
        targetEntityId,
        targetEntityName,
        content:     bubble,
        effectorName,
        replyToMessageId,
      }, `-${ i }` ) )
    })

    // Write the intent record at push time so context-builder can see what we said.
    // NOTE (11.3): this entity tracks intent, not confirmation.  confirmMessageDelivery()
    // will update it with delivered:true once the client ACKs.
    const sentEntityId = `conv-sent-${targetEntityId}-${deliveryTick}`

    commands.set ??= []
    commands.set.push({
      id:        sentEntityId,
      type:      'conversation.sent',
      createdAt: wallClock(),
      metadata: {
        targetEntityId,
        targetEntityName,
        messageCount:    bubbles.length,
        preview:         bubbles[0]?.slice( 0, 100 ) ?? '',
        effectorName,
        tick:            deliveryTick,
        delivered:       false,
        isAck,
        outboxMessageIds,  // enables confirmMessageDelivery to update this entity
      },
    })

    // Log the outbound message for session auditing (D4)
    this._sessionLogger?.write({
      type:             'conversation.out',
      tick:             deliveryTick,
      targetEntityId,
      targetEntityName,
      messageCount:     bubbles.length,
      messages:         bubbles.map( b => b.slice( 0, 300 ) ),
      preview:          bubbles[0]?.slice( 0, 100 ) ?? '',
      isAck,
    })

    const fullReply = bubbles.join(' ')

    // Persist every outbound as a conversation.exchange WM item so it consolidates
    // into episodic + vector memory — the same shape the AuditionEngine uses for
    // facet replies (built by the shared buildConversationExchange). UNCONDITIONAL
    // (option a): master-initiated outreach (no inbound `originalMessage`) must also
    // be remembered, so a facet later spawned to continue recalls what was said.
    commands.set ??= []
    commands.set.push( buildConversationExchange({
      entityId:    targetEntityId,
      entityName:  targetEntityName,
      userMessage: originalMessage,
      willReply:   fullReply,
      tick:        ( request.parameters?.tick as number ) ?? 0,
      idSeed:      wallClock(),
      createdAt:   wallClock(),
    }) )

    return {
      success: true,
      description: `I reach out to ${targetEntityName}: "${fullReply.slice( 0, 80 )}${fullReply.length > 80 ? '…' : ''}"`,
      commands,
      feedback: {
        outcomeQuality: 0.85,
        surprise: 0.15,
        lessons: [ `My message is queued for delivery to ${targetEntityName}.` ],
      },
    }
  }

}

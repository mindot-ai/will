// ─────────────────────────────────────────────────────────────
// src/cognition/conversation.memory.ts
// ─────────────────────────────────────────────────────────────
//
// The single authority for the `conversation.exchange` working-memory item.
//
// A completed conversational turn is persisted as a `working_memory.item` state
// entity so it flows through WorkingMemory → EpisodicConsolidator → vector. There
// are two producers and they MUST agree on the shape:
//
//   - AuditionEngine        — reactive replies (someone spoke → the Will answered)
//   - ProactiveCommunicator — proactive outreach (the Will decided to reach out)
//
// Both call `buildConversationExchange`; each applies the result via its own sink
// (AuditionEngine → memory sink / setEntity; ProactiveCommunicator → StateCommands).
// Per-caller knobs (activation, attendedCount, threadId, the id/createdAt stamps)
// stay parameters; the row shape, tags, and summary live here once.
//
// Downstream consumers read the STRUCTURED fields (`userMessage` / `willReply` in
// executive context + semantic clustering), with `summary` as the fallback — so
// both producers now emit the structured fields, not just a summary string.
// ─────────────────────────────────────────────────────────────

export interface ConversationExchangeInput {
  /** Stable entity id of the other party. */
  entityId:       string
  /** Display name; falls back to entityId. */
  entityName?:    string
  /** The inbound message. Empty string for proactive, master-initiated outreach. */
  userMessage:    string
  /** What the Will said. May be empty (formulated-but-unspoken still gets remembered). */
  willReply:      string
  /** Conversation thread, when the producer has one (replies do; outreach may not). */
  threadId?:      string
  /** Sim tick, when the producer is on-tick. Omitted off-tick. */
  tick?:          number
  /** WM activation. Default 0.85; AuditionEngine passes a confidence-derived value. */
  activation?:    number
  /** WM attended count. Default 3. */
  attendedCount?: number
  /** Unique id seed — the caller's clock (wallClock() under replay; never Date.now() in a scanned tree). */
  idSeed:         number
  /** Top-level createdAt. Pass on the StateCommands path; omit when setEntity stamps it. */
  createdAt?:     number
}

export interface ConversationExchangeEntity {
  id:         string
  type:       'working_memory.item'
  createdAt?: number
  metadata:   Record<string, unknown>
}

export function buildConversationExchange( input: ConversationExchangeInput ): ConversationExchangeEntity {
  const {
    entityId, userMessage, willReply, threadId, tick,
    activation = 0.85, attendedCount = 3, idSeed, createdAt,
  } = input
  const name = input.entityName ?? entityId

  return {
    id:   `wm-exchange-${ entityId }-${ idSeed }`,
    type: 'working_memory.item',
    ...( createdAt !== undefined ? { createdAt } : {} ),
    metadata: {
      wmType:        'conversation.exchange',
      activation,
      attendedCount,
      tags:          [ 'conversation', 'exchange', `entity:${ entityId }` ],
      summary:       userMessage
        ? `${ name }: "${ userMessage.slice( 0, 100 ) }" → "${ willReply.slice( 0, 100 ) }"`
        : `I → ${ name }: "${ willReply.slice( 0, 140 ) }"`,
      entityId,
      entityName:    name,
      userMessage,
      willReply,
      ...( threadId ? { threadId } : {} ),
      ...( tick !== undefined ? { tick } : {} ),
    },
  }
}

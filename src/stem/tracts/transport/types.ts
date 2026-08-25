// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport/types.ts
// ─────────────────────────────────────────────────────────────
//
// ExternalTransport — Will's unified bidirectional channel to its host peer
// (in production, a socket.io server owned by the backend).
//
// Replaces the per-concern, tick-drained SSE delivery model with a single
// envelope channel carrying every outbound concern (replies, chunks, outbox
// messages, effector invocations, activity) and every inbound concern (messages,
// percepts, acks).
//
// DETERMINISM CONTRACT (see EXTERNAL_TRANSPORT_TODO.md § guardrails):
//   - This module and its implementations live ONLY under src/stem/tracts/.
//     Nothing under src/cognition/ may import it.
//   - Outbound emit() is a pure side effect — it never mutates simulation state.
//   - Inbound is NOT applied here. The stem enqueues every InboundEnvelope onto
//     the tick-stamped InboundQueue; the tick loop applies it deterministically.
//   - wallTime is telemetry only (R2) — never feed it into replay-sensitive state.
// ─────────────────────────────────────────────────────────────

import type { effectorInvocation, OutboxMessage } from '#types'

// ── Shared base ────────────────────────────────────────────────

interface BaseEnvelope {
  /** Will instance this envelope belongs to (routing key for the peer). */
  willId:        string
  /**
   * Stable id used to match an outbound envelope to its ack(s).
   * For messages this is the OutboxMessage id; for effector invocations the
   * intentId; for replies/chunks a generated id.
   */
  correlationId: string
  /** Monotonic per-Will sequence number — ordering + dedup at the peer. */
  seq:           number
  /** Wall-clock emit/arrival time. Telemetry only (R2) — never replay state. */
  wallTime:      number
}

// ── Outbound (Will → peer) ─────────────────────────────────────

/** Facet reply, assembled. Fast path — emitted the instant the facet decides. */
export interface ReplyEnvelope extends BaseEnvelope {
  channel:           'reply'
  entityId:          string
  threadId:          string
  bubbles:           string[]
  replyToMessageId?: string
}

/** One streamed LLM token for a live conversation. Fast path, best-effort. */
export interface ChunkEnvelope extends BaseEnvelope {
  channel:  'chunk'
  entityId: string
  threadId: string
  content:  string
}

/** Generic outbox message (talk/text/gesture/broadcast). Bridged on tick drain. */
export interface MessageEnvelope extends BaseEnvelope {
  channel: 'message'
  message: OutboxMessage
}

/** External effector call for the peer/host to execute. Result returns via ack. */
export interface effectorInvocationEnvelope extends BaseEnvelope {
  channel:    'effector_invocation'
  invocation: effectorInvocation
}

/** Projection of a cognitive percept — observability only. */
export interface PerceptEnvelope extends BaseEnvelope {
  channel: 'percept'
  domain:  string
  payload: Record<string, unknown>
}

/** Plan/activity event for the peer's activity stream. */
export interface ActivityEnvelope extends BaseEnvelope {
  channel:   'activity'
  entityId:  string
  eventType: string
  payload:   Record<string, unknown>
}

/**
 * A SessionLogger NDJSON entry — observability. Emitted so the consumer owns log
 * persistence (Postgres, S3, Kafka, …) instead of the Will writing files/S3.
 */
export interface SessionLogEnvelope extends BaseEnvelope {
  channel: 'session_log'
  entry:   Record<string, unknown>
}

/**
 * One attributed token/cost ledger record — observability + billing. Carries the
 * 5-axis attribution (category/attribute/function/scope/label) + tokens + costUsd
 * so the consumer can meter and re-bill end-users straight off the stream.
 */
export interface TokenReportEnvelope extends BaseEnvelope {
  channel: 'token_report'
  report:  Record<string, unknown>
}

export type OutboundEnvelope =
  | ReplyEnvelope
  | ChunkEnvelope
  | MessageEnvelope
  | effectorInvocationEnvelope
  | PerceptEnvelope
  | ActivityEnvelope
  | SessionLogEnvelope
  | TokenReportEnvelope

// ── Inbound (peer → Will) ──────────────────────────────────────

/** Conversational text/voice from an external entity. */
export interface InboundMessageEnvelope extends BaseEnvelope {
  channel:    'inbound_message'
  kind:       'text' | 'voice'
  entityId:   string
  threadId:   string
  content:    string
  speakerName?: string
  /**
   * Whose doing this was, as the SENDING host asserts it. Optional on the wire
   * and only there: `SensoryInput.provenance` is required inside the package,
   * but a wire type cannot make an older peer send a field, so absence has to
   * be survivable. It is read through `asProvenance()`, which owns the
   * direction for untyped ingress.
   *
   * This field is why the transport no longer says `'unknown'`. It used to,
   * and correctly — the absence was STRUCTURAL, there was no field to fill —
   * but `unknown` percepts are skipped by the rupture gate in `action.selector`,
   * so a mind reached over a transport could not be interrupted by anyone
   * speaking to it, while the same words in-process could interrupt it. Two
   * transports, two different minds.
   */
  provenance?: import('#senses/index').SignalProvenance
  /** True when this thread is private — just this someone and the Will. */
  direct?:     boolean
  /** What the room is called, e.g. `#general`. A label, not an address. */
  threadName?: string
}

/** A non-conversational external percept (webhook, system signal, etc.). */
export interface InboundPerceptEnvelope extends BaseEnvelope {
  channel: 'inbound_percept'
  domain:  string
  payload: Record<string, unknown>
}

/**
 * Acknowledgement for a prior outbound envelope.
 *   - 'delivery' → receipt confirmation (edge-level; updates outbox status)
 *   - 'result'   → effector execution result (crosses determinism boundary →
 *                  applied on tick via confirmExecution)
 * `correlationId` points back to the acked outbound envelope.
 */
export interface AckEnvelope extends BaseEnvelope {
  channel:  'ack'
  ackKind:  'delivery' | 'result'
  delivered?: boolean
  result?: {
    success:     boolean
    description: string
    metrics?:    Record<string, number>
  }
}

export type InboundEnvelope =
  | InboundMessageEnvelope
  | InboundPerceptEnvelope
  | AckEnvelope

export type Envelope = OutboundEnvelope | InboundEnvelope

// ── Transport interface ────────────────────────────────────────

export type TransportStatus = 'connected' | 'disconnected' | 'reconnecting'

export interface AckResult {
  acked:    boolean
  via:      'callback' | 'event' | 'timeout'
  payload?: unknown
}

export interface ExternalTransport {
  /** True when a live connection to the peer exists. */
  readonly connected: boolean

  /**
   * Emit an outbound envelope. Resolves when the peer acks (via socket.io ack
   * callback) or the ack times out. Resolution NEVER mutates simulation state —
   * the caller decides what to do with the AckResult (e.g. requeue the outbox).
   */
  emit( env: OutboundEnvelope, opts?: { ackTimeoutMs?: number } ): Promise<AckResult>

  /**
   * Register a handler for inbound envelopes. The stem's handler MUST do nothing
   * but enqueue onto the InboundQueue — application happens on tick.
   * Returns an unsubscribe function.
   */
  onInbound( handler: ( env: InboundEnvelope ) => void ): () => void

  /** Connection lifecycle notifications (for buffer flush on reconnect). */
  onStatus( handler: ( status: TransportStatus ) => void ): () => void

  /** Tear down the connection and all handlers. */
  close(): void
}

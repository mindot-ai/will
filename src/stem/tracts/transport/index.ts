// ─────────────────────────────────────────────────────────────
// src/stem/tracts/transport/index.ts — ExternalTransport barrel
// ─────────────────────────────────────────────────────────────

export type {
  ExternalTransport,
  Envelope,
  OutboundEnvelope,
  InboundEnvelope,
  ReplyEnvelope,
  ChunkEnvelope,
  MessageEnvelope,
  effectorInvocationEnvelope,
  PerceptEnvelope,
  ActivityEnvelope,
  SessionLogEnvelope,
  TokenReportEnvelope,
  InboundMessageEnvelope,
  InboundPerceptEnvelope,
  AckEnvelope,
  AckResult,
  TransportStatus,
} from '#stem/tracts/transport/types'

export { LoopbackTransport, type AckPolicy } from '#stem/tracts/transport/loopback.transport'
export {
  SocketIoTransport,
  type SocketIoTransportOptions,
  type SocketLike,
} from '#stem/tracts/transport/socketio.transport'


export {
  type StreamChannel,
  StreamTransport,
  type OutboundListener,
  fileLoggingEnabled,
} from '#stem/tracts/transport/stream.transport'
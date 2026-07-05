// ─────────────────────────────────────────────────────────────
// src/index.ts  —  Will public API
// ─────────────────────────────────────────────────────────────

// Core simulation primitives (includes StorageAdapter, BunStorageAdapter, etc.)
export * from '#core/index'

// All cognitive engines
export * from '#cognition/index'

// Public types (OutboxMessage, effectorInvocation, ActionRequest, ActionResult, etc.)
export * from '#types'

// Deployment layer — WillStem, WillConfig, WillSummary, CognitiveHealth, TickListener …
export {
  WillStem,
  type WillInstance,
  type WillSummary,
  type CognitiveHealth,
  type WillStatus,
  type TickListener,
  type SimulationEventListener,
  type StateSnapshot,
  OUTBOX_TTL_TICKS,
} from '#stem/index'

export { assembleMind, type WillConfig } from '#stem/mind'

// External transport — the unified bidirectional envelope channel between a Will
// and its host peer (backend). Exposes the transport interface, every envelope
// type, and the three implementations:
//   • SocketIoTransport — production (Will = client, backend hosts the server)
//   • StreamTransport    — live in-process consumer (per-channel demux via on())
//   • LoopbackTransport  — deterministic in-memory transport for tests/replay
export * from '#stem/tracts/transport/index'

// Vector memory — semantic episodic recall. Exposes the adapter, the VectorIndex
// interface, and the embedders so a host can inject a custom backend (e.g.
// pgvector) via WillConfig.vectorMemoryAdapter. (EmbeddingProvider / VectorRecord
// / VectorQueryResult / VectorQueryFilter are already exported via #cognition.)
export {
  DefaultVectorMemoryAdapter,
  type VectorMemoryAdapter,
  type VectorIndex,
  OpenAICompatibleEmbedder,
  MockEmbedder,
  type EmbeddingProvider,
  type VectorRecord,
  type VectorQueryResult,
  type VectorQueryFilter,
  type VectorMemoryConfig,
} from '#cognition/memory/index'

// Profile registry — built-in profiles are auto-registered when this package is imported
// (mind.ts imports '#profiles/built-in' as a side effect).
export { resolveProfile, listProfiles, type WorldProfile } from '#profiles/index'

// PMA (Personal Mind Archive) snapshot types
export type {
  PMASnapshot,
  PMAIdentity,
  PMABelief,
  PMAGoal,
  PMAEmotionalBaseline,
  PMABehavioral,
} from '#pma/index'

// PMA eval harness — behavioral fidelity scoring
export { PMAEvalHarness } from '#pma/eval'
export type {
  ReconstructionFidelityReport,
  ReconstructionFidelityScores,
  BehavioralProbeResult,
  PMAProbe,
} from '#pma/eval'

// Sensory input types — used by callers of WillManager.ingestText()
export type { TextMessage, VoiceChunk, SensoryInput } from '#senses/index'

// ── SDK facade — the ergonomic embedding API (recommended entry point) ──
// `Will.create()` wraps WillStem in the shape a developer expects: on('message'),
// effector(name, handler), say(), state(), hibernate()/wake(). Drop to `.stem`
// for the full contract. See src/sdk/will.ts + examples/effectors.ts.
export { Will } from '#sdk/will'
export type {
  CreateWillOptions,
  WillMessage,
  WillStateSummary,
  EffectorHandler,
  EffectorResult,
} from '#sdk/will'

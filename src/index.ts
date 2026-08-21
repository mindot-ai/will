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

// Model routing — which model serves which call.
//
// These were reachable only through `WillConfig.llm.router`'s structural type,
// which meant the reference implementation this ships *for* hosts to use could
// not be imported by one. A seam nobody can import is not a seam.
//
// The engine carries mechanism only: a router sees what kind of work a call is
// and how much the moment demands, never who is paying or what anything costs.
// The table itself is the host's.
export {
  NULL_ROUTER,
  TableRouter,
  chainRouters,
  isNullRouter,
  type ModelRouter,
  type ModelRoute,
  type RoutingRule,
} from '#llm/routing'

// Provider vocabulary — the wire each known provider speaks and where it lives.
// A provider outside this table works identically once the host declares its
// `wire` and `baseUrl` on the `llm.providers` entry.
export {
  KNOWN_PROVIDERS,
  knownWireFor,
  defaultBaseFor,
  BACKGROUND_DEMAND,
  ESCALATION_DEMAND,
  type LLMProvider,
  type KnownProvider,
  type LLMWire,
  type LLMCallMeta,
  type ProviderCredential,
} from '#llm/index'

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
// (mind.ts imports '#stem/profiles/built-in' as a side effect).
export { resolveProfile, listProfiles, type WorldProfile } from '#stem/profiles/index'

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
export { Will } from '#surface/sdk/will'
export type {
  CreateWillOptions,
  Stimulus,
  WillMessage,
  WillEffectorAct,
  WillAffect,
  WillStateSummary,
  EffectorHandler,
  EffectorResult,
  EffectorSpec,
  EffectorEntry,
} from '#surface/sdk/will'
export type { SchemaPrecondition, EffectorDeclaration } from '#agency/types'

// ── Policy — the PDP/PEP boundary (POLICY_REAFFERENCE) ──────────────────
// A host installs a PolicyArbiter via `WillStem.setArbiter()` / `Will.setArbiter()`
// to gate host-owned effector invocations before they reach the world: allow,
// deny (with `finality` — class/parameter/context, see arbiter.ts), or escalate
// (hold the intent, voice the ask, resolve via `resolveEscalation()`). No arbiter
// installed ⇒ byte-identical to a Will with no policy layer. `RuleTableArbiter`
// is the local reference PDP — pure and declarative, sufficient for static
// schema/target/parameter rules; a host needing live world state (session/DB
// lookups) implements `PolicyArbiter` directly instead.
export {
  NULL_ARBITER,
  isNullArbiter,
  finalityOf,
  asFinality,
  type PolicyArbiter,
  type PolicyDecision,
  type DenialFinality,
  type PolicyCounterfactual,
  type Verdict,
  type PolicyInvocation,
} from '#stem/policy/arbiter'
export {
  RuleTableArbiter,
  type PolicyRule,
  type ParamConstraint,
  type RuleTableOptions,
} from '#stem/policy/rule.table'

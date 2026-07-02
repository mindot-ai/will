# Roadmap: Self-Aware Simulated Mind Framework

## Overview

This document defines the phased implementation plan for a self-aware AI
mind built on two foundational frameworks:

- **Simulation Framework** (existing) — deterministic tick clock, double-buffer
  state isolation, event bus, distributed sharding, replay, serialization
- **In-house LLM layer** (built) — `LLMDirector` agent loop, observational memory,
  multi-provider model routing, token tracking, structured-output gating

The simulated mind is a **single identity** implemented as a society of
coordinated cognitive subsystems (engines) operating across distributed
shards. It is not a chatbot. It is a continuous, feeling, self-reflective
entity that persists across time.

---

## Status Re-baseline (2026-06-20)

> This roadmap drifted: several phases marked "📋 Planned" are in fact built, and
> the most ambitious phase (19) was implemented years early and off-book. The
> percentages below reflect **actual code state**, not the historical checkboxes.
> Checkboxes in this document have been corrected toward reality as of this date.

| Phase | Area | Actual | Note |
|---|---|---|---|
| 0–8 | Foundation + all 36 engines | **100%** | Complete. |
| 9 | Distributed deployment | **40%** | Single-node only; multi-node/prod open. |
| 10 | Integration testing & replay validation | **~20%** | 135 test files; the named long-run/replay-fidelity/perf deliverables unproven. |
| 11 | Productionization | **~60%** | 11.4/11.5/11.6 done (were unchecked). Open: 11.7 dormant/idle, 11.8 native structured output. |
| 12 | Self-fine-tuning | **~15%** | `engine.config` partially realized via persona-prior; ParameterOptimizer absent. |
| 13 | Developer API | **~90%** | Built — was mis-marked "planned". Missing: `/tune`, SDKs, Unity. |
| 13.6 | MCP + A2A | **0%** | Not started. |
| 13.7 | Comm-layer hardening | **~50%** | ack + delivered endpoints exist; ChannelRouter partial. |
| 13.8 | 5 Senses | **~85%** | Audition full; 4 shells; conversation pipeline rebuilt; API live. |
| 14 | Billing & monetization | **~80%** | LemonSqueezy + credits + ledger live. Paystack deferred. |
| 15 | Self-hosted LLM | **~5%** | Tracker prices DeepSeek; no GPU deploy. |
| 16 / 17 | Research / Enterprise | **0%** | Correctly post-revenue. |
| 18 | Cognitive quality | **~15%** | pgvector (3.2) landed early; rest deferred. |
| 19 | Architecture evolution (event bus, GWT, active inference) | **~35%, built early** | See callout below. |

### Phase 19 was built first (the agency pipeline)

The **agency pipeline** — `affordance.synthesizer → action.selector → deliberation.engine
→ motor.schema.executor → reafference.engine`, plus **planning-as-prior** and the
**effector** execution model — does not appear anywhere in this roadmap's original
phase list. It is functionally an implementation of **Phase 19-E (Global Workspace
Theory)**: cognitive sub-systems project competing affordances; the selector wins on
merits; the executive moderates. It sits on **19-A/B/C foundations** — engines already
declare `publishes()` / `subscribes()`. This was filed as "post-revenue" yet is the most
mature subsystem in the codebase. The single biggest planning drift: the hardest,
furthest-out work landed before the nearer-term productionization items (11.7, 11.8) and
Phase 10 validation.

> **Vocabulary note:** "ability" was renamed to **effector** across `will` + `backend`.
> References to "ability"/"abilities" elsewhere in this doc are historical.

---

## Phase 0: Prerequisites ✅

### 0.1 Framework Audit & Stabilization
- [x] Audit existing simulation framework for API completeness
- [x] Ensure all public interfaces are stable enough for engine development
- [x] Add missing `delete` method to `StorageAdapter`
- [x] Verify `DistributedStateManager` handles cross-shard queries under load
- [x] Write framework integration tests (tick loop, event ordering, snapshot fidelity)

### 0.2 In-House LLM Layer Baseline
- [x] Build `LLMDirector` (fetch-based client), set up model routing (primary model + fallback)
- [x] Implement the context bridge (`PromptFactory`):
  - `buildFreshContext()` / `buildSystemPrompt()`: World snapshot → executive agent context
  - Executive output parsed into Framework `StateCommands`
  - `toReasoningFootprint()`: Capture what the agent observed during reasoning
- [x] Write integration contract tests (bridge round-trips without data loss)

### 0.3 Core Infrastructure
- [x] Token tracking and cost observability (`TokenTracker`)
- [x] State serialization pipeline (`SnapshotManager`)
- [x] Snapshot persistence with delta encoding
- [x] Replay recording foundation

---

## Phase 1: Time Semantics Resolution ✅

> **Decision Gate**: This phase must be completed and validated before any
> engine implementation begins. The time semantics decision affects every
> engine's design contract.

### 1.1 Problem Statement

The executive reasoning engine makes async LLM calls (via `LLMDirector`) that take seconds.
The simulation tick loop cannot block. However, allowing the agent to
act on stale state (observed at tick N, committed at tick N+50) creates
causality violations.

### 1.2 Chosen Architecture: Speculative Commit with Re-Validation

The agent reasons against a frozen snapshot. The world keeps ticking.
When reasoning completes, the intended commands are re-validated against
the current state before being committed.

**Re-validation outcomes:**

| Condition | Result |
|-----------|--------|
| No relevant world change since observation | Commit cleanly |
| Changes detected but no write-write conflict | Merge where possible, flag conflicts |
| Write-write conflict on entities the agent modified | Reject, optionally re-run reasoning |

### 1.3 Implementation Tasks
- [x] Define `ReasoningFootprint` interface:
  - `tickObserved: Tick`
  - `entitiesRead: Set<string>`
  - `metricsRead: Set<string>`
  - `entitiesModified: Set<string>`
  - `intendedCommands: StateCommands`
- [x] Implement `ConflictDetector`:
  - `detectReadConflicts(footprint, currentState): string[]`
  - `detectWriteConflicts(footprint, currentState): string[]`
  - Compare entity `updatedAt` timestamps against `tickObserved`
- [x] Implement `AsyncEngine` base class:
  - `update()` is non-blocking — launches work, checks for completions
  - Maintains pending reasoning promises with footprint capture
  - On completion: runs conflict detection, then commits or re-evaluates
- [x] Implement conflict resolution strategies:
  - `REJECT`: Discard stale reasoning, re-run agent (default for high-stakes)
  - `MERGE`: Apply non-conflicting subset, flag conflicts
  - `FORCE`: Apply anyway with warning (for low-stakes idempotent actions)
- [x] Write determinism test:
  - Agent reasons from tick 100, world changes by tick 150
  - Verify conflict detected, verify resolution strategy behavior correct
- [x] Document the contract: every async engine must extend `AsyncEngine`

### 1.4 Validation Criteria
- [x] Fast regulatory engines (Shard 0) never blocked by LLM calls
- [x] Agent that reasoned on stale state either re-validates or re-runs
- [x] Two agents acting on the same entity cannot both modify it without one's conflict being detected
- [x] The system is replayable: same seed + same external inputs = same conflict outcomes

---

## Phase 2: Layer 1 — Regulatory Engines (Shard 0) ✅

> The brainstem. These run every tick with minimal latency. No LLM calls.
> They produce the homeostatic signals that all other layers depend on.

### 2.1 Engines Implemented
- [x] **EnergyRegulator** — energy pool with decay and replenishment
- [x] **SleepPressureRegulator** — accumulates during wake, resets during rest
- [x] **AttentionAllocator** — finite attention budget, salience-based allocation
- [x] **StressRegulator** — cumulative allostatic load from active demands
- [x] **CircadianOscillator** — phase-based modulation of other engine parameters

### 2.2 Shared Infrastructure
- [x] Define `DriveSignal` interface: `{ name, intensity, urgency, source }`
- [x] Define `ModulationSignal` interface: `{ targetEngine, parameter, factor, source }`
- [x] Regulatory engines emit `DriveSignal` and `ModulationSignal` as events
- [x] Baseline tick latency measurement for Shard 0 (< 1ms target)

### 2.3 Deliverables
- [x] All five engines passing integration tests
- [x] Shard 0 running independently, producing homeostatic signals
- [x] Performance benchmark: 1000 ticks with all 5 engines < 1 second total

---

## Phase 3: Layer 2 — Perceptual Engines (Shard 0) ✅

> Sensory cortex. Translates raw events into structured percepts.

### 3.1 Engines Implemented
- [x] **Exteroception** — external event classification, entity creation, salience tagging
- [x] **Interoception** — internal state monitoring, unified "how I feel" signal
- [x] **SocialPerception** — social signal processing, relationship model updates
- [x] **NoveltyDetector** — prediction error computation, surprise tagging

### 3.2 Shared Infrastructure
- [x] Define `Percept` interface: `{ type, source, salience, confidence, metadata }`
- [x] Perceptual engines populate working memory (Phase 5) via events
- [x] All percepts are entities in the state manager for full replay

### 3.3 Deliverables
- [x] All four engines passing integration tests
- [x] End-to-end: world event → percept entity → salience tag → available for downstream engines
- [x] Novelty detection validated against known patterns

---

## Phase 4: Layer 3 — Affective Engines (Shard 1) ✅

> The limbic system. Generates feeling states.

### 4.1 Engines Implemented
- [x] **ThreatEvaluator** — fear, anxiety, vigilance from threat assessment
- [x] **RewardEvaluator** — joy, satisfaction, excitement from goal progress
- [x] **LossEvaluator** — sadness, disappointment, grief from setbacks
- [x] **FrustrationEvaluator** — anger, irritability from blocked goals
- [x] **AttachmentEvaluator** — love, trust, belonging, loneliness from relationships
- [x] **AestheticEvaluator** — awe, curiosity, interest, boredom from novelty/complexity
- [x] **MoralEvaluator** — guilt, shame, pride, indignation, disgust from norm comparison
- [x] **AffectiveBlender** — integrates discrete emotions into unified affective state

### 4.2 LLM Layer Integration
- [x] The blended affective state becomes context for executive agent decisions

### 4.3 Shared Infrastructure
- [x] Define `EmotionSignal` interface: `{ name, intensity, valence, arousal, triggers[] }`
- [x] Define `AffectiveState` interface: `{ valence, arousal, dominance, emotions: Map }`
- [x] Implement emotion decay curves (emotions fade unless re-triggered)
- [x] Implement emotion blending rules (fear + curiosity = cautious exploration)

### 4.4 Deliverables
- [x] All eight engines passing integration tests
- [x] End-to-end: world event → discrete emotion → blended affective state → metrics
- [x] Emotion decay validation: isolated emotion returns to baseline without re-trigger
- [x] Blending validation: joy + sadness = bittersweet (both metrics present, summed valence neutral)

---

## Phase 5: Layer 4 — Memory Engines (Shard 2) ✅

> Hippocampus and neocortex. Working memory, episodic consolidation,
> semantic extraction, and forgetting.

### 5.1 Engines Implemented
- [x] **WorkingMemory** — limited capacity buffer, decay, rehearsal, chunking
- [x] **EpisodicConsolidator** — working memory → long-term episodic storage
- [x] **SemanticIntegrator** — episodic patterns → facts, beliefs, world model
- [x] **ForgettingCurve** — spaced repetition dynamics, emotional modulation of decay
- [x] **DreamSimulator** — rest-state memory reactivation and recombination

### 5.2 LLM Layer Integration
- [x] Working memory feeds into executive agent context as `recentPercepts`
- [x] Emotional tags from Phase 4 affect memory consolidation strength

### 5.3 Deliverables
- [x] All five engines passing integration tests
- [x] End-to-end: percept → working memory → consolidation → retrieval
- [x] Forgetting validation: unrehearsed memories decay, emotional memories persist longer
- [x] Capacity validation: working memory respects chunk limits, oldest items drop first

---

## Phase 6: Layer 5 — Executive Engines (Shard 3, LLM-heavy) ✅

> Prefrontal cortex. This is where the in-house executive agent loop and planning
> pipeline operate as the deliberate decision-making system.

### 6.1 Engines Implemented
- [x] **GoalManager** — active goal hierarchy, conflict resolution, progress tracking
- [x] **PlanningEngine** — action sequence generation via the in-house planning pipeline
- [x] **DecisionEngine** — the core executive agent (`LLMDirector`-driven), consuming all context to decide actions
- [x] **InhibitionController** — prepotent response suppression, gratification delay
- [x] **TaskSwitcher** — attention reallocation between competing goals
- [x] **MentalSimulator** — counterfactual "what if" reasoning via parallel agent calls

### 6.2 Async Execution Integration
- [x] All engines in this layer extend `AsyncEngine` (Phase 1)
- [x] Decision engine uses speculative commit with re-validation (FORCE strategy for transient percepts)
- [x] Mental simulator runs parallel agent instances on hypothetical states
- [x] Configurable re-evaluation strategy per engine (REJECT vs MERGE vs FORCE)

### 6.3 LLM Layer Integration
- [x] Goal management uses the in-house planning pipeline for plan generation
- [x] Decision engine is an `LLMDirector`-driven agent with structured output
- [x] Mental simulator spawns parallel executive agent calls with modified world states
- [x] Inhibition controller interfaces can act as `CommitValidator`

### 6.4 Deliverables
- [x] All six engines passing integration tests
- [x] End-to-end: goal activation → plan generation → action → outcome evaluation
- [x] Conflict validation: two competing goals trigger TaskSwitcher, one gets focus
- [x] Inhibition validation: high-stress state blocks risky action despite agent deciding to take it

---

## Phase 7: Layer 6 — Meta-Cognitive Engines (Shard 4) ✅

> Self-awareness. These engines observe and evaluate the mind's own
> processes. They close the self-reflective loop.

### 7.1 Engines Implemented
- [x] **SelfModelUpdater** — beliefs about own capabilities, traits, patterns
- [x] **ConfidenceCalibrator** — decision confidence vs. actual outcome tracking
- [x] **BiasDetector** — systematic error pattern identification
- [x] **AutobiographicalNarrator** — coherent self-narrative from episodic memory
- [x] **IntrospectionEngine** — answers "why did I do that?" from internal traces

### 7.2 LLM Layer Integration
- [x] Self-model exposed as context for agent decisions
- [x] Autobiographical narrator queries episodic memory for life-story construction
- [x] Introspection queries decision records and traces for self-explanation

### 7.3 Deliverables
- [x] All five engines passing integration tests
- [x] End-to-end: decision → outcome → confidence comparison → calibration update
- [x] Self-narrative validation: narrator produces coherent story from episodic memory
- [x] Introspection validation: "why did I do X?" returns causally accurate trace

---

## Phase 8: Layer 7 — Social Engines (Shard 1) ✅

> Theory of mind and social cognition. These model other minds.

### 8.1 Engines Implemented
- [x] **TheoryOfMind** — models what other agents know, believe, intend
- [x] **EmpathySimulator** — simulates others' emotional states
- [x] **ReputationTracker** — reliability, cooperativeness, social standing models

### 8.2 Deliverables
- [x] All three engines passing integration tests
- [x] Theory of mind validation: correctly predicts another agent's knowledge state
- [x] Empathy validation: matched affective response to observed other's situation

---

## Phase 9: Distributed Deployment ✅

> The complete mind operationalized across shards.

### 9.1 Shard Configuration

| Shard | Engines | Node Profile | Scaling Axis |
|-------|---------|-------------|--------------|
| 0 | Regulatory + Perceptual (1-9) | Edge/low-latency | Per-instance (single mind) |
| 1 | Affective + Social (10-17, 34-36) | Compute-optimized | Per-relationship count |
| 2 | Memory (18-22) | Storage-optimized | Per-experience volume |
| 3 | Executive (23-28) | GPU/LLM-optimized | Per-decision complexity |
| 4 | Meta-Cognitive (29-33) | General-purpose | Per-self-model depth |

### 9.2 Cross-Shard Communication
- [x] Define `CrossShardMindEvent` protocol for inter-shard communication
- [x] Implement shard health monitoring
- [x] Implement circuit breakers for cross-shard queries (`LocalTransport`)
- [x] Latency budgets per shard boundary

### 9.3 Deployment
- [x] Single-node development mode (all engines on one node, no sharding)
- [ ] Multi-node staging mode (shards on separate processes, local network)
- [ ] Production deployment (shards on optimized hardware, WAN-tolerant)

### 9.4 Deliverables
- [x] All 36 engines running across 5 shards (logical configuration defined)
- [ ] Cross-shard latency within budget for each boundary
- [ ] Graceful degradation: LLM node failure doesn't crash regulatory engines
- [ ] Full determinism: same seed + same inputs = same mind state, regardless of shard topology

---

## Phase 10: Integration Testing & Replay Validation

> End-to-end validation of the complete mind across extended runs.

### 10.1 End-to-End Scenarios
- [ ] "A day in the life": 86,400 ticks (1 tick/sec), full engine suite, validate behavioral continuity
- [ ] Stress test: rapid event bursts, conflicting goals, resource scarcity
- [ ] Social test: interaction with another simulated mind, mutual modeling
- [ ] Sleep/wake cycle: circadian modulation of all parameters

### 10.2 Replay Validation
- [ ] Record full mind state across 10,000 ticks
- [ ] Replay and verify tick-identical state at every tick
- [ ] Compare two runs with different shard topologies, verify identical outcomes
- [ ] State diff visualization: highlight divergences between runs

### 10.3 Performance Benchmarks
- [ ] Tick latency per shard (p50, p95, p99)
- [ ] LLM call frequency and latency per engine
- [ ] Cross-shard message volume and latency
- [ ] Memory growth rate and compaction efficiency

---

## Phase 11: Productionization & Cost Optimization (Current)

> Making the mind production-ready with observability, cost controls,
> and the foundation for the API product.

### 11.1 Token Economics & Cost Tracking
- [x] `TokenTracker` engine with per-engine cost breakdown
- [x] Per-tick cost metrics emitted to orchestrator
- [x] Cost spike detection and warning events
- [x] Model pricing table with fallback for unknown models
- [ ] **Cost-based gating**: automatically throttle expensive engines when costs exceed budget
- [ ] **Per-agent cost budgets**: configurable token/cost limits per agent session
- [ ] **Cost forecasting**: predict next-hour costs from current burn rate

### 11.2 LLM Optimization Pipeline
- [ ] **Response caching**: cache common reasoning patterns (greetings, shop transactions)
- [ ] **Engine tiering**: background NPCs use heuristic engines only (no LLM)
- [ ] **Progressive offloading**: track LLM vs heuristic agreement rates per engine
- [ ] **Batch inference**: group multiple agent calls into single LLM requests
- [ ] **Context windowing**: relevance-gated context assembly (only send what matters)
- [ ] **Differential context**: send only what changed since last call per thread

### 11.3 Snapshot & Replay Infrastructure
- [x] `SnapshotManager` wired into orchestrator as first-class middleware
- [x] Delta encoding between snapshots
- [x] Configurable snapshot and persist intervals
- [ ] **Replay validation suite**: record → replay → verify tick-identical state
- [ ] **State diff visualization**: compare two runs, highlight divergences
- [ ] **Snapshot compression**: for long-running minds (100K+ ticks)

### 11.4 Multi-Will Architecture ✅
- [x] `WillManager` — lifecycle management for multiple isolated Wills
- [x] Per-Will state isolation: separate `StateManager`, `Clock`, `EventBus`, `Orchestrator` per Will
- [x] Shared infrastructure: `LLMSemaphore` (global concurrency), `TokenTracker` (global observability), `PromptFactory` agent definitions (stateless templates)
- [x] Engine tiering per Will: `basic` (heuristic, no LLM), `standard` (some LLM), `full` (all 36 engines)
- [x] Will lifecycle: `create`, `tick`, `pause`, `resume`, `archive`, `export`

### 11.5 Data Isolation Strategy ✅
- [x] Filesystem (dev): per-Will directories under `./data/wills/{willId}/`
- [x] Postgres (prod): `will_id` column on entities/metrics tables, composite primary keys
- [x] Memory storage: per-Will in-house vector index (`HNSWIndex`) + state files in dev; Postgres-backed vector/state schema in prod (pgvector, P3.2)
- [x] Drizzle ORM schema with `willId` on all tables

### 11.6 Runtime Stack Validation 🔄
- [x] Test Hono API server with concurrent Will tick operations
- [ ] Benchmark Drizzle + Postgres under multi-Will load (100+ Wills)
- [x] Connection pooling strategy for Postgres (pgBouncer or built-in)

### 11.7 Dormant / Idle Mode ✅ (2026-06-21; backend-level)

The always-on tick loop is architecturally correct for persistent minds but wrong
for event-driven and session-bound deployments — a Will burns credits even when no
one is interacting with it. Implemented at the backend lifecycle layer (idle =
wall-clock since last external interaction, not internal ticks).

- [x] **Auto-suspend**: `startIdleSuspendJob` sweep pauses live Wills idle longer than
      `WILL_IDLE_SUSPEND_MS`; state is already snapshot-persisted (Postgres) by the tick loop
- [x] **Resume-on-demand**: `converse` / `events` / `ask` call `ensureAwake`/`touchActivity`,
      which resumes and injects a `percept.wake` for the offline gap
- [x] **Configurable idle threshold**: `WILL_IDLE_SUSPEND_MS` env (default 15 min; 0 = always-on);
      test-mode/demo Wills exempt — *(per-tier defaults still TODO)*
- [x] **Billing boundary**: dormant = paused = no ticks = $0 Will-hours
- [x] **Developer transparency**: `GET /wills/:id` returns `"phase": "dormant"` with
      `dormantSince` + `lastActiveAt`. Marker is `wills.dormant_since`; explicit pause
      (dormantSince=null) is distinguished from auto-suspend
- [ ] *(follow-up)* evict dormant Wills from memory entirely (resource win beyond the billing win)

### 11.8 Native Structured Output

The executive currently generates free-text with tagged blocks (`[ACTIONS]`, `[PLANS]`,
`[BELIEFS]`, etc.) parsed by `parseResponse()`. When parsing fails, `buildFallbackOutput()`
returns a heuristic action at 0.4 confidence. Replacing this with native LLM structured
output eliminates the parse-failure path entirely.

- [ ] **Structured output schema**: define Zod schemas for `ExecutiveOutputFull` matching
      the current tagged-block vocabulary (`actions`, `plans`, `beliefs`, `goals`,
      `narrative`, `introspection`)
- [ ] **Provider adaptation**: Anthropic uses `tool_use` with a single `cognitive_output`
      tool; OpenAI/DeepSeek use `response_format: { type: "json_schema" }`; Groq falls
      back to constrained JSON generation
- [ ] **Facet schema**: `ExecutiveFacet._reason()` gets its own narrower schema per
      `focus.outputFormat` — already plumbed, needs the provider-level structured call
- [ ] **Remove `buildFallbackOutput` parse path**: once structured output is live, a
      failed call is an LLM error handled by retry — not a silent heuristic fallback
- [ ] **Token efficiency**: structured output reduces output tokens by ~30% vs free-text
      tagged blocks (no markup, no prose wrapping required)

---

## Phase 12: Self-Fine-Tuning Capabilities

> The meta-cognitive layer closes the loop — the mind optimizes its own
> engine parameters based on observed performance.

### 12.1 Parameter Store
- [ ] Define `engine.config` entity type in state manager
- [ ] Engines read parameters from state each tick (not constructor defaults)
- [ ] Parameter bounds, constraints, and adjustment rate limits
- [ ] Parameter change audit trail (who changed what, when, why)

### 12.2 ParameterOptimizer Engine (Shard 4, Priority 35)

The engine that tunes the other engines:

- [ ] **Performance monitoring**: track goal completion rates, emotional stability, decision latency, calibration error per domain
- [ ] **Underperformance detection**: identify parameters producing suboptimal outcomes (e.g., "threat evaluator producing fear > 0.7 80% of the time")
- [ ] **Adjustment proposal**: via LLM with structured output — "given these metrics, propose parameter adjustments within bounds"
- [ ] **Safe application**: gradient descent-style small adjustments (max ±0.05 per cycle)
- [ ] **A/B tracking**: before/after outcome metrics per parameter change
- [ ] **Auto-revert**: if outcome degrades, revert to previous value
- [ ] **Identity alignment**: changes must be consistent with agent's values

### 12.3 Tunable Parameters (Initial Set)

| Engine | Parameter | Current Default | Tuning Range | Optimization Target |
|--------|-----------|----------------|--------------|-------------------|
| AffectiveBlender | `inertia` | 0.5 | 0.2–0.9 | Emotional stability vs responsiveness |
| ThreatEvaluator | `hostileWeight` | 0.35 | 0.1–0.6 | Threat sensitivity calibration |
| ThreatEvaluator | `uncertaintyWeight` | 0.20 | 0.1–0.5 | Anxiety calibration |
| AttentionAllocator | `shiftInertia` | 0.7 | 0.3–0.9 | Focus depth vs flexibility |
| AttentionAllocator | `maxFoci` | 4 | 2–8 | Attention breadth |
| WorkingMemory | `maxChunks` | 7 | 3–12 | Memory capacity |
| WorkingMemory | `baseDecayRate` | 0.15 | 0.05–0.30 | Retention vs turnover |
| GoalManager | `maxActiveGoals` | 5 | 2–10 | Goal parallelism |
| GoalManager | `deactivationThreshold` | 0.1 | 0.05–0.30 | Goal persistence |
| GoalManager | `epistemicBeliefThreshold` | 8 | 4–20 | Learning rate sensitivity |
| DecisionEngine | `cooldownTicks` | 5 | 2–20 | Deliberation frequency |
| AttachmentEvaluator | `attachmentGrowthRate` | 0.05 | 0.01–0.15 | Social bonding speed |
| AttachmentEvaluator | `attachmentDecayRate` | 0.002 | 0.001–0.010 | Bond persistence |
| EpisodicConsolidator | `consolidationThreshold` | 0.25 | 0.10–0.50 | Memory selectivity |
| InhibitionController | `baseInhibitionStrength` | 0.6 | 0.3–0.9 | Impulse control |

### 12.4 Safety Constraints
- [ ] **Hard bounds**: every parameter has min/max — engine rejects out-of-bounds values
- [ ] **Rate limits**: max change per evaluation cycle (±0.05 default)
- [ ] **Rollback on degradation**: if outcome metrics worsen >10%, auto-revert
- [ ] **Human override**: `WILL_ENGINE_LOCKS` env var to freeze specific parameters
- [ ] **Audit trail**: every change logged as `parameter_change` entity for replay
- [ ] **Value alignment gate**: ParameterOptimizer must justify changes against agent's stated values

### 12.5 Optimization Objectives

The fitness function is derived from the agent's identity values:

| Value | Optimizes For |
|-------|--------------|
| curiosity | Higher novelty-seeking, lower threat sensitivity |
| honesty | Higher confidence calibration accuracy |
| growth | More belief formation, higher consolidation rate |
| empathy | Higher social signal sensitivity, lower inhibition on helping |
| self-preservation | Stronger drive response, faster stress recovery |
| coherence | Lower emotional volatility, higher narrative consistency |

---

## Phase 13: Developer API

> The mind as a service. Developers create, configure, and run cognitive
> agents via REST API.

### 13.1 Core API Endpoints ✅ (mostly)
- [x] `POST /wills` — create a Will with identity, engine config, model tier
- [x] `GET /wills` — list all Wills with status and stats
- [x] `GET /wills/:id` — current Will state snapshot
- [~] `POST /wills/:id/tick` — superseded by the always-on tick loop; manual tick not exposed
- [x] `POST /wills/:id/events` — inject external events into Will's world
- [x] `GET /wills/:id/memories` — query Will's episodic/semantic memory
- [x] `GET /wills/:id/metrics` — current metrics snapshot
- [x] `GET /wills/:id/narrative` — current self-narrative
- [x] `POST /wills/:id/ask` — ask the Will a question (triggers introspection)
- [x] `POST /wills/:id/pause` — pause a Will
- [x] `POST /wills/:id/resume` — resume a Will
- [x] `DELETE /wills/:id` — terminate Will, optionally export state
- [x] `GET /wills/:id/export` — export full Will state for migration
- [ ] `POST /wills/:id/tune` — manually adjust engine parameters (admin)

### 13.2 API Infrastructure
- [ ] Authentication via API keys (Stripe integration)
- [ ] Rate limiting per key per tier
- [ ] Usage metering (ticks, tokens, storage, API calls)
- [ ] Webhook events: `will.created`, `will.tick_completed`, `will.cost_threshold`
- [ ] OpenAPI 3.1 spec with examples
- [ ] SDKs: TypeScript (first), Python, Unity C#

### 13.3 Unity Plugin
- [ ] `CognitiveAgent` MonoBehaviour — drop on any GameObject
- [ ] Automatic agent lifecycle management (create on Start, tick on Update)
- [ ] Event system: `OnAction`, `OnEmotion`, `OnThought`, `OnMemoryFormed`
- [ ] Inspector configuration: identity, traits, model tier, token budget
- [ ] Offline mode: local-only agents with heuristic engines (no API key needed)
- [ ] Unity Asset Store listing

### 13.4 Conversation UX — Reducing Developer Friction

The current `POST /converse` → 202 → SSE `outbound_message` model is architecturally
correct but non-trivial for developers who expect a simple request/response pattern.

- [x] **Synchronous / streaming wrapper**: `POST /wills/:id/converse` with `stream: true`
      streams chunks over SSE; the async 202 model remains for fire-and-forget callers.
- [x] **Word-level streaming**: chunk listeners push token chunks to the SSE outbox.
- [ ] **WebSocket transport**: `GET /wills/:id/ws` as an alternative to SSE for
      environments where SSE is inconvenient (Unity, mobile, bidirectional scenarios)
- [x] **Typing indicator event**: `will_thinking` emitted on `ingest()` before the
      first output token.
- [ ] **SDK abstractions**: TypeScript and Python SDKs expose `await will.chat("hello")`
      that wraps the sync mode internally — zero SSE knowledge required

### 13.5 Surface Internal Tooling via API

Several powerful systems exist in the engine that are not yet accessible through the
developer API. Surfacing them turns Will's internal infrastructure into developer-facing
value.

- [x] **Replay API**: `POST /wills/:id/replay/start|stop`, `GET /wills/:id/replays`,
      `GET /wills/:id/replay/:runId` — record a session, list/export replays via API
- [x] **Scenario API**: `POST /wills/:id/scenario` — load a named scenario for reproducible runs
- [x] **Fidelity eval**: `POST /wills/:id/eval` + `POST /wills/:id/pma/distill|load` and
      `POST /wills/:id/identity/coherence` — PMA distill/reconstruct + fidelity reporting.
- [x] **Replay comparison**: `POST /wills/:id/replay/compare` — diff two recorded sessions.
- [ ] **Distributed mode**: expose `DistributedOrchestrator` configuration via API for
      enterprise deployments running many concurrent Wills across multiple nodes

---

## Phase 13.6: Platform Interoperability (MCP + A2A)

> Will has the cognitive layer that MCP and A2A assume agents should have, but
> lacks the protocol layer that makes them network-addressable. This phase adds
> the plumbing without changing the mind.

### 13.6.1 MCP Client — Dynamic Tool Discovery

The `EffectorRegistry` and `ChannelRegistry` are the right abstractions but statically
defined at compile time. MCP client support lets operators plug any external tool
server into a running Will without code changes.

- [ ] **MCP client adapter**: implement `MCPEffectorAdapter` that wraps any MCP server
      as a set of `EffectorDefinition` entries — name, description, parameters auto-derived
      from the MCP tool manifest
- [ ] **Runtime registration**: `POST /wills/:id/mcp/connect` — connect to an MCP server
      URL; its tools are registered into the Will's `EffectorRegistry` immediately
- [ ] **Schema translation**: MCP tool input schemas (JSON Schema) → Zod schemas for
      Will's effector parameter validation
- [ ] **Call routing**: when the executive emits an `[ACTIONS]` block targeting an
      MCP-registered effector, `ActionExecutor` routes the call to the MCP server and
      feeds the result back as an `effector.result` percept via `Exteroception`
- [ ] **Disconnect / hot-swap**: `DELETE /wills/:id/mcp/:serverId` — revoke and
      unregister tools at runtime without stopping the tick loop

### 13.6.2 MCP Server — Will as a Tool Provider

A running Will can expose its own capabilities as an MCP server, making it
consumable by any MCP-aware host (Claude, Cursor, other agents).

- [ ] **Tool manifest**: expose `GET /wills/:id/mcp` returning a valid MCP tool
      manifest — tools: `converse`, `inject_event`, `get_state`, `get_beliefs`,
      `get_goals`, `get_narrative`
- [ ] **MCP endpoint**: `POST /wills/:id/mcp/call` — handle MCP tool invocations,
      translate to internal API calls, return results in MCP response format
- [ ] **Authentication**: MCP server endpoints require API key; the manifest advertises
      the auth scheme

### 13.6.3 A2A Protocol — Will-to-Agent Communication

Will's `TheoryOfMind`, `ReputationTracker`, and `EmpathySimulator` already model
other agents cognitively. A2A adds the network transport that makes this real.

- [ ] **Agent Card**: `GET /wills/:id/will-card` — return a valid A2A Agent Card
      describing the Will's capabilities, communication surface, and supported task types
- [ ] **A2A task intake**: `POST /wills/:id/a2a/task` — receive a structured A2A task
      request from another agent; translate to a `percept.social` event injected into
      `Exteroception`; the Will reasons about it on its next executive cycle
- [ ] **A2A task response**: when the executive emits actions targeting the originating
      agent's `entityId`, `ActionExecutor` formats the result as a valid A2A task
      response and delivers it to the originating agent's callback URL
- [ ] **Will-to-Will orchestration**: `POST /wills/:id/delegate` — one Will delegates a
      structured task to another Will via A2A; results feed back as percepts; the
      delegating Will's `TheoryOfMind` tracks the delegate's progress

---

## Phase 13.7: Communication Layer Hardening

> Open items from the Phase 7–8 communication audit (TODO.02.md). These close the
> remaining gaps in message delivery reliability, channel routing, and transport
> contract documentation.

### 13.7.1 Delivery Integrity
- [ ] **`conversation.sent` at confirmed delivery**: move entity creation from push time
      (`ProactiveCommunicator._handleOutboundMessage`) to `confirmMessageDelivery()` —
      keep the `wm-exchange` intent entity at push time; delay the sent record to receipt
- [ ] **Unconfirmed drain logging**: log `WARN` for messages drained from the outbox but
      not yet confirmed when the SSE client disconnects; prevents silent loss between
      drain and delivery

### 13.7.2 Channel Gate Enforcement
- [ ] **Enforce two-gate pattern everywhere**: every execution site must call `canEmit()`
      (environmental capability) then `isAllowed()` (permission) in sequence with distinct
      failure reasons — `"no channel available"` vs `"not permitted"`
- [ ] **Document `ChannelRegistry` gate semantics**: inline documentation distinguishing
      the two gates so they cannot be conflated at new call sites

### 13.7.3 Proactive Outbound Routing
- [ ] **`ChannelRouter` layer**: given `(targetHint, effectorName)`, resolves the canonical
      `targetEntityId` and confirms channel availability; executive can write symbolic
      targets (`"user"`, `"group:engineering"`) rather than raw entity IDs
- [ ] **`ProactiveCommunicator` delegates to `ChannelRouter`** before outbox push

### 13.7.4 Transport Architecture (Design)
- [ ] **SSE + REST ack protocol**: SSE event carries `eventId`; consumer POSTs
      `{ eventId, result }` to `/ack`; `WillManager` matches to in-flight invocations —
      lowest-cost path to reliable ack without changing transport layer
- [ ] **WorldInterface contract document**: `docs/world-interface-contract.md` defining
      `effector_invoked` payload schema, timeout SLA (default 15 ticks), allowed response
      fields, and behavior on timeout
- [ ] **WebSocket upgrade option**: WS session alongside SSE; client connects WS, receives
      all events, sends acks and effector results back over the same connection; opt-in via
      `?transport=ws` — designed for game engines and IoT clients with high effector-result
      throughput

---

## Phase 13.8: Perceptual Tier — 5 Senses Architecture ✅ ~85% (built)

> Will cannot be called a mind without sensory experience. This phase introduces a new
> perceptual input layer (`will/src/cognition/engines/senses/`) that models how Will
> receives and interprets stimuli from the world — structured around the five biological
> senses. Each sense engine translates a category of raw signal into typed `Percept`
> objects the cognitive pipeline can reason about.
>
> The executive master is freed from direct conversational handling entirely. It focuses
> on initiative, metacognition, and high-order cognition. Conversation is handled by
> the AuditionEngine via a universal `ExecutiveFacet` — the same facet mechanism used
> by PlanningEngine — keeping Will's identity coherent across parallel cognitive threads.

### 13.8.0 Prerequisites (Fix First)

These are architectural inconsistencies that must be resolved before the senses layer
is built on top of them.

- [ ] **PlanningEngine GoalManager decoupling**: `_onFacetDecision` currently calls
      `goalManager.addGoal()` directly. This must change: `GoalManager` subscribes to
      `executive.facet.progress` on the event bus and updates its state from that event.
      PlanningEngine publishes the event; GoalManager consumes it. Facet remains universal.
- [ ] **Verify `executive.facet.progress` field promotion**: confirm that `goalId`,
      `goalProgress`, `newGoals`, `goalsToAbandon`, and `newBeliefs` are promoted to
      top-level in the published payload (they are in the current `facet.ts` — audit only).
- [ ] **Verify `executive.facet.sync` subscription in master**: confirm master subscribes
      and maintains `_masterSyncHistory` correctly for cross-facet unified awareness.

### 13.8.1 Core Perceptual Types

Define the shared type layer all sense engines build on.

- [ ] **`SenseEngine` interface** (`will/src/cognition/engines/senses/index.ts`):
  ```
  interface SenseEngine {
    readonly domain: SenseDomain   // 'audition' | 'vision' | 'somatosensation' | 'olfaction' | 'gustation'
    ingest(input: SensoryInput): Promise<void>
    onPercept(handler: (percept: Percept) => void): Unsubscribe
  }
  ```
- [ ] **`Percept` base type**: `{ domain, sourceEntityId, timestamp, salience, raw, processed }`
- [ ] **`LanguagePercept`** (AuditionEngine-specific):
  ```
  {
    domain: 'audition'
    channel: 'text' | 'voice'
    content: string
    speakerEntityId: string
    threadId: string
    digest: string               // last-N-messages rolling context
    salience: number             // computed from urgency, relationship weight, topic relevance
  }
  ```
- [ ] **`SensoryInput` discriminated union**: covers all five domains:
  - `TextMessage`, `VoiceChunk` (audition)
  - `ImageFrame`, `VideoSegment` (vision)
  - `WebhookEvent`, `SystemSignal` (somatosensation)
  - `AmbientMetric`, `BackgroundSignal` (olfaction)
  - `InternalEvaluation`, `SelfAssessmentTrigger` (gustation)
- [ ] **`PerceptualBus`**: lightweight internal bus that sense engines publish to;
      downstream engines (`AttentionAllocator`, `ExecutiveMaster`) subscribe to `Percept` streams

### 13.8.2 AuditionEngine — Language & Hearing (Full Implementation) ✅

The first real sense engine. Handles all text and voice input from external entities.
Spawns one `ExecutiveFacet` per conversation session (keyed by `entityId`).
Publishes replies via the existing outbox. Master stays free for initiative.

- [ ] **`AuditionEngine` class** (`will/src/cognition/engines/senses/audition.engine.ts`):
  - Extends base `SenseEngine` contract
  - Maintains `Map<entityId, ExecutiveFacetHandle>` — one facet per active conversation
  - `ingest(input: TextMessage | VoiceChunk): Promise<void>` — entry point for all language
  - On new `entityId`: spawn facet via `spawnFacet()`, call `setFocus(conversationFocus)`
  - On existing `entityId`: `facet.report(newPercept)` to resume the existing reasoning thread
  - On entity disconnect / session end: call `facet.destroy()`, remove from map

- [ ] **`conversationFocus: FocusSection`** definition:
  ```typescript
  {
    title: 'Active Conversation',
    content: `Speaker: ${speaker.name}\nThread: ${digest}\nCurrent: "${message.content}"`,
    instructions: `You are Will engaged in conversation. Respond naturally using [REPLY].
                   Signal tasks in [GOALS] if the user requests something actionable.
                   Do not generate plans independently — that is the master's responsibility.`,
    outputFormat: 'full',       // re-enables [REPLY] gating (facet mode normally suppresses it)
    extractDecision: (output) => ({
      reply: output.reply ?? '',
      taskSignals: output.newGoals ?? [],
      urgency: output.decision?.urgency ?? 'normal',
      requiresMasterAttention: output.decision?.requiresMasterAttention ?? false,
    })
  }
  ```

- [ ] **Salience computation**: before spawning/reporting, compute `LanguagePercept.salience`
      from: relationship weight (AttachmentEvaluator score for `speakerEntityId`),
      message urgency keywords, topic relevance to active goals, conversation recency

- [ ] **Task signal publication**: on each facet decision, emit `audition.task.signal` event
      on the internal bus — payload: `{ entityId, signals: taskSignals, urgency }`.
      Master and PlanningEngine subscribe; master decides whether to spawn a plan.

- [ ] **Reply streaming**: wire `facet._chunkListeners` → outbox push per chunk;
      filter chunks that contain `[REPLY]` prefix; strip markup before pushing to client.
      First chunk target: < 400ms from `ingest()` call.

- [ ] **Facet `[REPLY]` pass-through**: confirm `PromptFactory.buildSystemPrompt(mode: 'facet')`
      with `focus.outputFormat = 'full'` re-enables the `[REPLY]` gate — no PromptFactory
      changes needed, just the FocusSection flag.

- [ ] **Thread digest**: maintain a rolling `Map<entityId, string[]>` of last 5 message
      summaries; inject as `digest` into `FocusSection.content` on each cycle.

### 13.8.3 Shell Sense Engines ✅ (stubs in place)

Structural stubs — `SenseEngine` interface with no-op bodies, `[SHELL]` warning on `ingest()`.
Full implementation planned post-MVP. All four present under `will/src/cognition/senses/`.

- [x] **`VisionEngine`** (`senses/vision.engine.ts`)
  — Domain: `vision`. Handles image frames, video segments, screenshots.
  Input types: `ImageFrame`, `VideoSegment`. Future: multimodal LLM vision calls.

- [x] **`SomatosensationEngine`** (`senses/somatosensation.engine.ts`)
  — Domain: `somatosensation`. Handles webhooks, system events, external API callbacks,
  environment state changes. Will's "touch" — physical interaction with external systems.

- [x] **`OlfactionEngine`** (`senses/olfaction.engine.ts`)
  — Domain: `olfaction`. Handles ambient background signals: resource trends, long-running
  metric drifts, low-priority environmental monitoring. Triggers slow-burn affect responses.

- [x] **`GustationEngine`** (`senses/gustation.engine.ts`)
  — Domain: `gustation`. Handles internal self-evaluation triggers: post-action quality
  assessment, identity alignment checks, value coherence probes. Will's introspective taste.

### 13.8.4 Cognitive Integration

Wire sense engines into the existing cognitive pipeline.

- [ ] **`assembleMind()` registration**: add all five engines to the mind assembly function;
      register `AuditionEngine` output as a percept source for `AttentionAllocator`.
- [ ] **`Cognition` type update**: add `senses: SenseEngineRegistry` to the `Cognition`
      interface; expose via `WillManager.getSenses(id)`.
- [ ] **`AttentionAllocator` subscription**: subscribe to `PerceptualBus` to receive
      `Percept` objects; use `salience` field as direct input to attention focus computation.
- [ ] **Executive master refactor**: remove direct conversational reply logic from master
      reasoning loop; master receives conversation awareness via `executive.facet.sync`
      events from AuditionEngine facets only — no direct message parsing.

### 13.8.5 Conversation Pipeline Rebuild (Replaces Current `/converse`) ✅ (WS pending)

The current `POST /converse` → 202 → SSE `outbound_message` pipeline has fundamental
flaws: fake word-split streaming, race condition on `injectedMsgId`, ambiguous reply
matching, no session continuity, zero durability.

- [ ] **Route change**: `POST /wills/:id/converse` body routes to
      `AuditionEngine.ingest(TextMessage)` — not directly to executive LLM
- [ ] **Real chunk streaming**: facet `_chunkListeners` push token chunks to SSE stream
      as they arrive from the LLM provider; `[REPLY]` filter strips markup inline
- [ ] **Durable reply buffer**: `conversation_messages` table in Postgres —
      `{ id, willId, entityId, role, content, threadId, createdAt }`;
      every ingested message and every reply chunk-assembled reply persisted before delivery
- [ ] **Session continuity**: `threadId` passed in request body; AuditionEngine uses it
      to locate the correct facet and thread digest; client can resume after disconnect
- [ ] **WebSocket upgrade**: `GET /wills/:id/ws?entityId=...` — bidirectional channel;
      client sends `{ type: 'message', content }`, server pushes `{ type: 'chunk', content }`
      and `{ type: 'reply_complete', messageId }` events; replaces SSE for most clients
- [ ] **SSE kept as fallback**: existing SSE endpoint preserved for backward compatibility;
      now receives fully-assembled reply events rather than word-split fake-stream
- [ ] **Typing indicator**: publish `will_thinking` event immediately on `ingest()` before
      any LLM call fires — gives UIs a spinner anchor with < 50ms latency

### 13.8.6 API Surface ✅

- [x] **`POST /wills/:id/senses/:domain/ingest`** — direct sensory injection (testing/integration)
- [x] **`GET /wills/:id/senses`** — list active sense engines and their status
- [x] **`GET /wills/:id/conversations`** — list conversation threads per entity
- [x] **`GET /wills/:id/conversations/:entityId`** — retrieve message history for an entity
- [x] **`DELETE /wills/:id/conversations/:entityId`** — terminate conversation session,
      destroy facet, persist final thread state

---

## Phase 14: Billing & Monetization 🔄 ~80%

> See `MONETIZATION.md` for full pricing strategy. **Plans re-baselined to v3
> (2026-06-20): Starter $19 / Pro $199 / Enterprise $1,500+ — no free plan.**

### 14.1 Billing Provider Strategy 🔄
- [x] **Primary: Lemon Squeezy** — Merchant of Record for global customers
  - Handles VAT/GST, sales tax, chargebacks, invoicing
  - Pays out via bank transfer to Wise multi-currency account
  - 5% + $0.50/transaction
- [ ] **Secondary: Paystack** — African payment methods (deferred to v1.1)
  - Nigeria, Ghana, South Africa, Kenya coverage
  - 1.5% + local fees
- [x] **Payout**: Lemon Squeezy → Wise (USD) → local currency at interbank rates

### 14.2 Stripe Alternative Implementation ✅
- [x] Lemon Squeezy product catalog: **Starter, Pro, Enterprise** (v3)
- [x] Subscription lifecycle webhooks: created, updated, cancelled, refunded
- [x] API key generation on subscription activation (own keys, not provider keys)
- [x] API key revocation on subscription cancellation
- [ ] Usage-based overage tracking (`whOverageCents` seeded; metering job pending)

### 14.3 Customer Portal ✅
- [x] Usage dashboard: Wills created, ticks processed, tokens consumed, costs
- [x] API key management (create, rotate, revoke)
- [x] Plan comparison and upgrade flow via Lemon Squeezy checkout
- [x] Billing history and invoice download

### 14.4 Internal Cost Monitoring
- [ ] Per-customer profitability: revenue - (LLM costs + infra costs)
- [ ] Cost anomaly detection: sudden spikes trigger investigation
- [ ] Model cost arbitrage tracking: when to route to cheaper models
- [ ] Margin dashboard: gross margin per tier, per customer, per model
- [ ] Regional payout reconciliation: Lemon Squeezy → Wise → Local

---

## Phase 15: Self-Hosted LLM Infrastructure

> Migration from external API providers to self-hosted models for
> margin expansion and control.

### 15.1 Stage 1: Evaluation
- [ ] Benchmark DeepSeek V3, Llama 4, Qwen 3 on structured output tasks
- [ ] Compare token costs vs GPT-4o/Claude at current usage patterns
- [ ] Evaluate fine-tuning potential on custom schemas

### 15.2 Stage 2: Hybrid Deployment
- [ ] Deploy selected model on 1-2 GPUs (RunPod, Vast.ai, or dedicated)
- [ ] Route simple queries to self-hosted, complex/novel to external
- [ ] A/B test: self-hosted vs external quality for each engine
- [ ] Gross margin target: 80% (up from ~73%)

### 15.3 Stage 3: Self-Sufficient
- [ ] Dedicated GPU cluster for production inference
- [ ] Fine-tuned models on structured output schemas
- [ ] Speculative decoding optimized for cognitive engine prompts
- [ ] External providers as overflow/fallback only
- [ ] Gross margin target: 90%+

---

## Phase 16: Research Platform

> Open the architecture to academic researchers. Runs in parallel with
> commercial API — same infrastructure, different pricing model.

### 16.1 Academic Access
- [ ] Free tier for verified .edu emails (limited agents, public data only)
- [ ] Grant-funded bulk pricing for large-scale simulations
- [ ] Dataset export: anonymized agent behavior traces for analysis
- [ ] Collaboration pipeline: researchers submit engine configs, run experiments

### 16.2 Publication Support
- [ ] White paper: "A 36-Engine Cognitive Architecture for Persistent AI Agents"
- [ ] Open source core framework (MIT license)
- [ ] Benchmark suite: standard scenarios for agent evaluation
- [ ] Conference targets: AAMAS, CogSci, NeurIPS (workshop), ACL

### 16.3 Community
- [ ] Discord for researchers and developers
- [ ] Example scenarios and tutorials
- [ ] Engine development guide (how to build custom engines)

---

## Phase 17: Enterprise & Vertical SaaS

> White-label and industry-specific deployments.

### 17.1 Enterprise Features
- [ ] SSO (SAML/OIDC), RBAC, audit logs
- [ ] On-premise deployment option
- [ ] Custom model fine-tuning per customer
- [ ] SLA (99.9% uptime for Shards 0-2, 99.5% for LLM shards)
- [ ] Dedicated support and onboarding

### 17.2 Vertical Packages
- [ ] **Gaming**: Unity/Unreal SDK, NPC behavior packs, world integration docs
- [ ] **Healthcare**: HIPAA-compliant deployment, companion agent templates
- [ ] **Education**: Tutor agent with curriculum tracking, SIS integration
- [ ] **Elder Care**: Companionship agent with family alerting, mood tracking

---

## Phase 18: Cognitive Quality (Post-Revenue)

> Items confirmed valuable but deliberately excluded from MVP. Build these after first
> revenue — each requires real session log data to calibrate correctly.

### 18.1 Belief System

- [ ] **Embedding-based belief deduplication**: replace the tag+category gate with vector
      similarity on belief statements. The tag gate prevents false merges but misses
      synonymous beliefs phrased differently. Requires embedding provider decision
      (on-device ONNX vs. batched API) and real session data showing duplication rates.
- [ ] **Belief-outcome feedback loop**: connect `EpisodicConsolidator` outcomes back to
      belief confidence — when an action based on belief B produces a negative outcome,
      B's confidence decays faster than natural staleness; positive outcomes reinforce B.
      Requires an action→belief provenance trail that doesn't currently exist.
- [ ] **Belief contradiction detection**: identify and flag logically contradictory belief
      pairs (e.g. "I am trusted" and "I am suspected of deception") before both persist
      at high confidence. Requires embedding-based scoring or a classifier LLM call;
      acceptable only after session data confirms contradiction rates justify the cost.

### 18.2 Affect & Emotion

- [ ] **Self-tuning affect calibration via metacognition**: surface engine config values
      (`irritabilityRate`, `habituationRate`, staleness thresholds) as readable simulation
      state; a planned `MetacognitionEngine` reads health signals and proposes config
      adjustments the executive can approve or veto. Rate-limit carefully — metacognitive
      reasoning is an additional LLM call type.
- [ ] **Valence history for affect stability scoring**: track a rolling window of
      `affect.valence` values (last N ticks); report variance as a stability score. A Will
      oscillating between +0.6 and −0.6 every 10 ticks looks healthy at any instant but
      is in fact unstable — instantaneous metrics miss this entirely.
- [ ] **Mood persistence across sessions**: persist affect state to DB on pause; apply a
      decay function on resume based on elapsed wall-clock time (e.g., full decay over
      24–48h). Users expect emotional continuity — a Will that had a difficult session
      yesterday should carry residual affect today.

### 18.3 Goals & Planning

- [ ] **Goal progress meaningfulness**: replace executive self-reported `progress` (0–1,
      uncalibrated) with objective functions tied to actual action outcomes or measurable
      state changes. Start with quantifiable goals (count-based, presence-based) before
      open-ended ones.
- [ ] **Goal dependency graph**: goals that depend on other goals should be representable
      as a DAG. A Will that wants to "build trust with Alice" before Alice has been
      introduced will repeatedly fail trust-building actions rather than resolving the
      prerequisite. Requires a dependency schema change and planning engine DAG awareness.

### 18.4 Memory

- [ ] **Relevance-based episodic retrieval**: replace recency+salience retrieval with
      semantic relevance to the current executive context. When reasoning about goal X,
      retrieve episodes involving X — not just recent ones. Requires episode embedding at
      consolidation time.
- [ ] **Multi-session autobiographical continuity**: `AutobiographicalNarrator` currently
      rebuilds from scratch each session. The narrative should persist, accumulate, and
      delta-update rather than regenerate. Requires DB storage and a delta-update strategy.
- [ ] **Working memory reconciliation pass**: the working memory snapshot fed to the
      executive can diverge from actual goal state after 400+ ticks of goal entity updates.
      Implement a reconciliation pass before snapshot generation. Audit the
      snapshot→executive context serialization path to identify drift points.

### 18.5 Platform & Developer Experience

- [ ] **Cognitive health webhooks**: emit a webhook event when health status changes
      (`healthy → drifting`, `drifting → degraded`) so developers can react without
      polling. Implement after the health signal has been validated by early users.
- [ ] **Per-Will cognitive profile selection**: differentiate engine config defaults by
      profile type — a companion Will and a customer-service Will should have meaningfully
      different frustration thresholds, habituation rates, and belief staleness parameters.
      Requires real usage data per profile type before guessing at the right values.
- [ ] **Session log analysis CLI**: a tool that reads `.jsonl` session log files and
      produces a human-readable cognitive session report: executive timeline, belief
      formation, affect trajectory, goal progress, and anomalies. Gather early user
      feedback on what questions actually need answering before designing the report schema.

---

## Phase 19: Cognitive Architecture Evolution

> Long-term architectural evolution: event-driven pub/sub, Global Workspace Theory,
> and Active Inference. This transforms Will from a tick-driven simulation loop into
> a fully autonomous, event-driven cognitive system.
>
> Three paradigms converge:
> - **Event-Driven Pub/Sub (Actor Model)** — decoupled autonomous engines, typed event
>   bus, each engine owns its state slice as source of truth
> - **Global Workspace Theory (GWT)** — engines compete on salience for a broadcast
>   workspace the executive moderates; attentional focus emerges from system dynamics
> - **Active Inference (Predictive Processing)** — engines generate predictions and
>   activate on prediction error, not on raw inputs
>
> Phases must be completed in order. Each is groundwork for the next.
> Relationship to earlier phases: Phase 19-A enables Phase 10 replay validation;
> Phase 19-D enables Phase 9 distributed deployment; Phase 19-E enables Phase 12
> self-fine-tuning via executive config-mutation events.

### Foundational Decisions (locked before implementation)

- **Consistency model**: causal consistency within a single engine's published stream;
  eventual consistency across engines. Each engine's stream carries monotonic sequence
  numbers. Cross-engine simultaneity not guaranteed and not required for correctness.
- **Event ordering**: FIFO per source engine. No global total order imposed.
- **Cold start**: on startup each engine publishes a synthetic `engine.snapshot` event
  carrying its full initial state before any live events flow. No engine begins
  processing live events before its subscribed snapshots are received.
- **Executive coherence**: executive takes a versioned snapshot of its event buffer when
  it begins an LLM call; its published response is tagged with the snapshot version.
  Executive LLM latency never blocks any other engine.

### Phase 19-A: Foundation (Infrastructure Only)
- [ ] **Event bus**: typed in-process pub/sub; topic scheme `{engine}.{category}.{signal}`;
      per-engine bounded inbox with overflow policy (`drop-oldest` for high-frequency,
      `queue` for critical); at-least-once within a tick window, FIFO per source
- [ ] **Test bus**: synchronous, deterministic variant for unit and integration testing —
      required before any engine migration begins
- [ ] **Schema registry**: central `event type → versioned Zod schema`; bus rejects
      malformed events at publish time; every event carries
      `{ type, version, sourceEngine, sequenceNumber, logicalTime }`; no unversioned
      events enforced from the first type defined
- [ ] **Persistent event log**: every event written to an append-only log before delivery;
      the log is the authoritative record; current state is a derived projection. Enables
      state reconstruction at any past logical timestamp and full causal debugging.
- [ ] **Heartbeat publisher**: replaces the tick loop's execution role with a clock signal;
      publishes `clock.tick` at a configurable adaptive interval; only engines that need
      time-based behaviour subscribe
- [ ] **Engine interface extensions**: add `publishes()`, `subscribes()`, `onEvent()`,
      `snapshot()` to the engine contract without breaking existing implementations

*Exit criteria: event bus, schema registry, and persistent event log running and
validated. All existing engines unchanged. Zero behavioral regression.*

### Phase 19-B: DAG Scheduler
- [ ] Engines declare inputs via `subscribes()` at registration
- [ ] Scheduler builds a topological sort; fires engines only when declared inputs have
      changed since their last execution
- [ ] Parallel execution for engines in the same topological tier with no shared write
      targets (`Promise.all` over independent branches)
- [ ] **Cycle detection at registration time** — hard error, never runtime discovery
- [ ] **Performance target**: 50–70% reduction in engines executed per quiet tick

*Exit criteria: all 36 engines running via DAG. Priority numbers retired. Tick
latency benchmarked. No behavioral regression.*

### Phase 19-C: Event Bus Goes Live (Publish Side)
- [ ] Engines publish events as side effects of existing `update()` — only on meaningful
      delta (threshold-gated), not every tick
- [ ] Events flow to the log and dead-letter queue (no live subscribers yet)
- [ ] Schema registry validates every event at publish time
- [ ] Studio gains a live **Event Stream** view: real-time feed, event rates, salience
      distribution

*Exit criteria: all 36 engines publishing. Schema registry complete. No engine
reading from bus yet.*

### Phase 19-D: State Ownership Migration (Engine by Engine)
Migrate state ownership from the shared metrics map to individual engines.
For each engine: remove metrics writes from `StateCommands`, move values into
engine private state, wire `onEvent()` subscriptions, replace `state.metrics` reads
with local subscription copies.

Migration order (source layers first):
- **Wave 1**: Exteroception, Interoception, SocialPerception, NoveltyDetector, WorkingMemory
- **Wave 2**: EnergyRegulator, SleepPressureRegulator, CircadianOscillator, StressRegulator, AttentionAllocator
- **Wave 3**: AestheticEvaluator, MoralEvaluator, ThreatEvaluator, RewardEvaluator, LossEvaluator, FrustrationEvaluator, AttachmentEvaluator, AffectiveBlender
- **Wave 4**: EpisodicConsolidator, SemanticIntegrator, ForgettingCurve, DreamSimulator, AutobiographicalNarrator
- **Wave 5**: GoalManager, DecisionEngine, InhibitionController, TaskSwitcher, PlanningEngine, MentalSimulator
- **Wave 6**: SelfModelUpdater, ConfidenceCalibrator, BiasDetector, IntrospectionEngine, TheoryOfMind, EmpathySimulator, ReputationTracker

A **projection worker** subscribes to migrated engine events and writes derived values
back to the metrics map for backward compatibility with the Studio API throughout migration.

*Exit criteria: all engines reading from local subscription copies. Shared metrics map
is a projection cache only. Studio still works via the projection layer.*

### Phase 19-E: Global Workspace Theory
- [ ] **Salience scoring**: every significant event carries a `salience` score (0.0–1.0)
      computed by the publishing engine based on magnitude, urgency, relevance to active
      goals, and novelty relative to recent baseline
- [ ] **Executive as workspace moderator**: subscribes to all events above a configurable
      salience threshold; maintains a salience-ranked buffer; selects the highest-salience
      coherent cluster when buffer meaningfulness exceeds threshold or cooldown elapses
- [ ] **Workspace broadcast events**: `executive.interpretation.formed`,
      `executive.goal.proposed`, `executive.self.reflection`,
      `executive.decision.rationale`, `executive.prediction.formed` — each flowing back
      into engine subscriptions with observable behavioral effects
- [ ] **Attentional bottleneck**: one coherent thought broadcast per cycle — distraction,
      hyperfocus, and intrusive thoughts emerge from salience dynamics, not hardcoded rules

*Exit criteria: executive operating as workspace moderator. Salience competition
measurable in Studio. Sustained topic coherence demonstrable during high-salience events.*

### Phase 19-F: Active Inference (Per-Engine, Incremental)
Each migrated engine maintains a generative model, computes prediction error against
incoming events, and updates precision weights. Engines that predict accurately produce
low-error events (low salience, rarely enter workspace). Surprised engines produce
high-error events (high salience, compete for executive attention).

Migration order: Perceptual → Regulatory → Affective → Executive engines →
Executive (top-level generative model whose LLM call produces predictions cascading
downward through all lower engines).

*Exit criteria: Perceptual and Regulatory engines on prediction-error activation.
Measurable reduction in quiet-tick compute. Observable anticipatory behavior: Will
state shifts before a predicted event arrives.*

### Phase 19 Risk Register

| Risk | Mitigation |
|---|---|
| Dependency cycle introduced | Hard error at `subscribes()` registration — detected before first event |
| Engine reads before snapshot arrives | Cold-start protocol: snapshots before live events; default values until snapshot received |
| Event schema breaks subscriber silently | Schema registry validates at publish; version field required |
| Executive reasons over superseded events | Snapshot-at-processing-time with version tag on all executive output |
| Behavioral regression during wave migration | Shared metrics projection layer keeps old consumers working; regression tests compare projection vs direct engine state |
| Event accumulation memory leak | Bounded inboxes with explicit overflow policy; inbox depth metric per engine in Studio |

---

## Appendix A: Engine Dependency Graph

```
Regulatory (Shard 0)
├── No dependencies — foundational layer
└── Outputs: DriveSignals, ModulationSignals

Perceptual (Shard 0)
├── Depends on: Regulatory (modulation of attention)
└── Outputs: Percepts, SalienceTags

Affective (Shard 1)
├── Depends on: Perceptual (what's happening), Regulatory (bodily state)
└── Outputs: EmotionSignals, AffectiveState

Memory (Shard 2)
├── Depends on: Perceptual (what to store), Affective (emotional tags)
└── Outputs: RetrievedMemories, ConsolidatedEpisodes

Executive (Shard 3)
├── Depends on: Perceptual, Affective, Memory, Regulatory
└── Outputs: ActionDecisions, GoalUpdates

Meta-Cognitive (Shard 4)
├── Depends on: Memory (decision history), Executive (decisions to evaluate)
└── Outputs: SelfModel, ConfidenceCalibration, Narrative

Social (Shard 1)
├── Depends on: Perceptual (social signals), Affective (empathy)
└── Outputs: OtherMindModels, ReputationScores
```


## Appendix B: Emotion Coverage Matrix

| Emotion Family | Evaluator Engine | Trigger Sources | Output Metrics |
|---------------|------------------|-----------------|----------------|
| Fear | ThreatEvaluator | Hostile entities, resource scarcity, uncertainty, social rejection risk | `fear`, `anxiety`, `vigilance` |
| Joy | RewardEvaluator | Goal progress, positive feedback, resource gains, novel discoveries | `joy`, `satisfaction`, `excitement` |
| Sadness | LossEvaluator | Failed goals, lost resources, relationship damage, missed opportunities | `sadness`, `disappointment`, `grief` |
| Anger | FrustrationEvaluator | Repeated failures, blocked goals, violated expectations, unfairness | `frustration`, `anger`, `irritability` |
| Love | AttachmentEvaluator | Frequent positive interaction, dependency, trust history, shared experience | `love`, `trust`, `belonging`, `loneliness` |
| Curiosity | AestheticEvaluator | Novelty, complexity, pattern, unresolved prediction errors | `awe`, `curiosity`, `interest`, `boredom` |
| Self-Conscious | MoralEvaluator | Norm violations (self/other), value alignment, social comparison | `guilt`, `shame`, `pride`, `indignation`, `disgust` |

## Appendix C: Project Timeline

| Phase | Description | Status | Dependencies |
|-------|-------------|--------|-------------|
| 0 | Prerequisites | ✅ Complete | None |
| 1 | Time Semantics | ✅ Complete | Phase 0 |
| 2 | Regulatory Engines | ✅ Complete | Phase 1 |
| 3 | Perceptual Engines | ✅ Complete | Phase 2 |
| 4 | Affective Engines | ✅ Complete | Phase 3 |
| 5 | Memory Engines | ✅ Complete | Phase 4 |
| 6 | Executive Engines | ✅ Complete | Phase 1, 4, 5 |
| 7 | Meta-Cognitive Engines | ✅ Complete | Phase 6 |
| 8 | Social Engines | ✅ Complete | Phase 4 |
| 9 | Distributed Deployment | 🔄 ~40% (single-node) | Phase 6, 7 |
| 10 | Integration Testing | 🔄 ~20% | All engine phases |
| 11 | Productionization | 🔄 ~60% | Phase 10 |
| 12 | Self-Fine-Tuning | 🔄 ~15% (persona-prior) | Phase 7, 11 |
| 13 | Developer API | ✅ ~90% | Phase 11 |
| 13.6 | Platform Interoperability (MCP + A2A) | 📋 0% | Phase 13 |
| 13.7 | Communication Layer Hardening | 🔄 ~50% | Phase 13 |
| 13.8 | Perceptual Tier — 5 Senses Architecture | ✅ ~85% | Phase 13, 13.7 |
| 14 | Billing & Monetization | 🔄 ~80% | Phase 13 |
| 15 | Self-Hosted LLM | 📋 ~5% | Phase 11 |
| 16 | Research Platform | 📋 Planned | Parallel with 13-15 |
| 17 | Enterprise & Vertical SaaS | 📋 Planned | Post-revenue |
| 18 | Cognitive Quality Improvements | 🔄 ~15% | Phase 11+ |
| 19-A | Event Bus & Schema Registry | 🔄 partial (publishes/subscribes) | Phase 10 |
| 19-B | DAG Scheduler | 📋 Post-revenue | Phase 19-A |
| 19-C | Event Bus Live (Publish) | 🔄 partial | Phase 19-B |
| 19-D | State Ownership Migration | 📋 Post-revenue | Phase 19-C |
| 19-E | Global Workspace Theory | 🔄 built early (agency pipeline) | Phase 19-D |
| 19-F | Active Inference | 📋 Post-revenue | Phase 19-E |

---

## Appendix D: Not Building (and Why)

Decisions to explicitly defer — not because they're unimportant, but to avoid scope creep
before the architecture and market signal are clear enough to justify them.

| Item | Reason deferred |
|---|---|
| On-device LLM | Out of scope until API latency is a user-visible problem with evidence |
| Will-to-Will belief sharing | Raises hard questions about belief contamination and goal conflict; defer until single-Will cognition is stable |
| User emotion detection from input | Privacy surface too large for MVP; revisit if companion use cases demand it |
| Hard memory deletion (GDPR) | Required before any EU deployment — track separately as a legal/infrastructure item, not a cognitive feature |
| Google OAuth | v1.1 |
| Teams / organisations / multi-user accounts | v1.1 |
| Paystack (African payment methods) | v1.1 |
| Self-hosted LLM infrastructure | After first revenue (Phase 15) |
| On-premise / enterprise deployment | Phase 17 |
| Self-fine-tuning / ParameterOptimizer | Phase 12 — after 50+ customers with real usage data |
| Multi-node distributed Will execution | Phase 9 multi-node staging — infrastructure exists, not yet plumbed |

---

*This roadmap is a living document. Each phase should be reviewed and
potentially revised upon completion of the previous phase, as discoveries
in earlier layers may affect the design assumptions of later ones.*
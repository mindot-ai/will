# REORIENT_TODO — Strategic / architectural reorientation (`will` codebase review)

> Higher-level direction changes from the 2026-05-29 review. These are not one-line fixes; each is a
> decision + a migration. Tactical bugs live in `FIX_TODO.md`. Items are ordered by leverage.

---

## Context: what `will` is
A 35K-LOC TypeScript "cognitive engine" — a generic deterministic simulation core (`src/core/`:
event bus, event log, snapshot, replay, double-buffer state, seeded PRNG, async optimistic-concurrency
engine) specialized by a cognitive layer (`src/cognition/`: ~36 faculty engines + senses + an LLM-backed
ExecutiveEngine), hosted by a `WillManager` runtime (`src/stem/`). The ambition and much of the
infrastructure are genuinely strong (see "Strengths"). The reorientations below are about making the
**guarantees the architecture advertises actually hold**, and about not maintaining more bespoke
infrastructure than the project can afford.

---

## R1. Resolve the Mastra/ai-sdk identity crisis (pick one lane)
**Current state is the worst of both worlds:** the package name, keywords, README, and `tsup.external`
all say "Mastra + ai-sdk", but `src` imports neither — the LLM layer is a hand-rolled `fetch` client that
supports 2 of ~6 advertised providers (FIX F5), with no retries-beyond-429, no timeouts, no base-URL,
no tool-calling, no streaming for non-Anthropic.
- **Option A (recommended): adopt the Vercel AI SDK** (`@ai-sdk/*`, already a declared dep) as the provider
  abstraction. You delete `_callAnthropic/_callOpenAI/_callDeepSeek/_callGoogle`, get OpenAI/Anthropic/Google/
  Groq/Ollama/Azure + base-URL + streaming + structured output + retries for free, and keep your `withGate`
  semaphore on top for global concurrency. This collapses the most fragile file in the repo.
- **Option B: commit to the in-house client** — then implement the missing providers + base-URL + timeouts
  properly, and strip every Mastra/ai-sdk mention from keywords, README, and `tsup.external`.
- Either way the determinism of *which model/params produced an output* should be logged into the event
  stream (feeds R2).

> **DECISION (2026-05-29): Option B — commit to the in-house client.** The LLM provider layer is core
> enough that we won't delegate it to an external dependency we can't control. Work to do: implement the
> missing providers (currently 2 of ~6, FIX F5) + per-request base-URL + timeouts + retries beyond 429,
> and strip every Mastra/ai-sdk mention from `package.json` keywords, the README, and `tsup.external`.
> Log model/params into the event stream (feeds R2) regardless.
>
> **DONE (2026-05-29):** Shipped in three PRs.
> - #40 — stripped Mastra/ai-sdk signals (keywords, `tsup.external`, README, src comments).
> - #41 — base-URL routing (fixes the `deepseek` mis-routing) + per-request timeouts.
> - #42 — implemented the Google/Gemini provider; removed the dead `_callDeepSeek` stub.
> All four declared providers (anthropic, openai, deepseek, google) are now functional. Completion
> recording into the event stream (`_recordCompletion`) was already wired — that's the R2 hook. Still
> open within Option B if desired: retries beyond 429, tool-calling, non-Anthropic streaming.

## R2. Make determinism a real, enforced invariant
Replay/snapshot is positioned as a differentiator, but it is currently unenforceable: 26 `Math.random()`
and 154 wall-clock reads sit in the deterministic layers (FIX F2), and the LLM itself is non-deterministic.
- Inject `context.prng` and the sim clock into every engine; **ban** `Math.random`/`Date.now`/`new Date` in
  `src/core` and `src/cognition` via a lint rule (no-restricted-syntax / no-restricted-globals).
- Treat the LLM as an external oracle: record every LLM input+output (and model/params) into the event log so
  replay can *re-feed recorded completions* instead of re-calling the model. Without this, "replay" can only
  ever mean "replay of the non-LLM engines".
- Add a **replay-equivalence test**: run N ticks twice with the same seed and recorded completions → assert
  byte-identical event logs / snapshots. This is the test that proves the core promise (today untested).

> **Progress** (sliced for incremental enforcement — one PR each). Enforcement is a dependency-free vitest
> source scan (`tests/unit/determinism.guard.test.ts`), not ESLint: the repo is Bun-only with no lint toolchain.
> - **R2-a** ✅ (#44) — ban `Math.random()` in `src/core`+`src/cognition`; genuine randomness → `context.prng`,
>   unique ids → monotonic counters.
> - **R2-b1** ✅ (#45) — deterministic sim clock (fixed-delta mode), entity/event timestamps from sim-time,
>   `wallClock()` boundary for telemetry, scan bans `Date.now`/`new Date` in `src/core` (per-pattern `dirs` scoping).
> - **R2-b2** ✅ (#46 → #48) — swept `src/cognition` wall-clock: entity ids → counters; ms-as-Tick fixes
>   (`detectedAt`/`startedAt` → real `state.tick`, incl. the recency-window unit-mismatch bug); domain timestamps → sim-time;
>   dropped the scan's `src/core`-only scoping so cognition is covered too. Full entity-map replay equivalence landed and passes.
> - **R2-c** ✅ (#49 → #50) — R2-c-1 (#49): deterministic event ids (per-bus monotonic counter), `determinism-ok` markers on
>   run-identity (`simulation.ts`) + cross-shard (`distributed.ts`) ids, scan now bans `randomUUID`. R2-c-2 (#50): LLM-as-oracle
>   re-feed — `LLMCompletionSource` + `RecordedCompletionSource` (tick-keyed, prompt-verified, throws on divergence); `LLMDirector`
>   returns recorded completions on replay instead of re-calling the model. Wiring a source from a replay file lands in R2-d.
> - **R2-d** ✅ (#51) — replay-equivalence harness (`tests/integration/replay.equivalence.test.ts`): standard-tier mind
>   (ExecutiveEngine, LLM in the loop) runs 50 deterministic-clock ticks recording every executive completion (Run A), then
>   a freshly assembled mind with the same seed re-feeds the transcript with the mock off (Run B) → asserts byte-identical
>   `tick`/`time`/metrics/entities. A `CountingSource` proves `consumed === recorded` so a silent re-feed miss can't pass.
>   Added optional `clock?: ClockConfig` passthrough to `assembleMind`/`WillConfig` (unset = wall-time default).
>
> **R2 complete** — determinism is now an enforced invariant (source scan bans `Math.random`/`Date.now`/`new Date`/`randomUUID`
> in `src/core`+`src/cognition`), the LLM is a record/replay oracle, and byte-identical replay is proven end-to-end with the LLM in the loop.

## R3. Fix the state model so the double-buffer guarantee actually holds
`snapshot()` is shallow (FIX F1), so "read-only snapshot" and "atomic double-buffer commit" are conventions,
not guarantees — one careless engine mutation corrupts determinism invisibly.
- Choose a real immutability strategy: (a) `Object.freeze` deep in dev + structural sharing, (b) an immutable
  library (Immer's `produce`, or Immutable.js) for entity maps, or (c) copy-on-write with per-entity version
  stamps. (a)+(c) also kills the per-tick O(n) double-copy cost (FIX F8). This is foundational — every higher
  guarantee (replay, snapshot rollback, conflict detection in `AsyncEngine`) inherits its correctness from here.

> **Progress.**
> - **R3-a** ✅ (#52) — chose strategy (a): deep-`Object.freeze` every entity at the single write boundary
>   (`StateManager.setEntity`, re-established on `restore`). Pairs with the existing per-entity copy-on-write
>   (setEntity already writes a fresh object and never mutates in place), so the shallow `snapshot()` Map copy is now
>   genuinely safe and stored snapshots can't drift — rollback/replay correctness inherits from this. A careless
>   mutation of a read entity now throws a loud `TypeError` instead of silently corrupting determinism. Gated by
>   `WILL_FREEZE_STATE` (default on except `NODE_ENV=production`). Cycle-safe `deepFreeze` util + `state.immutability`
>   test suite (frozen reads, commit-path freeze, point-in-time snapshot isolation, restore re-freeze, gate opt-out).
> - **R3-b** ✅ (#66) — the per-tick O(n) double Map-copy (FIX F8): replaced the eager `new Map()` clone in
>   `StateManager.snapshot()` with **copy-on-write**. `snapshot()` now hands out the live entity/metric maps by
>   reference and marks them shared (O(1)); the next mutating write (`setEntity`/`deleteEntity`/`setMetric`/
>   `incrementMetric`) clones the map once before writing, so each snapshot stays an isolated point-in-time
>   view. `restore()`/`clear()` replace the maps (never empty a shared one) and reset the flags. Behaviour is
>   identical to the eager copy — verified no caller mutates a snapshot's maps (per-tick consumers are
>   `ReadonlySimulationState`-typed) — but the per-tick cost drops from two full copies to a single clone on
>   the first write, and zero on an idle tick or read-only snapshot consumer (pause/archive/PMA-eval/livestream
>   are now O(1) unless a write follows). New `state.cow.test.ts` pins map sharing/clone timing + isolation
>   across set/delete/metric/restore/clear. **R3 complete (a + b).**

## R4. De-globalize runtime state for multi-tenancy, scale, and testability
Two process-global singletons gate the platform's future:
- `TokenTracker` (`token.tracker.ts:290` `let _tracker`) — **all** Wills' usage/cost aggregate into one global
  tracker. For a multi-Will platform this conflates billing/usage across tenants.
- `WillManager` (`stem/manager.ts:1702` `let _globalManager`) — one global manager per process.
- These singletons are also *why* `vitest.config.ts` must run `singleFork: true` ("engines are stateful — no
  parallel isolation"). The testability problem and the multi-tenancy problem are the same problem.
- Reorient: make the token tracker (and other ambient services) **per-Will instances** carried on
  `SimulationContext` and injected, not fetched via `getTokenTracker()`. This unlocks per-tenant accounting,
  horizontal scale (N Wills per process, or 1 per worker), and parallel tests. Aligns with the cloud
  deployment roadmap noted in the workspace.

> - **R4-a** ✅ (#53) — de-globalized `TokenTracker`: removed the process-global `_tracker` + `getTokenTracker`/
>   `setTokenTracker` accessors. A fresh tracker is now created per Will in `assembleMind`, registered as an engine,
>   and injected into the executive's `LLMDirector` via `attachTokenTracker()`; the director records usage into the
>   injected instance (null → skipped, as on mock/replay runs) instead of fetching a global. Per-tenant accounting
>   now holds and parallel tests can't clobber each other's tracker. Isolation test
>   (`tests/integration/token.tracker.isolation.test.ts`) proves two minds own distinct trackers and that recording
>   on one leaves the other untouched.
> - **R4-b** ✅ (#54) — removed the `WillStem` process-global singleton (`_globalManager` + `getWillStem()`, actually in
>   `stem/index.ts`, not `manager.ts`). `WillStem` is already directly instantiable; the only caller was the dev runner,
>   now `new WillStem()`. Dropped `getWillStem` from the public barrel (no consumers in `will`/`backend`/`studio`/`scripts`).
>   Investigation correction: the `vitest.config.ts` `singleFork: true` was a vitest 2/3 `poolOptions.forks` key and a
>   **no-op under vitest 4** — the suite had been running with file parallelism (the v4 default) and passing all along.
>   Replaced it with an explicit `fileParallelism: true` + accurate comment. After R4 (a+b) `src` has **no module-level
>   mutable singletons** left; parallel files are safe (per-Will/per-instance state, process-isolated files, no
>   `.concurrent` tests). The keyed `_sinks`/`_sources` registries in `core/completion.recorder.ts` (R2-c replay seam)
>   remain module-level but are per-id and process-isolated per file, so they don't impede parallelism.
>
> **R4 complete (a + b).**

## R5. Decompose the god-objects
- `WillManager` is ~1,716 LOC / ~144 members in one class. Split along seams: lifecycle (spawn/pause/archive),
  messaging/outbox, effector invocation/ack, persistence/snapshotting, query/status.
- The `executive.engine/` cluster (engine + prompt.factory + facet + parser + gating + context + commands +
  messages ≈ 3K+ LOC) is the other heavyweight — worth a dedicated boundary review once R1 lands (the
  provider swap will simplify it).
- Goal: no single file is the place every change has to touch; each faculty engine stays independently testable.

> **STRATEGY (2026-05-31): extract-collaborator, sliced.** `WillManager` is `WillStem` in `stem/index.ts` (~1,725 LOC,
> ~50 public methods). Decompose by pulling cohesive method-sets + their owned fields into focused collaborator classes
> that `WillStem` composes and delegates to. The heavy collaborators (`PMADistiller`, `ReplayManager`, `PMAEvalHarness`,
> …) are already separate classes — `WillStem` only orchestrates them per-Will, so the split is mostly mechanical.
> Backend (`will.service.ts`) consumes the public API, but per owner decision it will be adapted later; for now each
> slice keeps the `WillStem` public surface stable so the suite stays green. Proposed slices (one PR each):
> - **R5-a** ✅ (#55) — `ReplayController` (`stem/replay.controller.ts`): record/replay subsystem (`_replayManager`,
>   `_activeRecorders`, `_completedReplays`, `_replayPaths` + start/stop/getMeta/list/compare). index.ts −115 LOC.
> - **R5-b** ✅ (#56) — `PMAController` (`stem/pma.controller.ts`): PMA subsystem (`_distiller`/`_loader`/`_evalHarness`
>   + `loadPMA`/`distillPMA`/`runPMAEval`). index.ts −49 LOC.
> - **R5-c** ✅ (#57) — `OutboxController` (`stem/outbox.controller.ts`): messaging/outbox (`drain`/`peek`/`requeue`/
>   `confirmDelivery` + `expireStale` TTL cleanup; owns `OUTBOX_TTL_TICKS`, re-exported from index). index.ts −100 LOC.
> - **R5-d** ✅ (#58) — `EffectorController` (`stem/effector.controller.ts`): external effectors (`setAllowed`/
>   `confirmExecution`/`drain` + `bufferInvocation` for `effector.invoked` events). index.ts −82 LOC.
> - **R5-e** ✅ (#59) — `SensoryController` (`stem/sensory.controller.ts`): senses I/O boundary — input ingestion
>   (`ingestText`/`ingestSensory`/`injectEvent`) + chunk streaming (`add*ChunkListener` + `sync*` helpers). index.ts −82 LOC.
> - **R5-f** ✅ (#60) — `BiographyWriter` (`stem/biography.writer.ts`): session-biography disk writers
>   (`writeSessionSummary` → behavioral.jsonl; `writeEmotionalEvent` / `writeEmotionalBiographySummary` →
>   emotional_biography.jsonl). node:fs/node:path leave index.ts. index.ts −178 LOC.
> - **R5-f2** ✅ (#61) — `HealthReporter` (`stem/health.reporter.ts`): pure read-only composite health view
>   `getCognitiveHealth` (belief quality + affect + goal state → `overallScore` + status band). index.ts −72 LOC.
>   Trivial one-line getters (`getWillState`/`getWillCognition`/…) stay on the WillStem facade.
> - **R5-g** ✅ — executive.engine cluster boundary review (the other ~3K-LOC heavyweight). **Scoping result:**
>   the engine is *already* decomposed into 11 cohesive modules (config/messages/gating/types/parser/commands/
>   context/facet/prompt.factory + the `engine.ts` orchestrator); sibling boundaries are clean. `engine.ts`
>   (~1000 LOC) is a genuine AsyncEngine orchestrator, not a god-object — its core lifecycle (`shouldAct`/
>   `readState`/`reasonAsync`/`onIntermediate`/`onReasoningComplete`/`react`) is irreducible. Per owner decision
>   we took the **safe wins** and will reassess before further extraction:
>   - **R5-g-0** ✅ (#62) — dedup the 5 gating/interval constants (prompt.factory.ts re-defined what config.ts
>     owns; nobody imported them from there) + drop unused config imports in engine.ts/gating.ts. config.ts is
>     the single source of truth. Zero behaviour change.
>   - **R5-g-1** ✅ (#63) — `DeferredEffectQueue` (`executive.engine/deferred.effects.ts`): the commit-gated
>     manager-write queue (FN11) — `enqueue`/`markReactTick`/`flush`. Pure, no engine-state coupling. engine.ts −61 LOC.
>   - **R5-g-2** ✅ (#67) — `EscalationBuffer` (`executive.engine/escalation.buffer.ts`): the pending
>     audition→executive escalation buffer — `push` (in the `audition.task.signal` handler) +
>     `drainToPercepts()` (in `onReasoningComplete`, builds the high-salience percept entities and captures the
>     first-requester context). Pure collaborator; the salience-spike that wakes the master stays in engine.ts
>     (gating state, not buffer). Public surface unchanged, behaviour identical. engine.ts −31 LOC net.
>   - **R5-g-3** ✅ (#68) — `FacetSupervisor` (`executive.engine/facet.supervisor.ts`): facet lifecycle +
>     attention budget — the facet registry, monotonic id counter, free-capacity tracking, `spawn()` (with its
>     bus/director/state-ref throw-checks), the per-tick state-ref fan-out, and the spawn/destroy session
>     logging. `spawnFacet()` delegates with an unchanged signature/return. The supervisor tracks
>     `_lastStateRef`/`_sessionLogger` so a facet's deferred `destroy()` logs the same live values the engine
>     would. Left in engine.ts by design: the `executive.facet.sync`/`audition.task.signal` subscriptions +
>     `_facetSyncSubscribed` (feed the gating salience buffer, shared with the escalation path) and the
>     `executive.master.sync` publish (reads master reasoning; gated on `supervisor.size`). Behaviour identical.
>     engine.ts −96 LOC net. **R5-g complete** — engine.ts is now a lean AsyncEngine orchestrator delegating to
>     deferred.effects / escalation.buffer / facet.supervisor + the existing config/messages/gating/parser/
>     commands/context/facet/prompt.factory modules.
> Lifecycle (create/pause/resume/archive/tick-loop) + the `_wills` registry stay as `WillStem`'s core.
> - **R5-tracts** ✅ (#74) — cluster the eight extracted collaborators (`replay`/`pma`/`outbox`/`effector`/
>   `sensory` controllers + `biography.writer` / `health.reporter` / `session.logger`) out of the flat
>   `src/stem/` root into a dedicated **`src/stem/tracts/`** directory, so `stem/` separates the orchestration
>   facade (`index` / `mind` / `runner` / `distribution`) from the delegated subsystems it composes. Pure
>   file move + import rewrite, zero behaviour change: `index.ts` + 11 consumers repointed to `#stem/tracts/*`,
>   `pma.controller`'s relative `../pma` re-based to `../../pma`, `OUTBOX_TTL_TICKS` re-export repointed; git
>   tracks all eight as renames (88–100% similarity).

## R6. Re-evaluate the hand-rolled HNSW vector index
`src/memory/vector.index.ts` implements HNSW (`HNSWIndex`) by hand; the `hnsw` package in `tsup.external` is
neither installed nor imported, and `@mastra/libsql`/`@mastra/pg` (installed) are unused. A bespoke ANN index
is a deep correctness liability (graph construction, layer assignment, recall, deletion, persistence are all
subtle, and the layer RNG is unseeded → non-reproducible).
- Decide: either depend on a vetted store (pgvector via the already-installed `@mastra/pg`, libsql, or a
  maintained hnsw lib) **or** elevate the in-house HNSW to a first-class component with a recall/correctness
  test suite, seeded RNG, and documented persistence format. Don't leave it as untested critical-path code.

> **DONE (2026-05-31):** Decision — **keep the in-house HNSW** and treat it as a first-class component; do
> NOT migrate to a vetted store. Re-assessment found the headline concerns already addressed: the layer RNG
> is seeded (Mulberry32, wired to the run seed in `mind.ts` as the single source of truth, persisted across
> serialize/deserialize, reset on `clear()` for byte-identical rebuild); recall/correctness/persistence are
> covered by three test files (`hnsw.search`, `hnsw.determinism`, `hnsw.pruning`); and the "unused deps"
> premise is stale — `@mastra/*`/`hnsw` are not in `package.json` (only `@aws-sdk/client-s3` + `vitest`). The
> pgvector seam stays pluggable via `config.vectorMemoryAdapter` in `mind.ts` for the backend. Two latent
> bugs found and fixed instead of a rewrite:
> - **R6-a** ✅ (#64) — `DefaultVectorMemoryAdapter._evictOldest` was a no-op (only flipped the dirty flag),
>   so the `indexBatch` eviction loop could spin forever once the index reached `maxIndexedEpisodes`.
>   Implemented real oldest-first eviction (drop earliest-inserted ~10%-of-cap, ≥1, per call) + a `size > 0`
>   loop guard; added `tests/unit/vector.adapter.eviction.test.ts` (bounded size, oldest-first, termination).
> - **R6-b** ✅ (#65) — removed dead metadata-filter plumbing: `sourceTypes/minValence/maxValence/tags/`
>   `tickRange` were declared on `VectorQueryFilter` and threaded through `searchWithVector`/`semanticQuery`
>   but silently ignored (HNSW is similarity-only; no caller populated them). Trimmed the type, the
>   forwarding, and the `semanticQuery` signature; narrowed `VectorIndex.search` to `{ minSimilarity? }`;
>   documented the similarity-only contract (callers post-filter on the returned episodes' metadata).

## R7. Build a test strategy around the invariants, not the leaves
~112 test cases (7 files) concentrate on senses and the cognition bus; the load-bearing infra — orchestrator
tick loop, state manager, event bus, replay, snapshot manager, `AsyncEngine` conflict detection, the HNSW
index, and the LLM director (which already has a `_mock` mode, so it's trivially testable) — has **no direct
tests**. Prioritize: (1) replay-equivalence (R2), (2) state immutability/commit (R3), (3) tick-loop
ordering/re-entrancy (FIX F3), (4) HNSW recall (R6), (5) gate concurrency/retry (FIX F6/F7). Fixing R4 removes
the `singleFork` constraint so these can run in parallel.

> **Progress** (sliced — one invariant cluster per PR). Several priorities already gained coverage during
> earlier work: replay-equivalence (#1) via R2-d (`replay.equivalence.test.ts`); state immutability/commit (#2)
> via R3-a freeze + R3-b `state.cow.test.ts`; HNSW recall (#4) via the pre-existing `hnsw.search`/
> `hnsw.determinism`/`hnsw.pruning` suites + R6-a `vector.adapter.eviction.test.ts`.
> - **R7-gate** ✅ (#69) — gate concurrency/retry (#5, FIX F6/F7): first direct tests for `src/llm/gate.ts`
>   (`tests/unit/llm.gate.test.ts`, 11 cases) — `LLMSemaphore` cap + FIFO wake + idempotent release;
>   `isRateLimitError` 429-shape matching; `withGate` success / non-429 passthrough / retry-then-succeed /
>   give-up-after-budget (fake timers). Exported `LLMSemaphore` for testability (no runtime change). Found:
>   the gate **holds** its slot during 429 backoff (doc says it releases — `release()` is in `finally`, after
>   the in-catch backoff await); flagged for a separate behaviour decision.
> - **R7-gate-fix** ✅ (#75) — resolved that flag: moved the warn-log + backoff `await setTimeout` *out* of the
>   `try/finally` so the slot is freed before the wait. On a retryable 429 the catch only records `retryDelay`,
>   `finally` releases, then the post-block code logs + sleeps before looping to re-acquire — so a throttled
>   call no longer pins a concurrency slot while it sleeps (default cap is 2; two sleeping calls used to starve
>   every other engine). `withGate` gained an optional `gate` arg (defaults to the `llmGate` singleton) to pin
>   the no-starvation contract against an isolated single-slot semaphore. 12th gate test added.
> - **R7-tickloop** ✅ (#70, #71) — tick-loop ordering / re-entrancy (#3, FIX F3), split in two:
>   - **PR A** (#70) `tests/unit/async.engine.test.ts` (8 cases) — `AsyncEngine` cross-tick lifecycle via a
>     controllable subclass: non-blocking react + `pending_depth` metric, single in-flight gating, clean
>     cross-tick completion, conflict+FORCE (commit anyway), conflict+REJECT (drop + rerun, plus the
>     `rerunOnRejection: false` silent-drop path), stale prune past `maxPendingTicks`, reasonAsync rejection
>     (swallowed, nothing committed). Conflict *detection* itself stays in `conflict.detector.test.ts`.
>   - **PR B** (#71) `tests/unit/orchestrator.tick.test.ts` (10 cases) — `DefaultOrchestrator._executeTick`
>     on a deterministic `fixedDeltaMs`/`startTime: 0` clock: clock advance + state-manager sync,
>     registration-order engine runs, double-buffer snapshot isolation (no engine sees a same-tick write until
>     the next tick), atomic entity+metric apply, `onBeforeCommit` abort vs pass, `onError` isolation
>     (fallback collected; throw-without-`onError` logged and tick continues), before/after-tick snapshot
>     phases, post-commit event publish with tick stamp.
> - **R7-eventbus** ✅ (#72) — `tests/unit/event.bus.test.ts` (9 cases) — `DefaultEventBus` dispatch contract:
>   publish queues then flush stamps (deterministic monotonic `evt-<n>` ids + injected `now`) and dispatches;
>   type / filtered / catch-all handler tiers + unsubscribe; `scheduleAt`/`prepareTick` release future events in
>   ascending tick order; flush cascade (handler publishing mid-flush, no re-entrant double-processing); `clear()`;
>   `maxQueueSize` overflow throw; `publishAsync` inline flush.
> - **R7-snapshot** ✅ (#73) — `tests/unit/snapshot.manager.test.ts` (7 cases) — `SnapshotManager` query/restore/
>   persist via an in-memory `StorageAdapter` stub: `snapshotInterval` gating, `getSnapshot`/`getLatestSnapshot`/
>   `snapshotCount` query API, `restoreState` round-trip (entities + metrics + clock), ring-buffer oldest-first
>   eviction past `maxInMemorySnapshots`, the `onSnapshot` replay-feed callback, and `persistNow`/
>   `loadLatestFromStorage` round-trip (with `persistInterval: 0` disabling both). Delta-baseline logic stays in
>   `snapshot.delta.test.ts` (FN13).
>
> **R7 complete** — orchestrator tick loop, state immutability/commit, event bus, replay, snapshot manager,
> `AsyncEngine` conflict detection, HNSW recall, and the LLM gate all now have direct coverage.

## R8. Pin the target runtime contract
The project is Bun-first for dev/start (`bun --env-file`, `@types/bun`) but ships an ESM library via `tsup`
for (presumably) Node consumers, with no `engines` field and Node-version assumptions left implicit. Decide
the supported runtime(s), add an `engines` field, and document it. Raw global `fetch`/`AbortController` are
fine on Node ≥18 and Bun — just state it.

> **DECISION (2026-05-29): Bun only.** Stick fully to Bun as the supported runtime contract. Pin it via
> `packageManager`/`engines` (Bun) + document it; the shipped tsup ESM build stays, but Bun is the stated
> target for dev/test/start. Global `fetch`/`AbortController` are guaranteed present, so no polyfills.
>
> **DONE (2026-05-29, #40):** Added `packageManager: "bun@1.3.9"` and `engines.bun` to `package.json`.

---

## Strengths worth preserving (don't reorient these away)
- **`AsyncEngine` optimistic-concurrency model** (`core/async.engine.ts`): offloading slow reasoning to
  background promises, then re-validating completed work against current state via a `ReasoningFootprint`
  (entities/metrics read) is a genuinely elegant way to keep the tick non-blocking. Keep it; just make the
  footprint comparison rest on real immutability (R3).
- **Two-phase bus** (transient `core/event.bus` + `cognition/bus` cognitive layer, with `_onAfterPhase1`
  sequencing) is a clean separation.
- **Seeded PRNG + event-log + snapshot + replay scaffolding** already exist — R2/R3 are about *enforcing* what's
  already designed, not building from scratch.
- **Env-driven config, mock LLM mode, token/cost tracking, tiered engine activation** (basic/standard/full) are
  good product-shaped decisions.

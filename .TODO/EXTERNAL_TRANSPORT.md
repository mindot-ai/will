# Will — External Transport + Conversation Memory + Facet Concurrency

> **Standing:** SHIPPED · 2026-08-25 · 73 of 73, opened 2026-06-02 — socket.io as the primary bidirectional channel, conversation through the canonical memory pipeline, per-facet serialization

> Reorientation of the conversation/communication pipeline.
> Three converging changes: (1) a unified bidirectional `ExternalTransport`
> (socket.io) replacing tick-drained SSE delivery; (2) conversation persisted
> through the canonical working-memory → consolidator → vector pipeline;
> (3) per-facet concurrency serialization.
>
> Scope: `will/` package only. `backend/` hosts the socket.io *server* and is
> out of scope here — we only build Will's *client* side and keep the existing
> HTTP/outbox paths working as fallback until the backend migrates.
>
> See `TODO.md` (Phase 13.8 senses) for the layer this builds on.

---

## Legend

- `[ ]` Not started   `[~]` In progress   `[x]` Complete   `[!]` Blocked

## Status (2026-06-02)

- ✅ **Section 0.1/0.2** — transport seam: `Envelope` union + `ExternalTransport` interface + `LoopbackTransport` fake. (`src/stem/tracts/transport/`)
- ✅ **Section 1.1** — `InboundQueue` (tick-stamped marshaling buffer). (`src/stem/tracts/inbound.queue.ts`)
- ✅ **Section 5** — conversation → `working_memory.item` (`conversation.exchange`) → consolidator → vector, + vector recall injected into facet focus. Wired in `mind.ts`.
- ✅ **Section 6** — per-entity turn serialization in `AuditionEngine` (Tier 2).
- ✅ **Section 0.3** — `SocketIoTransport` over `socket.io-client` (optional dep, lazy indirected import; injectable `socketFactory`).
- ✅ **Section 0.4 + 1.2** — `transport` + `InboundQueue` on `WillInstance`; `TransportController` drains/applies inbound at tick start (messages fire-and-forget; result-acks → `confirmExecution` before `step()`).
- ✅ **Section 2 (2.1/2.2/2.3/2.4)** — outbound complete: reply + chunk fast-paths, generic outbox bridge (`emitOutbox`), effector-invocation bridge. Shared monotonic per-Will seq.
- ✅ **Section 3** — `AckReconciler`: dual-path (emit-callback + discrete-event) acks deduped by correlationId, applied once on-tick. Result-ack → `confirmExecution`; delivery-ack → `confirmDelivery`. Emit-callback acks marshaled onto the InboundQueue (same path as discrete events).
- ✅ **Section 1.3** — replay recording: inbound batch captured per tick via a dedicated `inbound.recorder` seam (mirrors completions); recorded into the active `DefaultReplayRecorder`. (Re-injection rides with deferred deterministic re-execution.)
- ✅ **Section 2.5** — activity projection: `'*'` wildcard `addActivityListener` → `activity` envelopes.
- ✅ **Reconnect** — transport-layer pending-emit buffer: un-acked messages/invocations re-emitted on `onStatus('connected')`; cleared when their ack reconciles. Reply/chunk stay ephemeral.
- ✅ **Section 4** — *already satisfied*: external effectors flow `effector.invoked` → `pendingEffectorInvocations` → `emitInvocations` → transport, with result-acks → `confirmExecution` (Section 3). No executor change needed.
- ✅ **Tests** — foundation (11), audition.concurrency (3), audition.memory (8), audition.chunk (4), transport.controller (26), transport.socketio (8), ack.reconciler (5), communication.deliver-reply (4), replay.recorder inbound (+2). Full suite: **437 pass / 1 skip**.
- ✅ **Replay re-feed (1.3 closed)** — `RecordedInboundSource` + `applyInbound` re-feed; capstone equivalence test proves byte-identical re-injection. The transport's determinism leg now matches the LLM's (R2-d analog).
- 🎉 **Reorientation fully complete.** Deterministic re-execution now covers time, randomness, the LLM, **and** the transport.

### Closeout (2026-06-10) — remaining stretch + test gaps swept

- ✅ **§5.3** — explicit char budget + omitted-counter on the recall block (`_buildMemoriesSection`).
- ✅ **§5.4** — cold-spawn thread-digest hydration from recall (`attachMemoryRecall` + `ThreadDigestManager.hydrate`).
- ✅ **§6** — rapid-fire message coalescing per entity (`CoalesceWindow`). *Behavior change:* a burst is answered once, not N times.
- ✅ **§7.2 integration** — `transport.reply.out` (message in → reply out, off-tick) + `conversation.consolidation` (exchange → episodic + embedded).
- ✅ **Full suite: 582 pass / 1 skip** (was 437 at the 06-02 status; the package grew in between). Typecheck clean (one pre-existing `@vitest/expect` lib clash, unrelated).

---

## Determinism guardrails (cross-cutting — read first)

This package is replay-deterministic (`logicalTime` clock, replay recorder,
determinism-guard tests, `R2` wall-clock-is-telemetry annotations). Every task
below MUST honor:

1. **`socket.io-client` is never imported under `src/cognition/`.** The transport
   lives only in `src/stem/tracts/`. Engines stay transport-agnostic and talk to
   it through injected callbacks / an interface — exactly like `attachChunkCallback`.
2. **Outbound = side effect at the edge.** Emitting an envelope must never mutate
   simulation state.
3. **All inbound crosses one tick-stamped queue.** Messages, percepts, and
   result-acks land in `InboundQueue` and are applied at a fixed point in the
   tick with a `logicalTime` stamp — never applied immediately off-socket.
4. **Every test uses `LoopbackTransport`** (in-memory). No test opens a socket.
5. **On-tick vs off-tick boundary is explicit.** The ONLY replay-recorded,
   on-tick step is inbound *application* (queue drain → percept/ack). Everything
   downstream runs **off-tick** and is reconstructed from the recorded inputs,
   never replayed directly: facet reasoning (LLM calls), chunk streaming, the
   reply emit, and the `conversation.exchange` memory-sink `setEntity` writes.
   Off-tick writes stay R2-safe because state carries no wall-clock — `setEntity`
   stamps createdAt/tick from the sim clock; any `wallClock()` is telemetry-only
   (ids, session logs). See the `AuditionEngine` class header for the per-engine
   statement of this invariant.

---

## Section 0: Transport seam (foundation)

**Location**: `src/stem/tracts/transport/`

### 0.1 Envelope types + `ExternalTransport` interface ✅
**File**: `src/stem/tracts/transport/types.ts`

- [x] `Envelope` discriminated union (`channel` discriminator):
  - `message`   — inbound/outbound conversational text (entityId, threadId, content)
  - `chunk`     — outbound LLM token (entityId, threadId, content) — fast path
  - `reply`     — outbound assembled reply bubbles (entityId, threadId, bubbles[])
  - `effector_invocation` — outbound external effector call (mirror `EffectorInvocation`)
  - `percept`   — outbound `senses.*.percept` projection (optional, for observability)
  - `activity`  — outbound plan/activity event
  - `ack`       — inbound delivery-ack | result-ack (correlationId, kind, payload?)
- [x] Every outbound envelope carries `correlationId` + `willId` + `seq`.
- [x] `ExternalTransport` interface:
  ```ts
  interface ExternalTransport {
    readonly connected: boolean
    emit( env: OutboundEnvelope, opts?: { ackTimeoutMs?: number } ): Promise<AckResult>
    onInbound( handler: ( env: InboundEnvelope ) => void ): () => void
    onStatus( handler: ( s: 'connected' | 'disconnected' | 'reconnecting') => void ): () => void
    close(): void
  }
  ```
- [x] `AckResult = { acked: boolean; via: 'callback' | 'event' | 'timeout'; payload?: unknown }`

### 0.2 `LoopbackTransport` (deterministic fake) ✅
**File**: `src/stem/tracts/transport/loopback.transport.ts`

- [x] In-memory impl: `emit()` records to a `sent[]` log and resolves ack per a
  scripted policy; `injectInbound()` test helper pushes an inbound envelope.
- [x] Synchronous, no timers — deterministic. Mirrors `InProcessCognitiveTransport`.
- [x] Used by every transport/ingest/ack test.

### 0.3 `SocketIoTransport` (production impl) ✅
**File**: `src/stem/tracts/transport/socketio.transport.ts`

- [x] Wraps `socket.io-client` via an **indirected lazy dynamic import** so the core
  builds/tests without it; declared in `optionalDependencies`.
- [x] Connects to `url` with `auth: { willId, token }` (overridable via `socketFactory`).
- [x] `emit()` uses the socket.io ack callback with `ackTimeoutMs` (default 5000);
  timeout/disconnect → `{ acked: false, via: 'timeout' }` so the caller keeps it buffered.
- [x] Inbound: `socket.on('envelope', …)` + discrete `message.delivered` /
  `effector.invoked.ack` → synthesized `ack` envelopes (Section 2 dual-path).
- [x] Status surfaced via `onStatus` (connect/disconnect/reconnect_attempt).

### 0.4 Wire into `WillInstance` + config ✅
**Files**: `src/stem/index.ts`, `mind.ts` (`WillConfig`), `transport.controller.ts`

- [x] `WillInstance.transport: ExternalTransport | null` + `inbound: InboundQueue` + `_transportUnsub`.
- [x] `WillConfig.transport?: ExternalTransport` — the **caller** injects a pre-built
  transport (so `will` core never imports `socket.io-client`). `null` keeps the legacy outbox/SSE path.
- [x] `TransportController.attach()` wires `onInbound → inbound.enqueue`; `detach()` on archive.

---

## Section 1: Inbound marshaling (determinism linchpin)

**Location**: `src/stem/tracts/inbound.queue.ts`

### 1.1 `InboundQueue` ✅
- [x] `InboundQueue` class — FIFO of `InboundEnvelope`, tick-stamped `drain(tick)`.
- [x] `transport.onInbound(env => instance.inbound.enqueue(env))` wired at boot via `TransportController.attach()`.

### 1.2 Tick-loop drain + apply ✅
**File**: `src/stem/index.ts` (tick loop, before `simulation.step`), `transport.controller.ts`

- [x] At tick start, `TransportController.applyInbound(instance, tickCount, deps)` drains the queue and dispatches:
  - `inbound_message` → `auditionEngine.ingest(...)` (fire-and-forget; tick not blocked)
  - `ack` (result) → `effector.confirmExecution(invocationId, result)` (synchronous, before `step()`)
  - `ack` (delivery) → `outbox.confirmDelivery(id, delivered)`
  - `inbound_percept` → `sensory.injectEvent({ type: 'senses.<domain>', payload })`
- [x] Result-acks mutate state synchronously before `step()`; a bad envelope can't abort the batch.

### 1.3 Replay integration ✅
**Files**: `core/inbound.recorder.ts` (new), `core/replay.ts`, `replay.controller.ts`, `transport.controller.ts`

- [x] New `inbound.recorder` seam (mirrors `completion.recorder`): `InboundRecord`,
  `InboundSink`, `set/get/clearInboundRecorder` + `InboundSource` / `RecordedInboundSource` / `set/get/clearInboundSource`.
- [x] `DefaultReplayRecorder.recordInbound()` — stored, flushed/saved alongside records +
  completions, counted in `metadata.totalInbound`.
- [x] `ReplayController.start/stop` registers/clears the inbound recorder; `applyInbound`
  records the drained batch (tick-stamped) when a recorder is active.
- [x] **Re-feed:** `applyInbound` pulls from `getInboundSource(willId).envelopesAt(tick)`
  when a source is registered (replay), draining the live queue otherwise — the transport
  analog of the LLM completion re-feed. A source run does not re-record.
- [x] **Capstone test** (`tests/integration/transport.replay.equivalence.test.ts`, R2-d analog):
  record a run (messages + result-ack across ticks) → re-feed with no live socket →
  byte-identical dispatch sequence.

---

## Section 2: Outbound unification

### 2.1 Reply fast-path (Tier 1 seam → transport) ✅
**Files**: `audition.engine.ts`, `transport.controller.ts`

- [x] `AuditionEngine` gains `attachReplyCallback`; `_onFacetDecision` fires it with
  the bubbles the instant the facet decides — off-tick, gated on the `talk` effector.
- [x] `TransportController.attach()` bridges the reply callback → `transport.emit({channel:'reply'})`.
  `deliverReply()` still pushes to `outbox` as the disconnect buffer / legacy `/events` fallback.

### 2.2 Chunk fast-path → transport ✅
**Files**: `audition.engine.ts`, `sensory.controller.ts`, `transport.controller.ts`

- [x] AuditionEngine chunk callback is now **multi-subscriber** (`addChunkCallback` →
  `Set`, returns unsubscribe; handlers get `(entityId, threadId, chunk)`). `_emitChunk`
  fans the filtered `[REPLY_TEXT]` stream to all, resolving the current threadId per entity.
- [x] `SensoryController` registers its SSE fan-out once per instance via `addChunkCallback`
  (reads the live listener map; coexists with the transport subscriber).
- [x] `TransportController.attach()` adds a chunk subscriber → `transport.emit({channel:'chunk'})`;
  unsub tracked + released on detach.

### 2.3 Outbox bridge (generic messages) ✅
**Files**: `transport.controller.ts` (`emitOutbox`) + tick loop, `communication.executor.ts`, `audition.engine.ts`

- [x] Tick loop calls `emitOutbox()` after the outbox is spliced — one `message`
  envelope per outbox message, `correlationId = message.id`; delivery-acks → `confirmDelivery`.
- [x] No double-emit with the reply fast-path: `deliverReply({ pushToOutbox: false })` when a
  transport reply callback is attached — the exchange is still recorded, but no outbox copy is
  created, so `emitOutbox` carries only master/action messages (talk/broadcast/gesture).

### 2.4 Effector-invocation bridge ✅
**File**: `transport.controller.ts` (`emitInvocations`) + tick loop

- [x] Tick loop calls `TransportController.emitInvocations()` after
  `pendingEffectorInvocations` is spliced — one `effector_invocation` envelope each,
  `correlationId = intentId`. Result-acks route back via inbound → `confirmExecution`.

### 2.5 Activity projection (observability) ✅
**Files**: `planning.engine.ts` (`'*'` wildcard), `transport.controller.ts`

- [x] `PlanningEngine.addActivityListener('*', …)` — wildcard skips the per-entity filter.
- [x] `TransportController.attach()` subscribes with `'*'` and emits `activity` envelopes
  (`eventType` + payload), reconcile 'none' (fire-and-forget). Unsub released on detach.

---

## Section 3: Acks (dual path, idempotent) ✅

**Location**: `src/stem/tracts/ack.reconciler.ts`, `transport.controller.ts`

### 3.1 Correlation ids ✅
- [x] Every outbound envelope carries `correlationId` (outbox message id / invocation intentId).

### 3.2 Emit-callback path (fast, best-effort) ✅
- [x] `transport.emit()` ack → `_emit()` marshals it onto the `InboundQueue` as an `ack` envelope.

### 3.3 Discrete-event path (durable) ✅
- [x] Inbound `ack` envelopes (`message.delivered`, `effector.invoked.ack`, synthesized in
  `SocketIoTransport`) arrive via `onInbound` → `InboundQueue`.

### 3.4 Idempotent reconciliation, classified ✅
- [x] `AckReconciler` keyed by `correlationId` (bounded FIFO); first ack wins, rest no-op.
- [x] Applied on-tick in `TransportController._dispatch`: **result-ack** → `confirmExecution()`,
  **delivery-ack** → `confirmDelivery()`.
- [x] Both paths unified through the `InboundQueue`: discrete ack events arrive via
  `onInbound`; emit-callback acks are marshaled onto the queue by `_emit()`. The
  reconciler dedups across them.

### 3.5 Timeout / reconnect ✅
- [x] Emit-callback timeout (`acked:false`) → no ack marshaled.
- [x] Transport-layer pending-emit buffer (`_pending`, per Will): un-acked messages/invocations
  re-emitted on `onStatus('connected')` (`_reemitPending`); cleared when their ack reconciles.
  Reply/chunk/activity are ephemeral ('none') and not buffered.

---

## Section 4: action.executor & components tap transport ✅ (already satisfied)

No code change needed — the existing buffer→bridge path already routes external effectors over the transport:

- [x] `ActionExecutor` external effectors publish `effector.invoked` → `EffectorController.bufferInvocation`
  → `pendingEffectorInvocations` → `TransportController.emitInvocations()` on tick → transport (2.4).
- [x] `ProactiveCommunicator` outbox path bridged in 2.3 (`emitOutbox`); facet replies via the 2.1 fast-path.
- [x] `confirmExecution()` reached from transport result-acks via Section 3 — no signature change.
- [x] Innate/world executors still run in-process — only *external* effectors emit `effector.invoked`.

---

## Section 5: Conversation → working memory → consolidator → vector (proposal 2) ✅

**Files**: `audition.engine.ts`, `mind.ts`

Implemented via **state-entity injection**, not a direct `WorkingMemory.load()`: each
exchange becomes a `working_memory.item` entity (`wmType: 'conversation.exchange'`),
which `EpisodicConsolidator._findCandidates()` already scans on its tick — the same
deterministic path the legacy master reply used (`communication.executor.ts:330`). No
new memory plumbing; conversation salience flows in as the item's `activation`.

### 5.1 Inbound turn captured ✅
- [x] `_processMessage` records inbound text per entity (`_inflightInbound`) to pair with the reply.

### 5.2 Exchange → working_memory.item ✅
- [x] `_onFacetDecision` → `_persistExchangeMemory()` injects a `working_memory.item`
  (`wmType: 'conversation.exchange'`, `activation` from confidence, `tags:['conversation','exchange','entity:<id>']`,
  `summary: '<entity>: "inbound" → "reply"'`) via the injected memory sink. Runs even if the reply is channel-gated.
- [x] No wall-clock timestamp supplied — `setEntity` stamps createdAt/tick from the sim clock.

### 5.3 Retrieval injection (long-term awareness across restart) ✅
- [x] `_retrieveMemories()` → `EpisodicConsolidator.semanticQuery(content, { limit: 3 })`
  (resolves episodeId→content via `_storeMap`) → injected into the facet focus as a
  `## Relevant memories (recalled)` block. Best-effort: recall failure is non-fatal.
- [x] (Stretch) explicit char budget + omitted-counter on the "## Relevant Memories"
  block (deterministic recall order preserved). `prompt.factory.ts:_buildMemoriesSection`
  (RECALL_CHAR_BUDGET); tests `tests/unit/recall.budget.test.ts`.

### 5.4 Digest = derived recent-view ✅
- [x] `ThreadDigestManager` retained as cheap recent-context; long-term awareness now via 5.3 recall.
- [x] (Stretch) hydrate digest from recall on cold facet spawn. `AuditionEngine`
  gains `attachMemoryRecall`; `_processMessage` seeds an EMPTY thread digest from
  `semanticQuery` on the first turn for an entity (best-effort, off-tick, non-fatal).
  `ThreadDigestManager.hydrate` never clobbers a live digest. Wired (gated on a
  vector adapter) in `mind.ts`. Tests `tests/unit/audition.digest-hydration.test.ts`.

### 5.5 Wiring ✅
- [x] `mind.ts`: `attachMemorySink(e => simulation.stateManager.setEntity(e))` and
  `attachMemoryRecall((q,limit) => episodicConsolidator.semanticQuery(q,{limit}))` (when vector adapter present).

---

## Section 6: Tier 2 — per-facet concurrency ✅

**File**: `audition.engine.ts`

- [x] Per-entity serialized turn chain (`_enqueue`): serializes `_processMessage`
  so two messages from one entity never interleave `_streamState` / history / chunk stream.
- [x] Per-facet promise chain (tail-await) keyed by entityId; rejection-isolated tail.
- [x] Turn deferred (`_beginTurn`/`_endTurn`) resolved by `_onFacetDecision` (try/finally,
  all exit paths) with a safety timeout so the queue can never deadlock.
- [x] (Stretch) coalesce rapid-fire messages arriving before the in-flight turn finishes.
  A per-entity `CoalesceWindow` folds messages that pile up before a turn STARTS into
  one turn (`_perceive`/`_runCoalesced`); the window closes when its turn starts, so the
  next burst forms the following turn — serialization preserved. **Behavior change:** a
  burst is now answered once, not N times. Tests rewritten in
  `tests/unit/audition.concurrency.test.ts`.

---

## Section 7: Tests

### 7.1 Unit
- [x] `LoopbackTransport` — emit records, ack policy, inbound injection, status.
- [x] `InboundQueue` — FIFO, tick-stamping, drain-once.
- [x] `TransportController` — attach/enqueue, per-channel dispatch, batch isolation, detach; reply/chunk fast-path emit, `emitInvocations`, `emitOutbox`, shared monotonic seq, ack dedup + emit-callback marshaling, activity projection ('*'), reconnect re-emit, inbound recording.
- [x] Reply fast-path — AuditionEngine fires the reply callback (talk allowed) / suppresses it (talk denied).
- [x] `AckReconciler` — first-ack-wins dedup, FIFO eviction, clear; dual-path idempotency (callback then event → applied once).
- [x] `ProactiveCommunicator.deliverReply` — `pushToOutbox` (default push; transport path records-only + bypasses channel gate).
- [x] `SocketIoTransport` — ack callback / timeout / disconnect; inbound envelope + synthesized acks; status; close.
- [x] Per-facet serialization — rapid `ingest()` → no interleave; FIFO; cross-entity concurrent.
- [x] `DefaultReplayRecorder.recordInbound` — persisted + counted; survives buffer rollover.
- [x] Conversation → `working_memory.item` entity with correct shape + salience→activation.
- [x] Retrieval injection — focus contains memories block; empty + failure paths covered.

### 7.2 Integration (over LoopbackTransport)
- [x] message in → reply envelope out (off-tick, no tick required).
  `tests/integration/transport.reply.out.test.ts` — inbound_message → applyInbound →
  ingest → reply fast-path → `transport.emit({channel:'reply'})`, no outbox drain.
- [x] `effector_invocation` out → result-ack in → `confirmExecution` applied on tick (`transport.controller`).
- [x] Conversation turns consolidated to episodic + embedded (mock embedder).
  `tests/integration/conversation.consolidation.test.ts` — exchange → working_memory.item
  → consolidator tick → episode in store + vector index → recallable via semanticQuery.
- [x] Replay determinism: recorded inbound batch re-feeds with byte-identical dispatch (`transport.replay.equivalence`).

---

## Implementation order

```
0 (seam) → 1 (inbound queue) → 2.1/2.2 (reply+chunk fast path) → 6 (facet queue)
                              → 5 (memory)            [parallel, independent]
2.3/2.4 (outbox+effector bridge) → 3 (acks) → 4 (executor tap)
7 (tests) throughout
```

Sections 5 and 6 are independent of the transport and can land first if desired.

---

*Created: 2026-06-02*

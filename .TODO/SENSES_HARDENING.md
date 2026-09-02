# Will — Sensory Pipeline Hardening TODO

> **Standing:** SHIPPED · 2026-06-02 · partial — 33 of 35; lifecycle hygiene, salience fidelity, token economy and extensibility, not the core design

> Findings from the sensory-pipeline architecture review (AuditionEngine + facets
> + senses layer integration). The pipeline is a strong fit with the mind's
> philosophy — dual-track percept/facet, GWT + attention integration, narrative
> singularity, attention-budgeted facets. These items address lifecycle hygiene,
> salience fidelity, token economy, and extensibility — not the core design.
>
> Scope: `will/` package. Tackle **top-to-bottom by priority**; each item is
> self-contained and independently testable.
>
> Companion docs: `TODO.md` (senses architecture), `EXTERNAL_TRANSPORT_TODO.md`
> (transport reorientation — complete).
>
> **Status: complete.** §1–§5, §7, and §8 shipped; §6 base extraction shipped with
> cross-modal binding deferred until a second sense produces percepts (seam in place).

---

## Legend

- `[ ]` Not started   `[~]` In progress   `[x]` Complete   `[!]` Blocked
- Priority: **P0** bug/hang · **P1** correctness · **P2** efficiency/cost · **P3** structure/polish

---

## Scorecard (baseline at review time)

| Dimension | Grade | Item(s) |
|---|---|---|
| Fit with mind architecture/philosophy | A− | — |
| Clean logic / legit implementation | B+ | §2 |
| Contextual data: mechanism/summarize/inject | B | §5 |
| Extensible | B | §6 |
| Parallel/multiple sources | B+ | §1 |
| Escalation/awareness mapping | A− | — |
| Token efficiency | B− | §4 |
| Facet correctness | A− | §1, §2 |

Target after this plan: lifecycle + salience + token gaps closed → A− across the board.

---

## §1 — Idle-facet GC (attention-budget leak)  ·  **P0** (bug/hang)  ✅ DONE

### Problem
Conversation facets are destroyed **only** via explicit `endSession()`, which fires
only from `endConversation()` (SSE/WS disconnect). There is no idle reaper. A
conversation that goes quiet without a disconnect leaks its facet forever. As idle
facets accumulate, the attention budget `maxFacets = floor(free_capacity / 0.3)` is
exhausted → new conversations get `attention: 'full'` → the AuditionEngine's
graceful-degradation path returns **no reply** (silent hang).

### Evidence
- `executive.engine/facet.supervisor.ts:119` — `maxFacets` cap; `:120` returns
  `{ attention: 'full' }` when `_facets.size >= maxFacets`. No eviction anywhere.
- `executive.engine/facet.supervisor.ts:164` — `destroy()` only removes on explicit call.
- `senses/audition.engine.ts:747` — `endSession()` is the only audition caller; reached
  only via `WillStem.endConversation()` (`stem/index.ts:831`).
- `senses/audition.engine.ts:300` — attention-full → `_routeToFacet` returns false → no reply.

### Fix
1. **Activity stamping.** Track last-activity tick per facet. Simplest: `FacetSupervisor`
   records `lastActiveTick` on `spawn` and on each `report()` (or AuditionEngine stamps
   via a supervisor hook). Use the sim tick from the live state ref (deterministic), not wallClock.
2. **Idle reaper.** On each executive tick (or a periodic sweep in `FacetSupervisor`), destroy
   facets idle longer than `facetIdleTtlTicks` (config, default e.g. 50 ticks). Publish the
   existing `executive.facet.destroy` event so the AuditionEngine can drop its `_facets` entry.
3. **AuditionEngine reconciliation.** AuditionEngine must learn when the supervisor reaps a
   facet it holds in `_facets`. Either (a) subscribe to `executive.facet.destroy` and remove the
   entry + stream/turn state, or (b) the reaper invokes a registered onDestroy callback. Avoid a
   dangling handle whose facet is already destroyed.
4. **LRU under pressure (optional but recommended).** When a spawn would exceed `maxFacets`,
   evict the least-recently-active facet instead of refusing — so a fresh, active conversation
   preempts a stale one rather than being dropped.

### Acceptance / tests
- [x] Facet idle past TTL is destroyed; its attention budget is reclaimed.
- [x] AuditionEngine drops the reaped entity from `_facets` / `activeSessions()` (+ clears
      `_streamState`, `_inflightInbound`, `_inflightThread`, `_entityTail`) via `_teardownEntity`.
- [x] More-recently-active facet is NOT reaped in the same sweep.
- [x] Under budget pressure, LRU eviction admits a new conversation (no silent drop); refusal path retained via `evictLruOnPressure: false`.
- [x] Determinism: reaping keyed on sim tick (`facet.lastActiveTick`), not wallClock.

### Implementation (as shipped)
- [x] `ExecutiveFacet.lastActiveTick` + `markActive(tick)`; stamped at spawn and on each `report()` (sim tick).
- [x] `FacetSupervisor` idle reaper in `broadcastStateRef` (`_reapIdle` + `_reap`); `idleTtlTicks` (default 50), `evictLruOnPressure` (default true) constructor opts.
- [x] LRU eviction (`_leastRecentlyActive`) on budget pressure in `spawn()`.
- [x] `onReaped` added to `ExecutiveFacetHandle`; fired by reaper/LRU only (not explicit `destroy()`).
- [x] `AuditionEngine._teardownEntity` + `handle.onReaped(...)` wiring; `endSession` refactored to share it.
- [x] Tests: `tests/unit/facet.supervisor.test.ts` (6); `audition.lifecycle` onReaped cleanup (+1).

---

## §2 — Facet-per-entity vs digest-per-thread mismatch  ·  **P1** (correctness)  ✅ DONE (Option A)

### Problem
Facets are keyed by `entityId`, but digests/threads are keyed by `threadId`, and the
decision-subscription closure captures the **spawn-time** threadId. An entity that uses
two threads gets (a) mixed `_facetReasoningHistory` continuity across threads, and (b)
the will-turn digest appended to the wrong thread.

### Evidence
- `senses/audition.engine.ts` `_routeToFacet` — `handle.subscribe( d => this._onFacetDecision(
  entityId, percept.threadId, d ) )` captures the first percept's threadId for the facet's life.
- `_onFacetDecision` appends the will turn to that (possibly stale) threadId.
- `_inflightThread` map already tracks the *current* thread per entity (added for chunk envelopes).

### Fix (pick one)
- **Option A (minimal):** in `_onFacetDecision`, read the current thread from
  `_inflightThread.get(entityId)` instead of the captured `threadId`. Cheap; fixes the
  digest-append + reply threadId. Continuity history still mixes threads.
- **Option B (clean):** key facets by `entityId:threadId` (a conversation = entity × thread).
  Separate continuity per thread. More faithful; touches `_facets`, `_streamState`,
  `_inflightInbound/_inflightThread`, `endSession`, `activeSessions`. Decide whether one
  entity across threads should share a facet (Option A) or not (Option B).

### Resolution — Option A (shipped)
`_routeToFacet` no longer captures `percept.threadId` in the decision subscription;
`_onFacetDecision(entityId, decision)` resolves the thread from `_inflightThread.get(entityId)`
(the current turn's thread, valid under Tier 2 serialization). Fixes the will-turn digest
append, the exchange-memory threadId, and the reply/chunk envelope threadId.

- [x] Same entity, two threads → reply follows the current thread (`audition.memory` §2 test).
- [x] Reply/chunk/digest/memory all use the in-flight thread, not spawn-time.
- [ ] (Option B — deferred) per-thread continuity history (one facet per entity still shares continuity; acceptable, arguably desirable).

---

## §3 — Salience: crude, relationship-blind, non-per-entity key  ·  **P1** (correctness)  ✅ DONE

### Problem
`_model.observe('audition.', langEnergy)` uses a **literal key** (not per-entity), and the
formula is urgency-keywords + length only. `AttachmentEvaluator` exists but is **not wired in**,
so a message from a deep bond scores the same base as a stranger's. Salience drives attention
allocation, WM `activation`, and GWT workspace gating — so fidelity here directly shapes "what
Will notices."

### Evidence
- `senses/audition.engine.ts` `_processMessage` — `langEnergy = urgencyBonus*0.5 + lengthScore*0.3
  + 0.2`; `this._model.observe('audition.', langEnergy)` (literal key).
- `AttachmentEvaluator` present in cognition; not referenced by audition.
- `_lastMsgAt` tracked but unused (recency bonus never applied) — see §7.
- Original design (`TODO.md` §3.1 `computeLanguageSalience`) specified
  `attachmentScore*0.4 + urgency + goal-overlap + recency`.

### Resolution (shipped)
1. [x] Per-entity key: `this._model.observe('audition.${entityId}', energy)` — independent baselines.
2. [x] Pure helper `computeLanguageSalience({ content, attachmentScore, activeGoalText })`
   (`senses/audition/salience.ts`): base 0.15 + urgency 0.30 + attachment 0.35 + goal-overlap 0.15 + length 0.05.
3. [x] `AttachmentEvaluator.getAttachmentScore(keid)` added; wired via `attachAttachmentScore`.
4. [x] Active-goal topic overlap via `attachActiveGoalText` (GoalManager descriptions + tags).
5. [x] **Determinism:** dropped the wall-clock recency term (salience feeds attention/GWT, which are
   replay-sensitive). Per-entity GenerativeModel keying captures conversational novelty instead.
   This removed the dead `_lastMsgAt` field (closes the §7 nit).

### Acceptance / tests (`audition.salience.test.ts`, 8)
- [x] High-attachment + urgency → > 0.7.
- [x] Stranger neutral → near floor (< 0.35).
- [x] Attachment monotonic; urgency + goal-overlap raise score; short tokens ignored; clamped; deterministic.
- [x] Accessors consulted with the speaker's entityId (`audition.memory` §3 test).

---

## §4 — Token efficiency per facet turn  ·  **P2** (cost)  ✅ DONE

### Problem
Every facet turn carries the **full cognitive baseline** (beliefs, goals, affect, self-model) —
same as master — plus focus + continuity + master-sync + digest + recalled memories, and the
two-step output format generates private JSON reasoning **every** turn. For chatty multi-turn
threads this is a large, repeated prompt. There is belief dedup/omission and a summarizer, but
**no cross-turn prompt caching** of the stable prefix.

### Evidence
- `executive.engine/prompt.factory.ts` — facet mode = "same awareness baseline" as master
  (`:180`, `:185`); beliefs block + state baseline rebuilt per turn (`buildFreshContext`).
- `CONVERSATION_OUTPUT_FORMAT` (audition.engine.ts) — mandatory JSON reasoning step before `[REPLY_TEXT]`.
- `llm/index.ts` — `call` / `callStream`; no Anthropic `cache_control` breakpoints.

### Resolution (shipped — maximal caching, "Option B")
Investigation found the real blocker: `buildSystemPrompt` rendered a volatile `## Current Focus`
block (the per-turn message for conversation facets) between the stable persona head and the
stable schema, so nothing below it could cache. The "light turn / reduced baseline" idea was
**dropped** — it conflicts with the inclusive-awareness design and caching makes it unnecessary.

1. [x] **Relocated `## Current Focus` from the system prompt to the user-message tail**
   (`prompt.factory.ts`). The system prompt is now byte-identical per context.
2. [x] **Single cache breakpoint over the whole system prompt** for `provider==='anthropic'`
   (`_systemField()` in `llm/index.ts`) — `system: [{type:'text', text, cache_control:{type:'ephemeral'}}]`.
   GA, no beta header. Other providers get the plain string.
3. [x] **Shared across the mind:** master reuses its cached system prompt across ticks; because the
   facet role keys only on the constant `focus.title`, **all conversation facets of a Will share one
   cached system prompt** (and planning facets share theirs).
4. [x] **Measurement:** `cacheReadTok` / `cacheWriteTok` captured from `usage` in both call paths,
   surfaced in the facet response log + session log (`cacheReadTokens`/`cacheWriteTokens`).

### Acceptance / tests (`prompt.caching.test.ts`, 5)
- [x] System prompt byte-identical when only `focus.content` differs → one cache entry per context.
- [x] Volatile focus content does not leak into the system prompt.
- [x] Two conversation facets (same `focus.title`) → identical system prompt (shared cache entry).
- [x] Master vs facet system prompts differ (separate entries, by design); persona + schema retained.
- [x] No regression: full suite green incl. **replay-equivalence** (caching is wire-only; the recorder
  logs the system string, so record/replay determinism is untouched).

### Follow-up (noted, not blocking)
- [ ] Token tracker currently records the uncached `input_tokens` only; for exact billing it should
  also account for `cache_read`/`cache_creation`. Telemetry is captured; tracker accounting is a separate pass.

---

## §5 — Consolidate overlapping context stores  ·  **P2** (clarity)  ✅ DONE

### Problem
Four conversation-context mechanisms with no single source of truth:
`ThreadDigestManager` (in-mem, last-5), `ConversationManager` ring buffer, vector recall, and
`ExecutiveSummarizer`. The digest is volatile (lost on restart; recall now partly compensates).

### Evidence
- `senses/audition.engine.ts` `ThreadDigestManager`; recall via `EpisodicConsolidator.semanticQuery`.
- `ProactiveCommunicator` / `ConversationManager.recordExchange`; `ExecutiveSummarizer`.

### Investigation finding — they're not all duplicates
| Store | Role | In the facet prompt? |
|---|---|---|
| `will_conversations` (backend DB) | Verbatim transcript of record (UI/history). | No — backend. |
| episodic + vector (`EpisodicConsolidator`) | Long-term cognitive memory; semantic recall. | Yes — the single `## Relevant Memories` section. |
| `ThreadDigestManager` (AuditionEngine) | Verbatim recent turns (last-5), live-session view. | Yes — in `focus.content` (verbatim-recent ≠ semantic-past). |
| `ConversationManager` ring buffer | Legacy/PMA: fed the `conversation.session` entity + PMA seeding. **Removed in §8.** | **No** — was never read by the prompt builders. |
| `ExecutiveSummarizer` | Master's rolling reasoning summary ("Memory Continuity"). | Yes — distinct from conversation context. |

The real duplication was **two semantic-recall sections**: `context.memories` ("## Relevant Memories",
general state+goals query) **and** a separate per-facet block the AuditionEngine injected
("## Relevant memories (recalled)", message query) — both from the same vector store.

### Resolution (shipped — unify on one recall surface)
1. [x] Removed the AuditionEngine's separate recall (`_retrieveMemories`/`_formatMemory`/`_recall`/
   `attachMemoryRecall`/`RecalledMemory` + the focus memory-block + the `mind.ts` wiring).
2. [x] `FocusSection.recallQuery` added; the conversation facet sets it to the live message in `_buildFocus`.
3. [x] `buildExecutiveContext`/`buildFreshContext` accept `recallQuery` — a focus-supplied query drives
   the single `## Relevant Memories` section (else the general query). `facet.ts` threads `focus.recallQuery`.
4. [x] Net: **one** semantic-recall section, message-relevant for conversations; the verbatim digest stays
   the distinct recent-view; ConversationManager/summarizer roles documented above.

### Acceptance / tests (`audition.memory.test.ts`)
- [x] No duplicate recall: facet sets `focus.recallQuery`; no separate recall block in `focus.content`.
- [x] Restart awareness via recall: conversation persists to vector (memory sink), so a resumed
  conversation's first message recalls relevant past through the unified section. Verbatim last-N is
  intentionally ephemeral — `will_conversations` is the durable transcript of record.
- [x] Full suite green incl. replay-equivalence + mind integration (exercise `buildExecutiveContext`).

---

## §6 — Extensibility: shared sense-engine flow + cross-modal  ·  **P3** (structure)  ✅ DONE (base) · cross-modal deferred

### Problem
`SenseEngine` is an interface; `AuditionEngine` reimplemented the whole orchestration
(gate → salience → percept publish → facet route → memory). The four shell engines
(vision/somatosensation/olfaction/gustation) each re-declared the same boilerplate.
No cross-modal binding for the multimodal future the shells promise.

### Evidence
- `senses/index.ts` — `SenseEngine` interface (no shared base).
- `senses/{vision,somatosensation,olfaction,gustation}.engine.ts` — duplicated stubs (~50 lines each).

### Resolution (shipped — `senses/base.sense.engine.ts`)
1. [x] **`BaseSenseEngine`** (abstract, implements `SenseEngine`) captures the shared pipeline as a
   template method: `ingest()` = effector gate (`gateEffector` + `EffectorRegistry`) → kind filter
   (`acceptedKinds`) → `_perceive()`. Provides `attachBus`/`attachEffectorRegistry`, the
   CognitiveEngine defaults (`publishes`/`subscribes`/`onCognitiveEvent`/`snapshot`), and the single
   emit chokepoint `publishPercept()` → `senses.<domain>.percept`.
2. [x] **`ShellSenseEngine`** — `_perceive()` warns (only ever reached for an accepted kind) and
   `snapshot()` advertises shell status. The four shells are now ~6 lines each: `name`, `domain`,
   `acceptedKinds`.
3. [x] **`AuditionEngine`** extends `BaseSenseEngine` — dropped its `_bus`/`_effectorRegistry` fields,
   `attachBus`/`attachEffectorRegistry`, the gate+filter in `ingest`, and the inline bus publish.
   It now overrides only `publishes()` (adds `audition.task.signal`) and `snapshot()` (sessions), and
   implements `_perceive()` (the per-entity serialized conversation flow). Behavior unchanged.

### Cross-modal binding — deferred (seam in place)
`publishPercept()` is now the single chokepoint where a `CrossModalBinder` would observe percepts of
the same `sourceEntityId` across domains. Deliberately **not** built yet: it needs ≥2 live percept
producers to be meaningful, and audition is the only non-shell sense today (vision/soma/olfaction/
gustation emit nothing). Building it now would be a write-only sink with no consumer. When a second
sense goes live, the binder is a small, localized addition at the base chokepoint.

### Acceptance / tests (`base.sense.engine.test.ts`, `senses.shell.test.ts`)
- [x] A new (stub) sense engine reuses the base flow with ~no orchestration code — `TestSense`
  (gate + filter + publish all inherited) and `TestShell` exercise the contract.
- [x] AuditionEngine behavior unchanged after refactor — full audition suite green
  (memory/chunk/concurrency/salience) + mind integration + replay-equivalence.

---

## §7 — Nits & invariants  ·  **P3** (polish)  ✅ DONE

- [x] **`_lastMsgAt` dead field** — removed (the recency term was dropped for determinism in §3).
- [x] **entityId namespace collisions across sources** — documented as the integrator's contract in
      the `AuditionEngine` class header ("Entity keying & namespace contract"): the engine keys facet /
      turn-queue / chunk-state / inflight maps by `entityId`, so same-id messages share one facet by
      design; bridging multiple channels requires namespacing the id by source (e.g. `slack:U123`,
      `web:42`). `threadId` scopes one speaker's parallel threads but does not split facets.
- [x] **Off-tick reasoning invariant doc** — stated in the `AuditionEngine` class header
      ("Determinism: on-tick vs off-tick boundary") and added as guardrail #5 in
      `EXTERNAL_TRANSPORT_TODO.md`: inbound application is the only on-tick, replay-recorded step;
      facet reasoning, streaming, reply emit, and `conversation.exchange` `setEntity` writes run
      off-tick and are reconstructed (R2-safe — no wall-clock enters state).

---

## §8 — Remove ConversationManager (legacy, off the live pipeline)  ·  **P2** (clarity)  ✅ DONE (Option A)

### Problem
`ConversationManager` (`src/llm/conversation/manager.ts`) was a pure in-memory ring buffer modeling
the old "executive generates the reply via `[REPLY]`" loop. §5 confirmed it sits **off** the
AuditionEngine pipeline: not read by any prompt builder (`getRecentExchanges*` were dead) and not
written by the facet path (`deliverReply` never passed `incomingMessage`). Its only live producers
were the master `talk`/`text` path (`_handleOutboundMessage`) and PMA seeding — both of which now have
a better home in the unified conversation-memory pipeline (§5). Keeping it meant two parallel models
of "what was said," one of which never reached a prompt.

### Decision — Option (a): master-initiated messages join the same memory sink
If the master's outreach gets delivered, a facet later spawned to **answer or continue** that
conversation must recall it. So every outbound message — reply **and** master-initiated — is persisted
as a `conversation.exchange` working-memory item, exactly like a facet reply, and flows
WorkingMemory → EpisodicConsolidator → vector → unified recall (§5). No separate session store.

### Resolution (shipped)
1. [x] **`ProactiveCommunicator._handleOutboundMessage`** — removed the `recordExchange` call and the
   `conversation.session` entity write; made the `conversation.exchange` WM-item write **unconditional**
   (was gated on `originalMessage`). Master-initiated outreach uses a `You → <name>: "…"` summary;
   replies keep `<name>: "<inbound>" → "<reply>"`. `deliverReply` lost its dead `incomingMessage`
   recordExchange (exchange memory is owned upstream by the AuditionEngine sink).
2. [x] **ExecutiveEngine / PromptFactory** — dropped `attachConversationManager`, the field, and the
   `PromptDependencies.conversationManager` (it was never read by the prompt builders).
3. [x] **mind.ts / stem/index.ts** — removed the instance, wiring, `MindAssembly`/`WillInstance` fields,
   and the `attachSessionLogger` fan-out. Deleted `src/llm/conversation/manager.ts`.
4. [x] **PMA** — `lastConversationDigest` is now **derived** from the most recent consolidated
   `conversation.exchange` episode (was: a `conversation.session` entity). On load it is **re-seeded**
   as a `conversation.exchange` WM item tagged `pma-restored` (was: `seedFromDigest`), so a restored
   Will recalls its last conversation through the normal pipeline.
5. [x] **Latent bug fixed (in blast radius)** — the §5 memory sink
   `auditionEngine.attachMemorySink(e => simulation.stateManager.setEntity(e))` referenced `simulation`,
   which wasn't in `_constructCognition`'s scope (a `TS2304` that unit tests missed because they inject
   mock sinks). Threaded `simulation` into `_constructCognition` — option (a)'s persistence depends on
   this sink actually running.

### Acceptance / tests
- [x] `communication.outbound-memory.test.ts` — `talk` writes a `conversation.exchange` WM item for
  **both** master-initiated (no inbound, `You → …` shape) and reply (inbound present) paths; no
  `conversation.session` entity is written.
- [x] `pma.conversation-digest.test.ts` — distill derives the digest from the most-recent exchange
  episode (most-recent-wins); load re-seeds it as a `pma-restored` `conversation.exchange` WM item.
- [x] Typecheck clean; full suite green (462 → 468) incl. replay-equivalence + mind integration.

---

## Suggested order

```
§1 (P0 idle-facet GC)  →  §3 (P1 salience)  →  §2 (P1 thread keying)
   →  §4 (P2 prompt caching)  →  §5 (P2 stores)  →  §8 (P2 drop ConversationManager)
   →  §6 (P3 base engine)  →  §7 (P3 nits)
```

§2 and §3 are small and can pair. §4 should be measured before/after. §8 follows §5 (it removes the
last off-pipeline conversation store §5 documented). §6 is best done before the first non-audition
sense engine is built.

---

*Created: 2026-06-02 — from the sensory-pipeline architecture review.*

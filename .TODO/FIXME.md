# FIXME — review punch list

Findings from the architecture/performance review, ordered smallest → largest.
Severity: 🔴 correctness · 🟠 productionization · 🟡 docs/maintainability.

---

## Small (bounded, low risk)

- [x] **🟡 Move `vitest` to `devDependencies`** — `package.json`
  It is currently under `dependencies`; it is a test runner, not a runtime dep.

- [x] **🔴 Fix semaphore over-admission race** — `src/llm/gate.ts` (`LLMSemaphore.acquire` / `_release`)
  On release, `_running--` runs, then the woken waiter does `_running++` in a *later*
  microtask. A fast-path `acquire()` slipping into that window sees `_running < _max`
  and admits too — transiently exceeding `WILL_LLM_CONCURRENCY`. Hand the slot directly
  to the next waiter on release; the waiter must not re-increment.

- [x] **🔴 Add tick re-entrancy guard** — `src/core/orchestrator.ts` (`_runLoop` / `_executeTick`)
  `setInterval` fires an async callback with no in-flight guard. If a tick exceeds
  `tickIntervalMs` (it `await`s engine reacts and `eventBus.flush()`), the next interval
  overlaps the previous commit → concurrent `applyCommands` on the double buffer. Add an
  executing flag (or self-reschedule via `setTimeout` after completion).

## Medium (docs)

- [x] **🟡 Clean outdated README sections** — `README.md`
  Remove/correct anything no longer in the code:
  - Token-budget mechanism (`_applyTokenBudget()`, "hard 22.5K ceiling") — not present
    anywhere in `src/`.
  - `groq` provider — `LLMProvider` union is `anthropic | deepseek | openai | google`.
  - Project-structure tree still shows `deployment/` (now `stem/`, with `tracts/`).
  - Any other Mastra/ai-sdk references vs. the in-house `fetch` LLM layer.

## Large (separate units — confirm scope before starting)

- [ ] **🟡 Single-source engine defaults** — `src/stem/mind.ts` (`engineConfigEntities`) — **ON HOLD**
  Engine defaults live both in each engine's constructor and in the ~400-line mirror
  literal; they already drift. Deferred to an upcoming engine-config feature — do not
  reconcile piecemeal now.
  Audit (2026-06-01): the mirror entities are runtime-authoritative (hot-reloaded each
  tick via `_readConfigFromState`, overwritten by PMALoader), so mirror wins over the
  constructor `?? default`. 28/36 match. Known drift to address with the feature:
  - latent bugs (mirror stale, runtime uses unintended value): `working-memory.baseDecayRate`
    (0.15 vs 0.08), `working-memory.attentionProtection` (0.7 vs 0.6),
    `semantic.beliefStalenessThreshold` (150 vs 300)
  - mirror is intended/newer: `narrator.minIntervalTicks` (50 vs 300),
    `moral.eventThreshold` (0.3 vs 0.5), `moral.decayRate` (0.02 vs 0.04)
  - structural: moral foundations — `foundationPurity` key never matches (`sanctity`),
    `liberty` unmirrored, override de-normalizes the weights
  - dead/omitted: `episodic.maxStoredEpisodes` ignored; `spaced-repetition` has no mirror
    entry; `reward.socialDecayRate` and others unmirrored
  - intentional override (keep): `stress.baseDecayRate` 1.5

- [x] **🟠 Replace scattered `console.*` with an injectable logger** — ~134 call sites
  A library embedded in `backend` should not log directly to console. Done: added
  `src/core/logger.ts` (`Logger` interface, `ConsoleLogger` default, `setLogger()` seam,
  exported via `#core` + public API). Routed 118 library `console.*` calls through
  `logger.*` across 35 files. `runner.ts` (dev CLI) stays on console; the pre-existing
  `SessionLogger` in `stem/tracts/` is the structured NDJSON event stream, a separate
  concern from this diagnostic logger.

- [x] **🟡 Decompose `assembleMind`** — `src/stem/mind.ts` (~820-line function)
  Extract engine construction and the config literal into focused builders. Done:
  `assembleMind` is now a ~30-line orchestrator (resolve → construct → register → seed)
  delegating to focused module builders — `_buildSimulation`, `_constructCognition`,
  `_registerEngines`, `_seedIdentity`, `_seedInitialGoals`, `_buildEngineConfigEntities`,
  `_seedEngineConfigs`. Structural only: no engine-config values changed (that drift stays
  ON HOLD for the meta-cognition feature). Verified behaviour-identical — every `new`/`.attach`
  line and the config-entity literal are byte-identical to before; src typecheck clean;
  291 tests pass.

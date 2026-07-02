# FIX_TODO — Tactical fixes (`will` codebase review)

> Concrete, mostly-localized bugs and hygiene issues found during an architecture/perf/tooling
> review on 2026-05-29. Strategic/architectural changes live in `REORIENT_TODO.md`.
> Each item cites `file:line` (line numbers as read at review time). Severity: **P0** correctness/reliability,
> **P1** performance/important, **P2** quality/hygiene.

---

## P0 — Correctness & reliability

### F1. Snapshot is shallow — "read-only" state is not actually immutable
`DefaultStateManager.snapshot()` does `entities: new Map(this._entities)` — it copies the *map*, but every
entity object inside is shared by reference with live state.
- File: `src/core/state.manager.ts:145-152`
- Impact: An engine that mutates `snapshot.entities.get(id).someField = x` mutates **live** state mid-tick,
  bypassing the command/double-buffer pipeline. The `ReadonlySimulationState` type is a compile-time fiction
  with no runtime enforcement. This silently breaks the determinism, double-buffer-commit, and replay
  guarantees the whole `core/` event-sourcing design rests on.
- Fix (minimum): `Object.freeze` entities on read in dev/test builds so accidental mutation throws.
  Better: defensive-copy nested mutable fields, or adopt structural-sharing/immutable state (see REORIENT R3).

### F2. Replay is non-deterministic — raw `Math.random()` / wall-clock in the deterministic layers
A seeded Mulberry32 PRNG exists (`createPRNG`, `src/core/utils.ts:14`) and is carried on
`SimulationContext.prng`, but engines bypass it.
- 26 `Math.random()` call sites in `src/core` + `src/cognition` (e.g. `semantic.integrator.ts`,
  `dream.simulator.ts`, `planning.engine.ts`, `working.memory.ts`, `executive.engine/commands.ts`,
  `pma/eval.ts`).
- 154 `Date.now()` / `new Date()` reads in `src/core` + `src/cognition`, while a sim clock (`this._clock.now`)
  exists specifically to avoid wall-clock leakage.
- Impact: identical seed + identical event log ≠ identical run. Replay/snapshot (`core/replay.ts`,
  `core/snapshot.manager.ts`) cannot reproduce a session — the headline capability is not actually guaranteed.
- Fix: replace `Math.random()` with `context.prng.next()` and decision-affecting `Date.now()` with the sim
  clock inside `core`/`cognition`. (Latency-measurement `Date.now()` is fine.) Enforce via lint (REORIENT R2).

### F3. Tick loop has no re-entrancy guard (overlapping ticks)
`_runLoop` schedules with `setInterval(async () => { … await this._executeTick() }, tickIntervalMs ?? 0)`.
`setInterval` does not wait for the async callback.
- File: `src/core/orchestrator.ts:362-387`
- Impact: if a tick body (engine `react`, `eventBus.flush()`, after-tick snapshot handlers, any I/O) outlasts
  `tickIntervalMs` — guaranteed with the default `0` — the next interval fires and `_executeTick` runs
  concurrently, mutating `_currentTick`/state from two overlapping invocations.
  *Note:* the `AsyncEngine` design (LLM offloaded to a background promise) keeps the **executive** off the
  critical path, which lowers the likelihood — but the guard is still missing for everything else.
- Fix: replace `setInterval` with a self-rescheduling `setTimeout` loop plus an `_tickInProgress` flag so a
  tick can never overlap itself.

### F4. LLM `fetch` calls have no timeout / AbortController
`_callAnthropic`, `_callOpenAI`, `_callAnthropicStream` issue bare `fetch` with no timeout.
- File: `src/llm/index.ts:160, 285, 322`
- Impact: a hung connection blocks forever **and** holds a `withGate` semaphore slot. With the default
  `WILL_LLM_CONCURRENCY=2`, two stuck calls deadlock all LLM activity for the process.
- Fix: wrap each `fetch` with an `AbortController` + configurable timeout; on abort, throw a retryable error.

### F5. DeepSeek / Google / Groq / Ollama providers are broken or absent
- `_callProvider` routes `'deepseek'` → `_callOpenAI` (`src/llm/index.ts:270`), which hardcodes
  `https://api.openai.com/v1/chat/completions` (`:322`). DeepSeek requests therefore hit OpenAI's endpoint.
- The real `_callDeepSeek` (`:348`) is dead code that `throw`s "not yet implemented".
- `_callGoogle` (`:352`) throws "not yet implemented".
- No base-URL handling exists anywhere (`grep BASE_URL/baseURL` → 0 hits), so the README's Ollama setup
  (`OPENAI_BASE_URL=http://localhost:11434/v1`, README:59-65) and the "Groq / DeepSeek / Google / Ollama"
  support claim (README:36) are non-functional. Only Anthropic + OpenAI actually work.
- Fix: read `OPENAI_BASE_URL` (and per-provider base URLs) in the OpenAI-compatible path; implement or remove
  the advertised providers; delete the dead `_callDeepSeek`. Align README with reality (see F13).

### F6. Rate-limit retry misses 529/503 overloaded errors
`isRateLimitError` matches only `rate_limit_error`, `statusCode === 429`, `"rate limit"`, `"429"`.
- File: `src/llm/gate.ts:68-78`
- Impact: Anthropic `529 Overloaded` and transient `503` (both common) are treated as fatal and not retried.
- Fix: also retry on 500/502/503/529 and network errors (with the same backoff).

### F7. Semaphore can exceed `MAX_CONCURRENT` (over-subscription race)
In `LLMSemaphore`, a queued waiter increments `_running` only *after* it is dequeued and its promise
resolves (a microtask later). A fresh `acquire()` arriving in that window sees the just-freed slot and takes
it, so when the queued waiter resumes, `_running` is incremented past `_max`.
- File: `src/llm/gate.ts:38-58`
- Fix: reserve the slot at release time (increment for the woken waiter inside `_release` before resolving),
  or use a counting-semaphore impl that doesn't re-increment on wake.

---

## P1 — Performance & packaging

### F8. Two full O(n) state copies per tick
`_executeTick` calls `snapshot()` at `:425` and again (`postSnapshot`) at `:505`. Each is `new Map(entities)`
over the entire entity set, which includes beliefs, episodic memories, reputations (all stored as entities).
- File: `src/core/orchestrator.ts:425, 505`; `src/core/state.manager.ts:145`
- Impact: per-tick cost grows O(total entities) and is paid twice; dominates at high tick rates / large memory.
- Fix: take one snapshot per tick where possible; longer-term move to copy-on-write / dirty-tracking (REORIENT R3).

### F9. Phantom & misplaced dependencies in `package.json`
- `@mastra/core`, `@mastra/memory`, `@mastra/libsql`, `@mastra/pg`, `openai`, `hnsw` appear in `tsup`
  `external` (`tsup.config.ts:35-39`) and/or keywords, but are **not declared** in `will/package.json` or the
  workspace root. They resolve only via Bun hoisting — a fresh consumer install would break.
- `@ai-sdk/openai` is declared but imported **0 times** in `src`.
- `vitest` is in `dependencies` (`package.json:53`) but is a test tool → belongs in `devDependencies`.
- Fix: declare what's actually imported, drop what isn't, move `vitest` to `devDependencies`.

### F10. Build output `dist/` is committed to git
`.gitignore` ignores `/build` but `tsup` writes to `dist/`, and `git ls-files dist` shows
`dist/index.js`, `dist/index.d.ts`, `dist/index.js.map` are tracked.
- Fix: add `/dist` to `.gitignore` and `git rm -r --cached dist`.

---

## P2 — Config & hygiene

### F11. Path-alias drift across the three configs
The `#`-aliases disagree between `tsconfig.json`, `tsup.config.ts`, and `vitest.config.ts`:
- `tsconfig.json` has no `#deployment` alias (tsup + vitest do).
- `vitest.config.ts:15` maps `#tools → src/tools`, but the directory is `src/toolbox` (tsconfig/tsup map
  `#tools → src/toolbox`, which is correct).
- Today nothing imports `#deployment` or `#tools`, so typecheck passes by luck; the configs will bite later.
- Fix: make all three alias maps identical and point `#tools` at `src/toolbox` everywhere.

### F12. `test:integration` script matches no files
`package.json:48` runs `vitest run src/tests/integration`, but integration tests live in `tests/integration`
(there is no `src/tests`). The command runs zero tests.
- Fix: change to `vitest run tests/integration`.

### F13. README describes an architecture the code no longer has
The README documents a Mastra-based LLM layer — "Mastra threads", `lastMessages: 50`, "all Mastra LLM calls"
(README:131-132; `gate.ts:6` comment) — but no source file imports `@mastra/*` or `@ai-sdk/*`; the LLM layer
is hand-rolled `fetch`. Provider list (README:36) also overstates support (see F5).
- Fix: update README to match the raw-`fetch` reality, or decide the Mastra question (REORIENT R1) first.

### F14. No real linter / formatter
`"lint": "tsc --noEmit"` is just a duplicate typecheck (`package.json:44-45`). No ESLint/Biome, no formatter.
- Fix: add Biome or ESLint + a format step; wire a determinism lint rule here (REORIENT R2).

### F15. Cosmetic: mis-numbered step comments in `_executeTick`
Two `// 13.` comments and no `// 11.` (`src/core/orchestrator.ts:504, 509`). Harmless, but confusing in a
file this central. Renumber.

---

## Quick triage order
1. F2 + F1 + F3 (determinism + state immutability + tick re-entrancy) — these protect the core event-sourcing/replay promise.
2. F4 + F6 + F7 (LLM reliability) — cheap, high-value robustness.
3. F5 + F13 (providers vs. docs) — correctness + truthful docs.
4. F9 + F10 + F12 + F11 (packaging/config) — fast hygiene wins.

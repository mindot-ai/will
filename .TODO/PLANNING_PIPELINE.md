# Will — Planning Pipeline Hardening

> The planning faculty is architecturally sound — two-tier execution, facet-driven
> deliberation, DAG step parallelism, determinism-clean. But the **plan-execution
> feedback loop is silently dead**: step outcomes never resolve because `_plans` is
> keyed by `goalId` while the outcome path looks plans up by `plan.id`. No plan ever
> reaches `completed`/`failed` through the engine; the system only *appears* to work
> because GoalManager independently consumes `action.outcome`. This doc tracks the
> fix for that and the surrounding robustness/cleanup gaps.

---

## Background — the intended data flow

```
ExecutiveEngine.latestOutput.plans
  → PlanningEngine._ingestExecutivePlans()            (dedupe by goalId)
  → _createPlan()  → Plan { id: "plan-N", goalId }
  → _executePlans() → _computeReadySet() (DAG)        (parallel-ready steps)
  → bus: plan.step.dispatched { planId: plan.id, stepId }
  → ActionExecutor → decision.record → effector resolve
  → bus: action.outcome { planId: plan.id, stepId, success, outcomeQuality }
  → PlanningEngine.onCognitiveEvent('action.outcome')
  → _onStepOutcome(planId, stepId)                    ← BREAKS HERE
       Tier completion: next-tick _executePlans() advances / completes
       Tier step-aware: _reportToFacet() → facet LLM → _onFacetDecision()
```

The return leg (`action.outcome → _onStepOutcome`) never fires because the lookup
key (`plan.id`) doesn't match the map key (`goalId`).

---

## Severity legend

🔴 correctness (pipeline broken) · 🟠 robustness (silent stall under load) ·
🟡 logic gap / latent · ⚪ cleanup / hygiene

---

## Findings

### 🔴 P1 — Step outcomes never resolve (`planId` / `goalId` key mismatch)

**Symptom.** Steps dispatch once, then sit in `dispatched` forever. No plan ever
emits `plan.completed`/`plan.failed`; step-aware facets are never told a step
finished. Latent because `GoalManager` consumes `action.outcome` on its own
(`goal.manager.ts:259`, `_nudgeActionGoals`), so *goals* still advance — masking the
dead *plan* loop.

**Root cause.** Write side keys by `goalId`; execution/outcome side keys by `plan.id`.

- `_plans.set(plan.goalId, plan)` — `planning.engine.ts:410` (`_createPlan`)
- `_plans.set(goal.id, plan)` — `planning.engine.ts:974` (`_generateHeuristicPlans`)
- `_ingestExecutivePlans` / `getPlan` / `getPlansForGoal` read by `goalId`
  (`:294`, `:319`, `:966`, `:1118`, `:1122`)

vs.

- `_plans.has(p.planId)` — `planning.engine.ts:211` (outcome guard)
- `_plans.get(planId)` — `planning.engine.ts:528` (`_onStepOutcome`)
- `_activeFacets.set(plan.id, …)` / `.get(planId)` — `:605` / `:575`

`ActionExecutor` stamps `metadata.planId = plan.id` (`action.executor.ts:104`) and
echoes it back on `action.outcome` (`action.executor.ts:614`). So the inbound
`planId` is always `"plan-N"`, never the goalId → guard misses → outcome dropped.

**Fix (re-key to `plan.id`, the canonical id the execution path already assumes). ✅ DONE**
- [x] `_plans: Map<planId, Plan>` becomes the canonical store.
- [x] Add secondary index `_planByGoal: Map<goalId, planId>` + private
      `_getPlanByGoal(goalId)` helper.
- [x] `_createPlan` / `_heuristicPlan` set **both** maps.
- [x] Convert the goal-keyed reads (`_ingestExecutivePlans`, the heuristic
      "unplanned" filter, `getPlan`, `getPlansForGoal`) to go through
      `_getPlanByGoal`.
- [x] Left the outcome/facet path untouched — it's already `plan.id`-correct.
- [x] `_planByGoal` set on create; persists after completion since plans are never
      evicted from `_plans` today — preserves current one-plan-per-goal dedupe.

**Tests.**
- [x] Unit (`tests/unit/planning.execution.test.ts`): 2-step dependent completion
      plan, feed matching `action.outcome` into `onCognitiveEvent`, assert steps →
      `completed`, plan → `completed`, `plan.completed` fired; failing step →
      `plan.failed`; **and an outcome stamped with the goalId (the old key) is NOT
      resolved** — only `plan.id` advances a step. 433/433 unit green; replay
      equivalence byte-identical.
- [x] Full-stack integration through the real ActionExecutor
      (`plan.step.dispatched → decision.record → action.outcome`) — shipped in
      `tests/integration/planning.execution.integration.test.ts` (see "Full-stack
      planning integration test" below).

---

### 🟠 P2 — Reaped facet leaves PlanningEngine holding a dead handle

**Symptom.** Under attention pressure the supervisor LRU-evicts a plan's facet, or
the idle reaper reclaims it after `idleTtlTicks`. The facet is `destroy()`ed and
removed from the supervisor, but `PlanningEngine._activeFacets` keeps the stale
handle. The plan stays `step-aware` with a dead supervisor; the next
`facet.report()` silently no-ops (`facet.ts:190`, `if(this._destroyed) return`) and
the plan stalls with no fallback.

**Root cause.** `spawn()` exposes `handle.onReaped` (`facet.supervisor.ts:235`) so
owners can react to involuntary reclamation — `AuditionEngine` registers it;
`PlanningEngine._activateFacet` (`planning.engine.ts:589`) does not.

**Fix. ✅ DONE**
- [x] In `_activateFacet`, after subscribe, register `facet.onReaped(...)` →
      delete the handle + downgrade `executionTier` to `completion` when the plan
      is still `executing`/`ready`.
- [x] Confirmed `_onStepOutcome` then routes through the completion path (the
      downgraded tier skips the facet block; `_executePlans` finishes it).

**Tests. ✅**
- [x] Unit (`planning.execution.test.ts`): draft→execute spawns a (fake) facet,
      fire its captured `onReaped()`, assert tier → `completion`, handle dropped,
      plan still completes + `plan.completed` emitted.

---

### 🟠 P2b — First-cycle `execute` never activated a step-aware facet *(found during P2)*

**Symptom.** A plan that goes straight to `execute` in one executive cycle (no prior
`draft` tick) was created `ready` but `_activateFacet` was only called on the
*existing-plan* branch — so a single-cycle step-aware plan ran with no deliberative
supervisor (every step outcome hit the "no active facet for Tier 1" warn + autonomous
fallback).

**Fix. ✅ DONE**
- [x] In the no-existing-plan `execute` branch, after `status='ready'`, spawn the
      facet when `executionTier==='step-aware'` — mirrors the existing-plan branch.
- [x] Test: first-cycle `execute` step-aware calls `spawnFacet` exactly once.

---

### 🟡 P3 — `revised` plans stall

**Symptom.** A plan revised via the executive `revise` action freezes; it never
re-executes.

**Root cause.** `_ingestExecutivePlans` sets `status='revised'` and rebuilds steps
(`planning.engine.ts:339-357`) but `_executePlans` only runs `ready`/`executing`
(`:423`). Nothing transitions `revised → ready`. (The facet-driven `replan` path is
fine — it keeps status `executing` and calls `_executePlans()`.)

**Fix. ✅ DONE**
- [x] Re-arm in the `revise` branch:
      `status = status === 'executing' ? 'executing' : 'ready'` — in-flight plans
      revise in place (no re-`plan.started`, matching the facet replan path); idle
      plans return to `ready` and (re)start.
- [x] Decision: no re-`plan.started` for an in-flight revise (in-place semantics).
- _Note:_ the no-existing-plan `revise` branch still creates the plan in a
  `revised` holding state (requires a later `execute`) — intentional; revising a
  plan that never existed shouldn't silently auto-run.

**Tests. ✅**
- [x] Unit (`planning.execution.test.ts`): `execute` (1 step) → `revise` (2 steps)
      for the same goal; assert plan stays `executing`, carries the revised steps,
      and dispatches the new `step-0` next tick.

---

### 🟢 P4 — Multiple plans per goal ✅ IMPLEMENTED (full executive integration)

Chosen scope: **Full (planId + prompt)** — the executive can generate and manage
several plans per goal and sees each plan's live status.

**Engine.**
- [x] `_planByGoal: Map<goalId, string[]>` (ordered plan ids; terminal plans stay
      as history, filtered by `_activePlanForGoal`).
- [x] Helpers: `_plansForGoal`, `_activePlanForGoal`, `_resolveIngestTarget`
      (planId → that plan, else the goal's active plan), `_indexPlan`.
- [x] `draft` now **stacks** a new plan; re-assertion guard skips a draft whose
      (non-empty) `expectedOutcome` matches an existing active plan for the goal.
- [x] `validate/execute/revise/cancel` resolve via `planId` when present, else the
      active plan (backward-compatible). `_createPlan` returns the `Plan`.
- [x] `getPlansForGoal` returns all; `getPlan` returns the active plan (falls back
      to most-recent when all terminal). Heuristic "unplanned" filter →
      `!_activePlanForGoal(goalId)`.

**Executive contract.**
- [x] `ExecutivePlanOutput.planId?` (optional → backward-compatible). `parser.ts`
      needs no change — planId rides the raw `[PLANS]` JSON.

**Prompt (generation + execution awareness).**
- [x] New `## Active Plans` section (master mode) listing each live plan:
      `[planId] goal <id>: status, c/t steps (tier) — "expectedOutcome"`. Reads the
      persisted `plan` entities via `ExecutiveContext.plans`.
- [x] `[PLANS]` instructions + example updated: set `planId` to act on an existing
      plan, omit to draft a new one; explicit "multiple plans per goal" guidance.
- [x] `_persistPlans` (and the heuristic command) now persist `expectedOutcome` so
      the awareness section can show it.

**Sync analysis.**
- **GoalManager — no change needed.** `plan.completed` → `pending_verification`
      re-checks the goal's own completion condition next tick and reverts to
      `active` if unmet (`goal.manager.ts:684`). So completing one of several plans
      can't wrongly complete the goal — completion is condition-driven, not
      plan-count-driven. `executive.facet.progress` goalProgress is forward-only.
- **Determinism.** Set index is plain in-memory; the new persisted field is
      additive; prompt changes are recorded-output-derived. Replay + transport
      replay equivalence stay byte-identical.

**Tests. ✅** `tests/unit/planning.multiplan.test.ts` (6): draft stacking; re-assert
dedupe; planId targeting; **two plans per goal run in parallel & complete
independently**; getPlan active/most-recent semantics; `buildExecutiveContext`
surfaces plan entities into `context.plans`.

**Caveat.** The new prompt copy (Active Plans + planId guidance) is additive and
backward-compatible, but whether the LLM *uses* planId well can only be confirmed
in a live run — copy may need tuning against real sessions.

---

### ⚪ P5 — Cleanup / hygiene

- [x] **`publishes()` contract mismatch.** Added `planning.plan.created` to
      `publishes()`. _Finding:_ `.publishes()` has **no consumers in `src`** —
      schema registration happens entirely via `globalSchemaRegistry.register(...)`
      in `event.schemas.ts` (where `planning.plan.created` already lives with a real
      validator). So `publishes()` is currently documentary; the fix keeps the
      declaration accurate. (Broader cleanup — make `publishes()` authoritative or
      delete it across all engines — is out of scope.)
- [x] **Dead `events[]`.** Removed the never-pushed `events` array from `react()`
      (now returns `{ commands }`) and dropped the now-unused `SimulationEvent`
      import.
- [x] **Session-log `tick: 0`.** Added `_lastTick` (set each `react()`), used by
      `_dispatchSteps` / `_onStepOutcome` session-log writes; dropped their unused
      optional `tick?` params. Telemetry-only (never replay state).
- [x] **Per-tick re-serialize of terminal plans.** `_persistPlans` now persists a
      completed/failed/rejected plan **once** (tracked in `_persistedTerminal`) then
      skips it — terminal plans never change, so re-serializing them every tick was
      unbounded write amplification as plans accumulate. Verified: snapshot/restore
      test only constrains the ConfidenceCalibrator (not plan persistence); replay
      equivalence byte-identical. Test in `planning.execution.test.ts`.
      _Note:_ non-terminal plans still persist every tick (they change); a full
      per-field dirty-tracker is unnecessary given this covers the growth case.
- [x] **`_energyLevel` — kept as-is.** Reviewed: it's valid diagnostic state
      surfaced in `snapshot()`; real energy gating lives in the AttentionAllocator.
      Not vestigial enough to justify churning the snapshot shape. No change.

### 🟢 P6 — Plan-entity retention / GC ✅ DONE

`_plans` / `_planByGoal` / `_persistedTerminal` grew unboundedly as plans
completed (plans were never evicted). The P5 persist fix removed the per-tick write
cost; this bounds the accretion itself.

- [x] `_gcTerminalPlans(tick, commands)` (run in `react` before persist): evicts a
      terminal (completed/failed/rejected) plan — from `_plans`, `_planByGoal`,
      `_persistedTerminal`, `_terminalAt`, any facet — and emits a `commands.delete`
      for its state entity, once it's been terminal longer than
      `planRetentionTicks` (config, default 300).
- [x] `_terminalAt` records the sim tick each plan became terminal (set in
      `_onPlanCompleted` / `_onPlanFailed` / cancel). Deterministic; window compared
      against sim ticks (R2-safe). `react` commands gained a `delete: []` channel.
- [x] Test (`planning.execution.test.ts`): a completed plan is retained within the
      window, then evicted + its entity deleted past it.

### 🟢 Full-stack planning integration test ✅ DONE

- [x] `tests/integration/planning.execution.integration.test.ts`: wires the **real**
      `ActionExecutor` + `InnateExecutor` + `EffectorRegistry` to `PlanningEngine`
      over a real `CognitiveBus`, with a tiny orchestration loop applying
      handler-returned + `drainCommands()` state. Asserts the end-to-end chain
      `plan.step.dispatched → decision.record → action.outcome (echoes plan.id) →
      step completes → plan.completed` — the regression guard for the P1 `plan.id`
      echo that unit tests could only assert in isolation.

---

## Execution order

1. [x] **P1** — re-key + secondary index (unblocks the whole pipeline)
2. [x] **P1 tests** — unit regression (`planning.execution.test.ts`); full-stack
       integration deferred (seam covered by unit)
3. [x] **P2** — `onReaped` registration + tier downgrade
4. [x] **P2b** — first-cycle `execute` activates a step-aware facet (found in P2)
5. [x] **P3** — re-arm revised plans (`executing`/`ready`)
6. [x] **P5** — hygiene sweep: publishes ✓, dead `events[]` ✓, session-log tick ✓,
       persist-terminal-once ✓; `_energyLevel` reviewed & kept
7. [x] **P4** — multiple plans per goal (full executive integration: planId +
       Active Plans prompt section + context awareness)
8. [x] **P6** — retention GC of terminal plans + full-stack integration test

### Status: ✅ COMPLETE — P1–P6 + P2b all shipped & tested. Nothing open.
- **462 tests green** (unit + integration) · typecheck clean · replay +
  transport-replay equivalence byte-identical throughout.
- PRs: #118 (P1–P3/P2b/P5-core) · #119 (P4) · #120 (persist-terminal-once) ·
  #121 (awareness scoping) · #122 (mechanism/policy seam) — all merged ·
  P6 GC + full-stack integration test shipping now.

---

## Determinism notes

All fixes are tick-deterministic and replay-safe:
- Re-keying is pure in-memory map structure — no new RNG, no wall-clock, no new
  persisted fields (plan entities already serialize `id` + `goalId`).
- `onReaped` downgrade is driven by the supervisor's sim-tick reaper — deterministic.
- The `revised → ready` flip is derived from recorded executive output (R2-safe).
- Watch the `replay.equivalence` / `transport.replay.equivalence` integration tests
  stay green after each step.

---

*Created from the planning-pipeline architecture review.*

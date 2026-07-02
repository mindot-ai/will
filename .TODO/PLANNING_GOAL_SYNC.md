# Planning ↔ GoalManager — flow alignment audit

Audit of every flow between `PlanningEngine` and `GoalManager`, with the gaps found
and fixed. Goal here: a plan and the goal it serves never drift out of sync.

---

## The bidirectional contract

### GoalManager → Planning (a goal's state should govern its plans)
| Signal | Before | Now |
|---|---|---|
| `goal.achieved` (bus) | Planning ignored it → plans kept dispatching for a done goal | ✅ Planning subscribes → `_cancelPlansForGoal` (rejects active plans, tears down facets) |
| `goal.abandoned` | **Not a bus event** (session-log only) → planning couldn't react | ✅ `abandonGoal` now publishes `goal.abandoned` (schema-registered) → Planning cancels the goal's plans |
| `goal.blocked` (bus) | Planning ignored it | ⚪ Intentional — `blocked` is transient (stuck, may resume); cancelling its plan would be wrong. Left as-is |

### Planning → GoalManager (plan outcomes should inform the goal)
| Signal | Status |
|---|---|
| `plan.completed` (bus) | ✅ GoalManager → `pending_verification` → re-checks the goal's own completion condition next tick, self-reverts to `active` if unmet. Correct under multi-plan (completion *might* satisfy the goal → worth a check) |
| `plan.failed` (bus) | ⚪ **Intentionally not consumed.** Under multi-plan per goal + condition-driven completion, one plan failing neither satisfies nor fails the goal — there's nothing to recompute. The executive sees the failure via recent outcomes / Active Plans and decides whether to replan. Auto-failing the goal on a single plan's failure would be wrong |
| `action.outcome` (bus) | ✅ GoalManager `_nudgeActionGoals` advances action-type goals by domain/tag — independent of the plan layer |
| `executive.facet.progress` (bus) | ✅ GoalManager applies `goalProgress` (forward-only), forwards `newGoals` / `goalsToAbandon` / `newBeliefs` |

### Shared lifecycle invariant (now closed)
A goal reaching a **terminal** state (achieved or abandoned) cancels every still-active
plan pursuing it. A plan whose *own* completion triggered the goal is already terminal
and is skipped — so only *sibling* plans (multi-plan per goal) get reaped. Cancelled
plans go `rejected` → retention GC deletes the entity.

---

## Gaps found & fixed (this pass)

1. **🔴 Plans outlived their goal.** PlanningEngine subscribed to *no* goal lifecycle
   event, so a plan kept dispatching steps after its goal was achieved or abandoned
   (wasted actions; confusing activity stream). → subscribe to `goal.achieved` /
   `goal.abandoned`; `_cancelPlansForGoal`.
2. **🟠 `goal.abandoned` wasn't observable.** It was written to the session log only,
   never published — so no faculty could react to abandonment. → published as a bus
   event (`goal.manager.ts` `abandonGoal`), added to `publishes()`, schema registered
   in `event.schemas.ts`.

## Reviewed & deliberately left as-is

- **`plan.failed` → GoalManager**: not consumed, by design (see table).
- **`goal.blocked` → Planning**: not consumed; blocked is transient, not terminal.
- **`getPlan` / `getPlansForGoal`**: read-only goal-scoped accessors; unaffected.

## Determinism

`goal.abandoned` is published from deterministic paths; `_cancelPlansForGoal` runs in
`onCognitiveEvent` (deterministic bus delivery), mutates in-memory plan state + stamps
`_terminalAt` from the sim tick. No RNG/wall-clock. Replay + transport-replay
byte-identical.

## Tests
`tests/unit/planning.goal-sync.test.ts`: plan cancelled on `goal.achieved`; on
`goal.abandoned`; an already-completed plan is left untouched (no double-handling);
`GoalManager.abandonGoal` emits the `goal.abandoned` bus event. 468 tests green.

---

## ✅ plan.cancelled activity event (will-side done)
`_cancelPlansForGoal` publishes a `plan.cancelled` bus event (planId/goalId/reason/
steps/requester); added to `publishes()`, the `ActivityEvent` union (`plan_cancelled`),
and `addActivityListener`'s topic/type maps. The **socket** path
(`transport.controller.ts`) forwards it generically — works now (will runs from src).

## ⏳ Pending backend sync (separate repo, deliberate)
The `plan.cancelled` **SSE** closure lives in `backend` (`routes/v1/wills.ts`: add
`plan_cancelled` to the terminal-close check) and is deferred to a backend sync.

> **Heads-up captured during this work:** `will/dist` (the built artifact `backend`
> consumes via `workspace:*`) is **committed but stale** — last built at `6097f82`,
> before this session. So `backend` currently has *none* of this session's will
> changes (P1–P6, awareness, maturation, goal-sync, plan.cancelled). The backend
> sync must **rebuild + commit `will/dist`** (or move dist to a CI/release build)
> before any of it reaches the backend. Verified: committed `dist/index.d.ts` has
> `relevantPlanIds: 0`, `plan_cancelled: 0`, `_planByGoal: 0`.

---

*Created from the planning↔goal-manager alignment review.*

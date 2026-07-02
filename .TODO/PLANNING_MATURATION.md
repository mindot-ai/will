# Will — Planning Maturation (substrate vs. policy)

> The hardcoded `planning.engine` was a startup compromise so a fresh mind could
> plan/execute before a customer ever saw it (the same reason we gave it a
> communication faculty). The long-term question: do we eventually remove it and
> let the mind invent planning on its own? **No — we mature it.** Split the engine
> into a fixed deterministic **substrate** (mechanism) and a swappable **policy**
> (skill), then progressively hand the *policy* to the learned/LLM layer while the
> substrate stays put. This doc is the roadmap.

---

## The reframing

The binary "keep the engine vs. let the mind learn planning" is the wrong axis.
The engine bundles two different things; only one should ever be learned:

| MECHANISM (substrate — keep fixed & deterministic) | POLICY (skill — progressively learn / delegate) |
|---|---|
| plan lifecycle FSM; `_computeReadySet` DAG dispatch; `_onStepOutcome` correlation; facet spawn/reap; `_plans`/`_planByGoal` indices; persistence; bus contracts; awareness projection | what to plan; goal→step decomposition; tier choice; when to replan; the heuristic fallback templates |

Two grounding reasons this is right (not a compromise to undo):

1. **Biology.** Brains don't learn the *capacity* to plan from a blank slate — the
   prefrontal substrate is innate; experience fills it with strategies. A
   structured substrate is *more* faithful, not less. (Cf. we did **not** delete a
   "communication engine" to teach the mind to talk — AuditionEngine is still a
   faculty; the mind learns *what to say* within it.)
2. **Determinism.** The whole system rests on R2 replay-equivalence + snapshots.
   Any persistent, replayable, auditable planner must externalize plan state into
   deterministic entities across ticks — i.e. it converges on *needing this
   substrate*. The engine is the skeleton the learned muscle attaches to, not
   training wheels.

**The real risk is coupling to the engine's *implementation*, not its existence.**
Protection = interface discipline: consumers depend on the contracts, never the
internals.

### Interface invariants (the swap surface — keep stable)
- Bus: `plan.started` / `plan.step.dispatched` / `plan.step.outcome` /
  `plan.completed` / `plan.failed`.
- Executive I/O: the `[PLANS]` schema (`ExecutivePlanOutput`, incl. `planId`).
- Awareness: `ExecutiveContext.plans` + the `plans` awareness scope.
- Public API: `getPlan` / `getPlansForGoal` / `addActivityListener`.

As long as these hold, the planner implementation (hardcoded → learned → emergent)
can change with zero blast radius.

---

## ✅ Phase 0 — draw the line in code (shipped, then retired)

> **Update:** the fallback-policy seam (`planning.policy.ts`, `_generateFallbackPlans`,
> `planningPolicy` config, `minGoalPriority`) has since been **removed**. With the
> heuristic dropped (Phase 1) and the executive established as *the* planner, a
> fallback planner for goals the mind didn't deliberately plan is vestigial — it
> tensions with deliberate planning. The mechanism/policy boundary is now carried by
> the **emergent tier + executive-as-planner**, not a fallback-injection point.
> Trivially re-addable if a learned/no-LLM bootstrap planner is ever needed.

Originally: extract the hardcoded planning *policy* behind an injectable seam so the
engine is pure substrate.

- [x] `planning.policy.ts`: `PlanningPolicy` interface (`proposeFallback(goal,
      state) → {steps, feasibility} | null`) + `HeuristicPlanningPolicy` (the
      tag-driven templates, moved verbatim out of the engine).
- [x] `PlanningEngineConfig.planningPolicy?` — injectable; defaults to
      `HeuristicPlanningPolicy`. Engine wraps proposals into the Plan substrate
      (identity/lifecycle/persistence) and no longer knows step content.
- [x] Behaviour-preserving by default; deterministic (policy reads sim metrics
      only). Tests: `tests/unit/planning.policy.test.ts` (default parity, custom
      injection, abstention, pure heuristic logic). 460 unit green; replay +
      transport-replay byte-identical.

The policy can now be **shrunk, disabled (`heuristicFallback: 0`), or swapped**
without touching the substrate.

---

## Roadmap (eval-gated; do not hard-cutover anything)

Each step moves load from fixed → learned and is gated on evals holding (success
rate, goal-completion, cost/latency) before advancing.

- [x] **Phase 1 — drop the heuristic (done, stronger than "shrink").** The executive
      is the real planner (always wired), so the hardcoded tag→template heuristic
      was removed entirely: `HeuristicPlanningPolicy` deleted, `heuristicFallback`
      config gone, the engine now generates **no fallback plans by default**. The
      `PlanningPolicy` seam stays so a *learned* policy can be injected for a
      bootstrap/no-LLM mode. Nothing essential was lost — vitals are governed by the
      involuntary regulators + executive guidance, and the ActionExecutor still
      emits a bare `observe` before the executive's first cycle. (PR: drop-heuristic.)
- [x] **Phase 2 — delegate per-decision policy (complete).**
      - [x] **Tier choice → emergent (done, better than "learned upfront").** Removed
        `executionTier` from the executive contract entirely. The engine infers the
        supervision mode: top-down (`_inferInitialTier` — high-priority goal or
        low-confidence plan → start `deliberate`) + bottom-up (`_shouldEscalate` —
        an `automatic` plan escalates to `deliberate` on a surprising step outcome).
        Attention is *recruited by surprise*, not pre-allocated. Terminology also
        moved to `automatic`/`deliberate`, and the per-report guidance is now
        facts-only (the engine stopped coaching the facet's decision).
      - [x] **Replan surfaced + measured (done).** A mid-flight `replan` now raises a
        `plan.replanned` signal (mirrors `plan.escalated`) so the master is aware its
        plan was rewritten, and *every* supervisory directive is tallied into
        `planning.supervision.*` metrics (replan/retry/skip/escalate/abandon counts).
        Closes Phase 2 — and produces the first planning-quality signal an eval harness
        can read. The decision-vocabulary copy is already explicit (the facet's focus
        contract) and guidance is already facts-only, so "make the policy explicit" was
        also already satisfied.
- [~] **Phase 3 — plasticity dial (largely superseded).** The dial was meant to gate,
      per-decision, what stays `fixed` vs is `delegated-to-mind` — but its targets have
      *all already moved to the mind* via the work above: the fallback policy was
      removed (Phase 0 retired), tier choice is emergent (Phase 2), and replan +
      goal→step decomposition are the executive/facet's calls. There is no fixed policy
      left to dial. **Re-scope:** a plasticity dial only becomes meaningful again if a
      *learned / no-LLM* planning policy is ever injected (the `PlanningPolicy` seam was
      removed too, but is trivially re-addable); a dial would then gate *that*. Not
      current work.
- [ ] **Phase 4 — emergent planning *alongside* (long-term; eval-gated).** Extracted to
      its own file: **[`__EMERGENT_PLANNING_TODO.md`](./__EMERGENT_PLANNING_TODO.md)**.
      In short: let the mind compose reusable planning *strategies* (meta-planning) on
      the substrate, run them in parallel with executive planning, and prefer them only
      where they provably win on evals. Not started; gated on the eval harness (now done)
      + a demonstrated need. Never a hard cutover.

### Eval harness — ✅ DONE (`tests/eval/planning.eval.ts`)

Every phase above was "eval-gated," and Phase 2 made it *feasible* (planning quality is
now observable: `planning.supervision.*` + plan completed/failed/cancelled/escalated/
replanned + goal-completion). Built now: **`PlanningEvalHarness`** — a deterministic,
no-LLM scenario runner that drives the real `PlanningEngine` + `GoalManager` and returns
a `PlanningScorecard` (plans completed/failed/stuck, goals retained/abandoned,
supervision distribution, ticks, completion rate). Same scenario ⇒ byte-identical
scorecard (R2), runs in CI, gates regressions.

**It correlates with the PMA directly:** the scenario's `persona` IS the `engine-config-*`
params the PMA seeds (grit, conscientiousness). Pin it for reproducible regression
scoring; *sweep* it to measure how personality shapes planning. The standard suite
already sweeps both — proving higher conscientiousness completes a stuck step (#136) and
grittier personas hold stale goals (#134). Tests: `tests/eval/planning.eval.test.ts`.

### Non-goals
- Removing the substrate. (It's inevitable for determinism/persistence/audit.)
- A from-scratch, in-context-only planner. (Non-replayable, expensive, fragile.)

---

## Supervisory decision vocabulary (the facet's control verbs)

The directives a deliberate-tier facet can issue: **continue / retry / skip / pause /
replan / escalate / abandon / complete** (each maps to a real engine op).

- **Fixed, not learned** — it's the substrate's *operation set* (the orders the
  orchestrator can mechanically execute), like an ISA. What's learned is *which*
  directive to choose when, which is already the facet's (the mind's) job.
- **Bounded, not open-ended** — a *supervisor's* decision space is naturally
  bounded (let-run / intervene / hold / stop / rethink / defer). Open-ended dynamism
  belongs to the *step content* (any/composed effector) and *plan authoring* (the
  executive), not the control verbs. (We deliberately do **not** go full
  Claude-Code-style open control here — that would dissolve deterministic
  orchestration and re-merge decider+doer.)
- **Completed** — added `retry` (re-attempt the failed step, capped by
  `maxStepRetries`), `pause` (`status: 'paused'` — hold without abandoning; frees
  the facet; re-arms on the next `execute`), and `escalate` (hold + `plan.escalated`
  signal so the master re-decides, alongside its Active Plans awareness). The
  guidance prose is facts-only; the vocabulary lives in the facet's focus contract.

---

## First candidates to delegate (most-hardcoded policy today) — all resolved
1. ~~`HeuristicPlanningPolicy` templates~~ — **removed** (Phase 1).
2. ~~Tier defaulting~~ — **emergent** now (Phase 2): the engine infers the tier, the
   executive no longer sets it.
3. ~~Replan/skip/abandon guidance copy~~ — **done**: guidance is facts-only and the
   decision vocabulary is explicit in the facet's focus contract (lean-guidance
   refactor); replan is now also surfaced + measured (Phase 2).
4. ~~Draft re-assertion dedupe + `minGoalPriority` / top-2 fallback caps~~ — **moot**:
   the fallback policy was removed entirely, so these caps went with it. Re-applies only
   if a learned policy is ever injected.

> Net: nothing hardcoded remains to delegate. The policy is the mind (executive/facet);
> the engine is pure substrate. The only forward work is the optional eval harness +
> the long-term meta-planning direction (Phase 4).

---

*Created from the "should we eventually remove the planning engine?" discussion.*

# Will — Planning as a top-down prior (not a dispatcher)

> **Standing:** SHIPPED · 2026-07-02 · 16 of 16 — a plan biases the one action competition instead of dispatching steps; no parallel command channel. Pre-public: exact date not recorded

> Re-ground the planning **execution leg** onto the agency substrate. A plan stops
> *dispatching* steps to an executor and instead *biases the one action competition*
> toward the actions that serve its current frontier. The ordinary `ActionSelector`
> enacts the winner as the situation affords it; step outcomes are read from
> reafference; the plan advances. One action path, no parallel command channel.
>
> **Status: ✅ complete.** Branch `feat/planning-as-prior`. Full suite 873 pass / 1
> skip; typecheck clean; determinism guard green. The dispatcher is gone; a plan
> biases the one competition end-to-end (proven by `tests/integration/planning.as-prior.test.ts`).

---

## Why this is NOT `__EMERGENT_PLANNING_TODO`

| | This doc (planning-as-prior) | `__EMERGENT_PLANNING_TODO` (meta-planning) |
|---|---|---|
| Concern | how a plan **enacts** (execution coupling) | where plan **structure** comes from (strategy learning) |
| Change | dispatcher → top-down prior on the competition | executive authoring → learned reusable strategies |
| Gating | correctness + determinism; ships now | eval-dominance; long-term, not started |

They are orthogonal and compose: once planning enacts through the competition, a
recurring plan can later *proceduralize into a composite schema* — which is the
emergent-planning end-state reached through the agency substrate's own learning loop
rather than a bolted-on meta-planner. So this work is a prerequisite that makes the
emergent direction *cheaper*, but it is its own change.

## The principle (the North Star this realizes)

From `AGENCY_PIPELINE_TODO.md`: *"A mind does not possess actions; it finds them in
the situation."* The current planner violates this — it `plan.step.dispatched` →
directed `agency.intent` (`status:'selected'`) that **bypasses** the affordance
competition. A plan should instead behave like the executive's **ideomotor** intents
already do (synthesizer §172-193): an imagined action enters the field *pre-activated*
but **still competes**; it never bypasses selection.

Biologically: the PFC does not drive M1 directly — it **biases basal-ganglia action
selection** (the exact model `action.selector.ts` already cites). A plan is sustained
top-down bias on a competition, not a command stream.

## The clean model

```
PlanningEngine (executing plan)
   └─ project ready FRONTIER step(s) as `plan.prior` entities      (NEW · transient, rebuilt each tick)
AffordanceSynthesizer
   └─ reads plan.prior → emits competing affordances (source:'plan',  (NEW block, mirrors ideomotor)
      carrying planBias + planId/stepId provenance)
ActionSelector
   └─ competition (UNCHANGED) — plan affordance wins on its merits + planBias,
      or is deliberated (System 2). Committed intent carries planId/stepId.
MotorSchemaExecutor  (ALREADY plan-agnostic — no change)
   └─ enacts winner → emits action.outcome{planId,stepId}
PlanningEngine.onCognitiveEvent('action.outcome')
   └─ _onStepOutcome advances the frontier (UNCHANGED logic)
```

Key consequences:
- **No directed intents, no dispatch, no `source:'plan'` bypass.** The plan biases; the
  field competes; the body enacts what it affords.
- **No orphaning.** A plan affordance that loses the competition (or whose async intent
  is preempted) just re-projects next tick — the step stays on the frontier, never
  stranded. Robust by construction.
- **Vocabulary mismatch dissolves.** A step's `action` becomes an *advisory suggested
  schema*: if it resolves in the repertoire it surfaces as a boosted candidate; if not,
  the prior simply doesn't surface (the plan waits / replans) — no forced execution of
  an unresolvable string.
- **The executor needs zero plan-specific code** — `readIntent`/`_emitActionOutcome`
  already thread `planId`/`planStepId` generically; they now get populated from the
  affordance→intent provenance instead of the dispatch payload.

## Facet conclusion (settled before implementation)

Both the planning facet and the deliberation facet are minted by the **same**
`spawnFacet()` → `FacetSupervisor`, sharing **one** bounded attention budget and the
unified PromptFactory (one self). They are two *roles* of one mechanism:
- **Action-selection** (which concrete action now) — fully absorbed by the deliberation
  facet via the field. The dispatcher disappears here.
- **Supervision** (is this intention progressing / continue·retry·replan·abandon) — a
  slower metacognitive loop, recruited by surprise; stays the planning facet's job. It
  must NOT collapse into per-action deliberation (different timescale).

So: keep two focus-modes, one mechanism, one budget. Planning's facet sheds its
implicit action-dispatch role and narrows to pure supervision (which its own focus
instructions already claim: *"Your ONLY role: evaluate step outcomes…"*).

---

## Items

### Phase 0 — agency substrate carries plan provenance + bias
- [x] `agency/types.ts`: add `'plan'` to `AffordanceSource`; add `planBias?`,
      `planId?`, `stepId?` to `Affordance`.
- [x] `agency/selection.scoring.ts`: add first-class `plan` weight to `ScoreWeights`
      (default 0.30) + `+ w.plan * (a.planBias ?? 0)` term in `scoreAffordance`. Keeps
      top-down influence legible/tunable (not hijacking `expectedReward`, which
      reafference learns).
- [x] `affordance.synthesizer.ts`: new block reading `plan.prior` entities → build a
      competing affordance per prior (mirrors the ideomotor block): resolve the
      suggested schema, `source:'plan'`, salience high (frontier is willed), thread
      `planBias`/`planId`/`stepId`/`targetEntityId`/`parameters`. Thread the three new
      fields through `_build` ctx + `_toEntity` metadata. Unresolvable schema ⇒ skip.
- [x] `action.selector.ts`: `readAffordance` reads the three new fields; the committed
      intent metadata carries `planId`/`stepId`. (`effectiveWeights` picks up `plan`
      automatically via the `DEFAULT_WEIGHTS` spread.)

### Phase 1 — planning projects priors instead of dispatching
- [x] `planning.engine.ts` `PlanStep.status`: `'dispatched'` → `'active'` (on the
      frontier, biasing). Reinterpret `action` as the advisory suggested-schema; add
      optional `targetEntityId?`/`tags?`. Mirror in `PlanContext` + persistence.
- [x] Replace `_dispatchSteps` with `_projectFrontier(commands, tick)`: clear prior
      `plan.prior` entities, re-emit one per active frontier step of each executing
      plan (`plan-prior-${planId}-${stepId}`), strength from goal priority ⊕ plan
      confidence. Mark ready steps `active` (not `dispatched`); keep projecting while
      `active`.
- [x] `react`: call `_projectFrontier` after `_executePlans`. Stop projecting / clear
      priors for terminal/cancelled plans (`_cancelPlansForGoal`, `cancel`).
- [x] `_onStepOutcome`: UNCHANGED advance logic (now fed by competed outcomes). Update
      the `'dispatched'` marker in `_buildPlanFocusSection` to `'active'`.
- [x] `publishes()`: drop `plan.step.dispatched`; add `plan.step.activated` (awareness
      continuity). Awareness rename `step_dispatched` → `step_activated`
      (`ActivityEvent` union + `PLAN_TOPICS`/`TYPE_MAP` in `addActivityListener`).

### Phase 2 — executor sheds plan coupling
- [x] `motor.schema.executor.ts`: remove `plan.step.dispatched`/`plan.step.cancel` from
      `subscribes()` (→ `[]`) and delete their `onCognitiveEvent` handling. Keep the
      generic `planId`/`planStepId` threading in `readIntent`/`_emitActionOutcome`.

### Phase 3 — event schema + wiring
- [x] `event.schemas.ts`: register `plan.step.activated` (replacing dispatched);
      `plan.prior` is a transient entity (no bus schema needed, like `affordance`).
- [x] `mind.ts`: confirm tick order (planning before synthesizer — already true via
      registration order) so priors are visible same-tick. No new wiring otherwise.

### Phase 4 — tests
- [x] Rewrite `agency.execution.test.ts` plan-step cases (no more dispatch→intent).
- [x] Update `planning.execution.test.ts` + other `planning.*` suites that assert
      `plan.step.dispatched` (synthetic `action.outcome` feed still drives
      `_onStepOutcome`, so advance assertions hold; only the dispatch-event
      assertions change → `plan.step.activated`).
- [x] NEW integration test: real `PlanningEngine` + synthesizer + selector + executor —
      a plan whose frontier step's suggested schema is an innate sync stance competes,
      enacts, emits `action.outcome{planId,stepId}`, and the plan advances/completes.
      (Closes the long-standing "seam untested end-to-end" gap.)
- [x] Determinism guard (already covers `src/cognition/agency`) stays green: priors use
      `tick`+stable keys, rebuilt each tick, no RNG/wall-clock.

## Follow-ups
- **External-effector transport bridge — ✅ DONE** (branch `feat/agency-transport-bridge`).
  The stem now buffers `agency.invocation` (was the dead `effector.invoked`); the host
  ack reconciles agency-natively — `confirmExecution` reads the awaiting `agency.intent`
  (correlation handle = intent id), calls `reconcileInvocation` (carrying the efference
  copy + planId/stepId), and the ReafferenceEngine learns, frees the intent, and emits
  the `action.outcome{planId,stepId}` the planner advances on (the sole emitter for the
  async path — no double-advance vs the executor's sync/timeout emit). No more
  `decision.record`/`effector.confirmed`. Host-facing wire names (`effector_invocation`
  channel, `effector.invoked.ack`) kept for backend compatibility. So host-owned plan
  steps now execute end-to-end.
- **Condition-driven step completion** (a step satisfied by an observed world-condition
  regardless of which action produced it). v1 advances via attributed outcomes
  (reuses `_onStepOutcome`); the condition path is a clean additive extension later.
- **Step → composite expansion** (a high-level step with no single matching schema
  proceduralizing into a learned composite). Deferred to the emergent direction.

---

*Created from the "plan should be a prior, not a dispatcher" + facet-unification
conclusion. Companion to `PLANNING_MATURATION_TODO.md` (substrate/policy) and
`AGENCY_PIPELINE_TODO.md` (the competition this biases).*

# Agency Pipeline — mind-like effector system (greenfield)

> **Standing:** SHIPPED · 2026-07-02 · greenfield rebuild, 50 of 50; the old effector stack was deleted in its Phase 8. Pre-public: exact date not recorded

> Pure rebuild of how the Will *acts*. We are **not** migrating the current effector
> subsystem (`src/effectors/*`, `generic.json`, the executors, `ActionExecutor`).
> That whole stack gets deleted in Phase 8. This document is the canonical plan.

## North star

An agent framework treats effectors as **things the mind has** — a catalog it queries:
*given a goal, find the matching tool, fill its args, call it.* A mind does not possess
actions; it **finds them in the situation**. Capability is a **relation between a
body-in-a-state and a world-as-perceived**, not a row in a table.

So the pipeline is a perception → selection → enaction → learning **cycle**, not a
registry lookup:

```
senses → percepts                                     (existing: Exteroception)
AffordanceSynthesizer → affordance field              (NEW · no LLM · attention-gated)
affective / reward / novelty / threat → bias signals  (existing engines, on the bus)
ActionSelector → biased, gated competition            (NEW · no LLM)
   ├─ clear / habitual → enact directly                            (System 1)
   └─ ambiguous / high-stakes → ExecutiveEngine (LLM) adjudicates  (System 2)
                              → outputs inject ideomotor activation back
MotorSchemaExecutor → bind params · efference copy · execute/expand (NEW)
reafference (outcome percept) → prediction error
   → value / param / habit updates → repertoire grows, decays      (NEW · the learning loop)
PMA → repertoire + dispositions travel across re-embodiment        (NEW codec)
```

The organizing principle is the **instrumental → habitual gradient**: every schema
lives on a continuum (deliberate → mixed → proceduralized). Learning moves it along.
LLM spend *falls* over a Will's lifetime as common actions proceduralize — the opposite
of an agent loop.

## What this layer consumes (does NOT reimplement)

It reads, it never owns:
- `percept` entities — from Exteroception / the sense engines.
- `known-entity` (`ke-*`) dossiers — from KnownEntityTracker.
- Body metrics — `energy.level`, `stress.load`, `affect.valence`, `affect.arousal`,
  `attention.capacity`, `attention.effort`, `sleep.pressure`.
- Bias signals on the cognitive bus — reward (RewardEvaluator), novelty
  (NoveltyDetector), threat (ThreatEvaluator), drives (regulatory engines).
- Gating — EffortGate / InhibitionController become the NoGo pathway.
- GoalManager — goal relevance for the competition.

## Module layout (`src/engines/agency/`)

> Relocated under `src/engines/` alongside `src/engines/cognition/` in the repo
> reorg (aliases: `#agency`→`src/engines/agency`, `#cognition`→`src/engines/cognition`).

```
src/engines/agency/
  types.ts                     [P0] core contracts — Affordance, MotorSchema, …
  schemas/
    innate.ts                  [P0] the always-on floor of schema templates
    repertoire.ts              [P3] learned/template store + skill stats
    primitives/                [P2] primitive schema bodies
      orient.ts, internal.ts, communicate.ts, external.ts
  affordance/
    synthesizer.ts             [P0] AffordanceSynthesizer engine (head of pipeline)
  selection/
    scoring.ts                 [P1] activation function
    selector.ts                [P1] ActionSelector engine (competition + entropy)
  execution/
    executor.ts                [P2] MotorSchemaExecutor engine (+ efference copy)
  learning/
    reafference.ts             [P4] prediction-error → value/param/habit updates
  pma/
    competence.codec.ts        [P6] distill/load the competence layer
  index.ts                     barrel
```

## New entity & bus vocabulary

Entities (written to SimulationState):
- `affordance` — one per possibility this tick (transient; field is rebuilt each tick).
- `agency.skill` — a persisted LearnedSkill (habit strength, value, param priors).
- `agency.intent` — the selected affordance committed for enaction (replaces
  `decision.record` for this layer).
- `agency.outcome` — reafference: predicted-vs-actual, prediction error.

Cognitive-bus events:
- `affordance.field.synthesized` (v1) — `{ size, availableCount, tick }`
- `agency.selection.made` (v1) — `{ schema, activation, entropy, tick }`
- `agency.selection.ambiguous` (v1) — `{ topSchemas, entropy, tick }` → recruits LLM
- `agency.enacted` (v1) — `{ schema, success, outcomeQuality, surprise, tick }`
- `agency.skill.proceduralized` (v1) — `{ schema, habitStrength, tick }`

## Determinism / replay rules (hard constraints)

- No `Math.random()` / `Date.now()` in anything that affects logic. Use `tick` +
  stable keys for entity ids; draw randomness only from `context.prng` if ever needed.
- Engines read the frozen `ReadonlySimulationState` and emit `StateCommands` only —
  never mutate state. Let StateManager stamp `createdAt/updatedAt/updatedAtTick`.
- Affordance ids: `affordance-${tick}-${schema}-${targetOrKey}`.

---

## Phases

### Phase 0 — Foundations  ⟶ in progress
- [x] `#agency/*` tsconfig + tsup alias
- [x] `types.ts` — Affordance, AffordanceSource, MotorSchema, SchemaPrecondition,
      EfferenceCopy, SchemaOutcome, LearnedSkill, ScoredAffordance, SelectionResult
- [x] `schemas/innate.ts` — innate floor (orient, attend, inspect, reach-out, rest,
      withdraw, reflect, wait, express)
- [x] `affordance/synthesizer.ts` — AffordanceSynthesizer engine: builds the field
      each tick from innate floor + percepts + known-entities, attention-gated, with
      learned priors; emits `affordance` entities + metrics + bus event
- [x] `agency.synthesizer.test.ts` — field is non-empty from innate floor; respects
      preconditions; caps non-innate by attention budget; ids are deterministic (6/6 green)

### Phase 1 — Selection (no LLM)  ⟶ done
- [x] `selection/scoring.ts` — activation = goalRelevance + expectedReward +
      novelty + driveUrgency + habitStrength − cost − inhibition − risk.
      Decisions: **entropy + stakes** recruit the LLM; **additive habit bonus** +
      habit-relief on thresholds. Added a **decision temperature** (0.15) — raw
      activations live in a narrow band, so softmax needs sharpening to read a
      real gap as a confident winner. `stakes` = max(threat, |valence|, novelty·0.5)
      — novelty is deliberately weak so a newborn Will doesn't deliberate on
      literally everything before any habit forms.
- [x] `selection/selector.ts` — soft winner-take-all; competition entropy +
      habit-relieved thresholds; always commits `agency.intent` (System 1 default,
      carries the `deliberate` flag) and publishes `agency.selection.ambiguous`
      when System 2 is needed. Reads bias from goals + drive/threat/inhibition
      metrics.
- [x] tests: 17/17 green — pure scoring, System-1 commit, unavailable excluded,
      intent cleanup, flat-field ambiguity, high-stakes recruit, habit gradient,
      and a synthesizer→selector integration (lonely Will reaches out to a friend)

### Phase 2 — Motor schemas & execution  ⟶ done
- [x] `execution/executor.ts` — consumes `agency.intent`; emits the efference copy
      (predicted reward/valence) on every enaction; resolves sync stances to
      `agency.outcome`; holds communicate/external intents open as `awaiting`
      (efference persisted for reconciliation); **expands a composite into ordered
      primitive sub-intents that run one-per-tick, accumulate, and finalize into the
      composite's own outcome** — created skills are runnable, not inert.
- [x] `execution/primitives.ts` — sync stance bodies (state-grounded, reportorial —
      they don't fight the regulators), plus `communicate` and `external` async modes.
      (Kept as one module rather than `schemas/primitives/*` — fewer files, same seams.)
- [x] **Serial-action refinement** (selector): the Will acts one-at-a-time. The
      selector defers while an intent is `selected`/`awaiting`/`expanding` and no
      longer deletes intents — the executor owns the intent lifecycle. Forward-model
      priors (`expectedReward`/`expectedValence`) are now stamped onto the intent.
- [x] tests: 23/23 green — efference copy recorded pre-act, sync resolve + consume,
      depletion-sensitive outcome, async hold-open, unknown→host, composite runs in
      order & finalizes once, and a selector→executor serial-handoff drive.

> Lifecycle now live: `selected → (sync) outcome+delete | (async) awaiting | (composite) expanding → sub-intents → composite outcome`.
> Async `awaiting` intents are reconciled in Phase 4 (host ack / delivery → outcome); until then the Will stays busy on them by design.

### Phase 3 — Repertoire (skills as first-class)  ⟶ done
- [x] `schemas/repertoire.ts` — in-memory template store (innate floor + learned
      composites) + per-schema `LearnedSkill` stats; `skills()`/`schemas()` accessors,
      `registerComposite`, `recordOutcome`, `decay`, and `export`/`import` for PMA.
- [x] synthesizer + executor `attachRepertoire` — learned composites surface in the
      field and run without a restart; affordances carry learned priors.
- [x] discovery/creation hooks — `agency.schema.discovered` on first enaction;
      `agency.composite.proposed` → `registerComposite` creation seam. (will#197)

### Phase 4 — Reafference & learning (the growth engine)  ⟶ done
- [x] `learning/reafference.ts` — reads `agency.outcome`, folds prediction error into
      value EMA / habit strength / param priors, mirrors `agency.skill` entities,
      consumes outcomes, runs the forgetting curve, emits `agency.skill.proceduralized`.
- [x] tests: 29/29 green — learning rules, proceduralization crossing (once), decay +
      forget, the reafference engine, and an **end-to-end mini-orchestrator** where a
      schema enacted through the full loop proceduralizes (`habit 0.64`) and then the
      learned habit makes selection skip the LLM (novice deliberates, expert doesn't).
- [x] wired RewardEvaluator + ConfidenceCalibrator as update sinks — the executor
      emits `action.outcome` for every enaction (will#195); async `awaiting`
      reconciliation on host ack is done in `learning/reconcile.ts`.

### Phase 5 — Executive integration (LLM narrowed)  ⟶ done
- [x] `deliberation/deliberator.ts` — the System-2 seam. Recruited only when the
      selector marks an intent 'deliberating'; it chooses among the substrate's
      candidate affordances (ideomotor bias) and writes the result back as the
      now-'selected' intent. Never invents actions outside the field.
- [x] **Unified inference (hard invariant honored).** The Deliberator does NOT build
      a bespoke prompt — it reasons through a FACET of the executive consciousness
      (`spawnFacet` → `setFocus` → `report`), sharing the master's persona / identity
      / live self-context via the unified PromptFactory. One self across deliberate /
      converse / narrate — no identity fracture. Message-*content* authoring stays
      with the unified conversation-facet path (AuditionEngine), not duplicated.
- [x] **Graceful System-1 degradation** — no executive (basic tier), facet budget
      full, or director not yet ready ⇒ confirm the substrate's provisional winner.
      Never a stall, never an un-grounded LLM call.
- [x] **Deliberation gate reworked to top-2 margin** (was full-field entropy): the
      ever-present innate floor inflated entropy and made the Will deliberate on
      everything. Now it recruits System 2 only on a genuinely close contender or
      high stakes — habit relief on both gates (the gradient → falling LLM spend).
- [x] wired into `mind.ts` (selector → deliberation → executor; `attachExecutive`
      for non-basic tiers); selector marks `'deliberating'` + carries candidates.
- [x] tests: deliberation unit suite (facet choice, off-list clamp, no-executive /
      budget-full degradation) + selector "ambiguous → deliberating" + the learning
      loop now drives a Deliberator. Full suite 751 green; agency 42/42.

### Phase 6 — PMA competence codec  ⟶ done
- [x] `pma/competence.codec.ts` — `distillCompetence(repertoire)` carries the
      strongest skills (above a forgetting floor, ranked by consolidation) + their
      learned composite templates; `loadCompetence(snapshot, repertoire)` reloads
      them on re-embodiment so a Will *acts like itself*, not just believes/feels
      like itself. Closes the #1 gap from the original analysis.
- [x] `index.ts` barrel for clean wiring.
- [x] tests: 32/32 green — distill carries strong + drops fleeting; round-trip
      across a fresh repertoire restores habits + runnable composite; version guard.
- [x] folded `CompetenceSnapshot` into the real `PMASnapshot` — see step 7 below (done).

### Phase 7 — Wiring & observability  ⟶ done
- [x] registered the four engines in `src/stem/mind.ts` in tick order (synthesize →
      select → enact → learn), ticking last (after senses + known-entity) so the
      field reflects the current tick's percepts/dossiers. Shared `SchemaRepertoire`
      injected into synthesizer/executor/reafference; bus auto-wired by the orchestrator.
- [x] gated behind `WillConfig.enableAgency` (default off) so it runs *alongside* the
      legacy action path in its own entity namespace during the transition — no
      regressions (full suite 743 green).
- [x] added an executor await-timeout (15 ticks) so shadow-mode async intents that no
      host acks don't strand the serial Will.
- [x] telemetry metrics: `affordance.field_size`/`available_count`,
      `agency.selection.entropy`/`deliberate`/`busy`/`activation`,
      `agency.executor.enacted`, `agency.learning.updates`, `agency.skill.count`,
      `agency.habitual.count`.
- [x] determinism guard extended to cover `src/engines/agency` (deterministic ✓).
- [x] live integration test (`tests/integration/agency.pipeline.test.ts`): a real
      assembled mind ticks 100× → field synthesized, intents enacted, a skill
      proceduralizes (`"express" habit 0.64`); gate-off mind produces nothing.

### Phase 8 — Decommission the old stack (staged; see dependency map below)

**Finding (traced 2026-06):** a big-bang rip-out is unsafe — the legacy stack is
load-bearing for things the new pipeline does not own yet:
- `effectorRegistry` is the **permission/grant system** (`PATCH /effectors` →
  `isAllowed`) AND it **gates the senses** (`base.sense.engine` on `listen`,
  `audition.engine` on `listen`/`talk`) AND it feeds the **executive prompt**.
- conversation **authoring + delivery** runs AuditionEngine → ProactiveCommunicator
  (`deliverReply`); the new `communicate` primitive can deliver but cannot yet
  *author the words* — that is Phase 5 (LLM).
So full removal must wait until the new pipeline owns permissions + comms content.
`ProactiveCommunicator` / `ChannelRegistry` / `AuditionEngine` are **delivery/LLM
infra to KEEP**, not the "agent-framework" cruft to delete.

Cutover-enabling groundwork (safe, done now):
- [x] host-ack reconciliation (`learning/reconcile.ts`) — the new pipeline now owns
      host effectors end-to-end: `agency.invocation` → host ack → `reconcileInvocation`
      writes the outcome → reafference learns + frees the awaiting intent. Tested.
- [x] executor await-timeout (15t) — stranded async intents fail gracefully. Tested.

Dependency-ordered cutover (each step breaking → do with confirmation, validate green):
1. [x] **Re-home permissions** — agency-native `AccessGrants` (`permission/grants.ts`)
       now drives sense-gating (`base.sense.engine`) + reply-gating (`audition`) and
       runtime grants (`EffectorController.setAllowed`). `WillStem.setAllowedEffectors`
       (the backend's `PATCH /effectors` entry) is unchanged. Behaviour-preserving:
       grants seeded from the same resolved list, kept in sync with the legacy
       registry until it is deleted. Full suite 755 green; 4 permission unit tests.
2. [x] **Phase 5** — unified-facet deliberation (done above).
3. [x] **Phase 5b** — `MotorSchemaExecutor` delivers `communicate` enactions through the
       kept `ProactiveCommunicator` (outbox/channel-gated), permission-gated on
       `AccessGrants`; words authored by the deliberation/conversation facet. (will#196)
4. [x] **Cutover switch** — when `enableAgency`, the agency pipeline is the SOLE action
       system: the executor's heuristic observe-fallback (`action.executor`) and the
       executive's parameterless `actions[]`→decision.record emission (`commands.ts`,
       gated via `setAgencyMode`) both stand down. Delivery infra (ProactiveCommunicator /
       AuditionEngine) is kept. **Default off** → existing minds unchanged (full suite
       755 green). Integration test asserts no `'heuristic'` decision.records when on.

   ⚠ **Deletion is gated here.** `EffectorRegistry` / `action.executor` / `generic.json`
   are the DEFAULT action system today (`enableAgency` off). Deleting them before the
   agency pipeline is the default-on / only action path would break every existing
   (non-agency) mind + its tests. So the order is: flip `enableAgency` default on →
   soak (real LLM tier) → then delete. Per the chosen plan, the flip + deletion are
   left to the owner once soaked; the switch above makes that a one-line default change.

5. **Rehoming (prereq for deletion) — foundations done, additive + green (755):**
   - [x] **Plan-step execution → agency.** `MotorSchemaExecutor` now subscribes to
         `plan.step.dispatched`/`plan.step.cancel`, converts a step into an
         `agency.intent` (carrying planId/stepId), and on enaction emits the
         `action.outcome{planId,stepId}` the PlanningEngine consumes to advance.
   - [x] **Instruction→goal → agency.** New `intake/instruction.intake.ts` engine
         drains pending instructions → `goalManager.addGoal` each tick (verbatim from
         the legacy ActionExecutor). Not yet registered (activates on cutover).
   - These are additive (not yet wired into registration), so the suite is still 755
     green. Audit confirmed: senses/audition/permissions/executive-deliberation are
     compliant; planning + instruction-intake were the only non-compliant paths.

6. **Deletion increment — DONE (full suite 750 green, tsc clean):**
   - [x] agency always-on: removed `enableAgency`; agency engines + `InstructionIntake`
         registered unconditionally; the agency pipeline is the sole action system.
   - [x] deleted `action.executor.ts`, `innate.executor.ts`, `effectors/registry.ts`,
         `generic.json`, and the dev `innate.world.sandbox.ts`; dropped from
         `EngineRegistry`/`Cognition`/`mind.ts`/registration + `src/index.ts`.
   - [x] stripped the executive effector surface: `getEffectorDescriptions` catalog +
         `newEffectors`/created-effector path + `attachEffectorRegistry`
         (`prompt.factory`/`commands`/`parser`/`types`/`engine`).
   - [x] `AccessGrants` is the sole permission/sense gate (senses + audition + the
         `setAllowed` path); sandbox/runner decoupled; `WorldInterface.getWorldEffectors`
         removed; comments tidied.
   - [x] fixed/removed the legacy-referencing tests (PromptDeps/CommandDeps shape,
         `attachEffectorRegistry`→`attachGrants`; deleted `innate.focus` +
         `planning.execution.integration`; reworked the agency gate-off test).
7. [x] PMA: folded `CompetenceSnapshot` into `PMASnapshot` (`competence?`). The
       distiller embeds learned skills + invented composite schemas (threaded the
       live `SchemaRepertoire` through `PMADistiller.distill` ← `PMAController`); the
       loader re-seeds them via `loadCompetence` so a re-embodied Will resumes acting
       like itself. Omitted when nothing's been learned. 3 round-trip tests; full
       suite 753 green. (Behavioral `topActions` kept — it's a separate log-derived
       descriptor, no longer the only competence trace.)

### Phase 9 — Preemptive serializer (the "smarter serializer")  ⟶ done
- [x] `selection/selector.ts` — the selector no longer freezes while busy. It
      **re-competes every tick** and can **preempt** an `awaiting` action when a
      sufficiently stronger / higher-stakes challenger appears. Switch-cost hysteresis
      (`BASE_SWITCH_COST`) prevents thrashing; **stakes collapse the switch cost** so
      salient/urgent events override immediately; a long-awaited incumbent goes stale
      and yields more readily. New telemetry: `agency.selection.preempted` +
      `agency.action.preempted` event.
- [x] Scope: `awaiting` is the cleanly-preemptible state (executor never enacts it →
      race-free). `selected` (one tick) and `expanding` (composite) are left to finish;
      `deliberating` defers — preempting those would race the executor/deliberator
      intra-tick. tests: 4 preemption cases (keep-waiting, preempt, stakes-override,
      no-churn). Full suite green.
- [x] **composite preemption** (cancel-only) — the selector cancels a mid-`expanding`
      routine for a strong/high-stakes challenger; the executor's `_advance` guard
      drains it. (will#198) Further refinement: immediate-switch preemption needs the
      executor's macro-advance deferred a tick.

— — — Core agency pipeline COMPLETE: perception → competition → deliberation (unified
facet) → enaction → learning → portable competence → preemptive serialization; sole
action system; legacy effector stack retired. — — —

## Remaining work — ✅ ALL DONE (the Channel A/B layer can now begin — see AGENCY_CHANNEL_AB_TODO.md)
- [x] **Phase 5b** — `MotorSchemaExecutor` delivers `communicate` enactions through the
      shared `ProactiveCommunicator` (outbox/channel-gated), permission-checked on
      `AccessGrants`; denial → failed outcome, unauthored reach-out → awaiting. (will#196)
- [x] **Discovery/creation hooks** — `agency.schema.discovered` on first enaction;
      `agency.composite.proposed` → `registerComposite` creation seam. (will#197)
- [x] **Extra learning sinks** — executor emits `action.outcome` for EVERY enaction;
      `ConfidenceCalibrator` (already subscribed) + `RewardEvaluator` (now subscribed)
      learn from agency actions; async host-ack reconciliation in `reconcile.ts`. (will#195)
- [x] **Composite preemption** — selector cancels a mid-`expanding` routine for a
      strong/high-stakes challenger (cancel-only; the executor's `_advance` guard
      drains the macro). Live macro sub vs orphan sub correctly classified. (this PR)
      Follow-up: immediate-switch composite preemption needs deferred macro-advance.

## Open questions (decide as we hit them)
- Attention budget metric: confirm the canonical key (`attention.capacity` vs derive
  from `attention.effort`). Synthesizer currently falls back to a default cap.
- Drive signals: selector reads `drive.social` for the social drive — confirm the
  canonical loneliness/social-need metric the regulatory engines actually publish
  (falls back to 0 today). Same review for `threat.level` / `inhibition.level`.
- Tunables to revisit once real runs exist: decision temperature (0.15), the score
  weights, and the entropy/stakes thresholds (0.65 / 0.60) + habit relief (0.25).
- Where the executive authors reply *content* in the new model — Phase 2 `communicate`
  primitive vs keeping AuditionEngine facets as the content author (lean: facets stay,
  but deliver through the `communicate` primitive so there is one enaction path).
- Whether `agency.intent` fully replaces `decision.record` or coexists during build
  (lean: new type, old type dies in Phase 8).

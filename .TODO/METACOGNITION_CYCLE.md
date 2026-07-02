# METACOGNITION_CYCLE_TODO — Closing the mind's self-dependent loop

> The "mind closing cycle" feature: let the Will **accommodate** — write its own introspection back
> into the apparatus that perceives and reasons (engine configs, percept/salience priors, beliefs, and
> the PMA persona), so a coherent persona accretes over time instead of being re-derived each run.
>
> Captured 2026-06-01. Tactical bugs live in `FIX_TODO.md`; strategic reorientations in `REORIENT_TODO.md`.
> This file is scoped to the metacognition loop only. Items are ordered by dependency: the substrate (Phase 0)
> had to be trustworthy before anything writes back through it.

---

## Concept: assimilation is done, accommodation is not

The Will already **assimilates** — the executive, self-model-updater, confidence-calibrator, bias-detector,
autobiographical-narrator and introspection-engine all *produce* introspective signals each tick. What's
missing is **accommodation** (Piaget): those introspects never anchor back into the durable apparatus.
After a restart the persona is re-derived from scratch; introspection is observed and then thrown away.

**Closing the loop** = a bounded, deterministic write-back path:

```
percepts → engines → introspection (surprise / calibration / traits / narrative)
   ▲                                                   │
   └──────────  persona-prior  ◄──── consolidation ◄───┘   (the missing edge)
```

Two non-negotiable design constraints, because the loop feeds itself:

- **Derived, not mutated.** `effective_config = base_config ⊕ persona_prior`. The base stays static and
  replayable; a learned *prior layer* modulates it. Never overwrite base config in place — that would
  make replay (R2) impossible and let drift compound silently.
- **Stability–plasticity.** Adapt without catastrophic forgetting: bounded per-update deltas, hysteresis,
  and surprise-gating so only *significant* introspection moves the persona. The prediction-error
  substrate is what supplies "significant".

> NB: this is the "upcoming feature" referenced by the deferred `will/mind.ts` engine-config single-source
> audit — the persona-prior layer is the right home for that reconciliation. Don't reconcile config drift
> independently; fold it into Phase 2.

---

## Phase 0 — Make the prediction-error substrate trustworthy ✅ DONE (2026-06-01)

The loop's gate signal is prediction error (`GenerativeModel`) + salience (`SalienceComputer`). Before
relying on it we reviewed it and found it largely inert/miscalibrated, and repaired it.

- [x] **0a. Adaptive self-scaling in `generative.model.ts`.** `DEFAULT_RANGE` was a fixed `100`, so error
  was normalised against a constant scale regardless of signal magnitude (tiny signals always "predictable",
  large ones always "maxed"). Now `0 ⇒ adaptive`: `scale = madEma × SURPRISE_SCALE(20)` ≈ one typical
  deviation, so the gate (0.05) means the same thing across magnitudes. Added a `madEma` field (EMA of raw
  deviation = learned scale), threaded through `_makeStream` / `snapshot` / `restore` (legacy `?? 0`).
- [x] **0b. Cold-start fix.** First observation per stream is adopted as the prediction and returns zero
  surprise, instead of firing a spurious giant error against a zeroed prior.
- [x] **0c. Wire `ConfidenceCalibrator` (was a no-op).** The bus `action.outcome` payload never carried
  `confidence` and the calibrator never subscribed, so `_records` stayed empty and every domain bias was
  eternally 0. Added `confidence` to the bus payload (`action.executor.ts`) + an `action.outcome` handler
  that calls `recordOutcome(...)`.
- [x] **0d. Version-counter → significance magnitude.** `self.model.updater.ts` and
  `autobiographical.narrator.ts` fed a monotonically-incrementing `version` into `observe()`, so the gate
  saw the same "+1" forever. Replaced with real change magnitudes (`_identityChangeMagnitude`;
  `narrativeSignificance`). Precision streams renamed `self_model.change` / `narrative.change`.
- [x] **0e. Tests + verification.** 16 new unit tests (`generative.model.test.ts`,
  `confidence.calibrator.test.ts`, `salience.test.ts`). Full unit suite green (251/251, 33 files).
  Typecheck clean in `src/` (one pre-existing `@vitest/expect` lib type conflict, unrelated).

---

## Phase 1 — Close the remaining substrate gaps (HELD — do before write-back)

These were deliberately held out of the Phase 0 "core only" repair, but they gate a *trustworthy*
write-back. Triage each before Phase 2.

- [x] **1a. Audit the last two engines for the same antipatterns.** ✅ DONE (2026-06-02).
  - `bias.detector`: counter-as-signal fixed — gated on cumulative `_detectedBiases.length` (only grows,
    then saturates against the prune cap); now observes `newBiases.length` (biases surfaced this scan) on a
    renamed `bias.novelty` stream (precision knob renamed to match).
  - `introspection.engine`: three coupled smells fixed in one change — (i) counter-as-signal on
    `_introspectionHistory.length`; (ii) bus-spam (published `introspection.insight` *every tick* once
    history was non-empty); (iii) precision-stream mismatch (`setPrecision('introspection.significance')`
    vs `observe('introspection.total')` → the precision knob was a dead no-op). Now publishes only when an
    introspection was actually produced this tick, with salience on the `introspection.significance` stream
    (re-aligning precision).
  - **Deferred dead-wiring (recorded-but-unused) → fold into Phase 3 consolidation, not a pure repair:**
    `bias.detector._executiveNamedBiases` (set from `executive.self.reflection`, only `.size`-reported in
    snapshot) and `introspection._lastExecutiveActionType` / `_lastExecutiveTick` (set from
    `executive.decision.rationale`, only echoed in snapshot) are written but never consumed in logic.
    Making them live (e.g. executive-corroboration confidence boost for named biases) changes cognition
    semantics and is a natural consolidation input — decide there, don't silently change behaviour now.
- [x] **1b. Calibrator + self-model durability (FN9).** ✅ DONE (2026-06-02) — engine-level seam.
  - `ConfidenceCalibrator`: now snapshots/restores `_domainBias` (the learned calibration curve — *the*
    durable artifact) + `_records` + its `_salience`/`_model` sub-states, following the EnergyRegulator/
    ForgettingCurve convention.
  - `SelfModelUpdater`: now snapshots/restores `_domainPerformance` + the eval-gating ticks
    (`_lastEvaluationTick`, `_experienceCountAtLastEval`, so re-evaluation timing replays deterministically —
    R2) + `_salience`/`_model`.
  - 4 round-trip tests added to `engine.snapshot.restore.test.ts` (lossless round-trip + restored-reproduces /
    fresh-diverges). Full unit suite green (255/255).

  > ⚠️ **ESCALATION — the runtime restore seam is UNWIRED (blocks the durable-persona goal).** Implementing
  > `engine.restore()` is necessary but *not sufficient*: there is **no runtime caller of any cognition
  > engine's `restore()`** (`grep` for non-test `.restore(` callers returns nothing). At boot, `WillStem`
  > only calls `stateManager.restore(previousState, {entities:true})` — it rehydrates **entity** state, never
  > engine-internal state. So today the precedent engines (EnergyRegulator, ForgettingCurve, SpacedRepetition)
  > carry tested `restore()` methods that nothing ever invokes — and our two new ones inherit that fate.
  > **Consequence:** calibration bias / domain competence will NOT survive a restart until one of:
  >   - **(A)** wire a runtime seam: collect each engine's `snapshot()`, persist it alongside the state
  >     snapshot, and call `engine.restore()` for each during `assembleMind`/boot; **or**
  >   - **(B)** persist the durable artifacts **as entities** (the path that *is* wired — beliefs/goals/
  >     narrative already rehydrate via `_restoreFromState` on first tick), and read them back the same way.
  > This is a systemic architecture decision (affects all engines equally), so it belongs in **Phase 2**
  > (it's effectively the same persistence question as the persona-prior layer). Decide A vs B there. The
  > engine-level `snapshot()`/`restore()` is done and ready to plug into whichever seam wins.
- [x] **1c. Salience variance-model rewrite — DONE (2026-06-02).**
  - **Audit:** the "Welford" label was wrong — `m2 += error²·α·(1-α)` is a growing *sum* and `variance =
    m2/count` is the *lifetime* average of error², so its adaptation rate fell off as `1/count` and **stalled
    on long-lived streams** (a moderate deviation in a now-volatile stream was still scored against the stale
    calm variance → mis-normalised under live ticks).
  - **Fix:** replaced it with an **exponentially-weighted error variance** — `m2 = (1-α)·m2 + α·error²`,
    `variance = α·(1-α)·m2`. The `α·(1-α)` factor preserves the prior normalisation calibration *exactly* for
    a stationary stream (no behaviour change — all existing salience/precision/reward-threat tests stay green
    with `NORMALISE_SCALE` unchanged), and only the windowing changed, so the estimate now keeps adapting
    indefinitely. Fixed `score()` to match; corrected the mislabeled comments.
  - **Decision — keep separate, align philosophy:** `SalienceComputer` (attention/precision) and
    `GenerativeModel` (prediction/gating/anticipation) play distinct roles and every engine holds both, so
    **not merged** (a 36-engine refactor for no proportionate gain). But they now share the same *adaptive
    deviation-scale* philosophy (generative `madEma` ↔ salience EW-variance) — the conceptual consistency the
    "share a substrate" question was really after.
  - **Test:** `salience.test.ts` — variance adapts to a new volatility regime even after a 600-tick run
    (would have frozen under the old `1/count` model); stationary calibration preserved.
- [x] **1d. Precision-perception — AUDITED + verified LIVE (2026-06-02).** The chain is real:
  `executive.prediction.formed` → engine raises its SalienceComputer precision → the engine's published
  events carry higher salience → the executive's Global-Workspace gate buffers any event with
  `salience >= WORKSPACE_THRESHOLD (0.4)` (`engine.ts`) → buffer `totalSalience >= BUFFER_SALIENCE_TRIGGER`
  wakes the executive early (`gating.ts`, `reason: 'salience_charged'`). So precision is genuine top-down
  attention, not a dead knob.
  - **Audit of all 36 setPrecision callers:** 33 LIVE (precision stream is observed → reaches a published
    event's salience). **Fixed:** `spaced.repetition` set precision on `spaced_repetition.review_rate`, a
    stream never observed — realigned to `spaced_repetition.records` (the stream its `state.changed` publish
    observes). (Same wiring-bug class as the introspection mismatch fixed in 1a.)
  - **Reward/threat dead knobs — RESOLVED via Option B (2026-06-02).** `reward.evaluator` and
    `threat.evaluator` published *constant magnitude-proportional* salience (`joy*1.8`, `fear*1.5`) and never
    called `observe()`, so their precision knob was inert. Now routed through
    `observe('reward.value', rewardLevel)` / `observe('threat.level', threatLevel)` once per tick (reused
    across the tiered events) → salience is **surprise × precision**, uniform with the other 33 engines.
    Cognitive payoff: reward-prediction-error (expected reward goes quiet) and threat habituation (a steady
    threat fades from the workspace; a *change* re-alerts), and the executive's top-down precision now
    actually reaches these domains.
    - **Guardrail (representation ≠ attention):** added `worldState.threatLevel` to the executive context
      (read from the `threat.level` metric) + a tonic "Threat level … stay aware even if it now feels
      familiar" prompt line when elevated — so habituation of threat *events* never blinds the deliberate
      self to a sustained threat *level*. Tests: `reward.threat.salience.test.ts` (spike ≫ sustained
      habituation; context carries the tonic level).
  - **Regression test:** `precision.perception.test.ts` pins precision as a clean salience multiplier and
    its effector to lift a sub-`WORKSPACE_THRESHOLD` event into the workspace.
- [x] **1e. `madEma` reuses the prediction `alpha`. — DONE (2026-06-03, #98).** Split out a per-stream
  `scaleAlpha` governing the learned deviation scale (madEma gating basis + m2 salience-variance basis +
  the variance calibration factor); the prediction EMA keeps `alpha`. `scaleAlpha` defaults to the stream's
  own `alpha` (config + `_makeStream` + a legacy-snapshot fallback), so unset = the original coupled
  behaviour exactly. Tests in `generative.model.test.ts`.

---

## Phase 2 — The persona-prior layer (derived config)

> **DECISION (2026-06-02): Option B — persist persona artifacts as entities.** The unwired-runtime-seam
> finding from 1b forced the A-vs-B call. Chose **B** because: (1) engines already consume config via
> `state.entities.get('engine-config-*').metadata.params` in `_readConfigFromState`, so a learned prior
> layered on that path *is* the natural `effective = base ⊕ prior` — no new mechanism; (2) entity restore
> is the path that's actually wired at boot (beliefs/goals/narrative rehydrate this way), so persistence +
> replay + snapshot come free; (3) the 1b engine-level `snapshot()`/`restore()` still serves *in-memory*
> snapshot/replay, a separate concern. Mechanism internals (salience/generative baselines) stay FN9-only —
> a brief re-warm-up on restart is acceptable. (Option A — a runtime engine-snapshot collect/persist/restore
> seam — remains available later if mechanism state ever needs cross-restart durability.)

- [x] **2a. Define `persona_prior` + the derivation.** ✅ slice 1 (2026-06-02). New `src/cognition/persona.prior.ts`:
  `readEffectiveParams(state, engineConfigId)` returns base engine-config params ⊕ additive numeric deltas
  from the `persona-prior` entity (`metadata.priors[engineConfigId]`). Wired into
  `SelfModelUpdater._readConfigFromState` — a learned prior now modulates the self-model's re-evaluation
  cadence (the loop's first closed edge). Reader is pure/deterministic; missing prior ⇒ base. **Bounding of
  deltas is intentionally NOT in the reader** — it belongs to the writer (the Phase 3 consolidator), where
  per-param scale/clamp policy is decided. Does NOT touch `_buildEngineConfigEntities` (the held
  engine-config single-source reconciliation stays deferred — this is an additive layer on top).
- [x] **2b. Make config derivation `base ⊕ prior`.** ✅ slice 1 — done as part of 2a:
  `SelfModelUpdater._readConfigFromState` now reads the derived effective value via `readEffectiveParams`.
  Base entity untouched; prior is a separate entity layer. (Remaining engines adopt the same one-line swap
  as the consolidator starts writing priors for their config ids — widen incrementally, not all 37 at once.)
- [x] **2-B. Calibrator durability via entity (proof of Option B for a learned artifact).** ✅ slice 2
  (2026-06-02). `ConfidenceCalibrator` now writes its learned `_domainBias` as a `calibration-state` entity
  each react (deterministic, keyed on `tick`) and rehydrates it via `_restoreFromState` on the first react
  after a restart — directly, so calibration is continuous without waiting to re-accumulate
  `minSamplesPerDomain` outcomes. This closes the 1b runtime-gap **through the wired entity path**, proving
  B end-to-end. 3 tests (writes entity / rehydrates on restart / preserves restored bias with no new
  samples). `_records` deliberately not persisted — they re-accumulate from `action.outcome`.
- [x] **2c. Determinism (R2).** ✅ The reader and `consolidatePrior` are pure; the consolidator's bias
  comes from replayed bus events; the write is keyed on sim `tick`. Unit-level determinism asserted
  (`consolidatePrior` identical-sequence test; consolidator identical-drive test). A full N-tick
  replay-equivalence test on the assembled mind can be added later but the deterministic guarantees hold by
  construction.
- [x] **2d. Snapshot/restore (FN9).** ✅ Persona-prior + calibration-state are entities, so they ride the
  wired entity snapshot/restore. Asserted via simulated-restart round-trips in both
  `persona.consolidator.test.ts` and `confidence.calibrator.test.ts`.

---

## Phase 3 — The consolidation (write-back) mechanism

- [x] **3a. Consolidator.** ✅ (2026-06-02) New `PersonaConsolidator` faculty
  (`src/cognition/engines/faculties/persona.consolidator.ts`), **registered live** in the meta-cognitive
  engine set (tier `full`) via `engines/index.ts` + `mind.ts`. First closed loop:
  `confidence.calibrated` → bounded prior on `engine-config-self-model.minIntervalTicks` (persistent
  mis-calibration → re-examine the self more often). **Significance-gated** (a magnitude threshold on the
  calibration bias — the right notion for a persistent control signal; surprise/prediction-error gating
  suits event-driven signals, which is what the bus-publish gates we repaired in Phase 0/1 already do).
  Lean: no bus/salience/generative sub-state it doesn't use (avoids re-introducing the dead-wiring smell).
- [x] **3b. Bounded plasticity.** ✅ All limits live in the pure `consolidatePrior`: per-step clamp +
  cumulative clamp (both relative to each param's base magnitude, so one policy fits a 200-tick interval and
  a 0.02 rate) + multiplicative decay-toward-base each pass. Proven: single-step clamp, cumulative
  saturation (one-sided flood settles at the cap, never diverges), decay-back-to-base on recovery.
- [x] **3c. PMA integration.** ✅ DONE (2026-06-02). Two parts:
  - **Portable artifact:** `PMASnapshot.persona` = `{ configPriors, calibrationBias }`; `PMADistiller`
    extracts it from the `persona-prior` + `calibration-state` entities (omitted when nothing learned);
    `PMALoader` restores both entities. The *accreted* persona now travels with the exported identity, not
    just the seeded identity. (Additive field — no schema bump per the PMA convention.)
  - **Visible to the deliberate self:** `summarizePersonaPrior(state)` renders the active prior as
    first-person phrases; the executive context carries them as `selfTuning` and the prompt factory renders a
    "Self-tuning (how I've adapted my own mind)" line in the identity block — so the executive *sees* its own
    accommodation. Reward-weight tuning can be revisited here later.
- [x] **3d. Tests.** ✅ Bounded-drift / saturation, decay-to-base, sub-threshold no-op, interval gating,
  determinism, and simulated-restart round-trip — `persona.consolidator.test.ts` (7) + `persona.prior.test.ts`
  (14). Full suite green (335 passed, 1 skipped, 41 files).

### Widening the loop — edges closed

`consolidatePrior` is now multi-adjustment (decay once, N bounded steps, one version bump), and the
consolidator runs a small rule table. Three edges are live:

- [x] **Edge 1** `confidence.calibrated` → `self-model.minIntervalTicks` — mis-calibrated → re-examine self
  more often. (Self-model reads `readEffectiveParams`; base entity == default, no drift.)
- [x] **Edge 2** `bias.detected` (newCount) → `introspection.cooldownTicks` — recurring bias → introspect
  more often. Added `IntrospectionEngine._readConfigFromState` via `readEffectiveParams` (drift-free: seeded
  base == constructor default).
- [x] **Edge 3** `self_model.updated` (changeMagnitude) → `narrator.minIntervalTicks` — identity shifted →
  re-narrate sooner. Now **clean**: the narrator drift was reconciled (below), so it reads
  `engine-config-narrator` via `readEffectiveParams` (base 50 ⊕ prior) — same uniform path as edges 1 & 2.
- [x] **Edge 4** `bias.detected` (belief-formation types: overgeneralization / confirmation) →
  `semantic.beliefStalenessThreshold` — biased beliefs → let beliefs go stale sooner so they're
  re-examined. (2026-06-02; targets the read path #84 added.)
- [x] **Edge 5** `bias.detected` (memory-weighting types: recency / availability) →
  `working-memory.attentionProtection` — over-weighting recent/vivid items → loosen attention protection so
  they aren't clung to. `bias.detected` now carries `types[]`; the consolidator routes per category (belief
  → semantic, memory → working-memory), with the aggregate novelty still driving Edge 2 (introspection).

> **`reward.evaluator` intentionally NOT a consolidator write-target** despite #84 making its config
> read-ready: reward *weights* (goal/social/resource/discovery) are motivational *values* = persona
> **definition**, which belongs to the PMA layer (3c), not introspective self-correction. Revisit there.
> (Distinct from reward *event salience*, which 1d's Option-B change does route through `observe()`.)

> **Engine-config single-source drift — RESOLVED for the metacognition layer (2026-06-02).** The hold was
> lifted (the persona-prior layer is the feature it was waiting for). Reconciled: `narrator.minIntervalTicks`
> → canonical **50** (constructor default 300→50 to match the seeded mirror; narrator now reads its config).
> `confidence-calibrator`, `bias-detector`, `introspection`, `self-model` all read config via
> `readEffectiveParams` (mirrors already matched defaults — no behaviour change). The **broader
> reconciliation** (latent bugs in working-memory/semantic, moral foundations structural bug, missing
> spaced-repetition mirror, etc.) touches regulatory/memory engines and is a separate follow-up — see the
> updated `engine-config-single-source` memory note.

### Still open
- *(nothing actionable)* — the consolidator now has **8 live edges** and the substrate is fully tied off.
  Two of the originally-listed candidate inputs were **deliberately left unwired** (see below); revisit only
  if a concrete need surfaces.

### Resolved since
- **More consolidator edges — DONE (2026-06-03, #99).** Added edges 6–8, extending the loop past cadence
  control into the regulatory + perceptual apparatus:
    - 6. `bias.detected` → `inhibition.baseInhibitionStrength` (↑ self-restraint) — first edge that *raises*
      a gain rather than speeding a cadence.
    - 7. `introspection.insight` → `self-model.minNewExperiences` (↓ evidence gate) — composes with edge 1's
      time gate.
    - 8. `bias.detected` (belief) → `attention.shiftInertia` (↓ to break fixation) — complements edge 4.
  `inhibition.controller` + `attention.allocator` switched to `readEffectiveParams` (single-sourced); the
  full-mind replay test is unchanged (behaviour-preserving with no prior). Tests in
  `persona.consolidator.test.ts` + `persona.prior.test.ts`.
    - **Deliberately NOT wired:** `metacognition.state.changed` (payload is the same `overallBias`
      `confidence.calibrated` already carries → would double-count edge 1) and `narrative.updated` (the
      narrator is downstream of the self-model via edge 3 → no principled distinct target, cadence-loop risk).
- **1e (`madEma`/`scaleAlpha` decoupling) — DONE (2026-06-03, #98).** See Phase-1 §1e above.
- **Deferred dead-wiring (Phase 1a) — DONE (2026-06-03).** `bias.detector._executiveNamedBiases` now wires
  an *executive-corroboration* confidence boost (+0.15, fuzzy-matched) when the executive independently named
  a detected bias. introspection's `_lastExecutive*` had no principled consumer → removed (dead fields +
  their `executive.decision.rationale` handler/subscription). Test: `bias.detector.test.ts`.
- **Verification — ALREADY COVERED.** `mind.integration.test.ts` "produces identical state on replay with
  same seed" runs two seeded minds 50 ticks and asserts every metric + entity byte-for-byte equal (R2). It
  passed through the whole substrate-unification refactor, so determinism is proven for the assembled mind;
  consolidator/persona-prior determinism is also unit-tested.
- **Predictive substrate unified** (`PREDICTIVE_SUBSTRATE_TODO.md`, PRs #90–#96): `SalienceComputer` merged
  into `GenerativeModel` — supersedes 1c's "keep them separate" decision; every engine now holds one model.

> **Engine-config single-source — DONE** (metacog layer in this feature; broader reconciliation landed in
> PRs #83/#84, which also made working-memory/semantic/reward config-read-ready).

---

## Open questions / decisions needed

- **Where does consolidation run** — a new dedicated faculty, or fold into the existing
  `introspection.engine` / executive reflection pass? (Leans toward a dedicated, surprise-gated faculty so
  the write-back path is auditable in isolation.)
- **Granularity of the prior** — per-engine scalar knobs only, or also percept-level salience priors and
  belief-confidence nudges? Start narrow (engine config + calibration), widen later.
- **Forgetting policy** — does the prior decay toward base on its own (recency-weighted persona), or only
  move on new evidence? Affects whether an old persona ossifies.

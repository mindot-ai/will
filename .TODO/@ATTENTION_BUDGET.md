# Will — Dynamic Attention Budget

> A Will can now **explicitly choose** how much cognitive capacity to engage —
> mobilizing more attention (more parallel facets) under high stakes, or standing
> down to conserve — while its **vitals still compel rest/shutdown** when energy
> or sleep impose. Budget → concurrent facets → parallel LLM calls → token spend,
> so this is also a cost governor.

---

## Background — the two-layer model

- **`AttentionAllocator`** (regulatory, every tick): baseline `maxCapacity` modulated
  by involuntary regulators → publishes `attention.*` metrics + `attention.state.changed`.
- **`FacetSupervisor`** (executive): consumes that signal → `maxFacets` cap on concurrent facets.

Two gaps motivated this work:
1. Modulation was **one-directional & involuntary** (energy/sleep only ever *reduce* capacity); no
   voluntary control, no way to mobilize *more*.
2. The budget→facet coupling was **miscalibrated** — it fed the raw 0–100 capacity into a supervisor
   expecting a normalized 0–1 fraction, inflating the budget ~100× so it never bound (facets were
   capped only by the §1 idle-TTL / LRU GC).

---

## ✅ PR #114 — calibration fix (prerequisite)

The allocator publishes `attention.free_fraction = freeCapacity / baseline maxCapacity` (normalized
0–1); `FacetSupervisor.setAttentionState(freeFraction)` consumes it directly. The `0.3`-per-facet
constant and the default (`1 → 3 facets`) now hold on the right scale, and vital-reduced capacity
actually shrinks the facet budget. Tests: calibration regression in `facet.supervisor.test.ts`.

---

## ✅ Option C — homeostat + bounded voluntary override

**Design decisions (agreed):**
- **Control variable:** a single voluntary **`effort` ∈ [0.4, 1.0]** = how much of the vitals-permitted
  *ceiling* the mind engages. Homeostatic default **0.7**, so `focus` is a real increase and `rest` a
  real decrease. `effectiveCapacity = (maxCapacity × energyFactor × sleepFactor) × effort`.
- **Explicit choice via the action vocabulary (Option A):** the executive's chosen actions drive it —
  a **`focus`** action → effort target 1.0; **`rest`/`sleep`/`wait`/`meditate`** → 0.4; neither →
  decay toward baseline. The mind speaks its existing language; voluntary focus and the *already
  existing* involuntary "you MUST rest" (energy guidance) flow through one channel.
- **Vitals win:** effort scales the ceiling, so a collapsed ceiling (low energy / high sleep pressure)
  leaves nothing to engage — you cannot focus past exhaustion. `focus` is also gated on `energy > 15`.
- **Transience:** an explicit request snaps the set-point; otherwise it relaxes toward 0.7 each tick
  (`EFFORT_RELAX`), so focus/rest fade unless renewed each cycle — mind-like and self-limiting.

**Implementation (shipped):**
1. [x] `AttentionAllocator`: `effort` state + `attention.regulate` subscription; `react()` applies the
   request (snap) or relaxes toward baseline, clamps to [0.4, 1.0], computes `ceiling × effort`,
   publishes `attention.effort`.
2. [x] `ExecutiveEngine`: scans `executiveOutput.actions` and publishes `attention.regulate { effortTarget }`
   (focus → 1.0; rest/sleep/wait/meditate → 0.4). Replay-safe — derived from recorded LLM output.
3. [x] `focus` is a first-class **innate** cognitive action: defined in `generic.json` (description,
   `energyCost 0.04`, precondition `energy > 15`), added to `registry` `INNATE_EFFECTOR_NAMES`, handled
   by `InnateExecutor` (`_resolveFocus`, benign state-grounded outcome). Dispatched before world/
   communication, so it never errors as an unknown effector.
4. [x] `attention.regulate` registered in `event.schemas.ts`.

**Determinism:** all changes are tick-deterministic — effort is computed in `react()` from metrics
(like the existing energy/sleep factors); the voluntary signal is recorded LLM output (R2-safe). No new
persistence plumbing.

**Tests:** `attention.effort.test.ts` (focus raises capacity + free fraction; rest lowers; decay to
baseline; clamp; vitals cap full focus), `innate.focus.test.ts` (focus executes cleanly), supervisor
calibration. Full suite 479 → 488 green.

---

## ✅ End-to-end loop validation + propagation fix (PR #116)

Confirms a focus/rest **decision actually moves `maxFacets`** in a running mind, over a real
CognitiveBus: action choice → `effortTargetForActions()` → `attention.regulate` → allocator (effort →
capacity → freeFraction) → `attention.state.changed` → `FacetSupervisor.setAttentionState()` → budget.
- Extracted `effortTargetForActions()` (exported, unit-tested) from the inline executive logic.
- **Propagation fix:** `attention.state.changed` was gated on the *usage* prediction error alone, so a
  voluntary effort change under steady load never reached the supervisor — the budget wouldn't move in
  a quiet mind. Now publishes on a prediction error in **either** usage **or** `free_fraction`.
- Test: `tests/integration/attention.budget.loop.test.ts` (focus admits 3 facets, rest 1; freeFraction
  travels over the bus).

## ✅ Arousal-raised ceiling — Option A upward involuntary lever (PR #117)

Threat/reward arousal (`affect.arousal`) now **mobilizes the ceiling above baseline** (fight-or-flight),
the involuntary counterpart to voluntary focus, with a **Yerkes–Dodson inverted-U**:
- calm (≤ 0.3) → factor 1.0 (no boost); optimal (~0.65) → 1.3 (max mobilization → wider budget);
  extreme (→ 1.0) → < 1.0 (fragmentation / tunnel vision → narrower budget).
- `ceiling = maxCapacity × energyFactor × sleepFactor × arousalFactor`; effort utilizes it. So a calm
  mind sits at baseline, a roused one engages more, a panicked one loses capacity it cannot will back.
- Published as `attention.arousal_factor`. Test: `attention.arousal.test.ts`.

---

## ✅ Explicit energy-cost coupling (PR #139)

The attention→energy half of the homeostatic loop now closes: sustained voluntary **effort** and
**cognitive load** drain the energy pool, the continuous counterpart to the `focus` effector's one-shot
`energyCost`. So focus is genuinely self-limiting — engaging capacity costs energy, energy caps the
capacity ceiling — and cannot run for free.

- `EnergyRegulator` reads `attention.usage` (load) and `attention.effort` from `state.metrics` and
  folds them into the awake-decay multiplier:
  `1 + load·LOAD_DECAY_GAIN + (effort − EFFORT_BASELINE)·EFFORT_DECAY_GAIN`, clamped ≥ 0.5. The
  homeostatic effort baseline (0.7) is **cost-neutral**, so focusing above it burns faster and standing
  down (rest) slower, with no regression to the prior awake decay at the rest-point.
- **Fixed a latent dead-wire in the process.** The regulator previously read `payload.cognitiveLoad`
  off `attention.state.changed`, but the allocator never published that field — so cognitive work
  imposed *zero* continuous energy cost (`activityMultiplier` was pinned at 1.0). The unused
  `registerEffort()` stub (zero callers) was removed too. Load/effort now come straight from the
  event-sourced SimulationState, so they need no engine snapshot; the regulator's only durable
  internal state is now the GenerativeModel baseline (FN9 test updated accordingly).
- **Determinism:** multiplier is recomputed each tick from metrics + current energy (no hidden state);
  metrics are one-tick-lagged but consistent (energy ticks before attention). R2/replay-safe.
- **Tests:** `energy.effort.cost.test.ts` (focus > baseline > rest drain ordering; load adds cost;
  baseline cost-neutral; absent-metrics fallback) + `engine.snapshot.restore.test.ts` (model-only FN9).
  Full suite green: 567 passed / 1 skipped.

---

## Parked — genuine "possible follow-ups" (no current need)

- **Breadth vs. depth knob.** Expose `maxFoci` / `costPerFocus` / `shiftInertia` to the same voluntary
  control (spread wide & shallow vs. few & deep), beyond the single capacity scalar. They are already
  config + persona-prior modulated (`shiftInertia` even moves involuntarily via the bias-detector edge);
  putting them under *voluntary* executive control means a whole second control dimension — new action
  vocabulary + extending `attention.regulate` beyond the single `effortTarget`. Real design surface, no
  motivating need yet. **Parked.**
- **Tuning.** `EFFORT_*`, `AROUSAL_*`, the new `LOAD_DECAY_GAIN` / `EFFORT_DECAY_GAIN`, the focus/rest
  targets, and `0.3`-per-facet are first-cut constants. Tuning "against real session token economics"
  is data-dependent and there is no attention/token telemetry to tune against yet (the #138 eval
  harness measures planning quality, not attention cost). **Parked until that signal exists** — revisit
  then rather than guessing now.

---

*Created from the attention-budgeting design discussion.*

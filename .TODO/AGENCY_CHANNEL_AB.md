# Will — Lift the agency pipeline into the Channel-A/B developable layer

> **Status: ✅ COMPLETE (Strong tier, both reconciliations, and Channel B).**
> `AGENCY_PIPELINE_TODO.md` is fully closed and the agency engines — which began as the
> **one major faculty group that bypassed the Channel-A/B pattern** — are now
> personality-expressive: the selector develops its switch resistance, deliberativeness, and
> risk/novelty competition weights from disposition, sharing single sources of truth with the
> executive EffortGate and the TaskSwitcher, and the deliberation facet owns a preemption
> in-character (Channel B). **Remaining is only deliberately-deferred:** Medium-tier rows
> resolved as *defer / leave-to-existing* (see table); the routine-depth Channel-B nudge
> skipped as already-conveyed.
>
> **Done so far:**
> - **Scoring weights** ✅ — the selector's `risk` (emotional-stability ↓ → bolder, rule 36)
>   and `novelty` (openness ↑ → curiosity, rule 37) competition weights now develop. Threaded
>   `engine-config-action-selector` weights into `scoring.ts` (full 4-step ×2). Decision
>   temperature was **reclassified telemetry-only** (the top-2-margin gate means it no longer
>   drives the choice; "decisive → sharper" is already the rule-17b driver). Tests: consolidator
>   (4) + selector read-path proving the winner flips (2).
> - **Deliberation-gate decisiveness driver** ✅ — consolidator rule 17b: decisiveness ↑ →
>   *raises* the shared `deliberateThreshold` (opposing rule 17's analytical pull on the same
>   param). Because R1 made the selector a second consumer, this one rule develops "acts on
>   thinner margins" across BOTH reasoning and action. Completes the deliberation-gate edge.
> - **R1 — deliberativeness reconciliation** ✅ (the selector's System-2 gate). The selector
>   consumes the SAME disposition the executive's EffortGate develops — the persona-prior on
>   `engine-config-executive.deliberateThreshold` — shifting both its `MARGIN`/`STAKES` gates
>   from one `deliberativeness` deviation signal (native-scale sensitivities). Analytical
>   deliberativeness (rule 17) now unifies across reasoning AND action; a newborn Will (no
>   prior) is byte-for-byte unchanged. Pure consumer edge — no new seed/rule/description.
> - **R2 — switch-cost reconciliation** ✅ (the selector's preemption hysteresis). The
>   selector now reads `engine-config-action-selector.switchCost` (base ⊕ prior),
>   hardened by the shared `task_switch.current_focus_ticks` signal using the same
>   formula shape the TaskSwitcher uses internally — one switch-resistance disposition
>   (conscientiousness), two owners (TaskSwitcher attention + selector action) at their
>   native scales. Developed by a new PersonaConsolidator rule (28b), surfaced in
>   `PRIOR_DESCRIPTIONS`, telemetry `persona.action_selector.switch_cost_delta`. Tests:
>   `persona.consolidator.action-selector-switch-cost.test.ts` (3) + selector read-path
>   (3 in `agency.selection.test.ts`). PMA travel confirmed (whole `priors` map).

---

## What Channel A & B are (recap)

- **Channel A** — *mechanistic*: promote a hardcoded constant into the
  `engine-config-*` + persona-prior layer so it becomes a **developing disposition**.
  The 4-step pattern (verbatim from `@FACULTY_CONSTANTS_CHANNEL_A_TODO.md`):
  1. **Seed** the constant as a param on the governing `engine-config-<faculty>` in `src/stem/mind.ts`.
  2. **Read it live** in the engine's `react` via `readEffectiveParams(state, 'engine-config-<faculty>')` (base ⊕ prior), replacing the literal.
  3. **Develop it** — add a `PersonaConsolidator` rule: trait deviation → bounded delta.
  4. **Surface it** — `persona.prior.ts` `PRIOR_DESCRIPTIONS` first-person line.
- **Channel B** — *soft/in-character*: surface the state into the executive/facet
  prompt so the unified LLM reasons about it as itself.

Self-model traits available: `conscientiousness`, `decisiveness`, `openness`,
`agreeableness`, `persistence`, `resilience`, `creativity`, `analytical`,
`emotional-stability`.

---

## ⚠️ Two reconciliations to settle FIRST (design before wiring)

These aren't edges to add — they're existing things the agency layer now overlaps,
and getting them wrong makes the Will incoherent.

### R1 — One deliberativeness, two gates
`EffortGate` (`executive.engine/effort.gate.ts`) is the existing **trait-developed**
System-1/2 gate for the executive's *own reasoning* (analytical/conscientious → lower
threshold → deliberates more; impulsive → higher). The agency **selector** now owns a
*second* deliberation gate (`MARGIN_THRESHOLD` / `BASE_STAKES_THRESHOLD`) — hardcoded.
**Decision needed:** drive both from a single `deliberativeness` disposition (one
persona-prior consumed by both), so a Will isn't impulsive in reasoning but
over-deliberate in action. Lean: introduce a shared prior; the selector reads the same
effective deliberation threshold the EffortGate develops.

### R2 — One switch cost, two owners
`TaskSwitcher` already computes a **focus-dependent** switch cost
(`task_switch.switch_cost`, grows with `focusTicks`) and gives the focused goal a
trait-developed commitment boost. The selector's preemption uses a **flat**
`BASE_SWITCH_COST`. **Decision needed:** the selector should read
`task_switch.switch_cost` as the base of its preemption hysteresis, then layer a
`persistence` persona-prior on top — one source of truth: switch resistance =
f(focus duration, persistence). Resolves Q1 from the design discussion.

---

## Channel-A edge catalogue (agency)

Each row is the 4-step pattern. Group the agency constants under
`engine-config-action-selector`, `engine-config-affordance-synthesizer`, etc.

### 🟢 Strong — clear trait owner, real lever

| Engine · constant | Trait → direction | Behaviour it develops |
|---|---|---|
| ✅ `selector` · preemption switch cost (**R2**) | **conscientiousness** ↑ → higher | resists interruption; sees actions through vs. flits — *done* |
| ✅ `selector` · deliberation gate `MARGIN`/`STAKES` (**R1**) | **decisiveness** ↑ → acts on thinner margins · **analytical** ↑ → deliberates more | how readily it stops to think (System 2) — *done: both drivers develop the shared `deliberateThreshold` (rules 17 + 17b), consumed by selector + EffortGate* |
| ⚪ `scoring` · decision temperature (0.15) | ~~decisiveness~~ | **Reclassified → telemetry-only / skip.** Since the gate moved to top-2 margin (Phase 5), this temperature only shapes the `competitionEntropy` *metric*, not the (argmax) choice — so it's no behavioural lever. "Decisive → sharper choice" is already developed behaviourally by the decisiveness→`deliberateThreshold` driver (rule 17b). |
| ✅ `scoring` · `risk` weight (0.20) | **emotional-stability** ↑ → lower | bolder; low stability → higher → cautious/avoidant — *done (rule 36)* |
| ✅ `scoring` · `novelty` weight (0.10) | **openness** ↑ → higher | curiosity pulls harder toward the unpracticed — *done (rule 37)* |

### 🟡 Medium — plausible owner, watch for overlap

| Engine · constant | Trait → direction | Note |
|---|---|---|
| ⏸️ `scoring` · `goal` weight (0.30) | **conscientiousness** ↑ → higher | **Leave to `reward.goalWeight` (rule 26) — don't double-count.** Conscientiousness's achievement-striving already makes goals matter more via the reward signal; developing the action-competition `goal` weight from the same trait too would over-weight one disposition across two mechanisms. Revisit only if reward-side proves insufficient. |
| ✅ `scoring` · `habit` bonus + `HABIT_RELIEF` | tie to the **deliberativeness** disposition (R1) | **Satisfied-by-design.** R1 made `relief` and the `deliberativeness` term *additive* in both gates, so a strong habit relaxing deliberation already composes coherently with the developed deliberativeness — no separate lever needed. |
| ⏸️ `repertoire` · `HABIT_GAIN` / `VALUE_ALPHA` (learning rates) | **persistence** (habits form faster) or a plasticity/openness facet | weak owner; **deferred** unless a need appears (per original note). |

### 🔵 Leave fixed (physiological / mechanism timing)
- `synthesizer` attention cap → already reads `attention.capacity` (AttentionAllocator owns it).
- `selector` `AWAIT_STALE_TICKS` / `STALE_DECAY` → mechanism timing, not a disposition.
- `scoring` · `drive` weight → homeostatic; the drives themselves already carry urgency.

---

## Channel B (in-character) — mostly already satisfied

The Deliberator reasons through a **unified facet** that already receives the full
persona + live state, so the in-character channel exists for action deliberation. Only
small additions are worth considering, and only if they earn their tokens:
- [x] surface a one-line "you just **broke off** a pending action (X)" into the
      deliberation focus when a preemption occurred (so the LLM owns the interruption).
      *Done:* the selector stashes `preemptedFrom` on a preempting challenger that is ALSO
      deliberating; `DeliberationEngine._buildFocusContent` opens with the interruption
      framing instead of the neutral "selection was uncertain" line. Tested (focus content).
- [x] ~~surface "you've been **deep in** <routine> for N ticks"~~ → **Skipped (already
      conveyed / no hook).** Two reasons: (a) the Deliberator only runs on `deliberating`
      intents and the selector defers new selection while a composite is `expanding`, so it
      never reasons *during* a routine; (b) the TaskSwitcher's focus-duration state already
      flows into the unified self-context every facet inherits — exactly the "don't
      over-mechanize" case.
- Do NOT over-mechanize: if the unified facet's existing context already conveys it,
  skip the explicit nudge.

---

## Task checklist

- [x] **R1** — selector now consumes the SAME deliberativeness disposition the EffortGate
      develops (the persona-prior on `engine-config-executive.deliberateThreshold`): a single
      `deliberativeness` deviation signal shifts both the `MARGIN` and `STAKES` gates at their
      native scales (per-gate sensitivity), so an analytical Will deliberates more in action
      too and a decisive one commits faster. Pure *consumer* edge — no new seed, rule, or
      description (rule 17 already develops the threshold); 0 deviation ⇒ base gates unchanged
      for a newborn Will, so the literals stay as the neutral baseline. The decisiveness DRIVER
      ("acts on thinner margins") is the next edge and routes through this SAME threshold, so it
      reaches both consumers for free.
- [x] **R2** — selector develops its own `engine-config-action-selector.switchCost`
      (base ⊕ prior), hardened by the shared `task_switch.current_focus_ticks` signal;
      the flat `BASE_SWITCH_COST` is now a fallback only. *As-built note:* rather than
      consume the `task_switch.switch_cost` metric directly (goal-priority scale ≠ the
      selector's activation scale), the selector keeps a native-scale base developed by
      the SAME conscientiousness driver as the TaskSwitcher (rule 28 → 28b) and hardens
      it with the SAME focus signal + formula shape — "one disposition, two owners,
      native scales." Resolves Q1.
- [x] Seed `engine-config-action-selector` in `mind.ts` with the Strong-tier params
      (`switchCost`, `riskWeight`, `noveltyWeight`). `-affordance-synthesizer` not needed —
      its attention cap already reads `attention.capacity` (🔵 leave-fixed row).
- [x] `readEffectiveParams` in `selector.react` / `scoring` (threaded `state` in) for each
      Strong-tier constant: `effectiveSwitchCost` + `effectiveWeights` (risk/novelty into
      `scoreAffordance`); deliberativeness via `readPersonaPrior` on the executive threshold.
- [x] Added `PersonaConsolidator` rules: conscientiousness→switch-cost (28b),
      decisiveness→deliberation-gate (17b), emotional-stability→risk (36), openness→novelty
      (37). (temperature dropped — reclassified telemetry-only.)
- [x] `persona.prior.ts` `PRIOR_DESCRIPTIONS` first-person lines for each new param
      (`switchCost`, `riskWeight`, `noveltyWeight`; `deliberateThreshold` pre-existing).
- [x] Channel-B nudges — preemption-awareness nudge implemented; routine-depth nudge
      skipped as already-conveyed (see Channel B section).
- [x] Tests — per edge: high-trait vs neutral develops the param in the right direction
      (`persona.consolidator.action-selector-*`, `*.deliberation`); determinism-safe read
      paths in `agency.selection.test.ts` (switch-cost, deliberativeness, weights).
- [x] PMA: the persona-prior deltas already travel (`PMASnapshot.persona.configPriors`).
      Confirmed `_extractPersona` (pma/index.ts:348) copies the whole `priors` map and
      `PMALoader` (pma/index.ts:822) re-seeds it wholesale — the new
      `engine-config-action-selector` prior travels automatically, no codec change.

---

## Why this matters

The agency layer is *where personality becomes action*. Today every Will selects,
deliberates, and resists interruption identically. Channel A makes a conscientious Will
resist interruption and see plans through; an impulsive one act on thin margins; a
cautious one weight risk heavily; a curious one chase novelty — and all of it
*develops* over a life and *travels* in the PMA. It also turns the thrashing-vs-
responsiveness tunables (`BASE_SWITCH_COST`, decision temperature, the deliberation
thresholds) from guessed constants into developed dispositions — the right way to tune
them. This is the final step in making the action system a *self*, not a mechanism.

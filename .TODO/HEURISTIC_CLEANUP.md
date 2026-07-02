# Will — Heuristic cleanup audit (faculty engines)

> Audit of `src/cognition/engines/faculties/*` for heuristic processing that is
> **outdated, redundant, or distorting** now that the Will has dual-process cognition
> (master + facets) and the Channel-A persona-prior layer.
>
> **Key reframe:** most "heuristics" are not LLM-substitutes to remove — they are the
> deterministic autonomic *mechanism* Channel A modulates (oscillators, decay curves,
> affect/drive evaluators). Replacing those with LLM calls would be wrong. The genuine
> findings are narrow.

---

## Classification (all faculties swept)

- **Deterministic autonomic mechanisms — KEEP** (the wired substrate, not heuristics):
  affective.blender, frustration.evaluator, threat.evaluator, reward.evaluator,
  loss.evaluator, aesthetic.evaluator, moral.evaluator, stress.regulator,
  energy.regulator, sleep.pressure.regulator, circadian.oscillator, novelty.detector,
  interoception, exteroception, forgetting.curve, spaced.repetition,
  inhibition.controller, attention.allocator, task.switcher, social.perception,
  reputation.tracker, attachment.evaluator, theory.of.mind, empathy.simulator,
  dream.simulator, working.memory, episodic.consolidator, goal.manager.
- **Metacognition — KEEP** (core to the loop): self.model.updater, persona.consolidator,
  bias.detector, confidence.calibrator, semantic.engine/integrator.
- **Satellite dual-source — KEEP the architecture** (executive-fed path + cheap heuristic
  path for ticks *between* gated executive activations; dual-process did not change the
  gating cadence): autobiographical.narrator, introspection.engine, mental.simulator,
  semantic.engine/integrator.
- **Executive + fallbacks — KEEP**: executive.engine/* (now dual-process);
  `buildFallbackOutput` + action.executor bare-observe are LLM-down safety nets.

---

## Action items (the 3 genuine findings — one PR each)

> **Status:** the `will-identity-self → identity-self` rename that was blocking these has
> landed (will#152); the 3 cleanups now go in cleanly, one PR each.

### 1. `self.model.updater` — blunt trait nudge ⟶ **FIX** (High)  — ✅ DONE
`self.model.updater.ts` `_evaluateSelf`: a positive self-belief nudged **every** trait up
(`+confidence·0.02` across all keys). Now that Channel A reads these traits to develop
dispositions, this indiscriminately inflated *all* of them (grit, deliberativeness,
warmth, …) regardless of behaviour, competing with the principled per-domain formation —
it actively distorted the trait substrate the whole persona-prior layer reads.
**Fix:** make the nudge **targeted** — a self-belief only moves the trait(s) it is actually
about (lightweight keyword→trait match), so self-concept still shapes traits without
inflating unrelated ones.

### 2. `mental.simulator` — fully vestigial ⟶ **RETIRE** (Medium)  — ✅ DONE
`quickProject`, `cacheSimulation`, `getSimulations` have **zero external callers**
(grep-confirmed), and nothing consumes `mental_sim.scenario.run`. Built for a
`simulate_outcome` tool that was never wired; System 2's propose→evaluate now enumerates
and weighs options itself. **Action:** retire the engine — remove the faculty, its
construction/registration/config/distribution entries, the event schema, and the
integration-test wiring.

### 3. `introspection.engine` ↔ `bias.detector` — duplicated bias-detection ⟶ **CONSOLIDATE** (Low)  — ✅ DONE
Heuristic introspection independently detects *overconfidence* + *repetition* biases;
`bias.detector` is the dedicated, persona-prior-developed faculty (overgeneralization /
recency / confirmation) that writes `cognitive_bias` entities and `bias.detected` events.
Two faculties detecting "biases" is a smell. **Action (recommended):** move the two unique
checks (overconfidence, repetition) **into `bias.detector`** so detection has one home,
then have heuristic introspection **read `cognitive_bias` entities** and reflect on them
(lessons/insights) instead of re-detecting.

---

*Spun off from the Channel-A trait-edges work. The bigger, forward-looking opportunity —
lifting hardcoded mechanism constants into the developable Channel-A layer — is catalogued
separately in [__FACULTY_CONSTANTS_CHANNEL_A_TODO.md].*

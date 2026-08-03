# High-Value Engineering Contributions

These are scoped, well-defined tasks that fit Will's existing architecture and would be welcomed per `CONTRIBUTING.md`.

## 1. Fill the Shell Sense Engines

**Status:** Scaffolded but empty (`src/cognition/senses/vision.ts`, `somatosensation.ts`, `olfaction.ts`, `gustation.ts`)

**What to do:**
- Implement a `VisionEngine` that accepts image captions, bounding boxes, or CLIP embeddings and produces `percept.visual` events with salience scores
- Cross-modal binding is already stubbed — a second sense producing percepts would activate it
- Keep it deterministic: no unseeded RNG, no wall-clock reads inside `react()`

**Why it matters:** Will claims "five sensory domains" but only audition is live. This is the most obvious gap in the codebase.

---

## 2. Expand the `GenerativeModel` into Real Active Inference

**Status:** Currently an EMA + gating threshold (`src/cognition/generative.model.ts`)

**What to do:**
- Replace the simple EMA with a precision-weighted prediction error computation
- The `GenerativeModel` is called "the active-inference substrate" in docs but does not compute free energy or precision
- Implement per-stream precision estimates that decay with stale observations
- Gate consolidation and executive activation on *prediction error magnitude*, not just threshold crossing

**Why it matters:** Would make the "surprise-gated" claims in the README actually true rather than aspirational. The seam is clean — the gating interface already exists.

---

## 3. Build a `DeliberationCache` within the Agency Pipeline

**Status:** The `DeliberationEngine` (`src/cognition/agency/engines/deliberation.engine.ts`) makes an LLM call on every ambiguous action selection

**What to do:**
- Add a fast-path cache keyed by a **cognitive fingerprint vector** (~50D state vector: energy, stress, PAD affect, goal priorities, top percept saliences, top belief confidences)
- Value: past deliberation outputs (action choice + arguments)
- Gate: reuse existing `GenerativeModel` precision score — if precision is high, trust the cache
- On cache miss or low precision: call LLM, store result, update competence score

**Key constraint:** The cache must be deterministic — no hash maps with nondeterministic iteration order. Use sorted arrays or fixed-size ring buffers.

**Why it matters:** This is the *smallest scope* where a cache can genuinely reduce API costs without touching narrative, introspection, or planning blocks. It stays within the agency subsystem.

---

## 4. Background Verification + Competence Scoring

**Status:** The `ReafferenceEngine` exists but does not feed back into a cache competence model

**What to do:**
- When the `DeliberationCache` hits, fire the LLM call **asynchronously** (off the hot tick path)
- Compare LLM output to cache output
- Use match rate to update the `GenerativeModel` precision estimate for that cognitive domain
- This closes a real learning loop: cache predicts → action executes → outcome observed → precision updated

**Why it matters:** Makes the cache self-calibrating. A cache without a verification loop is dangerous — it will silently degrade.

---

## 5. Add Per-Effector Cost and Preconditions

**Status:** Explicitly on the roadmap (README: "Per-effector cost/preconditions and entity-targeting are on the roadmap")

**What to do:**
- Extend `EffectorSchema` with `cost: number` and `preconditions: string[]`
- Teach `ActionSelector` to read cost/preconditions from the schema registry
- The `MotorSchemaExecutor` already has a binding phase — add precondition validation before enactment
- Consider energy cost: high-cost effectors should drain `energy.level` on enactment

**Why it matters:** Well-scoped feature with a clear user need (game NPCs, smart home, robotics). The seam is stable.

---

## 6. Expand the PMA Eval Harness

**Status:** `PMAEvalHarness` (`src/pma/eval.ts`) has only 4 standard probes

**What to do:**
- Add probes for: social interaction under stress, goal abandonment, creative exploration, moral dilemma response
- Make the structural phase (Phase 1) runnable in CI without any API key
- Add a `runPMAEval` CLI command or example script
- Consider adding a "drift detector" that flags when a loaded PMA's beliefs diverge from the source beyond threshold

**Why it matters:** The PMA is one of Will's genuinely novel contributions. Better eval coverage makes the "portable mind" claim empirically defensible.

---

## 7. Implement Learned Consolidation Rules

**Status:** `PersonaConsolidator` has 37 hand-authored rules (`src/cognition/faculties/persona.consolidator.ts`)

**What to do:**
- Mine the event log (`data/wills/{id}/events/`) for statistical correlations between introspection signals and later behavioral outcomes
- Discover candidate meta-cognitive edges (e.g., "high arousal + failed plan → lower plan bias gain")
- Pre-compute offline, load as a rule table at boot — keeps the tick path deterministic
- Compare hand-authored vs. discovered rules via behavioral probe fidelity

**Why it matters:** Would be the first empirical test of whether Will's meta-cognition loop can discover its own edges rather than relying on the developer's priors.
# High-Value Engineering Contributions

> **Standing:** DESIGNED · 2026-08-03 · scoped invitations for contributors, not commitments. Two have since been overtaken by the engine and are marked so inline (§1 partially, §5 fully) — check an item against `src/` before taking it, because this document does not update itself

These are scoped, well-defined tasks that fit Will's existing architecture and would be welcomed per `CONTRIBUTING.md`.

## 1. Fill the Shell Sense Engines

**Status:** Three remain shells — `src/cognition/senses/vision.engine.ts`, `olfaction.engine.ts`, `gustation.engine.ts` (~24 lines each, via `ShellSenseEngine`, producing no percepts).

**`somatosensation.engine.ts` is no longer one** — the SIGNAL_BOUNDARY epoch gave it real transduction for system signals and webhooks, so it produces percepts today. Which means the cross-modal condition below **has already been met**: see the note added to `SENSES_HARDENING.md` §6.

**What to do:**
- Implement a `VisionEngine` that accepts image captions, bounding boxes, or CLIP embeddings and produces visual percepts with salience scores
- Keep it deterministic: no unseeded RNG, no wall-clock reads inside `react()`
- Decide the representation deliberately before coding. **A screenshot is not a percept** — a bitmap carries no `sourceEntityId`, no salience, nothing to bind cross-modally and nothing for the `GenerativeModel` to predict. Three candidate answers: *structural* (an accessibility tree, so entities fall out for free), *described* (a caption becomes the percept — cheap, hostile to determinism, and it puts an LLM call inside a sense engine, so do not choose it by accident), or *attended* (regions of interest as entities with their own salience — most faithful, most expensive).

**Why it matters:** Will claims "five sensory domains" and two are live. Vision is the valuable one — and cross-modal binding is no longer waiting on it, because somatosensation already met that condition.

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

## 5. ~~Add Per-Effector Cost and Preconditions~~ — SHIPPED, do not take this

**Status: done 2026-07-05/06.** `EffectorDeclaration` (`agency/types.ts`) carries
`description`, `cost`, `valence`, `preconditions`, `binds` and `tags`;
`externalSchemas()` populates them onto the `MotorSchema`, and they flow through
the affordance build and selection. There is no `EffectorSchema` type — that was
never the name. Entity *and* object targeting shipped the same week.

**What is actually still open in this area,** and is the real invitation — all
three from `CUSTOM_ABILITY_WIRING.md` Phase 2+:

- **Field width.** N objectless effectors all enter the always-offered floor, so
  a host declaring a large catalog emits every one of them every tick. Gate
  external affordances by attention/preconditions instead. This is the
  highest-value item on this page.
- **Revoking a runtime grant.** Granting at runtime adds the schema
  (`SchemaRepertoire.registerExternal`); removing one does not exist, and the
  backend `PATCH /v1/wills/:id/effectors` route is unwired.
- **Verify the learning surface.** External schemas accrue `LearnedSkill` stats
  via reafference, but that host acks feed `recordOutcome` with a meaningful
  `outcomeQuality` is unverified — so "the Will gets better at your effectors"
  is a claim without a test behind it.

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
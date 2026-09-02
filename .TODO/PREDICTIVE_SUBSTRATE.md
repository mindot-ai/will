# PREDICTIVE_SUBSTRATE_TODO — unify SalienceComputer into GenerativeModel

> **Standing:** SHIPPED · 2026-06-03 · 4 of 4, opened 2026-06-02 as a detour from [[METACOGNITION_CYCLE]] — `SalienceComputer` folded into `GenerativeModel`, one predictive substrate instead of two

> Detour from `METACOGNITION_CYCLE_TODO.md` (resume there after this lands). Goal: collapse the
> duplicated per-stream "predictive surprise" substrate. `SalienceComputer` and `GenerativeModel` both
> maintain an EMA prediction + a normalised deviation per stream — the same computation, done twice in
> every engine. `SalienceComputer` is the thinner re-implementation (its own docstring called it a
> placeholder for "a future Active Inference generative-model replacement").

## Evidence the usage has converged (audit 2026-06-02)
- Engine-facing surface is tiny and parallel: both are `observe()` + `snapshot()`/`restore()`;
  salience adds `setPrecision()`.
- `GenerativeModel.predict / anticipate / configureStream / meanError / isStable` = **0 call-sites** in
  `src` — dead surface, nothing to preserve.
- The two `observe()`s are frequently the **same call twice** on the same `(stream, value)`: one to gate a
  publish (`_model.observe(s,v).gated`), one to score it (`_salience.observe(s,v)`).

## Target
`GenerativeModel` becomes the single substrate. Its `observe()` returns `{ error, normalized, gated,
salience }` — `gated` from the madEma×20 scale (unchanged), `salience` from the EW-variance×3 × precision
(ported verbatim from `SalienceComputer`). It gains `setPrecision()`/`getPrecision()`. `SalienceComputer`
is retired. **Behavior-preserving:** both deviation scales are kept (don't fold them onto one normalisation
in this pass — that's a separate calibration decision), so no `WORKSPACE_THRESHOLD`/test recalibration.

## Plan (progressive — each phase its own green PR)

- [x] **P1 (#90) — Extend `GenerativeModel` (additive, zero behaviour change).** Add per-stream `m2` (EW variance),
  a `_precision` map + `setPrecision`/`getPrecision` (clamp [0.1,3.0], 0.02 mean-reversion on observe), and a
  `salience` field on the `observe()` return computed exactly as `SalienceComputer` does (cold-start → 0).
  Thread `m2`/`precision` through snapshot()/restore(). Nothing reads `salience` yet → fully safe. Tests:
  port the salience/precision/adaptive-variance cases onto `GenerativeModel`.
- [x] **P2 (#91-95 + this PR) — Migrate engines to the single object (batched).** Per `observe` site, one of 3 cases:
  *paired* (`gate`+`score` on same `s,v`) → collapse to one `observe`, use `.gated` + `.salience`;
  *salience-only* → `_model.observe(s,v).salience`; *gate-only* → `.gated`. Replace `_salience.setPrecision`
  → `_model.setPrecision`; `onCognitiveEvent`'s `_salience.observe(e.type,e.salience)` → `_model.observe(…)`.
  Drop the `_salience` field (6 engines are salience-only — there just rename `_salience`→`_model`). Merge
  the two snapshot sub-states into one `model`.
  - **Must not blind-sed** (collapsing same-stream pairs is mandatory — a double `observe` on one stream/tick
    corrupts the EMA). Watch stream collisions between a salience-only site and a gating site.
  - Suggested batches: (a) metacog engines, (b) affective evaluators, (c) regulatory/perceptual, (d) memory,
    (e) social + remainder.
- [x] **P3 (this PR) — Retire `SalienceComputer`.** Delete once no engine references it (or leave a deprecated
  re-export for one release). Drop `salience.test.ts` / fold into generative tests.
- [x] **P4 (this PR) — Verify.** typecheck + full suite, with special attention to `determinism.guard`,
  `engine.snapshot.restore`, `precision.perception`, `cognition.bus`. Behaviour-preserving ⇒ green.

## Invariants to hold throughout
- **R2 (determinism):** pure functions of state; no wall-clock/RNG. (Unchanged.)
- **FN9 (snapshot/restore):** one merged `model` sub-state per engine round-trips losslessly.
- **No recalibration:** `gated` keeps madEma×20; `salience` keeps variance×3×precision; `WORKSPACE_THRESHOLD`
  untouched.

---

## DONE (2026-06-03)
All 36 engines (incl. executive, semantic integrator/clustering, audition) now hold a single
`GenerativeModel`; `SalienceComputer` is deleted. `observe()` returns `{ error, normalized, gated, salience }`
— gating (madEma×20) and salience (EW-variance×3 × precision) on separate scales, behaviour-preserving
(stationary streams unchanged; bit-for-bit parity validated in P1 before retirement). Snapshot sub-states
merged to one `model` per engine. Tests that exercised `SalienceComputer` directly were ported to
`GenerativeModel` or folded in; `salience.test.ts` removed. Full suite green; typecheck clean.
Resume `METACOGNITION_CYCLE_TODO.md`.

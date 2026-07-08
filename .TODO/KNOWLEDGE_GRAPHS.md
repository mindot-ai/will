# Knowledge graphs → architecture documentation (roadmap)

> **Status:** graphs SHIPPED (2026-07-08) — `docs/graphs/*.svg`, generated from
> declarative specs by `docs/graphs/generate.ts` (design system: `lib.ts`).
> This file is the roadmap for the NEXT phase: pairing each graph with prose so
> a contributor can engage with Will without a tour guide.

## What exists

Eight graphs, one visual language (a category color is the same in every graph
— violet is always memory, amber executive, green agency…). Regenerate after
edits: `bun docs/graphs/generate.ts`. Verify visually: headless-Chrome
screenshot of the SVG (qlmanage crops to square — don't use it).

| Graph | Covers |
|---|---|
| `memory-cycle` | WM → episodic → beliefs; forgetting/dream/spaced loops; recall into thought; → PMA |
| `executive-dual-process` | salience → activation → effort gate → ideation/decision; facets, pump, CompletionInbox, recorder |
| `agency-pipeline` | field sources (innate/host/percept/ideomotor/plan) → afford → compete → deliberate → enact → reafference → skills |
| `audition-conversation` | ingest → grants → percept salience → conversation facet → [REPLY_TEXT] → outbox; exchange → memory |
| `affect-body` | 5 regulators + 7 evaluators → blender (VAD) → prompt/selection/salience/projections |
| `determinism-tick` | command-buffer tick, phases, seeded PRNG, pump/inbox quantization, record ⇄ re-feed replay |
| `pma-lifecycle` | living ⇄ artifact circle; what travels; reconstruction eval |
| `composition` | capstone: hosts → four surfaces → stem/tick/LLM/PMA → the eight engine systems |

## Phase 2 — the paired prose (docs/architecture/)

One markdown page per graph, `docs/architecture/<graph-name>.md`, each opening
with its SVG embedded, then ~600–1200 words. Per page:

- [ ] **Walk the graph left→right** — every node named in the graph gets one
      paragraph anchored in the real code path (file references, clickable).
- [ ] **The one non-obvious rule** each subsystem carries (memory: recall is a
      single surface driven by focus.recallQuery; executive: facets ARE the
      same self; agency: parameters bind from the situation, args via ideomotor;
      audition: silence is an outcome; tick: commands never state; PMA:
      save vs hibernate).
- [ ] **"Where to start reading"** — the 2–3 source files that own the loop.
- Source of truth for claims: the code + `.TODO/` design records (facet replay,
  custom ability wiring, audition determinism) — not memory or vibes.

Order (dependency-friendly): determinism-tick → memory → affect-body →
executive → agency → audition → pma → composition (the capstone page doubles
as the docs index / CONTRIBUTING "how it all plays out" entry).

## Phase 3 — integration

- [ ] README: replace the long Architecture prose section's opener with the
      composition graph + link to docs/architecture/ (keep the deep prose).
- [ ] CONTRIBUTING.md: point new contributors at the capstone page first.
- [ ] Graph/code sync policy: any PR that adds/renames an ENGINE or reroutes a
      major loop updates the affected graph spec in the same PR (specs are
      code — review them like code).

## Later / nice-to-have

- [ ] Two graphs not yet drawn: **social cognition** (ToM/empathy/reputation/
      known-entity dossiers → prompt) and **meta-cognition** (introspection →
      persona prior → engine configs write-back).
- [ ] Light-theme variants (the renderer takes a palette swap; GitHub README
      renders dark SVGs fine on both themes since the canvas paints its own bg).
- [ ] Animated capstone (SMIL pulse along the tick loop) for the landing page.

# Changelog

## Unreleased

- **Deterministic replay now holds end-to-end with the LLM in the loop** — the
  R2-d capstone (record a run's completions → re-feed into a fresh same-seed
  run → byte-identical state) is re-enabled and passing. Three fixes: facet
  decision effects land tick-quantized (`CompletionInbox`), replay re-feed is
  prompt-keyed (order-independent), and facet reasoning launches from a
  per-tick pump with the tick's frozen snapshot (never at raw report time).
  Facet spawning/reasoning flexibility unchanged; live replies shift by ≤1 tick.

## 0.1.0 — 2026-07-02 · first public release

An engine for persistent machine minds: 38 cognitive faculties across seven
systems, a learning agency pipeline, five sensory channels, and a dual-process
LLM executive — deterministic, persistent, and portable.

- Continuous tick-clock cognition: energy, sleep, affect (~25 continuous
  dials), memory consolidation, goals, beliefs, autobiographical narrative
- Agency pipeline: affordances found in the situation → selection →
  deliberation → motor schemas → reafference (skills proceduralise)
- Planning-as-prior: plans bias the one action competition (no side channel)
- PMA (Persistent Mind Artifact): distill → restore/fork a mind across
  process boundaries
- Deterministic core: seeded RNG, fixed clock, tick-pure engines, LLM
  record/re-feed seam (known gap: concurrent facet-chain interleaving —
  see .TODO/FACET_REPLAY_DETERMINISM.md)
- Zero-key quickstart: `bun run examples/hello-will.ts` (mock executive)
- Apache-2.0

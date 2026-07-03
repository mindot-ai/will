# Facet-era replay determinism gap (R2-d regression)

**Status:** OPEN — `tests/integration/replay.equivalence.test.ts` is `it.skip`'d on this.
**Found:** 2026-07-02, while making the suite CI-green for the public release.
**Updated:** 2026-07-03 — two of three layers fixed; the remaining work is precisely scoped.

## The gap — three layers

1. **Landing** ✅ **FIXED** (`cognition/completion.inbox.ts`). Facet decision effects
   (PlanningEngine plan mutations, AuditionEngine outbox writes via the direct
   `facet.subscribe` listeners) used to apply at raw LLM-promise resolution — an
   arbitrary wall-clock moment that could interleave with a tick in flight. They now
   stage in a `CompletionInbox` and land at the top of Phase 2, tick-quantized and
   FIFO, alongside the (already tick-aligned) bus events. This also restores the
   frozen-snapshot invariant: nothing mutates shared state while engines read.
   Facet spawning/reasoning flexibility is untouched — only the return path is
   disciplined. Chunk streaming stays real-time (client flow, not sim state).

2. **Pairing** ✅ **FIXED** (`core/completion.recorder.ts`). `RecordedCompletionSource`
   matched completions to calls by strict per-tick sequence, so a master/facet
   issue-order flip mispaired the whole tail (phantom `prompt diverged`). It now
   matches by **byte-identical prompt within the tick** — order-independent, still
   strict (a real divergence has no matching record and throws; identical duplicate
   prompts consume FIFO).

3. **Issue** ⬜ **REMAINING — the real work.** Facet reasoning *starts* at raw
   report/resolution time (`facet.report()` → fire-and-forget `_reason()`), and
   `_reason()` builds its prompt from `_currentStateRef` — the **live** state at that
   wall-clock moment. Both the issue tick and the prompt bytes are therefore
   race-dependent. Observed empirically (2026-07-03, with layers 1+2 fixed): run B's
   tick-1 facet prompt has **no byte-identical record** in run A, and run B issues
   calls at ticks (7, 47) that run A never recorded — A recorded 12 completions, B
   consumed 2 before its chains died on misses.

## The remaining fix — input-side quantization (symmetric to the landing inbox)

Quantize reasoning **start** to tick boundaries:

- `facet.report()` enqueues the report into a pending-report queue instead of firing
  `_reason()` immediately;
- the queue drains at a deterministic tick point (Phase 2, after the completion
  inbox — or start-of-tick), launching `_reason()` with **that tick's frozen
  snapshot** rather than the live ref;
- prompt inputs then become pure functions of (tick, seed, recorded external
  inputs): issue tick, prompt bytes, and (with layer 1) landing tick are all
  deterministic. `_masterSyncHistory` is already tick-aligned (it arrives via the
  bus), so no change there.

Effort: medium. Touches `facet.ts` (report queue + snapshot capture), the
orchestrator drain point, and the `stepSettled` quiescence contract in the test
(reasoning now spans: report tick → issue tick → land tick).

Note: live conversation latency is unaffected in practice — a report waits at most
one tick (≤1 s) before reasoning starts, noise against multi-second LLM latency.

## Why this matters beyond the test

Deterministic replay is a core product lever (audit/AI-Act story, PMA fork/restore,
forensic "why did it do X"). Today that guarantee holds for the deterministic core
(seeded RNG, fixed clock, tick-pure engines — R2-a/b/c all still pass) and for
*effect landing* (layer 1), but NOT yet for multi-chain LLM issue timing.

## Re-enable criteria

Un-skip `replay.equivalence.test.ts` when layer 3 lands. The harness is already
correct (per-tick quiescence draining, 100 ms quiet windows — see the file's
comments for the heisentest history) and asserts the right thing; only the
issue-side guarantee is missing.

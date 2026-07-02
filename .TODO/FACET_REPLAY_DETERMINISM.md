# Facet-era replay determinism gap (R2-d regression)

**Status:** OPEN — `tests/integration/replay.equivalence.test.ts` is `it.skip`'d on this.
**Found:** 2026-07-02, while making the suite CI-green for the public release.

## The gap

The R2-d capstone test (record a run's LLM completions → re-feed them into a fresh
same-seed run → assert byte-identical state) no longer holds. Diagnosed root cause,
in increasing depth:

1. **Off-tick reasoning.** The facet-era executive runs its LLM chains asynchronously
   across ticks (real timers + promise chains), so *when* a completion lands is
   wall-clock — not seed — determined. (The test now pins this per tick by draining
   to quiescence; that part is fixed in the harness.)
2. **Concurrent chain interleaving — the real blocker.** Around the same tick, the
   MASTER executive and a DELIBERATION FACET both issue LLM calls concurrently. The
   record/re-feed seam (`core/completion.recorder`) matches completions by
   *(tick, call order)* — but the order in which the two chains reach the LLM is a
   race. Observed directly: run A recorded `master` first at tick 1; run B's first
   call at tick 1 was the `facet` (system prompts differ: "unified cognitive core"
   vs "focused facet … Deliberation"), so the strict source threw
   `prompt diverged at tick 1`.
3. **State bleed between racing chains.** Because completions mutate state when they
   land, a different interleaving also changes the *content* of the next prompt
   (observed: `## Active Ruminations` empty vs populated with affordance percepts) —
   divergence compounds.

## Why this matters beyond the test

Deterministic replay is a core product lever (audit/AI-Act story, PMA fork/restore,
forensic "why did it do X"). Today that guarantee holds for the deterministic core
(seeded RNG, fixed clock, tick-pure engines — R2-a/b/c all still pass) but NOT for
the multi-chain LLM layer above it.

## Fix directions (in preference order)

1. **Order-independent completion matching.** Key recorded completions by
   `(tick, callerId, hash(systemPrompt))` instead of FIFO-per-tick. Handles
   master/facet races without touching cognition. Does NOT fix state-bleed (3):
   two runs may still interleave *landings* differently. Probably combine with (2).
2. **Deterministic completion landing.** Queue completion effects and apply them at
   a deterministic point (start of the next tick, ordered by callerId) instead of
   wherever the promise resolves. This makes (3) disappear and is the architecturally
   right move: the LLM stays an async oracle, but its *effects* enter the simulation
   on the tick clock. Medium effort, touches executive/facet effect application.
3. **Serialized replay mode.** A replay-only flag that serializes all LLM chains
   through a single-flight queue ordered by (tick, callerId). Cheapest correct
   option; replay runs slower than live (fine — replay is offline).

## Re-enable criteria

Un-skip `replay.equivalence.test.ts` when (1)+(2) or (3) lands. The test harness is
already correct (per-tick quiescence draining, 100 ms quiet windows — see the file's
comments for the heisentest history) and asserts the right thing; only the engine
guarantee is missing.

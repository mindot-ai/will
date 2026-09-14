# Will — Feeling the Time It Was Away

> **Standing:** DESIGNED · 2026-07-31 · the clock resumes from the snapshot tick, so the arithmetic is correct; the *sense* of having been away is unbuilt

> A Will wakes from hibernation with its arithmetic correct and its **sense of
> elapsed time absent**. The clock resumes from the snapshot tick, so nothing
> computes a negative age any more — but an eight-hour sleep advances that tick by
> exactly one. From the inside, no time passed. This is about giving a mind the
> means to notice that it was away, and to let that matter.

---

## Where this came from

The restart boundary was fixed in two halves (see `agency/restart.ts` and
`WillStem.createWill`):

1. **Time must not go backwards** — `clock.setTick( previousState.tick )`, because
   entities snapshot with the tick they were written at and 42 comparison sites
   across 19 files compute `tick - stampedTick`.
2. **Work in flight does not resume** — `awaiting` intents and consequence
   descriptors are dropped before restore, because sleeping is not the world
   declining to answer.

Half 2 exists *because* of the gap this TODO describes. Since the tick does not
advance across the absence, stale in-flight state looks plausibly **recent** on
wake rather than obviously impossible, so it has to be swept explicitly. If the
mind had a real sense of how long it was gone, that sweep could become a
judgement it makes rather than a rule the machinery applies — which is the shape
this codebase prefers (see `.TODO` neighbours on Channel A/B and the persona-prior
seam).

---

## What is missing

- **No representation of the gap.** Nothing in state says "I was away for N".
  Percepts, goals, undertakings and dossiers all come back as though written
  moments ago.
- **Tick-denominated deadlines silently stretch.** `CONSEQUENCE_TTL_TICKS`,
  `AWAIT_TIMEOUT`, the facet idle TTL and the executive interval are all counted
  in ticks. Across an absence they measure *compute*, not *time*, so a promise
  made "15 ticks ago" may be a week old.
- **Social time is invisible.** "They have not replied" is a very different fact
  after 2 minutes than after 2 days, and the reputation / attachment / frustration
  stack cannot currently tell them apart.
- **Nothing to reason from.** The mind cannot say "I have been gone a while, let
  me check what changed" because it has no ground for the antecedent.

---

## Constraints any design must respect

- **R2 replay determinism.** Wall-clock must not enter the agency competition or
  any engine decision path. `createdAt: wallClock()` already exists on some
  entities as telemetry; reading it in a scoring function would break replay. Any
  elapsed-time signal has to be recorded once at the boundary as *state*, then
  read deterministically from there.
- **Do not bolt it onto the tick.** Making the tick jump to approximate elapsed
  time would corrupt every tick-denominated interval at once and re-break the
  arithmetic the restart fix just repaired.
- **Build the cog, not the behaviour** (see memory `build-cogs-not-behaviors`).
  The goal is that the mind *perceives* the absence and decides what it means —
  not that the machinery mandates a "you were away, do X" response.

---

## Sketch (not a decision)

Record the absence once, at the restore boundary, as a first-class percept the
mind can reason about — the same shape the undertaking percept uses:

- a `session.absence` entity written in `createWill` alongside the tick resume,
  carrying the wall-clock gap measured **once** at the boundary and the tick it
  resumed at;
- surfaced through Exteroception in the first-person register the prompt already
  uses ("I have been away about nine hours; what I last knew is that old");
- available to the faculties that reason about social time — so "they have not
  answered" can be weighed against how long the silence has actually run.

Open questions to settle before building:

1. Does an absence age the things that were true when it slept — undertakings,
   goals, the freshness of a dossier — or only inform the mind that they might be
   stale? The second is more honest and more in keeping with the architecture.
2. Should tick-denominated deadlines gain an absolute floor, or is that
   double-counting once the mind can see the gap itself?
3. Is a long absence a physiological event too (circadian phase, energy, sleep
   pressure), or purely epistemic? The regulators currently rebuild from tick 1
   because `restore` passes `{ metrics: false }`.
4. What is the smallest gap worth noticing? A 30-second process restart should
   probably produce nothing at all.

---

## Status

Not started. Deliberately deferred rather than bolted onto the restart-boundary
fix — that change is about arithmetic and lifecycle correctness, this one is
about what a mind *knows* about its own discontinuity, and they should not be
conflated.

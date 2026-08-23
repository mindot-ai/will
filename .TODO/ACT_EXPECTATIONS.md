# ACT_EXPECTATIONS — an act is still in the air until the world says otherwise

> **Status:** SKETCH (2026-08-21). Deliberately short: its design depends on
> decisions not yet made in [[SIGNAL_BOUNDARY]], and writing it out in full
> before those land would be guessing in detail.
>
> **The one-line thesis:** speech already knows when it is still waiting for an
> answer. Acts do not, and that missing representation is why a mind can warn
> someone and never connect their leaving to it, or look one person up
> sixty-five times with nothing able to say *"I have already asked this."*

---

## What already exists, and is the model to copy

`conversation.aim.ts` is a complete, working instance of long-horizon
self-attribution — for speech only:

- **`SpokenTurn.answeredAt` / `unansweredAt`** — durable, snapshotted, and
  deliberately *not* bounded by the 30-tick echo window.
- **`isOpen(t)`** — *"a turn still in the air: said, not acknowledged-only, and
  not yet answered."*
- **`resolveReplyExpectations`** folds the world's answer — **or its absence** —
  onto the turns still in the air. Silence resolves a turn; it does not leave it
  dangling.
- It reaches the executive prompt (`## What I've Said Lately`) carrying
  `answered` and `answeredWith`, so **the mind does the attributing**, not a
  matcher.

That last property is the whole design principle, and it is already proven here:

> The engine does not infer that Friday's reply was caused by Monday's message.
> It shows the mind *"you said this, to them, N ticks ago, unanswered"* and lets
> the executive make the link. Long-horizon attribution is **reasoning, not
> matching** — a smarter matcher would be wiring the behaviour instead of giving
> the mind the cog.

---

## The asymmetry to resolve first (do not skip this)

For speech, "in the air" means **awaiting a reply**, and `answeredAt` closes it
because being answered is what speech is *for*.

An act has no such natural closer. Its ack returns immediately, so by the
mechanical layer's reckoning an act is never in the air at all. What an act is
actually waiting for is **the change in the world it was performed to cause** —
and that is goal-shaped.

So the first question is not "how do we track open acts" but:

> **Is an act-expectation a new mechanism, or is it `GoalState.completionCondition`
> finally being read on the act side?**

Leaning: **mostly the latter.** `completionType: 'metric' | 'action' | 'epistemic'`
and `completionCondition` already exist and already express "the world should end
up like this". An act performed toward a goal inherits that goal's expectation.
An act performed with no goal behind it is exactly the case that should be rare —
and when it happens, that is worth surfacing rather than tracking.

**Do not build a parallel expectation store before this is settled.** A second
mechanism that means what `completionCondition` already means is the "extra wire
to hold the roof" this codebase is trying to stop building.

---

## What it would give the mind (the cases that motivated it)

All observed live on the COO deployment:

| observed | what is missing |
| :--- | :--- |
| Warned someone; they left days later | nothing links the two, on any horizon |
| Looked one person up **65 times** | no representation of *"I have already asked this"* |
| Silence read as a possible Discord timeout | cannot suspect *her own* prior over-messaging as the cause |
| Reported work she had never done | no standing record of "what I set out to cause, and whether it happened" |

Note the last row: this is the completed-work-hallucination pattern, and it is
plausibly the *same gap*. A mind with a durable "here is what I set in motion and
here is what came back" is much harder to confuse about what it has done. That
makes this epoch a candidate fix for a problem currently filed as a separate
mystery — worth testing before treating them as two.

---

## Phases (provisional — depends on SIGNAL_BOUNDARY P0/P2)

### P0 — Read what exists
- [ ] Audit whether `completionCondition` can carry act-expectation semantics
      unchanged. Settle the question above **before writing any new type**.
- [ ] Establish whether an act's `sourceIntentId` survives onto the afference
      (SIGNAL_BOUNDARY P0 delivers this) — without it, no later mechanism
      can ask the question at all.

### P1 — Acts that are still in the air
- [ ] `isOpen`-equivalent for acts, derived from goal expectation rather than a
      new store if P0 says that is sound.
- [ ] Resolution folds **both** outcomes, like `resolveReplyExpectations`: the
      world changed as intended, *or* the window closed and it did not. An
      expectation that merely expires unrecorded teaches nothing.

### P2 — Surface it, do not infer from it
- [ ] The open set renders in the executive prompt, in the register
      `## What I've Said Lately` already uses. Cap and retention are decisions,
      not magic numbers — see SIGNAL_BOUNDARY's finding that the same
      string had three different caps (120 / 300 / 700) and the tightest one
      silently governed cognition.
- [ ] **No inference engine.** The mind attributes; the engine only remembers
      and shows.

## Scope notes

- **NOT in scope:** informational novelty ("did it *help*" vs "did it *work*") —
  related, genuinely missing, and a *learning* question rather than a
  representation one. Keep them apart or both stall.
- **NOT in scope:** widening the sense boundary. A mind cannot attribute a
  consequence it cannot perceive, but that limit is honest and separate.
- **Risk:** this is the kind of item that quietly grows into a causal-inference
  engine. The guard is the principle above — if a phase starts *deciding* what
  caused what, it has left this document.

## Related
- `.TODO/SIGNAL_BOUNDARY.md` §3b — the two-reconciliation split this
  extends; its P0 `sourceIntentId` is this epoch's prerequisite.
- `src/cognition/agency/conversation.aim.ts` — the reference implementation.
- `.TODO/ENVELOPE_NARROWING.md` — sibling gap on the learning side.

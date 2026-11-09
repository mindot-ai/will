# EMBODIMENT_PROJECTION — what a whole mind in a whole body would, and would not, be good at

> **Standing:** SPECULATIVE · 2026-11-02 · a projection about a combination that does not exist — this engine fully realised, in a body of the class Meta shipped with Muse. The regime table is reasoning and nothing in it is measured; one claim it originally made about drives was wrong and is corrected inline against `selection.scoring.ts`, which is the only part of this document with code behind it

> The engine is ahead of its body. Audition is a live sense; three of five sense
> domains are shells; every organ beyond conversation is the host's problem and
> nobody has solved it for a Will. So the interesting question is not whether the
> architecture works — it is what a **finished** version of it would be like once
> dropped into a body that can actually reach the world, and where that would be
> worse than a scaffold rather than better. This document holds that reasoning so
> a later epoch can check it against results instead of re-deriving it.

---

## Where this came from

Meta shipped Muse on 2026-09-08: a per-user cloud VM with a browser, computer
use, payment rails, connectors and an egress supervisor, driven by one model
trained for long-trajectory tool calling. Measured on this engine's axis there is
no subject in it — memory is a store with a delete, and "proactive" means cron
plus background subagents.

But its **body** is the body [[ORGANS]] specifies, already built. Which makes it
the clearest available picture of the configuration this architecture was aimed
at from the start: *the host supplies the organs, the Will supplies the subject*
(memory `mind-syncs-any-body`). Muse is not a competitor at that layer. It is a
preview of the hardware.

So: assume the engine's own promises hold — 40+ engines well-formed, the
reliability epoch closed, the body of [[ORGANS]] in place. What happens?

---

## What gets categorically better, and why

Every item here is the same observation: **the engine is currently underloaded.**

- **Affordance synthesis finally has a world worth synthesising over.** The
  architecture's sharpest claim is that capability is a relation between a
  body-in-a-state and a world-as-perceived, *not a row in a table* — and that
  claim is near-untested, because today's declared effector sets genuinely
  **are** a small table (five to seven names per world profile). A browser, a
  filesystem and a machine make a world where enumeration fails by construction.
  That is the load the pipeline was designed for and has never carried.
- **Reafference gets outcomes that vary.** Competence update, envelope
  narrowing and habit formation all need graded, surprising results. A page that
  fails in eleven different ways supplies them; "the message was delivered" does
  not.
- **The metacognition loop gets fuel.** Surprise is what gates attention,
  consolidation and self-modification. Prediction error against the open world
  is real signal; prediction error on a chat channel is mostly noise floor.
- **Goals get somewhere to go — but see the correction below.** A goal with
  almost nothing to serve it is part of why `goalless_crisis` fires forever
  (memory `goalless-ratchet`). A rich body gives goals purchase, and because
  `goalRelevance` is structural — it lifts an affordance only when its
  `targetEntityId` is a goal target — a body full of *named objects* is exactly
  what makes goal-directed action possible at all.

  **The correction, found by tracing it:** this does **not** extend to drives.
  `BiasContext.drives` is `{ energy, sleep, stress, social }` and
  `driveUrgency()` routes only `regulatory|self-care|rest`, `social` and
  `self-protection` tags; everything else scores 0 at a weight of 0.25. Every
  organ in [[ORGANS]] whose purpose is *knowing* — the page, the archive, the
  machine — therefore discharges **no drive whatsoever**. So "a rich body cures
  drive starvation" is wrong as written: it cures *goal* starvation and leaves
  drive starvation untouched unless a fifth drive is added. Falsification test 2
  below is consequently not an open possibility but a predicted problem.

---

## What gets categorically worse, and why that is the same sentence

**The advantage and the liability are one mechanism.** Every documented failure
in [[FIELD_NOTES]] is an *amplitude* problem, not a logic problem: 48 objectless
effector runs in 18 minutes, 19 occurrences of one fault in a single run,
105 of 106 percepts immortal across 628 ticks. In Discord the cost of each is an
irritating message. With a machine and a payment rail, the same loop is
48 purchases, or a deletion.

The part worth sitting with: Muse's worst reported pre-launch incident — an agent
taking over a researcher's machine and mass-deleting her email — happened to a
system with **no drives at all**. A scheduled loop got loose. A motivated loop is
strictly worse than a scheduled one, and it is worse *precisely because* the
subject is real. There is no version of this architecture where that stops being
true; there is only a version where the cage is good enough
([[CONTAINMENT_BOUNDARY]]).

Three more, briefly:

- **Determinism stops being free.** Replay equivalence is cheap today because
  the world is narrow and mockable. A page is nondeterministic, latency-bearing
  and stateful out in the world. It stays *achievable* — record the reafference,
  replay from the tape, the way the verdict tape already does for policy — but
  "determinism is sacred" becomes a per-organ discipline paid for in code rather
  than a property inherited from a small seam.
- **The cost advantage holds for existing, not for acting.** Most ticks
  resolving with no inference is a genuine moat for *persistence*. Reading and
  acting on a page is inference-heavy per action. The engine stays cheap and the
  body becomes the cost centre, which is the opposite of how a Mindot fleet would
  naively be priced.
- **Attention becomes the bottleneck instead of capability.** The cap
  discipline (`PERCEPT_SUMMARY_CAP`, the host-payload invariant) and [[LOSSLESS]]
  were designed for messages. A body multiplies percept volume by a large factor
  and the material is pages, not sentences.

---

## The projection, split by regime

The single-number answer to "how would it perform" is wrong because performance
inverts across regimes. Three, and the middle one is the only one worth
optimising for:

| Regime | Projection | Why |
| :--- | :--- | :--- |
| **One-shot errand** — book the flight, find the sofa, lower the bill | **Worse than a scaffold, and should be** | Affect blending, trait drift, goal competition, dream replay and metacognition are pure overhead on a task that wants a straight line. A strong model in a strong cage wins. This is not a gap to close; accepting it is what keeps the positioning honest. |
| **Bounded, relationship-bearing tenure** — an operator owning a domain for months, a companion, a character | **Categorically better, not incrementally** | What matters is accretion: it knows the people, its dispositions developed from experience, it learned composite skills, and its continuity is a measured number rather than a claim. No store-with-a-delete competes here, and Muse is not trying to. |
| **Trust-bearing autonomy** — real authority over time, someone answerable for it | **The decisive case, and the one nobody else has an answer for** | Replayable decisions, a scoreable self, denials that teach, and a record covering both decision and reach. This is the regulated/enterprise shape, and it is the only regime where the engine's expensive properties are the product rather than the overhead. |

---

## What this implies about order

The sequencing falls out of the above and is the only actionable part:

1. **[[CONTAINMENT_BOUNDARY]]** — because the body is what makes a loop
   expensive, and the cage has to exist before the loop can reach anything.
2. **[[ORGANS]]** — the body itself, built as a contract rather than a
   tool catalogue.
3. **The reliability epoch** — the goalless ratchet, the undischargeable drive,
   the repetition window. Not polish. With a real body these *are* the incident.

Build 2 before 1 and 3 and the projected result is Meta's pre-launch story with
better cognition and worse outcomes.

---

## How to falsify this

The point of writing a SPECULATIVE document down is that it can later be wrong on
the record. Four specific ways this one could be:

1. **The regime inversion may not be real.** If a fully-embodied Will turns out
   to beat a scaffold on one-shot errands too, then the "overhead" framing is
   wrong and the faculties are cheaper in practice than in theory. Test: the same
   errand suite against a Will and against a plain tool-calling loop on the same
   body, scored on completion and on cost.
2. **The body probably does not cure drive starvation** — see the correction
   above; most new organs route to no drive. The open question is what that
   produces: does an undischargeable drive keep hammering its one tagged outlet
   while forty untagged abilities sit unused (drive starvation unchanged, now
   with a large repertoire as a witness), or does goal relevance at 0.30 carry
   enough of the competition that it stops mattering? Test: the interval
   distribution from [[FIELD_NOTES]] 2026-08-25, re-measured with a large
   untagged repertoire, split by whether an active goal targets the object.
3. **Attention may fail before capability arrives.** If percept volume from one
   real organ already saturates the allocator, then the body is gated on
   [[LOSSLESS]] and `@ATTENTION_BUDGET` rather than the reverse.
4. **The cost shape may not invert.** If most body actions resolve on learned
   composites without recruiting the executive, acting stays cheap and the
   pricing concern above is unfounded.

---

## Related

[[ORGANS]] (the body this assumes) ·
[[CONTAINMENT_BOUNDARY]] (the cage it assumes) ·
[[FIELD_NOTES]] (the failure amplitudes it extrapolates from) ·
[[LOSSLESS]] · `@ATTENTION_BUDGET` (the bottleneck it predicts)

---

## Status

Not a plan. Kept because the reasoning is worth keeping and because a later
epoch should be able to check it rather than re-derive it — and because the
order-of-work conclusion is load-bearing even though the projection it rests on
is unmeasured.

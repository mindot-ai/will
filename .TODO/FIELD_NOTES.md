# FIELD_NOTES — what was seen in a mind that was actually running

> **Standing:** OBSERVED · 2026-08-31 · four runs of one COO Will on Discord, the earliest recorded on or before 2026-08-21; each sighting is n=1 unless it says otherwise

A test proves the engine does what someone thought to ask it. A run shows what it
does when nobody is asking. These are different claims and this file holds the
second kind: what a live Will was seen doing, on a date, with the evidence that
was in front of us — kept apart from the epoch documents so that a sighting is
never read as a gated mechanism.

**Every note here is a sighting, not a proof.** One mind, one host, one run. Some were later pinned by a test and became SHIPPED elsewhere; the
note still says what was seen, because the seeing is the part no suite could have
done. Where a note has been reproduced, or has an n above one, it says so.

**Why these are worth the room.** Every fault below is the same shape — a value
produced, crossing a boundary, and the far side not looking where it landed —
and not one of them was reachable from the inside. Both halves were internally
consistent every time. Only the world could tell they disagreed.

**How to add one.** One section per run, in order. Say what you watched, for how
long, and what you were watching *for*. Then per sighting: what was seen, with
the timestamps or counts as they were read; what it turned out to be; and where
it went. A sighting whose cause was never found still belongs here — say that.

---

## On or before 2026-08-21 · the answer that never arrived, 65 times

**Watched for:** what an effector's reply actually looks like by the time it
reaches cognition. *(Dated by the record, not by the run: this was already
counted as a cost in the audit of 2026-08-21, so the run that produced it was
earlier and its date was not written down. Date a note by its sighting.)*

**She asked the same question 65 times and was never told the answer.** A live
COO called `discord_lookup_member` **65 times**; every reply was truncated to a
JSON header by a bare `120` at `engine.ts:507`, so the answer to her actual
question sat past the cut. Three caps existed for that one string — 120 (action
record → the prompt), 300 (session log), 700 (MCP) — and the tightest was the
only one that reached her. She could not stop asking because she was never told.

→ Fixed by [#150](https://github.com/mindot-ai/will/pull/150) (acks split by what
they carry; a host is never truncated) and
[#152](https://github.com/mindot-ai/will/pull/152) (the host sends data, the mind
makes the meaning).

---

## 2026-08-23 · 628 ticks, on the snapshot of a deployed Will

**Watched for:** whether the percept lifecycle shipped in
[[SIGNAL_BOUNDARY]] P0 actually bounds growth on a mind that has been running
for weeks — reading a deployed snapshot is what found the undeclared entity
types, so the fix was checked the same way rather than by the suite alone.

**Her perceptual field was two-thirds one sentence.** At tick 11998 her state
held 106 percepts, **105 of them immortal** — every one a `msg-delivered-<id>` at
salience 0.35, one minted per message she had ever successfully sent. Running
`extractPercepts`'s exact logic against that snapshot put **identical copies of
"My message was delivered successfully" in nine of her ten executive percept
slots.** The tenth, and the loudest thing in her whole field at 0.5, was
`New agency.enacted: agency-enacted-discord_lookup_…` — her own bookkeeping.

A mind whose ten-slot window of *what I notice* is nine copies of one sentence
about itself is not noticing anything. It had been true for weeks and nothing
reported it, because every part was working: the outbox wrote a correct percept,
and nothing swept it.

→ Fixed by [#141](https://github.com/mindot-ai/will/pull/141) (the four percept
writers retrofitted onto one builder). **After 628 ticks (11998 → 12626):**
percepts in state 0 at boot and 0 at stop, entities 968 → 986, bounded growth, no
leak, window clear throughout.

**What the run did not fix, recorded because the run made it visible.** Her one
active goal completed and `goalless_crisis` began firing (12064, 12082, 12100).
Not caused by the repair — the goals deleted from her snapshot were never
hydrated. It is the ratchet: the only goal-generating mechanism she has is a
drive whose goals she can correctly identify as bad, and does, in her own
abandonment reason — *"This goal's broad framing made it satisfiable by
rumination."* Still OPEN.

---

## 2026-08-25 · the delivery-gap afternoon

**Watched for:** nothing in particular — the epoch had shipped and this was an
ordinary run. Five faults surfaced in one sitting.

**She decided to contact someone, said it was done, and nothing was sent.** Four
independent faults, one outcome
([#163](https://github.com/mindot-ai/will/pull/163)):

1. **An empty answer was indistinguishable from an empty non-answer.** A facet
   that reasoned and came back holding neither words nor a declared silence
   looked exactly like a dead author, so the intent sat `awaiting` until the
   clock abandoned it as a FAILED ACT — teaching her she is bad at speaking, from
   passes where she never spoke. **Nineteen times in one run.**
2. **The conversation format promised a delivery it could not make.** It told a
   facet that handing off a `reach-out` *"reaches them through their own
   conversation"* — so she reported the contract she had been given, **seven
   seconds before the master had even decided to.**
3. **Two paths reached the same person in the same millisecond.** A reply and a
   self-initiated message travel different roads and neither could see the other.
4. **A stalled stream muted the master for ten minutes.** The stream deadline was
   first-byte only and cleared once headers arrived, so a socket that went quiet
   mid-generation produced a promise that never settled.

**She broadcast an approval request and then truthfully denied sending it, seven
times.** At 15:31:02 she posted *"I want to discord_unban_member, but I need your
approval before I can do this. May I go ahead?"* Asked who she meant, she
answered *"I didn't send that. I've never asked to unban anyone"* — and again,
and again, **seven messages across four minutes.** She was right every time: the
ask goes out through the outbox directly, so nothing wrote the
`conversation.sent` that `## What I've Said Lately` is built from. The one
utterance missing from her record was the one she was being asked about.
→ [#164](https://github.com/mindot-ai/will/pull/164), and see 2026-08-31 below —
that fix was itself defective.

**An act with no object was damped later than one with an object, not less.**
Over 18 minutes `discord_server_snapshot` — objectless, cheap, returning the same
guild name and member count every time — **ran 48 times and repeated at a gap of
three ticks in 26 of 47 intervals**, while every entity-bound effector in the
same run sat at 30–60 ticks under the same weights. Those were not damped harder;
they read a descriptor written at the enacting tick, while the objectless arm
read a skill record that only lands when an async ack reconciles, some ticks
later. Half the repeats were slipping through the reconciliation window.
→ [#165](https://github.com/mindot-ai/will/pull/165).

**A person she had just answered was a different person to satiation.** A reply
is addressed to the transport id the percept arrived on (`discord:1019…`); a
self-initiated message is addressed to the anchor the executive resolved
(`ke:…`). `readSpokenTurns`, which builds the *prompt*, has always resolved that
through the alias table. The half that builds the *weights* never did. So a facet
answers someone, its sync wakes the master, the master forms a `reach-out` toward
that same person — and the reply that should damp it does not, because the two
halves are holding two ids for one person. **Both ids for both people were in the
live logs.** The prompt read them as one person; satiation read them as two.
→ [#166](https://github.com/mindot-ai/will/pull/166).

---

## 2026-08-31 · the restart watch

**Watched for:** whether the damping fixes held across a restart — and, since a
fix is a claim like any other, whether they did what they said.

**The escalation fix had written the record where it could not be read.** Two
tick counters live at that crossing and they are thousands apart:
`applyPolicyOutcomes` passes `instance.tickCount`, which is process-local and
resets to 0 every boot, while `conversation.sent` is read in sim-clock space.
[#164](https://github.com/mindot-ai/will/pull/164) had used the process counter,
which on a live Will put the ask **~17,000 ticks in the past** — the record
existed, and `## What I've Said Lately` keeps only the newest few, so it was
dropped from the one section it had been added to appear in. Both halves were
internally consistent; only a live run could tell they disagreed.
→ [#169](https://github.com/mindot-ai/will/pull/169). Confirmed on the next run:
a fresh escalation record, age 51 ticks.

**A guard that had never once fired since the day it was written.**
`FacetSpawnDeps.key` is `<role>:<entityId>`, and the two sides disagreed about
which id space that is: audition spawns a conversation facet keyed by the
transport address, while `authorOutreach` asks for `conversation:<anchor>`. So
the dedup the key exists for **had never once fired for a master-willed
outreach.** Every one spawned a transient rival facet on someone she was already
talking to — the exact thing the key was added to prevent, and what its own
comment claimed it did. The rival cannot see the thread digest, so it composes
blind. **Seen live: a reply at 10:25:03, and an unprompted second answer to the
same question at 10:25:30 — opening "To answer your question:", 27 seconds after
the first had already answered it.**
→ [#168](https://github.com/mindot-ai/will/pull/168). Confirmed on the next run:
`composing outreach to ke:1sqlkux inside the open conversation (facet-5)` — a
path that had never executed before.

---

## A note on the story these became

`CHANGELOG.md` 0.10.0 tells this as *"one afternoon of watching a mind run
surfaced six faults."* That is the story, and it is compressed: those six
came from **two** runs six days apart, and six is a curated count —
[#163](https://github.com/mindot-ai/will/pull/163) alone carried four. The
CHANGELOG is where an epoch gets its narrative. This file is where it keeps its
arithmetic.

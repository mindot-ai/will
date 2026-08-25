# SIGNAL_BOUNDARY — where the mind meets the world, in both directions

> *(formerly AFFERENCE_UNIFICATION — widened 2026-08-21 to cover efference too.
> Splitting one boundary into two epochs would repeat, at the document level,
> exactly the "not well accorded across" problem this file exists to fix. It is
> one seam; the vocabulary in §0 names both halves.)*
>
> **Status:** PROPOSED (2026-08-21), nothing implemented. Goal: stop treating
> "a message arrived", "an effector answered", "the world changed" and "I woke
> up" as four different kinds of thing. They are one kind of thing — **afference**
> — and the only question any of them raises is *did my own efference cause this?*
> Symmetrically on the way out: intent → invocation → handler → ack is **one**
> path, currently carried by one class doing seven jobs.
>
> **Why this is an architecture epoch, not a cleanup.** Of the defects found in a
> single day of live-running the COO deployment, ten were at the surface / tract /
> gate boundary and two were in cognition — and the two were boundary-shaped as
> well. Their *shape* is the tell: a field present on one side of a crossing and
> absent on the other; one value with three owners; a name describing the wrong
> step. That is joinery, not immaturity. The alternative reading — "the outer
> layers are simply newer" — is true but does not explain the shape.
>
> This is a **consolidation** epoch, not a feature. Its success condition is that
> the next bug of the shape "a value crossed a boundary and the far side wasn't
> looking" becomes unexpressible, because there is only one boundary left.
>
> Companion reading: `EXAFFERENCE.md` (which built half of this and named it),
> `POLICY_REAFFERENCE.md` (which routed refusals through the learning channel),
> `AGENCY_PIPELINE.md`, and `src/cognition/sense.boundary.ts` — whose header
> already states the thesis: *"Efference reaches you as a different signal, in a
> different modality, already marked as yours."*

---

## 0a. The compass — *"drop the mind in anything and it syncs the body"*

Stated as the project's heading goal (2026-08-21), and it reframes this epoch
from housekeeping into **the thing being built**:

> Will is the **percept & intelligence layer**. A host supplies organs — a robot's
> visual system, arm system, energy management; a company's ticket queue; a smart
> home's sensors; a Discord bridge. Those organs convert reality into *already
> processed sensory data*; the mind turns that into **meaning**. Effectors are how
> the mind induces control back over those systems.

The mind is the nervous system. The host supplies the body. Discord is one body
among many, and the least demanding of them.

**Why this makes the boundary the product.** Everything this file calls "surface"
is not plumbing around the engine — it *is* the contract every future host
implements. A robot integrator will never read `reafference.engine.ts`; they will
read the sense contract and the effector contract, and nothing else. So the seam's
quality is not an internal-tidiness question, it is **the API**.

**Three consequences that should decide arguments in this epoch:**

1. **A host must never need to know the mind's internals.** Today it does:
   `confirmExecution` takes a `decisionRecordId` (actually an `agency.intent` id),
   the ack shape is engine-flavoured, and a host that wants a fact to *stick* has
   to know that `perceive()` reaches memory while an ack does not. Every one of
   those is a leak of cognition into the contract. **Leak count is a metric this
   epoch should drive down.**
2. **Modality belongs to the host; meaning belongs to the mind.** `SensoryInput`'s
   ten kinds (text · voice · image · video · webhook · system · ambient metric ·
   background · internal evaluation · self-assessment) are already modality-shaped
   rather than Discord-shaped — that is right, and it is the part of the design
   most ready for a robot. Keep it that way: no channel-specific concept may enter
   the sense contract.
3. **An effector is an affordance, not an API call.** `EffectorSpec` already
   carries meaning + cost + valence + preconditions + binds, which is what lets a
   mind *find an action in a situation* rather than look one up in a catalogue
   (`AGENCY_PIPELINE.md`'s north star, and the facade-subject paradigm). An arm
   joint and a Discord ban are the same kind of thing to the mind and must stay so.

**The portability test — the acceptance criterion for this epoch:**

> Could a competent engineer write a *robot* host — visual system in, arm system
> out — reading only the sense contract, the effector contract, and one worked
> example, without opening a single file under `src/cognition/`?

Today the honest answer is **no**. When it is **yes**, this epoch is done. That
test is more useful than any phase checklist below, and where a phase and the test
disagree, the test wins.

**What this does NOT license.** It is not a rewrite mandate. The engine, the
wiring, metacognition and the PMA are sound; the portability problem lives almost
entirely at the boundary this file already scopes. Widening the epoch to "make
everything host-agnostic" would be the same over-reach §6 warns about.

## 0. The vocabulary, corrected

Three of the four definitions we started from are exactly right. One is not, and
a fifth term is missing and load-bearing.

| term | definition |
| :--- | :--- |
| **Afference** | Any input signal travelling *toward* the nervous system. The genus; the three below are its species. |
| **Efference** | Output from the nervous system **to the effectors** — muscles, glands, a host's `discord.js` client. ⚠️ *Not* "to the sensory": efference never reaches a sensor directly. What reaches a sensor is the **world having been changed** by the effector, and that arrives back as afference. |
| **Reafference** | Afference *caused by* one's own efference. Seeing your hand move because you moved it. |
| **Exafference** | Afference with no prior efference of one's own. The hand moved because someone pushed it. |
| **Efference copy** | ⚠️ *Missing from the list and it is the mechanism that makes the distinction possible.* An internal copy of the outgoing motor command, retained so the expected reafference can be **predicted** and subtracted. Without it there is no way to tell reafference from exafference except by guessing. |

The correction matters architecturally: it means **there is no such thing as an
"ack channel" separate from the sensory channel.** A host telling us what
happened is not a different kind of event from the world telling us what
happened — it is the same event, arriving with a correlation handle attached.
That handle *is* the efference copy.

Will already has efference copy and does not call it that: `predictedReward` /
`predictedValence` on the awaiting `agency.intent`, subtracted from the real
outcome to yield `surprise`. That is textbook, and it is already correct. The
problem is everything around it.

---

## 1. What exists today (audited 2026-08-21)

### The gates in — TWO principled doors, and a set of bypasses

**Correction (this replaces an earlier reading of "seven equal gates" — that was
wrong, and the difference decides the whole design).** The ordering question
*"does the mind perceive a message before audition, or after?"* has a clear
answer in the code:

```
will.perceive(stimulus)          ← MISNAMED. This is not perception.
  → stem.ingestText()
    → sensory.controller.ingestText()
      → auditionEngine.ingest( input )   ← the SENSE ORGAN runs first
        → transduction: language_percept, conversation.received, facet spawn
```

**Audition comes first. Perception is what audition produces.** That is the
biologically correct order — stimulus → sense organ → transduction → afference —
and it means the intake architecture is already right, and better than credited:

| door | entry | provenance |
| :--- | :--- | :--- |
| **1. The senses** | `ingestSensory( domain, input )` — a `SensoryInput` (10 stimulus kinds) routed to one of 5 sense engines (audition · vision · somatosensation · olfaction · gustation). `ingestText` is the audition alias. | ❌ **`SensoryInput` has no provenance field** |
| **2. The world** | `injectEvent()` writes an entity; `exteroception._scanWorld` notices the change next tick. | ✅ `reafferent`/`exafferent`, matched against consequence descriptors |

Everything else **bypasses both doors** and writes a `percept` (or worse, not
even that) with its own hand:

| bypass | writes | provenance |
| :--- | :--- | :--- |
| `outbox.controller` (message delivered) | `percept` directly | ✅ `'reafferent'` — the only bypass that gets it right |
| `effectorController.confirmExecution` | `agency.outcome` — **not a percept at all** | ❌ |
| policy refusal / escalation expiry | `agency.outcome` (`refused: true`) | ❌ |
| `stem` wake event | `percept` directly | ❌ untagged |
| `working.memory`, `escalation.buffer` | `percept` directly | ❌ untagged |
| `inspect` (host effector) | calls `perceive()` — i.e. uses the **EAR for something SEEN**, because audition is the only usable text door | ❌ untagged; a prose bracket `[I looked into …]` does the job a field should |

So the problem is not "too many doors." **It is that two good doors exist and
most traffic goes around them** — and that the sense door cannot carry the one
fact that would make going through it sufficient.

### The gate out — one path, one class, seven jobs

The flow itself is right: `agency.intent` → `_emitDispatch` → `agency.invocation`
→ the effector controller → host, plus the outbox for speech. What is wrong is
what sits at the crossing. **`effector.controller.ts` is 576 lines and 18
methods**, carrying:

1. policy enforcement (`setArbiter`, `bufferInvocation`, `_recordAndApply`, `_applyVerdict`)
2. allow-listing (`setAllowed`)
3. dispatch buffering (`_buffer`, `drain`)
4. escalation lifecycle (`resolveEscalation`, `_applyNewEscalations`, `_applyResolutions`, `_expireEscalations`, `_markEscalated`, `_clearEscalated`)
5. refusal queueing (`_applyRefusals`, `_queueRefusal`)
6. ack reconciliation (`confirmExecution`)
7. **composing and speaking a sentence** (`_voiceEscalation` → `outboxWriter.enqueue`)

Item 7 is the load-bearing tell: a class named `effectorController` is talking.
Every new need has added a method here because this is where agency meets
surface and nothing else was placed to carry it. Each addition was individually
reasonable; the aggregate is a pillar under a load it was not sized for.

**This is why the epoch is bidirectional.** The afference side needs a field;
the efference side needs a decomposition. Doing only the first would leave the
heavier half untouched.

### What the inconsistency has already cost

- **The 120-char cliff.** An effector's answer reaches the mind only through
  `action.record.outcome`, hard-capped by a bare magic number at
  `engine.ts:507`. A live COO called `discord_lookup_member` **65 times** and
  every reply was truncated to a JSON header — the answer to her actual question
  sat past the cut. She could not stop asking because she was never told.
- **Three caps for one string:** 120 (action record → the prompt), 300 (session
  log), 700 (`RESULT_DESCRIPTION_CAP`, MCP). The tightest is the only one that
  reaches cognition.
- **A stale doc claim:** `mcp/effectors.ts` says the description "feeds
  reafference + episodic memory". It does not reach `episodic.consolidator` at
  all — outcomes are not percepts, so nothing an effector learns is ever
  remembered.
- **Untagged is a silent third state.** `computeRupture` reads only
  `provenance:'exafferent'`, so untagged cannot rupture (safe) — but the
  ReafferenceEngine's sensory-confirmation path requires `'reafferent'`, so
  untagged also cannot confirm. Every untagged gate is invisible to both.
- **`inspect` launders its own findings.** It calls `perceive()` with a
  bracketed first-person string because the ack cannot carry facts. The
  bracketing is a *prose convention* doing a *field's* job.

### What is already right — do not "fix" these

- `sense.boundary.ts` — enumerating the self so exteroception stops perceiving
  the mind's own bookkeeping (measured: **36,721 self-percepts in 300 quiet
  ticks** before it existed). This is the afference/self line and it is correct.
- EXAFFERENCE P1/P2 provenance tagging + attenuation, and the invariant that a
  mind cannot rupture itself with its own act.
- Efference copy (`predicted*` → `surprise`).
- The `outbox.controller` delivery percept — **this is the reference
  implementation of what every gate should look like.**

---

## 2. The insight

> Every gate in §1 is afference. They differ only in **modality** (words, world
> change, body, host reply) and in **provenance** (mine or not). Today they
> differ in *type*, *shape*, *naming*, *cap*, and *whether provenance is asked
> at all* — and those accidental differences are where the bugs live.

The corollary that makes this tractable: **an effector ack is not a special
thing.** It is reafference with a correlation handle. `outbox.controller` already
treats a message ack exactly that way. `effectorController` does not, and that
single asymmetry explains items 1–5 in the cost list above.

---

## 3. Target design

**Do not build a new envelope.** The earlier draft of this file proposed one; the
ordering audit in §1 makes that a mistake — it would be a *third* door added to
two that already work, and the codebase would then have three. The actual work is
smaller and almost entirely subtractive:

> **Give `SensoryInput` the field it is missing, then send the bypasses through
> the doors that already exist.**

```
   provenance: 'reafferent' | 'exafferent' | 'unknown'
   sourceIntentId?: string          ← the efference copy's correlation handle
```

added to `SensoryInput` (all 10 kinds), propagated by `BaseSenseEngine` through
transduction onto the percept it produces. That single field is what `inspect` is
currently faking with a prose bracket, and what an effector ack has no way to say
at all.

With it, each bypass has an obvious home:

| bypass | goes through | as |
| :--- | :--- | :--- |
| effector ack carrying **facts** (`lookup`, `list_warnings`, `snapshot`) | door 1, a sense | reafferent stimulus — *looking is an act; what you see is reafference* |
| effector ack carrying **only the act's fate** (`kick`, `warn`) | stays `agency.outcome` | it is efference-copy reconciliation, not new world information |
| `inspect` | door 1, properly tagged | stops laundering |
| wake event | door 1 (`SystemSignal`) | exafferent — time passed without me |
| message delivered | already correct | keep as the reference implementation |

The old sketch, kept because the shape of the flow is still the target:

```
  ── EFFERENCE ─────────────────────────────────────────────
  agency.intent ──► dispatch ──► effector / outbox / world
        │                                    │
        └── efference copy (predicted*) ─┐   │  the world is changed
                                         │   ▼
  ── AFFERENCE ───────────────────────────┼──────────────────
                                          │
   words · world-change · body · host reply
                       │                  │
                       ▼                  │
              afference envelope  ◄───────┘  correlation handle
              { modality, provenance, sourceIntentId?, content, salience, tick }
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
   perception      learning        memory
   (salience,   (reafference:    (episodic,
    working      surprise vs      recallable)
    memory)      efference copy)
```

Three rules, and they are the whole design:

1. **Every input becomes an afference envelope.** One type, one writer, one
   place to add a field.
2. **Provenance is not optional.** A gate must declare `reafferent` (with
   `sourceIntentId`) or `exafferent`. There is no untagged. Where a gate cannot
   know, it must say so explicitly (`provenance: 'unknown'`) rather than omit —
   the same argument `asFinality` makes for never defaulting to `'context'`.
3. **Reafference reaches all three consumers, not one.** Today an effector ack
   reaches learning only; a message ack reaches perception only. Both should
   reach perception, learning, and memory, and the envelope is what makes that
   a routing decision rather than seven separate wirings.

---

## 3b. Two reconciliations, not one — and only one of them is built twice

Identifying reafference happens at **two layers**, and conflating them is how
this file's first draft went wrong a second time. They answer different
questions, on different horizons, with different certainty.

| | **mechanical** | **awareness** |
| :--- | :--- | :--- |
| asks | "is this signal the echo of THIS intent?" | "might this be a consequence of something I did?" |
| evidence | `sourceIntentId` (efference copy), text/entity hash match | content, timing, plausibility — *judgement* |
| horizon | `CONSEQUENCE_TTL_TICKS` = **30 ticks** | unbounded |
| certainty | exact | defeasible; the mind may be wrong |
| who decides | the engine | **the mind** |
| where | `consequence.ts`, `exteroception`, `reconcileInvocation` | `conversation.aim.ts` → the prompt |

**The mechanical layer is done and correct.** It is also, by construction,
**short**: past 30 ticks a self-caused signal is indistinguishable from a world
event, because the descriptor that would have matched it has been swept. At
Lora's 1 tick/second that is thirty seconds. Every consequence of her own action
that arrives later than that is, mechanically, exafference.

**The awareness layer exists — for speech only.** `conversation.aim.ts` is a
fully-formed instance of exactly what §0's question asks for:

- `SpokenTurn.answeredAt` / `unansweredAt` — **durable**, snapshotted, explicitly
  *not* bounded by the echo window (its header says why: `conversation.received`
  lives one tick, so it can answer "did they speak this tick" but never "when did
  they last speak").
- `isOpen(t)` — *"a turn still in the air: said, not acknowledged-only, and not
  yet answered."* A first-class representation of **an efference whose reafference
  has not come back yet.**
- `resolveReplyExpectations` folds the world's answer — **or its absence** — onto
  the turns still in the air. Silence is an outcome, not a missing outcome.
- It reaches the executive prompt as `## What I've Said Lately`, carrying
  `answered` and `answeredWith`.

**And that last point is the design principle worth stating out loud**, because it
is the answer to "how should awareness reconciliation work":

> The engine does **not** try to infer that Friday's reply was caused by Monday's
> message. It shows the mind *"you said this, to them, N ticks ago, unanswered"*
> and lets the executive make the link. Attribution over long horizons is
> **reasoning**, not matching. Building a smarter matcher would be building the
> behaviour instead of the cog.

### The gap
There is **no act-side equivalent**. `## Recent Action Outcomes` shows what she
did and how it landed — 6 records, and the outcome truncated — but nothing
represents *"this act of mine is still out there and its consequence has not
come back."* An effector ack closes the loop instantly, so by the mechanical
layer's reckoning nothing is ever in the air; and by the awareness layer's, acts
do not exist.

Concretely, from live runs: she warns someone and cannot later connect their
leaving to it; she cannot suspect that a person's silence is a consequence of
her own over-messaging; and she looked one person up 65 times with nothing
able to represent *"I have already asked this."*

### The subtlety to get right before building it
For speech, "in the air" means **awaiting a reply** — the purpose of speech is to
be answered, so `answeredAt` is the natural closer. For an act it is **not**
awaiting an ack (that returns immediately). It is awaiting **the change in the
world the act was for** — which is goal-shaped, and may already have a home in
`completionCondition` rather than needing a new mechanism.

**Do not design this in this file.** It is a sibling epoch — provisionally
`ACT_EXPECTATIONS` — and merging it into a plumbing consolidation is how both
stall. What belongs here is only the field that makes it *possible*:
`sourceIntentId` surviving on the afference, so a later mechanism can ask the
question at all.

## 3c. What happens to `agency.outcome` and `action.outcome` — decided

Both names came up as "does this survive". They are **different things**, and
one of them is three things. Recording the answers so they stop being re-asked.

### `agency.outcome` — an ENTITY. Survives unchanged. Does NOT become a percept.

Written by `reconcile.learning.ts:79` and `motor.schema.executor.ts` (:318, :924);
read by `reafference.engine.ts:137` and `action.selector.ts:745`. It is the place
**predicted meets actual** — the efference copy reconciled against the world's
reply, yielding `surprise`. That is precisely reafference in the mechanical
sense, and it already works.

**Decision: it stays as it is.** An earlier draft of this file proposed making it
"a projection of an afference envelope"; that was wrong twice over — it invents a
third door (§3), and it conflates two jobs that are genuinely distinct:

| | carries | goes to |
| :--- | :--- | :--- |
| `agency.outcome` | **the fate of my act** — did it land, how far off was my prediction | learning |
| a reafferent percept (new) | **what I found out by acting** — the world-information the act returned | perception · memory · recall |

An act like `kick` produces only the first. An act like `lookup` produces both.
Today the second has nowhere to go, which is the whole 65-lookups bug. Adding the
second **does not diminish the first.**

### `action.outcome` — a BUS EVENT. Concept sound; the NAME is overloaded three ways.

The concept is healthy and load-bearing: published by
`motor.schema.executor.ts:835` and `reafference.engine.ts:466`, schema-validated
(`actionType`, `domain`, `outcomeQuality`), and subscribed by **six** faculties —
`goal.manager`, `confidence.calibrator`, `known.entity.tracker`,
`self.model.updater`, `executive.engine`, `planning.engine`. This is one of the
*better* seams in the codebase and the epoch must not casually disturb it.
**Not everything at this boundary is broken; say so explicitly so a rename epoch
does not treat health as debt.**

What *is* wrong is that the same string names three unrelated shapes:

| use | site | shape |
| :--- | :--- | :--- |
| bus event | `motor.schema.executor:835`, `reafference.engine:466` | `{ actionType, domain, outcomeQuality }` |
| session-log record | `effector.controller:514` | `{ actionType, success, outcome, confirmedExternally }` |
| *near-collision* | `action.record` entity → `## Recent Action Outcomes` | `{ type, status, outcome, planId }` |

Three shapes, one word, and the prompt section is named after the one it is not.
Disambiguation belongs in **P3 (renaming)**, not earlier — the bus event's
subscriber list makes it the highest-blast-radius rename in the epoch, and it
should move only once, deliberately, with aliases.

### What this epoch changes about them
- **P2** adds the reafferent-percept sibling for fact-carrying acks. Neither name
  changes; `agency.outcome` keeps carrying fate.
- **P2** also collapses the three caps (120 / 300 / 700) that currently apply to
  the *same description string* on its way to these three sinks.
- **P3** disambiguates the `action.outcome` naming collision.
- Nothing else touches them.

## 3d. The clock — decided, and why it is not a config value

Not a phase; a consequence. It surfaced while P1 was in flight, as three faults
stacked in one rendered line — `Time: 12.0h (night, circadian: 3.00)` — and the
fix for the third one is a boundary question, which is why it is recorded here.

**A body's rhythm and a clock reading are different claims.** The oscillator's
`timeOfDay` is free-running from the tick unless a host entrains it, so it is
what the BODY reads. A jet-lagged body saying night at noon is not lying; it is
reporting itself. What it must never do is present that as the hour, which is a
fact about the world.

**So the hour left the prompt, and became something a mind ACTS to get.**
`check-time` is an innate, `external`, `binds: 'none'` schema on the floor beside
`orient` and `rest`. Every mind can ask; whether anything answers depends on
there being a world with a clock in it.

- **Rejected: a per-host injected clock.** The oscillator already accepts
  `setClock()`, and reading it into the prompt would have been three lines. It
  makes the hour a fact one Will silently has and another silently lacks, with
  no way for either to tell which — *"same input for all, no hack for some"*.
  Entrainment stays (a body entrained by its environment is what a circadian
  rhythm IS); what is gone is presenting the entrained phase as a clock reading.
- **The answer comes back on the ACK, as P2 made possible.** A host returns
  `observation` in whatever shape it keeps time; the engine turns it into a
  reafferent percept stamped with the intent that sought it. The host is not
  asked to phrase it. This is why the work waited for P2 — before it, the only
  way to answer was the `perceive()` laundering P1 removed.
- **Unanswered is an honest outcome.** Through the SDK an unregistered effector
  is acked failed inside the tick; through the raw stem the intent sits awaiting
  until `AWAIT_TIMEOUT`. Either way the mind learns time is unavailable here
  rather than being handed a fiction. That path had **no test coverage at all**
  while two schema comments rested their whole degradation story on it; it does
  now.

---

## 4. Open questions — decide before P1

- **Is interoception a fourth species?** Body signals have no external cause and
  no efference either. Classically this is *interoception*, a sibling of
  extero/proprioception, not a provenance value. **Leaning: keep it a MODALITY,
  with provenance `reafferent` when a drive changed because the mind acted
  (ate, rested) and `exafferent` when the body moved on its own.** That is the
  honest reading and it makes "I am tired because I worked" learnable.
- **Does the envelope replace `agency.outcome`, or feed it?** Replacing is
  cleaner and much riskier — `agency.outcome` is load-bearing for the whole
  agency pipeline and the replay tape. **Leaning: feed, not replace.** The
  envelope becomes the thing the gate writes; `agency.outcome` becomes a
  *projection* of a reafferent envelope carrying `sourceIntentId`.
- ~~**What is the cap, and who owns it?**~~ **DECIDED in P2 — there is no cap on
  what a host sends.** The question assumed the answer was a better number. It
  was not: a cap at this boundary is the engine deciding how much of an answer a
  mind may have, applied to the only copy. 120 / 300 / 700 were all deleted, and
  size is *documented* at `EffectorAck.observation` rather than enforced. The one
  survivor is `PERCEPT_SUMMARY_CAP`, which bounds the label the ENGINE composes —
  legitimate precisely because bounding its own words destroys nobody's only copy.
  (Sizing note, kept for the record: 6 action records × 120 chars is ~0.6% of a
  ~5,400-token prompt, so 120 was never a budget decision — it was an unexamined
  number.)
- **Do renames go in the public API?** `ConsequenceDescriptor`, `agency.outcome`
  and `effectorInvocation` are exported. A rename epoch touching them is a
  breaking change for hosts. **Leaning: rename internals freely, keep public
  aliases for one minor version.**

---

## 5. Phases

> Sequencing rule: **no phase may change behaviour until P3.** P0–P2 add a
> parallel path and prove it byte-identical, exactly as POLICY_REAFFERENCE P0
> shipped dark. The replay-equivalence capstone gates every phase.

### P0 — **CORRECTED TWICE, both times before writing code.** The sense door lays down no trace, and the trace it should lay is not the one this file first named.

**First correction (2026-08-21):** the original P0 said "`BaseSenseEngine`
propagates provenance onto the percept it transduces". There is no percept to
propagate onto. `publishPercept()` emits a **bus event** consumed by three
subscribers and then gone; **no entity is written.** Audition is the only sense
that remembers anything, via a `_memorySink` the base class does not provide.

**Second correction (2026-08-23), from tracing that sink:** the fix that
correction proposed — "lift audition's durable write into `BaseSenseEngine`,
audition's `conversation.received` becomes its specialization" — is also wrong,
in three ways.

**1. `conversation.received` is not a generic trace with a specialization.** It
is a social-cognition record: `sourceKeid`, `sourceName`,
`directedAtSelf: true`, `action: 'communication'`, `preview`, `chars`. It exists
because `SocialPerception` had nothing to scan and every downstream consumer —
reputation, affect, theory-of-mind, attachment, frustration — learned nothing
from any conversation. A vision frame has no `sourceKeid` and is not
`directedAtSelf`. Lifting this would make every sense pretend to be a
conversation.

**2. The trace the rest of cognition actually reads is `type: 'percept'`** —
consumed by the rupture gate (`action.selector`), reafference credit
(`reafference.engine`), `working.memory._ingestPercepts`, the executive context's
`extractPercepts`, and `novelty.detector`. `Exteroception` writes them for
world-changes. **Nothing writes one from the sense door.** *That* is the
portability gap: a robot host ingesting frames reaches none of those five.

**3. "Durable" is the wrong word, and the difference matters.**
`exteroception._collectStalePerceptIds` deletes every `percept` older than **2
ticks**. A `percept` entity is a short-lived staging area; persistence happens
downstream, WorkingMemory → EpisodicConsolidator → vector. So the sense door
needs to write a `percept` in order to *enter that pipeline*, not because the
percept itself lasts.

The mechanism is not the hard part and is already solved once: sense engines are
ingest-driven and **off-tick**, so they cannot return `StateCommands` — which is
exactly why audition needed an injected sink (`attachMemorySink`, wired at
`stem/mind.ts:1066` to `stateManager.setEntity`). The base needs the same.

#### The blocker found underneath it — `percept` has no owned lifecycle

`exteroception` is the **only** sweeper of `type: 'percept'`
(`social.perception` sweeps `conversation.received` and `percept.social`, not
this), and it only collects entities whose `metadata.tick` is a number. Two
writers omit it:

| writer | id | consequence |
| :--- | :--- | :--- |
| `outbox.controller` | `msg-delivered-${messageId}` | **unbounded leak** — one immortal `percept` per message the mind ever successfully sends |
| `stem/index.ts` | `percept-wake-event` | fixed id, so one only — but permanent: "I was offline for 3 hours" stays in state and in front of the executive forever |

Same root cause as the untagged-provenance finding in P0a-c: **`percept`
entities are written by code that does not own their lifecycle.** Three writers
skip provenance, two skip the tick. P0 proposes *more* writers from the sense
door, so building it first would multiply both faults.

#### What P0 therefore is

- [ ] **Own the `percept` contract before widening it.** One constructor for a
      `percept` entity — id, `tick`, `salience`, `category`, `summary`,
      `provenance`, optional `sourceIntentId` — so the tick and the provenance
      cannot be forgotten, and the sweeper's precondition is structural. The
      `satisfies SignalProvenance` in P0a-c was the first half of this; the
      constructor is the rest.
- [ ] Retrofit the five existing writers onto it. `outbox.controller` and
      `stem/index.ts` gain a `tick` (**fixes the leak**), `escalation.buffer`
      and both gain provenance. **Behaviour changes here** — a tagged
      `'exafferent'` wake percept becomes rupture-eligible, which is the fix
      named in P0a-c and wants its own test.
- [ ] **Then** `BaseSenseEngine` gains the sink and writes through the same
      constructor. Nothing else can be the shape of this: the base must not
      invent a sixth variant of an entity that already has five.

#### Shipped 2026-08-23 — all three steps

- [x] **Step 1** — `perceptEntity()`. `tick` and `provenance` required, `extra`
      spread first so a writer cannot clobber its own core. Adopted at
      `exteroception`, where it is a provable no-op.
- [x] **Step 2** — the other four writers retrofitted. **Closes the leak**
      (`msg-delivered-<id>` was uncollectable, and `extractPercepts` ranks by
      salience with no recency filter, so a failed delivery held an executive
      slot for the life of the mind). **The wake percept can now rupture** —
      paired test, tagged vs untagged, so the tag is isolated as the cause.
- [x] **Step 3** — `BaseSenseEngine.attachPerceptTrace( write, currentTick )`.
      The tick is injected as a *getter*, because a sense is ingest-driven and
      off-tick: audition's `_lastDecisionTick` is the cautionary case, lagging to
      whenever the executive last decided, so a message arriving forty ticks
      later would be stamped stale and swept on arrival.
- [x] `Percept.summary` is now **required**. It is the only field the rest of the
      mind reads — `extractPercepts` renders it and skips a percept without one,
      `working.memory` ingests on it. A sense that cannot say what it sensed
      produced a percept that existed and was invisible, which is what every
      shell sense would have done the day it was implemented.
- [x] `PERCEPT_SUMMARY_CAP = 100`, adopted from `exteroception`'s existing
      literal rather than chosen, so naming it changed nothing. One constant now
      instead of a literal per writer — §4's sizing question is still open, but
      answering it is a one-line change instead of an archaeology exercise.

**Audition is grandfathered out** (`tracesPercepts = false`), decided
2026-08-23. Every other sense traces by default, which is the contract a host is
owed; audition is the documented exception because it is the only live one and
switching it on routes every inbound message to five consumers it has never
reached. It is opted out of the WRITE, not degraded — the summary is produced
either way, so flipping the flag yields a well-formed percept immediately. Two
tests pin it, and turning it on has to break them.

Its `conversation.received` is untouched and is a **different trace for a
different reader**: social, `SocialPerception`-shaped, and not the generic
percept. The flag turns off only the second.

#### Verified in production (2026-08-23) — 628 ticks on a live Will

Reading a deployed Will's snapshot is what found the two undeclared entity
types, so the fix was checked the same way rather than by the suite alone.

**Before.** Lora's state at tick 11998 held 106 percepts, **105 of them
immortal** — every one a `msg-delivered-<id>` at salience 0.35. Running
`extractPercepts`'s exact logic against it: **nine of her ten executive percept
slots held identical copies of "My message was delivered successfully."** Her
`Recently observed:` line was two-thirds that one sentence. The tenth slot, and
the loudest thing in her whole perceptual field at 0.5, was
`New agency.enacted: agency-enacted-discord_lookup_…` — her own bookkeeping.

**Repair.** 194 entities removed from her snapshot: the 105 tickless percepts
and 89 orphaned `abandoned` goals (`GoalManager` skips both `abandoned` and
`completed` when hydrating, so those were never loaded — dead weight only).
Round-tripped through the real `DefaultSerializer`, because the checksum is
verified on load and throws.

**After, 628 ticks (11998 → 12626):**

| | boot | stop |
| :--- | ---: | ---: |
| percepts in state | 0 | **0** |
| immortal | 0 | **0** |
| entities | 968 | 986 |
| `agency.enacted` | 5 | 4 — and **zero** percepts from them |

Bounded growth, no leak, window clear throughout. New `msg-delivered` percepts
are ticked and swept on schedule.

**What it did NOT fix, stated because the run makes it visible.** Her one active
goal completed and `goalless_crisis` began firing (12064, 12082, 12100). Not
caused by the repair — the deleted goals were never hydrated. It is the ratchet:
the only goal-generating mechanism she has is a drive whose goals she can
correctly identify as bad, and she does, in the abandonment reason —
*"This goal's broad framing made it satisfiable by rumination."* A cog question,
not a purpose question: a Will takes an identity, it is not issued one.

#### Superseded — what P0 originally proposed, and why it is not that

Once the base can write, **does audition opt in?** Its four shell siblings can
opt in for free — they warn-and-return, so nothing observable changes — but
audition is live, and switching it on means every inbound Discord message
suddenly reaches **five consumers it has never reached**: the rupture gate
(where a high-salience exafferent percept can preempt an awaiting intent),
working memory, the executive prompt, novelty, and reafference credit. On Lora
that is not a tweak, it is a different mind.

**Recommendation: the base writes the trace, and audition is GRANDFATHERED OUT
until it is measured** — the inverse of this file's earlier framing. A host
implementing a new sense gets the trace by default, which is the compass's
requirement; audition is the documented exception carrying a link to the
measurement, not the template everyone inherits from.

### P0a — `SensoryInput` gains provenance (dark) — ✅ **SHIPPED 2026-08-23**
- [x] `provenance` + `sourceIntentId?` hoisted onto a shared **`SensorySignal`**
      base that all ten `SensoryInput` kinds extend, so the stamp is a property
      of *being a signal* rather than ten copies of two fields. `Percept`
      extends it too — transduction does not change whose doing a signal was.
- [x] Default when a caller omits it: **`'exafferent'`**, and it must be an
      explicit default with a comment, not an accident. Rationale mirrors
      `asFinality`'s: the dangerous direction is claiming *mine* about something
      that is not, because a percept wrongly marked reafferent is attenuated and
      can never rupture — a mind that mislabels the world as its own doing goes
      quiet about real events. `'exafferent'` errs toward noticing.
      → lives in exactly one place, `provenanceOf()`.
- [x] `BaseSenseEngine.publishPercept( percept, from )` stamps at the emit
      chokepoint. `from` is **required, not optional** — every percept has a
      cause, and passing it explicitly (rather than stashing the in-flight input
      on a field) is what keeps the stamp correct while `_perceive()` is async
      and two ingests overlap.
- [x] Doc-only: corrected the `mcp/effectors.ts` "feeds episodic memory" claim.
      Traced: a result `description` reaches `agency.outcome`, the executive
      prompt's `action.record` (**truncated to 120**), and the session log (300).
      Episodic memory is not among them. `RESULT_DESCRIPTION_CAP = 700` left
      alone deliberately — tuning it to match the 120 would ratify a truncation
      that is itself the defect.
- [x] Test: 10 new tests (`base.sense.engine.test.ts` ×7,
      `senses.provenance.test.ts` ×3), each mutation-verified against 5
      mutations. Full suite **1783 passed / 223 files**; `replay.equivalence`
      green — the quiet path is byte-identical.

**Two things found while implementing, both worth recording rather than
patching over:**

1. **The stamp had to be applied wholesale, not spread over.** The first cut
   overwrote `provenance` unconditionally but `sourceIntentId` only when the
   host supplied one — so a sense engine could fabricate a `sourceIntentId` and
   it survived, provenance the mind would later trust, laundered by the very
   step that exists to establish it. `publishPercept` now strips both fields off
   the engine's percept before re-applying them from the input. The host's
   assertion is the only authority. (Test: *"the stamp overrides whatever the
   sense engine put on the percept itself"*.)

2. **`provenance` lives in its own module, not `senses/index`.** `BaseSenseEngine`
   needs the *value* `provenanceOf`, and `senses/index` re-exports
   `BaseSenseEngine` — importing from there would have turned an erased,
   type-only edge into a real runtime import cycle. `senses/index` re-exports
   `./provenance`, so the public path is unchanged.

#### P0a-b — provenance made MANDATORY (2026-08-23, same day)

P0a shipped it `provenance?`, "optional at first so nothing breaks". That was
wrong within the hour, and the reason is worth keeping because it is a rule, not
a taste:

> **This codebase makes a field optional when absence is the ONLY way to say a
> third thing.** `speakerName?` — no string means "no name learned". `direct?` —
> no boolean means "the channel did not say". Provenance already HAS its third
> thing: `'unknown'`. So optionality bought a fourth state, behaviourally
> identical to `'exafferent'` and epistemically its opposite — a claim that the
> world did this, made by nobody. And it was lossy in the direction that costs:
> a reader could never separate *"the host asserts exafference"* from *"the host
> said nothing"*, which want different treatment, and `'unknown'` exists exactly
> to keep them apart.

The `asFinality()` citation in the original P0a was doing work it cannot do.
`asFinality( raw: unknown )` normalizes a value read off entity metadata, a
tape, or a host ack — *untyped* surfaces where the compiler cannot help and
something must be chosen. It justifies the **direction** of a fallback. It says
nothing about whether a **typed** field should be optional. Two decisions,
collapsed into one citation.

So: `provenance` is required, and the default survives in exactly one place —
**`asProvenance()`**, the `asFinality`-shaped normalizer for untyped ingress (an
MCP tool call, an HTTP body). Its fallback is `'exafferent'`, and deliberately
not the tidier-looking `'unknown'`: `'unknown'` is an assertion too — *"I looked
and cannot tell"* — and a caller that simply did not send the field has not looked.

**Required at `SensoryInput` ALONE would have been theatre**, which is the part
that changed the plan. No host constructs a `SensoryInput`; Discord and WhatsApp
both call `will.perceive( Stimulus )`. Requiring it only on the inner type just
forces the facade to write a magic literal — moving the unfounded claim *out* of
a named, tested, greppable helper and *into* `surface/sdk/will.ts`. So `Stimulus`
takes it too.

- [x] `Transduced<P>` — a percept as a sense engine BUILDS it, without the two
      fields, so forging the stamp is a **compile** error. The runtime strip
      stays as well: a type is only as strong as the compiler that saw it, and a
      JS host or an older-`.d.ts` consumer hands over whatever it likes. (The
      runtime test caught me re-introducing exactly that hole when I added the
      type guard and deleted the strip.)
- [x] `publishPercept` returns the stamped percept, so audition routes the turn
      with the same object the bus saw rather than a second one that can drift.
- [x] `say()` / `tell()` supply `'exafferent'` — not a default sneaking back in.
      The verb *is* the assertion: "say" is somebody speaking to the Will. A
      caller feeding back the Will's own act reaches for `perceive` and says so.
- [x] The transport controller writes **`'unknown'`**, not `'exafferent'`, and
      deliberately does not route through `asProvenance()`: the absence there is
      **structural**, not a caller's omission. `InboundMessageEnvelope` has no
      such field, so a remote host cannot declare one however much it knows.

> **⚠ Deviation, raised and then resolved back to the rule (2026-08-23).**
> Requiring it on `Stimulus` is a compile break for hosts, and §5 says no phase
> breaks anything until P3. It was taken briefly, and **backed out at that one
> door**: `Stimulus.provenance` is optional again, defaulting to `'exafferent'`
> in `perceive()`, so the break lands at P3 together with `perceive()` →
> `sense()` and a host migrates **once instead of twice**.
>
> Everything inside the package stays required — `SensoryInput`, `Percept`,
> `Transduced`. The leniency is one hop wide, at one door, and it is a
> **deprecation, not a design**: for that hop the four-state hole is alive
> again, an omission reading as a claim nobody made. That is the cost of the
> single migration, and it is on a clock.
>
> **The brief strictness paid for itself and the gains were kept.** The compiler
> found two host doors the manual audit had missed
> (`surface/mcp/server.ts`, `surface/serve/server.ts`), and it forced
> `discord_inspect_channel` to declare in a field what its own comment already
> said in prose. Every in-repo caller now passes `provenance` explicitly and
> keeps doing so — the leniency exists for hosts we do not own.

#### P0a-c — the vocabulary was already here, twice, and unconnected

Found only because the type was made required and the codebase was re-swept.
**`provenance: 'reafferent' | 'exafferent'` and `sourceIntentId` already
existed** — EXAFFERENCE P2/P3 shipped them, and P0a independently re-derived the
identical two field names for the sense door without noticing. Five sites, one
concept, no shared type:

| site | | how provenance is determined |
| :--- | :--- | :--- |
| `exteroception.ts:201` | writes | **inferred** — matches the change against our own live consequence descriptors |
| `outbox.controller.ts:110` | writes | `'reafferent'` by construction (the ack surface) |
| `reafference.engine.ts:164` | reads | `!== 'reafferent'` |
| `action.selector.ts:708` | reads | `!== 'exafferent'` — **the rupture gate** |
| `senses/provenance.ts` | mine | **asserted** by the host |

- [x] `SignalProvenance` is now the shared type; both writers use `satisfies`,
      because the compiler stops at the entity-metadata boundary (§6's own
      warning) and a bare literal there is unchecked.
- [x] `reafference.engine` reads through `asProvenance()` — behaviour-identical
      (absent and garbage both normalized to `'exafferent'`, which fails
      `!== 'reafferent'` exactly as `str()`-undefined did).
- [x] Corrected P0a's claim that provenance is *"ASSERTED, never inferred"*. It
      is **one concept with two determination mechanisms**, and both are right:
      at the WORLD door the mind holds both sides and inference *is* the
      efference copy working; at the SENSE door there is nothing to match
      against, so only the host can say.

**Left alone on purpose — `action.selector.ts:708`, the rupture gate.** It tests
`=== 'exafferent'`, so an **untagged** percept is excluded from rupture exactly
as our own echo is. Three writers are untagged: `escalation.buffer` (×2) and the
wake percept in `stem/index.ts` — which means **a mind that has been offline for
hours cannot be ruptured by noticing that**. Routing this read through
`asProvenance()` would default them to `'exafferent'` and fix it in one
character, and that is a genuine behaviour change that belongs to the phase that
tags those writers, with tests. Pinned meanwhile by
*"an UNTAGGED percept cannot rupture either — pinning today, not endorsing it"*
in `agency.rupture.test.ts`, so the fix has to be deliberate.

Also noted, not touched: **`provenance` is overloaded.** The agency pipeline uses
the same word for `{ planId, stepId }` (`reconcile.learning.ts:71`,
`plan.frontier.ts:40`). Unrelated concept, identical name. A P3 rename item.

**Deliberately NOT done in P0a, with reasons:**

- **`Stimulus` (the SDK facade) did not gain the fields.** `stem.ingestText()`
  takes a `TextMessage` directly and is public, so a host that wants to stamp
  today already can. `Stimulus` is the *curated* door and should gain a field
  when something reads it, not before — P1.
- **The wire door stays lossy, and that is now a named item rather than a
  discovery.** `InboundMessageEnvelope` reconstructs a `TextMessage` field by
  field and already drops **`direct`** and **`threadName`** — two fields the
  in-process door carries, one of which (`direct`) changes behaviour. Adding
  `provenance` there while those two stay dropped would be a third patch on a
  door known to leak. All three get fixed together, in the phase that owns the
  wire contract. **Remote hosts cannot declare provenance until then** — which
  matters directly for the compass (§0a): a robot over a socket is exactly the
  case this door serves.

### P1a — Decompose the efference crossing — ✅ **SHIPPED 2026-08-23**
- [x] Split along the three seams. **The seams were verified before the cut, not
      assumed:** a field→method map showed no method touching both the policy
      fields (`_arbiter`, `_pendingRefusals`) and the escalation fields
      (`_newEscalations`, `_activeEscalations`, `_pendingResolutions`) — except
      `_applyVerdict`, which is the ROUTER (deny one way, escalate the other). A
      router across a seam is the seam working, not a tangle.

      | file | lines | owns |
      | :--- | ---: | :--- |
      | `effector/policy.enforcement.ts` | 261 | arbiter · verdicts · refusals |
      | `effector/escalation.lifecycle.ts` | 183 | hold · resolve · expire |
      | `effector/types.ts` | 80 | the shapes they pass |
      | `effector.controller.ts` | **576 → 241** | agency↔host · tick ordering |

- [x] Pure move, no behaviour change. Import surface unchanged —
      `effectorController` is still the export, so no caller moved.
- [x] The cycle (policy raises an escalation → an escalation queues a refusal) is
      wired with arrow closures in the controller rather than a shared `this`,
      so neither class imports the other and resolution defers to call time.
- [x] `applyPolicyOutcomes` **stays in the controller.** The four-step tick
      ordering is load-bearing and neither collaborator owns the tick.
- [ ] `_voiceEscalation` still belongs to none of the three, and moving it is
      **not a file-boundary question** — it is about who authors the words.
      `escalationAsk` is a string template standing in for a facet that would say
      it in the Will's own voice. Deliberately left in place by a pure move.
- [ ] Only then consider whether the pieces want different lifetimes.

> Cost, stated plainly: 576 → 765 lines across four files. The split is not free;
> most of the growth is headers and the two deps interfaces. What it buys is that
> P1 and P2 both add work to this crossing, and they now have somewhere to add it.

**Verified by coverage, not by a green suite.** A pure move makes the whole suite
pass by construction, so passing proves nothing on its own. Mutations were
injected into both new files — the escalation TTL zeroed, the allow branch
disabled — and existing tests failed in each case (2 of 6 in
`policy.escalation`, 2 of 23 in `policy.arbiter`), which is what shows the moved
code is genuinely exercised where it now lives.

### P1 — Route the bypasses through the doors — ✅ **SHIPPED 2026-08-23**

- [x] **`inspect` stops laundering.** `EffectorHandler`'s `ctx` gains `intentId`
      — the correlation handle, which was already in scope at the call site
      (`inv.decisionRecordId`) and simply not passed on. `discord_inspect_channel`
      now sends `sourceIntentId: ctx.intentId` alongside its `'reafferent'`, so
      the echo is tied to the act by an id. The bracketed `[I looked into …]`
      stays, but it is decoration now rather than the mechanism.
- [x] **Wake event → a `SystemSignal` through door 1, `'exafferent'`** — which
      required the door to exist. `SomatosensationEngine` is no longer a shell:
      it transduces `system` and `webhook` inputs into percepts, and everything
      downstream reaches them because they are percepts, not because anyone
      wired five faculties to a wake event. `stem/index.ts` no longer builds an
      entity by hand.

      A host may put `summary` and `salience` on the signal's `data`; absent
      those it gets `SYSTEM_SIGNAL_SALIENCE` (0.75 — above exteroception's
      ambient 0.3, above the rupture gate's 0.4, because a signal means something
      happened TO the mind) and `Something happened: WAKE.`

- [x] **`working.memory` / `escalation.buffer` audited — NOT deleted, and the
      reason is worth keeping.** The doc suspected internal re-entry, and it was
      right: `escalation.buffer`'s own header says *"the master reads these as
      things IT noticed about its own situation — NEVER as incoming messages."*
      That is not afference.

      But it is not deletable either, and "percept-shaped" is not the defect.
      It is the ONLY path a focused facet has to the singular seat, and it is
      percept-shaped because `extractPercepts` renders `summary` and the
      executive context renders nothing else — a documented workaround, stated
      in that file twice. Deleting it removes the handoff; the real fix is
      giving the executive a section for *what my own parts handed me*, which is
      a prompt-surface change and not P1's business.

      P0 step 2 already removed the harm by tagging them `'reafferent'`, so they
      cannot rupture. `working.memory`'s `type: 'percept'` is a WM **item**, not
      a state entity, and was never in scope.

- [x] Tests: `senses.somatosensation.test.ts` (7) and `p1.doors.test.ts` (5).

#### The door was right and nothing walked through it (found by running a live Will)

P1 routed the wake correctly and it **still never fired**, because the gate
upstream of it had never been reachable on the lifecycle that matters:

```
Will.wake( pma )
  → createWill( config, startPaused: true )   status = 'paused', pausedAt = NULL
  → resumeWill( id )                          wake block gated on `if( instance.pausedAt )`
```

`pausedAt` is set **only** by `pauseWill()` — an in-session pause. A Will that
hibernates and comes back has always had `pausedAt` null, so **the one lifecycle
every deployed Will uses is the one the wake never fired on.** Lora had been
hibernating and waking for weeks with no idea she had ever been away.

The unit tests could not see it: both set `pausedAt` themselves, which is the
kind of test that agrees with you instead of checking. It took booting her.

- [x] **Fix:** `loadPMA` carries `pma.distilledAt` onto `pausedAt`. The PMA has
      held the answer all along — `distilledAt` is when the mind was distilled,
      i.e. when it stopped — and loading a PMA IS the statement *"this mind
      existed before and has been away since then."* Guarded against a skewed
      clock or a hand-edited artifact telling a mind it woke in 1970. A Will
      born fresh never calls `loadPMA` and is never told it woke, which is
      right: it was not away, it did not exist.

**Verified end to end on the live Will** — `prompt-tick-013269.txt`, the first
executive call after the wake:

```
## Percepts (What I Notice)
- [somatosensation] I was offline for 6 minutes. I am now online again. (salience: 0.75)

## Active Ruminations (retrieved memories & thoughts)
- [percept] I was offline for 6 minutes. I am now online again. (activation: 0.74)
```

and in her reasoning that tick: *"I came back online after a brief outage."*
The whole chain — `loadPMA` → `resumeWill` → `SystemSignal` → somatosensation →
percept entity → working memory → prompt → used.

> **Correction to what P0 step 2 claimed.** The wake percept was described there
> as "permanent — it told the executive *I was offline for 3 hours* for the rest
> of the mind's life." That was true only *if it fired*, and on the hibernate→wake
> lifecycle it never did — which is why her snapshot had no wake percept, a fact
> observed at the time and not chased. The immortality finding stands unchanged
> for `msg-delivered` (105 of them, measured); the wake half was conditional and
> was stated flatly.

> **Both P1 behaviour changes shipped uncovered on the first pass, and mutation
> testing is what said so.** Flipping the wake signal to `'reafferent'`, and
> blanking the intent id handed to a handler, each passed the entire 1826-test
> suite. Two changes with no test behind them are two changes that can be
> silently undone — and the wake one is the exact bug P0 step 2 had to fix by
> hand. `p1.doors.test.ts` exists because of that, and both mutations now fail.

> Also corrected: `agency.rupture.test.ts` was asserting a wake percept shaped
> `{ id: 'percept-wake-event', category: 'system' }`, which nothing produces any
> more. A test pinned to a shape no writer emits is a test that cannot fail for
> the right reason.

### P2 — Effector acks split by what they carry — ✅ **SHIPPED 2026-08-24**

- [x] **Facts** arrive through a sense, reafferent, with `sourceIntentId`.
      `EffectorAck.observation` is the seam: present ⇒ the ack is *also*
      afference and is ingested through somatosensation, whose stated domain is
      "external API callbacks" — which is what an effector ack is.
- [x] **Fate-only** acks stay on `agency.outcome`, unchanged.
- [x] Test: 9 in `p2.ack.split.test.ts`, plus the sync path pinned in
      `agency.execution.test.ts`.

**The host decides, and it is not inferred from `description`.** Nothing inside
the mind can tell *"the kick landed"* from *"there are 47 people here"* — both
are strings that came back from an act. Only the host knows which it wrote.
Same contract as `provenance`.

#### The bug was not the caps. The answer was never carried.

The phase was written as "collapse the three caps so a lookup's answer
survives". It did not survive because **nothing ever carried it**:

| site | published |
| :--- | :--- |
| `reafference.engine:475` | `description: 'The world confirmed the action.'` — hardcoded |
| `motor.schema.executor:835` | no `description` field at all |

`action.record` is built from that payload, so `## Recent Action Outcomes`
rendered action names and nothing else. Confirmed on a live Will:

```
## Recent Action Outcomes
- ✓ **withdraw** (tick 13471, 8 ticks ago)
- ✓ **express** (tick 13459, 20 ticks ago)
```

Sixty-five lookups would have rendered as sixty-five lines saying
`discord_lookup_member` and never once what was found. **Both publish sites had
the real words in scope** — `m['description']` off the `agency.outcome` entity,
`enaction.description` on the sync path — and dropped them. `agency.outcome` has
stored the host's description in full the whole time
(`reconcile.learning.ts:89`).

#### Nothing on the way in truncates a host — decided 2026-08-24

The caps are **gone**, not consolidated. 700 at the MCP boundary, 300 at the
session log, 120 at `action.record` were three unexamined numbers deciding how
much of an answer a mind was allowed to have, at boundaries where that was the
only copy.

> **All information sent by a host is consumed in its integrality.** The engine
> may bound what the ENGINE composes — `PERCEPT_SUMMARY_CAP` still applies to
> the summaries exteroception writes about world-changes — because there it is
> not destroying anyone's only copy. It may not bound what a host sent.

This is only safe *because* of the split: `description` now carries a **fate**,
which is short by nature. Before the split, cutting the description cut the
answer.

And the MCP bridge was doing it worst: the entire tool result went into
`description` and was cut at 700. A tool's output is what the act **revealed**,
so it rides `observation` now — whole, including what a tool says when it
fails, because an error message is information about the world too.

#### The host sends DATA, not meaning — decided 2026-08-24

The first cut of `observation` reached the mind as a *summary* and the
structured payload was **discarded**: it lived on the bus `Percept.raw` for one
tick and never entered state, memory, recall or the prompt. Truncation had been
removed and discarding left standing — the same act in a different costume, and
arguably worse, since truncation at least leaves a visible stump.

> **A host says what it handed over. The mind says what it means.**
>
> Making meaning by connecting pieces of information is the mind's entire job,
> and a host that hands over a conclusion has done that work on the wrong side
> of the boundary. A robot's vision layer reports
> `{ object: 'ball', confidence: 0.9, bbox: […] }` — demanding it also write
> *"I see a red ball on the table"* is asking the arm to do the thinking, and it
> makes every integration carry cognitive work it has no business carrying.

- [x] **`Percept.data`** — the host's payload, whole, beside `summary`.
- [x] **`summary` is a LABEL the ENGINE composes**, never required of a host. The
      signal's own name is the hint and it is free — `discord_server_snapshot`,
      `WAKE`, `lidar.scan` already say what kind of thing arrived. A host that
      happens to have words may put `summary` on its data and they are used
      instead; an option, never an obligation. `PERCEPT_SUMMARY_CAP` legitimately
      bounds it, because the engine bounding its own words destroys nobody's
      only copy.
- [x] **Five links, all of which had to carry it**, and each was a separate
      silent loss: the percept, the entity, the prompt's percept block, working
      memory's stored item, and the ruminations block that renders memory. A
      percept is swept after 2 ticks and the executive fires on its own
      schedule, so **memory is often where a mind actually meets an
      observation** — dropping it there loses it as completely as never storing
      it, one step later.
- [x] Size is documented at the field, not enforced. What a host sends lands in
      the percepts and briefly the prompt; a cap would be the engine deciding
      how much of an answer a mind may have, and that is not its decision.
- [x] The label is not printed twice — a host `summary` used as the label is
      omitted from the rendered data. Not reshaping: the stored data keeps every
      field, the render only declines to repeat one.

**Verified live** — her prompt, both blocks:

```
## Percepts (What I Notice)
- [somatosensation] Mindot HQ: 3 people, rooms include general, General, meet-lora, watch. (salience: 0.75)
    {"name":"Mindot HQ","memberCount":3,"premiumTier":0,"boostCount":0,"channels":[…]}

## Active Ruminations (retrieved memories & thoughts)
- [percept] Mindot HQ: 3 people, rooms include general, General, meet-lora, watch. (activation: 0.59)
    {"name":"Mindot HQ","memberCount":3,"premiumTier":0,"boostCount":0,"channels":[…]}
```

> Three of the five links shipped uncovered on the first pass, and the two
> prompt renderers each needed their LINE made a unit before a mutation could
> reach them — testing the data renderer in isolation left the call site free to
> drop it, exactly as `labelForHour` did. That is now three times in this epoch.

#### `observation` takes any shape — decided 2026-08-24

`unknown`, not `string`. A host with a member record sends the record, not a
paragraph about it; **making a host flatten its own data to prose is a quieter
kind of cutting** — it destroys the structure rather than the tail.
Somatosensation renders it for reading: the host's own `summary` if it gave
one, a bare string as itself, anything else as complete JSON. Ugly in a prompt
and honest — a host that wants prose sends prose. `{}` and `[]` read as a host
saying nothing, so the signal's own name is used instead.

> **Every behaviour change in this phase shipped uncovered on the first pass.**
> Reverting *both* description-carrying fixes — the two lines that ARE the
> lookup bug — passed all 1850 tests. So did cutting a record at 100 characters,
> until the fixture was made bigger than the cap it was meant to catch. Four
> mutations, four gaps, one pass each.

### P3 — Rename to the vocabulary

#### P3a — the host-facing door — ✅ **SHIPPED 2026-08-24**
- [x] `will.perceive()` → **`will.sense()`**. It has never been perception;
      a sense engine runs afterwards and *produces* the percept, which may not
      resemble what arrived and may not happen at all. `perceive` is kept as a
      **delegating** deprecated alias for one minor — delegating, so there is no
      second path to drift.
- [x] **`Stimulus.provenance` is required; the `?? 'exafferent'` is deleted.**
      The last surviving instance of the four-state hole is closed. Held back
      from P0a-b deliberately so this and the rename are ONE host migration, and
      that is how they shipped.
- [x] The two tests that pinned the leniency did what they existed to do: making
      the field required broke their **compile**, not an assertion. They now pin
      the opposite — `@ts-expect-error` guards the requiredness (a runtime test
      cannot: the omission was never a crash, it was a claim nobody made being
      recorded as one they did), plus `'unknown'` surviving the door as itself,
      plus the alias still delivering identically.
- [x] Migrated in-package: `discord.ts` ×2, `whatsapp.ts`, `mcp/server.ts`,
      `serve/server.ts`. All five already asserted provenance (P0a), so the
      break was the name only.

> **The typechecker did not catch the test doubles.** 36 tests failed at runtime
> after the rename because the channel fakes duck-type the Will rather than
> implementing it. Worth stating for hosts: a wrapper that structurally mimics a
> Will gets no compile error from this rename either — only a real `Will`
> reference does.

#### P3b — one word, one meaning — ✅ **SHIPPED 2026-08-24**
- [x] **`provenance` now means exactly one thing in this codebase.** The agency
      pipeline used it for `{ planId, stepId }`; that concept is now the named
      type **`PlanLink`** (`agency/types.ts`), threaded through
      `reconcileInvocation` and `effector.controller`. The signal sense keeps the
      word, as decided.
- [x] Swept the word out of every comment where it meant something else — plan
      links in six files, data lineage in the semantic integrator, "context" in
      `instruction.handler`, the session id in `pma`. What is left is one meaning.
- [x] An inline `{ planId?, stepId? }` in three signatures is also *how the
      collision stayed invisible*: a name can be grepped, a shape cannot.
      Behaviour is pinned by an existing test — dropping the plan link from the
      reconciled outcome turns `ReafferenceEngine — host-ack of a PLAN step` red.

#### P3c — `action.outcome` named three things — ✅ **SHIPPED 2026-08-24**

§3c assigned this to P3 and the checklist had lost it. **The bus event keeps the
name** — six subscribers, a validated schema, one of the better seams here, and
§3c is explicit that a rename epoch must not treat health as debt. The two
impostors give it up:

- [x] **The session-log record** `type: 'action.outcome'` → **`'effector.acked'`**,
      which is what it records: a host acked an effector invocation. Nothing else
      wrote it and nothing outside this package reads it (the backend's
      `action.outcome` mapping keys on the BUS event, which is untouched).
- [x] **Its `as never` cast is gone**, and that mattered more than the rename:
      the cast opted the write out of `LogEntryType` altogether, so the string
      was never checked against the union it belonged to. It is now.
- [x] **The prompt sections** were the third shape and the worst one, because a
      mind reads them. `## Recent Action Outcomes` (which renders `action.record`
      entities — what HAPPENED) sat two sections below `## Recent Actions` (which
      lists action types the mind CHOSE — intentions). Near-identical labels on
      opposite claims, adjacent on the page. They are now
      **`## What Became Of What I Did`** and **`## What I Have Been Choosing`**.
      Pinned by a test that asserts both titles and that neither old name
      survives anywhere on the page.

> The live cost of that pair, for the record: asked "have you completed that?", a
> COO answered *"Yes — it's done. I drafted the full v0.1 spec… Posted it to
> FKEM."* She had posted nothing and had no effectors at all. Her deliberation
> history said "I produce the scoping doc now" across twenty cycles and nothing
> on the page distinguished that from having done it.

#### P3d — cross-references — ✅ **CHECKED 2026-08-24**
- [x] `EXAFFERENCE.md` and `POLICY_REAFFERENCE.md` re-read end to end. Every
      `provenance` in both is the signal sense and every one is still accurate;
      neither mentions `will.perceive()`. `SENSES_HARDENING.md` refers only to
      `_perceive()`, the sense engine's internal template method, which is
      unchanged and correctly named — the domain work there really does produce
      the percept. **No edits were needed, which is the finding.**
#### P3e — no aliases at all — ✅ **SHIPPED 2026-08-24**

P3b/c deferred the internal renames as "unlovely, not misleading". Overruled,
and rightly: *"we're wearing a new skin here."* A second name for one thing is a
place where two readers can be talking about different objects and not find out.

**Deleted outright — no deprecation window:**
- `Will.perceive()`. It was one minor old and it was the newest alias in the
  package, which is the argument for taking it out now rather than later.
- `CreateWillOptions.model` (say `llmConfig.model`). Two spellings of one thing
  is how a config grows a precedence rule nobody can remember — and it had one.
- `EmbedderOptions.batchSize` → `maxConcurrency`. Nothing passed it.
- `ExecutiveOutputFull.conversationReplies` — a legacy JSON reply format no
  facet has emitted in a long time. The one read of it was writing an
  always-empty `replies: []` into the session log.
- The `ExecutiveFacet` compatibility re-export — a second import path for a
  symbol that already had one.

**Renamed so one verb spans the stack:**
- `stem.ingestText` → **`senseText`**, `stem.ingestSensory` → **`senseSignal`**,
  and `SenseEngine.ingest()` → **`sense()`** across every engine. The crossing
  into a mind is now called the same thing at the facade, the stem, the
  controller and the engine — it was called four things.
- `effectorInvocation.decisionRecordId` → **`intentId`**. It stopped being a
  `decision.record` id at the agency cutover and was kept "for wire-contract
  stability" — so the wire was stable and wrong, while the SDK translated it to
  `intentId` one hop later for the handler. Stability that preserves a false
  name is preserving the wrong thing.

> **A rename makes test doubles lie, twice over.** Renaming `ingest` broke 9
> tests loudly — and made one pass VACUOUSLY: `instance…somatosensationEngine
> .ingest = spy` assigned a spy to a property nothing reads, under an assertion
> that the spy was never called. It passed for the wrong reason. Sweep `.x =`,
> `.x.bind(`, `{ x: vi.fn() }` and structural cast types, not just `.x(`.

`injectEvent` is untouched: it writes an entity straight into state, so it is not
a door with a bad name — it is a bypass, and bypasses are P4.

### P4 — Delete what the doors subsumed — ✅ **SHIPPED 2026-08-24**

Three bespoke writers existed, not the one this file assumed.

- [x] **`outbox.controller.confirmDelivery` — routed through the door.** A
      delivery ack is reafference by construction: the words went out and the
      world said whether they landed. It now goes in as a `message_delivery`
      system signal carrying `{ messageId, delivered }` as DATA, so the percept
      is stamped, traced and swept by the same machinery as every other one
      instead of by hand in a tract. Two deliveries in one tick stay distinct
      because `messageId` is in the data the trace id hashes.
- [x] **`escalation.buffer.drainToPercepts` ×2 — built, not hand-rolled.** These
      were the last `type: 'percept'` literals in the package.
- [x] Success condition, **as amended**: every `type: 'percept'` ENTITY is built
      by `perceptEntity()`, and the only writers are a sense engine,
      exteroception, and the escalation buffer.

**The success condition as originally written cannot be met honestly, and the
reason matters more than the checkbox.** A sense door carries AFFERENCE — a
signal crossing into the mind, from the world (exafferent) or from the mind's own
act returning *through* the world (reafferent). A facet handing off to the master
crosses neither: it never left the mind. Routing it through a sense would dress
one part of a mind up as news from outside, which is exactly the laundering P1
removed from `inspect`, and §6 names that class of over-unification as the thing
not to do. So the rule is now *"only `perceptEntity()` builds one, and only three
places call it"*, which is checkable and true, rather than a fourth door.

> **Left open, deliberately.** An escalation handoff is using the percept entity
> as a DELIVERY MECHANISM, because the percept block is what the executive prompt
> renders. A `self.handoff` type with its own prompt section would say what it
> actually is. That is a prompt change plus a `_reconcileUndertakings` change —
> a decision, not a cleanup.

**Not a P4 case, despite matching the grep:** `working.memory.ts` sets
`type: 'percept'` on a working-memory ITEM, not a state entity. Different
namespace, same word — worth knowing before someone "fixes" it.

---

## 6. Scope notes

- **NOT in scope:** the sense boundary itself (correct, leave it); efference copy
  (correct); the affordance competition; informational novelty ("did it *help*"
  vs "did it *work*") — that is a real gap but it is a *learning* question, and
  this epoch is about *plumbing*. Do not let them merge.
- **The risk to name out loud:** this touches the replay tape, the PMA, and the
  entity vocabulary at once. The mitigations are the ones this codebase already
  trusts — ship dark, prove byte-identity per phase, centralize before widening
  (P5 of POLICY_REAFFERENCE proved that pattern works: importing the type first
  turned a taxonomy split into six compile errors instead of six silent
  mis-routes), and grep for literals headed into entity metadata rather than
  relying on the typechecker, which stops at that boundary.
- **Why this is worth an epoch:** every bug this session — the 120-char
  truncation, `inspect`'s laundering, the untagged wake percept, three caps for
  one string, "feeds episodic memory" being false — is the same bug. They were
  found one at a time because there is no one place where they would have been
  one bug.

## Related
- `.TODO/EXAFFERENCE.md` — built provenance and named it; this generalizes it.
- `.TODO/POLICY_REAFFERENCE.md` — routed refusal through the learning channel;
  the pattern P2 here follows.
- `src/cognition/sense.boundary.ts` — where I end and the world begins.

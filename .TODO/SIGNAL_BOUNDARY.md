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
- **What is the cap, and who owns it?** One named constant with a rationale,
  replacing 120/300/700. Sizing note: 6 action records × 120 chars is ~0.6% of a
  ~5,400-token prompt, so 120 was never a budget decision — it was an unexamined
  number.
- **Do renames go in the public API?** `ConsequenceDescriptor`, `agency.outcome`
  and `effectorInvocation` are exported. A rename epoch touching them is a
  breaking change for hosts. **Leaning: rename internals freely, keep public
  aliases for one minor version.**

---

## 5. Phases

> Sequencing rule: **no phase may change behaviour until P3.** P0–P2 add a
> parallel path and prove it byte-identical, exactly as POLICY_REAFFERENCE P0
> shipped dark. The replay-equivalence capstone gates every phase.

### P0 — **CORRECTED 2026-08-21, before implementation.** The sense door produces nothing durable.

Traced before writing code, and the original P0 ("`BaseSenseEngine` propagates
provenance onto the percept it transduces") was **wrong: there is no percept to
propagate onto.**

`BaseSenseEngine.publishPercept()` publishes a **bus event** —
`senses.<domain>.percept`, payload `{ domain, sourceEntityId, timestamp,
salience, raw }` — consumed by exactly three subscribers (`attention.allocator`,
`known.entity.tracker`, `action.selector`) and then gone. **No entity is
written.** Measured across the sense engines:

| engine | durable entity write |
| :--- | :--- |
| audition | ✅ — `conversation.received`, via its own `_memorySink` |
| vision · olfaction · gustation · somatosensation | **0 sites each** |

So the generic sense contract is *transient by construction*, and audition is the
only sense that remembers anything — because it hand-rolled a durable write the
base class does not provide.

**This is the portability gap, and it is bigger than provenance.** Under the
compass (§0a), a robot host ingesting frames through `ingestSensory('vision', …)`
would emit a bus event three faculties glance at for one tick, and the mind could
never remember having *seen* anything. Provenance on a signal that vanishes tags
nothing. **A sense that cannot lay down a trace is not a sense; it is an
interrupt.**

Which makes P0 the same move as the rest of the epoch — *generalize what one
place already got right*:

- [ ] **Lift audition's durable write into `BaseSenseEngine`.** Every sense lays
      down a trace; audition's `conversation.received` becomes its *specialization*
      of the general behaviour rather than a private exception.
- [ ] Provenance rides on that trace, where it now has something to ride.
- [ ] **Decision required before coding this** — it changes behaviour for a shipped
      sense (audition), so it is not a dark change. Options: (a) lift and have
      audition delegate; (b) add the base write and leave audition's in place until
      P4 removes the duplicate; (c) base write behind a flag, senses opt in.
      **Leaning (b)** — additive, keeps the quiet path byte-identical, and defers
      the deletion to the phase that exists for deletions.

The genuinely dark part of P0, unaffected by the above and safe to land first:

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

### P1a — Decompose the efference crossing
- [ ] Split `effector.controller.ts`'s seven jobs along their real seams. A first
      cut: **policy enforcement** (arbiter, verdicts, refusals) · **escalation
      lifecycle** (hold, resolve, expire) · **agency↔host translation** (buffer,
      drain, ack). `_voiceEscalation` belongs to none of the three — speech is the
      outbox's job and the escalation should *ask* for an utterance, not compose
      one.
- [ ] Pure move first, no behaviour change, gated by `replay.equivalence` — the
      same discipline that made the planning.engine split safe (will #6:
      "mechanical/verbatim; import surface unchanged").
- [ ] Only then consider whether the pieces want different lifetimes.

### P1 — Route the bypasses through the doors
- [ ] `inspect` stops laundering — same finding, now `provenance: 'reafferent'`
      + `sourceIntentId`, and the prose bracket becomes decoration rather than
      the mechanism.
- [ ] Wake event → a `SystemSignal` through door 1, `'exafferent'`.
- [ ] `working.memory` / `escalation.buffer` — audit whether these are afference
      at all, or internal re-entry that should never have been percept-shaped.
      **Suspect the latter; deleting is a valid outcome.**
- [ ] Test each: what reaches cognition is unchanged in content, changed only in
      that provenance is now stated.

### P2 — Effector acks split by what they carry
- [ ] **Facts** (`lookup`, `list_warnings`, `snapshot`) arrive through a sense,
      reafferent, with `sourceIntentId` — so they are perceived, remembered, and
      recallable, not just learned-from.
- [ ] **Fate-only** acks (`kick`, `warn`, a refusal) stay on `agency.outcome`.
      This split is the load-bearing decision of the phase: an ack is not
      *always* new world information, and forcing both through one path would be
      the same over-unification this file warns about.
- [ ] Replace the three caps (120 / 300 / 700) with one named constant.
- [ ] Test: a lookup's answer survives to the prompt intact — the 65-times bug
      is expressible as a regression test.

### P3 — Rename to the vocabulary
- [ ] `will.perceive()` → **`will.sense()`** (or `receive`). It has never been
      perception; audition runs first and *produces* the percept. The name has
      misled every reader of this flow, including this file's first draft.
      Keep `perceive` as a deprecated alias for one minor.
- [ ] Internal renames toward the four terms; public aliases retained one minor.
- [ ] Update `EXAFFERENCE.md` / `POLICY_REAFFERENCE.md` cross-references.

### P4 — Delete what the doors subsumed
- [ ] Remove bespoke `percept` writers that now go through a sense.
- [ ] Success condition: **every `type: 'percept'` write is inside a sense
      engine or exteroception** — no faculty, tract, or host writes one directly.

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

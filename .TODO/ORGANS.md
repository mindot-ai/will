# ORGANS — the body a Will needs, and the contract every organ signs

> **Standing:** DESIGNED · 2026-11-02 · §2 and §3 are read from `main` — the declaration's seven fields, `externalSchemas`, the floor/candidate split and salience formula in `affordance.synthesizer`, `scoreAffordance`/`driveUrgency`/`goalRelevance` and the weight table, `enactionFootprint` and the satiation arms in `consequence.ts`, `repeatWindowTicks` and its persona gains, `BaseSenseEngine`, and the PEP site. §4 onward is a plan of record with no code. Three stale-record defects found while tracing it are listed in §2 and are NOT fixed here

> A Will is the percept-and-intelligence layer; the host supplies the organs
> (memory `mind-syncs-any-body`). That division is load-bearing and it is also
> where the project is thinnest: one sense is alive, three are six-line shells,
> and every organ past conversation is "the host's problem" with no statement of
> what a host would have to supply. This document is that statement — what an
> organ **is**, what each organ a Will needs would sense and do, and in what
> order to build them. It is deliberately a contract and a catalogue, not a tool
> list. A tool list is the thing this architecture exists to not be.

---

## 1. The principle

Capability in this engine is *a relation between a body-in-a-state and a
world-as-perceived* — not a row in a table. Three consequences, and every rule
below descends from one of them:

- **An organ is a pair, never a half.** It senses and it acts. An effector with
  no corresponding sense is a hand with no proprioception: the mind acts, and
  learns what happened only from a `description` string in an ack. That is the
  shape of the delivery-gap fault class in [[FIELD_NOTES]].
- **An organ must put its objects into the world.** The mind binds actions to
  *perceived targets*. An organ that names nothing leaves its effectors
  objectless, and objectless is the pathological case (§3, rule 2).
- **An organ is host-supplied and therefore portable.** [[SIGNAL_BOUNDARY]]'s
  acceptance criterion is the portability test: if an organ can only be supplied
  by one host, it is not an organ, it is a feature of that host.

---

## 2. What the seam already is (read from `main`, 2026-11-02)

A host author needs this before anything else, and it is not currently written
down in one place.

### The afferent half

`BaseSenseEngine` (`src/cognition/senses/base.sense.engine.ts`) is the shared
pipeline. A concrete sense declares *what* it senses — `domain`, `acceptedKinds`,
an optional `gateEffector` — and implements `_perceive()`. The template method is
`ingest`: **effector gate → kind filter → `_perceive()` → `publishPercept()`**,
and `publishPercept()` is the single chokepoint onto the bus
(`senses.<domain>.percept`). The file's own header names that chokepoint as where
a future cross-modal binder would observe percepts sharing a `sourceEntityId`
across domains.

Five domains exist. Their real state:

| Domain | State on `main` |
| :--- | :--- |
| **Audition** | **Live.** A full engine directory — per-entity conversation facets, salience scoring, word-level streaming, its own `executive.facet.handoff` schema and session snapshot. |
| **Somatosensation** | **Live, narrow.** 137 lines, four `Transduced` sites: system signals and webhooks, with `SYSTEM_SIGNAL_SALIENCE = 0.75` and a label the engine composes while the host's payload passes whole. |
| **Vision** | **Shell.** 23 lines via `ShellSenseEngine`, zero percepts produced. |
| **Olfaction / Gustation** | **Shells.** 24 lines each, zero percepts. |

> **Record defect found here (not fixed in this change).** `README.md` says
> cross-modal binding "lands when a second sense produces percepts". A second
> sense now does — somatosensation. The trigger the repository set for itself has
> fired and the binder is unbuilt, with its chokepoint already in place.

### The efferent half

A host declares an ability as an `EffectorDeclaration`
(`src/cognition/agency/types.ts`). A bare string is the name-only form. The
object form is the one that matters, and it has **seven** fields:

| Field | Meaning |
| :--- | :--- |
| `name` | The ability's id. Comms names and names shadowing an innate stance are filtered out. |
| `description` | What the ability is *for*. Carried to perception **and** to the host — this is meaning, not a docstring. |
| `cost` | Intrinsic effort/energy demand, 0..1. Default `0.15`. |
| `valence` | Intrinsic affective prior, −1..1, before any learning. Default `0`. |
| `preconditions` | Body-state gates (`{ metric, op, value }`) evaluated against live metrics; the affordance is unavailable unless all pass. |
| `binds` | `'none'` (default) · `'entity'` (each sentient known-entity) · `'object'` (each non-sentient one). The bound target reaches the host as `ctx.targetEntityId`. **`SchemaBinding` has a fourth kind, `'percept'`, which is internal — the synthesizer binds a single percept schema and a host cannot declare one.** |
| `tags` | Routing tags, merged with the mandatory `'external'`/`'host'`. A tag the drive system recognises lets a homeostatic drive lift the ability — but only three tag families are recognised, and the documented example is not one of them (§3 Rule 5). |

`externalSchemas()` (`agency/schemas/external.ts`) turns each declaration into an
enactable `MotorSchema` tagged `external`; the synthesizer surfaces it, the
selector competes it, the `MotorSchemaExecutor` routes it to the host.

> **Record defect found here (not fixed in this change).** `binds: 'entity' |
> 'object'` **is implemented** — `external.ts:57,67`. But that file's own header
> still reads *"Scope (Phase 1): objectless schemas … Entity-bound external
> effectors … are a follow-up"* and points at `CUSTOM_EFFECTOR_WIRING_TODO.md`,
> a filename that does not exist (the document is
> [[CUSTOM_ABILITY_WIRING]]). That document's Standing line also still lists
> entity binding as open. A host author reading either would not know the single
> most important field exists. This is the `EXAFFERENCE`-sat-OPEN failure from
> [[STANDING]], relocated into a source comment.

> **Third record defect (not fixed in this change).** `types.ts:94` tells a host
> that *"a tag the drive system recognises (e.g. `'social'`, `'nourishment'`)"*
> will let a drive lift the ability. `driveUrgency()`
> (`agency/selection.scoring.ts:165`) recognises `'regulatory' | 'self-care' |
> 'rest'`, `'social'`, and `'self-protection'`. **`'nourishment'` returns 0.**
> This is the worst of the three, because it is in the field a host author is
> most likely to copy, and the failure is silent: the ability competes with
> `drive = 0` and nothing says so.

### The loop that closes

- The Will's chosen acts land in two host-drained queues: `outbox`
  (`OutboxMessage[]`, with `deliveryStatus`) and `pendingEffectorInvocations`
  (`EffectorInvocation[]`, each carrying a correlation handle).
- The host closes it: `confirmEffectorExecution(willId, invocationId, { success,
  description, metrics })` writes an `action.outcome` that the
  `ReafferenceEngine` reconciles into prediction error, value, param and habit
  updates.
- Two delivery modes: **outbox polling** (default) and **external transport**
  (`LoopbackTransport`, `StreamTransport`, `SocketIoTransport`).
- Before any of that, the **PEP** at `effectorController.bufferInvocation`
  consults the arbiter — `allow | deny | escalate`, with denial finality
  `class | parameter | context` ([[POLICY_REAFFERENCE]]). What the arbiter does
  *not* govern is reach: see [[CONTAINMENT_BOUNDARY]].

World profiles sit above all of it, seeding a list of effector **names** plus a
`context` string, without touching the persona layer. Note what a profile cannot
express today: it names abilities but says nothing about the senses that would
make them legible, and nothing about the objects they bind to. That gap is most
of this document.

---

## 3. What an organ is — the contract

Nine rules. Each one is a thing that, skipped, produced a measured failure
already on record in this repository — the citations are to the code that
diagnosed it, not to this document's reasoning.

For reference, the competition every ability is scored in
(`DEFAULT_WEIGHTS`, `agency/selection.scoring.ts`):

```
+ goal 0.30 · reward 0.25 · drive 0.25 · habit 0.20 · novelty 0.10
+ plan 0.30 · will 0.30 · social 0.30 · settled 0.30
− cost 0.20 · inhibition 0.30 · risk 0.20 · repeat 0.30
```

**Rule 1 — both halves, declared together.** An organ supplies at least one
sense contribution and at least one effector declaration, specified as one unit.
A host may not ship an effector whose outcome is observable only through its own
ack. The one documented case of an organ shipped without its afferent half is
Discord moderation (memory `will-discord-sense-boundary`): the abilities
presupposed a world — a member list — that she did not have.

**Rule 2 — name your objects, *and* give them salience.** Three facts from the
synthesizer, and the third is the one that bites:

- `binds: 'none'` lands an ability in the **innate floor — "always emitted,
  never attention-capped"** (`affordance.synthesizer.ts:193`). Bound schemas
  instead enter as candidates *at the target's salience* and compete through the
  attention cap (`:227–258`).
- `goalRelevance()` is **structural, not lexical**: it returns `maxGoalPriority`
  only when the affordance's `targetEntityId` is in `goalTargets`. An objectless
  act has no target, so **`goal` — tied for the largest weight at 0.30 — is
  structurally zero for it, permanently.** An objectless organ cannot be
  recruited by a goal, however relevant it is.
- An object's own salience is
  `familiarity × 0.6 + max(0, valence) × 0.3 + resolutionConfidence × 0.1 +
  goalTargets`. A **freshly named** object — a tab opened one tick ago — scores
  ≈ 0 on the first three terms. So naming objects is necessary and *not
  sufficient*: a new object is near-invisible until a goal points at it or
  familiarity accrues. An organ that mints objects must also make them
  goal-linked, or its whole world loses the cap to ambient rumination.

**Rule 3 — your satiation must not wait for your ack.** This is the rule that
cost the most to learn, and it is not about binding at all. For an objectless
act the damping source `selfEnactedAt` is a **skill record, written when the
outcome is reconciled** — for a host effector, an async ack landing some ticks
after the act. In the window between dispatch and reconciliation, satiation read
the *previous* enaction and damped almost nothing. Measured, in
`agency/consequence.ts:296+`:

> `discord_server_snapshot` — objectless, cheap, always succeeds — repeated at a
> gap of **three ticks in 26 of 47 intervals**, while every entity-bound effector
> in the same run sat at 30–60 under the same weights. Those were not damped
> harder, they were damped **sooner**, because a descriptor exists from the
> enacting tick and a skill record does not.

The engine side is fixed — `enactionFootprint` now reads both arms, the
dispatch-time consequence descriptors *and* the durable records. What an organ
must not do is be the thing whose only trace is a late ack. **The slower an
organ's ack, the more dangerous it is**, independently of what it binds to. A
browser organ whose acks take seconds is the worst case in §4.

The mirror failure is on record too, from over-damping: a live COO willed
`reach-out` 63 times in four minutes, delivered nothing, and 18 of those lost to
`justEnacted` readings of 0.93–0.98 — because each *attempt* wrote a fresh
footprint, so the damping never decayed. Hence `ConsequenceDescriptor.pending`.
An organ for which dispatch *is* the act and one for which it is not are
different, and the declaration has no way to say which.

**Rule 4 — there is one satiation window, and it drifts.**
`repeatWindowTicks` defaults to **60** and is a single per-Will value
(`config.mirror.entities.ts:390`), tuned by the persona prior — agreeableness
`+24` per unit, persistence `−20` (`persona.consolidator.ts:163`). An organ
**cannot declare its own**. So a fast organ and a slow one are damped on the
same clock, and that clock moves as the mind's personality develops. Recorded
here as a constraint, and as open question 3.

**Rule 5 — tag for a drive that actually exists.** `BiasContext.drives` is
exactly `{ energy, sleep, stress, social }` — **four**. `driveUrgency()` routes:

| Tag | Drive it reaches |
| :--- | :--- |
| `'regulatory'` · `'self-care'` · `'rest'` | `max(energy, sleep)` |
| `'social'` | `social` |
| `'self-protection'` | `max(stress, threat)` |
| anything else | **0** |

**There is no epistemic or curiosity drive.** Which means every organ in §4 whose
purpose is *knowing* — the page, the archive, the machine — routes to nothing and
competes with `drive = 0` against a weight of 0.25. Its only non-goal pull is
`novelty = 1 − habitStrength` at weight 0.10, which is not tag-gated and is spent
by use. Two honest options, and the choice is cognition's, not the body's:
accept that epistemic organs are goal-driven only, or add a fifth drive — which
is an engine change and belongs in its own document, not here.

**Rule 6 — declare meaning and priors, not a parameter schema.**
`description`, `cost`, `valence`, `preconditions`, `tags`. Arguments bind from
the situation. An organ that arrives as a JSON parameter form has been built as
a tool, and the competition has nothing to weigh. Note also that
`preconditions` read **live metrics** by key (`{ metric, op, value }`,
`affordance.synthesizer.ts:487`), and the only key pattern in the innate
schemas is `energy.level` — an organ cannot gate on a metric that no faculty
publishes.

**Rule 7 — never hand the mind a credential.** The mind holds no secret. The
organ's handler may; its declaration and its percepts may not. This is the one
rule the current architecture already satisfies and must not lose.

**Rule 8 — the payload passes whole.** [[SIGNAL_BOUNDARY]] P2: the engine may
bound the summary **it** composes; a host's payload is the mind's only copy and
is never clipped. An organ that truncates on the way in destroys evidence that
exists nowhere else.

**Rule 9 — deterministically mockable, or replay dies.** Every organ ships a
replay path: a deterministic double, or recorded reafference the tape can
replay. "Determinism is sacred" is the one hard contributing rule, and a body is
where it stops being free (see [[EMBODIMENT_PROJECTION]]).

---

## 4. The catalogue

Template for each: **senses** · **acts** · **objects it names** · **hazard**.
Declarations are illustrative, in the object form of §2.

### 4.1 Voice — audition · *exists*

- **Senses:** speech and text per entity, salience-scored, facet-isolated.
- **Acts:** the communication surface, governed by `AccessGrants` and the
  `ProactiveCommunicator` — not by `externalSchemas`.
- **Objects:** people, as known-entities. Already the best-developed organ.
- **Hazard:** none new. It is the reference implementation every other organ
  should be read against.

### 4.2 Interoception of the host — somatosensation · *exists, narrow*

- **Senses:** system signals and webhooks today. Should widen to the host's own
  condition: queue depth, rate-limit state, an organ going offline, a quota
  nearing exhaustion.
- **Acts:** none of its own, by nature.
- **Objects:** the host's subsystems, as entities, so "the mail organ is down"
  is a perceivable fact rather than a failed invocation.
- **Hazard:** `SYSTEM_SIGNAL_SALIENCE = 0.75` sits above exteroception's 0.3 and
  above the rupture gate of 0.4. Widening this organ widens what can rupture;
  the salience of routine host chatter must be set deliberately, not inherited.

### 4.3 Sight — vision · *shell, and the hardest design question here*

- **Senses:** the open question. **A screenshot is not a percept.** A bitmap
  carries no `sourceEntityId`, no salience, nothing to bind cross-modally and
  nothing for the generative model to predict. Three candidate answers, and the
  choice should be made explicitly rather than by whichever lands first:
  1. **Structural** — an accessibility tree, as Muse's browser subagent uses.
     Entities fall out naturally; this is the only option that satisfies Rule 2
     for free.
  2. **Described** — a vision model's caption becomes the percept. Cheap to
     build, hostile to determinism, and smuggles an inference into the sense
     layer where the architecture says there is none.
  3. **Attended** — regions of interest as entities with their own salience.
     Most faithful to the architecture, most expensive, nothing to copy.
- **Acts:** none. Vision is afferent; acting on what is seen belongs to §4.4.
- **Hazard:** building this as (2) is the easy path and would put an LLM call
  inside a sense engine, breaking the claim that external input reaches the mind
  through transduction rather than prompt injection.

### 4.4 The page — web · *unbuilt*

- **Senses:** a page as a structural percept (per §4.3 option 1); its change
  events; what the page asserts. Not raw DOM.
- **Acts:**
  ```typescript
  // No drive tag: there is no epistemic drive (Rule 5), so these compete on
  // goal relevance, reward and novelty. Tagging them 'epistemic' would read as
  // drive-routed and silently contribute 0.
  { name: 'read_page',   description: 'Read what a page I have open says.',
    cost: 0.10, valence: 0.10, binds: 'object' }
  { name: 'act_on_page', description: 'Press, type into, or choose something on a page.',
    cost: 0.25, binds: 'object',
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 15 } ] }
  ```
- **Objects:** **a tab is an entity**, and so is a *link* — see the hazard.
  A page the Will has open is a thing in its world with a lifetime, not a string
  parameter.
- **Hazard 1 — the tool-shaped shortcut.** One `browse(url, instruction)`
  effector, objectless, is a tool call wearing an organ's clothes: permanently
  in the field, never attention-capped, and goal-blind forever (Rule 2).
- **Hazard 2 — "open something new" is structurally objectless, in every
  organ.** You cannot bind to a page you have not opened. The honest resolution
  is that the *destination* must already be an entity before it can be acted on:
  a link perceived on a page, a bookmark, a URL someone mentioned. So the
  afferent half has to mint **candidate destinations** as objects, and
  `open_page` binds to those. An organ that cannot name its candidates is
  condemned to one objectless opener — which is the ability that will hammer.
- **Hazard 3 — ack latency.** A page action acks in seconds, i.e. many ticks.
  By Rule 3 that makes this the most repetition-prone organ in the catalogue,
  and the one that most needs its dispatch-time footprint to be right.

### 4.5 The machine — files and execution · *unbuilt*

- **Senses:** a directory as a place; a file's existence, size and change; the
  result of a run as an outcome percept rather than a return value.
- **Acts:** `read_file`, `write_file` (`binds: 'object'`, high `cost`,
  negative-leaning `valence` for destructive variants), `run` — which should
  almost certainly **not** exist as a general ability in v1. No drive tag
  applies (Rule 5).
- **Objects:** files and directories as entities.
- **Hazard:** this is the organ that makes [[CONTAINMENT_BOUNDARY]] binding
  rather than theoretical. It should not ship before the seam there does.

### 4.6 The purse — money · *unbuilt*

- **Senses:** balance, commitment, what a thing costs, what was spent — and
  **the outcome of a spend as reafference**, because the drive system must be
  able to learn that spending discharged nothing.
- **Acts:** one, narrow, and **never `binds: 'none'`**:
  ```typescript
  { name: 'pay_for', description: 'Pay for a specific thing I have decided on.',
    cost: 0.60, valence: -0.10, binds: 'object',
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 25 } ] }
  ```
  The gate one actually *wants* here is calibrated confidence, and it cannot be
  written: `confidence.calibrated` is an event, not a published metric, so
  there is no key for `preconditions` to read (Rule 6). Worth fixing before P6.
- **Objects:** the specific line item being paid for.
- **Hazard:** the highest-amplitude organ in the catalogue. It is the one where
  `escalate` should be the *default* verdict rather than an exception, and where
  Rule 2 is not a design preference but a safety property: an objectless
  `pay_for` in a repetition loop is the incident from
  [[EMBODIMENT_PROJECTION]] §"what gets worse", with a number attached.

### 4.7 The clock — elapsed time · *unbuilt, and already specified*

- **Senses:** [[ELAPSED_ABSENCE]] is this organ's afferent half and is already
  designed: the gap recorded once at the restore boundary as state, surfaced as
  a percept the mind can reason about. Add to it: a calendar as perceivable
  commitments, and deadlines as entities that age.
- **Acts:** `schedule`, `remind` — and nothing that makes the mind a cron.
- **Objects:** appointments and deadlines as entities.
- **Hazard:** tick-denominated intervals (`CONSEQUENCE_TTL_TICKS`,
  `AWAIT_TIMEOUT`, facet idle TTL, the executive interval) measure *compute*,
  not time. An organ that makes real time perceivable without reconciling that
  gives the mind two inconsistent clocks.

### 4.8 The directory — people · *partly exists*

- **Senses:** who exists, who spoke, who is reachable. [[KNOWN_ENTITY]] is the
  machinery; memory `will-discord-sense-boundary` is the live lesson — her world
  contains only people who spoke to her, which is why moderation effectors
  presupposed a world she did not have.
- **Acts:** reach out, introduce, hand off — `binds: 'entity'`, `tags:
  ['social']`. This is the **only** organ in the catalogue whose natural tag is
  one `driveUrgency()` actually recognises, which is itself the argument of
  Rule 5.
- **Objects:** people, with attachment bond and reputation.
- **Hazard:** the one documented case of an organ shipped **without** its
  afferent half. Any new organ should be checked against it: *what world does
  this ability presuppose, and does she have it?*

### 4.9 The archive — documents and knowledge · *partly exists*

- **Senses:** [[LOSSLESS]] P5 is this organ's afferent half in progress — what
  she read, recallable by meaning, a page at a time; a handed-over file as its
  own item, whole.
- **Acts:** `search_knowledge`, `draft`, `file` — `binds: 'object'`, no drive
  tag (Rule 5).
- **Objects:** documents and passages as entities.
- **Hazard:** Rule 6. This is where clipping on the way in is most tempting and
  most destructive.

### 4.10 The messenger — channels · *exists, unevenly*

- **Senses:** the live surfaces (Discord, WhatsApp) already transduce through
  audition. Email and the rest do not exist.
- **Acts:** the comms surface plus per-channel abilities.
- **Objects:** threads and channels as entities — currently they mostly are not,
  which is part of why delivery-gap faults were invisible.
- **Hazard:** a channel is not an organ by itself. Memory
  `delivery-is-not-outcome`: a message learns whether it was **answered**, not
  whether it sent. Any new channel has to close that loop or it adds reach
  without learning.

### 4.11 Borrowed hands — MCP tools, connectors, delegation · *exists as a surface*

- **Senses:** what a tool returned, as an outcome percept — and what a tool
  *is*, so the repertoire can hold it as an ability rather than a lookup.
- **Acts:** whatever the tool offers, wrapped to satisfy §2's seven fields.
  A tool with no `description`, `cost` or `binds` enters the competition blind.
- **Objects:** whatever the tool names.
- **Hazard:** this organ is already out-of-process and the grant is someone
  else's to give, which is open question 5 of [[CONTAINMENT_BOUNDARY]]. It is
  also the only organ where a third party chooses the ability set, so it is the
  one place a tool catalogue can leak back in through the side door.

### 4.12 Proprioception — the body sensing itself · *unbuilt, and the one nobody builds*

The most important entry in this catalogue and the least obvious.

Affordance synthesis is a relation between a **body-in-a-state** and a
world-as-perceived. The world half is well served. **The body half is not
perceived at all.** Today the Will discovers that an organ is absent, degraded,
rate-limited or ungranted only by trying it and reading the failure — which is
exactly the re-probe loop that [[POLICY_REAFFERENCE]] P2 had to damp for policy
refusals, re-created once per organ.

- **Senses:** which organs are present; which are healthy; which are granted and
  how far; what each costs right now. Published as percepts so the synthesizer
  can gate on them like any other precondition.
- **Acts:** none. It is pure afference, like interoception.
- **Objects:** the organs themselves — which means an organ is an entity, and
  the sense boundary's `writes` declaration is what keeps that from reading as
  world.
- **Hazard:** it is the one organ that must exist for the others to behave, and
  it is the one with no external product to copy from. Build it with the first
  real organ, not after the fifth.

---

## 5. Phases

Order is derived in [[EMBODIMENT_PROJECTION]] §"what this implies about order":
the cage, then the body, then reliability — because the body is what makes a
loop expensive.

| Phase | What it delivers | Gated on |
| :--- | :--- | :--- |
| **P0** | **Fix the record.** The three defects in §2 — `external.ts`'s stale header, [[CUSTOM_ABILITY_WIRING]]'s Standing line, and the `'nourishment'` example in `types.ts` that routes to no drive. A host author cannot satisfy Rule 2 while the code says `binds` does not exist, and cannot satisfy Rule 5 while the type suggests a tag that silently scores 0. Hours, not days. | nothing |
| **P1** | **The organ contract, as a type.** An `Organ` declaration binding a sense contribution to effector declarations, so §3's rules are expressible and a profile can require both halves. Profiles gain organs where they currently list names. | P0 |
| **P2** | **Proprioception** (§4.12). The body becomes perceivable before it grows. Organ presence/health/grant published **as metrics**, not only as percepts — Rule 6 means `preconditions` can only gate on a key some faculty publishes, so this phase is what makes `{ metric: 'organ.page.available', … }` writable at all. | P1 |
| **P3** | **Cross-modal binding.** The trigger has already fired (§2); the chokepoint exists. Needed before a second *rich* sense, or percepts of one object across domains stay unrelated. | P1 |
| **P4** | **The page** (§4.4) as the first full organ, with vision's representation question settled in favour of structure (§4.3 option 1). First real test of Rule 2 at scale. | P2, P3, [[CONTAINMENT_BOUNDARY]] |
| **P5** | **The machine** (§4.5) and **the clock** (§4.7). The machine must not precede a containment seam. The clock folds in [[ELAPSED_ABSENCE]], which is already designed. | P4, containment seam shipped |
| **P6** | **The purse** (§4.6), last and narrowest, with `escalate` as the default verdict. | P5, and the reliability epoch closed |

**Risk that cuts across every phase: ack latency (Rule 3).** Order the organs
within a phase by how fast they answer, not by how useful they are. A file read
acks in a tick; a page action acks in many; a payment may never ack without a
human. Each step down that list widens the dispatch-to-reconciliation window
that produced the three-tick loop, and the satiation window they all share is
one global number that the persona prior is free to shorten (Rule 4).

The reliability epoch (goalless ratchet, undischargeable drive, repetition
window) is **not** a phase here because it is not a body problem. It is a
precondition for P6 and a risk multiplier for P4–P5.

---

## 6. What must not be built

Stated as prohibitions because each is the path of least resistance and each
would quietly undo the architecture:

- **A tool catalogue.** An ability the mind looks up rather than finds in the
  situation. The symptom is a JSON parameter schema; the test is whether the
  affordance competition has anything to weigh (Rule 3).
- **A planner–executor channel.** Plans bias the one action competition as a
  top-down prior ([[PLANNING_AS_PRIOR]]). An organ that takes a plan and
  dispatches steps re-introduces the parallel command bus the architecture
  deleted.
- **An LLM call inside a sense engine.** §4.3 option 2. External input reaches
  the mind by transduction, not by inference-at-the-boundary.
- **Per-organ prompt text.** An organ that works by adding instructions to the
  prompt is configuring the model, not extending the body. Meaning goes in
  `description`, where perception can read it too.
- **An organ that needs the mind to hold a credential** (Rule 5).
- **An objectless high-amplitude ability** — anything in §4.5 or §4.6 with
  `binds: 'none'` (Rule 2).

---

## 7. Open questions

1. **Is `binds: 'object'` enough, or do organs need their own binding kind?**
   A tab, a file and a line item are all "non-sentient known-entities" today.
   That may flatten distinctions the synthesizer should see. Note `SchemaBinding`
   already carries a fourth, internal kind (`'percept'`), so the enum is not
   closed on principle — only closed to hosts.
2. **Who owns an organ's entity lifecycle?** If a tab is an entity, something
   must retire it. [[FIELD_NOTES]] 2026-08-23 recorded 105 of 106 percepts
   immortal and entities growing 968 → 986 in one run; organs that mint entities
   will make that worse before they make it better.
3. **Should an organ be able to declare its own satiation window?** Today
   `repeatWindowTicks` is one global, persona-tuned value (Rule 4). A browser
   and a file read plainly want different ones. But a per-organ window is a new
   tuning surface on a seam the persona prior already owns, and
   `persona-prior-is-the-tuning-seam` warns what happens when two things write
   the same constant.
4. **Does the body need a fifth drive?** Rule 5: there is no epistemic or
   curiosity drive, so most of §4 competes with `drive = 0`. Adding one is a
   cognition change with its own document; *not* adding one means the body is
   goal-driven only, which may be correct and should be stated either way.
5. **What publishes the metrics `preconditions` need?** `confidence.calibrated`
   is an event, not a metric, so the gate §4.6 actually wants cannot be written.
   The general question is which faculties should publish metrics for organs to
   gate on, and that is P2's real scope.
6. **Does proprioception need its own sense domain,** or is it interoception
   widened (§4.2)? Five domains is a deliberate number and a sixth is a real
   commitment.
7. **How does an organ declare what it may reach,** and is that the same
   declaration as its abilities? [[CONTAINMENT_BOUNDARY]] open question 3 asks
   this from the other side; they should be answered together.
8. **Can an organ be learned?** A composite skill spanning two organs is the
   obvious next thing the repertoire would want, and nothing says whether a
   *composite across organs* is different from one within an organ.
9. **What does a world profile become** once organs exist — a list of organs, or
   a list of abilities plus the organs implied? The honest answer is probably
   organs, which means the five built-in profiles get rewritten.

---

## 8. Related

[[CONTAINMENT_BOUNDARY]] (what an organ may reach — build first) ·
[[EMBODIMENT_PROJECTION]] (why this order, and what it would be good at) ·
[[CUSTOM_ABILITY_WIRING]] (the efferent seam as shipped — Standing line stale) ·
[[AGENCY_PIPELINE]] (the loop every organ joins) ·
[[SENSES_HARDENING]] · [[SIGNAL_BOUNDARY]] (the afferent seam and Rule 6) ·
[[ELAPSED_ABSENCE]] (§4.7's afferent half, already designed) ·
[[LOSSLESS]] (§4.9's afferent half, in progress) ·
[[KNOWN_ENTITY]] (§4.8) · [[POLICY_REAFFERENCE]] (the verdict every act passes) ·
[[FIELD_NOTES]] (the measurements Rule 2 and §4.6 rest on)

---

## 9. Status

Not started. P0 is hours of work and is the only part that should not wait for a
decision, because the record currently tells a host author the opposite of the
truth about `binds`. Everything from P1 on is a plan of record and nothing more —
cite it as intent, never as capability.

The thing most likely to go wrong with this document is that it gets read as a
backlog of effectors to add. It is the opposite: six of its nine sections exist
to stop that.

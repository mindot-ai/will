# Will — Known-entity knowledge (how a mind comes to know someone / something)

> **✅ COMPLETE — Phases 0–5 all shipped** (will#174, #180–#183, #185–#188; the rename
> #175/#177/#178 and the goal-lifecycle prereq #184). The known-entity dossier is the
> *node* for anything Will knows, sentient or not: it perceives entities through its senses,
> records what it learns in reasoning, holds a referent before a name, grows familiarity
> through encounters, earns a reliability track-record, feels **curious** about the
> half-known, **recognises** the same someone across handles, forgets faded blips, and
> carries the ones that mattered across a restart (attachment × salience). Kept as dev
> documentation of the design + rationale.
>
> Before this, Will only "knew" **agents** — a per-`keid` triple (`theory.of.mind`,
> `reputation.tracker`, `attachment.evaluator`) gated on a social signal — while factual
> knowledge about everything else lived, scattered, in beliefs/episodes. This unified both
> into one mind-like substrate that it builds up the way a person does: holding a referent
> before a name, growing through encounters, weighting by attachment, and feeling **curious**
> when it knows too little.
>
> Design north star: **a mind, not a database.** "I know someone" must be expressible
> before we know their name or have seen them; thin knowledge must *pull* for more.

---

## Vocabulary (proposed — confirm before Phase 1)

- **`known-entity`** — the general category. The dossier: one node per thing Will knows.
- **`kind: 'sentient' | 'thing'`** — internal, precise. The Will refers to them in its own
  voice as **"someone / something"** (executive prompt). Precise in the machinery,
  mind-like in the experience. (Alternatives weighed: `sentient`/`thing`, `subject`/`object`.)
- We **drop "agent"** as the user-facing/architectural noun. The identity field is **`keid`**
  (known-entity id; `agentId → keid` ✅ done across the social stack). A former "agent" is
  just a `known-entity` of `kind: 'sentient'`.

---

## The dossier — one node for anything known

Keyed by an internal **referent handle** (`keid`) that is NOT the name. Holds:

| Dimension | Applies to | Notes |
|---|---|---|
| **referent + resolution confidence** | all | how well-pinned-down this someone/something is (drives curiosity) |
| **identifying attributes** (name, appearance, …) | all | each may be **unknown**; accrete over time |
| **familiarity** | all | mere-exposure: rises per encounter/recall, decays with absence |
| **affective valence** | all | do I feel good/bad near it |
| **attachment** | all | does its absence cost me (generalises `attachment.evaluator`) |
| **reliability / track-record** | all | *does it perform as expected* (a car/place/tool can have this) |
| **social reputation** (cooperativeness, standing, moral trust) | **sentient only** | |
| **mental model** (beliefs, intentions, emotion) | **sentient only** | `theory.of.mind` |
| **links** to beliefs + episodes about it | all | the dossier is the *index* over scattered knowledge |

The relational triple becomes a **specialisation**: `theory.of.mind` + the *social* slice
of reputation attach only when `kind === 'sentient'`. **Attachment and reliability
generalise to everything.** (Refines the earlier "ToM+reputation are mind-only": only the
*social* dimension of reputation is mind-only; *reliability* is general.)

---

## Pillar — referent identity, provisional & curiosity-driven (the mind-like part)

Humans know *someone* before they know their name. So:

- Identity = an internal **referent**, not the name. Name/face are attributes that may be
  `unknown`. A dossier can exist fully anonymous ("the person I spoke with yesterday").
- Each dossier carries **resolution confidence** (0–1): how identified/coherent it is.
- **Low resolution → curiosity.** A thin/uncertain dossier emits an epistemic pull — wires
  into `novelty.detector` + epistemic goals (`goal.manager` already has an `epistemic`
  completion type) so Will is *driven to learn more about what it half-knows*.
- **Recognition / merge** (LAST): when two referents' attributes converge, fuse them ("oh,
  that's the same someone"). Hardest + an R2 hazard — deferred to its own phase.

---

## Growth — how the knowledge accretes (per personality)

- **Familiarity**: a mere-exposure/decay curve (sibling of the existing attachment curve and
  the `relationship.<id>.*` EMAs) — rises on each percept/recall of the entity, fades with
  absence. `openness` could tune how fast novelty settles into familiarity.
- **Attachment**: as today (`attachmentGrowthRate`, agreeableness-developable — Channel A).
- **Reliability**: updated from observed outcomes/predictions about the entity.
- **Sentient extras** (ToM, social reputation): as today, fed by `interaction.occurred`.

---

## Persistence — attachment is the crystallisation driver

**Doctrine (resolved): the PMA is a soul, not a ledger.** A mind doesn't remember
everything it encountered — it keeps the *shape those encounters left behind*. So the PMA
carries the **salient residue**, never the complete log: a bounded top-N of known-entities
by attachment × salience, each a **crystallised dossier summary** (bond, valence,
reliability verdict, gist + key attributes) — *not* the full encounter trail. Two tiers,
exactly as in a real mind: **episodic detail fades** (mostly not soul-material), while the
**relational/dispositional gist persists** ("I don't recall our conversations, but I know
you're dear to me"). The forgetting curve letting the rest go *is* the soul-true behaviour,
and it keeps the PMA portable.

No hard session/enduring binary. **The more an entity matters (attachment × salience), the
more strongly it consolidates, the more likely it survives a restart, the slower it fades**
— the same logic the engine already uses (emotion-weighted episodic consolidation; PMA
top-N relationships). Concretely:

- Dossiers are state entities → ride snapshots.
- PMA distils the **most-attached / most-salient** known-entities (extends the relationship
  stub, attachment-weighted).
- Low-salience dossiers decay via the forgetting curve (acquaintances fade — mind-like).
- **Orthogonal parity fix (do first, correct either way):** `theory.of.mind` is currently
  lost on *every* restore — no `_restoreFromState`, absent from the PMA stub — while
  bond/reputation survive. Add ToM restore + a `tom` slot in the stub.

---

## Consumers

1. **Executive context (FIRST).** A Will in conversation **records what it learns about its
   interlocutor** (write-path from `audition`/executive) and **reasons over the dossier**
   next turn. Generalises the current "## People You Know" block to "who / what I know",
   cache-safe (coarse, evaluated off stable state).
2. Later: `audition` weighting (today reads attachment per speaker) generalises to any
   salient entity; `attention`/salience reads familiarity; curiosity goals from gaps.

---

## Phased plan (sequential — supports both `sentient` & `thing` from the schema up)

- **Phase 0 — ToM persistence parity. ✅ DONE (will#174).** `theory.of.mind` now
  `_restoreFromState`s its `tom-<id>` gist on the first tick (like attachment/reputation),
  and the PMA relationship stub carries a `mentalModel` gist (extract + reseed). A restored
  Will recovers its *sense* of a known mind (confidence + dominant intention + emotion), not
  the full belief trail (that fades — soul-true). Rides the attachment/reputation-weighted
  top-N, so a mind only crystallises when it also mattered enough to bond/track.
- **Phase 1 — the dossier spine.** `known-entity` entity type + store, **general from day
  one** (`kind` sentient|thing), built first as the *index* that aggregates the existing
  sentient triple per `keid`; persistence + attachment-weighted PMA; **executive read
  consumer** ("who/what I know"). `agentId → keid` rename ✅ done (will#175).
  - **1a ✅ done (will#176)** — executive read generalised: `extractSocialModels →
    extractKnownEntities`; the dossier shape gains `kind` (sentient/thing), `name`, and the
    general `reliability` dimension; the prompt renders by **name, or "someone" when
    unknown** (provisional identity; the raw `keid` no longer leaks).
  - **1b** — materialise the `known-entity` dossier as a persisted entity (a small
    aggregator) so beliefs/episodes can link to it and Phase 2's write-path has a home.
  - **1c** — attachment×salience PMA weighting for dossiers (the soul doctrine).
- **Phase 2 — the write-path (materialise the dossier with its writer). ✅ COMPLETE.**
  Two writers, two layers — joined per `keid` by `extractKnownEntities` (1a).
  **2.1 perception binder (will#180) · 2.2 master reasoning write-path (will#181) · 2.2b
  facet/conversation write-path (will#182) · 2.3 PMA persistence (will#183).** The loop is
  real end-to-end: perceive → bind a dossier → reason → record name/facts/feeling →
  reason over it next turn → and now it *survives a restart*.
  - **2.3 — PMA persistence (the soul doctrine). ✅ DONE (will#183).** The dossier is
    folded into the PMA relationship stub (`dossier: { kind, name?, familiarity, valence,
    encounterCount, resolutionConfidence }`); `_extractRelationships` reads `known-entity`
    entities; `PMALoader` re-seeds `ke-<keid>` (lastSeenTick reset — fresh embodiment). The
    top-N is now ranked by **attachment × salience** (attachment first, then familiarity +
    resolution, interaction volume a faint tiebreaker) — so the entities that *mattered*
    crystallise and fleeting ones fade (the forgetting curve, made portable).
  - **Perception (subconscious) — the cross-modal binder. ✅ DONE (2.1).**
    `known.entity.tracker` (registered standard+, ticks after the senses) subscribes to
    `senses.*` and accretes a `known-entity` dossier (`ke-<keid>`) per `sourceEntityId`:
    familiarity (mere-exposure + absence decay), kind, channel-supplied name
    (`raw.speakerName`), encounterCount, lastSeen, resolutionConfidence; prunes by
    familiarity; restores from state. `extractKnownEntities` joins it so a *perceived*
    entity surfaces (by name, or "someone") even before the triple models it. familiarity
    is kept internal (decays each tick ⇒ would churn the cached prompt).
    *(Decision #1: the senses are how a mind comes to know things.)*
  - **Reasoning (conscious) — `knownEntityUpdates`. ✅ DONE — master (2.2, will#181) +
    facet (2.2b, will#182).** The output schema carries `knownEntityUpdates: [{ keid,
    name?, learned?, feeling? }]` (types + parser `[KNOWN_ENTITIES]` block + prompt
    contract, shared by master AND facet). It follows the **same split as `newBeliefs`**:
    * **Master** → `buildStateCommands`: facts → `keid`-tagged `social_belief`s; name/feeling
      → a `known.entity.learned` event.
    * **Facet** (2.2b) → applies output via `executive.facet.progress`: `knownEntityUpdates`
      is promoted onto it, the **SemanticIntegrator** turns facts into `keid`-tagged
      `social_belief`s (its existing facet-belief path), and the facet **publishes
      `known.entity.learned`** (name/feeling) — so the tracker stays the single dossier
      writer and routine (un-escalated) conversation records too.
    Facts ride the episodic consolidator + vector memory + working memory (decision #2);
    the dossier *indexes* them. The tracker sets the name, eases valence toward the feeling,
    raises resolutionConfidence, and persists a named-but-unseen someone.
  - **Dossier shape** (`known-entity` entity, id `ke-<keid>`): `keid, kind, name?,
    familiarity, valence, reliability?, resolutionConfidence, lastSeen` (+ joins
    trust/closeness/intention from the triple, + links to `keid`-tagged beliefs).
  - **Provisional identity:** `keid` is the perception-supplied referent (exists before the
    name); `name` accretes; `resolutionConfidence` rises with identifying attributes; the
    raw `keid` never surfaces (the prompt already says "someone" — 1a).
  - Faculty name **`known.entity.tracker`** (decision #4). LLM-contract shape is the
    implementer's call (decision #3).
- **Phase 3 — curiosity-to-resolve.**
  - **3.a — aggregate curiosity drive. ✅ DONE (will#185).** `known.entity.tracker` emits a
    `drive.curiosity_resolve` metric = `max familiarity·(1−resolutionConfidence)` — peaks for
    a familiar-yet-unknown someone, near-zero for strangers and the well-known. A
    `goal.manager` drive-mapping (threshold 0.4) turns a sustained drive into an **epistemic**
    "get to know the people I keep encountering but barely know" goal that resolves as the
    Will *learns* (belief formation, incl. keid-tagged beliefs) — lowering the drive (a clean
    loop). Safe under the born-done / age-0 goal guards (will#184).
  - **3.b — per-entity curiosity. ✅ DONE (will#186).** The vivid *"who was that?"*. For a
    familiar-yet-unresolved referent the tracker raises a specific `attention.demand`;
    `goal.manager._activateFromPercepts` (now honouring per-demand `goalTags` /
    `completionType` / `completionCondition`, deduped by the `keid:` tag, born-done-guarded)
    turns it into a per-keid **metric** goal *"get to know <name|someone>"* that completes
    on *that* referent's resolution (`known_entity.<keid>.resolution >= 0.6`). The pull
    subsides once resolved. (keid is sanitised — `:`→`_` — for the `[\w.]` condition parser.)
- **Phase 4 — generalise growth to `thing`. ✅ DONE (will#187).** The dossier mechanism is
  kind-agnostic: a non-audition percept binds a `thing` (familiarity curve, same as a
  someone). Reliability is now a dossier-native track-record (EMA of `action.outcome`s
  targeting the entity — general: a tool/place/person; decision #3) — authoritative over the
  sentient social reliability in `extractKnownEntities`, persisted + PMA-carried. Forgetting:
  a faded, unidentified blip (familiarity < floor, no name, low resolution) is dropped from
  memory and its `ke-<keid>` entity deleted; a named/resolved entity is identity-constitutive
  and kept (it rides the attachment×salience PMA, never forgotten).
- **Phase 5 (last) — recognition / referent merge. ✅ DONE (will#188, hardened will#189).**
  Two referents resolved to the *same name* (`trim().toLowerCase()` — so `Alice`/`alice`/
  `  Alice ` match; no fuzzy, so `alis` stays separate — a safe under-merge) are recognised
  as one someone and fused into a canonical keid (most-familiar wins, ties by keid order)
  with a `known-entity-alias` record. The tracker redirects later encounters of an aliased
  keid onto the canonical (no re-forming); `extractKnownEntities` resolves aliases so the
  triple/dossier/beliefs all aggregate under the one someone — no destructive re-keying.
  **Conservative (will#189) — a bare name match is too weak to conflate two *different*
  people who share a name:** only a still-thin handle (`encounterCount < 8`) is absorbed, and
  never when both were active concurrently (`|lastSeen gap| < 20` ⇒ two interlocutors at once,
  not one on two handles). Bias = keep two records of one person (harmless) over fusing two
  people. Deterministic (R2). *Future depth: a split trigger when fused evidence diverges, or
  executive-confirmed recognition — name+timing alone can't resolve identity perfectly.*
- **Channel A + B parity. ✅ DONE (will#191).** *Channel B* was there from the start — the
  dossier surfaces to the deliberate self (`## People You Know`) and is written back via
  `knownEntityUpdates`. *Channel A* now too: the tracker's dispositions are developable
  (base `engine-config-known-entity` ⊕ persona-prior, read effective each tick) and develop
  from self-model traits (consolidator rules 33–35) — **openness** grows familiarity faster
  (`familiarityGrowthRate`) and sharpens the pull-to-know (`curiosityGain`); **analytical**
  revises track-record judgments faster (`reliabilityRate`). (Recognition guards stay fixed —
  correctness, not a disposition.)

---

## Guardrails

- **Determinism (R2):** all growth/decay/resolution from sim-tick + pure state reads; no
  wall-clock/RNG. Merges (Phase 5) must be deterministic & replay-identical.
- **Cache:** the executive dossier block must be coarse/stable (same discipline as graded
  trait salience) — only changes on a real, evaluated transition, never per-tick.
- **Specialise, don't fork:** one dossier; sentient-only sub-records attach by `kind`.
  Don't reintroduce a parallel "agent" stack.

---

## Decisions (resolved)

1. **Names ✅** — `kind: 'sentient' | 'thing'` internally; "someone / something" in the
   Will's own voice (executive prompt). "agent" is dropped; the id field is `keid`.
2. **Resolution depth ✅** — *most human-mind-like*: no hard DB merge. Phase 5 is
   **recognition** — referents fuse provisionally as identifying evidence accumulates,
   carried with a revisable confidence (mis-recognition allowed, later corrected).
   R2-deterministic (evidence-weighted at sim-tick, no RNG), but behaves like recognition.
3. **Reliability source ✅** — native `reliability` field on the dossier (predicted-vs-actual
   track record), **not** bolted onto `reputation.tracker` (which stays social/sentient).
   Generalises cleanly to a car/place/tool; sentient social-reputation feeds in as the
   sentient-only slice.
4. **PMA budget ✅** — see the persistence doctrine above: bounded top-N by attachment ×
   salience, stored as crystallised summaries (salient residue), not complete logs. Exact N
   + weighting curve is a Phase-1 implementation knob (start from the existing top-20).

*Companion to the social-cognition stack (`theory.of.mind`, `reputation.tracker`,
`attachment.evaluator`, `empathy.simulator`, `social.perception`) and the PMA relationship
stubs (`pma/index.ts`). See `TRAIT_CHANNEL_A_EDGES_TODO.md` for the persona machinery these
faculties already plug into.*

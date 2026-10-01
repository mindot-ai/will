# LOSSLESS — nothing the mind takes in, thinks, says or keeps is cut

> **Standing:** DESIGNED · 2026-09-30 · scoped from a trace of every cut in `src/` (281 sites read, 64 of them comments); P0–P4 of 6 landed, unreleased

> **The rule:** *lossless, not unbounded.* Every cut that loses data — at intake, in
> transit between the mind's own parts, in what it keeps, in its artifact, in its
> logs — is removed. What goes into a single LLM call stays bounded, but never
> silently: ranked, counted, and recallable whole.

---

## Why

A mind that is handed part of an answer and not told it is part is reasoning from
someone else's conclusions. That is not a hypothetical in this record:

- A live COO called `discord_lookup_member` **65 times** because a bare `120` cut
  every reply to a JSON header before it reached her (FIELD_NOTES, fixed by #150).
- Her record of what she had said was cut to 100 characters per turn, and the
  other person's answer to 140, so "they answered: …" was often not the answer.
- Her reasoning crossed from the master to her facets at 400 characters —
  "facets have been reading the master's JSON truncated mid-object" (parser.ts).
- The trace an operator reads to judge her was cut again: 500 characters of facet
  reasoning, 1,000 of master reasoning. **Our analysis of her was built on the
  same cuts she was.**

SIGNAL_BOUNDARY P2 already said it for the host: *a host may decide what it looks
at; it does not get to decide how much of what it found the mind is allowed to
know.* This epoch holds the engine to the same rule.

## What this is not

**Not unbounded prompts.** The engine has no notion of a context window. GLM-5.2
defaults to ~203k tokens (1M only as `glm-5.2[1m]`), and one raw 30-PR GitHub
listing is ~135k. A prompt that grows with everything the mind has ever seen
fails at the provider, and the executive goes dark. The per-call view stays
bounded; what changes is that nothing leaves it **silently**.

**Not the mind's own limits.** Working memory chunks, active-goal capacity,
attention caps, the forgetting curve, belief decay, the percept sweep: these are
the model of a mind, not cuts of its data. They stay as designed (§ MIND below).

Measured on the one live mind (lora-c4cq81, 1,917 LLM calls, 2026-08-11 → 08-31):
largest input 13,401 tokens (p99 7,462), largest output 3,171 against an 8,096
ceiling. Removing text cuts is safe at that scale; an oversize single item is the
case that needs a mechanism (P5).

---

## The five kinds of cut

| Kind | Meaning | Fate |
|---|---|---|
| **LOSS** | Data dropped at intake, in transit between the mind's parts, in what it keeps, or in its artifact | Removed |
| **LOG** | An operator's record cut (session log, logger lines, error bodies) | Removed |
| **VIEW** | What a single LLM call is shown | Ranked + counted + recallable; single-item text cuts removed |
| **MIND** | A limit that is the cognitive model itself | Stays |
| **NONE** | Not a cut: parsing, ids, transport *splitting*, numeric clamps | Nothing to do |

---

## Phases

### P0 — what she said and heard is whole ✅

The records a turn is judged by. `conversation.sent` / `conversation.received`
carry a `preview` and nothing longer; `readSpokenTurns` (conversation.aim.ts)
reads it into `## What I've Said Lately` and the "they answered" line, and
`prompt.factory.ts:1218` cuts it again.

- [x] `conversation.sent` / `.received` carry the full text; readers read it; old
      records that only have `preview` still read (a woken mind's history)
- [x] `outbox.writer.ts:163-164`, `proactive.communicator.ts:233,249-250`,
      `escalation.lifecycle.ts:211`, `audition.engine/engine.ts:1134,1179` — no cut
- [x] `prompt.factory.ts:1218` — spoken turns render whole
- [x] `audition.engine/engine.ts:622` — a heard turn's percept `summary` is whole
      (today the master sees 100 characters of what someone said)
- [x] `audition.engine/engine.ts:281` — thread digest turns whole (count is P5)
- [x] `conversation.memory.ts:71-72` — conversation episodes stored whole (today
      100/140 characters — this is what recall finds later)
- [x] `discord.ts:52` `REACTION_QUOTE_CHARS` — the reacted-to message quoted whole
- [x] `proactive.communicator.ts:140,274` — the act's own description carries the
      words whole (it feeds `## What Became Of What I Did`)
- [x] **Episodes deduplicated on identity, not a 100-character prefix**
      (`episodic.consolidator.ts`, moved here from P2). For a conversation the
      prefix was boilerplate — `{"wmType":"conversation.exchange","activation":…`
      — so a different person saying a different thing was dropped as "already
      remembered" (reproduced live: Ada consolidated, Bo never did). Identity is
      now the WM item's id: every runtime writer names an item for the thing it
      holds, for its whole life (`wm-goal-<goal>`, `wm-percept-<percept>`,
      `wm-plan-<plan>`, `wm-exchange-<entity>-<tick>-<hash>`). Content is NOT part
      of it — a goal's priority drifts every tick, and keyed on content one goal
      became 1,334 "memories" in a 10K-tick soak once forgetting ran in days.
      `WorkingMemory.load()`'s boot-restarting counter ids are test-only.
- [x] Conversation WM item ids are deterministic (sim tick + hash of the words,
      the `_sentKey` recipe). They were wall-clock "telemetry only" until an
      episode began to remember its source; a wall-clock id in durable state is a
      run that cannot replay (caught by `replay.conversation.test.ts`).

What P0 surfaced, and its owner then recalibrated outside this epoch — the
forgetting curve, which is MIND: the one live mind held **zero** episodes on
every one of 2,095 ticks of a 35-minute run. The default rate (0.02/s) forgot a
typical episode in ~20 s, and every mind woken from its artifact ran at
`1 − memoryPersistence × 0.7` (0.44–0.79/s) as an ABSOLUTE rate — gone within
the tick. Now set in days of running time, persistence a multiplier on it
(`DEFAULT_FORGETTING_RATE_PER_SECOND`, forgetting.curve.ts).

### P1 — what she thinks is whole, in transit and in record ✅

- [x] Bus payloads whole: `executive.interpretation.formed` (was 400),
      `executive.decision.rationale` (200), `executive.master.sync` (600), and the
      facet-handoff escalation body (400) — the tract #160 built to carry "what it
      concluded" was still clipping it
- [x] A facet's history entries whole: master sync (cut again to 400) and its own
      reasoning (400). The counts, 5 and 10, are P5
- [x] **Every new goal the mind forms is added** (was the first two); GoalManager's
      capacity rule demotes the lowest to pending — a mechanism, not a cut
- [x] **Every self-observation kept, each under its own id** (was the first five,
      written into a 20-slot ring that overwrote itself, sometimes within a cycle)
- [x] Goal abandon reason (200), plan outcome (300) and supervision reasons
      (100/120) whole
- [x] The summariser's input whole (600 per entry; the option is gone). The
      summary itself is consolidation, and stays lossy by nature
- [x] Pivotal events keep the episode's text whole (was 150)
- [x] **The output ceiling is never silent.** Every wire reads why the provider
      stopped (`max_tokens` / `length` / `MAX_TOKENS`), a cut response is marked
      `truncated`, warned about at the one place every completion passes, and
      flagged in the ledger. (Never hit yet on the live mind: max 3,171 of 8,096.)

Reclassified while doing it, both measured:

- **The narrator's `story` is a VIEW, not a loss.** Every chapter the executive
  writes is kept whole as its own `narrative_chapter`, and nothing renders the
  story whole. Persisting the narrator's own heuristic line was tried and
  reverted: it is a statistic over episodes that are themselves kept, and a quiet
  mind writes one every 50 ticks — ~1,700 a day of boilerplate, which the
  bounded-growth soak caught.
- **Self-observations were read by nothing** — now read. `## Recent
  Self-Reflection` renders them whole, newest first, with a count of the ones not
  in view (6 shown; the recall act is P5). Wiring it surfaced the section's other
  loss: the introspection engine re-took the executive's introspection on every
  tick of the fresh window (14 copies of one reflection), and the copy the prompt
  read had `lessons` where it read `lessonsLearned`, and no recommendations — the
  mind was shown its biases and never what it had decided to do about them. Taken
  once now, carried whole, read under either name.
- ~~**Open — a facet's mind-wide output goes nowhere.**~~ Carried (its own PR,
  after P4). Every facet shares the master's system prompt, so every facet was
  asked for all of it, and only the master's output became state — on Lora's
  archived runs 18 of 364 facet decisions held an introspection and 27 a
  narrative, all dropped. A facet's account of itself (introspection, narrative,
  self-observations, identity, skills) now rides `executive.facet.sync` and the
  master writes it on its next tick, under the facet's name (`selfRecords`, shared
  with the master's own); its reflection and skills are published as the
  master's are. `goalsToReprioritize` rides `executive.facet.progress` to the
  GoalManager, and what a facet learned about people no longer depends on its
  creator's extractor keeping it (plan supervision's kept none).

### P2 — what she takes in is whole, and kept ✅

- [x] **Nothing dropped at the door.** Exteroception dropped every change past the
      50th in a tick, social perception every signal past the 20th — and each
      records what it scanned as seen (a received turn is swept the same tick), so
      what a cap dropped was never perceived at all. Both caps and their mirror
      params gone; a world entity's description reaches its percept whole (was 100)
- [x] **Working memory keeps the most salient of what arrives together.** It
      admitted each newcomer by evicting the FIRST least-active item — in a batch
      at equal activation, the one admitted just before, i.e. the more salient.
      Measured: of 20 percepts it kept the 7 LEAST salient (0.05–0.35); and the
      evicted, still in state, were re-admitted next tick and displaced the
      winners, then lost again — a period-2 oscillation. Now each percept competes
      once, most salient first, for a slot held by something weaker. Capacity,
      decay and recency unchanged. This had to land with the caps: uncapped, a
      burst would have filled working memory with the noise floor
- [x] **What she perceives becomes memory.** The consolidator skipped every item
      tagged `percept` as a "meta-percept" (v0.1.0); every percept carries the
      tag, and the sense boundary has since made percepts-about-percepts
      impossible — so it dropped only the world, including the answer each of her
      own acts brings back (effector observations arrive as somatosensation
      percepts with their data). Nothing she read on GitHub outlived working
      memory. Now remembered, data whole
- [x] **Every strong-enough candidate consolidated, not five a tick.** An item
      another engine writes into working memory lives one tick; a woken mind is
      handed its last conversation with each person that way (`pma` §8) and kept
      five of twelve. `maxPerTick` removed, and ignored in a woken mind's saved
      config (the forgetting-rate trap: a default change does not reach a mind
      that persisted the old value)
- [x] **Clustering reads the whole cluster, and what each memory was about.** It
      named a cluster from the first 20 episodes' first 10 words (LOSS) — and its
      own text reader found a summary only at the top level, so any episode
      consolidated from working memory read as its JSON: two unrelated percepts
      overlapped on `wmtype`, `content`, `summary`, `activation` and clustered.
      It now reads `episodeContentToText`, the text the vector index embeds, which
      learned the goal shape (`content.description`)
- [x] `integrator.ts` pattern probe — reclassified **NONE**: a search query, kept
      short enough to embed. Its fault was what it held — the first 150
      characters of each episode's JSON; it now probes with their meaning
- [x] **The bus never drops intake; every other drop is reported.** `senses.*`
      events are critical now — KnownEntityTracker builds who she knows from them
      and nothing else. Metric drops were logged on the 1st, 101st, 201st… with
      no type; now every flush that dropped says how many, of what. Whether the
      500 bound goes is decided from that record
- [→] Attachments (24,000 chars / 4 files / 256 KB fetch) **moved to P5**. The
      bridge's cut is the only thing bounding a call until the mind has a
      window-aware path for an oversize item; removed first, one 1 MB log
      (~250k tokens) fails the conversation call outright

Found doing P2 and **not** changed — each is a decision:

- ~~**Attention has never reached working memory.**~~ Wired (its own PR, after
  P2). `AttentionAllocator` writes `attention.focus.metadata.entityId`;
  `WorkingMemory._applyAttention` read `targetEntityId` — since v0.1.0 no item
  was marked attended, so protection (decay ×0.4) and rehearsal (+0.02 after 3
  attended ticks) never ran. Measured on one salient change: held 8 ticks
  ignored, 45 attended — and still let go, because a focus nothing reinforces
  decays. 100K-tick soak green.
- ~~**A percept is remembered by a margin of 0.018.**~~ Closed (its own PR,
  after P4). It entered at 0.75 and decayed in the same pass that admitted it, so
  the consolidator weighed 0.67 × 0.4 = 0.268 against 0.25 at ~1 tick/s, and
  0.236 — never — at 2 s. Working memory now records the activation an item was
  **encoded** with, and consolidation weighs that (or the current activation, if
  rehearsal has lifted it since). A goal held in mind (0.65 → 0.26) is now
  remembered, once — its WM id is the goal's, so a re-admission is not a second
  episode.
- ~~**A world entity re-set every tick becomes an episode every tick.**~~ Closed
  (same PR). Exteroception compares what an entity says (everything but its
  timestamps), read only when it was written since. An act's effect on its target
  is confirmed by a change in the target — a write that changes nothing confirms
  nothing, as an act that changed nothing is not a success (Mindbase #146).
- ~~Host-supplied social signal types that persist in state (`message`, `action`,
  …) are re-perceived every tick~~ Closed (same PR). Each signal is perceived
  once per write. `communication` waited for a `processedByExecutive` flag nothing
  sets before it could be swept — never swept; now swept like the rest. (Not a
  double count with exteroception: that is the only path a host message's CONTENT
  takes into memory; social perception carries the social signal.)
- An observation episode is embedded by its ≤100-character sense label, not its
  data — recall by meaning of what she read is P5.

### P3 — what she keeps is whole

**P3a — the mind's own stores ✅** (the artifact, below, is P3b)

Every count cap here dropped from memory and **not from state** — forgotten
in-session, restored on the next boot. The cut was a lie twice.

- [x] **Beliefs.** Past 500 the store deleted EVERY belief under 0.3 — not the
      fewest to get back to 500 — the one just formed included. Gone; decay bounds
      the store. And the mind's own prune (decay to 0.12) now deletes the entity:
      it was left behind, so the PMA, the bias detector and the self-model read a
      belief the mind had let go, and a restart restored it
- [x] **Belief history whole** (was the last 20). A run of decay steps is one
      entry (`since`, `steps`, total `delta`): decay is a fixed step every tick
      once stale, ~680 entries per fading belief, which is why a cap looked needed
- [x] **People, reputations, theory-of-mind models** — past 50 / 20 / 10 dropped
      from memory, not state. Caps gone. A named referent is kept; an unnamed,
      unresolved blip that fades is still forgotten (Phase 4, deletes properly)
- [x] **Recall by meaning.** The index evicted ~10% at 10,000 — remembered, then
      unreachable by meaning. Default now none (`maxIndexedEpisodes` stays a host
      option). Removing it surfaced what the eviction had been hiding: indexing is
      fire-and-forget, so an episode forgotten while its embedding was in flight
      had its vector land afterwards for a memory that no longer existed. Lora's
      first self's index held **9,671 vectors against zero live episodes**, and
      dead hits take recall's top-k slots. Closed (a delete in flight cancels the
      insert), and recall lets go of any dead hit it meets, so an old index heals
- [x] Reclassified **NONE**, each checked for a reader: bias evidence (a statistic
      over beliefs and decisions kept elsewhere; nothing reads it) and the 15-bias
      prune (one entry per bias type — it cannot fire); introspection history 30
      (an in-memory mirror feeding a metric — her reflections persist whole as the
      executive's own records); the narrator's 10 themes (every chapter keeps its
      themes whole in `narrative_chapter`) and 20 pivotal events (a pointer list
      over kept episodes, re-pushed each pass — the heuristic line P1 rejected)

Found doing P3a and **not** changed — each is the model of a mind, and the owner's:

- ~~**Belief decay runs every tick.**~~ Recalibrated to days of running time
  (its own PR, after P3): `DEFAULT_BELIEF_DECAY_PER_SECOND` — a weak belief
  (0.3) reaches the prune in ~3 days, a firm one (0.9) in ~13. Two relations had
  to move with it, both measured on the real engines. Spaced repetition's
  automatic review "assumed successful recall" (+0.05, fresh last-update, no
  evidence); per-tick decay lost that race, days-scale decay would have lost to
  it — every belief at 1.00 in 12 hours, forever. A review nothing recalled now
  moves only the schedule. And its record was persisted under the BELIEF's id:
  the later write won each tick, the belief entity became a review record, and a
  woken mind restored none of its beliefs — the unexplained "beliefs lost on
  restart" of the first review. Records have their own id (`sr-<belief>`), old
  ones still restore, orphans go with their belief. The parameter is renamed
  (`beliefDecayPerSecond`): a woken mind's saved per-tick 0.001 is ignored.
- ~~**Theory of mind's fade cannot fire, and should not as written.**~~ Fades
  in days now (its own PR, after P4). The decay took `rate × ticks since update`
  every tick — a step that grew with the silence — so the read of a colleague hit
  its 0.05 floor two ticks after 100 quiet ticks, and empathy (which uses a model's
  emotion only above 0.3) read nobody it had not heard from in the last minute and
  a half. A woken model was dated to tick 0 — `createdAt` keeps its first value
  and is sim-time ms, so it never held the last update — and faded on its first
  tick. And the floor sat on the prune line, so no model was ever let go. Now a
  fixed step per second at a belief's rate (a fresh read is let go in ~4 days of
  silence, a firm one in ~2 weeks), `lastUpdated` persisted and restored, and a
  model let go is deleted from state.

**P3b — the artifact, and waking ✅**

- [x] **The artifact is whole.** It carried the top 50 beliefs, 10 goals, 20
      relationships and 50 skills — and of goals only `active` ones: the filter
      also accepted `in_progress`, a status that does not exist, so a pending goal
      (demoted by capacity, not given up) or a blocked one never left the Will.
      Every belief, every goal still held, everyone known, every skill above the
      habit floor (the floor is forgetting, and stays). A dossier stub now carries
      the `handles` a person is reached at, and `suspectedSameAs`
- [x] **Waking does not overwrite the mind.** `Will.wake` restores the latest
      snapshot inside createWill and THEN loads the artifact; the loader's doc said
      "only when no prior snapshot was restored", and the wake path never honoured
      it. So EVERY wake: goal progress reset to 0 (via addGoal); every belief
      re-dated to tick 0, stale at once; the dossiers of the people the mind knew
      best replaced by stubs with **no handles** — it knew who they were and could
      not reach them — and theory-of-mind models by one-line gists; and the last
      conversation with each person remembered a second time. Now the snapshot wins
      where it holds a thing and the artifact fills only what it lacks.
      `GoalManager.restoreGoals` restores progress and status verbatim
- [x] **A new goal never takes a held goal's name.** The id counter restarts at
      0 each boot while a woken mind's goals return as goal-1…goal-N, so its first
      new goal was `goal-1` — and overwrote the one already there
- [x] **Identity guard.** Too many values or too long a style from an OPERATOR is
      an error now, as too long a prompt is (it was truncated with a warning). The
      mind's own identity, reloaded from its artifact, is kept whole — the
      self-model grows its values, and rejecting them there would refuse to wake it
- [x] `surface/host/utterances.ts` holds every word until a host takes it (was 50)
- [x] Reclassified **NONE**: ~~the transport's 1,000 un-acked envelopes (anything it
      could drop has already expired in the outbox — 100 ticks)~~ — wrong: a
      message the transport carries leaves the outbox the tick it is written, so
      the outbox's TTL never sees it (closed below); the event log's
      in-memory ring (no live mind wires an event log: `createProductionBus()`
      takes none); the artifact's top-3 actions and 5-session emotional baseline
      (statistics over records kept whole on disk)

Found doing P3b and **not** changed:

- ~~**The executive's `identityUpdates.values` and `.style` are never applied.**~~
  Applied (same PR as the facet's account), once each, by the executive engine on
  the next tick's state (`identityUpdateCommand`): traits by their delta, values
  ADDED (the prompt said "replaces existing" — an operator's values are not the
  mind's to drop), a style taken only while the style is still generic. The nudge
  had asked for an `[IDENTITY_UPDATE]` block the parser never reads and a `style`
  the output had no field for. Traits had been applied by the narrator, only when
  its 50-tick pass found the master's output fresh — missed, or (the output stays
  fresh 60 ticks) applied twice; the narrator's story took the same output twice
  the same way, and now takes each once. Open: a style the mind set for itself
  cannot be revised by it (no record of whose a style is).
- ~~**The transport re-emits what the mind already knows failed.**~~ Closed (its
  own PR, after P4), and worse than recorded. A message the transport carried
  left the outbox the tick it was written, so the outbox's TTL never saw it:
  un-acked, it was held for as long as the Will lived and delivered on the next
  reconnect however late. And an invocation was re-emitted after the executor
  had timed it out (failure recorded) or a change in its target had confirmed
  it — the host performed an act the mind had already settled. The tick loop now
  lets go of both, beside the outbox's own expiry: a message at the outbox's TTL,
  an invocation once its `agency.intent` is gone. The 1,000 cap (a silent FIFO
  drop) is gone — the buffer holds what the mind awaits. And the mind is told: an
  expired message, the outbox's or the transport's, is received as a failed
  delivery (`confirmDelivery(…, false)` — the sent record and a reafferent
  percept). `communication.outbound.undelivered` has no subscriber, so to the
  mind an expired message had been a message never answered.
- ~~**The event log, if ever wired, rewrites the whole file on every flush**~~
  Closed (same PR). `StorageAdapter.append` (the file store implements it); a
  store without it falls back. `flush()` drains — it returned the write in
  flight, so what arrived meanwhile stayed unwritten — and a failed write puts
  its batch back.

### P4 — the operator's record is whole ✅

The trace an operator judges the mind by is built from the session log (Lora's
host tails it), so every cut here was a cut in our analysis of her.

- [x] **A facet's response whole** (was 600). The master writes every prompt and
      response to `debug/`, so its 600-character excerpt is a preview beside
      `responsePath` and stays; a facet writes no file, so its excerpt was the only
      record of what two-thirds of her decisions said
- [x] Reasoning whole: the master's `executive.output` (was 1,000) and a facet's
      `executive.facet.output` (500) — the lines the trace's `decided` rows carry
- [x] Errors whole: the session-log `error` (300) and the logged failure (200),
      master and facet; provider error bodies on every wire (300) and the boot
      probe's (300) — a refusal's cause is often past the first 300 characters of
      an HTML error page
- [x] `spaced.repetition.ts` statement (100); the metrics debug flush (10 points,
      then "… and N more" of points spliced out and gone); logger lines quoting
      her words or decisions — outbox (80), proactive (80), audition (120/80),
      planning (40). A test scans every source file for a logger line quoting
      through a fixed-length cut
- [x] Already whole before P4: `outbox.writer` / `proactive.communicator` session
      messages (P0) and `reafference` (P0)
- Not an engine cut: the host console lines in `executive/coo/lora.ts`
  (`brief()`) — the trace FILE it writes is whole

### P5 — each call lossless, not unbounded

**Designed in [[LOSSLESS_P5]]** (2026-10-01): the window, paging an oversize item,
honest counts with a `[RECALL]` request, the text cuts, attachments as items, and
recall by meaning of what she read — five PRs, six decisions for the owner. It
found the overflow P2 opened: a tool's whole output renders in every prompt (twice
while its percept lives), and one 30-PR listing is ~135k tokens. The sketch below
is the scope it started from.

The design work. Three parts, in order:

1. **A context window the engine knows.** Host-declared per model, beside prices
   (`llmConfig.providers.<p>.models.<m>.contextWindow`) — prices taught us these
   are host-owned. Absent → today's behaviour.
2. **Every VIEW section ranked, counted, recallable.** Each section renders its
   most relevant items and states exactly how many more exist ("12 more beliefs
   not in view"), as `## My Beliefs` already half-does. An innate act lets the mind
   pull any named item — a belief, a memory, a person, an observation — into view
   whole next cycle. A mind that knows something is out of view, and can reach it,
   has not been truncated.
3. **An oversize single item is referenced, never cut.** Past a share of the
   window, an observation or attachment renders as its size plus a handle; the
   mind reads it in pages through the same act. Every byte stays reachable.

Attachments land here, moved from P2: the bridge delivers a file whole
(`surface/channels/types.ts` 24,000 chars / 4 files, `discord.ts` 256 KB fetch
today), the mind keeps it whole, and a call sees it through part 3.

Single-item text cuts in VIEW are removed here: `effectors.ts:57,73`
`MEANING_CAP` (it hides every GitHub tool's required args today),
`prompt.factory.ts:699-702` `MEMORY_CONTINUITY_CAP` — which labels a truncation
`[...summarized]` — `:1169` `RECALL_CHAR_BUDGET`, `context.ts:594,628-638`
`extractSummary` (120/200), `prompt.factory.ts:1302` expected outcome (80).

Count caps that become ranked + counted + recallable: `MAX_SURFACED_ABILITIES` 8
(`context.ts:379`, today first-8 by iteration order), `BELIEF_PROMPT_LIMIT` 30 /
`PER_CATEGORY_CAP` 8, known entities 6 (`context.ts:502`), percepts 10
(`context.ts:663`, `prompt.factory.ts:816`), recalled memories 8 (`context.ts:122,139`),
`SPOKEN_TURNS_SHOWN`, `ACTION_RECORD_KEEP` 6, `TRAIT_SURFACE_CAP` 6, thread
digest 5 turns, facet master-sync 5 / reasoning history 10.

---

## MIND — limits that stay

Working memory `maxChunks` 7 · `maxActiveGoals` 5 · `DEFAULT_MAX_FACETS` 10 ·
affordance attention cap 5–12 · forgetting curve prune · belief decay and the
0.12 prune · percept sweep after 2 ticks · spaced-repetition reviews per cycle ·
dream reactivations · satiation and settlement windows · the rolling summariser's
buffer (consolidation is lossy by nature; its INPUT is not, P1) · every numeric
clamp (`PRECISION_MAX`, `EFFORT_MAX`, `MAX_COMMITMENT_BOOST`, …).

A limit belongs here only if it is how a mind works, not how much of its data the
engine could be bothered to keep. When in doubt, it is LOSS.

## NONE — not cuts

Parsing and ids (`bus.ts:79`, `mind.ts:620`, `replay.controller.ts:136`,
`session.logger.ts:105`, `engine.ts:543`) · streaming holdback
(`audition.engine/engine.ts:802,811`) · Discord's 2,000 and WhatsApp's 65,536
character message **splitting** (`types.ts:128-131`) — splits, drops nothing · k-NN
result counts (`vector.index.ts:220,403`) · recall query formation
(`context.ts:519,536`) · the mock reply (`llm/index.ts:547`) · LLM concurrency.

---

## How each phase lands

One PR per phase. Each change names the reader of the value it stops cutting and
asserts on **rendered output or stored state**, never on a hand-built input — the
epoch before this one shipped six mechanisms dark on green suites. A test that
pinned a cut is changed to pin its absence, and mutation-checked: restore the cut,
watch it fail.

## Related

[[SIGNAL_BOUNDARY]] (P2 — the host side of the same rule) · [[FIELD_NOTES]]
(the 65 lookups) · [[STANDING]]

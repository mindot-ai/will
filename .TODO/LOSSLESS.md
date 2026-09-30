# LOSSLESS — nothing the mind takes in, thinks, says or keeps is cut

> **Standing:** DESIGNED · 2026-09-30 · scoped from a trace of every cut in `src/` (281 sites read, 64 of them comments); P0–P2 of 6 landed, unreleased

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
- **Open — a facet's mind-wide output goes nowhere.** A facet on the standard
  output format (plan supervision) is asked for BELIEFS, INTROSPECTION, NARRATIVE
  and SELF_OBS like the master, and its decision callback carries none of them
  on; only the master's output becomes state. Either carry them to the master or
  stop asking a facet for them — a decision, not a cut.

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

- **Attention has never reached working memory.** `AttentionAllocator` writes
  `attention.focus.metadata.entityId`; `WorkingMemory._applyAttention` reads
  `targetEntityId`. No item has ever been marked attended: attention protection
  (decay ×0.4) and rehearsal (+0.02 after 3 attended ticks) are dark, and
  `attendedCount` is 0 for every item working memory owns. Wiring it is MIND as
  designed, but it changes what every mind holds and for how long.
- **A percept is remembered by a margin of 0.018.** It enters at 0.75, decays one
  tick (0.08/s) before the consolidator's first look: 0.67 × 0.4 = 0.268 against
  a 0.25 threshold. At ~1 tick/s (Lora) it holds; at a slower tick it silently
  stops. A goal (0.65 → 0.57 → 0.228) is never remembered on activation alone.
- **A world entity re-set every tick becomes an episode every tick.**
  Exteroception perceives a change of `updatedAt`, not of content. Lora has no
  host world entities (her percepts come from her senses), but a host with a
  heartbeat entity would accrete ~86k episodes a day, forgotten over ~3.
- Host-supplied social signal types that persist in state (`message`, `action`,
  …) are re-perceived every tick; only `conversation.received` is swept.
- An observation episode is embedded by its ≤100-character sense label, not its
  data — recall by meaning of what she read is P5.

### P3 — what she keeps is whole

- [ ] `semantic.engine/integrator.ts:73,652-656,722-726` belief store: past 500,
      every belief under 0.3 is deleted, then the rest cut to 500. (Decay and the
      0.12 prune are MIND and stay.) `:599` history per belief kept to 20
- [ ] `known.entity.tracker.ts:210` people past 50 forgotten by count;
      `reputation.tracker.ts:94` (20); `theory.of.mind.ts:82` (10)
- [ ] `bias.detector.ts:348,354` evidence 10, biases 15; `introspection.engine.ts:127,152`
      history 30; `autobiographical.narrator.ts:163,213` themes 10, pivotal events 20
- [ ] `memory/vector.adapter.ts:83,287-294` evicts ~10% of the semantic index at
      10,000 episodes — evicted memories stop being recallable by meaning
- [ ] **The artifact:** `pma/index.ts:449` beliefs 50, `:475` goals 10, `:593`
      relationships 20, `:1092` emotional bio read from the last n log lines;
      `agency/competence.codec.ts:40,65` skills 50
- [ ] `stem/guards/identity.guard.ts:150-152,177` values past 12 and style past 200
      are truncated with a warning — reject instead, like the prompt limit does
- [ ] `stem/tracts/transport.controller.ts:42,100` drops the oldest un-acked outbound
      envelope past 1,000; `surface/host/utterances.ts:15` drops past 50
- [ ] `cognition/event.log.ts:22` in-memory ring 10,000 — verify the disk copy is whole

### P4 — the operator's record is whole

- [ ] Session log: `engine.ts:1148` reasoning 1,000, `facet.ts:580` 500,
      `engine.ts:1115`/`facet.ts:556` response excerpt 600, errors 200/300,
      `spaced.repetition.ts:523` statement 100, `outbox.writer.ts:163-164` +
      `proactive.communicator.ts:249-250` messages 300 / preview 100
- [ ] Provider error bodies `llm/index.ts:792,983,1022,1063`, `host/boot.ts:164` (300)
- [ ] Logger lines that quote content (80/120/60): outbox, proactive, audition,
      reafference, planning — whole
- [ ] `core/metrics.ts:96` debug flush shows 10 points — show all

### P5 — each call lossless, not unbounded

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

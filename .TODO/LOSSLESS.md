# LOSSLESS — nothing the mind takes in, thinks, says or keeps is cut

> **Standing:** DESIGNED · 2026-09-30 · scoped from a trace of every cut in `src/` (281 sites read, 64 of them comments); P0 of 6 landed, unreleased

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

### P1 — what she thinks is whole, in transit and in record

- [ ] Bus payloads: `commands.ts:308` (400), `:325` (200), `engine.ts:1339` (600),
      `engine.ts:1640` facet-sync body (400) — the tract #160 built to carry "what
      it concluded" still clips it
- [ ] `facet.ts:365` master-sync history entries (400), `:594` facet reasoning
      history (400) — whole (the counts, 5 and 10, are P5)
- [ ] `commands.ts:213` **drops every new goal after the second**; `:245` **drops
      every self-observation after the fifth** — the mind's own output discarded
- [ ] `goal.manager.ts:599,608,617` abandon reason (200); `planning.engine/engine.ts:690,706`
      outcome (300); `plan.supervision.ts:395,424,483` reasons (100/120)
- [ ] `llm/summarizer.ts:75,125` — reasoning cut to 600 before it is summarised
      into `## Memory Continuity`
- [ ] `autobiographical.narrator.ts:157,203` — the life story keeps its LAST 5,000
      characters: her beginning is deleted as she lives. `:208-209` episode 150
- [ ] Output ceiling: no provider stop reason is read, so a response that hits
      `maxOutputTokens` (default 8,096) is cut mid-JSON and parsed as if whole.
      Read the stop reason; never silent. (Never hit yet: max 3,171.)

### P2 — what she takes in is whole

- [ ] `surface/channels/types.ts:52-54,114` attachments: 24,000 chars, 4 files;
      `discord.ts:42,402` fetch cut at 256 KB — whole (oversize → P5 paging)
- [ ] `exteroception.ts:101,158` **drops percepts past 50 per tick**;
      `social.perception.ts:100,133` past 20 — nothing dropped at the door
- [x] ~~`episodic.consolidator.ts:734-745` prefix dedup~~ — landed in P0
- [ ] `semantic.engine/integrator.ts:566-580` episode content 150 in pattern text
- [ ] `semantic.engine/clustering.ts:429,435` pattern detection reads the first 20
      episodes / 10 words — verify whether this is a sampling window (MIND) or a
      cut of what it was asked to analyse (LOSS) before changing it
- [ ] `bus.ts:89` metric queue drops the oldest past 500 — count and surface every
      drop before deciding whether the bound itself goes

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

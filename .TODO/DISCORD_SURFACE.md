# DISCORD_SURFACE_TODO — a Will present in a server, not merely connected to one

> **Status:** 🟡 **P0–P1 LANDED (2026-08-11), P2+ OPEN.** *(Was a bare "OPEN";
> refined 2026-08-21 during the SIGNAL_BOUNDARY audit.)* P0 (the room stops being
> an id) and P1 (reactions are answers) are live. **The open half is confirmed by
> live evidence:** a COO's Discord world is only the people who have spoken to her
> — no member list, no ban list, no roles — so `inspect` returns a member *count*
> and never a roster. Given moderation abilities against that world she asked to
> unban the one person who talks to her, twice. See
> `.TODO/SIGNAL_BOUNDARY.md` and the sense-boundary limit it records.
>
> Original goal: give a Will the same insight into a
> Discord server that a person gets from the app — where it is, who is there, what
> the room is for, what it may do — and **hands**, so presence is not only receptive.
>
> Companion reading: `AGENCY_PIPELINE.md` (the competition these abilities enter),
> `../docs/graphs/identity-and-route.svg` (rooms are already referents),
> `../docs/graphs/answered-loop.svg` (what counts as being answered).

---

## Context: what exists today (audited 2026-08-11)

**The whole of what a Discord message tells her** (`surface/channels/discord.ts`,
the `will.sense` call):

```ts
{ text, from: 'discord:<userId>', thread: 'discord:<channelId>', direct: isDM, speaker }
```

Five fields. A channel is an **opaque id**: she has never known that
`discord:1531261362838441996` is called `#general`, what its topic is, who else is
in it, or that a *server* exists above it. She has been answering messages from
inside a room she cannot see.

**Three seams already exist and are starved rather than missing.** This matters for
scoping — most of the work below is feeding machinery that is already built, not
building it.

1. **A room is already a referent.** `known.entity.tracker.ts:318` creates a dossier
   for `enc.thread` on any non-direct encounter. `kind` is derived from the percept
   domain (`SENTIENT_DOMAINS.has(domain) ? 'sentient' : 'thing'`), so a room resolves
   to a `thing` with familiarity, reliability, and handles — no ontology change is
   needed to let her know places. It has a dossier and nothing to put in it.

2. **A pull-to-know already fires.** `drive.curiosity_resolve` is
   `familiarity × (1 − resolutionConfidence) × curiosityGain`
   (`known.entity.tracker.ts:420`). A referent she has met often but cannot identify
   *already* generates a drive. This is the progressive-discovery mechanism; it does
   not need inventing, it needs a name to be curious about.

3. **Abilities already route through the competition.** `EffectorDeclaration[]` →
   `externalSchemas()` → `MotorSchema` → `AffordanceSynthesizer` → the same scoring
   every other act faces. And `PolicyArbiter` (`effector.controller.ts:119`) already
   turns a refusal into something the mind learns from
   (`tests/conformance/denials-that-teach.test.ts`). Discord's permission bits belong
   *there*, not in a new gate.

**What is genuinely absent:** server/channel identity, membership, roles,
permissions, history, reactions, threads, pins, presence.

---

## The defect this starts from

A **reaction is an answer, and she reads it as silence.**

`conversation.received` is written only for text. 0.9.0 made a message learn whether
it was answered, and routes an unanswered turn into reputation as reliability
(−0.06) and into goals as *absence* of progress. So today, when someone replies to
her with 👍 — the single most common acknowledgement on Discord — she records no
answer, waits out the reply window, concludes she was ignored, and revises that
person downward.

The machinery shipped in 0.9.0 is working correctly on a false premise. This is P1
and it is small.

---

## Principles this follows

- **Build cogs, not behaviours.** Structure arrives as *percepts and affordances*.
  There is no "Discord tool API" she calls and no rule that says when to use it.
- **The container is rented.** The bridge supplies the *mechanism* (what is possible
  here); the deployer supplies the *policy* (what this tenant may do); the persona
  supplies the *value* (whether she wants to). Three different owners, never merged.
- **A permission is availability, not a wall.** `scoreAffordance` already multiplies
  a positive score by `availability`. An ability she holds but cannot use *here*
  should score low and stay **visible**, so she knows she cannot post in
  #announcements instead of trying and failing invisibly.
- **Everything known competes for prompt space.** Each phase must answer two
  questions separately: *what does she SEE* (rendered into the prompt) and *what does
  she merely HAVE* (in state, recalled on demand). Getting these the same way round
  is how a server map blows the context budget.

---

## Progressive discovery — the shape of P2

**Decided 2026-08-11: she is not handed the member list.** She meets a server the way
a person does.

Walking into a room, you see *that it is crowded* long before you learn who anyone
is. So:

- **The room carries a count, not a roster.** "47 people here" is a property of the
  place dossier — one number, one referent. It is not 47 dossiers.
- **A person becomes a referent on encounter.** Speaking, being mentioned, being
  replied to. This is what already happens; it needs no change.
- **A name heard is familiar but unresolved** — which is precisely the input
  `drive.curiosity_resolve` was built for. Someone referred to repeatedly whom she has
  never met generates a genuine pull to find out who that is.
- **That pull discharges into an act.** A `look-up-member` affordance lets her resolve
  a name *deliberately*, and lose the competition to something more pressing. Enacted
  curiosity, not a lookup table.

This keeps the dossier budget bounded by attention rather than by server size, which
is the only bound that survives a 500-member guild. It also means her knowledge of a
server has a **history** — she knows the regulars because she met them — and that is
the thing worth persisting into the PMA.

---

## Hands

**Decided 2026-08-11: she gets them, starting now.** The default is *what a person can
do in Discord*; the deployer narrows it.

This deliberately breaks a promise the README currently makes — "the bridge grants no
tools — it is a mouth and ears, not hands." That line must change with P3, not quietly
become false. (See `RELEASE.md` §0: the README is now a pre-flight item precisely
because this kind of drift is invisible.)

Three owners, kept apart:

| Layer | Owns | Mechanism |
|---|---|---|
| Bridge | what is *possible* on Discord | `EffectorDeclaration[]` |
| Deployer | what this tenant *may* do | config allowlist → which declarations are wired |
| Discord | what is *permitted here* | permission bits → `availability` + `PolicyArbiter` |
| Persona | whether she *wants* to | the competition, unchanged |

Candidate abilities, roughly a person's: reply-in-thread, react, edit-own,
delete-own, create-thread, pin, set-nickname, read-history, look-up-member. Voice is
out of scope.

---

## Phases

| | Phase | Delivers | Cost / risk |
|---|---|---|---|
| **P0** ✅ | The room stops being an id | `threadName` → the place dossier gets a name | **Landed 2026-08-11.** Topic deferred — see below |
| **P1** ✅ | Reactions are answers | `messageReactionAdd` on her own messages → `conversation.received` | **Landed 2026-08-11** |
| **P2** | She meets people | count on the room; referents on encounter; `look-up-member` discharging curiosity | Dossier budget; needs `GUILD_MEMBERS` (privileged) |
| **P3** | She has hands | ability declarations + deployer allowlist; README correction | Product surface change; policy wiring |
| **P4** | She knows what she may do | permission bits → `availability`; denial → percept | Depends on P3 |
| **P5** | History | backfill on join / on first sight of a channel | **Largest.** Token and memory cost; needs a recall story, not a dump |
| **P6** | The long tail | pins, edits, deletes, presence, voice awareness | Mostly additive once P0–P4 land |

P0 and P1 are independent of everything and of each other. P4 depends on P3. P5 is
the one that can go wrong quietly.

---

## Carried out of P0

- **A channel's TOPIC has nowhere to live.** P0 delivered the room's *name* because
  `KnownEntity` has a `name` and nothing else a description fits. "What is this
  channel for" is the more useful half and needs a new dossier field, which
  persists into the PMA — additive but not free. Worth doing as its own step
  rather than smuggling into a naming change.
- **Rooms and people share six slots.** `extractKnownEntities` sorts by recency and
  caps at 6, and an active channel is always recent. Rooms were *already* competing
  there (rendering as "something"), so P0 changed nothing about the pressure — but
  it makes the pressure visible, and P2 will make it worse. Decide the split before
  P2, not after.

## Open questions

- **Privileged intents.** `GUILD_MEMBERS` (P2) and `PRESENCE` (P6) require Discord's
  approval past 100 guilds. Decided 2026-08-11 to apply and see. Until granted, P2
  degrades to encounter-only discovery — which is the design anyway, so the fallback
  is honest rather than crippled.
- **Prompt budget.** No phase past P0 should render its whole content. What is the
  recall path for "who is in this server" and "what happened in this channel before"?
  Probably the existing vector recall, but that needs deciding, not assuming.
- **Pruning under P2.** `maxTracked` prunes by familiarity. A burst of one-off posters
  must not evict someone she talks to weekly. The current rank is
  `(name?1:0) + resolutionConfidence + familiarity`; verify that holds under guild
  load before shipping P2.
- **Multi-guild identity.** `discord:<userId>` is already stable across guilds, and
  0.9.0 anchors it. Confirm a person met in two servers is one referent with two room
  handles — it should be, by construction, but it is untested.

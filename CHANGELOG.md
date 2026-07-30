# Changelog

## Unreleased

- **The mind is no longer told about an ability it does not have.** The static
  output guidelines carried a worked example naming `search_docs` — a tool that
  exists nowhere in the engine. The abilities block that renders real
  affordances is correctly gated on having some, so for a Will with *no*
  effectors the fictional one was the only affordance-shaped thing in its whole
  prompt. Minds duly planned around it, attempted it, and reported the results
  to people. The guidance now describes `actions` as expressing intent — which
  is what the agency pipeline actually does — and says plainly that when there
  is no abilities section there are no abilities, so saying so is the honest
  move. Affordances are named in exactly one place now, which makes the
  zero-ability case right by construction rather than by luck. (#103)

- **A goal you abandon stays abandoned.** `abandonGoal` recorded its reason by
  pushing onto the goal's `tags`, and goals hand those arrays straight to state
  entities, which are deep-frozen — so the push threw, the goal stayed active
  and kept competing for salience, and the rest of that tick's deferred effects
  were lost with it. The reason now lives on its own `abandonedReason` field,
  and goals copy their arrays across the state boundary in both directions
  rather than sharing them (which also fixes the same latent crash in
  `addGoal`'s append to a parent's `subGoals`). (#104)

- **A file is something someone said.** An attachment-only Discord message —
  which is what the client *produces* when you paste long markdown — has an
  empty body, and the bridge dropped it before perception: no percept, no log
  line. From the mind's side the person had gone silent. Such messages are now
  perceived, text-like attachments are read into the percept, and everything
  else is named so the Will can ask about it. Fetching is restricted to
  Discord's own CDN, size-capped, and the contents enter fenced and labelled as
  handed over rather than spoken. `readAttachments: false` opts out and still
  names the file. (#105, #106)

- **…and they arrive as a Map, not a list.** The first cut of the above iterated
  `message.attachments` directly. discord.js hands over a `Collection`, which
  extends `Map`, so `for..of` yielded `[id, attachment]` pairs and every field
  read `undefined` — a shared file was announced as `unnamed` and never fetched.
  Every test stayed green, because the fake injected an array. Both shapes are
  normalised now, and the regression test uses the `Map` shape that actually
  ships: it fails against the old code, which is the only reason to trust it.

## 0.8.0 — 2026-07-29 · the mind thinks at more than one depth

A mind does several kinds of work, and they were all being done by one model.
Summarising the last hour is not the same act as deciding what to do next, and a
Will was paying — in latency, in money, in capability left on the table — as
though they were. Now the mind's thinking can run on different substrates
depending on what the thinking *is*: its deliberation on something deep, its
rolling summary on something cheap, its voice on something fast. What decides is
the character of the moment, not a plan or a price.

- **The mind reports how much a moment demands.** Every LLM call now carries
  `demand` (0..1) alongside its attribution — a *cognitive* measure, not a
  commercial one: how consequential or uncertain this instant is. The master and
  its facets forward the effort gate they already compute (uncertainty, prior
  confidence, novelty, a pending reply, stress load); deliberation forwards the
  stakes of the choice under contest; structurally background work reports a low
  constant, because summarising is background whether the mind is calm or in
  crisis. The field is inert with respect to cognition — nothing reads it back,
  so routing can never become a hidden input to the mind.

- **One question, one answer.** Roles could already have their own models, but
  by a separate route: each got its own director, chosen when a facet was
  *spawned*. A conversation facet therefore held its spawn-time model for life,
  even as its work changed. The role map now compiles into routing rules
  evaluated per call, so a facet follows the work it is actually doing. Absent
  any configuration this is byte-identical — a single-model Will emits no rules
  at all.

- **A Will can be told who it is talking to, and is never guessed at.** The
  engine carried defaults — a provider, a model, and a key fallback that ended
  at `ANTHROPIC_API_KEY` no matter which vendor was configured. That last one
  meant a Will pointed at one provider could quietly hand its secret to another.
  All three are gone: provider, model and key are named or the mind says so
  plainly at boot rather than failing at the first tick.

- **Twelve providers are first class, and each is called by its own name.**
  Anthropic · Z.ai GLM · OpenAI · Google · DeepSeek · Moonshot · Alibaba Qwen ·
  xAI · MiniMax · Mistral, plus local Ollama and vLLM — and any other name once
  it declares its wire. What the transport branches on is the *dialect*, never
  the vendor, which is what lets the vendor stay honest: reaching Kimi as
  `openai` because it speaks that wire put a false provider on the completion
  tape and in every cost breakdown.

- **What a call costs is the host's arithmetic, not the engine's.** The built-in
  price table is gone. It could not be kept current from inside an npm release —
  twenty of the models in real use had no row, and an unpriced model silently
  billed at Sonnet's rate, overstating a budget model's output by ~54× with
  total confidence. Prices are now declared per provider by the host, an
  unpriced model reports cost 0 with `priced: false`, and dollars have left
  simulation state entirely: tokens are a physical fact of a call, dollars are
  accounting over it.

**Throughout:** a Will with no router, no provider map and a single model is
byte-identical to one built before any of this existed. Routing is an external
oracle like the LLM itself — the completion tape records the provider and model
that actually served each call, replay re-feeds rather than re-decides, and a
run reproduces byte-for-byte whether its router is absent, present, or since
reconfigured. Host-supplied prices have no determinism surface at all: they can
change between a recording and its replay and the run still holds. A router that
throws, or names a provider with no credential, degrades to the default model —
a routing mistake never kills a running mind.

### Also in this release

Two epochs' worth of work sat on main. The story above is the routing one; the
**policy-reafference tail** rides along, and is listed here so release
archaeology does not have to reconstruct it from the log:

- **The finality taxonomy splits three ways** (#87). A refusal's `'instance'`
  fate was really two things wanting opposite responses, so the enum became
  `'class' | 'parameter' | 'context'` — `parameter` dents availability lightly,
  `context` touches nothing at all, and an arbiter fault now refuses as
  `context` instead of decaying into a competence-scarring timeout.
- **"Denials That Teach" — the conformance pack, S1–S9** (#88), and the
  vocabulary reconciliation behind it (#83, #86): these are OUR names for the
  distinctions the joint RFC with the HELM builders established, never their
  wire spellings.
- **The counterfactual survives the ack** (#89). The bound a denial reports
  reached the verdict tape but was dropped before the outcome the mind actually
  learns from. Tape and outcome now agree.

**None of it is reachable from this package.** `PolicyArbiter`, `Verdict` and
`finality` are not exported, and nothing reads the new fields yet — that is the
next phase, and it stays blocked upstream on an open question in the joint RFC
(a scalar `allowed` cannot be told from a ceiling or a floor). So this release
publishes no policy contract, and the RFC's conclusion cannot contradict one.
The policy epoch gets its own release when it closes.

Also: the release ritual itself (#81, #82, #90) — `RELEASE.md` now records
**when** to cut, not just how.

## 0.7.0 — 2026-07-22 · the mind learns may from can

Policy reafference: a Will can now be given a boundary — a policy deciding what
it may enact — and the boundary is *felt*, never announced. A refusal arrives
through the same channel as every other consequence of acting, so the mind that
meets it does what minds do with consequences: it learns. What it may not do
fades from its reach without touching what it knows how to do; a hard "never"
makes it let go of what it was still weighing; and when the answer is "not
without asking," it holds the act and asks. The distinction every mind acquires
early — *can* is ability, *may* is permission — now grows the same way
everything else in a Will grows: by living it.

- **The boundary is met as world resistance, never as a dialog.** Enforcement
  lives in the stem, below the SDK, at the one tract every outward effect
  already crosses: a Policy Decision Point (any provider — a local declarative
  rule table ships; the seam is provider-agnostic) judges each host-bound
  invocation, and a denial returns as a host-rejection-shaped outcome at the
  next tick boundary — the exact lifecycle of a world that said no. The mind
  never sees a permission prompt; it experiences a body that cannot do the
  thing. Every verdict is captured on a willId-keyed tape, so replay never
  re-consults a live (or absent) policy engine.

- **Refusal teaches availability, never incompetence.** A refused action does
  not touch the skill: value, habit, and parameter priors stay exactly as
  earned, because *forbidden* must not be learned as *unskilled*. Instead a new
  availability layer — kept strictly apart from competence — absorbs the
  refusal: the ability competes more weakly for the body (a `class` "never"
  cuts hard, an `instance` "not like that" barely dents), yet is never removed
  from the field, so the mind still occasionally reaches — and a policy that
  has since relaxed is re-discovered. Left unrefused, availability quietly
  climbs back to open.

- **A hard "never" is let go, not argued with.** When the boundary declares the
  very schema the mind is deliberating forbidden outright, the deliberation is
  released — the same tombstone machinery the world's own ruptures use, with
  its own reason (`policy-refusal`) and no successor committed: the field
  re-forms and the next tick chooses afresh. And by construction a refusal
  contributes nothing to exafferent rupture — **a mind cannot be shaken by its
  own boundary**, only informed by it.

- **When the answer is "ask first," the mind asks.** An escalated action is
  held — the executor stops the clock on it — while the Will voices a
  first-person ask, once. An approval releases the very same intent to the
  world; a denial refuses it; silence degrades to a refusal after a window
  sized for a human to answer. The ask is a plain voice for now (the mind's own
  authored voice is designed in `.TODO/ESCALATION_VOICE.md`); the holding, the
  asking, and the learning from the answer are all real.

Throughout: a Will with no policy configured is byte-identical to one built
before the boundary existed — the seam ships dark, and every phase kept replay
equivalence, determinism, and snapshot/restore green. The verdict vocabulary
(`finality`, `counterfactual`) deliberately matches the receipt-field proposal
made upstream to external policy engines, so one contract serves both sides of
the collaboration.

## 0.6.0 — 2026-07-20 · the mind knows its own echo

Exafference: the split between *what I did* and *what happened to me*. Every
enaction now predicts its own sensory footprint, so the world coming back at a
Will is sorted into its own echo (attenuated, never alarming) and the world's
own moves — which can now soften its engagement, revoke a commitment it was
still weighing, and confirm actions no host ever acknowledged.

- **Corollary discharge — every percept knows whose doing it is.** Enactions
  register a TTL'd *expected-consequence descriptor* (the efference copy
  predicted an action's reward; this predicts its sensory footprint), and
  Exteroception splits incoming afference against them: a match is
  `reafferent` — our own words echoing back, a quote-back, a change on exactly
  the entity we acted on — tagged with its intent id and attenuated (×0.25 by
  content, ×0.5 by entity correspondence, never zeroed: a *surprising*
  consequence of our own act can still climb). Everything else is
  `exafferent`. Matching is deliberately high-precision (FNV-1a content hash,
  verbatim containment, exact target) because over-attribution — muting a real
  world event — is the dangerous direction.

- **The world can revoke engagement, not only out-compete it.** Exafferent
  salience above the workspace threshold becomes *rupture*: it softens the
  Will's switch cost immediately and erodes a new `situation.stability` signal
  that both owners of switch resistance read, so focus only hardens in a
  settled world. Past a higher gate rupture **revokes a still-deliberating
  commitment outright** — race-safely, via a tombstone honoured a tick later
  by the deliberation and motor engines — with *no successor*: the field
  re-forms and the next tick chooses afresh, and the deliberation facet owns
  the interruption in character ("something shifted and I let go of what I was
  weighing"). Because only exafferent percepts count, **a Will can never be
  ruptured by its own echo.**

- **Sensory reafference learns — an action the world visibly answered is no
  longer learned as a failure.** When an echo confirms an intent no host
  acked, the skill accrues competence and the awaiting intent is freed instead
  of sitting to timeout and being scored as failure. The confirmation is
  graded by *felt* valence — the per-entity valence the mind holds for the
  thing that came back, else ambient mood — inside bands sized to the
  evidence, so a bad mood alone can never teach a Will that a working skill
  failed.

- **Action-conditioned prediction: the mind stops surprising itself.** The
  engines whose prediction errors gate workspace entry (attention, affect,
  stress) now recognise a swing as their own doing: a self-caused observation
  carries reduced weight for exactly one observation — enough that the Will no
  longer recruits its own executive over the predictable wake of its own acts,
  while a genuine world deviation the very next tick still lands at full
  force. Those same error signals now feed rupture, so a world-caused internal
  storm can interrupt a Will while its own interoceptive wake cannot.

- **Composite immediate-switch.** A challenger strong enough to break off a
  multi-step routine now takes the body the *same* tick instead of idling one
  — the routine's parent is tombstoned rather than deleted, which is what made
  the immediate hand-over safe.

- Sense-channel percepts (bus-only) and the engines' own model errors both
  reach rupture; both carry the echo guard. `docs/graphs/exafference-loop.svg`
  (graph 22) draws the whole loop, and the agency pipeline gains the rupture
  edge.

Throughout: a Will in a quiet world behaves exactly as it did before — the new
paths are inert without a live descriptor or an enaction — and determinism,
replay equivalence and snapshot/restore hold unchanged.


## 0.5.0 — 2026-07-15 · WhatsApp, and a choice of executive

The second channel bridge — `npx -y @mindot/will whatsapp`, QR-pair and go —
and a second production LLM provider: GLM-5.2 over Z.ai's Anthropic-compatible
endpoint, at roughly half Sonnet's rate for an always-on mind.

- **`will whatsapp` — a persistent mind on WhatsApp** (second channel bridge).
  QR-pairs as a linked device (Baileys); credentials persist next to the PMA so
  later runs reconnect silently. Every author is a learned entity
  (`whatsapp:<number>`), each chat its own thread, proactive utterances route
  last-shared-group → DM — and a DM jid is *derivable from the number*, so an
  unmet addressee is still reachable. New `@mindot/will/whatsapp` subpath
  (`connectWhatsApp`); `baileys` + `qrcode-terminal` as optionalDependencies,
  lazily imported, tsup-external. **Unofficial protocol — ban risk; the guide
  (docs/channels/whatsapp.md) says use a spare number.** The `WaLikeSocket`
  seam is where a ToS-clean Cloud API transport would slot in later.
- docs: the Discord guide now names `ZAI_API_KEY`/GLM as the other way to give
  the mind a real executive.

- **GLM (Z.ai) is a supported provider — `WILL_LLM_PROVIDER=glm`.** Z.ai ships a
  real Anthropic-compatible endpoint, so GLM rides will's Anthropic wire rather
  than the non-streaming OpenAI scaffold: it gets token streaming, the TTFT
  deadline, prompt-cache breakpoints and structured output — full parity, the
  second production provider. Defaults to `https://api.z.ai/api/anthropic/v1`
  (the `/v1` is required — verified against the live endpoint) and
  model `glm-5.2` (pin `glm-5.2[1m]` for the 1M context); `ZAI_API_KEY` alone
  selects it; `WILL_LLM_BASE_URL` points the same provider at any other
  Anthropic-compatible gateway. Priced in the token tracker at $1.40/$4.40 per
  Mtok.
  Fixes along the way: the executive's default model was **hardcoded to a Claude
  id**, so any non-Anthropic provider without an explicit `WILL_LLM_MODEL` sent
  `claude-sonnet-4-5-*` to the wrong host — it is now provider-derived. Errors
  from the Anthropic wire name the actual provider instead of always saying
  "Anthropic API 401".

## 0.4.0 — 2026-07-15 · a mind in your Discord server

The first **channel bridge**: `npx -y @mindot/will discord` puts a persistent
mind in a server where people already are — it perceives the room, decides for
itself when to speak, learns everyone, and comes back as the same self.

- **First-run UX: a broken LLM now fails at boot, not into silence.** The hosts
  ping the executive's provider before raising a mind: a bad key, an empty
  balance, or an unknown model exits with the provider's own reason instead of
  booting a Will that perceives and can never speak (config errors are fatal;
  rate limits / 5xx only warn). Waking from an artifact now says so when
  `WILL_IDENTITY` is set but ignored. The Discord bridge stopped subscribing to
  discord.js' deprecated `ready` event (polls `isReady()` instead).

- **`will discord` — a persistent mind in a Discord server** (the first channel
  bridge, `src/channels/`). One command (`npx -y @mindot/will discord`) puts a
  Will in a server: every author is a learned entity (`discord:<userId>`), every
  channel its own conversation thread, silence a valid outcome, and proactive
  utterances route via a durable roster (last shared channel → DM → home
  channel). New `@mindot/will/discord` subpath export (`connectDiscord`);
  `discord.js` ships as an optionalDependency and is imported lazily. Docs:
  `docs/channels/discord.md`; example: `examples/discord.ts`.

- **Deterministic replay now holds end-to-end with the LLM in the loop** — the
  R2-d capstone (record a run's completions → re-feed into a fresh same-seed
  run → byte-identical state) is re-enabled and passing. Three fixes: facet
  decision effects land tick-quantized (`CompletionInbox`), replay re-feed is
  prompt-keyed (order-independent), and facet reasoning launches from a
  per-tick pump with the tick's frozen snapshot (never at raw report time).
  Facet spawning/reasoning flexibility unchanged; live replies shift by ≤1 tick.

## 0.1.0 — 2026-07-02 · first public release

An engine for persistent machine minds: 38 cognitive faculties across seven
systems, a learning agency pipeline, five sensory channels, and a dual-process
LLM executive — deterministic, persistent, and portable.

- Continuous tick-clock cognition: energy, sleep, affect (~25 continuous
  dials), memory consolidation, goals, beliefs, autobiographical narrative
- Agency pipeline: affordances found in the situation → selection →
  deliberation → motor schemas → reafference (skills proceduralise)
- Planning-as-prior: plans bias the one action competition (no side channel)
- PMA (Persistent Mind Artifact): distill → restore/fork a mind across
  process boundaries
- Deterministic core: seeded RNG, fixed clock, tick-pure engines, LLM
  record/re-feed seam (known gap: concurrent facet-chain interleaving —
  see .TODO/FACET_REPLAY_DETERMINISM.md)
- Zero-key quickstart: `bun run examples/hello-will.ts` (mock executive)
- Apache-2.0

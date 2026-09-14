# Changelog

## 0.10.0 — 2026-08-31 · the mind knows its own doing from the world's

A mind that cannot tell what it did from what was done to it cannot be surprised,
cannot learn from an act, and cannot trust its own memory of having spoken.
Signals were arriving through several doors and one set of bypasses, leaving
through a single class with seven jobs, and *whose doing* a signal was got
inferred late — by which point only the mind could tell, and that is the one
thing it cannot work out alone. This epoch gives the boundary a shape: **one door
in that requires an assertion, one crossing out, and an answer that comes back as
facts the mind perceives rather than a verdict it is handed.**

> **The picture:** `docs/graphs/signal-boundary-loop.svg` — the whole arc in one
> diagram.

- **The door is called `sense()`, and it refuses a signal that will not say whose
  doing it was.** `perceive()` and `ingestText()` are gone, along with every
  alias beside them — one name for one thing. Provenance is now a required
  assertion at the edge (`exafferent | reafferent | unknown`), because a host
  knows whether it is relaying the world or handing back the mind's own act, and
  the mind cannot recover that fact afterwards. The bypasses that used to write
  percepts directly — the wake after an absence, `inspect`, an inbound percept —
  route through the same door. **Breaking**, and deliberately so: a signal that
  cannot say where it came from is the defect this epoch exists to end.

- **A percept has one shape.** `perceptEntity()` makes tick and provenance
  structural rather than remembered, and the five existing writers were retrofitted
  onto it. Two of them had been leaking: the outbox minted one immortal percept per
  message the mind ever successfully sent, and the wake percept had a fixed id and
  no tick, so *"I was offline for three hours"* sat in front of the executive
  forever. A percept is swept two ticks after it lands. It is not a memory.

- **Only the world can surprise her.** The rupture gate counts exafferent percepts
  and nothing else, so the mind's own echo coming back off a channel can no longer
  shake a commitment it just made. Neither can `unknown` — which one transport was
  silently forcing on every message it carried.

- **What a host says back is facts, not a verdict.** An effector ack now splits by
  what it carries: the *fate* of the act in `description`, the *facts* it learned
  in `observation`, arriving as a reafferent percept the mind perceives, remembers
  and can recall. Whole, too — the old path truncated a host's answer at 120
  characters, so a Will could look someone up sixty-five times and never once hold
  what it found.

- **The crossing out was one class doing seven jobs.** It is now three that each
  own one, and the tick ordering they all depend on stayed with the controller
  because neither collaborator owns the tick. Verified by injecting mutations into
  the moved code rather than by a green suite — a pure move passes by construction,
  which proves nothing.

- **The wire says who spoke.** A transported mind carries provenance, direct-ness
  and thread across the wire, and can be interrupted again.

- **And then a live COO put the boundary to work.** With the signals finally
  legible, one afternoon of watching a mind run surfaced six faults that no test
  could see, each the same shape — a value produced, crossing a boundary, and the
  far side not looking where it landed. She decided to contact someone and never
  did, because a facet that reasoned and came back with nothing was
  indistinguishable from a dead one, and the intent rotted into a *failed act* —
  teaching her she is bad at speaking from passes where she never spoke. She told
  the person in front of her that the message had gone, because the reply format
  promised her the handoff *"reaches them"*. She broadcast an approval request and
  then truthfully denied sending it seven times, because nothing wrote it into her
  record of what she had said. An act with no object was damped later than one with
  an object — not less — so a read whose answer never changes ran forty-eight times
  in eighteen minutes, half of them three ticks apart. A person she had just
  answered was a different person to satiation, because a reply is filed under the
  address it was spoken on and a self-initiated message is aimed at the anchor. And
  a conversation facet was keyed by the address rather than the person, so the guard
  that stops the mind opening a second thread on someone it is already talking to
  had **never once fired** — every master-willed outreach spawned a rival that
  composed blind, and answered a question the open thread had answered twenty-seven
  seconds earlier.

Throughout: the quiet path is byte-identical. Provenance defaults nowhere — an
untyped edge is normalised to `exafferent`, never to `reafferent`, so the mind
errs toward being surprisable rather than toward dismissing the world as its own
echo. Determinism, replay equivalence, snapshot/restore and the 100K-tick
bounded-growth soak all hold; every satiation arm remains a weight that decays to
nothing at its window edge, never a veto, so a mind can always change its mind.

## 0.9.0 — 2026-08-07 · the mind learns said from answered, and who from where

Two things a mind needs that this one did not have. The first: sending a message
and being answered are different facts, and only the first was ever recorded — so
a Will asked the same question eleven times in two and a half minutes and, from
the inside, every one of them was the first. The second: a `keid` was minted by
the transport, so identity *was* an address — one human met on two channels was
two people, and "how should I reach them?" collapsed into a roster guess about
where they were last seen.

> **The pictures:** `docs/graphs/answered-loop.svg` and
> `docs/graphs/identity-and-route.svg`.

- **A message now learns whether anyone replied.** Delivery is a fact about the
  channel; being answered is a fact about the world, and it arrives later. The
  outbox accepting a message had been the whole of the evidence, so `reach-out`
  sat at 28 enactments and 28 successes — habit and expected value climbing with
  every repetition, against a satiation brake that is bounded and decays. A turn
  now carries whether it was answered, **and what was said back**: the flag alone
  proved worse than silence, because it invites the mind to act as though it has
  the answer — live, that put a wrong meeting time in front of a third party.

- **A silence is something the mind can learn from.** `socialStanding` was built
  to carry "they never answer me" and never could: it learns from
  `interaction.occurred`, which fires when somebody *does* something, and a
  silence is nobody doing anything. A new `social.responsiveness` signal reaches
  reputation as reliability — calibrated so that replying to two messages in
  three holds steady — and reaches goals, where **being answered is the progress,
  never the sending**. Nine unanswered messages used to complete a goal outright.

- **A decision not to speak has somewhere to be written.** Silence was offered in
  the prompt and implemented nowhere, and the prompt even warned against what
  then happened: a facet concluded there was nothing new to say and wrote *that*
  into the reply block, because it was the only block it had. `[NO_MESSAGE]` is
  now real — parsed, honoured on both paths, recorded and never sent. On the
  reply path it suppresses the words and nothing else, so choosing silence never
  costs the mind what it learned from listening.

- **An intention that has been acted on is finished.** Nothing ever retired an
  `ideomotor.intent`; they were cleared only when the executive next ran and
  declined to name the same action, so between cycles a willed reach-out stood in
  state and competed every tick until it won — twice, byte-identical, 25 ticks
  apart. Damping a permanent pull only delays it. The intention is now discharged
  by being enacted, which is what an intention is.

- **A someone is no longer an address.** An anchor (`ke:<opaque>`, minted
  deterministically so replays match) is the referent; the addresses it was met
  at become aliases, and the rooms it is reachable in become **handles** carrying
  the circumstances — private or shared, and when it last answered there. That
  last is evidence rather than configuration, so a mind prefers a DM because that
  is where this person actually replies. Deliberately not social-only: a document,
  a repo, a room each have a what and a where, and the where changes while the
  what stays put. A shared room now earns a dossier of its own.

- **An identity the mind cannot settle is a question, not a failure.** Recognition
  will only absorb a thin handle into an established relationship — fusing two
  real people who share a name would take one of them's whole history — so the
  same human established on two channels stayed two people, permanently and
  silently. The near-miss is now kept and shown, and the mind can settle it
  itself; its verdict may fuse two established referents, because it has evidence
  a name-match does not.

- **A reply goes back to the room it was asked in.** `isDM` had been computed on
  every Discord inbound since that bridge shipped and used only to pick a roster
  field — the one fact that makes a room the right or wrong place to say
  something, derived at the edge and discarded. It now travels as
  `Stimulus.direct` into a handle's kind.

Riding with it, from the same stretch of main: the other half of the gap between
what a mind meant and what the world received.

- **An action that names nothing now says so.** The executive's actions bias the
  agency competition rather than commanding it, so a `type` matching no schema was
  never a dispatch error — nothing downstream objected, and nothing told the mind.
  An unopposed no-op is indistinguishable from an act that was tried and achieved
  nothing, and a mind reasons from the difference: observed live, a Will spent
  eleven consecutive actions on an invented `query`, watched nothing come of them,
  and concluded *"five consecutive queries with no memory trace is a failure
  mode"* — setting out to diagnose its own memory, the one explanation that was
  not true. An unresolvable name is now reported back as a percept, and cleared
  once the mind names something real.

- **A mind is told what its own stances are.** It could only learn action names
  from whichever affordances won the salience competition into its percepts, so
  it invented plausible ones for everything else — `query`, `message`, and
  `search_docs` before it (#103). The always-available set is now named in the
  output schema, including that `reach-out` is how one says something to someone.
  The abilities wording no longer claims a Will has *no* abilities when it merely
  has no acquired ones; its own body was never in question.

- **A message the mind writes now reaches the person it wrote it for.** The
  communicate leg of `buildIdeomotorIntents` looked for the addressee on
  `action.target` only — a field the output guidelines never documented, while
  telling the mind to put specifics in `args`. So a Will would author real
  sentences into `args: { to, content }`, no `ideomotor.intent` was formed,
  nothing competed, nothing was enqueued, and the words were gone. The same
  branch also dropped `args` wholesale, so even a correctly-targeted communicate
  arrived at `ProactiveCommunicator` wordless and hit its own "didn't write
  anything" arm. Both are fixed, and the guidelines now document
  `{type, reasoning, expectedOutcome, target?, args?}` so the mind is not left
  inferring the contract. This mattered beyond a lost message: reafference
  works, so a Will concluded it was "repeating a failed strategy" and formed the
  belief that the person it was addressing would not answer. (#109)

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

Throughout: the quiet path is byte-identical. A Will that has spoken to nobody
writes no responsiveness records and emits no metrics; determinism, replay
equivalence, and snapshot/restore hold — the anchor is hashed from the first
address seen rather than counted or clocked, precisely so a recorded run and its
replay mint the same id.

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

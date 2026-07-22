# Changelog

## Unreleased

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

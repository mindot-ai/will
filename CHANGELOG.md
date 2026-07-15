# Changelog

## Unreleased

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
  second production provider. Defaults to `https://api.z.ai/api/anthropic` and
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

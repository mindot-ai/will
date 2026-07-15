# Changelog

## Unreleased

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

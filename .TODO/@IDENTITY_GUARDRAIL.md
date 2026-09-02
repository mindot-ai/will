# Will — Identity / profile guardrail

> **Standing:** SHIPPED · 2026-07-02 · partial — Phase 1 and most of Phase 2 wired; the API boundary (`POST /v1/wills → 400`) and Studio surfacing are open. Pre-public: exact date not recorded

> **Status: 🟢 Phase 1 + most of Phase 2 wired.** A deterministic guard validates
> + sanitizes the operator-supplied persona at creation AND on PMA reload, with a
> capability cross-check, plus an optional semantic LLM coherence check. The API
> boundary (`POST /v1/wills → 400`) and Studio surfacing remain.

## Why (the trust boundary)

The persona (`identity.prompt` / `values` / `traits` / `style`) and a profile's
`context` are the **only** place untrusted, operator-supplied content is injected
into the heart of the Will — the executive **system prompt**, the **persona
prior**, and the **trait math**. Everything else the Will generates itself. So
this is the trust boundary, and bad content here doesn't just degrade output —
it can collapse the self-model the whole architecture exists to sustain.

Before this, the boundary was unguarded. The one guard that existed (stripping a
forged `## Who You Are` section in `prompt.factory.ts`) was **commented out**, so
a persona prompt could forge the prompt's own structural sections (`## Personality`,
`## Output Guidelines`, …) and hijack it.

The three failure modes:
- **Identity collapse** — empty/thin persona, generic style, or a prompt that
  fights the core grounding ("ignore your physiological state").
- **Collisions** — forged section headers; a custom effector shadowing an innate
  stance (silently un-enactable); out-of-range / non-finite trait values.
- **Hallucination** — claimed capabilities the Will lacks; classic prompt
  injection ("ignore previous instructions", "you are now…").

## Phase 1 — wired (this change)

- `src/stem/identity.guard.ts` — `validateWillIdentity(input) → { ok, errors,
  warnings, identityStrength, sanitized }`. Pure, deterministic. Three severities:
  - **error** (blocks creation): non-finite trait; custom effector ≡ an innate
    stance; prompt/context over the length cap.
  - **warning** (allowed, surfaced): thin/empty prompt, empty values, generic
    style, unknown trait key, clamped out-of-range trait, injection phrasing,
    low `identityStrength`.
  - **sanitize**: strip forged reserved-section headers; clamp traits to [0,1];
    trim + dedupe values/effectors; truncate over-long values/style.
- `mind.ts` calls it in `assembleMind` (after profile resolution): throws on
  errors, logs warnings, and seeds from the **sanitized** identity.
- Re-enabled the `prompt.factory.ts` `## Who You Are` stripper (defense-in-depth
  for PMA-template prompts that bypass creation).
- Test: `tests/unit/identity.guard.test.ts`.

## Phase 2+ — follow-ups

- **API boundary.** Call `validateWillIdentity` in `POST /v1/wills` so a bad
  config is rejected with `400` (and warnings surface in the create response /
  Studio) *before* a Will is created — not only as the engine-side safety net.
- ✅ **PMA-load boundary (done).** `PMAController.load` re-validates the artifact's
  identity through the same guard, so a stored/tampered PMA can't inject a
  collapsed/colliding/injected self on reload.
- ✅ **LLM coherence check (done, advisory + fail-open).** One cheap LLM review at
  creation — `src/stem/identity.coherence.ts`, exposed as
  `WillStem.reviewIdentityCoherence(input)`. Flags the semantic issues the
  deterministic rules can't: contradicting the architecture grounding ("you are a
  stateless assistant"), false-capability claims (vision / internet / total
  recall), and injected instructions. Returns `{ ok, ran, issues[] }`; an LLM
  error returns `ran: false` and never blocks creation, so the caller chooses
  whether `error`-severity issues are fatal. Parsing is robust (extracts JSON from
  prose, ignores malformed output). Unit test: `tests/unit/identity.coherence.test.ts`
  (fake reviewer). Live validation: `src/runners/coherence.runner.ts` — grounded
  persona → 0 issues; a persona that's stateless + claims screen/internet access +
  "ignore previous instructions" → 4 issues (1 contradiction, 2 false-capability,
  1 injection). Still OFF by default in the create path (costs a call); the API
  boundary will opt in.
- **Surface `identityStrength` in Studio** as a create-time signal, and let the
  warnings drive an "improve your persona" hint.
- ✅ **Capability cross-check (done, heuristic).** Flags a prompt that claims a
  sense the Will lacks (vision/smell/taste/physical-touch — shell senses), kept
  narrow to avoid flagging metaphor ("I see your point"). Could later be grounded
  in the Will's actual active sense set rather than a static list.
- **Per-field caps tuning.** The current limits (prompt 4000, context 4000,
  values 12, style 200) are conservative defaults — revisit against real personas.

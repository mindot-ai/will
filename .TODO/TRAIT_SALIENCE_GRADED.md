# Will — Graded trait salience (Channel B surfacing)

> **✅ COMPLETE (A + B + C, plus cross-session persistence).** Shipped in will#168
> (A — absolute intensity bands), will#170 (B — baseline-relative + C — recency), and
> will#171 (PMA persistence of the per-trait baseline/recency so the Will's *own norm*
> survives a restart). The binary gate is gone; the prompt now reads e.g.
> `conscientiousness (markedly high, above my norm, rising lately)`. Kept as dev
> documentation of the design + its cache/determinism rationale.

> How the Will's traits are surfaced to its deliberate self (the executive/facet
> system prompt). Today it's a **binary gate**; this doc designs a **graded /
> baseline-relative** replacement that reads more like how a mind actually knows its
> own character — *distinctive features, by degree* — without breaking determinism or
> the prompt cache.

---

## Today (the binary gate)

`executive.engine/prompt.factory.ts`, in `buildSystemPrompt`:

```ts
const notableTraits = Object.entries( identity.traits )
  .filter( ( [, v] ) => v > 0.6 || v < 0.4 )      // hard, symmetric cutoff
  .sort( ( [, a], [, b] ) => b - a )
// → "**Traits:** conscientiousness: 82%, impulsivity: 25%"
```

- **What's right:** personality *is* its distinctive features — surfacing only the
  tails (and omitting the unremarkable mid-band) is good signal economy, and it's
  genuinely mind-like. Critically, **only this Channel-B *surfacing* gates** —
  Channel-A mechanisms read the raw value continuously, so a mid-band trait still
  *acts*, it's just not yet *self-known*. (Continuous subconscious, thresholded
  awareness — keep this asymmetry.)
- **What's crude:** a hard binary in/out, fixed symmetric thresholds, no gradation
  (a 0.62 and a 0.98 trait read identically — "conscientiousness: 82%" with no sense
  of *how* defining it is), and no notion of *change* ("lately I've grown more …").

---

## Goal

Surface traits with **graded emphasis** ("strongly persistent" vs. "somewhat
impulsive") and optionally **relative to a baseline** (population default, or the
Will's own history / recent change), rather than binary in/out — while staying
deterministic and cache-friendly.

---

## Design options

### Option A — intensity bands (pure function of value) — ✅ DONE (will#168)
Shipped as `traitEmphasis(value) → { adverb, direction, rank } | null` in
`prompt.factory.ts`; renders `trait (adverb direction)` e.g. `persistence (strongly
high)`. Mid-band omitted; sorted by band rank then name (stable order); top-K capped
at `TRAIT_SURFACE_CAP`. ε on the lower edge keeps the boundary inclusive despite float
error. Map `|v − 0.5|` to a coarse adverb and a direction:

| band (deviation from 0.5) | surface | example |
|---|---|---|
| ≥ 0.40 (v ≥ .90 / ≤ .10) | "markedly" | "markedly conscientious" |
| 0.25–0.40 | "strongly" | "strongly persistent" |
| 0.10–0.25 | "somewhat" | "somewhat impulsive" |
| < 0.10 (mid-band) | omit | — |

- Pure, deterministic, **no new state**. Biggest readability win for least risk.
- Replaces the filter+map (~lines 198–204). Add a `traitEmphasis(value) →
  { adverb, surface } | null` helper; render `${adverb} ${low ? 'un'+trait : trait}`
  or keep the `name: NN%` form with the adverb prefix.
- Keep the top-K cap (sort by deviation, take N) so a many-trait Will can't bloat the
  prompt.

### Option B — baseline-relative (deviation from a reference) — ✅ DONE (will#170, persisted will#171)
Shipped as `normEmphasis(value, mean)` (`prompt.factory.ts`) → `above/below my norm`
past a coarse band, layered onto A. The reference is the **personal** baseline — a
slow per-trait EMA (`TraitStat.mean` on `identity-self`, computed by the self-model's
`_computeTraitStats`), **seeded from a population prior** so a fresh Will compares to
typical until it builds its own norm (both sub-options unified). Persisted through the
PMA (will#171) so the norm survives a restart. Express the trait relative to a baseline
instead of absolute 0.5:
- **Population baseline** (per-trait constant) — calibrates Will-vs-Will ("more
  agreeable than typical").
- **Personal baseline** (the Will's own running mean) — needs a per-trait mean stored
  in state, updated deterministically by sim-tick (R2-safe; the self-model already
  owns trait state, so fold it in there). Surfaces "above my own norm".

Heavier (new state) — only pursue if Will-vs-Will or self-relative calibration proves
worth it.

### Option C — recency-weighted emphasis ("lately…") — ✅ DONE (will#170)
Shipped as the `shiftDir` field of `TraitStat` → `rising/easing lately`, layered onto
A. A significant trait move at a self-model evaluation stamps the direction
(`_computeTraitStats`); it decays out of "lately" after `TRAIT_RECENCY_WINDOW`, checked
**only at evals** so it never churns the prompt between them.
Emphasize *recently changed* traits: "lately I've grown more persistent." The
self-model already emits `changeMagnitude` on `self_model.updated`; store per-trait
last-change tick + delta and let recent, significant changes earn a stronger phrasing
or a guaranteed slot. Deterministic via sim-tick. Pairs naturally with the persona-prior
self-tuning line already in the prompt ("how I've adapted my own mind").

**Recommended path:** A now (cheap, deterministic, no state) → layer C (reuse existing
self-model change signals) → consider B only if cross-Will/self-relative calibration
matters.

---

## ⚠️ Hard constraint — the system prompt is a cache breakpoint

`buildSystemPrompt`'s output is **the single Anthropic prompt-cache breakpoint** (the
master reuses it across ticks; every conversation facet shares one cached system
prompt — see the comment in `prompt.factory.ts`). If trait wording changed on *every*
tick with continuous values, it would **bust the cache constantly** (cost + latency).

Therefore graded emphasis must use **coarse, stable bands** — the rendered string
changes only when a trait *crosses a band boundary*, not on every micro-fluctuation.
This is why Option A is banded (not a continuous adverb) and why B/C must quantize.
**Never render a continuously-varying trait number in the system prompt.** (If finer
gradation is ever wanted, it belongs in the *user* message, which isn't the cache
anchor — but prefer keeping identity in the cached system prompt.)

---

## Acceptance — all met
- [x] Graded, banded emphasis replaces the binary gate; mid-band still omitted.
- [x] Pure + deterministic; replay-safe (B/C state derived from sim-tick on `identity-self`).
- [x] System-prompt string stable across ticks unless a trait crosses a band
      boundary (cache-preserving) — asserted in `tests/unit/trait-salience.test.ts`.
- [x] Top-K cap retained; prompt + self-model tests added/updated.
- [x] (Beyond original scope) per-trait baseline/recency persists across sessions via PMA.

---

*Spun off from the trait-surfacing discussion while wiring conscientiousness → planning.
See [TRAIT_CHANNEL_A_EDGES_TODO.md] for the complementary Channel-A (mechanism) work.*

**Implementation map:** `traitEmphasis` / `normEmphasis` + render —
`executive.engine/prompt.factory.ts`; per-trait `TraitStat` (baseline EMA + recency) —
`self.model.updater.ts` (`_computeTraitStats`, persisted on `identity-self`); context
threading — `executive.engine/context.ts` + `types.ts`; cross-session persistence —
`pma/index.ts`. Tests — `tests/unit/trait-salience.test.ts`,
`tests/integration/pma.eval.test.ts`.

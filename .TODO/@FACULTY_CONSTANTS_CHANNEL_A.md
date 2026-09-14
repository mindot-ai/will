# Will — Lift mechanism constants into the Channel-A developable layer

> **Standing:** SHIPPED · 2026-07-02 · partial by design — strong tier complete, medium tier all but two rows that are documented judgement-call skips, physiological tier deliberately fixed. Pre-public: exact date not recorded

> **Status: 🟢 Strong tier ✅ complete · 🟡 Medium tier ✅ mostly done (rules 28–30) with two
> rows deliberately deferred · 🔵 physiological tier intentionally left fixed.** The two
> Medium deferrals are documented judgement-call skips (redundant with edges already wired —
> `inhibition.arousalThreshold`/`maxDeferralsPerTick` overlap decisiveness #1; the extra
> `goal.manager` abandonment thresholds overlap grit), not pending work. Pick them up only
> if a concrete need appears.
>
> Across the faculties, many behaviours are governed by **hardcoded constants** (gains,
> rates, weights, thresholds) that *should* be driven by a personality trait and *develop*
> over the Will's life — exactly like grit, warmth, deliberativeness, and stability already
> do. This catalogues those constants and the trait that should drive each.
>
> This is **not** "delete heuristics" — these constants are the legitimate mechanism. The
> work is to promote the ones with a clear trait owner from a fixed literal into the
> `engine-config-*` + persona-prior layer so they become *developing dispositions*.

---

## The pattern (per the trait-edges doc — every entry is the same 4 changes)

1. **Seed** the constant as a param on the governing `engine-config-*` in `src/stem/mind.ts`.
2. **Read it live** in the faculty's `react` via `readEffectiveParams(state, 'engine-config-<faculty>')` (base ⊕ prior), replacing the literal.
3. **Develop it** — add a `PersonaConsolidator` rule: trait deviation → bounded delta.
4. **Surface it** — `persona.prior.ts` `PRIOR_DESCRIPTIONS` first-person line.

Self-model traits available: `conscientiousness`, `decisiveness`, `openness`,
`agreeableness`, `persistence`, `resilience`, `creativity`, `analytical`,
`emotional-stability`. (Adding a new trait — as we did for `emotional-stability` from
affect volatility — is itself an option where no existing trait fits.)

---

## 🟢 Strong — clear trait owner, real lever — ✅ **complete** (all rows wired)

| Faculty | Constant(s) | Trait → direction | Behaviour it would develop |
|---|---|---|---|
| ✅ `novelty.detector` | `significanceThreshold` | **openness** ↑ → lower (more sensitive) | notices novelty more readily (rule 20) |
| ✅ `reward.evaluator` | social-warmth boost (lifted the `·0.4` literal to `socialWarmthBoost`), `socialDecayRate` | **agreeableness** ↑ → bigger boost, slower decay | warmth from connection registers stronger & lingers — amplifies #6's `socialWeight` (rules 31–32) |
| ✅ `reward.evaluator` | `goalWeight` | **conscientiousness** ↑ → higher | goal-completion more rewarding — achievement-striving (rule 26) |
| ✅ `attachment.evaluator` | `attachmentGrowthRate` | **agreeableness** ↑ → higher (bonds faster) | grows attached more readily — altruism facet (rule 25) |
| ✅ `empathy.simulator` | `resonanceStrength` | **agreeableness** ↑ → higher | feels others' states more strongly — tender-mindedness (rule 24) |
| ✅ `stress.regulator` | `baseDecayRate` | **emotional-stability** ↑ → higher (sheds faster) | settles after stress sooner — recovery facet (rule 23) |
| ✅ `threat.evaluator` | `fearEventThreshold` | **emotional-stability** ↑ → higher (harder to alarm) | takes alarm less easily (rule 22) |
| ✅ `aesthetic.evaluator` | `aweThreshold` | **openness** ↑ → lower (more sensitive) | moved to awe by beauty more easily (rule 21) |
| ✅ `reputation.tracker` | `trustGrowthStep` (lifted the `+0.05` literal to config) | **agreeableness** ↑ → higher (trusts faster) | extends benefit-of-the-doubt more readily (rule 27) |

## 🟡 Medium — plausible trait, may need a judgement call

| Faculty | Constant(s) | Trait → direction | Note |
|---|---|---|---|
| ✅ `task.switcher` | `baseSwitchCost` | **conscientiousness** ↑ → higher (less distractible) | stays on task more — self-discipline of attention (rule 28) |
| `inhibition.controller` | `arousalThreshold` (0.6), `maxDeferralsPerTick` (3) | **decisiveness** / (inverse) impulsivity | `baseInhibitionStrength` already done (#1) |
| ✅ `moral.evaluator` | `eventThreshold` | **conscientiousness** ↓ → more morally self-evaluative | guilt/shame/pride register more readily — dutifulness (rule 29). Care/harm→agreeableness left open |
| ✅ `frustration.evaluator` | `decayRate` | **resilience** ↑ → higher (recovers faster) | shakes off a bad patch sooner — recovery facet (rule 30). `stuckThreshold`/`habituationRate` left (diminishing returns) |
| `goal.manager` | abandonment / re-prioritisation thresholds beyond grit | **persistence** / **decisiveness** | grit (`gritPriority`/`gritPatienceScale`) already done |

## 🔵 Lower priority / physiological — likely leave fixed

`circadian.oscillator`, `energy.regulator`, `sleep.pressure.regulator`,
`forgetting.curve`, `spaced.repetition`, `interoception`, `exteroception` — these model
biology/physics (rhythms, decay). A couple have a *thin* trait hook (e.g. memory
persistence ← conscientiousness via the forgetting curve), but most should stay fixed
unless a concrete need appears. **Guardrail:** only mechanize where a trait genuinely
*governs* the constant and a deterministic disposition is wanted — otherwise leave it.

---

## Guardrails (same as the trait-edges work)

- **Determinism (R2):** reads pure; deltas only from `consolidatePrior` (bounded + decaying).
- **Right faculty only:** wire a trait to the faculty it governs; note two-driver
  interactions where a constant already has a bias/operational driver.
- **Don't over-mechanize:** if soft in-character (Channel B) influence suffices and there's
  no need for a below-deliberation guarantee, leave the constant fixed.

*Companion to [__TRAIT_CHANNEL_A_EDGES_TODO.md] (the trait→faculty edges, now complete) and
[__HEURISTIC_CLEANUP_TODO.md] (the dead/distorting heuristic cleanup).*

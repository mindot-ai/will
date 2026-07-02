# Will — Trait → Faculty "Channel A" edges (the subconscious layer)

> A personality trait reaches behaviour through **two channels**:
>
> - **Channel A (subconscious / autonomic).** A faculty reads the trait as a *numeric
>   parameter* and acts on it mechanically every tick — no LLM, deterministic. The
>   Will does it *without deciding to and without knowing why*. (e.g. grit →
>   `goal-manager` abandonment timing; conscientiousness → `planning` follow-through.)
> - **Channel B (deliberate / aware).** The trait + its persona-prior self-tuning sit
>   in the executive/facet **system prompt** (`## Personality`), so the LLM reasons
>   *in character* — every notable trait colours planning/execution even with no
>   parameter behind it. (`prompt.factory.ts`, surfaced for master **and** facets.)
>
> Channel A is the missing half for most traits today. This doc lists the edges worth
> wiring, beyond the ones already done. **Mechanize a trait only where you need a
> deterministic disposition / there's a real lever; otherwise leave it to Channel B.**

---

## The established pattern (mirror this for every edge)

The machinery already exists end-to-end (`persona.prior.ts` mirror + `PersonaConsolidator`).
One edge = four small changes:

1. **Seed the base param** in `src/stem/mind.ts` on the governing `engine-config-*`
   entity (the PMA-seeded baseline; varies per Will).
2. **Read it live** in the faculty's `react`, via
   `readEffectiveParams(state, 'engine-config-<faculty>')` (base ⊕ persona-prior).
   Only override when the key is present; pure + deterministic (R2).
3. **Develop it** in `PersonaConsolidator._proposedAdjustments`: read the self-model
   trait (`identity-self.metadata.traits[...]`), push a bounded delta
   (`{ magnitude: dev, threshold, gain, engineConfigId, param }`). Above-baseline
   deviation only; `consolidatePrior` decays it back when the behaviour stops.
4. **Surface it** in `persona.prior.ts` `PRIOR_DESCRIPTIONS` as a first-person
   self-observation (closes Channel B: "I've become more …").

Self-model traits available (`self.model.updater._domainToTrait`): `conscientiousness`,
`decisiveness`, `openness`, `agreeableness`, `persistence`, `resilience`, `creativity`,
`analytical`, `emotional-stability`. Most form from per-domain task success rates;
`emotional-stability` is the exception — it forms from observed **affect dynamics** (a
slow EMA of negative affect sampled each tick in `self.model.updater`), then emitted as
an `emotional-regulation` assessment, so the same machinery turns it into a trait.

### ✅ Already wired
| Trait | Faculty | Param(s) | Direction |
|---|---|---|---|
| persistence | goal-manager | `gritPriority`, `gritPatienceScale` | grittier (exempt more, persist longer) |
| resilience | goal-manager | `frustrationTolerance` | don't give up faster when frustrated |
| conscientiousness | planning | `maxStepRetries`, `surpriseOutcomeQuality` | follow through on stuck steps; escalate sooner |
| decisiveness | inhibition | `baseInhibitionStrength` | commit with less hesitation (act more readily) |
| openness | attention, semantic | `shiftInertia`, `beliefStalenessThreshold` | shift attention more readily; re-examine beliefs sooner |
| analytical | introspection | `cooldownTicks` | introspect / reflect more often |
| openness + creativity | executive | `explorationRate` | explore / diverge more (two reinforcing drivers) |
| conscientiousness | executive | `impulsivity` | more impulse control (acts less impulsively) |
| emotional-stability | frustration | `irritabilityRate` | frustration snowballs into a bad mood more slowly |
| creativity | executive (dual-process) | ideation-pass `temperature` | diverge harder when proposing options (System 2) |
| analytical | executive (dual-process) | `deliberateThreshold` | engage System 2 (deliberate) more readily |
| agreeableness | reward | `socialWeight` | values social warmth / connection more (warmth facet) |
| agreeableness | frustration | `angerReactivity` | yields in conflict — less anger when wronged (yielding facet) |

---

## Recommended edges (prioritized)

### 🟢 Strong — clear trait, real existing lever — ✅ DONE

All three wired as consolidator rules 12–14 in `persona.consolidator.ts` (the target
params were already PMA-seeded, already read via `readEffectiveParams`, and already had
`PRIOR_DESCRIPTIONS` — so each edge was a trait-dev + rule addition only). See the
"Already wired" table above.

1. ~~**decisiveness → `engine-config-inhibition.baseInhibitionStrength` (↓).**~~ ✅
   A decisive Will commits to actions with less hesitation. Lever already exists and
   is already metacog-tuned (edge #6 raises it on recurring bias) — this adds a
   *trait* driver pulling the other way. Two-driver interaction (bias-caution vs.
   dispositional decisiveness) noted in rule 12's comment; both bounded/decaying so
   they compose into one auditable net delta. *Direction:* decisiveness↑ → inhibition↓.

2. ~~**openness → `engine-config-attention.shiftInertia` (↓) + `engine-config-semantic.beliefStalenessThreshold` (↓).**~~ ✅
   An open Will shifts attention more readily and re-examines beliefs sooner. Both
   levers exist; openness reinforces the existing belief-bias drivers (rules 4 & 8,
   same direction), additive and bounded. *Direction:* openness↑ → both↓.

3. ~~**analytical → `engine-config-introspection.cooldownTicks` (↓).**~~ ✅
   An analytical Will introspects more often / reflects more. Adds a steady
   dispositional pull on top of the event-driven bias driver (rule 2, same direction).
   *Direction:* analytical↑ → cooldown↓.

### 🟡 Medium — real trait, lever may need adding

4. ~~**creativity → exploration / idea-generation temperature.**~~ ✅ DONE
   Both halves landed. (a) The exploration half: creativity (with openness) develops
   `behavioralDisposition.explorationRate` (consolidator rule 15). (b) The dedicated
   divergence/temperature param — once **blocked** because the executive fused ideation +
   decision into one call (a global temperature would blunt decision quality) — is now
   clean: the master runs **dual-process** cognition (System 1 fast / System 2 deliberate
   propose→evaluate), so `creativity` drives the sampling `temperature` of the *isolated
   ideation (propose) pass only* (`ideationTemperature`, `effort.gate.ts`), exactly the
   "split first, then temperature on ideation" plan. The decision pass keeps the provider
   default — no bluntness. *Direction:* creativity↑ → propose temperature↑.

### Dual-process executive (DEV DOC — the foundation #4 rode in on)

The master reasons in one of two processes per tick, chosen **before** any LLM call:

- **System 1 (`fast`)** — the single-shot call. The default; routine ticks cost exactly
  what they always did.
- **System 2 (`deliberate`)** — a **propose→evaluate** pair: a *propose* pass generates a
  divergent candidate set (internal/non-streaming, elevated temperature), which is injected
  into a *decision* pass that streams + commits and retains `consideredAlternatives` (the
  explainability / future-regret substrate).

**Control structure — a-priori gate (escalation-ready).** `effort.gate.ts` `selectProcess`
is a pure, deterministic (R2) weighted scorer over signals already computed each tick
(epistemic uncertainty, prior-decision confidence, novelty, stress, pending message). It is
a *lazy* System 2 — engages reluctantly (needs corroborating signals), faithful to Kahneman.
Chosen over post-hoc escalation so we never stream an intuition we then override; the
deliberate path reports its own `confidence`, leaving a clean seam for a future
System-1→System-2 escalation.

**Two Channel-A trait hooks (effort/divergence as developing dispositions):**
- `creativity` → propose-pass sampling `temperature` (`ideationTemperature`, bounded
  `[0.6, 1.0]`) — closes #4 cleanly: temperature lives only on the isolated ideation call,
  never the decision call.
- `analytical` → `deliberateThreshold` (consolidator rule 17, develops it **down**) — effort
  allocation itself is a developing trait; a thinker deliberates sooner. Read as the
  effective (base ⊕ persona-prior) threshold in `reasonAsync`.

**Files:** gate `effort.gate.ts`; ideation schema/parse `types.ts` + `parser.ts`
(`parseIdeation`); prompts `prompt.factory.ts` (`buildIdeationFormatInstruction`,
`ideationCandidates` injection); orchestration `engine.ts` `reasonAsync`; transport
`llm/index.ts` (optional `temperature` on all providers); base seed
`engine-config-executive.deliberateThreshold`; develop `persona.consolidator` rule 17 +
`persona.prior` description. **Telemetry:** `executive.process`, `executive.effort_score`,
`executive.deliberate_candidates`, `persona.executive.deliberate_threshold_delta`.

**Shipped:** will#144 (gate + telemetry), #145 (ideation layer), #146 (wiring + temperature
transport), #147 (creativity/analytical riders + #4 close).

**Scope — master AND facets (unified).** Facets are "the master over their focus" (same
`PromptFactory`/`parseResponse` machinery, own `epistemicUncertainty`, own deliberate
decision e.g. planning's replan/continue/abandon, synced to master via
`## Master Consciousness Updates` + bus events) — so they now deliberate the same way. The
propose pass is a **shared master+facet helper** (`deliberate.reasoning.ts`
`proposeCandidates`) so "facets are like master" holds in code, not copy-paste. A facet
(`facet.ts` `_reason`) gates with facet-scoped signals — a live `recallQuery` message is its
stakes trigger; otherwise uncertainty/novelty/prior-confidence — and reads the **same**
developable `deliberateThreshold` (`engine-config-executive`), so the Will's deliberativeness
is one disposition applied everywhere: master and every focus. The propose pass is silent;
only the decision pass streams (phase-aware). Shipped as the facet dual-process upgrade.

5. ~~**emotional-stability (inverse neuroticism) → emotion/affect dynamics.**~~ ✅ DONE
   Wired as consolidator rule 16: a distinct `emotional-stability` self-model trait —
   formed from observed affect volatility (not a task success rate) — develops the
   frustration engine's build-rate **down** (`engine-config-frustration.irritabilityRate`),
   so a steadier Will lets low-grade frustration snowball into chronic irritability more
   slowly. Deliberately separate from resilience's `frustrationTolerance` (how much is
   *tolerated*, rule 10): stability governs how fast it *builds*. The
   formed-from-affect → reduces-build loop is a bounded self-regulation loop
   (steadier ⇒ slower build ⇒ steadier; the persona-prior caps + decay keep it stable).
   `FrustrationEvaluator.react` now reads `irritabilityRate` via `readEffectiveParams`
   (the seed entity already existed but was previously ignored).

### 🔵 Speculative — needs a faculty + lever first

6. ~~**agreeableness → conversation/social faculty (warmth / yielding / conflict).**~~ ✅ DONE
   Turned out **not** speculative — a clean lever already existed: the reward engine's
   `socialWeight` (`engine-config-reward`), already PMA-seeded *and* already read as
   base ⊕ persona-prior in `RewardEvaluator.react`. So #6 was the turn-key pattern after
   all: consolidator **rule 18** develops `socialWeight` **up** from demonstrated
   `agreeableness` (formed from the Will's own social/helping behaviour). An agreeable Will
   finds connection more rewarding, so positive interaction counts for more in its reward
   signal — a real Channel-A social-stance lever that shapes what it's motivated toward and
   feels good about, beneath deliberation, rather than leaving warmth to Channel-B phrasing.
   *Direction:* agreeableness↑ → `socialWeight`↑ (warmth facet).

   **Both facets now wired.** The second facet — *yielding in conflict* — landed as
   consolidator **rule 19**: agreeableness develops `engine-config-frustration.angerReactivity`
   **down** (the `0.7` anger gain, now read effective in `FrustrationEvaluator.react`), so a
   wronged-but-agreeable Will turns provocation (unfairness + blocked progress) into anger
   less strongly — it accommodates rather than retaliates. Same trait, two distinct facets:
   warmth = approach/connection (reward.socialWeight), yielding = low antagonism
   (frustration.angerReactivity). *Direction:* agreeableness↑ → `angerReactivity`↓.

---

## Cross-cutting audit item (do first — it unlocks several edges)

**`behavioralDisposition` (`riskTolerance`, `explorationRate`, `impulsivity`) is already
a trait→mechanism bridge** feeding action-selection/attention/inhibition (rendered in
the prompt too). **Audit whether it is PMA-seeded + metacog-developed like grit, or
static.** If static, route it through the persona-prior mirror so it *develops* the
same way — that single change gives risk/exploration/impulsivity their Channel A
development loop for free, and is a prerequisite for edges #4 (creativity↔exploration)
and a cleaner #1 (impulsivity↔inhibition).

**Audit result (done): STATIC.** PMA computes the three values from behavioural history
(`pma/index.ts` ~636) and `PMALoader` writes them onto `engine-config-executive.metadata.params`
(`pma/index.ts` ~805) at session start. They're surfaced in the executive prompt
(`prompt.factory.ts` ~208 — Channel B), but `executive.engine/context.ts` (~221) reads
the **raw** `metadata.params`, *not* `readEffectiveParams`, and `PersonaConsolidator`
never targets `engine-config-executive`. So there is no persona-prior layer and no
Channel A development loop — "stable per session" by construction.
*Next step (unblocks #4 and the impulsivity angle of #1):* (a) switch the context read to
`readEffectiveParams('engine-config-executive')`, (b) add `PRIOR_DESCRIPTIONS` for the
three params, (c) add consolidator rules driving them from self-model traits — open
design call on the trait→param map (e.g. openness/creativity→exploration,
decisiveness/(inverse)conscientiousness→impulsivity, ?→riskTolerance). Note this changes
the documented "stable per session" invariant.

---

## Guardrails (keep these true for every edge)

- **Determinism (R2).** Reads are pure functions of state; deltas come only from
  `consolidatePrior` (bounded per-step + cumulatively, decaying). No wall-clock, no RNG.
- **Right faculty only.** Wire a trait to the faculty it *governs* — don't sprawl one
  trait across faculties for breadth. (Conscientiousness→planning, not goal-manager.)
- **Deterministic guarantee test.** Only give a trait Channel A when you need the
  disposition to run *below deliberation* or need a hard guarantee. If soft in-character
  influence suffices, Channel B already covers it — adding a knob is needless surface.
- **Two-driver interactions.** Several params are already tuned by *bias/operational*
  signals. A trait driver on the same param is fine (both bounded/decaying), but note
  it in the rule comment so the composition is auditable.

---

*Spun off while wiring the conscientiousness → planning follow-through edge (the first
non-grit Channel A edge). See also [TRAIT_SALIENCE_GRADED_TODO.md] for the Channel-B
surfacing improvement.*

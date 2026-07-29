# MODEL_ROUTING — one Will, many models

**Status:** plan of record · opened 2026-07-28
**Engine version at open:** 0.7.0

> **The picture:** `docs/graphs/model-routing.svg` — the whole arc in one diagram:
> what the mind tags, where the host decides, and how one endpoint resolves per call.

---

## 0. The problem

A Will runs one `LLMDirector` with **one** `model`, **one** `provider`, and **one**
`apiKey`. Every call site — the master's decision, each facet, deliberation,
escalation, the summarizer, the identity guard, the embedder, message delivery —
shares it.

That is wrong on the engine's own terms, before any commercial consideration.
The architecture's central claim is that *an LLM is one component, recruited only
when a moment is ambiguous or high-stakes*. But the engine already knows how much
a moment demands (`effortScore`, `stakes`) and then spends the same model on all
of them. A rolling summariser compressing twelve excerpts and a deliberation over
a consequential commitment are not the same cognitive act, and should not
necessarily be the same inference.

**The goal:** let a host route each call to a model appropriate to that call,
without the engine knowing anything about money.

---

## 1. The boundary (read this before writing code)

`will` is Apache-2.0 and public. The routing *policy* — which model serves which
customer at which margin — is commercial and must never appear here.

> **Ship the mechanism. Never the policy.**

| Belongs in `will` (public) | Never in `will` |
| :--- | :--- |
| The `ModelRouter` seam + a null default | Any specific routing table we run |
| A reference table-driven router (host supplies the table) | Tier → model mappings |
| Routing by **cognitive demand** | Routing by *customer plan* |
| Public list prices (`MODEL_PRICING`) — already here, legitimate | Blended COGS, margins, negotiated rates |
| Per-Will cost telemetry (what this mind spent) | Per-customer profitability |

The engine may know *"this call is cheap-and-routine"*. It must never know
*"this caller is on the entry plan"*. That single distinction is what keeps the
public repo clean while making the host's routing fully expressible.

**Vocabulary rule:** no commercial words in public source or comments —
no *margin*, *COGS*, *tier*, *plan*, *upsell*. Say *cost*, *demand*, *budget*.
(npm ships `src/` comments permanently; a stray word is public forever.)

---

## 2. What already exists

Most of the substrate is here. This is a wiring job, not a build.

| Piece | Where | State |
| :--- | :--- | :--- |
| **Per-call attribution** — `category` / `attribute` / `function` / `scope` on every call | `llm/index.ts` `LLMCallMeta` | ✅ the routing discriminator, already tagged at every site |
| **`effortScore`** — physiology-derived demand (uncertainty, prior confidence, novelty, pending reply, stress), pure + deterministic, computed **before** the call | `faculties/executive.engine/effort.gate.ts` | ✅ already consumed by master + facets |
| **`stakes( winner, bias )`** — consequence of the leading choice (threat, affective charge, novelty) | `agency/selection.scoring.ts` | ✅ computed; not yet carried to the deliberation call |
| **Completion tape records `provider` + `model`** per call; replay re-feeds recorded completions | `core/completion.recorder.ts` | ✅ **replay determinism under routing is already solved** |
| **Multi-provider wire** — 5 providers, wire detection, per-provider base URLs, `baseUrl` override | `llm/index.ts` | ✅ |
| **Public list prices** + date-insensitive normalisation | `cognition/utilities/token.tracker.ts` | ✅ |
| **The seam pattern to copy** — interface + null default that ships dark + reference impl | `stem/policy/arbiter.ts` | ✅ proven in 0.7.0 |

**The three gaps:** the model is fixed per Will; there is one credential; there
is no router.

---

## 3. Design

### R0 — the demand hint

`LLMCallMeta` gains one optional field:

```ts
/**
 * How much this call demands, 0..1. Absent ⇒ unknown, and a router MUST treat
 * absence as "use the default" rather than as zero.
 *
 * This is a cognitive measure, not a commercial one: it says how consequential
 * or uncertain the moment is, never who is paying.
 */
demand?: number
```

A **number, not an enum**, because both real producers are already continuous.
Bucketing is a *policy* decision and belongs in the host's router, not here.

**The actual call sites are fewer than a `category:` grep suggests.** Only six
places reach `LLMDirector`; the other `category` hits are *percept* metadata
(`outbox.controller`, `escalation.buffer`, `stem/index`) or a direct
`TokenTracker.recordUsage` (`vector.embedder` — embeddings never go through the
director at all).

| Call site | Source of `demand` |
| :--- | :--- |
| master decision — `engine.ts` | `processSelection.effortScore` ✅ already in scope |
| master ideation — `engine.ts` | `processSelection.effortScore` ✅ already in scope |
| facet decision — `facet.ts` | `processSelection.effortScore` ✅ already in scope |
| facet ideation — `facet.ts` | `processSelection.effortScore` ✅ already in scope |
| summariser — `llm/summarizer.ts` | `BACKGROUND_DEMAND` |
| identity guard — `stem/guards/identity.coherence.ts` | `BACKGROUND_DEMAND` |
| *(fallback)* `DEFAULT_CALL_META` | left **absent** — unknown, not zero |

**Four of six sites carry a real, physiology-derived value**, because the effort
gate already computed it — central derivation from physiology is not future
work, it shipped with the dual-process gate. The remaining two are honestly
constant: a summariser compressing excerpts is background work whether the mind
is calm or in crisis.

`ESCALATION_DEMAND` is defined for the escalation path, which currently reaches
the master through a percept rather than its own LLM call; it becomes live if
that path ever calls directly.

### R1 — the router seam

New module `src/llm/routing.ts`, modelled on `stem/policy/arbiter.ts`:

```ts
export interface ModelRoute {
  provider: LLMProvider
  model: string
  baseUrl?: string
  maxOutputTokens?: number
}

/**
 * DETERMINISM CONTRACT: a router is an external oracle, exactly like the LLM
 * and the policy arbiter. Its choice is captured on the completion tape
 * (provider + model are already recorded), and replay re-feeds the recorded
 * completion — replay never consults a router.
 *
 * SCOPE: a router may read the call meta and its own configuration, and
 * nothing else. It must not reach into simulation state. This keeps `src/llm`
 * below cognition, where it belongs.
 */
export interface ModelRouter {
  readonly name: string
  route( meta: LLMCallMeta ): ModelRoute | null   // null ⇒ the Will's default
}

export const NULL_ROUTER: ModelRouter            // ships dark; byte-identical
export class TableRouter implements ModelRouter  // reference; host owns the table
```

`TableRouter` matches on the attribution axes and an optional demand band, and
is deliberately dumb: it is a worked example of the seam, not our routing table.

### R2 — the credential set

`LLMDirectorConfig` gains:

```ts
/**
 * Per-provider credentials. The top-level `apiKey`/`provider` remain the
 * default entry; a route to a provider with no entry falls back to the
 * default rather than throwing — a missing key must degrade, never crash a
 * running mind.
 */
credentials?: Partial<Record<LLMProvider, { apiKey: string; baseUrl?: string }>>
```

### Resolution order (per call)

```
router?.route( meta )                    // null / absent ⇒ skip
  → credentials[ route.provider ]        // missing ⇒ fall back to default
  → default provider/model/apiKey        // today's behaviour, unchanged
```

---

## 4. Invariants

1. **Quiet-path byte-identity.** With `NULL_ROUTER` (the default), a Will must be
   byte-identical to one built before this seam existed — asserted by test, the
   same bar the policy seam met.
2. **`demand` never changes cognition.** It is telemetry that rides along to the
   router. No engine may read it back and behave differently, or routing becomes
   a hidden input to the mind.
3. **Replay never consults a router.** The tape's recorded `provider` + `model`
   win. A replay whose router is absent, or configured differently, must still
   reproduce byte-for-byte.
4. **Degrade, never crash.** Unknown provider, missing key, throwing router →
   log once and use the default.
5. **The router is stateless w.r.t. the Will.** No simulation-state access; no
   cognition imports in `src/llm/routing.ts`.

---

## 5. Work breakdown

| # | Work | Depends on | Notes |
| :--- | :--- | :--- | :--- |
| **W0** | `demand` field on `LLMCallMeta`; forward `effortScore` at master + facet sites; constants at the background sites | — | Additive optional field; byte-identical |
| **W1** | Carry agency `stakes` onto the deliberating intent so an agency-driven facet reports the stakes of *that choice* rather than the tick's general effort | W0 | Refinement, not a gap — the facet already forwards `effortScore`. Optional |
| **W2** | `routing.ts`: `ModelRoute`, `ModelRouter`, `NULL_ROUTER`, `TableRouter` + tests | — | Pure module, no wiring |
| **W3** | `LLMDirector` resolves route per call; credential set; fallbacks | W2 | The behavioural change |
| **W4** | Byte-identity + replay-equivalence tests under a routing config | W3 | The gate |
| **W5** | Docs: routing guide in `docs/`, README note, `ROADMAP.md` entry | W3 | README + `.env.example` done; the standalone `docs/` guide waits for the backend table, so it documents a real setup |
| **W6** | Thread `router` from `WillConfig` → stem → every director; typed attribution axes | W3 | ✅ Shipped |
| **W7** | Desugar the per-role model map into the router; delete the director cache | W6 | ✅ Shipped — see §5d |
| **W10** | Every provider the cost model names; provider-scoped key env; export the seam | W9 | ✅ Shipped — see §5e |

---

## 5b. W8 — pricing belongs to the host (and dollars leave state)

### The three findings that forced this

1. **The table cannot be kept current from inside the engine.** Of the ~23
   models the host's cost model names, **20 have no row**. Prices change on a
   vendor's schedule; an npm release is the wrong instrument for tracking them.
2. **`__default__` is a silent lie.** An unpriced model is billed at Sonnet's
   `$3/$15`. For a budget model at `$0.14/$0.28` that overstates output cost by
   **~54×** — reported with total confidence. A wrong number nobody doubts is
   worse than a missing one.
3. **Dollars are in simulation state but nothing reads them.**
   `llm.cost_total_usd`, `llm.cost.<category>` and `llm.cost.fn.<function>` are
   pushed into `commands.metrics`; the only consumer in the tree is
   `thin-shim.runner` (a console display), and the `llm.cost.tick` event schema
   has **zero subscribers**.

Finding 3 is what makes the rest safe. Because no engine reads cost, moving
pricing to the host cannot change what a mind does — but while dollars sit in
state they still change state *bytes*, so a host that edited its prices would
break replay-equivalence over a number that influenced nothing.

### The line

> **Tokens are a physical fact of a call. Dollars are the host's accounting
> over that fact.**

| Stays in state | Leaves state — telemetry only |
| :--- | :--- |
| `llm.prompt_tokens_*`, `llm.completion_tokens_*`, `llm.total_calls`, per-category token counts | `llm.cost_total_usd`, `llm.cost_this_tick_usd`, `llm.cost_avg_per_tick_usd`, `llm.cost.<category>`, `llm.cost.fn.<function>` |
| deterministic, physical, plausibly readable by a future budget governor | host accounting, zero engine readers |

Cost keeps flowing on the existing ledger path (`onRecord` → the stem's
transport bridge → the host), which is where a host was already reading it.

**Consequence:** host-supplied prices have **no determinism surface**. Prices
can change between a recording and its replay and the run still reproduces
byte-for-byte.

### The provider map

One declaration per provider, carrying everything a host knows about it:

```ts
llm: {
  providers: {
    anthropic: { apiKey, prices: { 'claude-sonnet-5': { input: 3, output: 15 } } },
    deepseek:  { apiKey, baseUrl, prices: { 'deepseek-v4-flash': { input: 0.14, output: 0.28 } } },
  },
  provider, model,   // the simple single-provider path, unchanged
  router,            // W6 — routes to provider names
}
```

Deliberately **not** hung off the router: a Will with no router still needs
prices (the common case), prices and routing policy change on different
schedules, and the tracker has no business reaching through a router to price a
call. The router *references* provider names; it does not own them.

### Unpriced is visible, never silent

`__default__` is removed. An unpriced model reports **cost 0** with
`priced: false` on the ledger record and one warning per model id. The quickstart
still shows real token counts and an honest "cost unknown" instead of a
confident wrong figure.

The built-in table stays as a **fallback convenience** for the zero-config
case, carries an `as of` date, and is always overridden by host prices — it is
a starting point, not a source of truth.

### W8 work items

| # | Work |
| :--- | :--- |
| **W8a** | `providers` map on `WillLLMConfig`; thread prices → `TokenTracker`, credentials → `LLMDirector` |
| **W8b** | Host prices win; unpriced ⇒ cost 0 + `priced:false` + warn-once; delete `__default__` |
| **W8c** | Dollars out of `commands.metrics`; keep token metrics; move `thin-shim` to read the tracker |
| **W8d** | ~~Refresh the built-in fallback table~~ — **superseded**: the table was dropped entirely (W9). A partial stale table is the same failure as `__default__`, one model at a time. |

---

## 5c. W9 — the host declares its providers, explicitly

Three defaults removed, for one reason: **the engine guessed, and a wrong guess
about who you are talking to is expensive.**

| Removed | Was | Now |
| :--- | :--- | :--- |
| `MODEL_PRICING` | 22 stale rows; ~20 of the models in current use missing | The engine ships no prices. Host-owned, `null` when unknown. |
| Closed `LLMProvider` union | 5 names; anything else had to masquerade as `openai`, lying on the tape and in attribution | Any string. Known names keep built-in base URLs as *data*; anything else declares `wire` + `baseUrl`. |
| `defaultModelFor()` | A Claude id for every provider but GLM | Required from `llm.model` or `WILL_LLM_MODEL`. |
| `?? 'anthropic'` provider | Silent | Required from `llm.provider` or `WILL_LLM_PROVIDER`. |
| `?? ANTHROPIC_API_KEY` | A Will pointed elsewhere still sent an Anthropic key | `WILL_LLM_API_KEY` only. |

**Wire, not provider, is what the transport branches on.** Every switch in the
LLM layer was really asking "which dialect?", so `CallEndpoint` carries a
resolved `wire` and the provider name is free.

**Two exemptions, deliberately:** a **mock** Will and a **replay** never reach a
network — demanding credentials from either would break the no-key quickstart
and re-feeding alike. Both resolve a `mock` sentinel that the tape records
plainly.

---

## 5d. W6/W7 — one mechanism, not two

The seam shipped in W2/W3 but nothing threaded it from `WillConfig`, so a host
using the SDK could not route at all (**W6**). Fixing that exposed the deeper
problem: the engine already had a second, older answer to "which model serves
this call?" — the per-role model map, implemented as a **cache of directors**
keyed by model.

Two mechanisms, one question, and they disagreed about *when*:

| | decided at | follows |
| :--- | :--- | :--- |
| role map | facet **spawn** | the role the facet was created under |
| router | each **call** | the work the call is actually doing |

A facet held its spawn-time model for life. The router could still override per
call, so the role map was never authoritative either — it was a *default* with
extra machinery.

**W7 makes the map sugar.** `compileRoleRouter()` desugars it into rules, which
chain behind the host's own router (`chainRouters`, host first — the precedence
the two already had). `_directorFor` and its cache are gone; a Will builds one
director.

The desugaring is exact because every role's call sites already tag themselves
with the matching axis — `summarizer` → `category`, `deliberation` and
`conversation`/`outreach` → `function`. The master's own deliberate pass is
tagged `ideation`, so a `deliberation` rule does not capture it, exactly as
before. Roles equal to `executive` emit no rule at all, so a single-model Will
keeps an empty chain and stays byte-identical.

Two supporting changes fell out:

- **`ModelRoute.provider` is now optional** — "same vendor, different model",
  which is the only thing a role has ever meant.
- **`chainRouters` isolates a throwing link.** A broken host router must not
  take the compiled role map down with it; that failure would look like nothing
  at all, silently demoting every role-mapped call to the default.

---

## 5e. W10 — the providers the cost model actually names

`KNOWN_PROVIDERS` held five. The routing table in
`executive/WILL_PRICING_STRATEGY_ECONOMY.md` builds on ten, plus local
runtimes. Every missing one had to be reached by declaring `wire` + `baseUrl` by
hand — or, far more likely, by calling it `openai` because it speaks that wire,
which puts a false vendor on the completion tape and in the per-provider cost
breakdown.

Added: `moonshot` · `qwen` · `xai` · `minimax` · `mistral` · `ollama` · `vllm`.
Each entry is wire + base URL, verified against the vendor's own docs.

**Why a URL table survives when the price table did not.** A stale price is
invisible — a confident wrong number nobody doubts. A stale base URL fails on
the first call, loudly, with the endpoint in the message. They also move on
different clocks: vendors reprice quarterly and change an API host about once a
decade. Convenience is worth it when being wrong announces itself.

**One regression fixed here.** W9 removed the key fallback that ended at
`ANTHROPIC_API_KEY` for every provider — correctly, since it handed one vendor's
secret to another. But removing it outright left `ANTHROPIC_API_KEY=… npx
@mindot/will` (the documented quickstart) building a director with an *empty*
key, while the host's preflight check still validated the key it found. Preflight
said yes; the first real call 401'd. `providerKeyFromEnv()` restores the path
without the bug: the lookup is keyed by the **resolved provider**, so it can only
ever read the key belonging to the provider actually configured.

**Public surface.** None of `TableRouter`, `NULL_ROUTER`, `ModelRouter`,
`RoutingRule` or `KNOWN_PROVIDERS` was exported from the package index — the
reference implementation that ships *for hosts to copy* could not be imported by
one. Now exported. A seam nobody can import is not a seam.

---

## 6. Non-goals

- **No spend governor here.** A Will under sustained stress recruits the
  executive *more often*; if demand-routing also sends those to costlier models,
  the two multiply. That is a real risk and the right instrument is a **budget
  governor** (`docs/strategy/will/__METABOLIC_BUDGET`), not the router. Keep them
  separate: *the router picks what fits the moment; a governor decides what we
  can afford.* Note the interaction, build it separately.
- **No automatic model selection.** The engine never picks a model on quality
  grounds by itself. A host configures; the engine obeys.
- **No pricing intelligence.** The engine reports what a call cost using public
  list prices. It does not optimise for cost, and must not learn to.
- **No per-tier anything.** Tiers do not exist in this engine
  (`EngineTier`/`ModelTier` were deliberately removed); nothing here reintroduces
  them under another name.

---

## 7. Open questions

- **W1 shape:** carry `stakes` as a field on the deliberating intent entity, or
  recompute from the affordance at the deliberation site? Field is cheaper and
  honest to the moment the choice was made; recomputation avoids widening the
  entity. Decide when W1 starts.
- **Embedding calls** are not completions and never route to a chat model. They
  may want their own seam later, or to be excluded explicitly. Excluded for now.
- **Streaming + routing:** a route that changes provider mid-conversation changes
  wire dialect. Facets should hold their route for the life of a thread —
  confirm during W3.

---

## 8. Definition of done

- A host can route each call site to a different provider/model through public
  API alone, with no `will` change.
- With no router configured, the engine is byte-identical to 0.7.0.
- Replay reproduces byte-for-byte with the router absent, present, or changed.
- No commercial vocabulary anywhere in the shipped source.

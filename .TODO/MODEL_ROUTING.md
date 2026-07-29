# MODEL_ROUTING — one Will, many models

**Status:** plan of record · opened 2026-07-28
**Engine version at open:** 0.7.0

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
| **W5** | Docs: routing guide in `docs/`, README note, `ROADMAP.md` entry | W3 | Public-facing |

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

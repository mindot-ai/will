# Will — Per-Facet Awareness Scoping

> A facet now sees exactly the cognitive-context sections its creating engine
> declares — the prompt-context analogue of an engine's `subscribes()`. This
> replaces the blanket `mode === 'master'` gate with a uniform, declarative
> manifest, so any faculty can become plan/goal/belief/…-aware on demand without
> bloating every facet prompt.

---

## Problem

Making a facet "plan-aware" by special-casing it (e.g. scope plans to a
conversation's `requestingEntityId`) only solved planning↔conversation. A future
faculty that wants plan-awareness but has no `requestingEntityId` would be stuck,
and unconditionally rendering plans would bloat every facet prompt for nothing.

We needed a *general* control: each facet declares which awareness it wants;
unused awareness costs zero tokens.

---

## ✅ Stage 1 — declarative awareness manifest (shipped)

The single, uniform gate for every cognitive-state section in the facet/master
user message.

- **`AwarenessScope`** (`prompt.factory.ts`): `'goals' | 'plans' | 'beliefs' |
  'percepts' | 'ruminations' | 'memories' | 'recentActions'`.
- **`FULL_AWARENESS`** — master always renders everything.
- **`DEFAULT_FACET_AWARENESS`** — baseline for a facet that declares nothing
  (everything *except* `plans`, which stays opt-in to keep facet prompts lean).
- **`FocusSection.awareness?: AwarenessScope[]`** — the creating engine declares
  the set when it builds the focus (rides the existing `setFocus` seam — no new
  spawn parameter). `FocusSection.awarenessEntityId?` scopes entity-filtered
  sections (currently `plans`) to a single requester.
- **`buildUserMessage`** builds `scopes = master ? FULL : (focus.awareness ??
  DEFAULT_FACET)` and gates each section via `has(scope)`; sections assemble via a
  `filter(Boolean).join('\n\n')` so spacing stays clean.

**Wiring done.**
- AuditionEngine conversation facet declares `[ ...DEFAULT_FACET_AWARENESS,
  'plans' ]` + `awarenessEntityId = speakerEntityId` → a conversation can report
  the speaker's plan/step state **with precision**, scoped to them.
- Plan entities now persist `requestingEntityId` / `requestingThreadId`;
  `ExecutiveContext.plans` carries `requestingEntityId` so the filter works.

**To add a new awareness type:** (1) add the scope name to `AwarenessScope`,
(2) gate its section in `buildUserMessage` via `has(...)`, (3) add it to
`FULL_AWARENESS` (and `DEFAULT_FACET_AWARENESS` if facets should get it by
default). Any facet-spawning engine opts in by listing it.

**Tests.** `tests/unit/awareness.scope.test.ts` (6): plans appear only when
declared; defaults still include goals/beliefs; an explicit set drops unlisted
defaults; `awarenessEntityId` filters to one requester; master ignores the
manifest. 454 unit green; replay + transport-replay byte-identical.

---

## Design rationale (why this shape)

- **Push, not pull.** This is *state projection* — authoritative, structured,
  live, deterministic (read from `state` at prompt-build). It's the right tool for
  "report current state with precision." It is **not** recall (associative,
  relevance-gated, embedded-at-a-point-in-time) — see below.
- **Decoupled & open/closed.** Consumers declare interest by scope name; they
  don't reach into PlanningEngine/GoalManager. Mirrors `subscribes()`/`publishes()`.
- **Token-bounded by declaration + scoping.** Only declared scopes render; entity
  scoping trims further. A faculty that doesn't want plans pays nothing.

---

## ✅ Stage 2 — recall-scoped awareness (the WM/vector question) — SHIPPED

**Finding.** Plans live only as `plan` *state entities* (`_persistPlans`); they are
**not** in working memory, and vector/episodic memory holds plan-related
*episodes* (stable descriptors), not the live plan entity.

**Is that a flaw?**
- For Stage-1 **push** scoping: **no** — state entities are the correct, precise,
  live source. WM/vector would be a *worse* source (decaying, lossy, stale).
- For the **pull/recall** layer: **yes, a gap.** Because nothing plan-derived is in
  vector memory, a facet can never *opportunistically* surface a plan via relevance
  recall — awareness requires pre-declaring the scope (foreknowledge). The
  "the conversation made this relevant, even though I didn't pre-declare it" case
  isn't covered.

**How fixing it enhances the scoping (the payoff).** Emit a **stable, embeddable
plan descriptor** (goal / expectedOutcome / topic — fields that don't change per
tick) into episodic memory at plan creation/revision. Then:

- recall matches on that stable descriptor → returns the **plan id(s)** relevant to
  the current message;
- those ids feed the projector as a **scope filter** — `_buildActivePlansSection`
  renders the **live** state of *those* plans (from the state entity, precise).

This marries the two layers correctly: **recall decides *which/whether* (relevance);
projection supplies the *current state* (precision).** Crucially, it generalizes
scoping from `entityId` (a special case that needs a requester) to **relevance** —
the faculty-agnostic key that removes the "no `requestingEntityId`" limitation
entirely. Live step-state never goes into embeddings (no staleness trap); only the
stable descriptor does.

**Implementation (shipped).**
- [x] **Descriptor emission.** `PlanningEngine._flushPlanDescriptors` (run in
      `react`) emits a stable `working_memory.item` for each newly created/revised
      plan: `{ wmType:'plan', content:{ summary, planId, goalId }, tags:['plan',
      'plan.descriptor'], activation }`. Only the stable descriptor (goal +
      expectedOutcome) is embedded — **never** the live step state — so recall stays
      match-stable. The EpisodicConsolidator already indexes `working_memory.item`s
      → vector; the WorkingMemory faculty GCs the item after consolidation (no
      growth). Follows the established external-injection pattern (AuditionEngine).
- [x] **Relevance filter (reused the recall surface, not `focus.awarenessIds`).**
      `buildExecutiveContext` collects planIds from recalled descriptor episodes →
      `ExecutiveContext.relevantPlanIds`. `_buildActivePlansSection(plans, entityId,
      relevantIds)` renders the **union** of the requester's own plans (entityId)
      and recall-surfaced plans (relevantIds). Master ignores the filter (sees all).
      The context surface is cleaner than `focus.awarenessIds` — the focus is built
      *before* recall runs, so the relevance signal must ride the context.
- [x] **AuditionEngine — no extra wiring needed.** The conversation facet already
      declares `['plans']` + `awarenessEntityId`; relevance now *also* flows
      automatically via `context.relevantPlanIds` (recall is driven by the live
      message). So a message that mentions a plan surfaces that plan's **precise
      live state**, even one the speaker didn't request — the relevance key removes
      the `requestingEntityId` limitation.

**Determinism.** Descriptor emission is a state command; relevantPlanIds collection
is pure over (deterministic) recall results; the filter is pure. Replay +
transport-replay byte-identical.

**Tests.** `awareness.recall.test.ts` (descriptor emission shape; recall→planId
collection) + `awareness.scope.test.ts` Stage-2 cases (union filter; relevance-only
for a facet with no entityId; master unaffected). 467 tests green.

**Boundary.** End-to-end *semantic* recall surfacing depends on vector memory being
configured (same as all episodic recall); without it the consolidator's recent-query
fallback still surfaces fresh descriptors. The deterministic seams (emission +
collection + filter) are unit-covered.

### Status: ✅ COMPLETE — Stages 1 & 2 shipped. Nothing open.

---

*Created from the cross-faculty plan-awareness design discussion.*

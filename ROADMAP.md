# Will — Roadmap

**How this engine grows, and how you can shape it.**

Will is an engine for persistent machine minds. This document is the public
roadmap: what exists today, what is being built, what is being considered, and
what we have deliberately decided *not* to do.

It is written for the people who use and contribute to Will. It is honest by
construction — every item carries a status, and nothing is listed as coming
unless it is genuinely being worked on.

- **Discussions & proposals:** [GitHub Discussions](https://github.com/mindot-ai/will/discussions)
- **Issues & bugs:** [GitHub Issues](https://github.com/mindot-ai/will/issues)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Release history:** [CHANGELOG.md](CHANGELOG.md)

---

## How to read this

Every item carries one of three statuses. We do not move an item up a level to
make the roadmap look better.

| Status | Meaning |
| :--- | :--- |
| **Shipped** | In a released version. Documented, tested, and covered by the stability policy below. |
| **Building** | Actively being worked on. Landing in a foreseeable release. Design may still change. |
| **Considering** | A direction we find compelling. **Not committed, not scheduled**, and may never happen. Your input matters most here. |

There is no "coming soon." If it is not **Building**, do not plan around it.

---

## What Will is (and isn't)

Will is a **cognitive substrate**, not a chatbot framework and not an agent
orchestration library. Its distinguishing commitments:

- **An LLM is one component, not the substrate.** Most ticks resolve on the
  engines alone. The model is recruited when a moment is ambiguous or
  high-stakes — often it stays silent.
- **The mind accretes.** Traits develop, beliefs consolidate, skills
  proceduralise. A coherent self carries across restarts.
- **Determinism is a first-class property.** Same seed + same inputs
  re-executes the whole mind byte-for-byte. This is what makes emergent
  behavior debuggable rather than merely impressive.

Those three commitments are the frame for everything below. A proposed feature
that would compromise determinism, or that would make the LLM the substrate,
will be declined on principle — see [Non-goals](#non-goals).

---

## Stability & versioning

Will is pre-1.0 and uses semantic versioning.

- **Minor versions (0.x.0) may contain breaking changes.** They are always
  documented in [CHANGELOG.md](CHANGELOG.md) with a migration note.
- **The SDK facade is the stable surface.** If you build on the facade, you are
  on the most stable path. Deep imports into engine internals are supported for
  research and extension, but internals move faster.
- **Determinism is treated as a contract, not a feature.** A change that breaks
  replay-equivalence is treated as a defect, and a bug report proving one is one
  of the most valuable contributions you can make.
- **Toward 1.0:** the criteria are a stable facade surface, a documented
  extension API for third-party engines, and a published determinism test
  harness. No date — 1.0 lands when those are true.

---

## Shipped

The foundation. Available today in the released package.

### The mind

- **40+ cognitive engines** — 38 faculties across seven systems (regulatory,
  perceptual, affective, memory, executive, meta-cognitive, social) stepping
  forward on a deterministic tick clock.
- **Agency pipeline** — actions are found in the situation, enacted, and
  proceduralised into composite skills. Not a fixed effector catalog.
- **Affective system** — eight evaluators blended into valence, arousal,
  dominance, and attachment.
- **Memory** — episodic consolidation, semantic belief integration, forgetting
  curve, spaced repetition, dream replay.
- **Planning as a prior** — plans bias the single action competition top-down
  rather than running a parallel command channel.
- **Metacognition loop** — introspection writes back into the engine apparatus,
  bounded and surprise-gated.
- **Five sensory channels** with a conversation pipeline built on executive
  facets.

### Continuity & verification

- **PMA (Portable Mind Artifact)** — a portable, eval-verified mind artifact
  carrying psychology *and* learned competence, with a measured
  reconstruction-fidelity score.
- **Deterministic replay** — record a session, replay it, compare runs.
- **Snapshot / restore** across the full engine set.

### Recent releases

- **0.7.0 — policy reafference.** A Will can be given a boundary deciding what
  it may enact, and the boundary is *felt* rather than announced: a refusal
  arrives as world resistance through the same channel as any other
  consequence, so the mind learns availability without learning incompetence.
- **0.6.0 — exafference.** The mind distinguishes its own echo from the world.
  Self-caused percepts are attenuated; genuinely world-caused shifts can
  interrupt an in-flight commitment. Engagement became dependent on situation
  shifts, not just on initial choice.
- **0.5.0 / 0.4.0 — channels.** WhatsApp and Discord surfaces; a choice of
  executive provider.

### Surfaces you can embed today

SDK facade (Node/TS) · Discord · WhatsApp · MCP server (Claude Desktop / Claude
Code) · MCP tools as the mind's abilities · HTTP sidecar / Docker for any
language. See the [README](README.md) for the current list and setup.

---

## Building

Actively in progress.

### Record anchoring — tamper-evident cognition

Cognition records — session logs, decision records, completion transcripts —
hash-chained inside the engine, digested and signed so that what a mind decided
can be verified after the fact without trusting the operator.

**Why it matters:** Will can already *explain* a decision by replaying it. This
adds the missing middle step — proving the record wasn't altered between the
decision and the explanation. Together: an ability that was never granted can't
be enacted, what happened is evidenced, and why it happened can be re-derived.

**Community-facing outcome:** an anchored record you can verify yourself, with
a CLI, independent of any hosted service.

### Per-call model routing

One Will currently sends every call to one model — the master's decision, each
facet, the propose pass, the rolling summariser, the identity guard. Those are
not the same cognitive act and need not be the same inference.

The engine now tags each call with how much it *demands* (0..1), taken from the
same a-priori effort gate that already decides fast-vs-deliberate, and exposes a
`ModelRouter` seam so a host can send each call where it belongs — including to
a self-hosted or local model.

**What the engine knows:** whether a moment is routine or consequential. **What
it will never know:** who is paying, or what anything costs them. Routing policy
is host configuration; the engine ships the mechanism and a reference
table-driven router, never a table of its own.

Unconfigured, this is inert: a Will with no router behaves exactly as before.

### Determinism test harness

Making replay-equivalence something contributors can run and extend, not just
something maintainers assert. This is a prerequisite for 1.0.

### Engine quality & cost work

Ongoing: context assembly efficiency, cheaper routing for background cognition,
and reducing the inference needed per tick without reducing what the mind does.

---

## Considering

**Not committed.** These are directions we find compelling and are actively
gathering input on. If one matters to you, say so in
[Discussions](https://github.com/mindot-ai/will/discussions) — real demand is
how these move.

| Direction | What it would be | What would move it |
| :--- | :--- | :--- |
| **Third-party engine API** | A documented, supported way to write your own faculty and have it participate in the tick loop as a first-class engine | Contributors actually building engines against internals today, and telling us where the seams hurt |
| **Additional language SDK** | A first-class surface beyond Node/TS | Sustained demand concentrated in one language community |
| **Game-engine integration** | A supported path for embedding a persistent mind in an NPC, with an example project | Game developers building this and reporting what's missing |
| **Local / edge execution** | Running a mind where there is no cloud — mostly reflexive, reaching for a model rarely | Demand from privacy-first and offline builders, plus local model quality reaching the executive bar |
| **Cross-surface continuity** | Moving one mind between surfaces with its memory and dispositions intact | Users independently asking to move an existing Will between surfaces |
| **Populations of minds** | Many persistent minds interacting, with replay making population-scale behavior debuggable | Researchers hitting the ceiling of single-mind deployments |

---

## Non-goals

Deliberate decisions, not gaps. Knowing what a project refuses is as useful as
knowing what it plans.

- **Not a chatbot framework.** If you want prompt → response, there are lighter
  tools and you should use them.
- **Not an agent orchestration library.** Will is one mind, coherent over time —
  not a graph of task-executing workers.
- **We will not make the LLM the substrate.** Recruiting a model for every tick
  would be simpler and would destroy the thing that makes Will different.
- **We will not trade away determinism** for a feature, however convenient.
  Replay-equivalence is the property the whole architecture is built to
  protect.
- **PMA is for synthetic minds only.** A PMA is the distilled persona of a
  synthetic mind. It is not a human mind, an upload, or a representation of a
  real person, and we will not build in that direction.
- **No speculation mechanics.** No tokens, no NFTs, no artificial scarcity
  layered onto mind artifacts.

---

## How the roadmap changes

This document is reviewed as the project reaches its own milestones — not on a
calendar.

**How to influence it:**

1. **Open a Discussion** for a direction, a use case, or a missing seam. The
   *Considering* table above moves primarily on demonstrated need.
2. **Open an Issue** for defects. A bug report that breaks replay-equivalence
   is the highest-value report in this project — it will be prioritized, not
   deflected.
3. **Contribute.** See [CONTRIBUTING.md](CONTRIBUTING.md). Engine work,
   examples, docs, and adapters are all genuinely useful, and the areas under
   *Considering* are the most open to being shaped by whoever shows up.

Will is developed by [Mindot](https://mindot.io) and released under
Apache-2.0. The engine is open source and intended to stay that way.

---

*Last updated: 2026-07-28 · engine version 0.7.0*

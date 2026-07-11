# Knowledge graphs → architecture documentation (roadmap)

> **Status:** graphs SHIPPED (2026-07-08) — `docs/graphs/*.svg`, generated from
> declarative specs by `docs/graphs/generate.ts` (design system: `lib.ts`).
> This file is the roadmap for the NEXT phase: pairing each graph with prose so
> a contributor can engage with Will without a tour guide.

## What exists

Sixteen graphs, one visual language (a category color is the same in every
graph — violet is always memory, amber executive, green agency…). Regenerate
after edits: `bun docs/graphs/generate.ts`. Verify visually: headless-Chrome
screenshot of the SVG (qlmanage crops to square — don't use it).

**Wave 1 — the cognitive stories:**

| Graph | Covers |
|---|---|
| `memory-cycle` | WM → episodic → beliefs; forgetting/dream/spaced loops; recall into thought; → PMA |
| `executive-dual-process` | salience → activation → effort gate → ideation/decision; facets, pump, CompletionInbox, recorder |
| `agency-pipeline` | field sources (innate/host/percept/ideomotor/plan) → afford → compete → deliberate → enact → reafference → skills |
| `audition-conversation` | ingest → grants → percept salience → conversation facet → [REPLY_TEXT] → outbox; exchange → memory |
| `affect-body` | 5 regulators + 7 evaluators → blender (VAD) → prompt/selection/salience/projections |
| `determinism-tick` | command-buffer tick, phases, seeded PRNG, pump/inbox quantization, record ⇄ re-feed replay |
| `pma-lifecycle` | living ⇄ artifact circle; what travels; reconstruction eval |
| `composition` | capstone: hosts → four surfaces → stem/tick/LLM/PMA → the eight engine systems |

**Wave 2 — machinery, seams, edges (2026-07-09):**

| Graph | Covers |
|---|---|
| `meta-cognition` | observers (self-model/calibrator/bias/narrator) → introspection facet → persona-prior (base ⊕ prior) → effort gate, trait bands, salience — the write-back loop |
| `executive-agency-seam` | abilities into context → conscious args → ideomotor pre-activation; plan priors; deliberation; inhibition veto; outcomes teach both sides |
| `transports` | outbound envelopes → TransportController → loopback/socket.io/stream → far side; acks → InboundQueue → applied on-tick |
| `simulation-core` | clock → DefaultSimulation → orchestrator → commands → StateManager → COW snapshots; tick listeners = the host connection points |
| `cognitive-wiring` | assembleMind: attach*/priority/schema registry; tick time: publish → bus (queued) → Phase-2 flush → onCognitiveEvent → drainCommands |
| `llm-cycle` | buildSystemPrompt/buildUserMessage → LLMDirector precedence (re-feed → mock → live+gate) → recorder/tokens → parser strategies → tagged blocks |
| `host-surfaces` | will CLI → host/boot → MCP server / HTTP sidecar / facade; UtteranceTap; connectMcpEffectors; the PMA between sessions |
| `stem-tracts` | the body's organs: sensory/inbound intake, outbox/ack/effector outflow, PMA/replay lifecycle, logger/health/biography observability |

## Phase 2 — the paired prose (docs/architecture/)

One markdown page per graph, `docs/architecture/<graph-name>.md`, each opening
with its SVG embedded, then ~600–1200 words. Per page:

- [ ] **Walk the graph left→right** — every node named in the graph gets one
      paragraph anchored in the real code path (file references, clickable).
- [ ] **The one non-obvious rule** each subsystem carries (memory: recall is a
      single surface driven by focus.recallQuery; executive: facets ARE the
      same self; agency: parameters bind from the situation, args via ideomotor;
      audition: silence is an outcome; tick: commands never state; PMA:
      save vs hibernate).
- [ ] **"Where to start reading"** — the 2–3 source files that own the loop.
- Source of truth for claims: the code + `.TODO/` design records (facet replay,
  custom ability wiring, audition determinism) — not memory or vibes.

Order (dependency-friendly): simulation-core → determinism-tick →
cognitive-wiring → memory → affect-body → executive → agency →
executive-agency-seam → audition → meta-cognition → llm-cycle → transports →
stem-tracts → host-surfaces → pma → composition (the capstone page doubles as
the docs index / CONTRIBUTING "how it all plays out" entry).

## Phase 3 — integration

- [ ] README: replace the long Architecture prose section's opener with the
      composition graph + link to docs/architecture/ (keep the deep prose).
- [ ] CONTRIBUTING.md: point new contributors at the capstone page first.
- [ ] Graph/code sync policy: any PR that adds/renames an ENGINE or reroutes a
      major loop updates the affected graph spec in the same PR (specs are
      code — review them like code).

## Later / nice-to-have

- [ ] One graph not yet drawn: **social cognition** (ToM/empathy/reputation/
      known-entity dossiers → "People You Know" in the prompt).
- [ ] Light-theme variants (the renderer takes a palette swap; GitHub README
      renders dark SVGs fine on both themes since the canvas paints its own bg).
- [ ] Animated capstone (SMIL pulse along the tick loop) for the landing page.

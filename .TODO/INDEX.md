# INDEX — the development record, in order

> **Generated** by `bun .TODO/index.ts` from the `Standing` line of every
> document in this folder and the release headers in `CHANGELOG.md`.
> Do not edit by hand — edit the document, then re-emit.

Day zero is **2026-05-28**. 45 documents, 8 releases.
What each level means, and what it may be cited for, is [STANDING.md](STANDING.md).

- **SHIPPED** · 30 — in the engine, gated by CI, carried by a release
- **OBSERVED** · 8 — true of the real system at a moment, established by looking
- **DESIGNED** · 6 — reasoned to a plan of record — intent, not capability
- **SPECULATIVE** · 1 — a hypothesis the project is holding

> Dates before 2026-07-02 predate this repository — `will` was split out and
> squashed on that date. These come from the documents, not from `git log`.

## May 2026

**2026-05-28 · SHIPPED** · [Will — Implementation TODO](TODO.md)

day zero of this record — the 5-Senses (Phase 13.8) implementation checklist. Partial and superseded: audition and exteroception ship, four shell senses are still empty (see [[__CONTRIBUTION_TOPICS]]), and its 63 unchecked boxes are history, not backlog

**2026-05-29 · OBSERVED** · [FIX_TODO — Tactical fixes (`will` codebase review)](FIX_TODO.md)

tactical review, `file:line` as read on the day — the line numbers have drifted since and should be re-resolved by symbol, not by number

**2026-05-29 · OBSERVED** · [FUNCTIONAL_REVIEW — Behavioural / correctness review (`will` codebase)](FUNCTIONAL_REVIEW.md)

found by tracing runtime logic — the tick loop, LLM I/O, optimistic concurrency, serialize→snapshot→replay, HNSW — rather than by reading structure

**2026-05-31 · OBSERVED** · [REORIENT_TODO — Strategic / architectural reorientation (`will` codebase review)](REORIENT.md)

architectural direction changes from the 2026-05-29 review; each is a decision plus a migration, not a fix

## June 2026

**2026-06-01 · OBSERVED** · [FIXME — review punch list](FIXME.md)

architecture/performance review punch list; 6 of 7 closed since

**2026-06-02 · SHIPPED** · [Will — Sensory Pipeline Hardening TODO](SENSES_HARDENING.md)

partial — 33 of 35; lifecycle hygiene, salience fidelity, token economy and extensibility, not the core design

**2026-06-03 · SHIPPED** · [METACOGNITION_CYCLE_TODO — Closing the mind's self-dependent loop](METACOGNITION_CYCLE.md)

24 of 24, captured 2026-06-01 — the Will writes its own introspection back into the apparatus that perceives and reasons

**2026-06-03 · SHIPPED** · [PREDICTIVE_SUBSTRATE_TODO — unify SalienceComputer into GenerativeModel](PREDICTIVE_SUBSTRATE.md)

4 of 4, opened 2026-06-02 as a detour from [[METACOGNITION_CYCLE]] — `SalienceComputer` folded into `GenerativeModel`, one predictive substrate instead of two

**2026-06-21 · SHIPPED** · [Engine Phases: Self-Aware Simulated Mind Framework](ENGINE_PHASES.md)

the phase-by-phase build record, kept for provenance. Its 156 unchecked boxes are historical, not a backlog — the forward-looking roadmap is [ROADMAP.md](../ROADMAP.md)

## July 2026

### 2026-07-02 — the public split

`will` became its own public repository on this date and the history was
squashed into it. The 16 documents below were written across the weeks before
it, in an order this record no longer holds — they share a date because the
split gave them one, not because they happened together.

**2026-07-02 · SHIPPED** · [Will — Dynamic Attention Budget](@ATTENTION_BUDGET.md)

budget → concurrent facets → token spend is live; also the cost governor. Its PR refs are private-repo numbering

**2026-07-02 · SHIPPED** · [Will — Lift mechanism constants into the Channel-A developable layer](@FACULTY_CONSTANTS_CHANNEL_A.md)

partial by design — strong tier complete, medium tier all but two rows that are documented judgement-call skips, physiological tier deliberately fixed

**2026-07-02 · SHIPPED** · [Will — Identity / profile guardrail](@IDENTITY_GUARDRAIL.md)

partial — Phase 1 and most of Phase 2 wired; the API boundary (`POST /v1/wills → 400`) and Studio surfacing are open

**2026-07-02 · SHIPPED** · [Will — Lift the agency pipeline into the Channel-A/B developable layer](AGENCY_CHANNEL_AB.md)

complete, 11 of 11 — the agency engines were the last faculty group bypassing Channel-A/B

**2026-07-02 · SHIPPED** · [Agency Pipeline — mind-like effector system (greenfield)](AGENCY_PIPELINE.md)

greenfield rebuild, 50 of 50; the old effector stack was deleted in its Phase 8

**2026-07-02 · SHIPPED** · [Will — Per-Facet Awareness Scoping](AWARENESS_SCOPING.md)

3 of 3 — a facet sees the context sections its creating engine declares

**2026-07-02 · SHIPPED** · [Will — Known-entity knowledge (how a mind comes to know someone / something)](KNOWN_ENTITY.md)

Phases 0–5 complete — the dossier is the node for anything Will knows. Its PR citations are private-repo numbering that now collides with public PRs

**2026-07-02 · SHIPPED** · [Will — Planning as a top-down prior (not a dispatcher)](PLANNING_AS_PRIOR.md)

16 of 16 — a plan biases the one action competition instead of dispatching steps; no parallel command channel

**2026-07-02 · SHIPPED** · [Planning ↔ GoalManager — flow alignment audit](PLANNING_GOAL_SYNC.md)

flow-by-flow audit of the Planning↔GoalManager contract, with the gaps found and fixed

**2026-07-02 · SHIPPED** · [Will — Planning Maturation (substrate vs. policy)](PLANNING_MATURATION.md)

partial — 7 of 8; the engine is split into deterministic substrate and swappable policy, and the policy is being handed to the learned layer progressively

**2026-07-02 · SHIPPED** · [Will — Planning Pipeline Hardening](PLANNING_PIPELINE.md)

34 of 34 — the plan-execution feedback loop was silently dead (`_plans` keyed by `goalId`, looked up by `plan.id`) and only appeared to work because GoalManager independently consumed `action.outcome`

**2026-07-02 · SHIPPED** · [Will — Trait → Faculty "Channel A" edges (the subconscious layer)](TRAIT_CHANNEL_A_EDGES.md)

the two-channel model — a trait reaches behaviour subconsciously as a numeric parameter (A) and consciously through the prompt (B). Its PR refs are private-repo numbering

**2026-07-02 · SHIPPED** · [Will — Graded trait salience (Channel B surfacing)](TRAIT_SALIENCE_GRADED.md)

A + B + C plus cross-session persistence of the per-trait baseline. Its cited `will#168/#170/#171` are private-repo numbers that now collide with three unrelated public PRs

**2026-07-02 · OBSERVED** · [Will — Faculty output-consumption audit + integration wiring](FACULTY_INTEGRATION_AUDIT.md)

per-faculty audit by tracing whether a faculty's distinctive output is actually *read*. Method note: events are not a relevance signal — the executive subscribes to `'*'`

**2026-07-02 · OBSERVED** · [Will — Heuristic cleanup audit (faculty engines)](HEURISTIC_CLEANUP.md)

faculty-engine audit whose finding was a reframe: most "heuristics" are the autonomic mechanism Channel A modulates, not LLM substitutes to remove

**2026-07-02 · OBSERVED** · [Will — Audit TODO](TODO.g1.md)

superseded — pipeline audit, prompt-quality review and session-log gap analysis; its 61 unchecked boxes are a historical snapshot, not open work

**2026-07-02 · RELEASE v0.1.0** — *first public release*

**2026-07-04 · SHIPPED** · [Facet-era replay determinism gap (R2-d regression)](FACET_REPLAY_DETERMINISM.md)

found 2026-07-02 while making the suite CI-green for the public release; all three layers fixed and `replay.equivalence.test.ts` re-enabled, verified 3×

**2026-07-06 · SHIPPED** · [Will — Custom (host-owned) effector wiring](CUSTOM_ABILITY_WIRING.md)

partial — gap found 2026-06-15, Phase 1 wired; entity binding, per-effector metadata, preconditions and the learning surface are open

**2026-07-08 · SHIPPED** · [Audition conversation-reply determinism + reliability gap](AUDITION_REPLY_DETERMINISM.md)

found 2026-07-05 while building the SDK facade; root cause measured — not the suspected salience race — and both done-criteria pinned by CI

**2026-07-08 · SHIPPED** · [Knowledge graphs → architecture documentation (roadmap)](KNOWLEDGE_GRAPHS.md)

partial — the graphs ship and regenerate from declarative specs (28 as of 2026-09-02); the next phase, pairing each graph with prose, is open (9 items)

**2026-07-08 · DESIGNED** · [Record anchoring — tamper-evident decision records (parked, do not lose)](RECORD_ANCHORING.md)

parked the day it was written so it would survive context loss. Upgrades the audit story from operator-trusted logs to tamper-evident records — no blockchain, no new dependency

**2026-07-15 · RELEASE v0.5.0** — *WhatsApp, and a choice of executive*

**2026-07-15 · RELEASE v0.4.0** — *a mind in your Discord server*

**2026-07-20 · RELEASE v0.6.0** — *the mind knows its own echo*

**2026-07-21 · DESIGNED** · [ESCALATION_VOICE — the escalation ask in the mind's own voice](ESCALATION_VOICE.md)

the mechanism (hold → ask → resolve → expire) shipped with [[POLICY_REAFFERENCE]] P4; only the authored voice is unbuilt. 6 items

**2026-07-22 · RELEASE v0.7.0** — *the mind learns may from can*

**2026-07-28 · SHIPPED** · [ENVELOPE_NARROWING — the counterfactual, consumed: refusals narrow reach, not ability](ENVELOPE_NARROWING.md)

partial — designed 2026-07-22, P0 shipped; P1 is blocked upstream on counterfactual direction (2026-07-27), P2 open

**2026-07-28 · SHIPPED** · [POLICY_REAFFERENCE — the boundary as a sense: policy verdicts routed through reafference](POLICY_REAFFERENCE.md)

partial — P0–P4 2026-07-21, P5 2026-07-28, released in v0.7.0; P6 is open and gated on a schema diff from the bilateral joint RFC with HELM

**2026-07-29 · SHIPPED** · [MODEL_ROUTING — one Will, many models](MODEL_ROUTING.md)

opened 2026-07-28 at engine 0.7.0; the mind tags, the host decides, one endpoint resolves per call. Released in v0.8.0

**2026-07-29 · RELEASE v0.8.0** — *the mind thinks at more than one depth*

**2026-07-31 · DESIGNED** · [Will — Feeling the Time It Was Away](ELAPSED_ABSENCE.md)

the clock resumes from the snapshot tick, so the arithmetic is correct; the *sense* of having been away is unbuilt

## August 2026

**2026-08-03 · DESIGNED** · [High-Value Engineering Contributions](__CONTRIBUTION_TOPICS.md)

scoped invitations for contributors, not commitments — the four shell sense engines are still empty scaffolds

**2026-08-03 · DESIGNED** · [DeliberationCache — Production Proposal for Will](DELIBERATION_CACHE_PROPOSAL.md)

production proposal, 9 items, no code. Its formula is held separately as SPECULATIVE in [[__RESEARCH_DIRECTIONS]]

**2026-08-03 · SPECULATIVE** · [Experimental Research Directions](__RESEARCH_DIRECTIONS.md)

a synthesis of established ideas (case-based reasoning, speculative decoding, mixture-of-experts) applied to structured agent cognition. The fast-path/slow-path architecture is proven; this application of it is not, and no published system has demonstrated it

**2026-08-07 · RELEASE v0.9.0** — *the mind learns said from answered, and who from where*

**2026-08-11 · SHIPPED** · [DISCORD_SURFACE_TODO — a Will present in a server, not merely connected to one](DISCORD_SURFACE.md)

partial — P0 (the room stops being an id) and P1 (reactions are answers) live, P2+ open; the open half is confirmed by live evidence, not inference

**2026-08-21 · SHIPPED** · [ACTION_CONDITIONED_PREDICTION_TODO — the exafference sequel](ACTION_CONDITIONED_PREDICTION.md)

designed 2026-07-20, all 11 tracked items landed; the header said OPEN until the SIGNAL_BOUNDARY audit corrected it

**2026-08-21 · SHIPPED** · [EXAFFERENCE_TODO — corollary discharge + the exafferent interrupt (commitment revocation)](EXAFFERENCE.md)

designed 2026-07-19, all 23 items landed. The header said OPEN for a month after it shipped — the mistake that motivated [[STANDING]]

**2026-08-21 · DESIGNED** · [ACT_EXPECTATIONS — an act is still in the air until the world says otherwise](ACT_EXPECTATIONS.md)

sketch, deliberately short — its design depends on decisions made in [[SIGNAL_BOUNDARY]]. 6 items, none built

**2026-08-25 · SHIPPED** · [Will — External Transport + Conversation Memory + Facet Concurrency](EXTERNAL_TRANSPORT.md)

73 of 73, opened 2026-06-02 — socket.io as the primary bidirectional channel, conversation through the canonical memory pipeline, per-facet serialization

**2026-08-31 · SHIPPED** · [SIGNAL_BOUNDARY — where the mind meets the world, in both directions](SIGNAL_BOUNDARY.md)

52 of 57, opened 2026-08-21 as AFFERENCE_UNIFICATION and widened to cover efference; released in v0.10.0. The live-run sightings that shaped it are a different claim and live in [[FIELD_NOTES]] — OBSERVED, n=1, gated by nothing

**2026-08-31 · OBSERVED** · [FIELD_NOTES — what was seen in a mind that was actually running](FIELD_NOTES.md)

four runs of one COO Will on Discord, the earliest recorded on or before 2026-08-21; each sighting is n=1 unless it says otherwise

**2026-08-31 · RELEASE v0.10.0** — *the mind knows its own doing from the world's*


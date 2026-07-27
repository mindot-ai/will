# POLICY_REAFFERENCE — the boundary as a sense: policy verdicts routed through reafference

> **Status:** P0–P4 SHIPPED (2026-07-21) · P5 + refinements OPEN. Goal: give the
> Will a **body that cannot do forbidden things**, and make the refusal something
> the mind *learns from* rather than a wall it re-discovers every tick. A policy
> verdict stops being an exception thrown at the host and becomes **graded
> reafference**: the world answering "not that", in the same currency as every
> other outcome.
>
> **Shipped (main):** the three-verb "Gated" story is demonstrable end to end.
>
> | Phase | PR | What it delivers |
> | :--- | :--- | :--- |
> | **P0** seam | #72 | `PolicyArbiter` interface + local `RuleTableArbiter`; PEP in `effectorController`, fail-closed, byte-identical default. Provider-agnostic — no HELM types. |
> | **P1** refusal ack + tape | #72 | A denial reconciles as a host-rejection-shaped `agency.outcome` at the next boundary (not a 15-tick timeout); verdicts captured on a willId-keyed tape (`verdict.recorder.ts`). |
> | **P2** availability | #73 | Refusal → a schema-keyed **availability** layer in the repertoire, strictly apart from `LearnedSkill`; `scoreAffordance` damps a positive activation without removing it (re-probe survives, slow recovery). Forbidden ≠ unskilled. |
> | **P3** rupture | #74 | A `class` refusal of the schema being deliberated writes an `agency.revocation` tombstone (reuses EXAFFERENCE P4) — the Will lets go. A refusal contributes ZERO exafferent rupture by construction. |
> | **P4** speech act | #75 | `escalate` HOLDS the intent (executor stops timing it out), voices a first-person ask once, and `WillStem.resolveEscalation` approves (dispatch) / denies (refuse); unanswered → refusal at `ESCALATION_TTL_TICKS = 30`. |
>
> Every phase kept `replay.equivalence` green — the no-policy quiet path is
> byte-identical throughout. Verdict vocabulary (`finality` + `counterfactual`,
> no numeric severity) is deliberately identical to the HELM RFC's proposal.
>
> **Open:** **P5** (the four-value finality taxonomy — *unblocked*, no HELM
> dependency) and **P6** (HELM transport adapter — gated on the schema diff).
> **Deferred refinements:**
> facet-authored escalation voice → [[ESCALATION_VOICE]] (`.TODO/ESCALATION_VOICE.md`);
> counterfactual-driven envelope narrowing → [[ENVELOPE_NARROWING]]
> (`.TODO/ENVELOPE_NARROWING.md`); escalation-payload persistence across
> snapshot/restore — **trivial**: the held invocation is fully reconstructable
> from the escalated intent's own metadata (schema/parameters/target persist in
> sim state, `escalationExpiresAt` too), so it is a ~20-line `restoreEscalations()`
> analogous to `restoreAvailability` — fold into the next policy PR.
>
> Companion reading: `AGENCY_PIPELINE.md` (the pipeline this extends),
> `EXAFFERENCE.md` (provenance, rupture, revocation — the machinery this reuses),
> `CUSTOM_ABILITY_WIRING.md` (host-declared effectors — the surface being gated),
> `RECORD_ANCHORING.md` (the evidence half of the same accountability story).
> **The picture:** `docs/graphs/policy-reafference-loop.svg` — the whole loop in
> one diagram (reach → boundary → three fates → may from can → the field re-forms).
>
> **Motivating context:** evaluation of `helm-ai-kernel` (Mindburn-Labs,
> Apache-2.0) as a candidate external Policy Decision Point, and a live
> collaboration track with its builders. **Nothing here hard-depends on HELM** —
> the seam is provider-agnostic by construction (§P0). HELM is the first adapter,
> not the interface.
>
> **Collaboration status (2026-07-27): the proposal was accepted and returned as
> a bilateral joint RFC** — *"Denials That Teach"* (HELM × Will v0.1, Ivan /
> Fabrice). HELM ships the **producer** half (both receipt fields, opt-in per
> policy profile, absent when disabled); Will is named the **reference consumer**
> in HELM's conformance packs. Two things land on us, and both are recorded
> below as **P5**:
>
> 1. **`finality` widens 2 → 4 values**, mechanically derived from the rule that
>    fired: `class_forbidden` · `ungranted` · `instance_parameter` ·
>    `instance_context`. Three map onto paths we already shipped; the fourth is
>    new (see below).
> 2. **`counterfactual` carries scalar bounds and required-capability names
>    ONLY — never enumerations**, because an allowlist is an infrastructure map
>    and a denial that returns it is an exfiltration primitive. This deletes the
>    `oneOf` branch from [[ENVELOPE_NARROWING]]'s HELM-sourced path.
>
> Reply drafted at `Will-HELM/WILL_REPLY_TO_HELM.md` (answers their §7; asks back
> for counterfactual *direction* — a `relation` field or a `requested` guarantee
> — since a scalar bound alone cannot distinguish a ceiling from a floor, and a
> learner that guesses wrong clamps the wrong way).
> **The picture:** `docs/graphs/policy-joint-rfc.svg` — producer, seam, and the
> four consumer fates in one diagram.

---

## Context: what exists today (audited 2026-07-21)

**Gating is name-level and covers five names.** `access.grants.ts` is the whole
permission primitive:

```ts
isAllowed( name: string ): boolean {
  if( !EXPLICIT_EFFECTORS.has( name ) ) return true   // ← everything else: free
  return this._granted.has( name )
}
```

`EXPLICIT_EFFECTORS` = `listen | talk | text | gesture | broadcast`. Every
host-declared domain effector is **ungated by construction** — `externalSchemas()`
(`schemas/external.ts`) explicitly filters the comms names *out*, so `trade`,
`move`, `use`, `attack` enter the repertoire freely enactable.

**The granularity gap.** A grant answers *"may this ability exist?"* — never
*"may this ability be used **this way**, on **this target**, **this often**?"*.
Granting `talk` grants talking to anyone about anything, forever. Granting a host
`trade` grants any amount with any counterparty. Our own accountability claim
("an ability not granted has no motor schema and can never be enacted",
`RECORD_ANCHORING.md`) is true at the **repertoire** level and silent on **use**.

**Dispatch is already a single choke point.** Everything world-facing funnels
through one bus event:

```
MotorSchemaExecutor._emitDispatch()             motor.schema.executor.ts:530
   └─ bus 'agency.invocation'  { schema, intentId, parameters, targetEntityId,
                                  description, tick }
        └─ stem/tracts/effector.controller.ts   (the host boundary)
             └─ host handler
                  └─ confirmEffectorExecution( intentId, result )
                       └─ ReafferenceEngine → LearnedSkill (value, habit,
                                               prediction error, param priors)
```

That payload is already ~90% of an external PDP's request shape (an action name,
parameters, a target, a correlation handle). The intent sits `awaiting` until
acked or `AWAIT_TIMEOUT` (15) expires. **A verdict has a natural return channel
that already feeds learning — this is the whole opportunity.**

**Enaction is unconditional.** `execution.primitives.ts` `mode: 'external'`
returns success and a description (`"dispatched to the host; awaiting the world's
reply"`). No evaluation, no refusal path, no reason.

**Machinery we do NOT need to build** (shipped by EXAFFERENCE P0–P5):
- `consequence.ts` — descriptors, `fnv1a`, canonical `paramsKey`, TTL sweep.
- `revocation.ts` — `agency.revocation` tombstones, `RUPTURE_REVOKE_GATE = 0.7`,
  the race-free T+1 revocation discipline.
- provenance tagging — so a refusal cannot be mistaken for a world event, and the
  mind cannot rupture itself with its own boundary.
- `situation.stability` — the two-timescale engagement softening.

---

## The insight

Everywhere else a policy `DENY` is a **dead end**: the agent is blocked, a receipt
is written, and the agent holds no representation of what happened — so it tries
again next turn, forever. Will has an ack path that feeds `LearnedSkill`. Routed
through it, refusal becomes **competence-shaping**:

- the Will learns the shape of its own permissions instead of re-probing the wall;
- repeated refusal drives the schema's value down → the ActionSelector stops
  fielding it → **inference spend falls** (the proceduralization curve, run in
  reverse);
- a hard refusal on a high-stakes commitment is *exactly* a rupture, and P4's
  tombstone already lets the mind **let go without a committed successor**.

**The sharp distinction (design-critical):** a refusal is **not a failure**.

| | teaches | signal |
| :--- | :--- | :--- |
| Failure | *"I am not skilled at this"* | competence ↓, stochastic, re-probe is rational |
| Refusal | *"this is not available to me"* | **precondition**, deterministic, re-probe is waste |

Folding a refusal into competence would teach the Will it is *bad at* trading
when in fact it is *forbidden* to trade — and would corrupt param priors with a
signal that has nothing to do with execution quality. **Refusal must land on
availability (affordance gating), not on skill.** This is the single most
important decision in this document.

---

## Target design

One interface, three verdicts, three cognitive fates:

```
  intent selected ──► PolicyArbiter.evaluate( invocation )   ◄── provider adapter
                                    │                             (HELM | local | none)
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
      ALLOW                       DENY                      ESCALATE
        │                           │                           │
   dispatch to host        never reaches the host      intent HOLDS (awaiting),
   (status quo)            │                           ProactiveCommunicator
                           ├─ graded negative ack ─────► voices the ask
                           │  via confirmEffectorExecution
                           ├─ availability prior ↓ on the AFFORDANCE
                           │  (not competence ↓ on the skill)
                           └─ if stakes ≥ gate → rupture → agency.revocation
                                                 tombstone (P4 machinery, reused)
```

- **A. The arbiter seam.** A narrow interface at the stem boundary — *below* the
  SDK, *outside* cognition. The mind never sees a permission dialog; it
  experiences **world resistance**. This is what preserves the facade-subject
  paradigm (a subject that projects, never an agent-function asking approval) and
  it is also the phenomenologically honest model: a body that cannot do the thing.
- **B. Availability priors.** A per-`(schema, paramsKey-class)` availability
  score the **AffordanceSynthesizer** reads when fielding. Refusal decays it;
  slow recovery lets the Will *occasionally re-probe* so a policy change is
  discoverable (a permanently-zeroed affordance can never learn it was un-banned).
- **C. ESCALATE is a speech act.** HELM's `ESCALATE` means "a human can resolve
  this with an exact approval." Will already has a ProactiveCommunicator and an
  escalation buffer. The mind **asks** — in character, in first person — and the
  intent holds rather than failing. This is the most Will-native part of the
  design and has no analogue in any other PDP consumer.

---

## Determinism (non-negotiable)

Byte-for-byte replay is the third verb. The moment verdicts become inputs to
cognition, replay depends on them. Rules:

1. **Verdicts are recorded, never recomputed.** The verdict + reason code + the
   arbiter's identity land on the tape at the tick they arrived. Replay **reads
   them back**; it must never re-call an arbiter. A replay that re-evaluates
   policy is not a replay.
2. **The arbiter is off the deterministic path.** Treat it exactly like the LLM:
   an external oracle whose *output* is recorded. (`AUDITION_REPLY_DETERMINISM.md`
   already established this discipline for completions — mirror it.)
3. **Absent arbiter ⇒ byte-identical.** No arbiter configured must produce a run
   identical to today's, with no new entities or metrics written — the same
   "quiet path stays byte-identical" property EXAFFERENCE P3 proved for
   `situation.stability`. Test it the same way.
4. **No wall-clock, no signature material in cognition.** Receipt timestamps,
   hashes and signer keys are *evidence-layer* concerns; they ride the record
   stream (`RECORD_ANCHORING.md`), never the mind's state. Cognition sees
   `{ verdict, reasonCode, severity }` and nothing else.

---

## Phases

> **Sequencing note:** P0–P2 are the whole thesis and are independently
> shippable. P3–P4 are the mind-native payoff. Do **not** start P5 (any external
> provider) before P0's interface has a local adapter proving the seam.

### P0 — The arbiter interface + null adapter (dark: no behaviour change) ⟶ done (2026-07-21)
- [x] `src/stem/policy/arbiter.ts` — `PolicyArbiter { name, evaluate(inv) }`
      returning `Verdict | Promise<Verdict>`. Provider-agnostic: no HELM types,
      no transport, no Go. `Verdict = { decision, reasonCode?, finality?,
      counterfactual?, detail? }`. **Design change from the sketch:** `severity`
      became `finality: 'class' | 'instance'` and `counterfactual` became
      structured `{ field, requested?, allowed? }` — aligned with the two fields
      we are proposing upstream, so the local adapter and the external one speak
      one vocabulary. `finalityOf()` defaults an unlabelled denial to
      `'instance'` (the conservative reading: narrows the envelope, never
      deletes the ability).
- [x] **Async allowed by construction.** `evaluate` may return a Promise; the
      executor already holds the intent `awaiting` for `AWAIT_TIMEOUT` (15) and
      `drain()` runs every tick, so an external PDP's latency is absorbed by
      machinery that already exists. Both P0 adapters are synchronous, which is
      why P0 changes nothing.
- [x] `NULL_ARBITER` + `isNullArbiter()` — the default. The enforcement point
      takes a fast path that allocates nothing when unconfigured. Full suite
      **1116 passed / 2 skipped (169 files)** including
      `tests/integration/replay.equivalence.test.ts` — the byte-identical
      guarantee holds.
- [x] PEP lives in `effectorController.bufferInvocation`
      (`stem/tracts/effector.controller.ts`) — chosen over the `stem/index.ts`
      subscription because the controller already owns both ends of the loop
      (dispatch *and* `confirmExecution`), so P1's refusal ack lands in the same
      object, and it is testable without booting a simulation.
      `setArbiter( arbiter | null )` installs/clears.
- [x] **Fails CLOSED.** A sync throw or an async rejection withholds the
      invocation — an arbiter fault must never become an implicit allow.
- [x] `RuleTableArbiter` (`stem/policy/rule.table.ts`) — ordered, first-match-wins
      rules scoped by `schema`/`target`, with `require: Record<field,
      ParamConstraint>` on an `allow`. A violated bound flips to deny **carrying
      the counterfactual it just computed** (`{ field, requested, allowed }`) —
      i.e. the local adapter is a working reference implementation of the exact
      upstream proposal. `fallthrough` is a **required** option: a policy
      component that silently defaults open is a trap.
- [x] Tests (`tests/unit/policy.arbiter.test.ts`, 23 cases): null/default/cleared
      fast paths; allow buffers, deny + escalate withhold; only the act crosses
      the boundary (asserted by exact shape); sync-throw and async-reject both
      fail closed; async allow delivers late; rule ordering, target scoping,
      fallthrough posture, class-vs-instance finality, missing parameter,
      `oneOf` sets, first-declared-violation stability, verdict determinism.

**Known-incomplete on purpose:** a refused invocation is currently just never
handed to the host, so the intent dies at the executor's 15-tick await timeout
and reconciles as a plain *failure*. That is safe (the effect never reaches the
world) but crude, and it is exactly the wrong learning signal — P1 replaces it
with an immediate graded refusal ack, P2 routes it to availability instead of
competence.

### P1 — Verdict → ack, the mechanical half ⟶ done (2026-07-21)

**Determinism model, resolved by audit.** The replay-equivalence harness drives
`simulation.step()` directly — NOT the stem tick loop — so `applyInbound` and all
effector-ack handling sit *outside* the replayed unit. That is the codebase's
actual contract: effector acks are external inputs applied by the harness between
steps, with full deterministic re-execution DEFERRED (see `inbound.recorder.ts`).
So a policy refusal is treated as **exactly a host rejection ack**: enqueued during
the step's flush, applied by the harness at the next tick boundary. `bufferInvocation`
writes only harness state during the step, so `simulation.step` determinism is
untouched — the byte-identical guarantee holds trivially (replay-equivalence still
green). The verdict-capture seam ships now; re-execution rides the same deferred
mechanism as inbound acks, and the source interface is ready for it.

- [x] `DENY` no longer waits for the 15-tick timeout. `_applyVerdict` queues a
      `PendingRefusal`; `effectorController.applyPolicyOutcomes(instance)` — wired
      into the stem loop at the `applyInbound` boundary (`stem/index.ts`) — drains
      it through the existing `confirmExecution(intentId, { success: false, … })`,
      the unchanged correlation-handle path. A denial reconciles as a
      host-rejection-shaped `agency.outcome` the following step sees.
- [x] `src/stem/policy/verdict.recorder.ts` — the verdict tape, mirroring
      `completion.recorder.ts` / `inbound.recorder.ts`: willId-keyed
      sink (`recordVerdict`) + strict re-feed source (`RecordedVerdictSource`,
      keyed by `(tick, intentId)`). `bufferInvocation` checks the **source first**
      (replay never re-enters the arbiter), else consults the arbiter and records
      **every** verdict (allow included, so replay reproduces every decision). A
      source miss reproduces a buffered allow (the live run had no verdict there).
- [x] `ESCALATE` withholds from the host but does NOT queue a refusal — the intent
      stays `awaiting`. **P1 deliberately stops here:** it still expires at the
      executor's `AWAIT_TIMEOUT` (15). The extended-TTL hold + resolution path is
      P4's speech act, not a mechanical concern.
- [x] Async arbiters: the `.then` records + applies on resolution; the refusal
      queue drains each tick, so a late verdict still lands. Fails closed on
      rejection (unchanged from P0).
- [x] Tests (`tests/unit/policy.reafference.test.ts`, 12): deny queues → reconciles
      as a failure outcome at the boundary; queue drains once; escalate withholds
      without an outcome; allow reaches the host; async deny reconciles on resolve;
      tape captures deny (with finality + counterfactual) and allow, records nothing
      under a null arbiter; source re-feeds allow/deny **without consulting a
      throwing arbiter**, buffers on a miss, and does not double-record. Full suite
      **1128 passed / 2 skipped (170 files)**, replay-equivalence green. Typecheck clean.

**Still known-incomplete (→ P2):** the refusal reconciles as a plain FAILURE
(`success: false`), the same signal a host rejection or a timeout produces. That is
the wrong lesson — forbidden ≠ unskilled. P2 gives the ack a discriminated
`refused` marker and routes it to affordance AVAILABILITY instead of `LearnedSkill`
competence.

### P2 — Refusal teaches availability, not incompetence ⟶ done (2026-07-21)
- [x] Refused outcomes carry a discriminated `refused: true` + `finality`
      marker (`reconcile.learning.ts` `HostAckResult`; stamped by
      `reconcileInvocation`; set by `applyPolicyOutcomes`). NOT a magic
      `outcomeQuality`.
- [x] The **availability layer** lives in `SchemaRepertoire`, strictly apart from
      `LearnedSkill`: `_availability` map, `recordRefusal(schema, finality, tick)`,
      `availabilityOf(schema)`, recovery folded into `decay()`, mirrored to
      `agency.availability` state entities (`availabilityEntities()` /
      `restoreAvailability()`). Multiplicative cut — **class 0.50, instance 0.12**
      — floored at 0.05 (never zero, re-probe always possible); slow recovery
      (0.02/decay) climbs back and the entry is dropped at full recovery, so a
      long-ago-refused Will returns to the byte-identical quiet path.
- [x] `ReafferenceEngine`: a `refused` outcome routes to `recordRefusal` and
      **stops** — it never touches competence (no `recordOutcome`, no discovery,
      no proceduralization) — while still freeing the awaiting intent and
      signalling a refused plan step unsuccessful so the plan doesn't hang. Emits
      `agency.refused.count` only when it fired (quiet path silent).
- [x] `scoreAffordance` damps a **positive** activation by `availability` and
      never flips a negative one — a refused ability competes weakly but is never
      removed from the field, so re-probe survives and recovers with availability.
      `AffordanceSynthesizer._build` sets `availability` only when `< 1` (omitted
      otherwise ⇒ affordance field byte-identical for a never-refused Will);
      `restoreAvailability` rehydrates it alongside composites.
- [x] **Scope decision (recorded):** P2 keys availability by **schema**, not
      `(schema, paramsKey)`. At fielding time the Will hasn't bound params yet, so
      instance-level *envelope narrowing* can only bite at selection time — a
      distinct, later mechanism. P2 honours class-vs-instance via cut MAGNITUDE
      (class suppresses the ability; instance barely dents it and recovers fast),
      which is the fielding-time-implementable half. Per-params gating is the
      deferred follow-up.
- [x] Tests (`tests/unit/policy.availability.test.ts`, 11): class-hard vs
      instance-light, compounding-but-never-zero, monotone recovery + drop,
      mirror/restore; refusal dents availability + leaves `LearnedSkill`
      undefined; a genuine failure still records competence + leaves availability
      at 1; refusal metric only when fired; activation damped-but-positive,
      byte-identical when absent, recovered restores full weight. Full suite
      **1139 passed / 2 skipped (171 files)**, replay-equivalence green. Typecheck clean.

**The three verbs, now demonstrable.** Gated (P0), and a mind that *learns the
shape of its own permissions* rather than re-probing the wall (P1+P2). What
remains is refinement, not foundation: P3 (refusal as rupture), P4 (escalate as
speech act), P5 (HELM adapter), and the deferred per-params envelope narrowing.

### P3 — Refusal as rupture (reuse P4 machinery) ⟶ done (2026-07-21)
- [x] **`finality` IS the severity signal** (no separate numeric field — keeps the
      vocabulary identical to the HELM proposal). A `class` refusal of the schema
      the Will is currently `deliberating` writes the existing `agency.revocation`
      tombstone (`ActionSelector`, extended P4 block): the Will lets go, no
      successor committed. An `instance` refusal ("not with those params") never
      revokes — a still-deliberating attempt may yet succeed.
- [x] **The invariant, by construction.** A refusal is an `agency.outcome`, never a
      `percept`; `computeRupture` reads only `provenance:'exafferent'` percepts, so
      a refusal contributes ZERO exafferent rupture — the mind cannot rupture
      itself with its own boundary. Policy revocation is a SEPARATE, explicit
      trigger (`refusedClassSchemas`) with its own reason code `'policy-refusal'`
      (vs `'exafferent-rupture'`) and its own metric `agency.policy.revoked`; the
      exafferent scalar, switch-cost softening, and `situation.stability` are all
      untouched. Quiet path (no refusal) is byte-identical — the scan runs only
      when an intent is deliberating and writes nothing when the set is empty.
- [x] Tests (`tests/unit/policy.rupture.test.ts`, 5): a class refusal of the
      deliberating schema tombstones it + emits `agency.policy.revoked` + labels
      the event `policy-refusal`; an instance refusal does not; a class refusal of
      a *different* schema does not; a refused outcome erodes no stability and
      fires no rupture event (zero exafferent contribution); the exafferent path
      still revokes, labelled distinctly. Full suite **1144 passed / 2 skipped
      (172 files)**, replay-equivalence green. Typecheck clean.

### P4 — ESCALATE is a speech act ⟶ done (2026-07-21)
- [x] An `escalate` verdict raises a **held escalation** (`effectorController`):
      the awaiting intent is marked `escalated` + `escalationExpiresAt` in sim
      state (at the boundary, like every effector-ack write), the Will voices a
      first-person ask ONCE, and the payload is kept so an approval can dispatch
      it. `applyPolicyOutcomes` now orchestrates four boundary steps in order:
      resolutions → expiry → new escalations → refusals.
- [x] **The executor holds it** (`motor.schema.executor.ts`, one line): an
      `escalated` awaiting intent is skipped in the timeout loop, so it is never
      reconciled as a phantom timeout-failure — the stem owns its lifecycle. Quiet
      path byte-identical (no intent carries the flag ⇒ the skip never fires).
- [x] The ask is voiced through `cognition.outboxWriter` as a **broadcast** to
      `'*'`, carrying the reason code's *meaning* (`escalationAsk` +
      `ESCALATION_MEANINGS`), not its raw string. Voiced exactly once, at raise
      time — never per tick.
- [x] Resolution API `WillStem.resolveEscalation(id, invocationId, approved)` →
      `effectorController.resolveEscalation`, applied at the next boundary:
      **approve** re-buffers the held invocation (the SAME intent id resumes to
      the world) and releases the hold; **deny** refuses it (class). Unknown /
      already-resolved ids are harmless no-ops.
- [x] **Expiry degrades to a refusal** (instance finality, `ESCALATION_EXPIRED`)
      at `ESCALATION_TTL_TICKS = 30` (2× `AWAIT_TIMEOUT`), so a human has real
      time to answer and an unanswered ask still resolves deterministically.
- [x] Tests (`tests/unit/policy.escalation.test.ts`, 6): held + voiced-exactly-
      once + not-per-tick; approval resumes the same intent id and releases the
      hold; denial writes a refused(class) outcome; unknown-id no-op; expiry at
      the TTL writes a refused(instance) outcome; and the executor holds an
      escalated intent past the await window while still timing out a plain one.
      Full suite **1150 passed / 2 skipped (173 files)**, replay-equivalence
      green. Typecheck clean.

**Honest scope limits (→ follow-ups):** the ask is a stem-side template
(broadcast to `'*'`), not yet facet/LLM-authored in the mind's own voice — the
in-character version is the deferred refinement the phase name aspires to. And
the held escalation's payload is harness state (like `pendingEffectorInvocations`),
so it does not survive a snapshot/restore — a restored escalation would expire to
a refusal rather than resume. Both are acceptable for the mechanism; neither
changes the lifecycle.

### P5 — The four-value finality taxonomy — UNBLOCKED (no HELM dependency)

The joint RFC's enum is a **vocabulary**, not a transport. It can be adopted
entirely against the local `RuleTableArbiter`, and it should be — it is what
makes the P6 adapter a four-arm switch instead of a semantic negotiation.

- [ ] **Widen `DenialFinality`** to HELM's spelling on the deny branch:
      `'class_forbidden' | 'instance_parameter' | 'instance_context'`.
      `ungranted` does **not** join it — it maps to our existing
      `decision: 'escalate'` (see the axis note below). `finalityOf()`'s
      conservative default becomes `'instance_parameter'`.
- [ ] **`instance_context` — the new fate: touch NOTHING.** A context/taint
      refusal is not about the ability, so denting its availability teaches a
      lesson the policy never taught. Record the verdict, free the awaiting
      intent, signal the plan step, and stop — no availability delta, no
      envelope, no competence. This is a fourth branch in the ReafferenceEngine's
      refused path, and it **corrects current behaviour**: today every instance
      denial dents availability by 0.12 regardless of cause.
- [ ] **Fix the arbiter-fault path (conformance S9 — we currently fail it).**
      A sync throw / async rejection fails closed correctly (the effect is
      withheld, `effector.controller.ts:137`) but queues no refusal, so the held
      intent expires at `AWAIT_TIMEOUT` and reconciles as a **plain failure** —
      landing on competence. A PDP outage must never teach a mind it is
      unskilled. Queue an `instance_context`-shaped refusal instead (touch
      nothing), reason code `ARBITER_UNAVAILABLE`.
- [ ] Tests: each of the four values drives exactly its own fate and no other
      (the S1–S9 matrix, minus the transport-dependent ones); `instance_context`
      leaves availability, envelopes and `LearnedSkill` all provably untouched;
      an arbiter fault records no competence; quiet path still byte-identical.

**The axis note (recorded, because it will come up again).** HELM is fail-closed,
so every receipt is allow-or-deny and `ungranted` is a *denial shape* meaning "a
human could grant this." Will keeps a third **decision** because an escalation is
not a denial here: the intent is HELD, the timeout clock stops, and an approval
dispatches **the same intent id** — it is the original reach resumed, not a
retry. Three of HELM's values are `<scope>_<reason>`; `ungranted` is neither, and
that asymmetry is the tell that it lives on a different axis. We proposed a
`resolvable: true` flag orthogonal to a three-value enum (it would also express
"bound exceeded, but an operator could raise it" — inexpressible today); if
upstream declines, the four-arm mapping works unchanged.

### P6 — HELM adapter (external PDP) — gated on the schema diff
- [ ] Adapter mapping `agency.invocation` → HELM's `WorkstationDecisionRequest`,
      and `WorkstationPolicyDecisionReceipt` → `Verdict`. With P5 done this is a
      four-arm switch plus transport.
- [ ] Transport decision (subprocess CLI vs. `helm-ai-kernel serve` HTTP).
      **Must stay optional** — the OSS engine never hard-depends on a Go binary.
- [ ] Receipts flow to the record stream, not to cognition (determinism rule 4);
      this is where this document meets `RECORD_ANCHORING.md`.
- [ ] **Bilateral-determinism demo** (the joint RFC's §5 centerpiece): a seeded
      Will against a frozen policy snapshot, replayed tick-for-tick. Our half
      already holds — verdicts are taped and re-fed, the arbiter is never
      re-consulted on replay; HELM commits to computing the counterfactual from
      the same snapshot as the verdict.
- [ ] **Conformance fixtures S1–S9** contributed upstream (seeded mind + frozen
      policy snapshot + expected state deltas). S6 (*a relaxed policy is
      rediscovered without a restart*) is the one worth arguing hardest for: a
      consumer that zeroes a forbidden ability permanently degenerates back into
      a static blocklist.

---

## Scope notes

- **Engine touchpoints:** `stem/policy/arbiter.ts` (new),
  `stem/tracts/effector.controller.ts`, `agency/engines/reafference.engine.ts`,
  `agency/engines/affordance.synthesizer.ts`, `agency/schemas/repertoire.ts`
  (availability prior alongside `LearnedSkill`).
- **NOT in scope:** replacing `AccessGrants` (it stays as the coarse repertoire
  gate — this is the *fine* gate below it); key management; receipt verification
  UX; backend/Studio surfacing; policy *authoring* (the arbiter consumes policy,
  it does not define it).
- **Open question:** does the arbiter see *composite* intents, or only the
  primitive sub-intents they expand into? Leaning primitives-only (the executor
  already expands before enaction, and a composite has no single effect) — but a
  policy that wants to forbid a *sequence* would need the parent. Decide in P0.
- **Open question:** `communicate` mode currently passes through `AccessGrants`
  only. Should the arbiter also see comms acts (content-level policy), or is that
  a step too far into the mind? Leaning yes-but-P6 — it is the same seam, but the
  paradigm risk is much higher when the thing being refused is *speech*.

## Related

- `.TODO/RECORD_ANCHORING.md` — the **evidenced** verb. This doc is the
  **gated** verb. Together with replay they are the full three-verb story, and
  they should ship in that order (gated → evidenced) so there is something worth
  anchoring.
- `.TODO/EXAFFERENCE.md` — P4 revocation + provenance are reused wholesale here.
- `.TODO/CUSTOM_ABILITY_WIRING.md` — the host-effector surface this gates.

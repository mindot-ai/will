# POLICY_REAFFERENCE — the boundary as a sense: policy verdicts routed through reafference

> **Status:** OPEN — designed 2026-07-21. Goal: give the Will a **body that
> cannot do forbidden things**, and make the refusal something the mind *learns
> from* rather than a wall it re-discovers every tick. A policy verdict stops
> being an exception thrown at the host and becomes **graded reafference**: the
> world answering "not that", in the same currency as every other outcome.
>
> Companion reading: `AGENCY_PIPELINE.md` (the pipeline this extends),
> `EXAFFERENCE.md` (provenance, rupture, revocation — the machinery this reuses),
> `CUSTOM_ABILITY_WIRING.md` (host-declared effectors — the surface being gated),
> `RECORD_ANCHORING.md` (the evidence half of the same accountability story).
>
> **Motivating context:** evaluation of `helm-ai-kernel` (Mindburn-Labs,
> Apache-2.0) as a candidate external Policy Decision Point, and a live
> collaboration track with its builders. **Nothing here hard-depends on HELM** —
> the seam is provider-agnostic by construction (§P0). HELM is the first adapter,
> not the interface.

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

### P1 — Verdict → ack, the mechanical half
- [ ] `DENY` short-circuits dispatch and returns through
      `confirmEffectorExecution( intentId, { success: false, ... } )` — reusing
      the existing correlation handle, so the executor's await path is untouched.
- [ ] Verdict recorded on the tape (determinism rule 1). Replay reads it back.
- [ ] `ESCALATE` holds the intent `awaiting` without consuming the timeout.
      (Timeout semantics: an escalation that is never resolved must eventually
      expire — decide TTL here, likely `AWAIT_TIMEOUT × 2`.)
- [ ] Tests: deny blocks the host handler; verdict survives snapshot/restore;
      replay determinism (identical tape → identical run); null adapter
      byte-identical.

### P2 — Refusal teaches availability, not incompetence
- [ ] ReafferenceEngine distinguishes a refused outcome from a failed one
      (a discriminated field on the ack, not a magic `outcomeQuality`).
- [ ] Refusal updates a **availability prior** keyed by `(schema, paramsKey)`;
      it must **not** touch `LearnedSkill` value/habit/param-priors.
- [ ] AffordanceSynthesizer reads availability when fielding; slow recovery
      permits re-probe (pick the constant with the same care as
      `CONSEQUENCE_TTL_TICKS`).
- [ ] Tests: repeated refusal suppresses fielding; competence for the same
      schema is unchanged; recovery re-fields after N ticks; a *failure* still
      moves competence normally (no cross-contamination).

### P3 — Refusal as rupture (reuse P4 machinery)
- [ ] Map `severity` → rupture. At/above `RUPTURE_REVOKE_GATE` (0.7) write the
      existing `agency.revocation` tombstone: the Will **lets go** of a
      commitment it was still deliberating, no successor committed.
- [ ] Provenance: a refusal is self-caused (carries `intentId`) ⇒ **reafferent by
      construction**. Assert it can never be counted as exafferent salience —
      the mind must not be able to rupture itself with its own boundary.
- [ ] Tests: high-severity refusal revokes a `deliberating` intent T+1;
      low-severity does not; refusal contributes zero exafferent rupture.

### P4 — ESCALATE is a speech act
- [ ] ProactiveCommunicator voices the ask in first person, carrying the
      reason code's *meaning* (not its string) — "I can't send that on my own;
      I'd need you to allow it."
- [ ] Resolution path: approval → the held intent proceeds; denial → P1 refusal.
- [ ] Tests: escalation produces exactly one utterance (not one per tick);
      approval resumes the *same* intent id; expiry degrades to refusal.

### P5 — HELM adapter (external PDP) — gated on the collaboration track
- [ ] Adapter mapping `agency.invocation` → HELM's `WorkstationDecisionRequest`,
      and `WorkstationPolicyDecisionReceipt` → `Verdict`.
- [ ] Transport decision (subprocess CLI vs. `helm-ai-kernel serve` HTTP).
      **Must stay optional** — the OSS engine never hard-depends on a Go binary.
- [ ] Receipts flow to the record stream, not to cognition (determinism rule 4);
      this is where this document meets `RECORD_ANCHORING.md`.
- [ ] Upstream asks tracked separately (async correlated verdicts, graded +
      counterfactual denials, a non-workstation effect taxonomy, a documented
      deterministic mode). See the collaboration notes, not this file.

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

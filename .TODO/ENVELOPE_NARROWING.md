# ENVELOPE_NARROWING — the counterfactual, consumed: refusals narrow reach, not ability

> **Status:** OPEN — designed 2026-07-22. Goal: make an *instance* refusal teach
> the Will **how much of an ability it may use** — "not 500; up to 100" — instead
> of lightly denting the whole schema. The counterfactual a policy denial already
> carries (`{ field, requested, allowed }`) is today recorded on the verdict tape
> and consumed by NOTHING. This item closes that loop: the Will starts reaching
> for what it *may* have.
>
> This also makes Will the first real consumer of the `counterfactual` receipt
> field proposed upstream to HELM — the strongest possible argument for that
> proposal is a mind demonstrably learning from it.
>
> Companion reading: `POLICY_REAFFERENCE.md` (P2 — the availability layer this
> refines; the scope decision it defers to here is recorded there).
>
> ---
>
> **UPDATE 2026-07-27 — the upstream proposal was ACCEPTED**, returned as the
> bilateral joint RFC *"Denials That Teach"* (HELM × Will v0.1). HELM ships
> `counterfactual` on denial receipts, opt-in per policy profile. This item is no
> longer speculative: it is **the consumer half of a shipped wire field**, and
> Will is named the reference consumer in HELM's conformance packs. Three
> consequences for the design below:
>
> 1. **`oneOf` is dropped from the HELM path.** Counterfactuals carry *scalar
>    bounds and required-capability names only — never enumerations*, because an
>    allowlist is an infrastructure map and a denial that returns it is an
>    exfiltration primitive. `oneOf` survives only for the local
>    `RuleTableArbiter`, which is trusted and in-process. The HELM-sourced
>    envelope is effectively `{ max?, min? }`.
> 2. **Only `instance_parameter` feeds this layer.** Under the four-value enum
>    ([[POLICY_REAFFERENCE]] P5), `instance_context` must touch nothing and
>    `class_forbidden` **erases** stored envelopes — which settles the open
>    question at the bottom of this file. A required-capability counterfactual is
>    not envelope knowledge at all; it rides `ungranted` and makes the escalation
>    ask *specific* ("I need `fs:write`") rather than generic.
> 3. **Direction is an open upstream ask.** A scalar `allowed` alone cannot
>    distinguish a ceiling from a floor; a learner that guesses wrong clamps the
>    wrong way, which is worse than not learning. We asked for either a
>    `relation: 'max'|'min'|'eq'` field or a guarantee that `requested` is always
>    present (so direction is recoverable by comparison). **P1 below must not be
>    implemented until this is settled** — it decides the fold.

---

## Context: what exists today (audited 2026-07-22)

**P2 keys availability by SCHEMA.** A `class` refusal suppresses the ability
hard; an `instance` refusal ("not with those parameters") dents it lightly and
recovers fast. That was the honest fielding-time cut: when the AffordanceSynthesizer
builds the field, **parameters are not bound yet** — the executive/deliberation
supplies args later, and habitual enaction pulls them from `paramPriors`. So
instance-level knowledge cannot bite at fielding. It has to bite where params
exist: **deliberation and enaction.**

**The counterfactual is dropped twice.** The arbiter's denial carries
`counterfactual: { field, requested, allowed }` (rule.table.ts returns it; the
HELM adapter would too). It reaches (1) the verdict tape (`verdict.recorder.ts`)
and (2) the `[policy] DENY …` log line — and nothing else. The refusal ack built
in `applyPolicyOutcomes` forwards `refused` + `finality` only, so by the time the
ReafferenceEngine sees the outcome, the *envelope information is gone*.

**The learning asymmetry this creates:** a Will refused `trade(500)` under a
max-100 policy currently learns only "trade is slightly less available." The
policy told it exactly what would have worked. It should learn *that*.

---

## The principle

> **The envelope shapes reach; the arbiter remains the law.**

The learned envelope is a PRIOR, never a gate. Will must not locally pre-refuse
params outside the envelope — policy can change, and a local gate would freeze a
stale rule and kill re-probe (the exact failure mode P2's recovery avoids).
The envelope biases what the Will reaches for; the arbiter still judges every
dispatch. Symmetrically: an *allowed* enaction outside a stale envelope loosens
it (the world just proved the bound moved).

---

## Target design

```
  instance refusal + counterfactual { field, requested, allowed }
      │
      ▼  (thread it through the ack — it is dropped today)
  PendingRefusal → confirmExecution → reconcileInvocation → agency.outcome
      │
      ▼  ReafferenceEngine (refused branch, P2)
  repertoire.recordEnvelope( schema, field, allowed, tick )     NEW layer,
      │                                                          sibling of
      ├─ mirrored to `agency.envelope` entities (+ restore)      availability
      │
      ├─► habitual enaction (executor): params drawn from paramPriors are
      │   CLAMPED to the envelope — the habit reaches for what it may have
      │
      └─► deliberate articulation (facet context): the envelope rides into the
          deliberation as knowledge — "amounts above 100 have been refused" —
          so authored args comply by understanding, not by clamp
```

- **Store:** per-`(schema, field)` bounds in the repertoire —
  `{ max?, min?, oneOf?, lastRefusedTick }` — folded from counterfactuals
  (numeric `allowed` ⇒ max/min by `relation` if upstream supplies it, else by
  comparison with `requested`; array ⇒ oneOf, **local arbiter only** — HELM never
  sends enumerations, see the 2026-07-27 update).
  Same lifecycle discipline as availability: empty until fed (byte-identical
  quiet path), slow decay toward open so a relaxed policy is re-discoverable,
  entry dropped when fully open, mirror + restore entities.
- **Two consumption points, deliberately different:** the *habit* path is
  clamped mechanically (habits carry no understanding; the clamp is the
  understanding), while the *deliberate* path is informed, not clamped — the
  facet should know the bound and choose within it, and an over-bound deliberate
  choice still goes to the arbiter (which may say yes: the envelope could be
  stale).
- **Loosening:** an ALLOW outcome whose params exceed a stored bound relaxes the
  bound toward what was just permitted. Cheap, and it keeps the envelope honest
  in both directions.

## Phases

### P0 — Thread the counterfactual through the ack (it is dropped today)
- [ ] `PendingRefusal` carries `counterfactual?`; `applyPolicyOutcomes` forwards
      it; `HostAckResult` + `reconcileInvocation` stamp it onto the refused
      `agency.outcome`. Tape ↔ outcome now agree.

### P1 — The envelope layer in the repertoire
- [ ] `recordEnvelope`, `envelopeOf(schema)`, decay-toward-open in `decay()`,
      `agency.envelope` mirror + restore. Quiet path writes nothing.
- [ ] ReafferenceEngine's refused branch feeds it (instance finality with a
      counterfactual only; class refusals stay availability's business).
- [ ] Loosening on ALLOW outcomes that exceed a stored bound.

### P2 — Consumption
- [ ] Executor: clamp habitual (paramPriors-sourced) params to the envelope at
      enaction; count `agency.envelope.clamped` only when it fired.
- [ ] Deliberation: envelope rides the facet context for the schema being
      deliberated (a one-line knowledge item, not an instruction).
- [ ] Tests: counterfactual survives ack→outcome; refusal(500, max 100) ⇒ next
      habitual enaction ≤ 100; deliberate context carries the bound; an ALLOW at
      120 relaxes the bound; decay re-opens; competence untouched throughout;
      quiet path byte-identical.

## Scope notes

- **NOT in scope:** local pre-refusal (the arbiter remains the law); per-target
  envelopes (field-level only, first); surfacing envelopes in Studio.
- ~~**Open question:** should a `class` refusal also *erase* stored envelopes?~~
  **SETTLED 2026-07-27 — erase.** The joint RFC's §4 makes it normative
  consumer behavior for `class_forbidden` ("erase stored envelopes; stop
  probing"), which matches where we were leaning anyway.
- **Prerequisite:** [[POLICY_REAFFERENCE]] **P5** (the four-value taxonomy)
  lands first — this layer must be fed by `instance_parameter` alone, and that
  value does not exist until P5 widens the enum.

## Related

- `.TODO/POLICY_REAFFERENCE.md` — P2's recorded scope decision defers here.
- The HELM RFC (`counterfactual` receipt field) — this item is its consumer.

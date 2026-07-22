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
  (numeric `allowed` ⇒ max/min by comparison with `requested`; array ⇒ oneOf).
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
- **Open question:** should a `class` refusal also *erase* stored envelopes for
  the schema (a "never" makes bounds moot), or leave them to decay? Leaning
  erase — cheaper than carrying dead knowledge.

## Related

- `.TODO/POLICY_REAFFERENCE.md` — P2's recorded scope decision defers here.
- The HELM RFC (`counterfactual` receipt field) — this item is its consumer.

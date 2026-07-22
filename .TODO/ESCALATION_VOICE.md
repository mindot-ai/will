# ESCALATION_VOICE — the escalation ask in the mind's own voice

> **Status:** OPEN — designed 2026-07-21. Goal: replace the stem's fixed-template
> escalation ask (POLICY_REAFFERENCE P4) with words the Will actually *authors* —
> first person, grounded in its persona, identity, memory, and how it feels about
> the thing it's being stopped from doing — while keeping the deterministic
> template as the floor. The mechanism (hold → ask → resolve → expire) is done;
> this is only about *whose voice* speaks the ask.
>
> Companion reading: `POLICY_REAFFERENCE.md` (P4 — the escalation lifecycle this
> refines), `AGENCY_PIPELINE.md` (the self-initiated communicate path this reuses).

---

## Context: what exists today (audited 2026-07-21)

P4 raises a held escalation in the **stem** (`effectorController`): the awaiting
intent is marked `escalated`, the executor stops timing it out, and the ask is
voiced ONCE via `cognition.outboxWriter.enqueue({ effectorName: 'broadcast',
targetEntityId: '*', content })`. The content is a stem-side template
(`escalationAsk` + `ESCALATION_MEANINGS`): reason code → a fixed phrase, plus the
schema name. Deterministic, synchronous, one utterance — good for replay and the
P4 tests, but **not the mind's voice**: no persona, no feeling, no memory.

**The authoring seam already exists** — for self-initiated outreach, not for
escalations. `AuditionEngine.authorOutreach(entityId, entityName, gist)` spawns a
transient `'outreach'` executive facet (the unified conversation voice — same
persona/identity/memory grounding as a reply), reasons through the LLM, and
returns authored bubbles. The `MotorSchemaExecutor` already uses it
(`attachOutreachAuthor(auditionEngine)`): a self-initiated communicate gets its
**words from `authorOutreach`** and its **delivery from the ProactiveCommunicator**.
Author and deliver are already two distinct stages. The escalation ask should
ride that same path — it does not today because the escalation is detected in the
stem, below cognition, which cannot recruit a facet.

**Two structural obstacles** (both real, neither fatal):

1. **Layer boundary + async.** Authoring lives in cognition and is async (the
   facet LLM authors in ~8–18s, spanning ticks). The stem cannot call it. So the
   facet voice needs a **stem→cognition signal**: the stem raises + holds + emits
   a signal; a cognition-side consumer authors and delivers. The template stays as
   the synchronous fallback.
2. **No addressee.** `authorOutreach` needs `(entityId, entityName)` — a target.
   An escalation's real addressee is the **operator/owner**, and there is NO
   modeled operator entity in the mind's world (grep confirms: "operator" always
   means the human deploying the Will — config/persona supplier — never an entity
   the mind perceives or holds a relationship with). P4 sidesteps this by
   broadcasting to `'*'`. The facet voice cannot: to speak *to* someone it needs
   someone to speak to. **This is the load-bearing prerequisite**, and it is
   bigger than the voice itself.

---

## The prerequisite: an operator/owner entity

Before the Will can author an ask *to its operator*, the operator must exist in
its world as an entity it can perceive, remember, and hold a stance toward — the
same way a conversation partner does. Options, cheapest first:

- **A. A well-known operator entity id**, seeded at assembly from config (e.g.
  `owner` / `operator:<id>` with a display name). The mind treats it as a known
  entity: outreach can address it, memory can accrue about it, affect can attach
  to it. Minimal, and it makes the operator a *first-class relationship* — which
  is arguably correct: a Will that must ask permission has an authority in its
  world, and modelling that honestly is better than a faceless broadcast.
- **B. Address the action's target** (the entity the effector was aimed at).
  Rejected: semantically wrong — asking Bob for permission to trade *with* Bob.
- **C. Keep broadcasting to `'*'`** but let the facet author the words. Possible,
  but a first-person ask to no-one-in-particular reads oddly and the facet has no
  addressee to ground tone. Acceptable only as an interim.

**Recommendation: A.** It unlocks the voice *and* is the more honest world-model —
and it likely pays off beyond escalations (an owner the Will can thank, update,
or defer to). It should be decided as its own small design note, because it
touches assembly, the known-entity tracker, and possibly affect.

---

## Target design

Keep the stem template as the deterministic FLOOR; layer the facet voice on top,
superseding the template only when an executive is attached and an addressee
exists. The escalation lifecycle (hold/resolve/expire) is untouched.

```
  stem: escalate verdict
    → mark intent escalated + hold                    (unchanged, P4)
    → emit `agency.escalation.raised` signal          (NEW: intentId, schema, reasonCode, meaning)
    → voice TEMPLATE ask once                          (unchanged — the floor)

  cognition: consumer of `agency.escalation.raised`
    → if executive attached AND operator entity known:
        authorOutreach( operatorId, operatorName, gist = the ask's meaning )
        → deliver authored bubbles to the operator     (supersedes/updates the template row)
    → else: the template row stands
```

- **The signal is the seam.** The stem already knows everything the ask needs
  (schema, reason code, meaning); it hands that to cognition as a bus event or a
  transient `agency.escalation` entity. The consumer (a small engine, or the
  ProactiveCommunicator's owner) turns it into an outreach.
- **The template is never removed.** It guarantees "exactly one utterance,
  synchronously, deterministically" — the property P4's tests and replay depend
  on. The facet voice is an *enrichment* that arrives a few ticks later; if it
  never arrives (no executive, budget full, timeout), the floor already spoke.
- **Determinism is preserved.** Facet words go through the LLM, which is
  recorded/replayed via `completion.recorder` — so the authored ask is replay-safe
  exactly like every other facet utterance. The only change is timing (the ask
  arrives async), which is fine for an outreach.

---

## Phases

### P0 — Operator/owner entity (the prerequisite)
- [ ] Decide + seed a well-known operator entity from config at assembly
      (id + display name); make it a known entity the outreach path can address.
      Likely its own note (`OPERATOR_ENTITY.md`) — it is bigger than the voice.

### P1 — The stem→cognition signal
- [ ] `effectorController` emits `agency.escalation.raised` (intentId, schema,
      reasonCode, meaning) when it raises an escalation. Template voicing stays.
- [ ] Assert the signal is emitted exactly once per escalation (not per tick).

### P2 — Facet authoring + delivery
- [ ] A cognition consumer recruits `authorOutreach(operatorId, operatorName,
      gist=meaning)` and delivers the authored bubbles to the operator, replacing
      or following the template row.
- [ ] Fallback discipline: no executive / budget full / author timeout ⇒ the
      template floor stands; never zero utterances, never double-asks.
- [ ] Tests: with an executive + operator, the ask is facet-authored (persona
      grounded), still exactly one logical ask; without, the template stands;
      determinism holds (authored words re-fed from the completion tape).

---

## Scope notes

- **NOT in scope:** changing the escalation lifecycle (hold/resolve/expire — P4
  owns it), the resolution API, or the verdict path. This is voice only.
- **Open question:** does the operator hear the ask through the same channel as
  everyone else, or a dedicated operator channel? Probably a dedicated one (an
  approval UI), which argues for the operator-entity + a channel binding.
- **Open question:** should the *authored* ask also carry the machine-readable
  approval handle (intentId) so an approval UI can call `resolveEscalation`
  without parsing prose? Yes — the words are for the human; the handle rides the
  outbox row's metadata for the UI.

## Related

- `.TODO/POLICY_REAFFERENCE.md` — P4 is the lifecycle; this is its voice.
- A future `OPERATOR_ENTITY.md` — the prerequisite world-model change (P0 above).

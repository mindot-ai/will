# EXAFFERENCE_TODO — corollary discharge + the exafferent interrupt (commitment revocation)

> **Status:** OPEN — designed 2026-07-19. Goal: make the reafferent/exafferent split a
> *cognitive* judgment instead of a transport accident, and let exafference not just
> recruit the executive but **revoke the agency's current commitment** — the agency's
> function becomes not only independent choice of action in a situation, but
> **engagement that is dependent on situation shifts**.
>
> Companion reading: `AGENCY_PIPELINE.md` (the pipeline this extends),
> `PREDICTIVE_SUBSTRATE.md` (the GenerativeModel this leans on),
> `PLANNING_AS_PRIOR.md` (plan priors ride the same competition).

---

## Context: what exists today (audited 2026-07-19)

**The self/world split is correlational, not simulational.** The MotorSchemaExecutor
emits an **efference copy** (predicted reward/valence, `types.ts` `EfferenceCopy`)
*before* enacting and persists it for reconciliation
(`motor.schema.executor.ts` header + the async-hold path). The host's ack returns via
`confirmEffectorExecution` with the intent id as correlation handle; the
ReafferenceEngine folds predicted-vs-actual into value/habit/param-priors/competence
(`reafference.engine.ts`). So "self-caused" = "carries my intent id" — and everything
*without* a handle is exafferent **by default**, flowing percept → perceptual engines →
GenerativeModel (`observe()` → `{ error, normalized, gated, salience }`) → workspace
gate (`WORKSPACE_THRESHOLD`, executive.engine) → AffordanceSynthesizer.

**Preemption exists, but is field-mediated only** (`action.selector.ts`, "the smarter
serializer"):
- In-flight classification: `awaiting` + `expanding` are PREEMPTIBLE; `deliberating`
  and a standalone `selected` **BLOCK unconditionally** (race-safe rule).
- An `awaiting` incumbent carries switch-cost hysteresis
  (`BASE_SWITCH_COST` ⊕ persona `switchCost` prior, hardened by shared
  `task_switch.current_focus_ticks` — "one disposition, two owners" with the
  TaskSwitcher), scaled DOWN by the challenger's stakes; staleness decays it
  (`AWAIT_STALE_TICKS` = executor `AWAIT_TIMEOUT` = 15).
- Composite preemption is **cancel-only** (delete parent; current sub drains; next
  tick re-selects) — the comment itself flags "immediate-switch composite preemption
  needs deferred macro-advance".
- `agency.action.preempted` is published; a deliberating challenger carries
  `preemptedFrom` so the facet owns the interruption in-character (Channel B,
  `deliberation.engine.ts`).

**The three gaps** (from the exafference review, 2026-07-19):

1. **No sensory corollary discharge.** The efference copy reaches *reconciliation*,
   never *perception*. Sensory consequences of our own actions — the channel echoing
   our message, a user quoting us back, the observable downstream effect of an
   effector — read as exafference. Today the only guard is the channel bridges
   dropping self-authored events: corollary discharge as a transport hack, boolean
   and per-channel, not graded and not general.
2. **No exafferent interrupt.** The world can only revoke commitment by *fielding a
   stronger affordance* and beating hysteresis. A rupture-grade world event cannot
   touch a `deliberating` intent at all, cannot soften commitment globally, and
   cannot make the mind *let go before knowing what comes next*. Revocation is
   currently only ever displacement-by-winner.
3. **Engagement is one-way.** Focus ticks and conscientiousness *harden* switch
   resistance; nothing *softens* it when the situation destabilizes. Engagement
   should be a function of situation stability, not only of how long we've been
   staring at the task.

---

## Target design

Three mechanisms, one currency (prediction error), zero new blocking work in the tick:

```
             efference copy ──────────────┐ (P1: + expected-consequence descriptors, TTL)
                                          ▼
percept in ──► corollary-discharge match ─┬─ match → provenance:'reafferent',
                                          │          salience × ATTENUATION, intentId link
                                          └─ miss  → provenance:'exafferent' (default)
                                                        │
                    (P3) rupture = f(exafferent salience, gated prediction-error spikes)
                                                        │
        ┌───────────────────────────────────────────────┼─────────────────────────┐
        ▼                                               ▼                         ▼
  workspace gate                            ActionSelector:                 situation.stability
  (existing — recruits                      switch-cost × (1−rupture),      EMA metric — the
  the executive; unchanged)                 awaiting-hysteresis → 0,        TaskSwitcher's focus
                                            (P4) revoke 'deliberating',    hardening reads it too
                                            emit agency.commitment.revoked
```

- **A. Corollary discharge** — the executor already emits the efference copy at
  enaction; extend that moment to also register **expected-consequence descriptors**:
  `{ intentId, schema, channel/target hints, match keys (outbound message id / content
  hash / effector name+target), ttlTick }`. A deterministic matcher at the percept
  boundary tags each new percept `provenance: 'reafferent' | 'exafferent'`; matches
  get salience attenuated (not zeroed — a *surprising* consequence of our own action
  should still be able to climb) and carry the intentId so sensory consequences can
  reconcile/learn later (P5). Bridges keep their hard self-drop as a transport guard;
  cognition gains the graded judgment.
- **B. The rupture channel** — a per-tick scalar computed pull-style from frozen
  state (no new engine ordering hazards): magnitude of *exafferent-tagged* salience
  crossing a gate, plus workspace-gated prediction-error spikes. Rupture:
  (1) scales `effectiveSwitchCost` down (engagement softening), (2) floors the
  awaiting incumbent's hysteresis toward zero, (3) at high magnitude **revokes
  blocking commitments** — cancel a `deliberating` intent (facet-orphan-safe) and
  emit **`agency.commitment.revoked`**: letting go *without* a committed successor;
  next tick's competition decides over a freshly synthesized field. Because
  provenance-tagged, **the mind cannot be ruptured by its own echo** — that's why A
  must land before B is armed.
- **C. Situation-dependent engagement** — a `situation.stability` EMA (decays toward
  stable, knocked down by rupture) that *both* owners of switch resistance read: the
  selector's `effectiveSwitchCost` and the TaskSwitcher's focus hardening. Stability
  permits hardening; instability floors it. One disposition, two owners, now with a
  shared third input at their native scales.

**Explicit non-goals here:** action-conditioned prediction (waking GenerativeModel's
dead `predict()` surface to make forward-model exafference detection) is the natural
sequel but a separate TODO; standalone `selected` stays blocking (it resolves within
a tick — the race-safe rule is correct); no LLM in any matching path.

---

## Phases (each its own green PR; monolith behavior byte-identical until armed)

### P0 — Decisions + safety audit (no code) ⟶ done (2026-07-19)
- [x] **Orphan-safety audit — naive delete is UNSAFE (resurrection race).** The
      Deliberator itself is stateless across ticks (pickup → facet → commit happen
      inside one `react()`, re-read from frozen state each tick — no dangling
      handle to a vanished intent). The hazard is *command application order*:
      registration order is Synthesizer → **Selector → Deliberation** → Executor →
      Reafference (`mind.ts`), so a same-tick selector `delete` + deliberation
      `set` on the same intent id applies set-after-delete — the intent is
      **resurrected as `selected`** and the executor enacts it despite revocation.
      **P4 design amended accordingly (tombstone, below).**
- [x] **Match-key inventory + descriptor schema.** Two world-facing enaction
      moments in the executor: (1) sync-delivered communicate (`_deliver` success —
      keys: `textHash` over the authored bubbles, `targetEntityId`, effector);
      (2) the async `'awaiting'` hold for communicate-unauthored/external (keys:
      schema/effector + `targetEntityId` + `paramsHash`). Host acks already
      correlate by intent id — descriptors cover the *sensory* footprint only.
      Sync innate enactions get **no** descriptor (internal effects; noise).
      `CONSEQUENCE_TTL_TICKS = 30` (2 × `AWAIT_TIMEOUT`).
- [x] **Gates decided:** `RUPTURE_SALIENCE_GATE = 0.4` (= `WORKSPACE_THRESHOLD`,
      executive.engine/config.ts — rupture ≈ "would seize the workspace"),
      `RUPTURE_REVOKE_GATE = 0.7`, `ATTENUATION = 0.25`. Constants land beside the
      selector's gate constants; persona-tunability deferred.
- [x] **Bridge self-drop confirmed additive:** `channels/whatsapp.ts:133`
      (`m.key.fromMe` → return) and `channels/discord.ts:101`
      (`author.id === self.id || author.bot` → return). Transport guard stays;
      P2's tagging is the graded layer above it.

> **P0 amendments to later phases:**
> - **P1:** descriptors expire at their own TTL **only** — *not* on intent
>   resolution. A host ack does not stop the sensory echo from arriving two ticks
>   later; the descriptor must outlive the intent to catch it (TTL 30 > await
>   timeout 15 covers the stranded case too, and one sweep is simpler than two).
> - **P4:** revocation must **never delete a `deliberating` intent from the
>   selector directly.** Instead the selector writes a separate **tombstone
>   entity** (`agency.revocation`, keyed by intent id — no same-entity write
>   race). One tick later both honor it from frozen state: the Deliberation
>   engine skips + deletes tombstoned intents before deliberating; the Executor
>   refuses to enact a `selected` intent whose tombstone exists (covers the
>   half-race where deliberation committed `selected` the same tick the tombstone
>   landed). Cost: revocation takes effect T+1 — acceptable, deterministic,
>   race-free by construction.

### P1 — Expected-consequence descriptors (dark: no consumer)
- [ ] Executor: at the efference-copy moment, also write descriptor records
      (entity or engine-state map keyed by intentId; TTL tick-denominated;
      snapshot/restore round-trips — FN9). Composite expansion registers per-sub
      descriptors as each sub enacts.
- [ ] Expire descriptors at their own TTL only (P0 amendment: they deliberately
      outlive intent resolution — the echo arrives after the ack).
- [ ] Tests: lifecycle (register → resolve/expire), TTL under fixed clock, replay
      determinism (descriptors identical across replays), snapshot round-trip.

### P2 — Corollary-discharge matcher (percepts gain provenance)
- [ ] Deterministic matcher at the percept boundary (extend where percepts are
      committed — sensory/perceptual layer, *before* the AffordanceSynthesizer's
      per-tick read): match keys against live descriptors; on match set
      `provenance:'reafferent'`, `sourceIntentId`, salience ×= `ATTENUATION`; else
      `provenance:'exafferent'`.
- [ ] AffordanceSynthesizer + workspace gating read the *attenuated* salience —
      no other change; the attention budget now naturally favors world over echo.
- [ ] Tests: echo percept attenuated + tagged; unmatched percept untouched
      (byte-identical to today); expired descriptor → no match; determinism guard
      (no wall clock, no RNG in matching).

### P3 — Rupture + engagement softening (the selector learns to let go of waiting)
- [ ] Rupture computed pull-style in the selector's `react()` from frozen state:
      max exafferent percept salience this tick (+ optionally count of `gated`
      prediction-error crossings) → `rupture ∈ [0,1]` above
      `RUPTURE_SALIENCE_GATE`.
- [ ] `effectiveSwitchCost × (1 − rupture)`; awaiting-incumbent hysteresis floored
      toward 0 at full rupture (composes with the existing stakes scaling —
      document the composition so it can't double-count stakes).
- [ ] `situation.stability` EMA metric (knocked down by rupture, mean-reverts;
      snapshot-safe); TaskSwitcher's focus-hardening reads it (both owners, native
      scales — mirror the R2 pattern).
- [ ] Emit `agency.situation.rupture` (telemetry + affect can subscribe; watch
      double-counting with threat/arousal evaluators — they already see the same
      percepts; rupture event carries `salience` conservatively).
- [ ] Tests: no-rupture path **byte-identical** (replay-equivalence guard on a
      quiet run); rupture softens awaiting preemption (challenger wins where it
      previously lost); thrash resistance (hysteresis floor > 0 below
      `RUPTURE_REVOKE_GATE`; stability EMA restores hardening after quiet ticks).

### P4 — Commitment revocation (the letting-go)
- [ ] Above `RUPTURE_REVOKE_GATE`: revoke via **tombstone** (P0 amendment — never
      a direct delete): selector writes `agency.revocation` keyed by intent id +
      emits **`agency.commitment.revoked`** `{ from: schema, reason:
      'exafferent-rupture', rupture, tick }`; next tick the Deliberation engine
      skips + deletes tombstoned intents, and the Executor refuses tombstoned
      `selected` intents (both then clean up tombstone + intent).
- [ ] Revocation does **not** commit a successor in the same tick — the field
      re-forms (the rupturing percept's un-attenuated salience carries it through
      the attention budget) and the next tick selects. Channel B: the *next*
      deliberating intent carries `preemptedFrom` + a `revokedBy` hint so the facet
      can own the rupture in-character ("something just changed — I dropped what I
      was weighing").
- [ ] (Optional sub-item, pre-existing debt) composite **immediate-switch**: the
      deferred-macro-advance upgrade the selector comment already flags — in-scope
      here only if P4 touches the same seam anyway; otherwise leave cancel-only.
- [ ] Tests: mid-deliberation rupture → revoked → re-selection next tick; orphan
      facet result dropped without throw; revocation event in the log exactly once;
      replay determinism across the whole sequence.

### P5 — Sensory reafference learns (optional follow-up)
- [ ] Matched (`reafferent`, `sourceIntentId`) percepts route a *soft* outcome to
      the reconcile/learning path — outcomeQuality from the matched percept's
      valence — so skills whose effects manifest through the senses (not host acks)
      still accrue competence. Guard against double-scoring an intent that also
      received a host ack (ack wins; sensory match only scores ack-less intents).

---

## Invariants (hold in every phase)

- **R2 determinism** — all TTLs and EMAs tick-denominated; matching is pure string/
  hash comparison; rupture is a pure function of frozen state; nothing async added
  to the tick.
- **FN9 snapshot/restore** — descriptors, provenance tags, and the stability EMA
  round-trip losslessly; replay-equivalence suite extended, not just green.
- **Serial body preserved** — one enaction at a time; revocation frees the slot, it
  never double-enacts (respect the executor's `_advance` guard and the selector's
  race rules).
- **Quiet-world no-op** — with no exafferent salience above gate, every path is
  byte-identical to today (pin with a replay guard test in P3; this is the "don't
  break the monolith" bar).
- **Echo cannot rupture** — provenance tagging (P2) is a hard prerequisite for
  arming rupture (P3); never ship P3 without P2 in the same release.

---

## Relation to the wider map

- **Executive recruitment unchanged** — the workspace gate keeps deciding when the
  LLM is bought; rupture is the *agency-side* sibling: recruitment answers "should I
  think harder?", revocation answers "should I stop what I'm doing?". Same currency
  (prediction error), different spender.
- **Delegation** (`__DELEGATION.md`) — a long-await delegation is an hours-scale
  `awaiting`; rupture + staleness give it a principled interrupt story, and the
  *absence* of expected reafference at descriptor-TTL is itself an exafferent-grade
  event (the engine-scale twin of the platform Deadline Watcher).
- **Sequel TODO (not here):** action-conditioned prediction — wake GenerativeModel's
  `predict()` (dead surface, 0 call-sites per `PREDICTIVE_SUBSTRATE.md`) so streams
  are predicted *conditioned on outstanding efference*: statistical surprise becomes
  true exafference detection, sharpening both P2's matching and P3's rupture.

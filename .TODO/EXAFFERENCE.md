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
> **The picture:** `docs/graphs/exafference-loop.svg` — the whole arc in one
> diagram (act → world → split → respond · learn).

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

### P1 — Expected-consequence descriptors (dark: no consumer) ⟶ done (2026-07-19)
- [x] Executor writes `agency.consequence` **entities** (`consequence.ts`:
      `CONSEQUENCE_TYPE`, `CONSEQUENCE_TTL_TICKS = 30`, FNV-1a `fnv1a` +
      canonical `paramsKey` — the shared match keys P2 will reuse) at both
      world-facing enaction moments: delivered communicate (`textHash` over the
      authored bubbles, effector, target) and the async hold (`paramsHash` +
      schema + target; mode communicate|external). Sync innate enactions
      register none. Entities ride StateManager snapshot/restore (FN9 for free);
      composite subs register through the same hold/deliver paths as they enact.
- [x] TTL-only expiry sweep at the top of the executor's `react()` (before the
      await-timeout sweep); verified a descriptor outlives its intent's timeout
      resolution and dies exactly at its own TTL.
- [x] Tests (`agency.consequence.test.ts`, 8 cases): hash/canonicalization
      determinism, delivered-communicate registration, external-hold
      registration, no-descriptor for sync innate + blocked communicate, TTL
      sweep, descriptor-outlives-resolution, replay determinism (two identical
      runs → identical entity sets). Full unit suite 925/925.

### P2 — Corollary-discharge matcher (percepts gain provenance) ⟶ done (2026-07-19)
- [x] Matching happens **at percept creation** (atomic — a percept never exists
      untagged): Exteroception computes `matchText` (entity content ≻
      description ≻ summary) per raw percept and consults
      `liveConsequences()` + `matchConsequenceText()` (consequence.ts) while
      building the entity. Match → `provenance:'reafferent'` + `sourceIntentId`
      + salience ×= `ATTENUATION`; miss → `provenance:'exafferent'`. The
      OutboxController's delivery percepts ("ear hears the word") are tagged
      reafferent **by construction**, un-attenuated (they're the ack surface,
      not a content echo).
- [x] **P2 scope decisions (recorded):** (a) provenance is set only at
      world-ingress creators — endogenous percepts (working memory, escalation
      buffer, wake) stay *untagged*: they are neither, and P3's rupture reads
      only `provenance:'exafferent'`; (b) **high-precision matchers only** —
      exact content hash, or verbatim containment of the descriptor's `text`
      (new field, stored at the delivery site) above `MIN_TEXT_MATCH_LEN = 12`.
      Entity-correspondence matching for external effectors is deferred
      (over-attribution mutes genuine world events; under-attribution is the
      status quo — safe); (c) `agency.consequence` added to Exteroception's
      `internalTypes` (perceiving our own descriptors was a P1 self-noise
      loop); (d) sense-engine bus percepts (`senses.<domain>.percept`) are not
      entities — tagging that path rides P3 if rupture ends up consuming it.
- [x] Consumers unchanged: AffordanceSynthesizer / AttentionAllocator /
      workspace read the already-attenuated salience off percept metadata.
- [x] Tests (`corollary.discharge.test.ts`, 11 cases): hash + containment +
      length-guard + no-match + stable-order matcher paths; live/expired
      descriptor filtering; echo tagged + attenuated vs. control (salience ==
      base × ATTENUATION); unrelated percept byte-equal to a descriptor-free
      run; own descriptors never perceived (internal type); expired descriptor
      no longer captures; determinism (identical state → identical tagged
      percepts). Full unit suite 936/936; typecheck clean.

### P3 — Rupture + engagement softening (the selector learns to let go of waiting) ⟶ done (2026-07-20)
- [x] `computeRupture(state, tick)` in the selector: max salience among
      `provenance:'exafferent'` percepts fresh within `RUPTURE_WINDOW_TICKS = 2`
      (= the percept lifespan), mapped through `RUPTURE_SALIENCE_GATE = 0.4`
      (= `WORKSPACE_THRESHOLD`) into [0,1]. Pure; reafferent percepts excluded by
      construction → the mind can't rupture itself. (The optional gated-
      prediction-error term is deferred; percept salience alone proved
      sufficient.)
- [x] Two-timescale softening: **fast** `effectiveSwitchCost × (1 − rupture)` at
      the call site (same-tick), applied uniformly to both preemption paths;
      **slow** `situation.stability` scales the focus-hardening term inside
      `effectiveSwitchCost` (`1 + focusTicks·FOCUS_GAIN·stability`). Documented as
      orthogonal to the per-challenger stakes scaling (world-instability vs.
      challenger-quality) so they compose without double-counting.
- [x] `situation.stability` EMA metric: `clamp01(prev + STABILITY_RECOVERY·(1−prev)
      − rupture)`, snapped to 1 within `STABILITY_EPSILON` so a never-ruptured mind
      **stops writing it** → the quiet path has no such metric and stays
      byte-identical (proven by the replay-equivalence integration test, still
      green). Metric-only ⇒ snapshot-safe for free. *(Follow-up shipped: the
      **TaskSwitcher** now reads `situation.stability` too — its focus-hardening
      term `×0.01·stability` mirrors the selector, so both owners of switch
      resistance loosen focus under a destabilized world at their native scales;
      absent stability = 1 = byte-identical.)*
- [x] Emits `agency.situation.rupture { rupture, stability, tick }` (salience =
      rupture) only when rupture > 0.
- [x] Tests (`agency.rupture.test.ts`, 8 cases): quiet path emits no
      stability/rupture; **reafferent echo cannot rupture**; strong exafferent
      fires the event + drops stability; sub-gate + stale-window percepts don't;
      **the headline** — a challenger pinned via `scoreAffordance` just below the
      incumbent keeps waiting when calm but preempts under full rupture; stability
      mean-reverts on a quiet tick. Full unit suite 944/944; replay-equivalence
      green; typecheck clean.

### P4 — Commitment revocation (the letting-go) ⟶ done (2026-07-20)
- [x] New `agency/revocation.ts`: `REVOCATION_TYPE`, `RUPTURE_REVOKE_GATE = 0.7`,
      `REVOCATION_TTL_TICKS = 5`, `revocationEntity` / `revokedIntentIds` /
      `staleRevocationIds`. Above the gate the selector writes an
      `agency.revocation` tombstone (keyed by intent id — never a direct delete,
      per the P0 resurrection-race finding) and emits **`agency.commitment.revoked`**
      `{ from, reason: 'exafferent-rupture', rupture, tick }`.
- [x] Both honorers act next tick from frozen state: the **Deliberation engine**
      skips + deletes tombstoned `deliberating` intents (+ their tombstone) before
      picking a target — never deliberating a revoked one, while non-tombstoned
      intents proceed; the **Executor** refuses a tombstoned `selected` intent (the
      half-race where deliberation committed the same tick the tombstone landed),
      deleting intent + tombstone with no enaction, and TTL-reaps orphan tombstones.
- [x] **No successor same tick** — the revocation return carries only the
      tombstone; the field re-forms and next tick selects. Tombstone type added to
      Exteroception `internalTypes` (never perceived).
- [x] Tests (`agency.revocation.test.ts`, 6 cases): selector issues tombstone +
      event once with no successor; sub-gate rupture does not revoke; Deliberation
      drops the revoked intent (+ tombstone) while a co-present live intent still
      deliberates; Executor refuses + cleans a tombstoned `selected` without
      enacting; orphan-tombstone TTL reap. Full unit suite 950/950;
      replay-equivalence green; typecheck clean.

> **Follow-up shipped:** the Channel-B `revokedBy` in-character hint on the *next*
> deliberating intent now works — the selector keeps a small `_lastRevoked`
> (snapshot-recorded, telemetry-grade like `_lastEntropy`) set at revocation and
> consumed once, within `REVOKE_HINT_WINDOW = 8` ticks, when a fresh deliberation
> forms; the Deliberation engine voices it ("something shifted and I let go of
> X"). The orphan-facet-drop concern from P0 is moot by construction: the
> Deliberation engine is stateless across ticks (it re-reads frozen state each
> `react`), so a revoked intent it never picks up produces no dangling handle.
> Composite immediate-switch remains pre-existing debt (untouched).

### P5 — Sensory reafference learns ⟶ done (2026-07-20)
- [x] The ReafferenceEngine now gathers outcomes from **two** sources: real
      `agency.outcome` entities (host ack / sync / timeout) *and* synthesized soft
      outcomes for `reafferent` percepts carrying a `sourceIntentId` whose intent
      is still `awaiting` and **un-graded this tick** (`gradedIntentIds` guard ⇒
      ack wins, never double-scores). The soft outcome is a modest positive
      (`SENSORY_SOFT_QUALITY = 0.6`, success, valence = the efference copy's
      predictedValence — "it manifested", not a fabricated felt-quality), folded
      through the same `recordOutcome` path so the skill accrues competence and the
      awaiting intent is freed — instead of sitting to `AWAIT_TIMEOUT` and being
      learned as a *failure*. `agency.sensory.confirmed` metric added; each awaiting
      intent scores at most once (`sensedIntentIds`).
- [x] Live path enabled: the executor's awaiting-**communicate** descriptor now
      carries `text`/`textHash` when the words are authored (`parameters.content`
      / first message), so an echo of them is P2-matchable. (External effectors
      still have no text ⇒ no sensory confirmation yet — that awaits the deferred
      entity-correspondence matcher; over-attribution stays the guarded-against
      direction.)
- [x] Tests: `agency.sensory-reafference.test.ts` (5 cases — echo confirms +
      frees an ack-less awaiting intent; host ack wins/no double-score; non-
      awaiting no-op; exafferent never confirms; at-most-once per intent) +
      `agency.consequence.test.ts` (awaiting communicate carries text). Full unit
      suite 955/955; replay-equivalence green; typecheck clean.

> **Note:** the spec said "outcomeQuality from the matched percept's valence,"
> but percepts carry no felt valence at the reafference seam (affect writes
> valence downstream). Deviation recorded: the soft outcome uses a fixed
> confirmation quality + the efference copy's predicted valence. A valence-driven
> soft quality is a clean upgrade once affect tags percepts.

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

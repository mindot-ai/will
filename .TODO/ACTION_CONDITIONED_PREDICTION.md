# ACTION_CONDITIONED_PREDICTION_TODO — the exafference sequel

> **Standing:** SHIPPED · 2026-08-21 · designed 2026-07-20, all 11 tracked items landed; the header said OPEN until the SIGNAL_BOUNDARY audit corrected it

> **Status:** ✅ **SHIPPED** — designed 2026-07-20, all 11 tracked items landed
> (0 open; each marked ✅ in the table below). *(Header said OPEN until 2026-08-21;
> corrected during the SIGNAL_BOUNDARY audit.)* Sequel to `.TODO/EXAFFERENCE.md`
> (P0–P5 + follow-ups + review all shipped). Goal: predictions conditioned on
> **what we just did** — statistical surprise becomes true exafference
> detection. The key discovery cutting this down to size: the substrate
> already exists. `GenerativeModel.anticipate(signal, value, confidence)`
> blends a top-down expectation into a stream's prediction and decays after
> one observe — it has **zero call-sites**. ACP is *wiring callers into a
> dead surface*, not building a model.
>
> This file is also the **consolidated registry of every deferred item** left
> around the exafference arc, ordered by dependency and priority (§0).

---

## §0 — The deferred registry (dependency + priority order)

| # | Item | Origin | Depends on | Size | Status |
|---|---|---|---|---|---|
| **1** | **ACP-P1: entity-correspondence via descriptors** — external-effector echoes become matchable; subsumes the old "entity-correspondence matching" deferral | EXAFFERENCE P2 scope decision (b) | nothing (descriptors carry `targetEntityId` since P1) | S | ✅ this file, shipped below |
| **2** | **Sense-channel rupture coverage** — `senses.*.percept` bus events never become entities ⇒ a sensory shock cannot rupture today; needs the echo guard extended to the bus path | EXAFFERENCE P2 scope decision (d), verified 2026-07-20 (`attention.allocator.ts:117` is the only consumer) | P2 matcher (done) | M | ✅ shipped below |
| **3** | **ACP-P2: the efferent-anticipation seam** — engines holding a GenerativeModel subscribe to `agency.enacted` / `agency.communicate` / `agency.invocation` and `anticipate()` the streams that action class predictably moves ⇒ self-caused stream movement stops recruiting the workspace | this file | `anticipate()` (exists) | M/L | ✅ shipped 2026-07-20 (all qualifying consumers — see §3 + the cross-check correction) |
| **4** | **Composite immediate-switch** — a preempting challenger now commits the same tick the routine is cut. Solved with the P4 **tombstone** rather than the "deferred macro-advance" the original comment imagined: deleting the parent is what made immediate commit unsafe (the executor's in-tick advance re-`set`s it — set-after-delete resurrection — and queues a second 'selected' sub ⇒ double enaction). Tombstoning instead lets the challenger commit immediately; next tick the executor drops the parent, its subs (any status), and the tombstone, and enacts the challenger alone | pre-existing debt (selector comment) | independent | M | ✅ shipped 2026-07-20 |
| **5** | **Valence-driven P5 soft quality** — UNBLOCKED by building the missing seam rather than waiting for it: Exteroception stamps every percept with a felt valence (KnownEntityTracker's per-entity `ke-<id>.valence` when the thing is known → `'entity'`; else ambient `affect.valence` → `'ambient'`), and the ReafferenceEngine grades the sensory confirmation within a band sized to the evidence (entity ±0.25, ambient ±0.10; neutral/absent = the pre-seam 0.6 exactly, `success` below 0.5). A bad mood alone can therefore never teach the Will that a working skill failed | EXAFFERENCE P5 deviation note | — | M | ✅ shipped 2026-07-20 |
| **6** | **ACP-P3: model-error rupture term** — the selector buffers `attention/affect/stress.state.changed` (each carries its engine's prediction-error salience) into `computeRupture`. The echo guard composes at the SOURCE: ACP-P2 consumers emit self-caused swings at ≤ 0.35, below the 0.4 rupture gate — an interoceptive wake of our own action cannot rupture, a world-caused internal storm can | EXAFFERENCE P3 deferral | #3 (✅) | S | ✅ shipped 2026-07-20 |

**Adjacent, interrelated, NOT this repo/arc (tracked elsewhere):**
- **Record anchoring → VLX** (`.TODO/RECORD_ANCHORING.md`, VLX/SPEC.md §7) —
  business-roadmap-gated (devspace `executive/ROADMAP.md` R3).
- **Delegation** (`.TODO/__DELEGATION.md` in devspace docs/strategy/will) —
  hours-scale awaiting intents; rupture/staleness give it an interrupt story,
  but the delegation arc is its own design.

**Why this order:** #1 unlocked immediate value with machinery already shipped
(descriptors, provenance, P5 scoring) and *is* the safe version of the old
entity-correspondence deferral — action-conditioned at the percept level.
#2 closes a genuine blind spot in rupture with the echo-guard invariant kept.
#3 is the substrate-wide payoff but needs per-engine stream inventories (M/L).
#4 is independent debt, tackle when touching the selector next. #5 needed an
affect-side seam, so we BUILT it (percept valence) rather than waiting. #6 must
not precede #3.

**Registry status (2026-07-20): every item shipped.** The arc is closed; the
remaining named work lives in the "adjacent" list above, in other repos.

---

## §1 — The idea, precisely

Today's exafference detection is *categorical* (provenance tags) and
*statistical* (GenerativeModel EMA deviation). What's missing is the
*conditional* layer: **given the efference we just emitted, expect specific
consequences** — at two levels:

- **Percept level (P1):** a live consequence descriptor targeting entity X is
  a standing prediction "X is about to change *because of me*". A `modified`
  percept on exactly X while the descriptor lives is reafference — tag it,
  attenuate it (more gently than a text match — we're less certain), and let
  P5's sensory confirmation cover **external effectors**, which the text-only
  matcher never could.
- **Stream level (P2):** an enaction predictably moves internal streams
  (attention toward the target, social drive after a reach-out, arousal after
  any act). `anticipate(stream, expected, confidence)` pre-blends that into
  each engine's prediction so the self-caused movement lands with low error —
  no false surprise, no spurious workspace recruitment — while genuinely
  world-caused deviation still spikes. Effect decays after one observe
  (already built).

**Invariants carried over from EXAFFERENCE.md, unchanged:** quiet-world
byte-identity (no live descriptor + no enaction ⇒ every path identical);
echo cannot rupture; R2 determinism (tick-denominated, pure reads);
FN9 (any cross-tick buffer snapshots/restores).

---

## §2 — ACP-P1: entity-correspondence (shipped 2026-07-20)

- [x] `matchConsequenceEntity( descriptors, entityId, changeType )` in
      `consequence.ts`: an **external**-mode descriptor whose `targetEntityId`
      equals the percept's entity, for a `modified` percept only (an
      `appeared` entity is new information, not our footprint), first match in
      stable order. Deliberately narrower than text matching: exact target,
      external mode only (communicate has the text path).
- [x] `CORRESPONDENCE_ATTENUATION = 0.5` (gentler than text's 0.25 — we are
      less certain this change is ours; a surprising change on our own target
      should still be able to climb).
- [x] Exteroception: entity-correspondence checked when text matching misses;
      match ⇒ `provenance:'reafferent'` + `sourceIntentId` + ×0.5 salience.
      P5's sensory confirmation now lights up for external effectors — an
      un-acked `wave-hands` at bob whose bob-entity visibly changes is scored
      and freed instead of timing out as a failure.
- [x] Tests (`agency.acp.test.ts`): correspondence match tags + attenuates ×0.5;
      `appeared` never matches; wrong entity never matches; communicate-mode
      descriptors don't entity-match (text path owns them); expired descriptor
      inert; P5 end-to-end via entity correspondence (external intent freed).

## §2b — Sense-channel rupture coverage (shipped 2026-07-20)

- [x] ActionSelector subscribes `senses.*`; `onCognitiveEvent` buffers
      `senses.<domain>.percept` events (salience + text when present in the
      payload). Buffer is cross-tick (flush T → react T+1) ⇒ carried in
      `snapshot()`/`restore()` (FN9) and consumed+cleared each `react`.
- [x] `computeRupture` folds in buffered sense percepts: text-matched against
      live descriptors ⇒ ours ⇒ **excluded** (the echo guard extends to the
      bus path); unmatched ⇒ exafferent contribution (same gate).
- [x] Tests: a high-salience sense percept ruptures; the same percept matching
      a live descriptor's text does not; buffer clears after react; snapshot
      round-trip carries the buffer.

---

## §3 — ACP-P2: the efferent-anticipation seam (OPEN — next)

Design (settled here, implementation phased):

1. **The signal already exists.** The executor publishes `agency.enacted`
   (sync outcomes), `agency.communicate` and `agency.invocation` (dispatch)
   with schema + target. No new event needed.
2. **Convention over framework:** each participating engine, in its
   `onCognitiveEvent`, translates an enaction event into `anticipate()` calls
   on **its own streams** with a conservative confidence (start 0.3–0.5). No
   central registry of stream effects — the engine knows its streams; the
   blend decays after one observe by construction.
3. **First consumers (one PR each, measure before widening):**
   - [x] **AttentionAllocator (shipped 2026-07-20)** — subscribes to the three
         enaction events; anticipates `attention.usage`/`attention.free_fraction`
         (the ONLY streams whose errors anything consumes — they gate
         `attention.state.changed`; `attention.entity.*` errors are discarded,
         so anticipating them would be theater). **Measured finding that
         reshaped the design:** after a stable stretch the salience denominator
         (EW variance) collapses, so any deviation saturates salience at 1.0
         and a conservative `anticipate()` nudge is behaviorally invisible.
         The measurable lever is **precision**: `ACP_SELF_PRECISION = 0.35` on
         both streams (below `WORKSPACE_THRESHOLD = 0.4` even at saturation),
         restored explicitly after ONE observe — the model's own mean-reversion
         (0.02/observe ≈ 50 ticks) would dampen genuine world surprise arriving
         after our action, the exact failure this plan forbids. The
         `anticipate()` nudge is kept as the directional prior. Tests
         (`agency.acp-attention.test.ts`): unprompted shift recruits (≥ gate);
         same shift post-enaction attenuated below the gate; full weight
         restored the very next tick; wiring pin. *(Observed pre-existing gap,
         not this arc's: the allocator's `snapshot()` does not carry its
         GenerativeModel, unlike most engines.)*
   - [x] **AffectiveBlender (shipped 2026-07-20)** — the "arousal post-enaction"
         consumer: `affect.arousal` (the one stream whose error is consumed —
         it weights the every-tick `affect.state.changed` publish) gets the
         shared pattern. Constants consolidated into `#cognition/acp`
         (`ACP_SELF_PRECISION`) so the safety number can't drift between
         consumers; the allocator imports it too. Directional prior kept
         (acting is arousing: +0.1 @ 0.4). Tests mirror the allocator's trio.
   - [x] **Social-drive: dropped by the honesty rule (inventoried 2026-07-20)**
         — no consumed social-drive stream exists; `social.agent_count`
         (SocialPerception) moves when *others* appear, not when we act —
         anticipating it on our own enaction would be wrong, not conservative.
         Revisit only if a consumed social stream appears.
   - [x] **StressRegulator (shipped 2026-07-20)** — `stress.load` error gates
         `stress.state.changed`; precision-only (no directional prior: acting
         can load OR relieve, so we don't pretend to know the sign). Shared
         pattern from `#cognition/acp`; trio tests
         (`agency.acp-stress.test.ts`). Registry #6 (the model-error rupture
         term) is now unblocked.

> **Correction (cross-check, 2026-07-20).** An earlier note here claimed the
> rollout covered "every engine whose GenerativeModel errors are consumed".
> That was overstated: a rigorous sweep finds **44 consumed-error sites** across
> ~30 engines. The real qualifying filter is BOTH (a) the error is consumed AND
> (b) **our own enaction predictably moves that stream** — anticipating a stream
> we don't actually cause suppresses genuine surprise (the over-attribution
> failure). Under (b) the shipped three are the correct and complete set:
> attention usage/free (acting shifts attention), `affect.arousal` (acting is
> arousing), `stress.load` (acting loads or relieves). Audited and rejected:
> `energy.level` — enactions never move it (`Enaction.metricDeltas` is declared
> in `execution.primitives.ts` and consumed by the executor but has **zero
> producers**, a dead surface worth its own cleanup); `circadian.alertness`
> (time-driven); `novelty.score`, `emotion.*`, `belief.count`, `tom.models`,
> `reputation.tracked`, `spaced_repetition.*`, `dream.reactivation`,
> `social.agent_count` (appraisal/memory/other-driven, not action-caused).
> Revisit only if an enaction begins to move one of them.
4. - [ ] **Eval before rollout:** a scenario where the Will acts and the
         workspace-entry count from self-caused streams drops vs. baseline,
         with world-event detection latency unchanged. Only then widen to
         further engines.
5. - [x] **ACP-P3 (registry #6, shipped 2026-07-20):** rather than reading
         other engines' models (impossible from the selector), the selector
         buffers their error-driven `*.state.changed` events into the same
         FN9-snapshotted afferent buffer that carries sense percepts, and
         `computeRupture` folds them in. No new guard needed — ACP-P2 IS the
         guard: self-caused swings arrive pre-attenuated below the rupture
         gate. Tests in `agency.acp.test.ts` (world-caused internal storm
         ruptures; ACP-attenuated self-caused wake cannot).

**Why not all 36 engines at once:** anticipation with wrong expected values
*suppresses real surprise* — the over-attribution failure mode again, now at
stream level. Per-engine, evidence-gated rollout is the only honest path.

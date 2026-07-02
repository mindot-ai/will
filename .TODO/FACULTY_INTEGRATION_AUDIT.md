# Will — Faculty output-consumption audit + integration wiring

> Full per-faculty audit: does each faculty's **distinctive output** (a metric/entity that
> should change behaviour) actually get *consumed* by something that changes behaviour?
>
> **Method note.** Events are NOT a relevance signal — the executive subscribes to `'*'`
> (global workspace, `bus.ts`), so every event charges its salience buffer. The real signal
> is whether a faculty's metric/entity is *read* and acted on.

---

## Audit result

≈32 of 36 faculties are **functional** (verified via the affect blender, executive context,
gating, memory modification, consolidator events, PMA, or direct refs). Four are **inert or
under-wired** — they run every tick but their output reaches nothing:

| Faculty | Evidence | Status |
|---|---|---|
| `task.switcher` | `switch_cost` / `task.focus` read by nothing (exteroception *excludes* `task.focus`) | inert |
| `empathy.simulator` | writes **no** `emotion.*` metric; `empathic_state` unread by blender/executive | under-wired |
| `theory.of.mind` | not in executive context; only consumer is `empathy` (itself under-wired) | under-wired |
| `reputation.tracker` | persists to PMA (cross-session ✓) but **no in-session** consumer | half-wired |

**Cross-cutting insight:** three of the four — `empathy` + `theory.of.mind` + `reputation` —
are the **social-cognition stack**, and it's collectively under-integrated: the Will builds
rich models of *others* (their minds, emotional resonance, trustworthiness) that never flow
into its own affect or reasoning in-session. The one social faculty that *is* wired is
`attachment` (it reaches affect via `emotion.love/belonging/trust`). `task.switcher` is a
separate, unrelated attention case.

**Note:** three recently-lifted Channel-A constants landed on these faculties —
`empathy.resonanceStrength` (#24), `reputation.trustGrowthStep` (#27),
`task.switcher.baseSwitchCost` (#28). Wiring the faculties retroactively makes those edges
matter.

---

## Wiring plan (do all — full integration, consulting correlated faculties)

### 1. `empathy.simulator` → affect (emotion contagion)  — ✅ DONE
Empathy resonates with others' inferred emotions but never moves the Will. Emit a dampened
**vicarious affect** signal (`empathy.vicarious_valence` / `_arousal`) that `affective.blender`
folds into the blended state. *Integrate with:* `theory.of.mind` (source of others' emotions),
`attachment` (closeness amplifies resonance), `affective.blender` (consumer).

### 2. `theory.of.mind` + `reputation.tracker` → executive context (social awareness)  — ✅ DONE
Surface the Will's models of *present agents* — what they seem to want/feel/believe (ToM) and
how trustworthy/cooperative they are (reputation) — into the executive (and conversation
facet) context, so the Will reasons *about whom it is dealing with*. *Integrate with:*
`social.perception` (who's present), `attachment` (bond strength), `executive.engine/context`,
the audition/conversation path.

### 3. `task.switcher` → task persistence  — ✅ DONE (Channel B + Channel A)
- **Channel B:** the current focus + cost of switching surface into the executive context
  (`## Task Focus`), so the deliberate self weighs persistence.
- **Channel A (end-to-end):** the focused goal gets a bounded **commitment boost** to its
  priority in `goal.manager._updatePriorities` — built from focus duration, **amplified by
  sunk cost in an in-progress plan** (`planning.engine`), and scaled by the switch cost
  (#28). Recomputed fresh each tick (no accumulation); bounded so a clearly higher-priority
  goal still wins. This makes the focus *mechanically* stick for goal selection, the
  executive, and planning. *Integrated:* `task.switcher` (focus) + `planning.engine` (plan
  progress) → `goal.manager` (priority).

---

*Spun off from the heuristic-cleanup audit ([__HEURISTIC_CLEANUP_TODO.md]) and the
constants-lifting work ([__FACULTY_CONSTANTS_CHANNEL_A_TODO.md]).*

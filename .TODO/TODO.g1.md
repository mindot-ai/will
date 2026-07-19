# Will — Audit TODO

Generated from: pipeline audit · prompt quality review (tick-858 prompt) · session log gap analysis.
Work items are grouped and ordered by dependency — tackle top-to-bottom within each section.

---

## A — Pipeline gaps

### A1 · Action lifecycle tracking  *(Track stage — currently missing)*

**Problem:** Once `ActionExecutor` dispatches an action to an external handler it immediately
writes `executed: true, success: true, outcome: 'Dispatched to external handler'`.  No
distinction exists between "completed", "in-flight", or "timed out".  The executive never
sees whether an action it decided on actually landed.

**Files:** `action.executor.ts`, `core/types.ts`

**Tasks:**
- [ ] Add `status: 'queued' | 'executing' | 'completed' | 'failed' | 'timed_out'` to the
  `decision.record` entity metadata. Rename the field from `executed: true` to
  `status: 'completed'` on internal execution paths.
- [ ] For external effectors (the `effector.invoked` path), write
  `status: 'awaiting_host'` instead of `executed: true`. Set a `dispatchedAt: tick`.
- [ ] Add a stale-detection pass in `ActionExecutor.update()`: any `decision.record` with
  `status: 'awaiting_host'` older than `N=15` ticks becomes `status: 'timed_out'`.
- [ ] Publish `action.timed_out` bus event when a record transitions to timed_out, carrying
  `actionType`, `planId?`, `stepId?`, `tick`.

---

### A2 · Action history in executive context  *(Confirm → Perceive loop)*

**Problem:** `buildExecutiveContext()` (`context.ts`) does not surface recent action
outcomes. The executive reasons over goals at 0% progress with no visibility into what it
already tried.  Nova's "coherence crisis" (tick 211) was caused by this gap.

**Files:** `executive.engine/context.ts`, `executive.engine/types.ts`,
`executive.engine/prompt.factory.ts`

**Tasks:**
- [ ] Add `recentActions?: Array<{ type: string; status: string; tick: number; outcome: string }>` 
  to `ExecutiveContext` in `types.ts`.
- [ ] In `buildExecutiveContext()`, scan `state.entities` for `decision.record` entities
  with `executionTick` present and return the last 5 (most recent first), including their
  `status` and truncated `outcome`.
- [ ] Render in `buildUserMessage()` as a `## Recent Action Outcomes` block (after
  "Recent Actions") — show type, status badge (`✓ completed` / `⏳ awaiting` / `⏱ timed out`),
  and one-line outcome. Skip if empty.

---

### A3 · Communication delivery confirmation  *(Confirm stage)*

**Problem:** When the executive outputs a `conversationReplies` block, `commands.ts`
writes a `conversation.outbox` entity.  `ProactiveCommunicator` dequeues it and sends the
message.  But no receipt entity is written back.  The next executive cycle cannot tell
whether the reply was delivered, still in the outbox, or silently dropped.

**Files:** `effectors/executors/communication.executor.ts`, `cognition/engines/faculties/executive.engine/commands.ts`

**Tasks:**
- [ ] After a successful send in `ProactiveCommunicator.executeAction()`, write a
  `conversation.sent` entity:
  ```
  { id: `sent-${tick}-${targetEntityId}`, type: 'conversation.sent',
    metadata: { targetEntityId, targetEntityName, tick, messageCount, preview: messages[0].slice(0,80) } }
  ```
- [ ] Clean up `conversation.sent` entities after 30 ticks (stale purge in ActionExecutor
  or a dedicated pass).
- [ ] Include `conversation.sent` entities in `buildExecutiveContext()` → `recentActions`
  so the executive sees them as `status: 'completed'` action records.

---

### A4 · Goal progress attribution for action-type goals  *(Integrate stage)*

**Problem:** `_nudgeActionGoals` exists in `goal.manager.ts` and correctly handles
`completionType === 'action'`.  But communication goals (e.g. "respond to studio user")
are created as `epistemic` or without tags that match the effector name.  The nudge never
fires because the tag intersection fails.

**Files:** `goal.manager.ts`, `executive.engine/commands.ts`

**Tasks:**
- [ ] When the executive creates a goal in response to an incoming message (`conversationReplies`
  present in same output), auto-tag the goal with `['communication', 'reply', senderName]`
  and set `completionType: 'action'`.
- [ ] In `_nudgeActionGoals`, also match against the `targetEntityId` stored on goal metadata
  (not just tags) — communication goals should track to a specific entity.
- [ ] Add `lastActionAttemptTick` and `lastActionType` fields to `GoalState` updated on
  every `action.outcome` match — gives the executive visible evidence that it tried.

---

### A5 · Boredom → proactive drive escalation

**Problem:** `AestheticEvaluator` fires `emotion.boredom.significant` (boredom=1,
stimulusVariability=0) every single tick when idle.  No engine subscribes to this signal
for escalation.  Nova sat at maximum boredom for 126 consecutive ticks with zero effect
on behavior.

**Files:** `aesthetic.evaluator.ts`, `cognition/engines/faculties/goal.manager.ts`,
`executive.engine/gating.ts`

**Tasks:**
- [ ] Track consecutive max-boredom ticks in `AestheticEvaluator` (`_consecutiveMaxBoredom`
  counter).
- [ ] After `_consecutiveMaxBoredom >= 30`, publish a `drive.seek_engagement` bus event
  with `salience: 0.85` — high enough to trigger the executive gating buffer.
- [ ] In `gating.ts` `evaluateGating()`: subscribe to `drive.seek_engagement`; treat it as
  a forced activation reason (`reason: 'prolonged boredom — forcing proactive cycle'`).
- [ ] In `GoalManager`, subscribe to `drive.seek_engagement`; if no `communication` or
  `exploration`-tagged goal is active, create a lightweight goal:
  `"Seek meaningful engagement — initiate contact or explore a pending question"`,
  `priority: 0.6, completionType: 'action'`.
- [ ] Reset `_consecutiveMaxBoredom` on any `novelty.significant` or `social.communication`
  event.

---

## B — Prompt quality

### B1 · Duplicate `## Who You Are` section header

**Problem:** `identity.prompt` (stored in the `identity-self` entity) contains
`## Who You Are\nI am Nova.` as part of the PMA-generated template.  `buildSystemPrompt()`
in `prompt.factory.ts` then appends a second `## Who You Are\n${identityBlock}` block.
The LLM receives both and the second block (with values/traits/style) has no header
coherence relative to the first.

**File:** `executive.engine/prompt.factory.ts`

**Tasks:**
- [ ] In `buildSystemPrompt()`, before inserting `## Who You Are\n${identityBlock}`,
  strip any existing `## Who You Are` sub-section from `identity.prompt` using a regex:
  ```ts
  const cleanPrompt = identity.prompt.replace(/^##\s*Who You Are[^\n]*\n[^\n]*/m, '').trim()
  ```
- [ ] Or — preferred — rename the prompt.factory block to `## Personality` to avoid the
  collision entirely, since the persona sentence belongs to the preamble and the
  traits/values block is configuration.

---

### B2 · Belief deduplication before scoring

**Problem:** At tick 858 Nova had 70 beliefs, ~15 of which were near-identical restatements
of "preparation is complete".  The `BELIEF_PROMPT_LIMIT = 50` cap includes duplicates —
the LLM gets 50 slots occupied by the same semantic content expressed differently.

**File:** `executive.engine/context.ts`

**Tasks:**
- [ ] After scoring beliefs, add a deduplication pass before slicing to
  `BELIEF_PROMPT_LIMIT`: iterate sorted beliefs; skip any belief whose statement shares
  more than 6 content words (non-stopwords) with an already-kept belief.
- [ ] Reduce `BELIEF_PROMPT_LIMIT` from 50 → 30 and add `beliefsDeduped: number` to
  `ExecutiveContext` (shown as `[+N deduped]` in the prompt alongside `beliefsOmitted`).
- [ ] Add a per-category cap: no more than 8 beliefs per `category` in the prompt
  (prevents a single runaway theme dominating the full window).

---

### B3 · Memory display when vector index unavailable

**Problem:** When no embedding/vector index is configured, `semanticQuery` falls back to
`episodicConsolidator.query({ limit: 8 })` which returns episodes sorted by
`activationStrength`.  Many episodes have `activationStrength: 0`, so relevance renders as
`0.00` in the prompt — misleading and unhelpful.

Additionally, working memory items of type `goal` appear in **Relevant Memories** in the
prompt even though goals are already rendered in **Active Goals** — pure duplication.

**Files:** `executive.engine/context.ts`, `executive.engine/prompt.factory.ts`

**Tasks:**
- [ ] In `buildExecutiveContext()`, when falling back to `episodicConsolidator.query()`,
  sort results by `timestamp` descending (most recent first) rather than by
  `activationStrength`.
- [ ] Set `relevance` to `undefined` (not 0) when coming from the fallback path so
  `prompt.factory` can omit the relevance display entirely:
  ```
  // fallback: no relevance score — show recency indicator instead
  content: ep.content, tick: ep.timestamp
  ```
- [ ] In `buildUserMessage()`, filter working memory items with `type === 'goal'` from the
  memories/ruminations section.

---

### B4 · Overdue goal deadline indicator

**Problem:** Goal-2 ("Deploy by cycle 700") was shown at tick 858 with no indication it
had been overdue for 158 ticks.  The executive had no signal to reprioritize or abandon.

**Files:** `executive.engine/prompt.factory.ts`, `goal.manager.ts`

**Tasks:**
- [ ] In `buildUserMessage()`, when rendering goals, check if `goal.deadline &&
  state.tick > goal.deadline`; append `[OVERDUE — ${state.tick - goal.deadline} ticks past
  deadline]` in red/uppercase to the goal line.
- [ ] In `GoalManager._deactivateStale()`, treat an overdue `action` or `epistemic` goal
  as having decayed priority: apply a `priorityDecayRate * 3` multiplier per tick past
  deadline — so it naturally falls below `deactivationThreshold` and is abandoned rather
  than sitting at 0% forever.

---

### B5 · Empty identity values/style nudge

**Problem:** Nova ran 858 ticks with `values: []` and `style: ''`.  The executive saw
"No values defined yet." every cycle but never acted on it because it was low-salience
background noise rather than an actionable signal.

**Files:** `executive.engine/prompt.factory.ts`

**Tasks:**
- [ ] In `buildUserMessage()`, when `identity.values.length === 0` and
  `state.tick > 20` (past early bootstrap), inject a one-line hint in the
  `## Active Goals` block:
  ```
  ⚠️ You haven't defined your values or communication style yet. Use [IDENTITY] this
  cycle to set them — your values anchor every decision you make.
  ```
- [ ] Same for `identity.style === ''`.
- [ ] Show this hint at most once every 30 ticks (track `_lastValueNudgeTick` in the
  factory or gate it to the executive interval).

---

## C — Session logging

### C1 · `LogEntryType` union incomplete

**Problem:** `facet.ts` writes entries with `type: 'executive.facet.call'` and
`type: 'executive.facet.output'` via `_sessionLogger?.write(...)` but neither string is
in the `LogEntryType` union in `session.logger.ts`.  TypeScript currently allows this only
because of the `Record<string, unknown>` intersection.

**File:** `deployment/session.logger.ts`

**Tasks:**
- [ ] Add to `LogEntryType`:
  ```ts
  | 'executive.facet.spawn'
  | 'executive.facet.call'
  | 'executive.facet.output'
  | 'executive.facet.destroy'
  | 'plan.step.dispatch'
  | 'plan.step.outcome'
  | 'goal.progress'
  | 'action.outcome'
  ```

---

### C2 · Full LLM reasoning not persisted

**Problem:** `executive.output` log entry truncates `reasoning` to 1000 chars.  The
full LLM output (reasoning + tagged blocks) is the most valuable artifact for debugging
but is lost after the session.  The debug prompt file (`prompt-tick-000N.txt`) captures
the input but not the output.

**Files:** `executive.engine/engine.ts`, `llm/index.ts` (LLMDirector)

**Tasks:**
- [ ] In `LLMDirector`, after a successful call, write the full response text to
  `./data/wills/{willId}/debug/response-tick-{N:06d}.txt` (same pattern as the prompt
  file).  Return the path alongside `text`, `inputTok`, `outputTok`.
- [ ] Log the path in `executive.response`:
  ```ts
  this._sessionLogger?.write({ type: 'executive.response', ..., responsePath: path })
  ```
- [ ] Remove the 1000-char truncation from `executive.output.reasoning` OR log full
  reasoning separately and keep only the excerpt (600 chars) in the JSONL for stream
  scanning.

---

### C3 · Facet lifecycle logging

**Problem:** When a facet is spawned or destroyed there is no log entry.  Looking at a
session JSONL you can find `executive.facet.output` records but cannot determine which
plan/goal triggered the facet, when it was created, or whether it was destroyed cleanly.

**Files:** `executive.engine/engine.ts` (`spawnFacet`), `executive.engine/facet.ts`
(`destroy`)

**Tasks:**
- [ ] In `ExecutiveEngine.spawnFacet()`, after `this._facets.set(facetId, facet)`:
  ```ts
  this._sessionLogger?.write({
    type: 'executive.facet.spawn',
    tick: this._lastStateRef?.tick,
    facetId,
    planId: ...,   // pass from calling context (PlanningEngine)
    goalId: ...,
    executionTier: 'step-aware',
    totalFacets: this._facets.size,
  })
  ```
- [ ] Pass `planId` and `goalId` into `spawnFacet()` as optional params so they can be
  logged (currently the caller has this info but `spawnFacet` doesn't accept it).
- [ ] In `ExecutiveFacet.destroy()`, write:
  ```ts
  this._sessionLogger?.write({ type: 'executive.facet.destroy', facetId: this.facetId, tick })
  ```
- [ ] In `ExecutiveFacet._reason()`, the existing `executive.facet.call` write (line 273)
  should include `planId` and `goalId` from the focus context.

---

### C4 · Plan step dispatch and outcome logging

**Problem:** Plan execution is opaque in the session log.  We can see facet outputs but
not which specific plan steps were dispatched or what their outcomes were — making it
impossible to trace whether a multi-step plan advanced or stalled.

**Files:** `planning.engine.ts`, `deployment/session.logger.ts`

**Tasks:**
- [ ] Attach `SessionLogger` to `PlanningEngine` via `attachSessionLogger()` (same pattern
  as ActionExecutor).
- [ ] When `plan.step.dispatched` fires, write:
  ```ts
  logger.write({ type: 'plan.step.dispatch', tick, planId, stepId, stepIndex, action, description })
  ```
- [ ] In `_onStepOutcome()`, write:
  ```ts
  logger.write({ type: 'plan.step.outcome', tick, planId, stepId, success, outcomeQuality, description })
  ```
- [ ] When a plan transitions to `completed` or `failed`, write a `plan.complete` log
  entry with `totalSteps`, `completedSteps`, `failedSteps`, `durationTicks`.

---

### C5 · Goal progress change logging

**Problem:** Goals sit at 0% for hundreds of ticks in the session log with no entries
showing why progress isn't moving.  There is no `goal.progress` entry type.

**Files:** `goal.manager.ts`, `deployment/session.logger.ts`

**Tasks:**
- [ ] Attach `SessionLogger` to `GoalManager` via `attachSessionLogger()`.
- [ ] In `_nudgeActionGoals()`, when `goal.progress` actually changes, write:
  ```ts
  logger.write({ type: 'goal.progress', tick, goalId, description: goal.description.slice(0,80),
    previousProgress, progress: goal.progress, trigger: 'action.outcome', actionType, domain })
  ```
- [ ] When `GoalManager` fires `goal.achieved` or `goal.blocked`, write a corresponding
  `goal.achieved` / `goal.blocked` log entry.
- [ ] In `_deactivateStale()`, when a goal is abandoned, write:
  ```ts
  logger.write({ type: 'goal.abandoned', tick, goalId, reason, ticksStuck, finalProgress })
  ```

---

### C6 · `action.outcome` bus event logging

**Problem:** When `action.outcome` fires on the bus (the signal that closes the
Act → Integrate loop), it is only an in-memory bus event.  It does not appear in the
session JSONL.  Combined with the missing goal.progress entries, it is impossible to
audit whether the `action.outcome → _nudgeActionGoals` path ever fires.

**Files:** `action.executor.ts`

**Tasks:**
- [ ] In `ActionExecutor._resolveAction()`, when publishing `action.outcome` to the bus,
  also write to sessionLogger:
  ```ts
  this._sessionLogger?.write({
    type: 'action.outcome',
    tick,
    actionType: effector.name,
    domain: effector.tags?.[0] ?? actionType,
    success: result.success,
    outcomeQuality: result.feedback.outcomeQuality,
    planId: metadata?.planId,
    stepId: metadata?.stepId,
  })
  ```
- [ ] Similarly log `action.timed_out` entries when a `decision.record` times out (from A1).

---

## D — Dead infrastructure & silent gaps

### D1 · `executive.prediction.formed` is never published

**Problem:** 20+ engines subscribe to `executive.prediction.formed` and use it to tune
their precision/attention (stress, frustration, reward, novelty, threat, social, dream,
circadian, forgetting, mental simulator...).  It is defined in `event.schemas.ts`.  But
**no engine ever publishes it**.  Every engine that subscribes gets silent: all their
prediction-error paths are permanently inactive.  This includes `FrustrationEvaluator`'s
confidence calibration, `NoveltyDetector`'s expectation suppression, `MentalSimulator`'s
trigger logic, and the PMA-calibrated decay rates in `EnergyRegulator`.

**Files:** `executive.engine/commands.ts` (or `engine.ts`), every subscribing engine.

**Tasks:**
- [ ] In `publishCognitiveEvents()` in `commands.ts`, after the executive reasoning
  completes, publish `executive.prediction.formed`:
  ```ts
  bus.publish({
    type: 'executive.prediction.formed', version: 1, sourceEngine: 'executive-engine',
    salience: 0.7,
    payload: {
      predictedDomains: executiveOutput.actions.map( a => a.type ),
      confidence: executiveOutput.confidence,
      tick: footprint.tickObserved,
    }
  })
  ```
- [ ] Verify each subscribing engine's handler fires correctly with a test session after
  the publish is wired.

---

### D2 · `executive.call` log entry missing context counts

**Problem:** `executive.call` in `engine.ts` only logs prompt sizes and the debug path.
It does not log `workingMemoryItems`, `goalCount`, `pendingMessages`, `beliefCount`,
`episodeCount` — the counts that appeared as `null` in the JSONL analysis.  Without these,
monitoring token growth over time is possible but diagnosing *why* a prompt grew is not.

**File:** `executive.engine/engine.ts`

**Tasks:**
- [ ] Extend the `executive.call` `_sessionLogger?.write()` call to include:
  ```ts
  workingMemoryItems: execContext.workingMemory.length,
  goalCount:          execContext.goals.length,
  pendingMessages:    this._messageQueue.pendingMessages.length,
  beliefCount:        execContext.beliefs.length,
  beliefsOmitted:     execContext.beliefsOmitted,
  episodeCount:       this._episodicConsolidator?.getAllEpisodes().length ?? 0,
  ```
  These are all available at the point the log entry is written (after `buildFreshContext`
  returns `execContext`).

---

### D3 · Memory Continuity block has no length cap

**Problem:** The rolling summary (`## Memory Continuity`) is injected into the user
message with no truncation.  At tick 858 it was ~500 words summarising 12 cycles — growing
linearly as more sessions accumulate.  Combined with 50 beliefs and 8 memories, it pushes
the user message above 25k chars.

**File:** `executive.engine/prompt.factory.ts`

**Tasks:**
- [ ] Cap `memoryContinuity` at 1200 chars (approx 300 tokens) in `buildUserMessage()`:
  ```ts
  const memoryContinuity = deps.summarizer?.current
    ? `## Memory Continuity\n${deps.summarizer.current.slice( 0, 1200 )}`
    : ''
  ```
- [ ] If the raw summary exceeds the cap, append `\n[...summarized — full history in
  episodic memory]` so the executive understands it's truncated.
- [ ] In `ExecutiveSummarizer`, when compressing, deduplicate consecutive summaries that
  share >60% of their sentences (symptom: Nova's 12 "preparation complete" cycles
  producing near-identical summary paragraphs).

---

### D4 · `conversation.in` / `conversation.out` log entries never written

**Problem:** Both types exist in `LogEntryType` and are documented in the file header of
`session.logger.ts`, but no code in the codebase ever calls
`logger.write({ type: 'conversation.in', ... })` or `'conversation.out'`.  The session
JSONL has zero conversation entries despite Nova receiving and planning to reply to
messages.  This is the single most important audit trail for a conversational will.

**Files:** `effectors/executors/communication.executor.ts`,
`cognition/engines/faculties/social.perception.ts`

**Tasks:**
- [ ] In `SocialPerception` (or wherever the inbound `communication` entity is first
  processed), write:
  ```ts
  logger.write({ type: 'conversation.in', tick, entityId, sender, senderId,
    content: message.slice(0, 500), salience })
  ```
- [ ] In `ProactiveCommunicator.executeAction()`, after successful send, write:
  ```ts
  logger.write({ type: 'conversation.out', tick, targetEntityId, targetEntityName,
    messages, preview: messages[0]?.slice(0, 100) })
  ```
- [ ] Attach `SessionLogger` to `SocialPerception` and `ProactiveCommunicator` if not
  already done.

---

### D5 · Episodic memory conflates intent with confirmed outcome

**Problem:** When the executive plans to do something (e.g. reply to a user), the
planning artifact is consolidated into episodic memory with the same weight as a
completed action.  This caused Nova's tick-211 coherence crisis — it read its own
memory of "I tried to respond" and couldn't determine if the response landed.

**Files:** `episodic.consolidator.ts`, `core/types.ts` (EpisodicMemory interface)

**Tasks:**
- [ ] Add `outcomeStatus?: 'intended' | 'attempted' | 'confirmed' | 'failed'` to the
  `EpisodicMemory` interface.
- [ ] When `EpisodicConsolidator` consolidates a working memory item of type
  `decision.record`, set `outcomeStatus` based on the record's `status` field:
  - `executed: false` → `'intended'`
  - `status: 'awaiting_host'` → `'attempted'`
  - `status: 'completed'` → `'confirmed'`
  - `status: 'failed' | 'timed_out'` → `'failed'`
- [ ] In `_extractEpisodeContent()` in `context.ts`, prefix the content string with a
  status badge when `outcomeStatus` is present:
  `"[attempted] I tried to reply to studio-user"` vs `"[confirmed] Reply sent to studio-user"`.

---

## Priority order

| Priority | Items | Rationale |
|---|---|---|
| 🔴 Ship-blocking | A1, A2, A3, C2 | Action lifecycle + history in context + delivery confirmation + full reasoning persisted — the feedback loop can't close without these |
| 🟠 High | A4, B1, C1, C3, D1, D4 | Goal attribution + prompt dedup + type safety + facet logging + prediction publisher + conversation log |
| 🟡 Medium | A5, B2, B3, D2, D3, C4, C5, C6 | Boredom drive + belief quality + memory display + log completeness + rolling summary cap + plan/goal audit trail |
| 🟢 Polish | B4, B5, D5 | Deadline display + identity nudge + episodic outcome field |

---

## Progress tracker

- [x] A1 — Action lifecycle tracking
- [x] A2 — Action history in executive context
- [x] A3 — Communication delivery confirmation
- [x] A4 — Goal progress attribution
- [x] A5 — Boredom → proactive drive escalation
- [x] B1 — Duplicate `## Who You Are`
- [x] B2 — Belief deduplication
- [x] B3 — Memory display quality
- [x] B4 — Goal deadline indicator
- [x] B5 — Empty identity nudge
- [x] C1 — `LogEntryType` union incomplete
- [x] C2 — Full LLM reasoning not persisted
- [x] C3 — Facet lifecycle logging
- [x] C4 — Plan step dispatch/outcome logging
- [x] C5 — Goal progress change logging
- [x] C6 — `action.outcome` bus event logging
- [x] D1 — `executive.prediction.formed` never published (already implemented — false alarm)
- [x] D2 — `executive.call` log missing context counts
- [x] D3 — Memory Continuity block no length cap
- [x] D4 — `conversation.in` / `conversation.out` never written
- [x] D5 — Episodic memory conflates intent with confirmed outcome

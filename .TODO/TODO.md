# Will — Implementation TODO

> **Standing:** SHIPPED · 2026-05-28 · day zero of this record — the 5-Senses (Phase 13.8) implementation checklist. Partial and superseded: audition and exteroception ship, four shell senses are still empty (see [[__CONTRIBUTION_TOPICS]]), and its 63 unchecked boxes are history, not backlog

> Ordered implementation checklist for the 5 Senses Architecture (Phase 13.8).
> Tasks are sequenced by dependency — complete each section before starting the next.
> See `roadmap.md § Phase 13.8` for the full design specification.

---

## Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked — dependency unresolved

---

## Section 0: Prerequisite Fixes

These are existing architectural inconsistencies in the current codebase that must be
resolved before the senses layer is built on top of them. They are small, targeted
changes — not rewrites.

### 0.1 PlanningEngine — Decouple GoalManager Direct Calls ✅

**Verified correct**: `GoalManager.onCognitiveEvent()` already subscribes to
`executive.facet.progress` and handles `newGoals`, `goalsToAbandon`, `goalProgress`
from that event. `_onFacetDecision()` in PlanningEngine only handles plan directives
(continue/skip/abandon/replan/complete) — it never calls `goalManager.addGoal()` directly.
No changes needed.

### 0.2 Audit `executive.facet.progress` Payload ✅

Confirmed: `goalId`, `goalProgress`, `newGoals`, `goalsToAbandon`, `newBeliefs` are all
promoted to top-level in the `executive.facet.progress` payload (facet.ts lines 371–377).

### 0.3 Audit `executive.facet.sync` in Master ✅

Confirmed: `ExecutiveFacet` subscribes to `executive.master.sync` in its constructor
(bus.subscribe on `executive-facet-{id}`). Master sync events are accumulated in
`_masterSyncHistory` (last 5 entries) and injected into the facet's reasoning context
at line 226–231 of facet.ts. AuditionEngine conversation facets inherit this automatically.

---

## Section 1: Core Perceptual Types ✅

**File**: `will/src/cognition/engines/senses/index.ts` — created.

Key deviations from original plan (confirmed superior after codebase analysis):
- No separate `PerceptualBus` — percepts published directly on `CognitiveBus` with topic `senses.{domain}.percept`
- No separate `SalienceComputer` — `SalienceComputer` from `#cognition/salience` already exists and is used by `AuditionEngine`
- No `SenseEngineRegistry` — sense engines added directly to `EngineRegistry` / `Cognition` type
- `SenseEngine` extends `CognitiveEngine` (not standalone) + adds `attachBus()` and `ingest()`

### 1.1 `SenseDomain` union ✅
Defined and exported in `will/src/cognition/engines/senses/index.ts`.

### 1.2 `Percept` base type ✅
Defined and exported in `will/src/cognition/engines/senses/index.ts`.

### 1.3 `LanguagePercept` ✅
Defined and exported in `will/src/cognition/engines/senses/index.ts`.

### 1.4 `SensoryInput` discriminated union ✅
All input types (`TextMessage`, `VoiceChunk`, `ImageFrame`, `VideoSegment`, `WebhookEvent`,
`SystemSignal`, `AmbientMetric`, `BackgroundSignal`, `InternalEvaluation`,
`SelfAssessmentTrigger`) defined and exported. `SensoryInput` union defined.
Re-exported from `will/src/index.ts` for backend use.

### 1.5 `SenseEngine` interface ✅
Defined and exported in `will/src/cognition/engines/senses/index.ts`.
Extends `CognitiveEngine` so engines integrate with the existing engine registration system.

### 1.6 `PerceptualBus` — superseded ✅
Decided against a separate bus. Percepts are published directly on the existing
`CognitiveBus` under the `senses.{domain}.percept` topic prefix. `AttentionAllocator`
subscribes to `senses.*`. No separate class needed.

### 1.7 `SenseEngineRegistry` — superseded ✅
Decided against a separate registry. All five sense engines are named properties on the
`Cognition` / `EngineRegistry` type (`auditionEngine`, `visionEngine`, etc.), exactly like
other cognitive engines. `WillManager.ingestSensory()` routes by domain name via a local
`engineMap`. No separate registry class needed.

---

## Section 2: Shell Sense Engines ✅

**Location**: `will/src/cognition/engines/senses/`
All four shell engines created and registered in `EngineRegistry` + `assembleMind()`.

### 2.1 VisionEngine

**File**: `will/src/cognition/engines/senses/vision.engine.ts`

- [ ] Create `VisionEngine` class implementing `SenseEngine`
- [ ] `domain = 'vision'` as const
- [ ] `ingest(input: ImageFrame | VideoSegment)` — shell (log + no-op)
- [ ] `onPercept()` / `destroy()` — standard
- [ ] JSDoc: "Future: multimodal LLM vision calls for image/video understanding"

### 2.2 SomatosensationEngine

**File**: `will/src/cognition/engines/senses/somatosensation.engine.ts`

- [ ] Create `SomatosensationEngine` class implementing `SenseEngine`
- [ ] `domain = 'somatosensation'` as const
- [ ] `ingest(input: WebhookEvent | SystemSignal)` — shell
- [ ] JSDoc: "Future: webhook ingestion, system event routing, external API callbacks"

### 2.3 OlfactionEngine

**File**: `will/src/cognition/engines/senses/olfaction.engine.ts`

- [ ] Create `OlfactionEngine` class implementing `SenseEngine`
- [ ] `domain = 'olfaction'` as const
- [ ] `ingest(input: AmbientMetric | BackgroundSignal)` — shell
- [ ] JSDoc: "Future: ambient background signal monitoring, slow-burn affect triggers"

### 2.4 GustationEngine

**File**: `will/src/cognition/engines/senses/gustation.engine.ts`

- [ ] Create `GustationEngine` class implementing `SenseEngine`
- [ ] `domain = 'gustation'` as const
- [ ] `ingest(input: InternalEvaluation | SelfAssessmentTrigger)` — shell
- [ ] JSDoc: "Future: post-action quality assessment, identity alignment checks"

---

## Section 3: AuditionEngine (Full Implementation) ✅

**File**: `will/src/cognition/engines/senses/audition.engine.ts` — created.

Implemented with minor adaptations from plan:
- `ThreadDigestManager` embedded (no separate file)
- `CONVERSATION_OUTPUT_FORMAT` const replaces `buildConversationFocus` helper (inlined in `_buildFocus()`)
- `_chunkCallback` injected for future streaming hookup — not yet wired to SSE outbox (Section 5)
- `requiresMasterAttention` derived from `escalate` action type in LLM output
- Salience computed per entity via `SalienceComputer.observe('audition.{entityId}', langEnergy)`

### 3.1 Salience Calculator

**Helper**: `will/src/cognition/engines/senses/audition/salience.ts`

```typescript
export function computeLanguageSalience(opts: {
  speakerEntityId: string
  content:         string
  attachmentScore: number    // from AttachmentEvaluator for speakerEntityId
  activeGoalIds:   string[]  // current active goals
  lastMessageAt?:  number    // timestamp of last message from this entity
}): number
```

Scoring formula (combine, clamp to 0–1):
- `attachmentScore * 0.4` — closer relationship = higher salience
- urgency keyword match (`urgent`, `help`, `now`, `critical`, `asap`) → +0.3
- topic overlap with active goals (simple keyword match for MVP) → +0.2
- recency bonus (message within last 30s) → +0.1

- [ ] Implement `computeLanguageSalience()`
- [ ] Unit test: high-attachment sender + urgency keyword → salience > 0.7

### 3.2 Thread Digest Manager

**Helper**: `will/src/cognition/engines/senses/audition/digest.ts`

```typescript
export class ThreadDigestManager {
  private _threads = new Map<string, string[]>()  // threadId → last-5 summaries

  append(threadId: string, role: 'user' | 'will', content: string): void
  getDigest(threadId: string): string    // joins last 5 summaries into context block
  clear(threadId: string): void
}
```

Digest format (output of `getDigest`):
```
[Thread context — last 5 messages]
user: <content>
will: <content>
...
```

- [ ] Implement `ThreadDigestManager`
- [ ] `append()` trims to last 5 after each addition
- [ ] `getDigest()` returns empty string if no history

### 3.3 Conversation FocusSection Builder

**Helper**: `will/src/cognition/engines/senses/audition/focus.ts`

```typescript
import type { FocusSection } from '#cognition/engines/faculties/executive.engine/facet'

export function buildConversationFocus(opts: {
  speakerName:  string
  speakerRole?: string
  digest:       string
  content:      string
}): FocusSection
```

FocusSection structure (refer to `facet.ts` for exact interface):
```typescript
{
  title: 'Active Conversation',
  content: `Speaker: ${speakerName}${speakerRole ? ` (${speakerRole})` : ''}
Thread context:
${digest}

Current message: "${content}"`,
  instructions: `You are Will engaged in a live conversation.
Respond directly and naturally using [REPLY].
If the speaker requests something actionable, signal it in [GOALS] — but do not
spawn plans yourself. Plans are the executive master's responsibility.
Stay in character. Keep replies concise unless depth is warranted.`,
  outputFormat: 'full',    // re-enables [REPLY] which facet mode suppresses by default
  extractDecision: (output) => ({
    reply:                    output.reply   ?? '',
    taskSignals:              output.newGoals ?? [],
    urgency:                  output.decision?.urgency               ?? 'normal',
    requiresMasterAttention:  output.decision?.requiresMasterAttention ?? false,
  }),
}
```

- [ ] Confirm `FocusSection` interface shape by reading `facet.ts` (use Serena `find_symbol`)
- [ ] Implement `buildConversationFocus()`
- [ ] Confirm `outputFormat: 'full'` is a valid FocusSection field (check PromptFactory)

### 3.4 AuditionEngine Class

**File**: `will/src/cognition/engines/senses/audition.engine.ts`

```typescript
export class AuditionEngine implements SenseEngine {
  readonly domain = 'audition' as const

  private _facets     = new Map<string, ExecutiveFacetHandle>()   // entityId → facet
  private _digests    = new ThreadDigestManager()
  private _bus:       PerceptualBus
  private _handlers   = new Set<(p: Percept) => void>()

  constructor(
    private readonly _executive: ExecutiveEngine,   // for spawnFacet()
    private readonly _getAttachmentScore: (entityId: string) => number,
    private readonly _getActiveGoalIds:   () => string[],
    private readonly _eventBus:           EventBus,
    bus:                                  PerceptualBus,
  ) { this._bus = bus }
```

- [ ] Define class skeleton with constructor

**`ingest()` implementation**:

```typescript
async ingest(input: SensoryInput): Promise<void> {
  if (input.kind !== 'text' && input.kind !== 'voice') return

  const content = input.kind === 'text'
    ? input.content
    : (input.transcription ?? '[voice — transcription pending]')

  const salience = computeLanguageSalience({
    speakerEntityId: input.entityId,
    content,
    attachmentScore: this._getAttachmentScore(input.entityId),
    activeGoalIds:   this._getActiveGoalIds(),
    lastMessageAt:   this._lastMessageAt.get(input.entityId),
  })

  this._lastMessageAt.set(input.entityId, Date.now())

  const percept: LanguagePercept = {
    domain:          'audition',
    channel:         input.kind,
    content,
    speakerEntityId: input.entityId,
    threadId:        input.threadId,
    digest:          this._digests.getDigest(input.threadId),
    salience,
    timestamp:       Date.now(),
    raw:             input,
  }

  // Publish to perceptual bus (AttentionAllocator et al. can react)
  this._bus.publish(percept)
  this._handlers.forEach(h => h(percept))

  // Route to facet
  await this._routeToFacet(percept)

  // Update digest with inbound message
  this._digests.append(input.threadId, 'user', content)
}
```

- [ ] Add `_lastMessageAt = new Map<string, number>()` to class
- [ ] Implement `ingest()`

**`_routeToFacet()` implementation**:

```typescript
private async _routeToFacet(percept: LanguagePercept): Promise<void> {
  let handle = this._facets.get(percept.speakerEntityId)

  if (!handle) {
    // New conversation session — spawn a fresh facet
    handle = await this._executive.spawnFacet()
    const focus = buildConversationFocus({
      speakerName:  percept.speakerEntityId,   // resolve to display name if available
      digest:       percept.digest,
      content:      percept.content,
    })
    handle.setFocus(focus)
    handle.subscribe(decision => this._onFacetDecision(percept.speakerEntityId, percept.threadId, decision))
    this._facets.set(percept.speakerEntityId, handle)
  } else {
    // Existing session — update focus content and report new percept
    const focus = buildConversationFocus({
      speakerName: percept.speakerEntityId,
      digest:      percept.digest,
      content:     percept.content,
    })
    handle.setFocus(focus)
  }

  // Report triggers the facet's next reasoning cycle
  await handle.report({
    type:    'language_percept',
    payload: percept,
  })
}
```

- [ ] Implement `_routeToFacet()`
- [ ] Read `facet.ts` to confirm `spawnFacet()`, `setFocus()`, `subscribe()`, `report()` API

**`_onFacetDecision()` implementation**:

```typescript
private _onFacetDecision(
  entityId: string,
  threadId: string,
  decision: FacetDecision,
): void {
  const d = decision.decision as {
    reply:                   string
    taskSignals:             unknown[]
    urgency:                 string
    requiresMasterAttention: boolean
  }

  // Update digest with Will's reply
  if (d.reply) {
    this._digests.append(threadId, 'will', d.reply)
  }

  // Publish task signals for master / PlanningEngine
  if (d.taskSignals?.length) {
    this._eventBus.publish('audition.task.signal', {
      entityId,
      threadId,
      signals:  d.taskSignals,
      urgency:  d.urgency,
      requiresMasterAttention: d.requiresMasterAttention,
    })
  }

  // NOTE: Reply delivery to the client is handled by the outbox/SSE layer.
  // The facet's chunk listeners stream token-by-token; this callback receives
  // the assembled decision after the full reply is complete.
}
```

- [ ] Implement `_onFacetDecision()`

**`endSession()` and lifecycle**:

```typescript
endSession(entityId: string): void {
  const handle = this._facets.get(entityId)
  if (!handle) return
  handle.destroy()
  this._facets.delete(entityId)
  // Digest kept until explicit clear — allows history retrieval after session ends
}

onPercept(handler: (percept: Percept) => void): Unsubscribe {
  this._handlers.add(handler)
  return () => this._handlers.delete(handler)
}

destroy(): void {
  for (const [, handle] of this._facets) handle.destroy()
  this._facets.clear()
  this._handlers.clear()
}
```

- [ ] Implement `endSession()`, `onPercept()`, `destroy()`

### 3.5 Reply Streaming via Chunk Listeners

**Context**: The facet accumulates tokens via `_chunkListeners` (internal). We need
those chunks delivered to the SSE client token-by-token.

- [ ] Read `facet.ts` to find the chunk listener API (likely `onChunk()` or `_chunkListeners`)
- [ ] In `_routeToFacet()`, after `spawnFacet()`, call `handle.onChunk(chunk => { ... })`
  to register a chunk listener
- [ ] Chunk listener logic:
  - Filter: only pass chunks through if they are part of a `[REPLY]` block
    (track a stateful `inReplyBlock` boolean — set true when `[REPLY]` seen, false on `]`)
  - Strip the `[REPLY]` and closing `]` markers from the chunk content
  - Push stripped chunk to the outbox: `this._outbox.push({ type: 'chunk', content: stripped, entityId })`
- [ ] The outbox push mechanism must be injected into `AuditionEngine` constructor
  (accept `_pushChunk: (entityId: string, chunk: string) => void`)

### 3.6 Export from senses barrel

**File**: `will/src/cognition/engines/senses/index.ts` (update)

- [ ] Export `AuditionEngine` from the senses barrel
- [ ] Export all shell engines
- [ ] Export `SenseEngineRegistry`, `PerceptualBus`

---

## Section 4: Cognitive Integration ✅

### 4.1 `assembleMind()` Registration ✅

**File**: wherever `assembleMind()` or `createWill()` is defined
(likely `will/src/stem/manager.ts` or `will/src/cognition/mind.ts`)

- [ ] Locate `assembleMind()` using Serena `find_symbol`
- [ ] Instantiate `PerceptualBus`
- [ ] Instantiate `SenseEngineRegistry`
- [ ] Instantiate all five engines; register with registry
- [ ] Instantiate `AuditionEngine` with correct dependencies:
  - `_executive`: the `ExecutiveEngine` instance
  - `_getAttachmentScore`: lambda that reads from `AttachmentEvaluator`
  - `_getActiveGoalIds`: lambda that reads from `GoalManager`
  - `_eventBus`: the simulation's event bus
  - `bus`: the `PerceptualBus` instance
- [ ] Add `senses: SenseEngineRegistry` to the returned mind object

### 4.2 `Cognition` Type Update ✅

**File**: wherever `Cognition` interface is defined
(likely `will/src/cognition/index.ts` or `will/src/types.ts`)

- [ ] Add `senses: SenseEngineRegistry` to `Cognition` interface
- [ ] No engine should access other engines' senses directly — all via `PerceptualBus`

### 4.3 `AttentionAllocator` Subscription ✅

**File**: `will/src/cognition/engines/regulatory/attention.allocator.ts` (or similar)

- [ ] Locate `AttentionAllocator` using Serena `find_symbol`
- [ ] In its initialization/constructor, accept `PerceptualBus`
- [ ] Subscribe to `'*'` domain percepts
- [ ] On percept receipt: use `percept.salience` as an attention focus signal
  (map salience → attention weight for the source entity)
- [ ] This replaces or supplements any existing input-scanning logic in the allocator

### 4.4 Master Executive — `audition.task.signal` subscription ✅

**File**: `will/src/cognition/engines/faculties/executive.engine/engine.ts`

Implemented via `this._bus.subscribe(this.name, ['audition.task.signal'], ...)` in the
engine's bus subscription block. The bus guard prevents double-subscription on re-attachment.

On receipt of `audition.task.signal`, the engine buffers it into `_pendingEscalations`.
These are flushed in the next `_executeReasoning()` cycle by injecting synthetic `percept`
entities into the world state — visible to master as `## Percepts (What You Notice)`.
The percept directive explicitly reads: *"Create a plan or update goals. Do not emit [REPLY]
— the facet handles communication."*

**Architecture clarification (updated after legacy path removal):**
- `[REPLY]` is **fully removed** from master's output schema. Master responds to escalations
  via plans/goals/actions only — never by producing a reply directly.
- `[ACK]` is also removed from master. The acknowledgement path no longer exists.
- Routine AuditionEngine traffic never reaches master — facets handle all conversation.
- Escalations surface as high-salience percepts, not as `## ⚡ Incoming Messages`.
- `_messageQueue.pendingMessages` still exists but is NOT used by audition escalations
  (doing so would have caused the master to attempt a `[REPLY]` which it can no longer emit).
- `prompt.factory.ts` JSDoc updated to reflect this — master mode description no longer
  references `[REPLY]` or incoming messages.

### 4.5 `WillManager` Sense Engine Exposure ✅

**File**: `will/src/stem/manager.ts`

Three methods added in the `// ── Senses API` section (after `injectIncomingMessage`):

```typescript
async ingestText( id: string, input: TextMessage ): Promise<void>
// → instance.cognition.auditionEngine.ingest( input )

endConversation( id: string, entityId: string ): void
// → instance.cognition.auditionEngine.endSession( entityId )

activeConversationSessions( id: string ): string[]
// → instance.cognition.auditionEngine.activeSessions()
```

`TextMessage` imported from `'#senses/index'` barrel.

Notes:
- No `getSenses()` helper needed — `getWillCognition(id).auditionEngine` is sufficient
- `ingestText()` is the senses-aware successor to `injectIncomingMessage()` (which remains
  for backward compatibility with the legacy tick-based conversation pipeline)
- Reply delivery and chunk streaming are deferred to Section 5

---

## Section 5: Conversation Pipeline Rebuild

### Architectural Notes (read before implementing)

Two gaps were deferred from AuditionEngine's `_onFacetDecision()`:

**Gap 1 — Reply Delivery**
`_onFacetDecision()` receives assembled reply bubbles (`d.replyBubbles`) but nothing
delivers them to the client. Fix in 5.3: pass `ProactiveCommunicator` reference into
`AuditionEngine` via `attachProactiveCommunicator()`, then call
`ProactiveCommunicator._handleOutboundMessage()` (or the public `executeAction()`) per
bubble. **Must check `ChannelRegistry.canEmit()` before pushing to outbox.**

Route: `AuditionEngine._onFacetDecision()` → `ProactiveCommunicator._handleOutboundMessage()`
→ `ChannelRegistry.canEmit('text', entityId)` → `outbox.push()`

**Gap 2 — Chunk Streaming**
`_chunkCallback` is declared in `AuditionEngine` but `ExecutiveFacetHandle` has no
`onChunk()` method — the existing global `chunkListeners` on `WillInstance` is
Will-wide, not per-entity. Fix in 5.4:
1. Add `onChunk( handler: (chunk: string) => void ): Unsubscribe` to `ExecutiveFacetHandle`
2. Wire it through `ExecutiveFacet._reason()` at the LLM stream level (alongside existing
   global `_chunkBroadcaster`)
3. In `AuditionEngine._routeToFacet()`, after `spawnFacet()`, call:
   `handle.onChunk( chunk => this._chunkCallback?.( entityId, chunk ) )`
4. In `WillManager`, provide `chunkCallback` per entity via `addEntityChunkListener()`
   (new method, returns unsubscribe), backed by a `Map<entityId, Set<fn>>` on `WillInstance`
5. `ChannelRegistry.emitChannelsFor()` must be checked before forwarding chunks to client

---

### 5.1 `conversation_messages` Table Migration ✅

Added nullable `thread_id` column to existing `will_conversations` table via Drizzle migration
`backend/drizzle/0005_classy_storm.sql`. Migration applied (`bun run db:migrate`).
Schema: `backend/src/db/schema/conversations.ts`.

### 5.2 Update `POST /wills/:id/converse` Route ✅

Route fully rewritten. Streaming mode: registers chunk + tick listeners before ingest,
emits `will_thinking` → `chunk*` → `reply_complete` SSE events, persists both sides of
conversation. Non-streaming mode: calls `ingestText()`, persists inbound, returns 202 with
`{ threadId, channel, eventType }`. Old `injectMessage()` service method removed.

### 5.3 Reply Delivery via `ProactiveCommunicator` (Gap 1) ✅

**Files modified**:
  - `will/src/effectors/executors/communication.executor.ts` — added `deliverReply()` method
  - `will/src/cognition/engines/senses/audition.engine.ts` — added `attachProactiveCommunicator()`,
    updated `_onFacetDecision()` to call `this._ProactiveCommunicator.deliverReply()`
  - `will/src/stem/mind.ts` — wired `auditionEngine.attachProactiveCommunicator( ProactiveCommunicator )`

**`ProactiveCommunicator.deliverReply()` added** — purpose-built method for AuditionEngine:
  - Checks `_channelRegistry?.canEmit('text')` before pushing
  - Pushes each bubble to `this._outbox` with `effectorName: 'text'`
  - Logs to session logger with `source: 'audition-facet'`
  - Records exchange in `ConversationManager` ring buffer (when `incomingMessage` provided)
  - Returns outbox message IDs (empty array if channel gate blocks delivery)
  - Avoids the `ActionRequest/ReadonlySimulationState` cycle — no state ref needed

**`AuditionEngine._onFacetDecision()` updated**:
  - Calls `deliverReply()` when `_ProactiveCommunicator` is attached
  - Logs delivery result (IDs) or warns on channel gate block
  - Falls back to console log only when no executor attached (dev/test/basic tier)

### 5.4 Chunk Streaming via `ExecutiveFacetHandle.onChunk()` (Gap 2) ✅

**Files modified**:
  - `will/src/cognition/engines/faculties/executive.engine/facet.ts`
    - Added `onChunk` to `ExecutiveFacetHandle` interface
    - Added `_chunkHandler` field + `setChunkHandler()` to `ExecutiveFacet`
    - `_reason()` uses `callStream()` when `_chunkHandler` set, `call()` otherwise
  - `will/src/cognition/engines/faculties/executive.engine/engine.ts`
    - Added `onChunk: (handler) => facet.setChunkHandler(handler)` to handle object in `spawnFacet()`
  - `will/src/cognition/engines/senses/audition.engine.ts`
    - `_routeToFacet()`: after spawn, registers `handle.onChunk( chunk => this._chunkCallback!(entityId, chunk) )`

Architecture achieved:
```
SSE/WS client
    ↑ chunk
WillManager.addEntityChunkListener(id, entityId, fn)   ← TODO: still needed (5.4a)
    ↑
AuditionEngine._chunkCallback(entityId, chunk)
    ↑  registered via attachChunkCallback()
ExecutiveFacet._chunkHandler(chunk)
    ↑  set via handle.onChunk()
LLMDirector.callStream() → per-token callback
```

**Remaining (5.4a)** — `WillManager.addEntityChunkListener()`:
  - Add `entityChunkListeners: Map<string, Set<fn>>` to `WillInstance`
  - Add `addEntityChunkListener(id, entityId, fn): () => void` to `WillManager`
  - Wire: on first listener for any entity, call `auditionEngine.attachChunkCallback((eid, chunk) => { entityChunkListeners.get(eid)?.forEach(fn => fn(chunk)) })`
  - Gate: check `ChannelRegistry.emitChannelsFor(entityId)` before forwarding (for non-text channels)
  - Note: for the SSE path, the backend registers/unregisters via this API on connect/disconnect

### 5.5 SSE Typing Indicator ✅

`will_thinking` event emitted immediately before `ingestText()` call in streaming mode.
Client receives `{ entityId, threadId }` to render spinner.

### 5.6 SSE Chunk + Reply Complete Events ✅

`chunk` events: `{ content, threadId, entityId }` — one per LLM token via `addSensoryChunkListener`.
`reply_complete` event: `{ messageId, content, threadId }` — fires when outbox has the reply
(detected via `addTickListener`). Will's reply persisted to `will_conversations` on completion.
Fake word-split streaming fully removed.

### 5.6.1 Entity-Scoped Activity SSE Stream ✅

**Causal chain**: entity message → `AuditionEngine` escalation → `ExecutiveEngine`
`_pendingEscalations[0]` → `CommandDependencies.requestingEntityId` → `GoalManager.addGoal()`
→ `GoalState.requestingEntityId` → `Plan.requestingEntityId` → all plan bus events.

**New bus events**: `plan.started` (on `ready→executing`), `plan.step.outcome` (previously
session-log only), `plan.completed`/`plan.failed` (tier gate removed — both tiers publish).

**Files modified**:
- `will/src/cognition/engines/faculties/goal.manager.ts` — `requestingEntityId/ThreadId` on `GoalState`; params 9+10 on `addGoal()`; new `getGoal(id)` accessor
- `will/src/cognition/engines/faculties/planning.engine.ts` — `Plan.requestingEntityId/ThreadId`; new `ActivityEvent` / `ActivityEventHandler` types; `addActivityListener(entityId, fn)`; bus publications for `plan.started`, `plan.step.outcome`; removed tier gate on `plan.completed`/`plan.failed`
- `will/src/cognition/engines/faculties/executive.engine/commands.ts` — `CommandDependencies.requestingEntityId/ThreadId`; passes both to `addGoal()`
- `will/src/cognition/engines/faculties/executive.engine/engine.ts` — captures `_firstEscalation` before drain; stamps on `CommandDependencies`
- `will/src/cognition/engines/index.ts` — re-exports `ActivityEvent`, `ActivityEventHandler`
- `will/src/stem/manager.ts` — `addActivityListener(id, entityId, fn)` delegates to `planningEngine`
- `backend/src/services/will.service.ts` — `addActivityListener()` proxy
- `backend/src/routes/v1/wills.ts` — `GET /:id/activity?entityId=` SSE endpoint; 30s heartbeat; auto-close on terminal events

### 5.7 WebSocket Upgrade (Optional — after SSE working)

**File**: new `backend/src/routes/v1/ws.ts` or added to `wills.ts`

- [ ] `GET /wills/:id/ws?entityId=...&threadId=...`
- [ ] Authenticate via `?token=...` query param (JWT) or cookie
- [ ] On connection: `willManager.addEntityChunkListener(id, entityId, chunkFn)`
- [ ] Client → server message: `{ type: 'message', content: string }`
  → `willManager.ingestText(id, { kind: 'text', entityId, threadId, content })`
- [ ] Server → client: `{ type: 'thinking' }`, `{ type: 'chunk', content }`,
  `{ type: 'reply_complete', messageId }`
- [ ] On disconnect: `willManager.endConversation(id, entityId)` + unsubscribe chunk listener

### 5.8 Conversation History API ✅

- `GET  /wills/:id/conversations` — entity summary list, sorted most-recent first
- `GET  /wills/:id/conversations/:entityId?limit=50&threadId=...` — paginated messages, oldest→newest
- `DELETE /wills/:id/conversations/:entityId?threadId=...` — delete entity (or thread) history

### 5.9 WillService Proxy Methods ✅

- `ingestText()` — routes TextMessage through AuditionEngine, fires webhook
- `addSensoryChunkListener()` — per-entity SSE chunk fan-out
- `endConversation()` — deletes conversation rows; returns `{ deleted }`
- `getConversationHistory()` — paginated, optional threadId filter
- `listConversations()` — entity summary with messageCount + lastMessageAt

---

## Section 6: API Surface (Sense Engine Routes) ✅

- `GET  /wills/:id/senses` — returns `{ engines: [{ domain, status, activeSessions?, sessions? }] }`
- `POST /wills/:id/senses/:domain/ingest` — validates domain, requires `kind` field in body,
  routes to `willService.ingestSensory()` → `WillManager.ingestSensory()` → engine.ingest()
  `WillManager.getSenseEngineStatus()` and `ingestSensory()` added to will package.

---

## Section 7: Testing

### 7.1 Unit Tests

- [ ] `computeLanguageSalience()` — test all score components individually
- [x] `ThreadDigestManager` — append, trim to 5, getDigest format, thread isolation, clear() (`tests/unit/senses.shell.test.ts`)
- [ ] `buildConversationFocus()` — correct FocusSection fields, `outputFormat: 'full'`
- [ ] `PerceptualBus` — publish → handler called, unsubscribe removes handler
- [ ] `SenseEngineRegistry` — register, route by input kind
- [x] Shell engines — `ingest()` logs warning, does not throw; correct domain/status/publishes() (`tests/unit/senses.shell.test.ts`)
- [x] `GoalManager.requestingEntityId` — addGoal() with requester → getGoal() returns it; without → undefined; multiple goals independent (`tests/unit/goal.requester.test.ts`)
- [x] `PlanningEngine.addActivityListener()` — no-bus no-op + warning; entity filter; all 5 topic→type mappings; unsubscribe; multi-listener isolation; extra payload fields forwarded (`tests/unit/planning.activity.test.ts`)

### 7.2 Integration Tests

- [x] `AuditionEngine` end-to-end: `ingest(TextMessage)` → facet spawned → decision emitted
      → `audition.task.signal` published on event bus (`tests/integration/audition.lifecycle.test.ts`)
- [x] Facet session lifecycle: new entity → facet created; same entity → facet reused;
      `endSession()` → facet destroyed, removed from map (mock executive, no LLM) (`tests/integration/audition.lifecycle.test.ts`)
- [x] Thread digest persistence across multiple messages in the same thread (`tests/integration/audition.lifecycle.test.ts`)
- [ ] GoalManager subscription: emit `executive.facet.progress` on bus → GoalManager state
      updates without any direct method call to PlanningEngine (validates Section 0.1 fix)

### 7.3 Conversation Pipeline Tests (Backend)

- [x] `POST /converse` → `will_conversations` persists inbound row (`backend/tests/integration/conversation.pipeline.test.ts`)
- [x] SSE stream receives `will_thinking` event before first chunk (`backend/tests/integration/conversation.pipeline.test.ts`)
- [x] Chunks arrive in order; `reply_complete` fires after last chunk (`backend/tests/integration/conversation.pipeline.test.ts`)
- [x] `reply_complete` → `will_conversations` persists Will's reply (`backend/tests/integration/conversation.pipeline.test.ts`)
- [x] `GET /conversations/:entityId` returns history in chronological order (`backend/tests/integration/conversation.pipeline.test.ts`)

---

## Implementation Order Summary

```
Section 0   →  Section 1   →  Section 2   →  Section 3.1–3.3
     ↓                                              ↓
Section 0.1 fix (GoalManager)              Section 3.4–3.6 (AuditionEngine class)
                                                    ↓
                                           Section 4 (Cognitive Integration)
                                                    ↓
                                           Section 5 (Conversation Pipeline)
                                                    ↓
                                           Section 6 (API Routes)
                                                    ↓
                                           Section 7 (Tests)
```

**Do not start Section 3 until Section 0 fixes are verified.**
**Do not start Section 5 until Section 4 is complete and `AuditionEngine.ingest()` is end-to-end tested.**

---

---

## Section 8: Activity Stream

> Implemented as part of the conversation pipeline rebuild (see Section 5.6.1 above).
> Listed here for discoverability in the studio integration phase.

- [x] Causal `requestingEntityId` link from entity message → goal → plan → bus events
- [x] `plan.started` bus event emitted on `ready → executing` transition
- [x] `plan.step.outcome` published to bus (was session-log only)
- [x] `plan.completed` / `plan.failed` tier gate removed (both tiers publish)
- [x] `PlanningEngine.addActivityListener(entityId, fn)` — entity-scoped subscriber
- [x] `WillManager.addActivityListener(id, entityId, fn)` — public delegation
- [x] `WillService.addActivityListener()` — backend proxy
- [x] `GET /wills/:id/activity?entityId=` — SSE endpoint with heartbeat + auto-close
- [x] Unit tests: `addActivityListener()` fully covered (`tests/unit/planning.activity.test.ts`)

---

*Last updated: 2026-05-28*

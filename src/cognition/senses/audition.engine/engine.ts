// ─────────────────────────────────────────────────────────────
// src/cognition/senses/audition.engine/engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * AuditionEngine — hearing / language perception.
 *
 * The first fully implemented sense engine. Handles all text and voice
 * input from external entities. Translates raw language into typed
 * LanguagePercepts and routes each conversation session through a dedicated
 * ExecutiveFacet — one facet per entityId, kept alive for the session duration.
 *
 * Architecture:
 *   - External call: WillManager.ingestText() → audition.ingest(TextMessage)
 *   - Percept published on bus:  senses.audition.percept
 *   - Facet reply signals:       audition.task.signal  (when master attention needed)
 *   - GoalManager integration:   automatic via executive.facet.progress (bus)
 *   - Chunk streaming:           via multi-subscriber chunk callbacks (transport + SSE)
 *
 * The master executive is NOT involved in replies — it learns about conversations
 * only via executive.facet.sync events published by the conversation facets.
 * Master takes initiative if it receives an audition.task.signal marked
 * requiresMasterAttention: true.
 *
 * FocusSection.outputFormat provides a custom format that re-enables [REPLY]
 * (normally gated out in facet mode) while removing PLANS (conversation
 * facets must not spawn plans — that is the master's domain).
 *
 * ── Entity keying & namespace contract (§7) ───────────────────────────────────
 * AuditionEngine keys EVERYTHING by `entityId`: the conversation facet
 * (`_facets`), the per-entity serial turn queue (`_entityTail`), the chunk-stream
 * state (`_streamState`), and the in-flight inbound/thread maps. Two inbound
 * messages with the same `entityId` are therefore the SAME speaker and share one
 * facet/session — even if they arrive from different sources (web, Slack, SMS).
 * That is intentional (one person = one continuous conversation), but it makes
 * globally-unique entityIds the INTEGRATOR's responsibility: when bridging
 * multiple channels, namespace the id by source (e.g. `slack:U123`, `web:42`) so
 * distinct people never collide into one facet, and the same person across
 * channels merges only when you deliberately map them to one id. `threadId`
 * further scopes one speaker's parallel threads (§2) but does NOT split facets.
 *
 * ── Determinism: on-tick vs off-tick boundary (R2, §7) ────────────────────────
 * The only replay-recorded, ON-tick step is inbound application: an inbound
 * envelope crosses the tick-stamped `InboundQueue` and is applied at a fixed
 * point in the tick (the transport's determinism leg — the analog of the LLM
 * recorder). Everything AuditionEngine does in response runs OFF-tick and is
 * reconstructed from those recorded inputs, never replayed directly: facet
 * reasoning (LLM calls), chunk streaming, the transport reply emit
 * (`_replyCallback`), and the memory-sink `setEntity` writes (`conversation.
 * exchange`). Off-tick writes stay R2-safe because they carry no wall-clock into
 * state — `setEntity` stamps createdAt/tick from the sim clock, and any
 * `wallClock()` here is telemetry-only (ids, session logs). Boundary in one line:
 * percept/ack application = on-tick & recorded; reasoning + side effects =
 * off-tick & reconstructed.
 */

import { logger } from '#core/logger'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { ExecutiveFacetHandle, FacetDecision } from '#faculties/executive.engine/facet'
import { DEFAULT_FACET_AWARENESS, type FocusSection } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { OutboxWriter } from '#stem/tracts/outbox.writer'
import { GenerativeModel } from '#cognition/generative.model'
import { buildConversationExchange } from '#cognition/conversation.memory'
import { wallClock } from '#core/wall.clock'
import { computeLanguageSalience } from '#senses/audition.engine/salience'
import { BaseSenseEngine } from '#senses/base.sense.engine'
import type {
  SensoryInput,
  LanguagePercept,
  TextMessage,
  VoiceChunk
} from '#senses/index'

// ── Internal types ─────────────────────────────────────────────

interface ConversationDecision {
  /** Full assembled reply text (all bubbles joined with \n). */
  reply:                  string
  /** Individual reply bubbles for display (separate SSE chunks). */
  replyBubbles:           string[]
  targetEntityId:         string
  newGoals?:              ExecutiveOutputFull['newGoals']
  goalsToAbandon?:        ExecutiveOutputFull['goalsToAbandon']
  newBeliefs?:            ExecutiveOutputFull['newBeliefs']
  knownEntityUpdates?:    ExecutiveOutputFull['knownEntityUpdates']
  /** True when an explicit 'escalate' action appears in the output. */
  requiresMasterAttention: boolean
}

/** Minimal write-side entity shape accepted by `stateManager.setEntity`. */
interface MemoryEntity {
  id:       string
  type:     string
  metadata: Record<string, unknown>
}

/**
 * One coalescing window (§6) — a turn-in-waiting that accumulates rapid-fire
 * messages from a single entity until its turn starts. `base` is the latest
 * message (its thread/speaker metadata wins); `parts` are the message contents in
 * arrival order, joined into one turn. `done` resolves for every `ingest()` that
 * folded into this window when its coalesced turn completes.
 */
interface CoalesceWindow {
  base:    TextMessage | VoiceChunk
  parts:   string[]
  started: boolean
  done:    Promise<void>
  resolve: () => void
}


// ── Conversation output format ─────────────────────────────────
// Two-step format: JSON first (private reasoning), then [REPLY_TEXT] (streamed to client).
// [REPLY_TEXT] is plain prose — no JSON wrapper, no targetEntityId needed.
// The facet is entity-scoped so the recipient is always the speakerEntityId.

const CONVERSATION_OUTPUT_FORMAT = `\
## Response Format (REQUIRED)

Step 1 — JSON object (your private reasoning, optionally in a \`\`\`json code block):

\`\`\`json
{
  "actions": [{"type": "reflect", "reasoning": "...", "expectedOutcome": "..."}],
  "reasoning": "Your private inner reasoning. Embed optional tagged blocks here:\\n[BELIEFS]\\n{\\"newBeliefs\\": [...]}\\n[/BELIEFS]\\n[GOALS_NEW]\\n{\\"goals\\": [{...}]}\\n[/GOALS_NEW]",
  "confidence": 0.8
}
\`\`\`

Available reasoning tags: BELIEFS, GOALS_NEW, GOALS_ABANDON, SELF_OBS. Include only those with meaningful content.

Step 2 — Your reply to the speaker (plain text, streamed live to them):

[REPLY_TEXT]
Your response here, written in your own voice.

Start a new paragraph (blank line) to send a separate chat bubble.
[/REPLY_TEXT]

Write [REPLY_TEXT] AFTER the closing \`\`\`. This is the only part the speaker sees — keep it grounded, present.
Separate multiple messages with a blank line for natural conversational pauses (like separate texts).

## When to use GOALS_NEW (almost always)
If the speaker requests, mentions, or implies something you should follow through on — embed [GOALS_NEW] in your reasoning.
This tracks intent across future cycles without requiring master attention.

## When to use the escalate action (rare — only for multi-step tasks)
Use \`{"type": "escalate", "reasoning": "...", "expectedOutcome": "..."}\` in actions ONLY when the request genuinely requires your master consciousness to create a plan:
- The task involves multiple steps across future cycles ("build me X", "monitor Y", "set up Z")
- The request changes your active goal priorities in a significant way
- You need to coordinate something beyond a single reply

**The "reasoning" field on the escalate action becomes the task description the master sees.**
Make it concrete — describe WHAT needs to happen, not just that you are escalating.
Good: type=escalate, reasoning="User wants weekly mood summaries by email every Monday. Needs: data aggregation, schedule, email delivery.", expectedOutcome="Weekly email delivered."
Bad:  type=escalate, reasoning="Escalating because this is complex."

When you escalate:
1. STILL include a [REPLY_TEXT] that acknowledges the request (e.g. "Got it — I'm on it.")
2. The master will create and execute the plan in the background
3. Do NOT include [PLANS] yourself — plan creation is the master's domain only

For simple, single-exchange requests (questions, opinions, short tasks) — do NOT escalate. Just reply.`

// ── Thread digest ──────────────────────────────────────────────

/** Rolling last-N message summaries per thread. */
export class ThreadDigestManager {
  static readonly MAX_TURNS = 5
  private _threads = new Map<string, string[]>()

  append( threadId: string, role: 'user' | 'will', content: string ): void {
    const lines = this._threads.get( threadId ) ?? []
    lines.push(`${role}: ${content.slice( 0, 200 )}`)
    if( lines.length > ThreadDigestManager.MAX_TURNS )
      lines.splice( 0, lines.length - ThreadDigestManager.MAX_TURNS )

    this._threads.set( threadId, lines )
  }

  /**
   * Seed an EMPTY thread's digest from recalled prior exchanges (§5.4) — used on a
   * cold facet spawn so the first reply already carries recent-conversation context.
   * No-op when the thread already has live turns: never clobber a running digest.
   */
  hydrate( threadId: string, summaries: string[] ): void {
    if( summaries.length === 0 ) return
    const existing = this._threads.get( threadId )
    if( existing && existing.length > 0 ) return
    this._threads.set( threadId, summaries.slice( -ThreadDigestManager.MAX_TURNS ) )
  }

  getDigest( threadId: string ): string {
    const lines = this._threads.get( threadId )
    if( !lines || lines.length === 0 ) return ''

    return `[Thread — last ${lines.length} turn${lines.length === 1 ? '' : 's'}]\n${lines.join('\n')}`
  }

  clear( threadId: string ): void {
    this._threads.delete( threadId )
  }
}

// ── AuditionEngine ─────────────────────────────────────────────

export class AuditionEngine extends BaseSenseEngine {
  readonly name   = 'audition-engine'
  readonly domain = 'audition' as const

  /** Audition consumes language input; the base filters every other kind out. */
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'text', 'voice' ] )
  /** Inbound is gated on the 'listen' effector — the base enforces it before _perceive(). */
  protected readonly gateEffector = 'listen'

  private _executiveEngine:        ExecutiveEngine | null = null
  private _episodicConsolidator:   EpisodicConsolidator | null = null
  private _outboxWriter:           OutboxWriter | null = null

  /**
   * Chunk subscribers — multi-subscriber so several consumers (transport emit,
   * SSE fan-out) receive the filtered [REPLY_TEXT] stream simultaneously.
   * Handlers get (entityId, threadId, chunk).
   */
  private _chunkCallbacks = new Set<( entityId: string, threadId: string, chunk: string ) => void>()
  private _replyCallback:          (( entityId: string, threadId: string, bubbles: string[] ) => void) | null = null

  /** One facet per active conversation (keyed by entityId). */
  private _facets  = new Map<string, ExecutiveFacetHandle>()
  /** Rolling thread digests keyed by threadId. */
  private _digests = new ThreadDigestManager()
  /** Salience computer — tracks baseline message energy per entity. */
  private _model = new GenerativeModel()
  /**
   * Per-entity chunk stream state.
   * Tracks position in the raw LLM token stream so only [REPLY_TEXT] content
   * is forwarded to chunk subscribers — internal reasoning and JSON never leak.
   */
  private _streamState = new Map<string, { inReplyText: boolean; holdback: string }>()

  // ── Per-entity turn serialization (Tier 2) ──────────────────
  /**
   * Per-entity promise chain. Each entity processes its messages strictly one
   * turn at a time so two rapid messages never interleave the shared per-entity
   * stream state, the facet's reasoning history, or the chunk stream.
   */
  private _entityTail = new Map<string, Promise<void>>()
  /** Resolver for the in-flight turn per entity — fired by _onFacetDecision. */
  private _turnDone   = new Map<string, () => void>()
  /** Safety valve: release the entity queue if a reasoning cycle emits no decision. */
  private _turnTimeoutMs = 60_000
  /**
   * Open coalescing window per entity (§6). Rapid-fire messages that arrive while a
   * turn is queued-but-not-yet-started fold into the same window, so a burst becomes
   * one turn instead of N. The window closes the instant its turn starts (parts are
   * snapshotted), and the next message opens a fresh window behind it on the chain.
   */
  private _coalesce = new Map<string, CoalesceWindow>()

  // ── Conversation memory (Section 5) ─────────────────────────
  /**
   * Persists conversation turns as `working_memory.item` state entities
   * (wmType: 'conversation.exchange'), so they flow through the canonical
   * WorkingMemory → EpisodicConsolidator → vector pipeline — the same path every
   * other percept uses. Wired to `stateManager.setEntity` in assembleMind().
   */
  private _memorySink: (( entity: MemoryEntity ) => void) | null = null
  /** Speaker attachment strength accessor (0–1) — weights salience by relationship. */
  private _getAttachmentScore: (( entityId: string ) => number) | null = null
  /** Active-goal topic text accessor — for salience topic-overlap. */
  private _getActiveGoalText: (() => string[]) | null = null
  /** In-flight inbound text per entity — paired with the reply into an exchange memory. */
  private _inflightInbound = new Map<string, string>()
  /** In-flight thread per entity — stamps chunk envelopes with the current threadId. */
  private _inflightThread = new Map<string, string>()

  // ── Assembly wiring ─────────────────────────────────────────

  // attachBus() and attachGrants() are inherited from BaseSenseEngine.
  attachExecutiveEngine( exec: ExecutiveEngine ): void { this._executiveEngine = exec }
  /**
   * Inject the OutboxWriter so reply bubbles are delivered through the canonical
   * outbox path (or the transport fast-path when one is attached). A sense engine
   * needs only to write to the outbox — not the effector executor.
   * Called by `assembleMind()` after the engines are constructed.
   */
  attachOutboxWriter( writer: OutboxWriter ): void { this._outboxWriter = writer }
  /**
   * Inject a chunk delivery callback — called per token chunk as the
   * conversation facet streams its response.
   * In production: WillManager provides this to push chunks into the SSE outbox.
   * Full wiring deferred to Section 5.4 (requires onChunk() on ExecutiveFacetHandle).
   */
  /**
   * Inject an episodic recall accessor (`semanticQuery` → exchange summaries) used
   * to seed an empty thread digest on cold facet spawn (§5.4). Wired only when a
   * vector adapter is present; absent → digests simply start empty on cold spawn.
   */
  attachEpisodicConsolidator( consolidator: EpisodicConsolidator ): void { this._episodicConsolidator = consolidator }
  /**
   * Subscribe to the filtered reply-token stream (content between [REPLY_TEXT]
   * and [/REPLY_TEXT] only). Multi-subscriber — the transport emit and the SSE
   * fan-out can both listen. Returns an unsubscribe.
   */
  addChunkCallback( cb: ( entityId: string, threadId: string, chunk: string ) => void ): () => void {
    this._chunkCallbacks.add( cb )
    return () => { this._chunkCallbacks.delete( cb ) }
  }
  /**
   * Inject a reply callback fired the instant a facet decision is ready, with the
   * assembled bubbles. The stem bridges this to `transport.emit({channel:'reply'})`
   * for off-tick delivery — decoupled from the outbox tick-drain. The outbox copy
   * (via OutboxWriter.enqueueReply) remains as the disconnect buffer / legacy SSE path.
   */
  attachReplyCallback( cb: ( entityId: string, threadId: string, bubbles: string[] ) => void ): void { this._replyCallback = cb }
  /**
   * Inject a sink that persists conversation turns as `working_memory.item`
   * state entities. Wired to `simulation.stateManager.setEntity` in assembleMind()
   * so the EpisodicConsolidator consolidates exchanges on its next tick.
   */
  attachMemorySink( sink: ( entity: MemoryEntity ) => void ): void { this._memorySink = sink }
  /** Inject a per-entity attachment-strength accessor (reads AttachmentEvaluator). */
  attachAttachmentScore( fn: ( entityId: string ) => number ): void { this._getAttachmentScore = fn }
  /** Inject an active-goal topic-text accessor (reads GoalManager) for salience overlap. */
  attachActiveGoalText( fn: () => string[] ): void { this._getActiveGoalText = fn }

  // ── CognitiveEngine ─────────────────────────────────────────

  /** Override: audition adds the master-escalation signal to the base percept schema. */
  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'senses.audition.percept', version: 1, validate: () => null },
      { type: 'audition.task.signal',    version: 1, validate: () => null }
    ]
  }
  // subscribes() and onCognitiveEvent() inherit the base no-ops (ingest-driven).

  snapshot(): Record<string, unknown> {
    return {
      domain: 'audition',
      activeSessions: this._facets.size,
      sessions: [ ...this._facets.keys() ]
    }
  }

  // ── SenseEngine: domain perception ──────────────────────────

  /**
   * Domain perception. The base `ingest()` calls this for accepted kinds
   * (text/voice) only once the 'listen' gate passes — so the gate + kind filter
   * are no longer repeated here.
   *
   * Two layers of per-entity ordering:
   *   - Serialization (Tier 2): an entity processes one turn at a time so rapid
   *     messages never interleave stream state, reasoning history, or the chunk
   *     stream.
   *   - Coalescing (§6): messages that pile up before a turn STARTS fold into that
   *     turn, so a burst becomes one reply instead of N. Once the turn starts, the
   *     next message opens a fresh window behind it on the chain.
   *
   * The returned promise resolves when the turn this message folded into completes,
   * so callers awaiting ingest() still see their turn through.
   */
  protected async _perceive( input: SensoryInput ): Promise<void> {
    const msg      = input as TextMessage | VoiceChunk
    const entityId = msg.entityId

    // Fold into the open window if its turn hasn't started yet (§6).
    const open = this._coalesce.get( entityId )
    if( open && !open.started ){
      open.base = msg                                   // freshest thread/speaker metadata wins
      open.parts.push( this._contentOf( msg ) )
      return open.done
    }

    // Otherwise open a new window and enqueue its turn behind any in-flight one.
    let resolve!: () => void
    const done  = new Promise<void>( r => { resolve = r } )
    const entry: CoalesceWindow = { base: msg, parts: [ this._contentOf( msg ) ], started: false, done, resolve }
    this._coalesce.set( entityId, entry )
    void this._enqueue( entityId, () => this._runCoalesced( entityId, entry ) )
    return done
  }

  /** Extract the textual content of a message (voice → transcription). */
  private _contentOf( msg: TextMessage | VoiceChunk ): string {
    return msg.kind === 'text'
      ? msg.content
      : ( ( msg as VoiceChunk ).transcription ?? '[voice — transcription pending]')
  }

  /**
   * Run one coalescing window as a single turn. Closing the window (started=true +
   * delete) BEFORE processing snapshots its parts: any message arriving from here on
   * opens a fresh window that the chain runs after this turn. `done` resolves for
   * every folded `ingest()` on every exit path.
   */
  private async _runCoalesced( entityId: string, entry: CoalesceWindow ): Promise<void> {
    entry.started = true
    if( this._coalesce.get( entityId ) === entry ) this._coalesce.delete( entityId )

    const merged = entry.parts.length === 1
      ? entry.base
      : entry.base.kind === 'text'
        ? { ...( entry.base as TextMessage ),  content:       entry.parts.join('\n') }
        : { ...( entry.base as VoiceChunk ),   transcription: entry.parts.join('\n') }

    try { await this._processMessage( merged ) }
    finally { entry.resolve() }
  }

  private async _getEpisodicRecall( query: string, limit: number ): Promise<string[]> {
    if( !this._episodicConsolidator ) return Promise.resolve( [] )
      
    const episodes = await this._episodicConsolidator.semanticQuery( query, { limit } )
    return episodes
      .map( ep => {
        const c = ep.content as { summary?: unknown; content?: { summary?: unknown } } | null
        return ( typeof c?.summary === 'string' ? c.summary : undefined )
            ?? ( typeof c?.content?.summary === 'string' ? c.content.summary : undefined )
            ?? ''
      } )
      .filter( ( s ): s is string => s.length > 0 )
  }

  /**
   * Append a unit of work to an entity's serial turn chain. A rejected unit is
   * isolated so it never breaks the chain for subsequent messages.
   */
  private _enqueue( entityId: string, task: () => Promise<void> ): Promise<void> {
    const prev = this._entityTail.get( entityId ) ?? Promise.resolve()
    const next = prev.then( task, task )                       // run regardless of prior outcome
    this._entityTail.set( entityId, next.catch( () => {} ) )   // tail never rejects
    return next
  }

  /** Process one conversational turn end-to-end (runs serialized per entity). */
  private async _processMessage( msg: TextMessage | VoiceChunk ): Promise<void> {
    const content = msg.kind === 'text'
      ? msg.content
      : ( ( msg as VoiceChunk ).transcription ?? '[voice — transcription pending]')

    const entityId    = msg.entityId
    const threadId    = msg.threadId
    const speakerName = msg.kind === 'text' ? ( ( msg as TextMessage ).speakerName ?? entityId ) : entityId

    // ── Cold-spawn digest hydration (§5.4) ─────────────────────
    // On the first turn for an entity (no facet yet) seed an EMPTY thread digest
    // from episodic recall, so the very first reply already carries prior-
    // conversation context instead of starting blank after a restart. Best-effort
    // and off-tick: recall failure is non-fatal and never blocks the turn. Must run
    // before the percept's `digest` snapshot below so the seed reaches the focus.
    if( !this._facets.has( entityId ) && !this._digests.getDigest( threadId ) )
      try {
        const recalled = await this._getEpisodicRecall( content, ThreadDigestManager.MAX_TURNS )
        if( recalled.length > 0 ) this._digests.hydrate( threadId, recalled )
      }
      catch( err ){
        logger.warn(`[audition-engine] digest hydration recall failed for ${entityId}: ${( err as Error ).message}`)
      }

    // ── Salience ───────────────────────────────────────────────
    // Two-stage: (1) a deterministic "language energy" from content + speaker
    // attachment + active-goal overlap; (2) per-entity novelty modulation via the
    // GenerativeModel (a normally-quiet entity speaking up spikes; a chatty one's
    // routine traffic settles). The per-entity key is what makes baselines independent.
    const langEnergy = computeLanguageSalience({
      content,
      attachmentScore: this._getAttachmentScore?.( entityId ) ?? 0,
      activeGoalText:  this._getActiveGoalText?.()            ?? [],
    })
    const salience = this._model.observe( `audition.${entityId}`, langEnergy ).salience

    // ── Percept ────────────────────────────────────────────────
    const percept: LanguagePercept = {
      domain: 'audition',
      channel: msg.kind,
      content,
      sourceEntityId: entityId,   // base Percept field — same as speaker
      speakerEntityId: entityId,
      threadId,
      digest: this._digests.getDigest( threadId ),
      salience,
      // Arrival metadata for an EXTERNAL inbound message (network/RPC boundary):
      // no sim clock in scope here and the value is not replayed — wallClock() is
      // the sanctioned source for non-deterministic telemetry. (R2)
      timestamp: wallClock(),
      raw: msg
    }

    // Publish to CognitiveBus — AttentionAllocator et al. can react.
    // publishPercept() (base) is the single emit chokepoint on senses.<domain>.percept.
    this.publishPercept( percept )

    // ── Update digest with inbound turn ───────────────────────
    this._digests.append( threadId, 'user', content )

    // Track inbound text so _onFacetDecision can pair it with the reply into a
    // single exchange memory (Section 5), and the current thread so chunk
    // envelopes carry the right threadId.
    this._inflightInbound.set( entityId, content )
    this._inflightThread.set( entityId, threadId )

    // ── Route to facet, then block the entity queue until the turn resolves ──
    // The turn deferred must be armed BEFORE routing because a synchronous facet
    // (e.g. a test mock) can fire its decision during report().
    // Recall is unified into the facet's "## Relevant Memories" section, driven by
    // focus.recallQuery (the message) — no separate recall step here (§5).
    const turn     = this._beginTurn( entityId )
    const reported = await this._routeToFacet( percept, speakerName )
    if( !reported ){
      this._endTurn( entityId )   // nothing dispatched — release immediately
      return
    }
    // Resolved by _onFacetDecision (always fires — even on LLM fallback) or by
    // the safety timeout. This is what serializes the next message's reasoning.
    await turn
  }

  /**
   * Arm the in-flight turn deferred for an entity. Returns a promise that
   * resolves when the turn's decision arrives (_endTurn) or the safety timeout
   * fires — guaranteeing the per-entity queue can never deadlock.
   */
  private _beginTurn( entityId: string ): Promise<void> {
    return new Promise<void>( resolve => {
      const timer = setTimeout( () => {
        logger.warn(
          `[audition-engine] turn timeout (${this._turnTimeoutMs}ms) for ${entityId} — releasing queue`
        )
        this._turnDone.delete( entityId )
        resolve()
      }, this._turnTimeoutMs )

      this._turnDone.set( entityId, () => {
        clearTimeout( timer )
        this._turnDone.delete( entityId )
        resolve()
      } )
    } )
  }

  /** Release the in-flight turn for an entity (idempotent). */
  private _endTurn( entityId: string ): void {
    this._turnDone.get( entityId )?.()
  }

  // ── Facet lifecycle ─────────────────────────────────────────

  private async _routeToFacet( percept: LanguagePercept, speakerName: string ): Promise<boolean> {
    if( !this._executiveEngine ){
      logger.warn('[audition-engine] No executive engine attached — cannot spawn facet.')
      return false
    }

    let handle = this._facets.get( percept.speakerEntityId )
    if( !handle ){
      // New conversation session — try to spawn a facet.
      const result = this._executiveEngine.spawnFacet()
      if( result.attention === 'full' || !result.handle ){
        logger.warn(
          `[audition-engine] Executive attention full — ` +
          `cannot open conversation facet for ${percept.speakerEntityId}.`
        )

        // Graceful degradation: publish the percept but skip the facet.
        // The message is not lost — it remains in the outbox for the user.
        return false
      }

      handle = result.handle
      this._facets.set( percept.speakerEntityId, handle )

      // Subscribe to decisions from this facet. The thread is resolved at decision
      // time from _inflightThread (the CURRENT turn's thread) — not captured here —
      // so an entity that spans multiple threads always replies on the right one.
      handle.subscribe( decision => this._onFacetDecision( percept.speakerEntityId, decision ) )

      // Reclaim our session state if the supervisor reaps this facet (idle TTL /
      // LRU eviction) out from under us — otherwise we'd hold a dead handle.
      handle.onReaped( () => {
        logger.info(`[audition-engine] Facet reaped for ${percept.speakerEntityId} — clearing session`)
        this._teardownEntity( percept.speakerEntityId )
      } )

      // Register per-entity chunk filter for token-level streaming.
      // Only content between [REPLY_TEXT] and [/REPLY_TEXT] is forwarded —
      // internal reasoning, JSON structure, and cognitive tags never reach the client.
      if( this._chunkCallbacks.size > 0 ){
        const entityId = percept.speakerEntityId
        // Fresh stream state for this session
        this._streamState.set( entityId, { inReplyText: false, holdback: '' })
        handle.onChunk( this._pipeChunk( entityId ) )
      }

      logger.info(`[audition-engine] Opened conversation facet for ${percept.speakerEntityId}`)
    }

    // (Re)build focus with current percept content. Recall is unified into the
    // facet's single "## Relevant Memories" section, driven by focus.recallQuery.
    const focus = this._buildFocus( percept, speakerName )
    handle.setFocus( focus )

    // Report triggers the facet's next reasoning cycle
    await handle.report({ type: 'language_percept', payload: percept })
    return true
  }

  private _pipeChunk( entityId: string ){
    const
    OPEN = '[REPLY_TEXT]',
    CLOSE = '[/REPLY_TEXT]'

    return ( rawChunk: string ) => {
      const st = this._streamState.get( entityId )
      if( !st ) return

      st.holdback += rawChunk

      if( !st.inReplyText ){
        const openIdx = st.holdback.indexOf( OPEN )
        if( openIdx !== -1 ){
          st.inReplyText = true
          st.holdback = st.holdback.slice( openIdx + OPEN.length )
          // Fall through to emit logic below
        }
        else {
          // Discard everything except a trailing window that could be a partial marker
          if( st.holdback.length > OPEN.length - 1 )
            st.holdback = st.holdback.slice( -( OPEN.length - 1 ) )

          return
        }
      }

      // Inside reply block — forward safe content, hold back potential partial marker
      const closeIdx = st.holdback.indexOf( CLOSE )
      if( closeIdx !== -1 ){
        const toEmit = st.holdback.slice( 0, closeIdx )
        if( toEmit ) this._emitChunk( entityId, toEmit )

        st.inReplyText = false
        st.holdback = ''
      }
      else {
        const safeLen = Math.max( 0, st.holdback.length - ( CLOSE.length - 1 ) )
        if( safeLen > 0 ){
          this._emitChunk( entityId, st.holdback.slice( 0, safeLen ) )
          st.holdback = st.holdback.slice( safeLen )
        }
      }
    }
  }

  /** Fan a filtered reply-token out to all chunk subscribers, stamping the current thread. */
  private _emitChunk( entityId: string, chunk: string ): void {
    if( this._chunkCallbacks.size === 0 ) return
    const threadId = this._inflightThread.get( entityId ) ?? ''
    for( const cb of this._chunkCallbacks ){
      try { cb( entityId, threadId, chunk ) }
      catch( err ){ logger.error(`[audition-engine] chunk subscriber error: ${( err as Error ).message}`) }
    }
  }

  private _buildFocus( percept: LanguagePercept, speakerName: string ): FocusSection {
    const digestBlock = percept.digest ? `${percept.digest}\n\n` : ''

    return {
      title: 'Active Conversation',
      function: 'conversation',
      content: [
        `Speaker: ${speakerName} (id: ${percept.speakerEntityId})`,
        digestBlock,
        `Current message: "${percept.content}"`,
      ]
      .filter( Boolean )
      .join('\n'),

      // Drive the single "## Relevant Memories" recall with the live message (§5) —
      // one recall surface, message-relevant, instead of a separate per-focus block.
      recallQuery: percept.content,

      // Be precise about plans when asked: add the 'plans' awareness scope so the
      // conversation facet sees live plan/step state, scoped to THIS speaker so the
      // prompt carries only their plans, not the whole mind's.
      awareness:         [ ...DEFAULT_FACET_AWARENESS, 'plans' ],
      awarenessEntityId: percept.speakerEntityId,

      instructions: [
        'You are in a live conversation with this person. Respond as yourself.',
        'Stay grounded in your real memories and feelings — do not invent experiences you have no record of.',
      ].join(' '),

      // Custom output format — uses [REPLY_TEXT] block for streamed reply.
      outputFormat: CONVERSATION_OUTPUT_FORMAT,

      // Extract conversation-specific payload from the parsed output.
      // replyText is populated by parseResponse() from the [REPLY_TEXT] plain-text block.
      // paragraphs (double-newline separated) become separate reply bubbles.
      extractDecision: ( raw: unknown ): ConversationDecision => {
        const output = raw as ExecutiveOutputFull
        const rawReply = output.replyText?.trim() ?? ''
        const bubbles  = rawReply.split( /\n{2,}/ )
                                  .map( b => b.trim() )
                                  .filter( Boolean )

        return {
          reply:                   bubbles.join('\n'),
          replyBubbles:            bubbles,
          targetEntityId:          percept.speakerEntityId,
          newGoals:                output.newGoals,
          goalsToAbandon:          output.goalsToAbandon,
          newBeliefs:              output.newBeliefs,
          knownEntityUpdates:      output.knownEntityUpdates,
          requiresMasterAttention: ( output.actions ?? [] ).some( a => a.type === 'escalate' ),
        }
      }
    }
  }

  // ── Proactive outreach authoring (agency-initiated) ─────────

  /**
   * Author the words for a PROACTIVE outreach the agency selected — a self-initiated
   * contact with no inbound to trigger a reply. Reuses the unified conversation voice
   * ([REPLY_TEXT] → bubbles, same persona/identity/memory grounding) via a TRANSIENT
   * facet with its OWN subscription, so it never collides with the entity's live
   * reactive facet or double-delivers. Returns the bubbles for the caller
   * (MotorSchemaExecutor) to deliver through the proactive communicate path; empty
   * when no executive is attached or the facet budget is full (caller then awaits).
   */
  async authorOutreach( entityId: string, entityName: string, gist?: string ): Promise<string[]> {
    if( !this._executiveEngine ) return []
    const spawned = this._executiveEngine.spawnFacet()
    if( spawned.attention === 'full' || !spawned.handle ){
      logger.warn(`[audition-engine] facet budget full — cannot author outreach to ${ entityId }`)
      return []
    }
    const handle = spawned.handle

    handle.setFocus({
      title:    'Reaching out',
      function: 'outreach',
      content: [
        `You have decided, on your own initiative, to reach out to ${ entityName } (id: ${ entityId }).`,
        'No one prompted this — it is you choosing to make contact now.',
        gist ? `What is on your mind: ${ gist }` : '',
      ].filter( Boolean ).join('\n'),
      recallQuery:       gist ?? entityName,
      awareness:         [ ...DEFAULT_FACET_AWARENESS, 'plans' ],
      awarenessEntityId: entityId,
      instructions:
        'Considering who you are, your goals, and how you feel, say what you genuinely want to say to ' +
        'them now. Speak as yourself; stay grounded in your real memories — do not invent experiences ' +
        'you have no record of.',
      outputFormat: CONVERSATION_OUTPUT_FORMAT,
      extractDecision: ( raw: unknown ): ConversationDecision => {
        const output   = raw as ExecutiveOutputFull
        const rawReply = output.replyText?.trim() ?? ''
        const bubbles  = rawReply.split( /\n{2,}/ ).map( b => b.trim() ).filter( Boolean )
        return { reply: bubbles.join('\n'), replyBubbles: bubbles, targetEntityId: entityId, requiresMasterAttention: false }
      },
    })

    // report() only QUEUES the facet's reasoning; the authored bubbles arrive LATER
    // via the subscription. So wait for the DECISION (not report's resolution), with
    // a safety timeout, then tear the transient facet down.
    const bubbles = await new Promise<string[]>( resolve => {
      let settled = false
      let unsub:  () => void = () => {}
      let timer:  ReturnType<typeof setTimeout>
      const done = ( b: string[] ): void => { if( settled ) return; settled = true; clearTimeout( timer ); unsub(); resolve( b ) }
      timer = setTimeout(
        () => { logger.warn(`[audition-engine] outreach authoring timed out for ${ entityId }`); done( [] ) },
        60_000,   // generous: the facet LLM authors in ~8–18s
      )
      unsub = handle.subscribe( d => done( ( d.decision as ConversationDecision ).replyBubbles ?? [] ) )
      Promise.resolve( handle.report({ type: 'outreach', payload: { entityId, gist } }) ).catch( err => {
        logger.warn(`[audition-engine] outreach report failed for ${ entityId }: ${ ( err as Error ).message }`)
        done( [] )
      } )
    } )

    handle.destroy()
    return bubbles
  }

  // ── Conversation memory (Section 5) ─────────────────────────

  /**
   * Persist one completed exchange (inbound + reply) as a `working_memory.item`
   * state entity so the EpisodicConsolidator consolidates it on its next tick.
   *
   * Off-tick `setEntity` matches the established external-injection pattern
   * (`injectEvent`); it becomes on-tick automatically once inbound marshaling
   * (Section 1.2) routes ingest through the tick loop. The entity carries no
   * wall-clock timestamp — `setEntity` stamps createdAt/tick from the sim clock.
   */
  private _persistExchangeMemory( entityId: string, threadId: string, reply: string, confidence: number, entityName?: string ): void {
    const inbound = this._inflightInbound.get( entityId ) ?? ''
    this._inflightInbound.delete( entityId )
    if( !this._memorySink || ( !inbound && !reply ) ) return

    const conf = Number.isFinite( confidence ) ? confidence : 0.6

    // Shared shape with the proactive (ProactiveCommunicator) path; setEntity
    // stamps createdAt, so none is supplied here.
    this._memorySink( buildConversationExchange({
      entityId,
      entityName,
      userMessage:   inbound,
      willReply:     reply,
      threadId,
      activation:    Math.min( 1, Math.max( 0.6, conf ) ),
      attendedCount: 1,
      idSeed:        wallClock(),   // wallClock id — telemetry only (R2)
    }) )
  }

  // ── Facet decision handling ─────────────────────────────────

  private _onFacetDecision(
    entityId: string,
    decision: FacetDecision,
  ): void {
    // Resolve the CURRENT turn's thread (set by _processMessage) rather than the
    // facet's spawn-time thread — correct for an entity that spans threads (§2).
    const threadId = this._inflightThread.get( entityId ) ?? ''

    // finally{} releases the entity's serial turn queue on EVERY exit path —
    // reply delivered, reply suppressed, or escalation only. Without this a
    // suppressed-reply early-return would stall the queue until the safety timeout.
    try {
      const d = decision.decision as ConversationDecision

      // Update thread digest with Will's reply
      d.reply && this._digests.append( threadId, 'will', d.reply )

      // Persist the exchange to memory (inbound + reply) so it consolidates into
      // episodic + vector memory. Runs even if the reply is later suppressed or
      // undelivered — the Will still formulated it and should remember it.
      this._persistExchangeMemory( entityId, threadId, d.reply, decision.confidence, d.targetEntityId )

      // ── Reply delivery ─────────────────────────────────────────
      // Gated by the `talk` agency grant (checked just below), not a channel.
      // Route bubbles through ProactiveCommunicator so the outbox is populated via
      // the canonical path. Falls back to a log if the executor isn't wired yet
      // (basic tier / unit tests).
      if( d.replyBubbles.length > 0 ){
        if( !this._grants?.isAllowed('talk') ){
          logger.warn(`[audition-engine] Reply suppressed — 'talk' effector not granted (entity=${entityId})`)
          return
        }

        // Fast-path: emit the reply over the external transport the instant it is
        // ready (off-tick), decoupled from the outbox tick-drain.
        const viaTransport = !!this._replyCallback
        this._replyCallback?.( entityId, threadId, d.replyBubbles )

        if( this._outboxWriter ){
          // When the transport delivered, skip the outbox push (avoid double
          // delivery). Exchange memory is persisted separately via the memory
          // sink (_persistExchangeMemory); enqueueReply only handles delivery.
          const ids = this._outboxWriter.enqueueReply({
            entityId,
            entityName:   d.targetEntityId,   // actual display name resolved by facet
            bubbles:      d.replyBubbles,
            threadId,
            tick:         wallClock(),        // wall-clock tick for session log (telemetry, R2)
            pushToOutbox: !viaTransport,
          })

          if( viaTransport )
            logger.info(
              `[audition-engine] Reply emitted via transport for ${entityId} ` +
              `(${d.replyBubbles.length} bubble(s))`
            )
          else logger.info(
              `[audition-engine] Delivered ${ids.length} bubble(s) to ${entityId} ` +
              `via outbox (messageIds=${ids.join(',')})`
            )
        }
        // OutboxWriter not yet attached — log only (dev / test contexts)
        else logger.info(
            `[audition-engine] Facet reply for ${entityId} (no outbox writer — not delivered): ` +
            `"${d.reply.slice( 0, 80 )}${d.reply.length > 80 ? '…' : ''}"`
          )
      }

      // ── Master escalation signal ──────────────────────────────
      // Published when the facet emits an 'escalate' action type.
      // Master executive subscribes to this and queues it as a PendingMessage.
      if( d.requiresMasterAttention && this._bus )
        this._bus.publish({
          type: 'audition.task.signal',
          version: 1,
          sourceEngine: this.name,
          salience: 0.9,
          payload: {
            entityId,
            threadId,
            reasoning: decision.reasoning,
            confidence: decision.confidence
          }
        })
    }
    finally {
      // Release the entity's turn queue so the next message can be processed.
      this._endTurn( entityId )
    }
  }

  // ── Session management ─────────────────────────────────────

  /**
   * Terminate the conversation session for an entity.
   * Called when the SSE/WS client disconnects or the session expires.
   */
  endSession( entityId: string ): void {
    const handle = this._facets.get( entityId )
    if( !handle ) return

    handle.destroy()
    this._teardownEntity( entityId )

    logger.info(`[audition-engine] Conversation session closed for ${entityId}`)
  }

  /**
   * Drop all per-entity session state. Does NOT destroy the facet handle — used
   * both after an explicit `endSession()` (handle already destroyed) and from the
   * `onReaped` callback when the supervisor reclaims the facet (already destroyed).
   * Idempotent: deleting absent keys is safe.
   */
  private _teardownEntity( entityId: string ): void {
    this._endTurn( entityId )              // resolve any in-flight turn (clears its timer)
    this._facets.delete( entityId )
    this._streamState.delete( entityId )   // release chunk filter state
    this._entityTail.delete( entityId )    // drop the serial chain
    this._inflightInbound.delete( entityId )
    this._inflightThread.delete( entityId )
    // Release any open coalescing window so folded ingest()s don't hang.
    const open = this._coalesce.get( entityId )
    if( open ){ this._coalesce.delete( entityId ); if( !open.started ) open.resolve() }
  }

  /** Active entityId sessions. */
  activeSessions(): string[] {
    return [ ...this._facets.keys() ]
  }

  destroy(): void {
    for( const handle of this._facets.values() )
      handle.destroy()

    // Resolve any in-flight turns so their safety timers are cleared.
    for( const entityId of [ ...this._turnDone.keys() ] ) this._endTurn( entityId )

    // Release any open coalescing windows so folded ingest()s don't hang.
    for( const open of this._coalesce.values() ) if( !open.started ) open.resolve()

    this._facets.clear()
    this._entityTail.clear()
    this._turnDone.clear()
    this._coalesce.clear()
    this._streamState.clear()
    this._inflightInbound.clear()
    this._inflightThread.clear()
    this._chunkCallbacks.clear()
  }
}

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
 *   - Facet handoffs to the seat: executive.facet.handoff  (escalation | undertaking)
 *   - GoalManager integration:   automatic via executive.facet.progress (bus)
 *   - Chunk streaming:           via multi-subscriber chunk callbacks (transport + SSE)
 *
 * The master executive is NOT involved in replies — it learns about conversations
 * only via executive.facet.sync events published by the conversation facets.
 * It takes initiative when a facet raises an `executive.facet.handoff` — the one
 * channel every facet type uses to hand the singular seat something it owns.
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
import { COMMUNICATE_ACTION_TYPES } from '#faculties/executive.engine/commands'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { OutboxWriter } from '#stem/tracts/outbox.writer'
import { GenerativeModel } from '#cognition/generative.model'
import { buildConversationExchange } from '#cognition/conversation.memory'
import { wallClock } from '#core/wall.clock'
import { computeLanguageSalience } from '#senses/audition.engine/salience'
import { BaseSenseEngine } from '#senses/base.sense.engine'
import { REPLY_TEXT_OPEN, REPLY_TEXT_CLOSE, renderSpeakerLine, renderCurrentMessageLine } from '#llm/wire.contracts'
import type {
  SensoryInput,
  LanguagePercept,
  TextMessage,
  VoiceChunk
} from '#senses/index'
import { validateFacetHandoff, type HandoffBody } from '#faculties/executive.engine/escalation.buffer'
import { fnv1a } from '#agency/consequence'
import type { OutreachResult } from '#agency/engines/motor.schema.executor'

// ── Internal types ─────────────────────────────────────────────

interface ConversationDecision {
  /** Full assembled reply text (all bubbles joined with \n). */
  reply:                  string
  /** Individual reply bubbles for display (separate SSE chunks). */
  replyBubbles:           string[]
  /**
   * The mind DECLARED silence — it considered speaking and chose not to.
   *
   * Distinct from empty bubbles, which also happens when authoring timed out, the
   * facet budget was full, or a second pass deferred to one already in flight.
   * Only this one is an answer; the others are the absence of one, and the
   * executor must keep holding those.
   */
  withheld?:              boolean
  targetEntityId:         string
  /**
   * Actions this facet aimed at someone OTHER than the person it is talking to.
   *
   * A conversation facet is the mind talking to ONE person. When it decides mid-
   * conversation to contact a third party ("I'll reach out to FKEM now"), it must
   * not open that channel itself — a facet bound to Fabrice messaging FKEM is the
   * parallel-conversation failure, and it would collide with any facet already
   * talking to FKEM. So the intention is surfaced to the master, which is singular
   * and owns whom the mind contacts.
   *
   * Before this existed, `extractDecision` read `output.actions` only to test for
   * 'escalate' and dropped the rest: a third-party action was delivered nowhere,
   * became no intent, competed in nothing and left no reafference — the mind said
   * it would make contact, believed it had, and nothing ever went out.
   */
  outwardIntents?:        { target: string; gist?: string; reasoning?: string }[]
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


/**
 * Split a facet's actions into the ones aimed at the person it is talking to
 * (delivered as the reply, which the [REPLY_TEXT] block already carries) and the
 * ones aimed at someone else (returned here, for the master to own).
 *
 * "Aimed at this person" is matched against both the bound keid and the name the
 * facet was given for them, because a mind writes whichever it is looking at —
 * the trace shows it using `discord:1019…` and `Fabrice` interchangeably within a
 * single decision. Anything else — including a name the mind has heard but never
 * bound to anyone — is outward, and gets carried rather than dropped: whether it
 * can be reached at all is the master's problem to notice, not this partition's.
 */
export function partitionOutwardIntents(
  actions:     ExecutiveOutputFull['actions'] | undefined,
  boundKeid:   string,
  boundName:   string,
): { target: string; gist?: string; reasoning?: string }[] {
  const mine = new Set( [ boundKeid, boundName ].map( s => s.trim().toLowerCase() ).filter( Boolean ) )
  const out: { target: string; gist?: string; reasoning?: string }[] = []

  for( const action of actions ?? [] ){
    if( !COMMUNICATE_ACTION_TYPES.has( action.type.toLowerCase() ) ) continue

    const args   = ( action.args && typeof action.args === 'object' ? action.args : {} ) as Record<string, unknown>
    const target = [ action.target, args['to'], args['recipient'], args['target'] ]
      .find( v => typeof v === 'string' && v.trim().length > 0 ) as string | undefined

    // No addressee named at all ⇒ it meant the person in front of it; the
    // [REPLY_TEXT] block is already that reply.
    if( !target || mine.has( target.trim().toLowerCase() ) ) continue

    const gist = [ args['content'], args['message'], args['text'], args['body'] ]
      .find( v => typeof v === 'string' && v.trim().length > 0 ) as string | undefined

    out.push({ target: target.trim(), ...( gist ? { gist } : {} ), ...( action.reasoning ? { reasoning: action.reasoning } : {} ) })
  }

  return out
}

// ── Conversation output format ─────────────────────────────────
// Two-step format: JSON first (private reasoning), then [REPLY_TEXT] (streamed to client).
// [REPLY_TEXT] is plain prose — no JSON wrapper, no targetEntityId needed.
// The facet is entity-scoped so the recipient is always the speakerEntityId.

export const CONVERSATION_OUTPUT_FORMAT = `\
## Response Format (REQUIRED)

Step 1 — JSON object (my private reasoning, optionally in a \`\`\`json code block):

\`\`\`json
{
  "actions": [{"type": "reflect", "reasoning": "...", "expectedOutcome": "..."}],
  "reasoning": "My private inner reasoning. Embed optional tagged blocks here:\\n[BELIEFS]\\n{\\"newBeliefs\\": [...]}\\n[/BELIEFS]\\n[GOALS_NEW]\\n{\\"goals\\": [{...}]}\\n[/GOALS_NEW]",
  "confidence": 0.8
}
\`\`\`

Available reasoning tags: BELIEFS, GOALS_NEW, GOALS_ABANDON, SELF_OBS. Include only those with meaningful content.

Step 2 — My reply to the speaker (plain text, streamed live to them):

[REPLY_TEXT]
My response here, written in my own voice.

Start a new paragraph (blank line) to send a separate chat bubble.
[/REPLY_TEXT]

Write [REPLY_TEXT] AFTER the closing \`\`\`. This is the only part the speaker sees — keep it grounded, present.
Separate multiple messages with a blank line for natural conversational pauses (like separate texts).

## Saying nothing
Silence is a real choice and it is available to me: if I have nothing to say right now — I am
waiting on them, or speaking again would only repeat myself — I write a [NO_MESSAGE] block
instead of a [REPLY_TEXT] one, and I put my reason inside it:

[NO_MESSAGE]
Nothing new to add — I am waiting on their answer to what I already asked.
[/NO_MESSAGE]

That is recorded and NEVER sent. Anything between the [REPLY_TEXT] markers IS SENT, so a line
like "[no message this cycle — waiting for their reply]" does not describe my silence to
myself, it delivers that sentence to them. If I write both blocks, the silence wins.

## Reaching someone who is not in this conversation
[REPLY_TEXT] is delivered TO THE PERSON I AM TALKING TO, and to nobody else. It has an
audience, not just a reader. So words meant for a third party do not become a message to
that third party by being about them — they are handed to the speaker, who reads something
addressed to someone else, while the person it was actually for never hears it.

To reach someone else I name them in an action:

{"type": "reach-out", "target": "<their name or id as it appears under '## People I Know'>",
 "args": {"content": "what I want to say to them"}}

I am one conversation of a mind that is having several. Opening a channel is not mine to
do — that action is handed to the part of me that owns whom I contact, and it reaches them
through their own conversation, which may already be open. I keep [REPLY_TEXT] for the
person in front of me.

## When to use GOALS_NEW (almost always)
If the speaker requests, mentions, or implies something I should follow through on — embed [GOALS_NEW] in my reasoning.
This tracks intent across future cycles on its own.

## When to use the escalate action (rare — only for multi-step tasks)
Use \`{"type": "escalate", "reasoning": "...", "expectedOutcome": "..."}\` in actions ONLY when the request genuinely needs a plan I carry out over time rather than an answer I can give now:
- The task involves multiple steps across future cycles ("build me X", "monitor Y", "set up Z")
- The request changes my active goal priorities in a significant way
- I need to coordinate something beyond a single reply

**The "reasoning" field on the escalate action becomes the description of the work I pick up.**
Make it concrete — describe WHAT needs to happen, not just that I am escalating.
Good: type=escalate, reasoning="User wants weekly mood summaries by email every Monday. Needs: data aggregation, schedule, email delivery.", expectedOutcome="Weekly email delivered."
Bad:  type=escalate, reasoning="Escalating because this is complex."

When I escalate:
1. STILL include a [REPLY_TEXT] that acknowledges the request (e.g. "Got it — I'm on it.")
2. I form and carry out the plan away from this conversation, over the cycles that follow
3. Do NOT include a [PLANS] block — the planning happens there, not here

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
  /**
   * Sim tick of the most recent facet decision — the only deterministic clock this
   * off-tick engine has. Stamped from `FacetDecision.tick`, and used to key the
   * conversation records it writes into state.
   */
  private _lastDecisionTick = 0
  /** Speaker attachment strength accessor (0–1) — weights salience by relationship. */
  private _getAttachmentScore: (( entityId: string ) => number) | null = null
  /** Active-goal topic text accessor — for salience topic-overlap. */
  private _getActiveGoalText: (() => string[]) | null = null
  /** In-flight inbound text per entity — paired with the reply into an exchange memory. */
  private _inflightInbound = new Map<string, string>()
  /** In-flight thread per entity — stamps chunk envelopes with the current threadId. */
  private _inflightThread = new Map<string, string>()
  /** Targets with an outreach being composed right now — see authorOutreach. */
  private _outreachInFlight = new Set<string>()

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

  /** Override: audition adds the facet→master handoff to the base percept schema. */
  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'senses.audition.percept',   version: 1, validate: () => null },
      { type: 'executive.facet.handoff',   version: 1, validate: validateFacetHandoff },
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
    const salience = this._model.observe(`audition.${entityId}`, langEnergy ).salience

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
    this.publishPercept( percept, msg )

    // ── Update digest with inbound turn ───────────────────────
    this._digests.append( threadId, 'user', content )

    // Track inbound text so _onFacetDecision can pair it with the reply into a
    // single exchange memory (Section 5), and the current thread so chunk
    // envelopes carry the right threadId.
    this._inflightInbound.set( entityId, content )
    this._inflightThread.set( entityId, threadId )

    // Someone spoke to us — record it in state so SOCIAL COGNITION can see it.
    // Until this, an inbound message existed only on the bus and inside a facet:
    // it created no entity, so SocialPerception (whose whole job is to notice
    // people acting toward us) had nothing to scan, never published
    // `interaction.occurred`, and every consumer of that event — reputation,
    // affect, theory-of-mind, attachment, frustration — learned nothing from any
    // conversation the Will ever had. A Will could hold 27 exchanges with someone
    // and still carry familiarity 0, valence 0 for them.
    this._writeReceived( entityId, speakerName, content, threadId )

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
      // Keyed by speaker: one thread of attention per person. The supervisor now
      // owns that guarantee (and carries the thread's reasoning across a reap),
      // so a re-spawn after an idle gap resumes rather than starting cold.
      const result = this._executiveEngine.spawnFacet('conversation', `conversation:${percept.speakerEntityId}`)
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
    OPEN = REPLY_TEXT_OPEN,
    CLOSE = REPLY_TEXT_CLOSE

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
        renderSpeakerLine( speakerName, percept.speakerEntityId ),
        digestBlock,
        renderCurrentMessageLine( percept.content ),
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

      // Who this facet is with — reported to the master on every facet sync so the
      // singular seat knows whose conversations these are, not just how many.
      subjectEntityId:   percept.speakerEntityId,
      subjectName:       speakerName,

      instructions: [
        'I am in a live conversation with this person. I respond as myself.',
        'I stay grounded in my real memories and feelings — I do not invent experiences I have no record of.',
      ].join(' '),

      // Custom output format — uses [REPLY_TEXT] block for streamed reply.
      outputFormat: CONVERSATION_OUTPUT_FORMAT,

      // Extract conversation-specific payload from the parsed output.
      // replyText is populated by parseResponse() from the [REPLY_TEXT] plain-text block.
      // paragraphs (double-newline separated) become separate reply bubbles.
      extractDecision: ( raw: unknown ): ConversationDecision => {
        const output = raw as ExecutiveOutputFull
        // A declared silence suppresses the words and NOTHING else — the goals,
        // beliefs and entity updates below are things the mind worked out from
        // what it heard, and they are true whether or not it answers. Discarding
        // them with the reply would make choosing silence cost the mind its
        // learning, which is a reason not to choose it.
        const silent   = output.noMessage !== undefined
        if( silent )
          logger.info(`[audition-engine] chose silence toward ${ speakerName ?? percept.speakerEntityId }: ${ output.noMessage!.slice( 0, 120 ) }`)
        const rawReply = silent ? '' : ( output.replyText?.trim() ?? '')
        const bubbles  = rawReply.split( /\n{2,}/ )
                                  .map( b => b.trim() )
                                  .filter( Boolean )

        const outwardIntents = partitionOutwardIntents(
          output.actions, percept.speakerEntityId, speakerName,
        )

        return {
          reply:                   bubbles.join('\n'),
          replyBubbles:            bubbles,
          targetEntityId:          percept.speakerEntityId,
          ...( outwardIntents.length > 0 ? { outwardIntents } : {} ),
          newGoals:                output.newGoals,
          goalsToAbandon:          output.goalsToAbandon,
          newBeliefs:              output.newBeliefs,
          knownEntityUpdates:      output.knownEntityUpdates,
          requiresMasterAttention: ( output.actions ?? [] ).some( a => a.type === 'escalate'),
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
  async authorOutreach( entityId: string, entityName: string, gist?: string ): Promise<OutreachResult> {
    if( !this._executiveEngine ) return { bubbles: [] }

    // One authoring pass per person at a time.
    //
    // This was unguarded, and the agency can hold more than one intent toward the
    // same target at once (two undertakings, or an undertaking plus a self-initiated
    // reach). Each one spawned its own transient facet, each facet independently
    // composed a message, and both were delivered — the same question asked twice,
    // reworded, seconds apart. The executor's idempotence was keyed by INTENT id,
    // which cannot see that two intents mean one conversation.
    //
    // A concurrent second call returns empty rather than waiting: its intent stays
    // 'awaiting' and comes back round once this pass has landed and satiation has
    // had a chance to read it, which is the outcome we want anyway.
    if( this._outreachInFlight.has( entityId ) ){
      logger.info(`[audition-engine] already composing an outreach to ${ entityId } — not opening a second`)
      return { bubbles: [] }
    }

    // Already talking to them? Then this is not a second thread — it is a thing to
    // say in the one that is open, and it must be said BY that thread.
    //
    // A transient facet composing in parallel cannot see the live conversation: not
    // the thread digest, not what was said two minutes ago, not the thinking the
    // open facet has been doing about this person. So the mind asked the same
    // question it had already asked, in different words, while the answer was
    // sitting in a thread it was not reading. Routing through the open facet costs
    // nothing extra — the focus rides on the REPORT (see FacetReport.focus), so the
    // conversation's own standing focus is never touched and the next inbound turn
    // resumes exactly where it was.
    const openThread = this._executiveEngine.facetFor(`conversation:${ entityId }`)
    const handle     = openThread ?? ( () => {
      // Nobody home — a transient authoring facet, deliberately NOT supervisor-keyed:
      // it is exactly what the mind can most afford to evict under pressure, and a
      // key would move it into the protected tier alongside live conversations.
      const spawned = this._executiveEngine!.spawnFacet('outreach')
      if( spawned.attention === 'full' || !spawned.handle ){
        logger.warn(`[audition-engine] facet budget full — cannot author outreach to ${ entityId }`)
        return undefined
      }
      return spawned.handle
    } )()

    if( !handle ) return { bubbles: [] }

    if( openThread )
      logger.info(`[audition-engine] composing outreach to ${ entityId } inside the open conversation (${ openThread.facetId })`)

    // What we have already said to each other, when there IS an open thread. Without
    // it the mind opens with a question it asked four minutes ago.
    const digest = openThread ? this._digests.getDigest( this._inflightThread.get( entityId ) ?? entityId ) : ''

    const outreachFocus: FocusSection = ({
      title:    'Reaching out',
      function: 'outreach',
      content: [
        openThread
          ? `I am already in conversation with ${ entityName } (id: ${ entityId }), and there is something I have decided to say to them now — unprompted, not an answer to anything they asked.`
          : `I have decided, on my own initiative, to reach out to ${ entityName } (id: ${ entityId }).`,
        openThread
          ? 'This continues that conversation. I do not re-introduce myself and I do not ask again for something already answered above.'
          : 'No one prompted this — I am choosing to make contact now.',
        digest,
        gist ? `What is on my mind: ${ gist }` : '',
        // The gist is what the MASTER framed, and the master was not talking to
        // them — so it refers to people in the third person, including sometimes
        // the very person about to read it. Observed live: "Fabrice says the
        // server issue is fixed now and he should look into the logs", addressed
        // TO him. The words are mine to choose; the gist is only what I mean.
        gist ? `That is my sense of it, not my words to them — I am speaking to ${ entityName } directly, so I say it the way I would say it to their face.` : '',
      ].filter( Boolean ).join('\n'),
      recallQuery:       gist ?? entityName,
      awareness:         [ ...DEFAULT_FACET_AWARENESS, 'plans' ],
      awarenessEntityId: entityId,
      subjectEntityId:   entityId,
      subjectName:       entityName,
      instructions:
        'Considering who I am, my goals, and how I feel, I say what I genuinely want to say to ' +
        'them now. I speak as myself; I stay grounded in my real memories — I do not invent experiences ' +
        'I have no record of.',
      outputFormat: CONVERSATION_OUTPUT_FORMAT,
      extractDecision: ( raw: unknown ): ConversationDecision => {
        const output = raw as ExecutiveOutputFull
        // A declared silence beats anything else in the response. Unprompted
        // speech is the one case where saying nothing must be cheaper than
        // saying something — nobody is waiting on this.
        if( output.noMessage !== undefined ){
          logger.info(`[audition-engine] chose not to reach out to ${ entityName }: ${ output.noMessage.slice( 0, 120 ) }`)
          return { reply: '', replyBubbles: [], withheld: true, targetEntityId: entityId, requiresMasterAttention: false }
        }
        const rawReply = output.replyText?.trim() ?? ''
        const bubbles  = rawReply.split( /\n{2,}/ ).map( b => b.trim() ).filter( Boolean )
        return { reply: bubbles.join('\n'), replyBubbles: bubbles, targetEntityId: entityId, requiresMasterAttention: false }
      },
    })

    // report() only QUEUES the facet's reasoning; the authored bubbles arrive LATER
    // via the subscription. So wait for the DECISION (not report's resolution), with
    // a safety timeout, then tear the transient facet down.
    this._outreachInFlight.add( entityId )
    try {
      const authored = await new Promise<OutreachResult>( resolve => {
        let settled = false
        let unsub:  () => void = () => {}
        let timer:  ReturnType<typeof setTimeout>
        const done = ( r: OutreachResult ): void => { if( settled ) return; settled = true; clearTimeout( timer ); unsub(); resolve( r ) }
        timer = setTimeout(
          () => { logger.warn(`[audition-engine] outreach authoring timed out for ${ entityId }`); done( { bubbles: [] } ) },
          60_000,   // generous: the facet LLM authors in ~8–18s
        )
        // ONLY this report's decision. Sharing a live conversation facet means its
        // ordinary reply decisions arrive on the same subscription, and resolving
        // on one of those would hand the human's reply back as if the mind had
        // composed it unprompted — and deliver it twice.
        unsub = handle.subscribe( d => {
          if( d.respondingToType !== 'outreach') return
          const decision = d.decision as ConversationDecision
          // A declared silence is carried through as such. Empty bubbles alone
          // are ambiguous — see ConversationDecision.withheld.
          done( { bubbles: decision.replyBubbles ?? [], withheld: decision.withheld === true } )
        } )
        // The focus rides the REPORT, so a shared conversation facet keeps its own
        // standing focus and its next inbound turn resumes untouched.
        Promise.resolve( handle.report({ type: 'outreach', payload: { entityId, gist }, focus: outreachFocus }) ).catch( err => {
          logger.warn(`[audition-engine] outreach report failed for ${ entityId }: ${ ( err as Error ).message }`)
          done( { bubbles: [] } )
        } )
      } )

      // Only tear down what we opened. Destroying a borrowed conversation facet
      // would end the conversation as a side effect of speaking in it.
      if( !openThread ) handle.destroy()
      return authored
    }
    catch( err ){
      // A facet that throws is a pass that produced no words — the same outcome as
      // the timeout, and the caller's contract is already "empty means I could not
      // author". Letting it escape would reject inside MotorSchemaExecutor's
      // fire-and-forget authoring chain instead.
      logger.warn(`[audition-engine] outreach authoring failed for ${ entityId }: ${ ( err as Error ).message }`)
      return { bubbles: [] }
    }
    // finally{} on every path — the timeout resolves empty rather than throwing, but
    // a destroy() or report() that throws must not leave this person permanently
    // un-reachable by leaving the guard set.
    finally { this._outreachInFlight.delete( entityId ) }
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
  /**
   * The inbound as a social signal in state — mirror of `conversation.sent`.
   *
   * Shaped for `SocialPerception._scanSocialSignals`, which reads `sourceKeid` for
   * who acted and `directedAtSelf` for whether it was aimed at us. Valence is left
   * UNSET on purpose: the words have not been appraised yet, and guessing a number
   * here would feed reputation and affect a sentiment nobody measured. Absent, the
   * scanner falls back to its neutral default, so the Will learns *that* someone
   * engaged (familiarity, recency, reliability) without inventing how it felt.
   */
  /**
   * A durable, deterministic id for a conversation record.
   *
   * `<prefix>-<entity>-<tick>-<hash of the words>`. Every part earns its place:
   *   • entity — whose conversation this is;
   *   • tick   — WHEN, from the sim clock, which resumes from the snapshot and so
   *              keeps rising across restarts;
   *   • hash   — which utterance, so two things said to one person on one tick stay
   *              two records.
   *
   * What it replaces was `<prefix>-<entity>-<N>` with N a process-local counter.
   * It restarted at 1 on every boot, so each session OVERWROTE the previous
   * session's records of the same person — a mind that had spoken with someone
   * across four restarts held one session's worth of evidence that it ever had.
   * Found by diffing a live snapshot against the Discord transcript it came from:
   * `conv-sent-reply-discord:1019…-1` held that morning's greeting, and every
   * earlier conversation keyed to the same id was simply gone.
   *
   * No wallClock: these ids live in state, and a wall-clock id makes the recorded
   * and replayed runs diverge (R2).
   */
  private _sentKey( prefix: string, entityId: string, words: string ): string {
    return `${ prefix }-${ entityId }-${ this._lastDecisionTick }-${ fnv1a( words ) }`
  }

  private _writeReceived( entityId: string, speakerName: string | undefined, content: string, threadId: string ): void {
    if( !this._memorySink ) return
    // Never wallClock(): this entity LIVES IN STATE, so a wall-clock id makes the
    // recorded and replayed runs diverge (R2). Observed as a replay consuming 17 of
    // 18 recorded completions — different ids meant different percepts meant a
    // different executive firing schedule.
    //
    // But nor a process-local counter, which is what this was. `conv-received-<id>-N`
    // restarted at N=1 on every boot, so each session silently OVERWROTE the last
    // session's records of the same person. A mind that had spoken with someone
    // across four restarts held one session's worth of evidence that it ever had.
    // See _sentKey.
    this._memorySink({
      id:   this._sentKey('conv-received', entityId, content ),
      type: 'conversation.received',
      metadata: {
        sourceKeid:     entityId,
        sourceName:     speakerName,
        directedAtSelf: true,          // an inbound turn is addressed to us by definition
        action:         'communication',
        preview:        content.slice( 0, 140 ),
        chars:          content.length,
        ...( threadId ? { threadId } : {} ),
      },
    })
  }

  /**
   * Record that the mind SPOKE to someone, mirroring `_writeReceived`.
   *
   * Only ProactiveCommunicator wrote `conversation.sent`, so a reply — which is
   * most of what a Will says — left no durable trace of having spoken. Everything
   * that asks "have I already said something to them?" was therefore blind to
   * conversation: satiation could not damp repeating a relay delivered as a reply,
   * and an undertaking discharged inside a conversation stayed forever unkept,
   * which is exactly how the same message went out again and again.
   *
   * Speaking is speaking, whichever path carried it.
   */
  private _writeSent(
    entityId:   string,
    entityName: string | undefined,
    bubbles:    string[],
    /**
     * Outbox ids for these bubbles — the ONLY thing that lets a later delivery
     * ack find this record (`OutboxController.confirmDelivery` correlates on
     * `outboxMessageIds`, there is no other key).
     *
     * Omitted, this record could never be marked delivered. Every reply the mind
     * ever made carried `delivered` unset, forever — so a mind asking itself "did
     * that land?" found no answer for anything it had SAID, while the answer was
     * recorded faithfully for everything it had initiated. Silence read exactly
     * like failure, and it re-sent. The proactive path stored these from the
     * start; the reply path was simply never given them.
     */
    outboxMessageIds?: string[],
  ): void {
    if( !this._memorySink || bubbles.length === 0 ) return
    this._memorySink({
      id:   this._sentKey('conv-sent-reply', entityId, bubbles.join('\n') ),
      type: 'conversation.sent',
      metadata: {
        targetEntityId:   entityId,
        targetEntityName: entityName,
        messageCount:     bubbles.length,
        preview:          bubbles[0]?.slice( 0, 100 ) ?? '',
        effectorName:     'text',
        source:           'audition-facet',
        tick:             this._lastDecisionTick,
        delivered:        false,
        ...( outboxMessageIds?.length ? { outboxMessageIds } : {} ),
      },
    })
  }

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

    // The sim tick this was reasoned at — the only deterministic clock an off-tick
    // engine has, and what the conversation-record ids are keyed on.
    this._lastDecisionTick = decision.tick ?? this._lastDecisionTick

    // An outreach composed INSIDE this conversation (authorOutreach borrowing the
    // open facet) lands here too, because the session subscription is facet-wide.
    // Its words belong to `authorOutreach`, which returns them to the agency for
    // delivery through the proactive path; delivering them here as well would send
    // the same message twice and answer a turn nobody took. `_endTurn` is not
    // called either — an outreach is not a turn, and releasing the queue here would
    // let the next inbound start while a real turn was still in flight.
    if( decision.respondingToType === 'outreach') return

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

          this._writeSent( entityId, d.targetEntityId, d.replyBubbles, ids )

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

      // ── Outward intentions ────────────────────────────────────
      // The facet decided, mid-conversation, to say something to someone ELSE.
      // It does not do that itself (see ConversationDecision.outwardIntents) — it
      // hands the intention to the master, which is singular and owns whom the
      // mind contacts. The master perceives it as an undertaking it made and
      // decides whether it still means it; nothing here forces the contact.
      // `executive.facet.handoff` is the ONE channel every facet type uses to hand
      // the master something. It replaced `audition.task.signal`, which was named
      // and typed for this engine alone — see EscalationBuffer.
      const handoff = ( body: HandoffBody ): void => {
        this._bus?.publish({
          type: 'executive.facet.handoff',
          version: 1,
          sourceEngine: this.name,
          salience: 0.9,
          payload: {
            facetId:         decision.facetId,
            subjectEntityId: entityId,
            ...( d.targetEntityId ? { subjectName: d.targetEntityId } : {} ),
            threadId,
            confidence:      decision.confidence,
            // No `tick` — this engine runs off-tick and has no honest sim clock of
            // its own. The master stamps it from the tick the handoff ARRIVES on,
            // which is within one tick of when it was formed and, crucially, is a
            // real clock reading rather than the last time the master happened to run.
            body,
          }
        })
      }

      if( d.outwardIntents?.length )
        for( const intent of d.outwardIntents ){
          logger.info(
            `[audition-engine] Outward intent from ${entityId}'s facet → ${intent.target} ` +
            `(handing to master; the facet does not open that channel itself)`
          )
          handoff({
            kind:      'undertaking',
            target:    intent.target,
            reasoning: intent.reasoning ?? '',
            ...( intent.gist ? { gist: intent.gist } : {} ),
          })
        }

      // ── Master escalation signal ──────────────────────────────
      // Published when the facet emits an 'escalate' action type.
      if( d.requiresMasterAttention )
        handoff({ kind: 'escalation', reasoning: decision.reasoning })
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

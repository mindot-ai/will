// ─────────────────────────────────────────────────────────────
// src/surface/sdk/will.ts — the ergonomic facade
// ─────────────────────────────────────────────────────────────
//
// `WillStem` is the full, powerful contract (tick listeners, the outbox drain,
// the effector ack loop, PMA distill/load). This facade wraps it in the shape a
// developer expects when embedding a mind in their own project:
//
//   const will = await Will.create({ name: 'Aria', identity: {...} })
//   will.on('message', m => console.log(m.content))
//   will.effector('search_docs', async a => await myDb.search(a.query))
//   await will.sense({ from: 'ada', text: 'What should we work on?', provenance: 'exafferent' })
//   const reply = await will.nextUtterance({ to: 'ada' })   // WillMessage | null
//   const pma = await will.save()               // non-destructive; keeps ticking
//
// A Will is a *subject*, not a function: you `sense` stimuli to it and observe
// its *projections* (message / effector / emotion / state) — you never `await`
// a computed return. `nextUtterance` is a thin, honest adapter for callers that
// want a reply-shaped await; `null` means the Will chose silence, not an error.
//
// Everything under here already existed; the facade hides the plumbing:
//   • one message → outbox drain → delivery-ack, surfaced as an event;
//   • effector invocations → your async handler → execution-ack, automatically;
//   • state as a plain summary; hibernate/wake as PMA out/in.
//
// It stays an ADDITIVE convenience — `will.stem` and `will.id` are exposed so a
// power user can drop to the full WillStem contract at any time.
// ─────────────────────────────────────────────────────────────

import { WillStem } from '#stem/index'
import type { WillConfig, WillIdentity, Anatomy, InitialGoal, WillModelConfig, WillLLMConfig } from '#stem/mind'
import { PROVIDER_KEY_ENV, providerKeyFromEnv, type LLMProvider } from '#llm/index'
import type { PMASnapshot } from '#pma/index'
import type { effectorInvocation } from '#types'
import type { EffectorDeclaration, SchemaPrecondition } from '#agency/types'
import type { PolicyArbiter } from '#stem/policy/arbiter'
import type { SignalProvenance } from '#senses/provenance'

// ── Public surface ────────────────────────────────────────────

/**
 * A stimulus entering the Will's sensory field. A Will is a subject, not a
 * function: you don't *call* it with input and await a return — you `sense`
 * something to it, and it *may* project a response later (see `nextUtterance`),
 * coloured by its current state. Silence is a valid, meaningful outcome.
 */
export interface Stimulus {
  /** What was said / observed. */
  text: string
  /** Who it's from (entity id). Default 'user'. */
  from?: string
  /**
   * The speaker's real name, when known. A name here is *learned* by the Will as
   * this entity's name (see known.entity.tracker) — so it is left unset by
   * default rather than filled with a chat-frame placeholder: absent a real
   * name, the Will knows the person as "someone" until it learns one.
   */
  speaker?: string
  /**
   * Whose doing this was: `'exafferent'` (the world), `'reafferent'` (the Will's
   * own act, coming back), or `'unknown'` (you cannot tell).
   *
   * REQUIRED, as of P3. Only you can answer it — nothing inside the mind can
   * tell the echo of its own utterance from a stranger saying the same words,
   * which is why this is asserted at the boundary and never inferred behind it.
   * Most inbound traffic is `'exafferent'`; use `say()`/`tell()`, whose verbs
   * already make that claim, when that is all you mean. Reach for `'reafferent'`
   * when you are feeding back the result of something the Will did — an
   * ability's output, a webhook fired by its own write, a platform echo of a
   * message it sent — and pass `sourceIntentId` if you have it.
   *
   * It was optional for exactly one epoch, defaulting to `'exafferent'`, so that
   * a host migrated ONCE — at P3, alongside the `perceive()` → `sense()` rename
   * — rather than twice. That default was the last surviving instance of the
   * four-state hole the internal types exist to forbid: an omission silently
   * became a claim nobody made. It is gone.
   *
   * If you genuinely cannot tell, say `'unknown'`. That is a different statement
   * from `'exafferent'` and the mind treats it as one: the rupture gate in
   * `action.selector` counts only `'exafferent'` percepts, so a mislabelled echo
   * can interrupt a mind's train of thought with its own words.
   */
  provenance: SignalProvenance
  /** The intent whose enaction caused this, when `provenance` is `'reafferent'`. */
  sourceIntentId?: string
  /** Conversation/thread id (default = `from`). */
  thread?: string
  /** True when `thread` is private — just this someone and the Will. See TextMessage.direct. */
  direct?: boolean
  /** What the room is called, e.g. `#general`. A label, not an address. See TextMessage.threadName. */
  threadName?: string
}

/** A message the Will emitted to someone. */
export interface WillMessage {
  /** Message id (stable — dedupe on it). */
  id: string
  /** The text the Will said. */
  content: string
  /** Entity id the Will addressed (the speaker you used in say()/tell(), or a bond). */
  to: string
  /**
   * The conversation this belongs to — the `thread` from the `sense()` that
   * prompted it. Absent when the Will spoke unprompted, which genuinely has no
   * thread.
   *
   * WHERE, not just to whom. The engine knew this the whole way down —
   * `OutboxMessage.threadId` carries it — and the projection dropped it here, so
   * a channel adapter had nothing to answer INTO and had to guess from a roster.
   * Observed live: a DM arrived on `discord:1532693…`, she answered it correctly
   * and in seconds, and the reply went to the shared server channel because that
   * was the last room the roster had seen this person in. From the operator's
   * side she had simply ignored him.
   */
  thread?: string
}

/**
 * A motor act the Will *chose* to enact — a projection of its agency, surfaced
 * whether or not you registered a handler for it. (When you did, the handler
 * still runs and its outcome feeds reafference.)
 */
export interface WillEffectorAct {
  /** The effector the Will selected. */
  name: string
  /** The arguments it bound. */
  args: Record<string, unknown>
  /** Its stated reason for the act. */
  reasoning: string
  /** Bound target entity, when the act binds one. */
  to?: string
}

/** The Will's affect, projected when it shifts. Valence/arousal ∈ −1..1. */
export interface WillAffect {
  valence: number
  arousal: number
}

/**
 * The result of an effector your handler ran. Return a bare string as shorthand
 * for `{ success: true, description }`. `metrics` optionally writes world state
 * back into the Will's body (e.g. `{ 'energy.level': 80 }`) — validated finite.
 */
export type EffectorResult = string | {
  success: boolean
  /** How the act WENT — its fate. What the Will learns competence from. */
  description: string
  /**
   * What the act REVEALED — new information about the world (SIGNAL_BOUNDARY P2).
   *
   * Return it and the Will *perceives* it: it arrives as a reafferent percept
   * tied to the act by `sourceIntentId`, so it is remembered and recallable,
   * not merely learned from. A lookup, a listing, a snapshot has one; a kick or
   * a warning does not — those only have a fate.
   *
   *     return { success: true,
   *              description: 'Looked up Ada.',              // how it went
   *              observation: 'Ada joined 3 months ago, …' } // what I found
   *
   * Any shape — a string, a record, a list — and carried WHOLE.
   *
   * SEND WHAT YOU HAVE, NOT WHAT IT MEANS. You are not asked to summarise, and
   * you should not: making meaning by connecting pieces of information is the
   * mind's entire job, and a host that hands over a conclusion has done that
   * work on the wrong side of the boundary. A robot's vision layer reports
   * `{ object: 'ball', confidence: 0.9, bbox: […] }`; it has no business
   * deciding whether that is worth reacting to.
   *
   * The mind labels it with the ability's own name, and sees the data itself in
   * its percepts — state, working memory and the prompt all carry it. If you
   * happen to have a one-line `summary` on your object it is used as the label,
   * but that is a convenience and never a requirement.
   *
   * SIZE IS YOURS TO JUDGE, AND NOTHING TRUNCATES IT. What you send lands in
   * the mind's percepts and, briefly, its prompt — so a very large payload
   * costs tokens on the ticks it is alive. The engine will not second-guess you
   * by cutting it: a cap here decides for a mind how much of an answer it may
   * have, and that decision is not the engine's to make. Send the record; send
   * the field you would want it to notice.
   *
   * Before this, a host with facts to hand back had to return the ack AND call
   * `sense()` separately — two calls for one act, and the second one had to
   * pretend somebody had spoken.
   */
  observation?: unknown
  metrics?: Record<string, number>
}

/** Your implementation of an ability the Will can choose to use. */
export type EffectorHandler = (
  args: Record<string, unknown>,
  ctx: {
    reasoning: string
    /**
     * The `agency.intent` this handler is running under — the correlation handle
     * the Will will match an ack to (SIGNAL_BOUNDARY P1).
     *
     * Pass it as `sourceIntentId` on any `sense()` you make from inside a
     * handler, and the resulting percept is a *reafference* the mind can tie back
     * to the act that caused it, rather than an unexplained arrival. Before this
     * existed, `discord_inspect_channel` had to say so in English — a bracketed
     * `[I looked into #general: …]` that only the LLM could read — because the
     * fact had nowhere structural to live.
     */
    intentId: string
    targetEntityId?: string
    /**
     * The addresses this host knows `targetEntityId` by — a channel id, a user id.
     * `targetEntityId` itself is an opaque anchor (who something IS); these are
     * where to find it. Resolved inside the Will, where the alias table lives.
     */
    targetAddresses?: readonly string[]
    description?: string
  },
) => EffectorResult | Promise<EffectorResult>

/**
 * A richer effector declaration — the ability seeded as a *learnable affordance*.
 * `description` is its meaning (carried to perception + your handler); `cost`,
 * `valence`, and `preconditions` are the intrinsic priors the mind starts from,
 * refined by reafference through use. Args still bind from the situation — this
 * is not a tool-call parameter form. Declare rich effectors in `create()`'s
 * `effectors` map (that is where they enter the affordance repertoire).
 */
export interface EffectorSpec {
  /** What the ability is for. */
  description?: string
  /** Intrinsic effort / energy demand 0..1 (default 0.15). */
  cost?: number
  /** Intrinsic reward prior −1..1 the mind expects before learning (default 0). */
  valence?: number
  /** Body-state gates; the ability is unavailable unless all pass. */
  preconditions?: SchemaPrecondition[]
  /**
   * Whether the ability targets a specific perceived target (default 'none').
   * 'entity' directs it at a known person, 'object' at a known thing; the bound
   * target arrives as `ctx.targetEntityId`.
   */
  binds?: 'none' | 'entity' | 'object'
  /**
   * Routing tags (merged with 'external'/'host'). A drive-recognised tag (e.g.
   * 'social', 'nourishment') lets a homeostatic drive lift this ability when it
   * presses.
   */
  tags?: string[]
  /** Your implementation. */
  handler: EffectorHandler
}

/** An effectors-map value: a bare handler, or a spec carrying meaning + priors. */
export type EffectorEntry = EffectorHandler | EffectorSpec

/** A compact read of the mind's current inner state. */
export interface WillStateSummary {
  tick: number
  /** Physiology + affect, 0..1 unless noted. */
  metrics: {
    energy: number; stress: number; sleep: number
    valence: number; arousal: number
  }
  goals: Array<{ description: string; priority: number }>
  beliefs: Array<{ statement: string; confidence: number }>
  /** The Will's current self-narrative (may be empty early in a life). */
  narrative: string
}

export interface CreateWillOptions {
  /** Display name. */
  name: string
  /** Persona: who this Will is. All fields optional except by your intent. */
  identity: Partial<WillIdentity> & { prompt: string }
  /** 'mind' (default: the whole architecture) | 'reflex' (no-LLM shell). */
  anatomy?: Anatomy
  /** Per-Will LLM config: provider, model(s), BYO apiKey, baseUrl, caps.
   *  Unset fields fall back to WILL_LLM_* envs. apiKey stays in memory only.
   *  (Named llmConfig because `llm` is the provider MODE switch.) */
  llmConfig?: WillLLMConfig
   /**
   * LLM mode — which provider the executive speaks to.
   *
   * 'mock' (the default when no key is present) runs a deterministic canned
   * executive: zero keys, zero cost. Every other value names a provider and
   * needs its key, either the provider's own env below or the
   * provider-agnostic WILL_LLM_API_KEY:
   *
   *   anthropic  ANTHROPIC_API_KEY   Claude, native Messages wire
   *   glm        ZAI_API_KEY         Z.ai GLM, Anthropic-compatible wire
   *   openai     OPENAI_API_KEY      OpenAI wire
   *   google     GOOGLE_API_KEY | GEMINI_API_KEY   native Gemini wire
   *   deepseek   DEEPSEEK_API_KEY    OpenAI wire
   *   moonshot   MOONSHOT_API_KEY    Kimi — OpenAI wire
   *   qwen       DASHSCOPE_API_KEY   Alibaba Model Studio — OpenAI wire
   *   xai        XAI_API_KEY         Grok — OpenAI wire
   *   minimax    MINIMAX_API_KEY     OpenAI wire
   *   mistral    MISTRAL_API_KEY     OpenAI wire
   *   ollama · vllm                  local; no key, set `llm` explicitly
   *
   * Any other string works too — it just has to declare its `wire` and
   * `baseUrl` on `llmConfig.providers`. Naming the vendor rather than
   * borrowing `openai` because it speaks that wire is what keeps the
   * completion tape and the cost breakdown honest.
   *
   * Omit to auto-detect from whichever key is set.
   */
  llm?: 'mock' | LLMProvider
  /**
   * Abilities the Will can choose to enact. `name → handler`, or
   * `name → { handler, description?, cost?, valence?, preconditions? }` to seed
   * the ability with meaning + intrinsic priors (see EffectorSpec). Declared
   * here (create time) so they enter the affordance repertoire.
   */
  effectors?: Record<string, EffectorEntry>
  /** Goals seeded before the first tick. Usually leave empty — the Will forms its own. */
  initialGoals?: InitialGoal[]
  /** Persist snapshots to disk across restarts (default false). */
  persist?: boolean
  /** Deterministic clock + seed (for replay/testing). Omit for wall-time. */
  seed?: number
  /** Milliseconds between ticks (default 1000; lower = faster demo). */
  tickMs?: number
  /** Stable id (default: derived from name + a random suffix). */
  id?: string
}

type WillEvent = 'message' | 'state' | 'effector' | 'emotion' | 'error'

/** A caller awaiting the Will's next spontaneous utterance (see nextUtterance). */
interface UtteranceWaiter {
  /** Only resolve on an utterance addressed to this entity, when set. */
  to?: string
  resolve: ( m: WillMessage | null ) => void
  timer:   ReturnType<typeof setTimeout>
}

/** Affect must move at least this far (−1..1) before another `emotion` projection. */
const AFFECT_EPSILON = 0.02

// ── The facade ────────────────────────────────────────────────


/**
 * Which provider to talk to when the caller did not say.
 *
 * Checks the provider-agnostic key first (it means "I configured this
 * deliberately"), then each provider's conventional env. The order among
 * providers is detection precedence when several keys happen to be present —
 * it is not a ranking, and no provider here is more supported than another.
 */
export function detectProvider(): 'mock' | LLMProvider {
  // A provider-agnostic key says nothing about who to send it to. Guessing
  // here is how a key meant for one vendor ends up at another; the guess used
  // to be 'anthropic' unconditionally.
  if( process.env.WILL_LLM_API_KEY ){
    const provider = process.env.WILL_LLM_PROVIDER
    if( !provider )
      throw new Error(
        'WILL_LLM_API_KEY is set but WILL_LLM_PROVIDER is not — there is no way ' +
        'to tell which provider that key belongs to. Set WILL_LLM_PROVIDER, or ' +
        'use a provider-specific key (ANTHROPIC_API_KEY, ZAI_API_KEY, …).'
      )
    return provider as LLMProvider
  }
  // A provider-specific key IS the explicit statement — no guess involved.
  // Order is precedence when several are present, and is append-only: moving an
  // entry silently changes which vendor an existing environment talks to.
  //
  // Read through providerKeyFromEnv rather than raw truthiness, so "is a key
  // set?" and "what is the key?" cannot disagree — a blank `XAI_API_KEY=` would
  // otherwise select xai here and then supply nothing to call it with.
  for( const provider of Object.keys( PROVIDER_KEY_ENV ) )
    if( providerKeyFromEnv( provider ) ) return provider
  return 'mock'
}

export class Will {
  /** The underlying WillStem — drop here for the full contract. */
  readonly stem: WillStem
  /** This Will's id. */
  readonly id: string
  readonly name: string

  private readonly _effectors = new Map<string, EffectorHandler>()
  /** Rich declarations for create-time effectors → seed the affordance repertoire. */
  private readonly _effectorDecls = new Map<string, EffectorDeclaration>()
  private readonly _messageHandlers  = new Set<( m: WillMessage ) => void>()
  private readonly _stateHandlers    = new Set<( s: WillStateSummary ) => void>()
  private readonly _effectorHandlers = new Set<( a: WillEffectorAct ) => void>()
  private readonly _emotionHandlers  = new Set<( a: WillAffect ) => void>()
  private readonly _errorHandlers    = new Set<( e: Error ) => void>()
  private readonly _utteranceWaiters = new Set<UtteranceWaiter>()
  private _lastAffect: WillAffect | null = null
  private _unsub: ( () => void ) | null = null

  private constructor( stem: WillStem, id: string, name: string ){
    this.stem = stem
    this.id   = id
    this.name = name
  }

  /** Boot a new mind. Resolves once it is ticking. */
  static async create( opts: CreateWillOptions ): Promise<Will> {
    const id = opts.id ?? `${slug( opts.name )}-${Math.random().toString( 36 ).slice( 2, 8 )}`
    const stem = new WillStem()
    const will = new Will( stem, id, opts.name )

    for( const [ name, entry ] of Object.entries( opts.effectors ?? {} ) )
      will._register( name, entry )

    await stem.createWill( will._buildConfig( id, opts ) )
    will._attach()
    return will
  }

  /**
   * Restore a mind from a PMA artifact — identity, beliefs, relationships, and
   * learned competence carry across the process boundary. Same options as
   * create() (minus identity, which the artifact supplies).
   */
  static async wake(
    pma: PMASnapshot,
    opts: Omit<CreateWillOptions, 'identity'> & { identity?: Partial<WillIdentity> },
  ): Promise<Will> {
    // Waking IS being the same mind, so the id continues from the artifact unless the
    // caller overrides it. The id is the path key for everything durable that lives
    // OUTSIDE the artifact — `data/wills/<id>/vector_index`, snapshots, session logs.
    // Minting a fresh `name-<random>` here gave a woken mind a brand-new, empty vector
    // store every boot: identity/beliefs/goals returned (those are in the artifact) while
    // episodic recall came back permanently empty, and the orphaned index was left behind
    // on disk. Observed: four boots, four `lora-*` directories, four 4KB indexes, and a
    // mind that concluded at 100% confidence that its own channel might not be viable
    // because it could not recall a conversation it had just had.
    const id = opts.id ?? pma.willId ?? `${slug( opts.name )}-${Math.random().toString( 36 ).slice( 2, 8 )}`
    const stem = new WillStem()
    const will = new Will( stem, id, opts.name )

    for( const [ name, entry ] of Object.entries( opts.effectors ?? {} ) )
      will._register( name, entry )

    const config = will._buildConfig( id, { ...opts, identity: { prompt: '', ...opts.identity } } )
    // Say out loud that this identity is a placeholder. Otherwise the creation
    // guard warns about the empty persona we just constructed on purpose — three
    // alarms per wake, drowning the real check that runs when the artifact loads.
    config.identityFromArtifact = true

    await stem.createWill( config, true /* startPaused — load the artifact before the first tick */ )
    stem.loadPMA( id, pma )
    stem.resumeWill( id )
    will._attach()
    return will
  }

  // ── Perceiving ─────────────────────────────────────────────

  /**
   * Deliver a stimulus into the Will's sensory field. This is the one true
   * intake — `say`/`tell` are sugar over it. It returns once the stimulus is
   * *delivered*, NOT once the Will has responded: a response (if any) is a
   * projection that arrives later on the `message` event, or via
   * `nextUtterance()`. The Will may also stay silent — that is not an error.
   *
   * NAMED `sense`, NOT `perceive` (SIGNAL_BOUNDARY P3). What happens here is
   * *transduction*: a signal crosses into the mind. PERCEPTION is what a sense
   * engine does afterwards — audition runs, judges salience, and produces a
   * `Percept`, which may not resemble what arrived and may not happen at all
   * (a gated sense drops it). Calling the door `perceive` said the caller had
   * already done the mind's work, and it misled every reader of this flow,
   * including the first draft of the epoch that renamed it.
   */
  async sense( stimulus: Stimulus ): Promise<void> {
    const from = stimulus.from ?? 'user'
    await this.stem.senseText( this.id, {
      kind:        'text',
      entityId:    from,
      threadId:    stimulus.thread ?? from,
      content:     stimulus.text,
      // speakerName is a *learned* name in the mind's known-entity model — supplying
      // one teaches the Will this entity's name. So we don't fabricate a chat-frame
      // default ('You'/'User'): without an explicit name the name stays unlearned and
      // the Will knows the person as "someone" until a real one is learned. (The live
      // conversation focus still falls back to the entity id for its Speaker line.)
      ...( stimulus.speaker ? { speakerName: stimulus.speaker } : {} ),
      // Omitted rather than defaulted: an unknown room is not known to be public.
      ...( stimulus.direct !== undefined ? { direct: stimulus.direct } : {} ),
      // Omitted when the channel does not know — a room with no name stays
      // unnamed, the same way a person does, rather than being labelled with its id.
      ...( stimulus.threadName ? { threadName: stimulus.threadName } : {} ),
      // No default. `Stimulus.provenance` is required now, so there is nothing
      // left to fall back to — the four-state hole is closed at every door into
      // this mind, which was the point of the epoch.
      provenance: stimulus.provenance,
      ...( stimulus.sourceIntentId ? { sourceIntentId: stimulus.sourceIntentId } : {} ),
    } )
  }

  /**
   * Sense from the default user. Sugar over `sense`.
   *
   * Supplies `provenance: 'exafferent'` — that is not a default sneaking back
   * in, it is what the verb MEANS. "Say" is somebody speaking to the Will; a
   * caller who wants to feed back the Will's own act reaches for `sense` and
   * says so. The assertion lives in the function name.
   */
  async say( text: string ): Promise<void> {
    return this.sense( { text, from: 'user', provenance: 'exafferent' } )
  }

  /** Sense from a specific interlocutor (multi-party). Sugar over `sense` — see `say` on provenance. */
  async tell( entityId: string, speakerName: string, text: string ): Promise<void> {
    return this.sense( { text, from: entityId, speaker: speakerName, provenance: 'exafferent' } )
  }

  /**
   * Await the Will's *next spontaneous utterance* — a thin, honest adapter over
   * the `message` projection stream for request/response callers. Resolves with
   * the message, or `null` if the Will stays silent within `within` ms (default
   * 5000). `null` is a real outcome — the Will chose not to speak — not a
   * failure. Pass `to` to only accept an utterance addressed to that entity.
   *
   *   await will.sense( { from: 'ada', text: 'Hi!', provenance: 'exafferent' } )
   *   const reply = await will.nextUtterance( { to: 'ada', within: 3000 } )
   *   // reply is a WillMessage, or null if Ada got the silent treatment.
   */
  nextUtterance( opts: { within?: number; to?: string } = {} ): Promise<WillMessage | null> {
    return new Promise<WillMessage | null>( resolve => {
      const timer = setTimeout( () => {
        this._utteranceWaiters.delete( waiter )
        resolve( null )
      }, opts.within ?? 5000 )
      // Don't let a pending wait keep the host process alive.
      ;( timer as { unref?: () => void } ).unref?.()
      const waiter: UtteranceWaiter = { to: opts.to, resolve, timer }
      this._utteranceWaiters.add( waiter )
    } )
  }

  // ── Abilities ──────────────────────────────────────────────

  /**
   * Register an ability the Will can choose to enact, at runtime. `entry` is a
   * bare handler or a full spec (`{ handler, description?, cost?, valence?,
   * preconditions?, binds?, tags? }`). When the Will decides to use `name`, your
   * handler runs with the arguments it chose; the return value feeds back as the
   * outcome (the reafference loop that lets the Will learn the ability).
   *
   * The ability's schema is added to the live repertoire so it can actually be
   * *afforded* immediately (a grant alone only gates), then granted. Note: this
   * is a runtime mutation — the deterministic/replayable path is declaring
   * effectors in `create()`'s `effectors` map.
   */
  effector( name: string, entry: EffectorEntry ): this {
    this._register( name, entry )
    // Add its schema to the live repertoire (so it can be perceived + enacted),
    // then grant it. Comms names are no-ops in registerEffector (grant-governed).
    this.stem.registerEffector( this.id, this._effectorDecls.get( name )! )
    this.stem.setAllowedEffectors( this.id, [ ...COMMUNICATION, ...this._effectors.keys() ] )
    return this
  }

  /** Split an effectors-map entry into a handler + an EffectorDeclaration. */
  private _register( name: string, entry: EffectorEntry ): void {
    if( typeof entry === 'function'){
      this._effectors.set( name, entry )
      this._effectorDecls.set( name, name )          // bare name — uniform prior
      return
    }
    this._effectors.set( name, entry.handler )
    const hasMeta = entry.description !== undefined || entry.cost !== undefined
      || entry.valence !== undefined || entry.preconditions !== undefined
      || entry.binds !== undefined || entry.tags !== undefined
    this._effectorDecls.set( name, hasMeta
      ? {
          name,
          ...( entry.description   !== undefined ? { description:   entry.description   } : {} ),
          ...( entry.cost          !== undefined ? { cost:          entry.cost          } : {} ),
          ...( entry.valence       !== undefined ? { valence:       entry.valence       } : {} ),
          ...( entry.preconditions !== undefined ? { preconditions: entry.preconditions } : {} ),
          ...( entry.binds         !== undefined ? { binds:         entry.binds         } : {} ),
          ...( entry.tags          !== undefined ? { tags:          entry.tags          } : {} ),
        }
      : name )
  }

  // ── Introspection ──────────────────────────────────────────

  /** A compact snapshot of the mind's current inner state. */
  state(): WillStateSummary {
    const c = this.stem.getWillCognition( this.id )
    const s = this.stem.getWillState( this.id )
    const m = ( k: string, d = 0 ): number => s.metrics.get( k ) ?? d
    const narrative = c.autobiographicalNarrator.getNarrative()
    return {
      tick: s.tick,
      metrics: {
        energy:  m('energy.level', 100 ), stress: m('stress.load'), sleep: m('sleep.pressure'),
        valence: m('affect.valence'),    arousal: m('affect.arousal'),
      },
      goals:   c.goalManager.getActiveGoals().map( g => ( { description: g.description, priority: g.priority } ) ),
      beliefs: c.semanticIntegrator.getBeliefs().map( b => ( { statement: b.statement, confidence: b.confidence } ) ),
      narrative: narrative.story ?? '',
    }
  }

  // ── Events ─────────────────────────────────────────────────

  on( event: 'message',  handler: ( m: WillMessage ) => void ): this
  on( event: 'state',    handler: ( s: WillStateSummary ) => void ): this
  on( event: 'effector', handler: ( a: WillEffectorAct ) => void ): this
  on( event: 'emotion',  handler: ( a: WillAffect ) => void ): this
  on( event: 'error',    handler: ( e: Error ) => void ): this
  on( event: WillEvent, handler: ( arg: never ) => void ): this {
    switch( event ){
      case 'message':  this._messageHandlers.add(  handler as ( m: WillMessage ) => void ); break
      case 'state':    this._stateHandlers.add(    handler as ( s: WillStateSummary ) => void ); break
      case 'effector': this._effectorHandlers.add( handler as ( a: WillEffectorAct ) => void ); break
      case 'emotion':  this._emotionHandlers.add(  handler as ( a: WillAffect ) => void ); break
      default:         this._errorHandlers.add(    handler as ( e: Error ) => void )
    }
    return this
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pause():  void { this.stem.pauseWill( this.id ) }
  resume(): void { this.stem.resumeWill( this.id ) }


  /**
   * Install the Policy Decision Point consulted before every effector
   * invocation this Will hands to the host (POLICY_REAFFERENCE P0). `null`
   * restores the no-op default. See `WillStem.setArbiter` for the one scoping
   * caveat (per-stem, not per-Will id) — irrelevant here since `Will.create()`
   * gives this instance its own dedicated stem.
   */
  setArbiter( arbiter: PolicyArbiter | null ): this {
    this.stem.setArbiter( arbiter )
    return this
  }

  /**
   * Checkpoint the living mind into a portable PMA artifact — NON-destructive.
   * The Will keeps ticking; the snapshot is a point-in-time copy you can archive
   * or wake elsewhere. Use this for periodic saves; use `hibernate()` to sleep.
   */
  async save(): Promise<PMASnapshot> {
    return this.stem.distillPMA( this.id )
  }

  /**
   * Distil the mind into a portable PMA artifact and archive it — DESTRUCTIVE:
   * the tick loop stops (the Will sleeps). The returned snapshot restores the
   * same self via `Will.wake()` — across a restart, a fork, or a machine
   * boundary. For a copy that leaves the Will running, use `save()`.
   */
  async hibernate(): Promise<PMASnapshot> {
    const pma = this.stem.distillPMA( this.id )
    await this.stop()
    return pma
  }

  /** Tear the Will down (its tick loop stops; state is discarded unless persisted). */
  async stop(): Promise<void> {
    // Resolve anyone awaiting an utterance — the Will won't speak again.
    for( const w of this._utteranceWaiters ){ clearTimeout( w.timer ); w.resolve( null ) }
    this._utteranceWaiters.clear()
    this._unsub?.()
    this._unsub = null
    await this.stem.archiveWill( this.id )
  }

  // ── Internals ──────────────────────────────────────────────

  private _buildConfig( id: string, opts: CreateWillOptions ): WillConfig {
    // Auto-detect from whichever provider key is present; explicit `llm` wins.
    // Order is detection precedence when several keys are set, not a
    // recommendation — every provider here is a first-class target.
    const mode = opts.llm ?? detectProvider()
    const useMock = mode === 'mock'
    // `llm` selects the provider; an explicit llmConfig.provider still wins.
    // Model rides with the transport — `llmConfig.model`, and only that. The
    // top-level `model` spelling is gone: two ways to say one thing is how a
    // config grows a precedence rule nobody can remember.
    const llmConfig: WillLLMConfig | undefined = useMock && !opts.llmConfig
      ? undefined
      : {
          ...( mode !== 'mock' ? { provider: mode } : {} ),
          ...opts.llmConfig,
        }
    return {
      id, name: opts.name,
      identity: {
        prompt: opts.identity.prompt,
        values: opts.identity.values ?? [],
        traits: opts.identity.traits ?? {},
        style:  opts.identity.style ?? '',
      },
      anatomy: opts.anatomy ?? 'mind',
      llm:     llmConfig,
      testMode:   useMock,
      persistentMemory: opts.persist ?? false,
      snapshotInterval: 100,
      tickIntervalMs:   opts.tickMs ?? 1000,
      allowedGenericEffectors: [ ...COMMUNICATION, ...this._effectorDecls.values() ],
      initialGoals: opts.initialGoals ?? [],
      ...( opts.seed !== undefined ? { randomSeed: opts.seed, clock: { fixedDeltaMs: 1000, startTime: 0 } } : {} ),
    }
  }

  /** Wire the single tick listener that drives messages + the effector ack loop. */
  private _attach(): void {
    this._unsub = this.stem.addTickListener( this.id, ( _snapshot, _tick, outbox, invocations ) => {
      // Outbound messages → event + auto delivery-ack.
      for( const msg of outbox ){
        this._emitMessage( {
          id: msg.id, content: msg.content, to: msg.targetEntityId,
          ...( msg.threadId ? { thread: msg.threadId } : {} ),
        } )
        try { this.stem.confirmMessageDelivery( this.id, msg.id, true ) } catch { /* best-effort */ }
      }
      // Effector invocations → project the motor act, then run the handler → ack.
      for( const inv of invocations ){
        this._emitEffectorAct( { name: inv.effectorName, args: inv.parameters, reasoning: inv.reasoning, to: inv.targetEntityId } )
        void this._runEffector( inv )
      }

      // Projections that read the state summary — compute it once, and only when
      // something is actually observing (state() is cheap but not free). Isolated
      // so a transient read error can never stall the tick loop.
      if( this._stateHandlers.size > 0 || this._emotionHandlers.size > 0 ){
        try {
          const s = this.state()
          for( const h of this._stateHandlers ) try { h( s ) } catch { /* isolate */ }
          if( this._emotionHandlers.size > 0 ) this._maybeEmitAffect( s.metrics.valence, s.metrics.arousal )
        }
        catch( e ){ this._emitError( e as Error ) }
      }
    } ) ?? null
  }

  private async _runEffector( inv: effectorInvocation ): Promise<void> {
    const handler = this._effectors.get( inv.effectorName )
    if( !handler ){
      // The Will chose an effector we have no handler for — report it as failed so
      // the reafference loop learns it doesn't work, rather than hanging on the await.
      this.stem.confirmEffectorExecution( this.id, inv.intentId, {
        success: false, description: `No handler registered for effector "${inv.effectorName}"`,
      } )
      return
    }

    try {
      const raw = await handler( inv.parameters, {
        reasoning: inv.reasoning,
        // The correlation handle, so a handler that feeds its own result back in
        // can say WHICH act caused it. This line used to read
        // `intentId: inv.decisionRecordId` — the translation that proved the
        // wire name was already wrong.
        intentId: inv.intentId,
        targetEntityId: inv.targetEntityId,
        // Which of the host's own ids that referent is — without it a handler
        // gets an opaque anchor and nothing it can look up.
        ...( inv.targetAddresses?.length ? { targetAddresses: inv.targetAddresses } : {} ),
        ...( inv.description ? { description: inv.description } : {} ),
      } )
      const result = typeof raw === 'string' ? { success: true, description: raw } : raw
      this.stem.confirmEffectorExecution( this.id, inv.intentId, result )
    }
    catch( err ){
      this._emitError( err instanceof Error ? err : new Error( String( err ) ) )
      this.stem.confirmEffectorExecution( this.id, inv.intentId, {
        success: false, description: `Effector "${inv.effectorName}" threw: ${( err as Error ).message}`,
      } )
    }
  }

  private _emitMessage( m: WillMessage ): void {
    for( const h of this._messageHandlers ) try { h( m ) } catch( e ){ this._emitError( e as Error ) }
    // Wake any nextUtterance() awaiter this message satisfies.
    if( this._utteranceWaiters.size > 0 ){
      for( const w of [ ...this._utteranceWaiters ] ){
        if( w.to !== undefined && w.to !== m.to ) continue
        clearTimeout( w.timer )
        this._utteranceWaiters.delete( w )
        w.resolve( m )
      }
    }
  }
  private _emitEffectorAct( a: WillEffectorAct ): void {
    for( const h of this._effectorHandlers ) try { h( a ) } catch( e ){ this._emitError( e as Error ) }
  }
  private _maybeEmitAffect( valence: number, arousal: number ): void {
    const last = this._lastAffect
    // Emit on the first read, then only when affect moves past the epsilon.
    if( last
      && Math.abs( last.valence - valence ) < AFFECT_EPSILON
      && Math.abs( last.arousal - arousal ) < AFFECT_EPSILON ) return
    this._lastAffect = { valence, arousal }
    for( const h of this._emotionHandlers ) try { h( { valence, arousal } ) } catch( e ){ this._emitError( e as Error ) }
  }
  private _emitError( e: Error ): void {
    for( const h of this._errorHandlers ) try { h( e ) } catch { /* nowhere left to go */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** The three communication effectors a Will needs to hear + speak. */
const COMMUNICATION = [ 'listen', 'talk', 'text' ] as const

function slug( s: string ): string {
  return s.toLowerCase().replace( /[^a-z0-9]+/g, '-').replace( /^-+|-+$/g, '') || 'will'
}

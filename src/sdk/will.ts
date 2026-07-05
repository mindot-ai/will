// ─────────────────────────────────────────────────────────────
// src/sdk/will.ts — the ergonomic facade
// ─────────────────────────────────────────────────────────────
//
// `WillStem` is the full, powerful contract (tick listeners, the outbox drain,
// the effector ack loop, PMA distill/load). This facade wraps it in the shape a
// developer expects when embedding a mind in their own project:
//
//   const will = await Will.create({ name: 'Aria', identity: {...} })
//   will.on('message', m => console.log(m.content))
//   will.effector('search_docs', async a => await myDb.search(a.query))
//   await will.say('What should we work on today?')
//   const pma = await will.hibernate()          // Will.wake(pma) later
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
import type { WillConfig, WillIdentity, EngineTier, ModelTier, InitialGoal } from '#stem/mind'
import type { PMASnapshot } from '#pma/index'
import type { effectorInvocation } from '#types'

// ── Public surface ────────────────────────────────────────────

/** A message the Will emitted to someone. */
export interface WillMessage {
  /** Message id (stable — dedupe on it). */
  id: string
  /** The text the Will said. */
  content: string
  /** Entity id the Will addressed (the speaker you used in say()/tell(), or a bond). */
  to: string
}

/**
 * The result of an effector your handler ran. Return a bare string as shorthand
 * for `{ success: true, description }`. `metrics` optionally writes world state
 * back into the Will's body (e.g. `{ 'energy.level': 80 }`) — validated finite.
 */
export type EffectorResult = string | {
  success: boolean
  description: string
  metrics?: Record<string, number>
}

/** Your implementation of an ability the Will can choose to use. */
export type EffectorHandler = (
  args: Record<string, unknown>,
  ctx: { reasoning: string; targetEntityId?: string },
) => EffectorResult | Promise<EffectorResult>

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
  /** basic | standard (default) | full. */
  engineTier?: EngineTier
  /** haiku (default) | sonnet | opus — informational tier hint. */
  model?: ModelTier
  /**
   * LLM mode. 'mock' (default when no ANTHROPIC_API_KEY) runs a deterministic
   * canned executive — zero keys, zero cost. 'anthropic' calls the real model
   * (needs ANTHROPIC_API_KEY / WILL_LLM_* env). Omit to auto-detect.
   */
  llm?: 'mock' | 'anthropic'
  /** Abilities the Will can choose to enact. name → your handler. */
  effectors?: Record<string, EffectorHandler>
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

type WillEvent = 'message' | 'state' | 'error'

// ── The facade ────────────────────────────────────────────────

export class Will {
  /** The underlying WillStem — drop here for the full contract. */
  readonly stem: WillStem
  /** This Will's id. */
  readonly id: string
  readonly name: string

  private readonly _effectors = new Map<string, EffectorHandler>()
  private readonly _messageHandlers = new Set<( m: WillMessage ) => void>()
  private readonly _stateHandlers = new Set<( s: WillStateSummary ) => void>()
  private readonly _errorHandlers = new Set<( e: Error ) => void>()
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

    for( const [ name, handler ] of Object.entries( opts.effectors ?? {} ) )
      will._effectors.set( name, handler )

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
    const id = opts.id ?? `${slug( opts.name )}-${Math.random().toString( 36 ).slice( 2, 8 )}`
    const stem = new WillStem()
    const will = new Will( stem, id, opts.name )

    for( const [ name, handler ] of Object.entries( opts.effectors ?? {} ) )
      will._effectors.set( name, handler )

    await stem.createWill(
      will._buildConfig( id, { ...opts, identity: { prompt: '', ...opts.identity } } ),
      true /* startPaused — load the artifact before the first tick */,
    )
    stem.loadPMA( id, pma )
    stem.resumeWill( id )
    will._attach()
    return will
  }

  // ── Talking ────────────────────────────────────────────────

  /**
   * Speak to the Will as the default user. The reply is asynchronous — it
   * arrives on the `message` event once the Will has reasoned about it.
   */
  async say( text: string ): Promise<void> {
    return this.tell( 'user', 'You', text )
  }

  /** Speak as a specific interlocutor (multi-party conversations). */
  async tell( entityId: string, speakerName: string, text: string ): Promise<void> {
    await this.stem.ingestText( this.id, {
      kind: 'text', entityId, threadId: entityId, content: text, speakerName,
    } )
  }

  // ── Abilities ──────────────────────────────────────────────

  /**
   * Register an ability the Will can choose to enact. When the Will decides to
   * use `name`, your handler runs with the arguments it chose; the return value
   * is fed back as the outcome (closing the reafference loop that lets the Will
   * learn the ability). Registering makes the effector available immediately.
   */
  effector( name: string, handler: EffectorHandler ): this {
    this._effectors.set( name, handler )
    // Communication effectors + every registered custom name.
    this.stem.setAllowedEffectors( this.id, [ ...COMMUNICATION, ...this._effectors.keys() ] )
    return this
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
        energy:  m( 'energy.level', 100 ), stress: m( 'stress.load' ), sleep: m( 'sleep.pressure' ),
        valence: m( 'affect.valence' ),    arousal: m( 'affect.arousal' ),
      },
      goals:   c.goalManager.getActiveGoals().map( g => ( { description: g.description, priority: g.priority } ) ),
      beliefs: c.semanticIntegrator.getBeliefs().map( b => ( { statement: b.statement, confidence: b.confidence } ) ),
      narrative: narrative.story ?? '',
    }
  }

  // ── Events ─────────────────────────────────────────────────

  on( event: 'message', handler: ( m: WillMessage ) => void ): this
  on( event: 'state',   handler: ( s: WillStateSummary ) => void ): this
  on( event: 'error',   handler: ( e: Error ) => void ): this
  on( event: WillEvent, handler: ( arg: never ) => void ): this {
    if( event === 'message' ) this._messageHandlers.add( handler as ( m: WillMessage ) => void )
    else if( event === 'state' ) this._stateHandlers.add( handler as ( s: WillStateSummary ) => void )
    else this._errorHandlers.add( handler as ( e: Error ) => void )
    return this
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pause():  void { this.stem.pauseWill( this.id ) }
  resume(): void { this.stem.resumeWill( this.id ) }

  /**
   * Distil the mind into a portable PMA artifact and archive it. The returned
   * snapshot restores the same self via `Will.wake()` — across a restart, a
   * fork, or a machine boundary.
   */
  async hibernate(): Promise<PMASnapshot> {
    const pma = this.stem.distillPMA( this.id )
    await this.stop()
    return pma
  }

  /** Tear the Will down (its tick loop stops; state is discarded unless persisted). */
  async stop(): Promise<void> {
    this._unsub?.()
    this._unsub = null
    await this.stem.archiveWill( this.id )
  }

  // ── Internals ──────────────────────────────────────────────

  private _buildConfig( id: string, opts: CreateWillOptions ): WillConfig {
    const useMock = ( opts.llm ?? ( process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock' ) ) === 'mock'
    return {
      id, name: opts.name,
      identity: {
        prompt: opts.identity.prompt,
        values: opts.identity.values ?? [],
        traits: opts.identity.traits ?? {},
        style:  opts.identity.style ?? '',
      },
      engineTier: opts.engineTier ?? 'standard',
      modelTier:  opts.model ?? 'haiku',
      testMode:   useMock,
      persistentMemory: opts.persist ?? false,
      snapshotInterval: 100,
      tickIntervalMs:   opts.tickMs ?? 1000,
      allowedGenericEffectors: [ ...COMMUNICATION, ...this._effectors.keys() ],
      initialGoals: opts.initialGoals ?? [],
      ...( opts.seed !== undefined ? { randomSeed: opts.seed, clock: { fixedDeltaMs: 1000, startTime: 0 } } : {} ),
    }
  }

  /** Wire the single tick listener that drives messages + the effector ack loop. */
  private _attach(): void {
    this._unsub = this.stem.addTickListener( this.id, ( _snapshot, _tick, outbox, invocations ) => {
      // Outbound messages → event + auto delivery-ack.
      for( const msg of outbox ){
        this._emitMessage( { id: msg.id, content: msg.content, to: msg.targetEntityId } )
        try { this.stem.confirmMessageDelivery( this.id, msg.id, true ) } catch { /* best-effort */ }
      }
      // Effector invocations → run the handler → execution-ack.
      for( const inv of invocations )
        void this._runEffector( inv )

      // State subscribers (only when someone is listening — state() is cheap but not free).
      if( this._stateHandlers.size > 0 ){
        const s = this.state()
        for( const h of this._stateHandlers ) try { h( s ) } catch { /* isolate */ }
      }
    } ) ?? null
  }

  private async _runEffector( inv: effectorInvocation ): Promise<void> {
    const handler = this._effectors.get( inv.effectorName )
    if( !handler ){
      // The Will chose an effector we have no handler for — report it as failed so
      // the reafference loop learns it doesn't work, rather than hanging on the await.
      this.stem.confirmEffectorExecution( this.id, inv.decisionRecordId, {
        success: false, description: `No handler registered for effector "${inv.effectorName}"`,
      } )
      return
    }

    try {
      const raw = await handler( inv.parameters, { reasoning: inv.reasoning, targetEntityId: inv.targetEntityId } )
      const result = typeof raw === 'string' ? { success: true, description: raw } : raw
      this.stem.confirmEffectorExecution( this.id, inv.decisionRecordId, result )
    }
    catch( err ){
      this._emitError( err instanceof Error ? err : new Error( String( err ) ) )
      this.stem.confirmEffectorExecution( this.id, inv.decisionRecordId, {
        success: false, description: `Effector "${inv.effectorName}" threw: ${( err as Error ).message}`,
      } )
    }
  }

  private _emitMessage( m: WillMessage ): void {
    for( const h of this._messageHandlers ) try { h( m ) } catch( e ){ this._emitError( e as Error ) }
  }
  private _emitError( e: Error ): void {
    for( const h of this._errorHandlers ) try { h( e ) } catch { /* nowhere left to go */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** The three communication effectors a Will needs to hear + speak. */
const COMMUNICATION = [ 'listen', 'talk', 'text' ] as const

function slug( s: string ): string {
  return s.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'will'
}
